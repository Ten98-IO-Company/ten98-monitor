import assert from 'node:assert/strict';
import test from 'node:test';

// Self-hosted installs send no data to Ten98 or third parties: Better Auth telemetry stays off even if the library
// default changes, and configuration refuses BETTER_AUTH_TELEMETRY, which would otherwise force it on.
test('Better Auth telemetry is pinned off', async () => {
  Object.assign(process.env, { APP_URL: 'http://localhost:3000', AUTH_SECRET: 'a'.repeat(32), DATABASE_URL: 'postgresql://synthetic@localhost:5432/synthetic' });
  const { getAuth } = await import('../src/server/auth.ts');
  const { closeDatabase } = await import('../src/server/db.ts');
  try {
    assert.deepEqual(getAuth().options.telemetry, { enabled: false });
  } finally {
    await closeDatabase();
  }
});

test('configuration refuses BETTER_AUTH_TELEMETRY, which would force telemetry on', async () => {
  const { getConfig } = await import('../src/server/config.ts');
  const env = { APP_URL: 'http://localhost:3000', AUTH_SECRET: 'a'.repeat(32), DATABASE_URL: 'postgresql://synthetic@localhost:5432/synthetic' };
  for (const value of ['1', 'true', 'TRUE', 'yes']) assert.throws(() => getConfig({ ...env, BETTER_AUTH_TELEMETRY: value }), /BETTER_AUTH_TELEMETRY is not supported/);
  for (const value of ['0', 'false', ' FALSE ']) assert.doesNotThrow(() => getConfig({ ...env, BETTER_AUTH_TELEMETRY: value }));
  assert.doesNotThrow(() => getConfig(env));
});

test('configuration ignores a leftover BOOTSTRAP_TOKEN: the first sign-up claims the installation', async () => {
  const { getConfig } = await import('../src/server/config.ts');
  const env = { APP_URL: 'http://localhost:3000', AUTH_SECRET: 'a'.repeat(32), DATABASE_URL: 'postgresql://synthetic@localhost:5432/synthetic' };
  for (const value of ['b'.repeat(64), 'short']) {
    const config = getConfig({ ...env, BOOTSTRAP_TOKEN: value });
    assert.equal(Object.hasOwn(config, 'bootstrapToken'), false);
    assert.equal(Object.values(config).includes(value), false);
  }
});
