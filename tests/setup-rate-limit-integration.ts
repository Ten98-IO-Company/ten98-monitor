import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfig, secret as configSecret } from '../src/server/config.ts';
import { assertSchema, closeDatabase, getDatabase } from '../src/server/db.ts';
import { handleApi } from '../src/server/api.ts';
import { clientLimitKey } from '../src/server/client-rate-limit.ts';
import { networkSettings, useNetwork, withTransport, type MakeRequest } from './collector-admission-integration.ts';

// Needs an isolated synthetic PostgreSQL database; never a real installation.
// First-user setup attempts count per client over a 15-minute window, in one bucket shared by POST /api/auth/setup and its
// /api/setup alias. These attempts carry a too-short password, so an attempt under the limit gets the normal 400 refusal rather than
// 429 and never claims the installation, whether or not it is already claimed.
export async function runSetupRateLimitChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
  const config = getConfig();
  for (const url of [config.appUrl, config.databaseUrl]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
  await assertSchema();
  // Derive the keys exactly as the route does, including AUTH_SECRET_FILE support.
  const { pool } = getDatabase(), secret = configSecret('AUTH_SECRET');
  const addressA = '198.51.100.31', addressB = '198.51.100.32';
  const clientA = clientLimitKey('setup', addressA, secret), clientB = clientLimitKey('setup', addressB, secret), keys = [clientA, clientB];
  const send = (from: MakeRequest, path = '/api/auth/setup') => handleApi(from(path, {
    method: 'POST', headers: { origin: config.appUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Setup limit fixture', email: 'setup-limit@integration.test', password: randomBytes(4).toString('hex') }),
  }));
  const attempt = (from: MakeRequest, path?: string) => send(from, path).then(response => response.status);
  const seed = (key: string, minutesAgo: number, count: number) => pool.query('INSERT INTO request_limit(key,minute,count) VALUES($1,floor(extract(epoch FROM now())/60)-$2::integer,$3)', [key, minutesAgo, count]);
  const savedNetwork = Object.fromEntries(networkSettings.map(key => [key, process.env[key]]));
  try {
    await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])', [keys]);
    useNetwork({ ANALYTICS_NETWORK_MODE: 'off', TRUSTED_PROXIES: '127.0.0.1' });
    const statuses = await withTransport(config.appUrl, async (_peer, via) => {
      const a: number[] = [];
      // Alternate the canonical path and its alias: both draw on one bucket.
      for (let n = 0; n < 11; n++) a.push(await attempt(via(addressA), n % 2 ? '/api/setup' : '/api/auth/setup'));
      const limited = await send(via(addressA));
      return { a, limited: { status: limited.status, error: (await limited.json() as { error?: string }).error }, b: await attempt(via(addressB)) };
    });
    assert.deepEqual(statuses.a.slice(0, 10), Array(10).fill(400), 'The first ten setup attempts from one client are refused as invalid, not rate limited.');
    assert.equal(statuses.a[10], 429, 'The eleventh setup attempt from one client within the window is refused, across the canonical path and alias.');
    assert.deepEqual(statuses.limited, { status: 429, error: 'Too many attempts. Wait 15 minutes and try again.' }, 'The refusal names the 15-minute window.');
    assert.ok(statuses.b !== 429 && statuses.b >= 400 && statuses.b < 500, 'Another client is not limited by the first client\'s attempts.');

    // Earlier minutes inside the 15-minute window count toward the limit; older ones do not.
    await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])', [keys]);
    await seed(clientA, 10, 10);
    assert.equal(await withTransport(config.appUrl, (_peer, via) => attempt(via(addressA))), 429, 'Attempts ten minutes ago count toward the limit.');
    await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])', [keys]);
    await seed(clientA, 20, 10);
    const outside = await withTransport(config.appUrl, (_peer, via) => attempt(via(addressA)));
    assert.ok(outside !== 429 && outside >= 400 && outside < 500, 'Attempts twenty minutes ago fall outside the window.');
  } finally {
    useNetwork(savedNetwork);
    await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])', [keys]);
  }
  return { groups: ['setup attempts count per client: one client over its limit leaves another admitted', 'setup attempts count over a 15-minute window', 'the canonical setup path and its alias share one bucket'] };
}
if (process.env.TEN98_INTEGRATION_TEST === '1' && pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url) try { console.log(await runSetupRateLimitChecks()); } finally { await closeDatabase(); }
