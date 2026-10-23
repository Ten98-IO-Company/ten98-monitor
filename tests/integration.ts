import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import type { Request as BossRequest, SendOptions } from 'pg-boss';
import { getConfig } from '../src/server/config.ts';
import { closeDatabase, getDatabase, migrationSource } from '../src/server/db.ts';
import { enqueueProbe, getBoss, reconcileProbes, stopJobs } from '../src/server/jobs.ts';
import { runAnalyticsChecks } from './analytics-integration.ts';
import { runTeamsChecks } from './teams-integration.ts';
import { runAccountSecurityChecks } from './account-security-integration.ts';
import { runApiKeyChecks } from './api-keys-integration.ts';
import { runProviderChecks } from './providers-integration.ts';
import { runOidcChecks } from './oidc-integration.ts';
import { runDestinationChecks } from './destinations-integration.ts';
import { runNativeAnalyticsChecks } from './native-analytics-integration.ts';
import { runReportsChecks } from './reports-integration.ts';
import { runRetentionChecks } from './retention-integration.ts';
import { runRetentionCoverageChecks } from './retention-coverage-integration.ts';
import { runExplorerChecks } from './explorer-integration.ts';
import { runDomainCollectionChecks } from './domain-collection-integration.ts';
import { runClientRateLimitChecks } from './client-rate-limit-integration.ts';
import { runSetupRateLimitChecks } from './setup-rate-limit-integration.ts';
import { runEmailSuppressionChecks } from './email-suppression-integration.ts';
import { runCollectorAdmissionChecks } from './collector-admission-integration.ts';
import { runAccountClosureChecks } from './account-closure-integration.ts';
import { runClosedAccountRetentionChecks } from './closed-account-retention-integration.ts';
import { runContentSupportListChecks } from './content-support-list-integration.ts';
import { runStartupMigrateChecks } from './startup-migrate-integration.ts';

// Run against a fresh, migrated local database with the web and worker processes running.
// Fixtures are intentionally retained for inspection; this test never clears a database.
assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'Set TEN98_INTEGRATION_TEST=1 for an isolated local test database.');
const config = (() => {
  try { return getConfig(); }
  catch {
    console.error('Integration configuration is invalid. Check the local test environment; credentials are redacted.');
    process.exit(1);
  }
})();
const base = new URL(process.env.BASE_URL ?? 'http://localhost:3000');
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
assert.ok(localHosts.has(base.hostname), 'BASE_URL must be local.');
assert.ok(localHosts.has(new URL(config.appUrl).hostname), 'APP_URL must be local.');
assert.ok(localHosts.has(new URL(config.databaseUrl).hostname), 'DATABASE_URL must point to an isolated local PostgreSQL instance.');
const pool = getDatabase().pool;
let stage = 'initial safety checks';

type Reply = { response: Response; body: Record<string, any>; cookie: string };
async function request(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string | null } = {}): Promise<Reply> {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  if (options.cookie) headers.set('cookie', options.cookie);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const origin = options.origin === undefined ? (method === 'GET' ? null : config.appUrl) : options.origin;
  if (origin !== null) headers.set('origin', origin);
  const response = await fetch(new URL(path, base), {
    method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  return { response, body, cookie };
}

async function expectStatus(path: string, status: number, options?: Parameters<typeof request>[1]) {
  const result = await request(path, options);
  assert.equal(result.response.status, status, `${stage}: ${options?.method ?? 'GET'} ${path}`);
  return result;
}

async function retainHistoricalAnalytics(workspaceId: string, cookie: string) {
  // Fixed-date analytics fixtures need an explicit owner policy before any project
  // is created, so the real cleanup worker cannot race their historical events.
  const path = `/api/workspaces/${workspaceId}/retention`;
  const current = await expectStatus(path, 200, { cookie });
  const settings = { ...current.body.settings, rawAnalyticsDays: 3650 };
  const preview = await expectStatus(`${path}/preview`, 200, {
    method: 'POST', cookie, body: { revision: current.body.revision, settings },
  });
  const saved = await expectStatus(`${path}/save`, 200, {
    method: 'POST', cookie, body: { previewToken: preview.body.previewToken },
  });
  assert.deepEqual(saved.body.settings, settings, 'The owner must save the historical fixture policy through the real API.');
  assert.equal(saved.body.revision, current.body.revision + 1);
}

async function createIdentity(workspaceId: string, role: 'owner' | 'viewer') {
  const id = randomUUID();
  const email = `${id}@integration.test`;
  const password = randomBytes(24).toString('base64url');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [id, 'Integration fixture', email]);
    await client.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), id, await hashPassword(password)]);
    await client.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, id, role]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  const login = await expectStatus('/api/auth/sign-in/email', 200, { method: 'POST', body: { email, password } });
  assert.ok(login.cookie, 'Fixture login must set a session cookie.');
  return { id, cookie: login.cookie };
}

async function waitForProbe(projectId: string, probeId: string, cookie: string, expected: 'completed' | 'denied') {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = await expectStatus(`/api/projects/${projectId}/jobs`, 200, { cookie });
    const probe = result.body.jobs.find((job: { id: string }) => job.id === probeId);
    if (probe && probe.status !== 'queued') {
      assert.equal(probe.status, expected, 'Worker must apply current membership permissions.');
      assert.ok(probe.completedAt, 'Terminal worker result must include completion time.');
      return probe;
    }
    await delay(250);
  }
  assert.fail(`Worker did not reach ${expected} within 45 seconds; start the worker against the same database.`);
}

try {
  const safety = await pool.query(`SELECT (SELECT count(*) FROM "user")::int AS users,
    (SELECT count(*) FROM project)::int AS projects, (SELECT claimed FROM installation WHERE id='instance') AS claimed`);
  assert.equal(safety.rows[0].users, 0, 'Use a fresh test database; existing users will not be modified.');
  assert.equal(safety.rows[0].projects, 0, 'Use a fresh test database; existing projects will not be modified.');
  assert.equal(safety.rows[0].claimed, false, 'Use an unclaimed test installation.');
  await expectStatus('/api/health/ready', 200);
  await expectStatus('/api/me', 401);

  stage = 'schema mismatch readiness and recovery';
  const savedSchema = await pool.query<{ checksum: string }>('SELECT checksum FROM schema_version WHERE version=$1', ['0001']);
  assert.equal(savedSchema.rowCount, 1);
  assert.equal(savedSchema.rows[0].checksum, (await migrationSource()).checksum, 'Test and server must share the normalized migration checksum.');
  try {
    await pool.query('UPDATE schema_version SET checksum=$1 WHERE version=$2', ['integration-mismatched-checksum', '0001']);
    await expectStatus('/api/health/ready', 503);
    await expectStatus('/api/status', 503);
    await expectStatus('/api/session', 503);
    await expectStatus('/api/health/live', 200);
  } finally {
    await pool.query('UPDATE schema_version SET checksum=$1 WHERE version=$2', [savedSchema.rows[0].checksum, '0001']);
  }
  await expectStatus('/api/health/ready', 200);
  console.log('PASS schema mismatch blocks readiness and recovers after restoration');

  stage = 'unclaimed installation reports setup and refuses public sign-up';
  const password = randomBytes(24).toString('base64url');
  const unclaimedSession = await expectStatus('/api/session', 200);
  const unclaimedStatus = await expectStatus('/api/status', 200);
  assert.equal(unclaimedSession.body.setupRequired, true, 'An unclaimed installation requires setup.');
  assert.equal(unclaimedSession.body.user, null, 'The session read reveals no user when signed out.');
  assert.equal(unclaimedStatus.body.configured, false, 'The status alias reports an unclaimed installation.');
  const { setupRequired: _setupRequired, user: _noUser, ...sessionInstallation } = unclaimedSession.body;
  const { configured: _configured, ...statusInstallation } = unclaimedStatus.body;
  assert.deepEqual(sessionInstallation, statusInstallation, 'The canonical session read and the status alias report the same installation.');
  // Only the setup route creates the first user: Better Auth's own sign-up stays closed even while unclaimed.
  await expectStatus('/api/auth/sign-up/email', 404, { method: 'POST', body: { name: 'Early sign-up', email: 'early@integration.test', password } });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n, 0, 'A refused sign-up creates no user.');
  console.log('PASS unclaimed installation requires setup and public sign-up stays closed');

  stage = 'first sign-up validation and atomic rollback';
  const claim = { name: ' Test owner ', email: ' OWNER@integration.test ', password, workspaceName: 'Primary workspace' };
  for (const path of ['/api/auth/setup', '/api/setup']) {
    await expectStatus(path, 400, { method: 'POST', body: { ...claim, password: 'short' } });
    // A leftover `token` is tolerated, but every other unknown field is still refused.
    await expectStatus(path, 400, { method: 'POST', body: { ...claim, token: 'leftover', password: 'short' } });
    await expectStatus(path, 400, { method: 'POST', body: { ...claim, unexpected: true } });
    await expectStatus(path, 403, { method: 'POST', body: claim, origin: 'https://untrusted.integration.test' });
  }
  // Force a late failure after user/account writes to prove bootstrap is all-or-nothing.
  await pool.query("ALTER TABLE workspace ADD CONSTRAINT integration_reject_claim CHECK(name <> 'reject-install')");
  try {
    await expectStatus('/api/auth/setup', 500, { method: 'POST', body: { ...claim, workspaceName: 'reject-install' } });
    const rolledBack = await pool.query(`SELECT (SELECT count(*) FROM "user")::int AS users,
      (SELECT count(*) FROM account)::int AS accounts, (SELECT count(*) FROM instance_operator)::int AS operators,
      (SELECT claimed FROM installation WHERE id='instance') AS claimed`);
    assert.equal(rolledBack.rows[0].users, 0, 'Failed setup must leave no owner.');
    assert.equal(rolledBack.rows[0].accounts, 0, 'Failed setup must leave no credentials.');
    assert.equal(rolledBack.rows[0].operators, 0, 'Failed setup must leave no instance operator.');
    assert.equal(rolledBack.rows[0].claimed, false, 'Failed setup must remain claimable.');
    assert.equal((await expectStatus('/api/session', 200)).body.setupRequired, true, 'Failed setup still requires setup.');
  } finally {
    await pool.query('ALTER TABLE workspace DROP CONSTRAINT integration_reject_claim');
  }

  stage = 'racing installation claims';
  // Without a setup token the first sign-up claims the installation; the canonical path races its alias.
  // The second competitor carries a leftover setup token, as a page cached across the upgrade may send; it is ignored.
  const competitors = [claim, { ...claim, token: 'leftover-cached-page-token', email: ' OTHER-OWNER@integration.test ', name: 'Other owner' }];
  const claims = await Promise.all(competitors.map((body, index) => request(index ? '/api/setup' : '/api/auth/setup', { method: 'POST', body })));
  assert.deepEqual(claims.map((item) => item.response.status).sort(), [200, 409], 'Exactly one concurrent setup must succeed.');
  const winnerIndex = claims.findIndex((item) => item.response.status === 200);
  assert.equal(claims[1 - winnerIndex].body.error, 'Setup is complete. Sign in with the owner account.', 'The losing claim explains that setup is complete.');
  assert.equal(claims[1 - winnerIndex].cookie, '', 'The losing claim starts no session.');
  const ownerCookie = claims[winnerIndex].cookie;
  assert.ok(ownerCookie, 'Successful setup must sign the owner in.');
  const count = await pool.query(`SELECT (SELECT count(*) FROM "user")::int AS users,
    (SELECT count(*) FROM account)::int AS accounts, (SELECT count(*) FROM workspace)::int AS workspaces,
    (SELECT count(*) FROM membership WHERE role='owner')::int AS owners, (SELECT count(*) FROM instance_operator)::int AS operators`);
  assert.deepEqual(count.rows[0], { users: 1, accounts: 1, workspaces: 1, owners: 1, operators: 1 });
  const operator = await pool.query('SELECT o.user_id FROM instance_operator o JOIN membership m ON m.user_id=o.user_id AND m.role=\'owner\'');
  assert.equal(operator.rowCount, 1, 'The first user is both instance operator and workspace owner.');
  const credential = await pool.query('SELECT a.password,u.email,u.name FROM account a JOIN "user" u ON u.id=a."userId"');
  assert.ok(await verifyPassword({ hash: credential.rows[0].password, password }), 'Owner password must use the supported Better Auth hash.');
  assert.ok(credential.rows[0].password !== password, 'Plaintext passwords must not be stored.');
  assert.equal(credential.rows[0].email, competitors[winnerIndex].email.trim().toLowerCase());
  const owner = await expectStatus('/api/me', 200, { cookie: ownerCookie });
  assert.equal(owner.body.workspaces.length, 1);
  assert.equal(owner.body.workspaces[0].role, 'owner');
  assert.equal(owner.body.instanceOperator, true, 'The first user is the instance operator.');
  const ownerSession = await expectStatus('/api/session', 200, { cookie: ownerCookie });
  assert.equal(ownerSession.body.setupRequired, false);
  assert.deepEqual(ownerSession.body.user, owner.body.user, 'The session read returns the signed-in user.');
  const claimedSignedOut = await expectStatus('/api/session', 200);
  assert.equal(claimedSignedOut.body.setupRequired, false);
  assert.equal(claimedSignedOut.body.user, null, 'The session read reveals no user when signed out.');
  assert.equal((await expectStatus('/api/status', 200)).body.configured, true);
  const workspaceA = owner.body.workspaces[0].id as string;
  await retainHistoricalAnalytics(workspaceA, ownerCookie);
  // Setup allows 10 attempts per client in 15 minutes and this stage has used them; start a fresh window for the late claims.
  await pool.query("DELETE FROM request_limit WHERE key LIKE 'setup:client:%'");
  for (const path of ['/api/auth/setup', '/api/setup']) for (const token of [undefined, 'leftover-cached-page-token']) {
    const late = await expectStatus(path, 409, { method: 'POST', body: { ...claim, email: 'late-owner@integration.test', ...token ? { token } : {} } });
    assert.equal(late.body.error, 'Setup is complete. Sign in with the owner account.', 'A late claim gets the same refusal with or without a leftover token.');
    assert.equal(late.cookie, '', 'A refused claim starts no session.');
  }
  await expectStatus('/api/auth/sign-up/email', 404, { method: 'POST', body: { name: 'Unauthorized', email: 'unauthorized@integration.test', password } });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n, 1, 'Refused claims and sign-ups create no user.');
  await expectStatus('/api/auth/sign-in/email', 401, { method: 'POST', body: { email: credential.rows[0].email, password: `${password}wrong` } });
  console.log('PASS owner claim, atomic rollback, concurrency and signup boundary');

  stage = 'workspace and project authorization';
  const workspaceB = randomUUID();
  await pool.query('INSERT INTO workspace(id,name) VALUES($1,$2)', [workspaceB, 'Independent workspace']);
  const other = await createIdentity(workspaceB, 'owner');
  await retainHistoricalAnalytics(workspaceB, other.cookie);
  const viewer = await createIdentity(workspaceA, 'viewer');
  const otherMe = await expectStatus('/api/me', 200, { cookie: other.cookie });
  assert.deepEqual(otherMe.body.workspaces.map((item: { id: string }) => item.id), [workspaceB]);
  const originA = 'https://alpha.integration.test';
  const originB = 'https://beta.integration.test';
  const createdA = await expectStatus(`/api/workspaces/${workspaceA}/projects`, 201, { method: 'POST', cookie: ownerCookie, body: { name: 'Alpha', origin: originA } });
  const createdB = await expectStatus(`/api/workspaces/${workspaceB}/projects`, 201, { method: 'POST', cookie: other.cookie, body: { name: 'Beta', origin: originB } });
  const projectA = createdA.body.project;
  const projectB = createdB.body.project;
  await expectStatus(`/api/workspaces/${workspaceA}/projects`, 404, { cookie: other.cookie });
  await expectStatus(`/api/workspaces/${workspaceB}/projects`, 404, { cookie: ownerCookie });
  await expectStatus(`/api/workspaces/${workspaceA}/projects`, 404, { method: 'POST', cookie: other.cookie, body: { name: 'Intrusion', origin: 'https://intrusion.integration.test' } });
  await expectStatus(`/api/workspaces/${workspaceA}/projects`, 200, { cookie: viewer.cookie });
  await expectStatus(`/api/workspaces/${workspaceA}/projects`, 404, { method: 'POST', cookie: viewer.cookie, body: { name: 'Viewer write', origin: 'https://viewer.integration.test' } });
  for (const endpoint of ['events', 'analytics', 'jobs']) {
    await expectStatus(`/api/projects/${projectA.id}/${endpoint}`, 404, { cookie: other.cookie });
    await expectStatus(`/api/projects/${projectB.id}/${endpoint}`, 404, { cookie: ownerCookie });
    await expectStatus(`/api/projects/${projectA.id}/${endpoint}`, 200, { cookie: viewer.cookie });
  }
  for (const cookie of [other.cookie, viewer.cookie]) {
    await expectStatus(`/api/projects/${projectA.id}/check-worker`, 404, { method: 'POST', cookie, body: { requestId: randomUUID() } });
  }
  console.log('PASS workspace isolation and viewer write restrictions');

  stage = 'documented GET operations without paywalls';
  // Free, fully featured: every GET the served OpenAPI document lists must answer a viewer
  // with an ordinary outcome, never 402 or a server error. Writes keep their role checks above.
  const spec = await expectStatus('/api/openapi.json', 200);
  const pathIds: Record<string, string> = { workspaceId: workspaceA, projectId: projectA.id, visitorKey: randomBytes(32).toString('hex') };
  const documentedGets = Object.keys(spec.body.paths).filter((template) => spec.body.paths[template].get).length;
  let exercisedGets = 0;
  for (const template of Object.keys(spec.body.paths)) {
    if (!spec.body.paths[template].get) continue;
    const { response } = await request(template.replace(/\{(\w+)\}/g, (_, name) => pathIds[name] ?? randomUUID()), { cookie: viewer.cookie });
    assert.ok(response.status !== 402 && response.status < 500, `${stage}: GET ${template} answered ${response.status}`);
    exercisedGets += 1;
  }
  assert.ok(documentedGets > 0 && exercisedGets >= documentedGets, `${stage}: exercised ${exercisedGets} of ${documentedGets} documented GET operations`);
  console.log(`PASS ${exercisedGets} documented GET operations answer the viewer without 402 or 5xx`);

  stage = 'public collector isolation, CORS and privacy';
  const eventId = randomUUID();
  const tracking = await expectStatus('/api/tracking-config', 200, { method: 'POST', origin: originA, body: { siteKey: projectA.publicKey, environment: 'live' } });
  const event = { siteKey: projectA.publicKey, eventId, name: 'page_view', url: `${originA}/products?private-test-query=secret#private-test-fragment`, consent: { analytics: true, epoch: tracking.body.consentEpoch } };
  const preflight = await expectStatus('/api/collect', 204, { method: 'OPTIONS', origin: originA });
  assert.equal(preflight.response.headers.get('access-control-allow-origin'), originA);
  assert.equal(preflight.response.headers.get('access-control-allow-credentials'), null);
  const refused = await expectStatus('/api/collect', 403, { method: 'POST', origin: 'https://untrusted.integration.test', body: event });
  assert.equal(refused.response.headers.get('access-control-allow-origin'), null);
  await expectStatus('/api/collect', 403, { method: 'POST', origin: null, body: event });
  await expectStatus('/api/collect', 403, { method: 'POST', origin: originA, body: { ...event, siteKey: projectB.publicKey } });
  await expectStatus('/api/collect', 403, { method: 'POST', origin: originA, body: { ...event, url: `${originB}/products` } });
  await expectStatus('/api/collect', 400, { method: 'POST', origin: originA, body: { ...event, eventId: 'not-a-uuid' } });
  const accepted = await expectStatus('/api/collect', 202, { method: 'POST', origin: originA, body: event });
  assert.equal(accepted.response.headers.get('access-control-allow-origin'), originA);
  await expectStatus('/api/collect', 202, { method: 'POST', origin: originA, body: event });
  const events = await expectStatus(`/api/projects/${projectA.id}/events`, 200, { cookie: ownerCookie });
  assert.equal(events.body.total, 1, 'Retrying an event ID must not create another event.');
  assert.equal(events.body.events[0].path, '/products');
  const storedEvents = await pool.query('SELECT row_to_json(e) AS data FROM event e WHERE project_id=$1', [projectA.id]);
  const stored = JSON.stringify(storedEvents.rows);
  assert.ok(!stored.includes('private-test-query') && !stored.includes('private-test-fragment'), 'Query strings and fragments must never enter stored event rows.');
  const betaEvents = await expectStatus(`/api/projects/${projectB.id}/events`, 200, { cookie: other.cookie });
  assert.equal(betaEvents.body.total, 0, 'Rejected cross-project events must leave no data.');
  console.log('PASS collector CORS, project validation, idempotency and URL privacy');

  stage = 'application document security headers';
  // Server-rendered documents carry the root-route policy (src/routes/__root.tsx) with a per-request nonce; raw fetch
  // because `request` JSON-parses bodies, following the router's search canonicalization (`/` answers 307 to `/?view=project`)
  // to the document a browser lands on. Tag assets served from public/ must stay header-free for customer sites.
  const document = async (path: string) => { const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15_000) }); return { response, text: await response.text() }; };
  const documentPolicy = /^default-src 'none'; script-src 'self' 'nonce-([A-Za-z0-9+/=_-]{16,})'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' data: about:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'$/;
  const documentHeaders: Record<string, string> = { 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'cross-origin-opener-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', 'cache-control': 'no-store' };
  const expectDocumentHeaders = (path: string, response: Response) => {
    const nonce = response.headers.get('content-security-policy')?.match(documentPolicy)?.[1];
    assert.ok(nonce, `${stage}: ${path} must carry the exact document policy, got ${response.headers.get('content-security-policy')}`);
    for (const [name, value] of Object.entries(documentHeaders)) assert.equal(response.headers.get(name), value, `${stage}: ${path} ${name}`);
    assert.equal(response.headers.get('strict-transport-security'), null, `${stage}: ${path} must not send HSTS over this http origin`);
    return nonce;
  };
  const landing = await document('/');
  assert.equal(landing.response.status, 200, `${stage}: GET / answered ${landing.response.status}`);
  const landingNonce = expectDocumentHeaders('/', landing.response);
  const scriptTags = landing.text.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(scriptTags.length >= 2, `${stage}: expected the hydration and module entry script tags, found ${scriptTags.length}`);
  for (const tag of scriptTags) assert.ok(tag.includes(`nonce="${landingNonce}"`), `${stage}: script tag without the header nonce: ${tag}`);
  assert.notEqual(expectDocumentHeaders('/', (await document('/')).response), landingNonce, `${stage}: the nonce must change on every request`);
  expectDocumentHeaders('/share/boards/<unknown>', (await document(`/share/boards/${randomUUID()}`)).response);
  expectDocumentHeaders('/share/websites/<unknown>', (await document(`/share/websites/${randomUUID()}`)).response);
  expectDocumentHeaders('/nope', (await document('/nope')).response);
  const tracker = await document('/tracker.js');
  assert.equal(tracker.response.status, 200, `${stage}: GET /tracker.js answered ${tracker.response.status}`);
  assert.equal(tracker.response.headers.get('content-type'), 'text/javascript; charset=utf-8');
  for (const name of ['content-security-policy', 'strict-transport-security', 'cross-origin-resource-policy', ...Object.keys(documentHeaders)]) assert.equal(tracker.response.headers.get(name), null, `${stage}: /tracker.js must stay free of ${name}`);
  console.log('PASS application documents carry the nonce policy and header class; tag assets stay header-free');

  stage = 'worker completion and idempotency';
  const requestId = randomUUID();
  const job = await expectStatus(`/api/projects/${projectA.id}/check-worker`, 202, { method: 'POST', cookie: ownerCookie, body: { requestId } });
  const retry = await expectStatus(`/api/projects/${projectA.id}/check-worker`, 202, { method: 'POST', cookie: ownerCookie, body: { requestId } });
  assert.equal(retry.body.job.id, job.body.job.id, 'Job request retries must return the original probe.');
  await waitForProbe(projectA.id, job.body.job.id, ownerCookie, 'completed');

  stage = 'pg-boss and application transaction rollback';
  const boss = await getBoss();
  const originalSend = boss.send;
  let sentJobId: string | null = null;
  const rollbackRequest = randomUUID();
  const injectedFailure = new Error('integration: fail after queue insertion');
  boss.send = async (name: string | BossRequest, data?: object | null, options?: SendOptions): Promise<string | null> => {
    assert.ok(typeof name === 'string', 'enqueueProbe must name its queue.');
    assert.ok(options?.db, 'Queue insertion must receive the application transaction.');
    sentJobId = await originalSend.call(boss, name, data, options);
    throw injectedFailure;
  };
  try {
    await assert.rejects(enqueueProbe(projectA.id, owner.body.user.id, rollbackRequest), (error) => error === injectedFailure);
  } finally { boss.send = originalSend; }
  assert.ok(sentJobId, 'Failure must occur after a real queue insert.');
  const rollbackProbe = await pool.query('SELECT count(*)::int AS count FROM import_probe WHERE request_id=$1', [rollbackRequest]);
  const rollbackJob = await pool.query('SELECT count(*)::int AS count FROM pgboss.job WHERE id=$1', [sentJobId]);
  assert.equal(rollbackProbe.rows[0].count, 0, 'A failed enqueue must roll back the application record.');
  assert.equal(rollbackJob.rows[0].count, 0, 'A failed enqueue must roll back the pg-boss job.');

  stage = 'authorization revoked before worker execution';
  await pool.query("UPDATE membership SET role='editor' WHERE workspace_id=$1 AND user_id=$2", [workspaceA, viewer.id]);
  // Delete membership in the same transaction as enqueue: no worker timing race can
  // make this test pass or fail before the revocation becomes visible.
  boss.send = async (name: string | BossRequest, data?: object | null, options?: SendOptions): Promise<string | null> => {
    assert.ok(typeof name === 'string', 'enqueueProbe must name its queue.');
    assert.ok(options?.db, 'Revocation test requires the enqueue transaction.');
    const queuedId = await originalSend.call(boss, name, data, options);
    await options.db.executeSql('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspaceA, viewer.id]);
    return queuedId;
  };
  let revokedProbe: { id: string; status: string };
  try { revokedProbe = await enqueueProbe(projectA.id, viewer.id, randomUUID()); }
  finally { boss.send = originalSend; }
  const denied = await waitForProbe(projectA.id, revokedProbe.id, ownerCookie, 'denied');
  assert.ok(denied.error, 'Revoked work must explain why it did not execute.');
  await expectStatus(`/api/projects/${projectA.id}/events`, 404, { cookie: viewer.cookie });
  console.log('PASS worker completion, retry safety, queue rollback and revoked permissions');

  stage = 'terminal queue reconciliation';
  const reconciliationCases = ['failed', 'cancelled', 'deleted', 'completed', 'healthy'] as const;
  const delayedProbes = new Map<string, string>();
  boss.send = async (name: string | BossRequest, data?: object | null, options?: SendOptions): Promise<string | null> => {
    assert.ok(typeof name === 'string', 'enqueueProbe must name its queue.');
    // Keep these real jobs out of the running worker. A zero retry limit lets the
    // public fail API reach its terminal state without racing a retry worker.
    return originalSend.call(boss, name, data, { ...options, startAfter: new Date(Date.now() + 3_600_000), retryLimit: 0 });
  };
  try {
    for (const label of reconciliationCases) {
      const probe = await enqueueProbe(projectA.id, owner.body.user.id, randomUUID());
      delayedProbes.set(label, probe.id);
    }
  } finally { boss.send = originalSend; }
  for (const probeId of delayedProbes.values()) {
    const queued = await pool.query('SELECT state,start_after > now() AS delayed FROM pgboss.job WHERE name=$1 AND id=$2', ['setup-probe', probeId]);
    assert.equal(queued.rowCount, 1, 'Each application probe must use its queue job ID.');
    assert.equal(queued.rows[0].state, 'created');
    assert.equal(queued.rows[0].delayed, true, 'Reconciliation fixtures must not be executable by the worker.');
  }
  await boss.fail('setup-probe', delayedProbes.get('failed')!);
  await boss.cancel('setup-probe', delayedProbes.get('cancelled')!);
  await boss.deleteJob('setup-probe', delayedProbes.get('deleted')!);
  await boss.complete('setup-probe', delayedProbes.get('completed')!, null, { includeQueued: true });
  for (const label of ['failed', 'cancelled', 'completed']) {
    const state = await pool.query('SELECT state FROM pgboss.job WHERE name=$1 AND id=$2', ['setup-probe', delayedProbes.get(label)]);
    assert.equal(state.rows[0]?.state, label, `Queue fixture must reach ${label}.`);
  }
  const removed = await pool.query('SELECT 1 FROM pgboss.job WHERE name=$1 AND id=$2', ['setup-probe', delayedProbes.get('deleted')]);
  assert.equal(removed.rowCount, 0);
  await reconcileProbes(projectA.id);
  for (const label of reconciliationCases) {
    const result = await pool.query('SELECT status,completed_at,error FROM import_probe WHERE id=$1', [delayedProbes.get(label)]);
    const expected = label === 'healthy' ? 'queued' : 'failed';
    assert.equal(result.rows[0]?.status, expected, `A ${label} queue job must reconcile to application status ${expected}.`);
    if (expected === 'failed') {
      assert.ok(result.rows[0].completed_at, 'A failed probe must have a completion time.');
      assert.ok(result.rows[0].error, 'A failed probe must explain that the check needs retrying.');
    } else {
      assert.equal(result.rows[0].completed_at, null);
      assert.equal(result.rows[0].error, null);
    }
  }
  const completedProbe = await pool.query('SELECT status,error FROM import_probe WHERE id=$1', [job.body.job.id]);
  assert.equal(completedProbe.rows[0].status, 'completed', 'Reconciliation must preserve a successfully completed application record.');
  assert.equal(completedProbe.rows[0].error, null);
  const reconciledView = await expectStatus(`/api/projects/${projectA.id}/jobs`, 200, { cookie: ownerCookie });
  for (const label of reconciliationCases) {
    const probe = reconciledView.body.jobs.find((item: { id: string }) => item.id === delayedProbes.get(label));
    assert.equal(probe?.status, label === 'healthy' ? 'queued' : 'failed', 'HTTP job results must expose the reconciled state.');
  }
  console.log('PASS terminal/missing queue reconciliation preserves healthy and completed work');

  stage = 'workspace and invitation lifecycle';
  await runTeamsChecks({ baseUrl: base.href, appUrl: config.appUrl, ownerCookie, ownerId: owner.body.user.id, workspaceId: workspaceA });
  stage = 'analytics aggregation and custom events';
  await runAnalyticsChecks({ baseUrl: base.href, appUrl: config.appUrl, ownerCookie, workspaceId: workspaceA, foreignProjectId: projectB.id });
  stage = 'native analytics consent and measured visits';
  await runNativeAnalyticsChecks({ baseUrl: base.href, appUrl: config.appUrl, ownerCookie, ownerId: owner.body.user.id, workspaceId: workspaceA });
  stage = 'verified serving-domain collection';
  await runDomainCollectionChecks();
  stage = 'collector admission before shared budgets';
  await runCollectorAdmissionChecks();
  stage = 'content assessment list source verification';
  await runContentSupportListChecks();
  stage = 'reports and revocable snapshot shares';
  await runReportsChecks({ baseUrl: base.href, appUrl: config.appUrl, ownerCookie, ownerId: owner.body.user.id, workspaceId: workspaceA });
  stage = 'retention policy, cleanup and authorization';
  await runRetentionChecks({ ownerId: owner.body.user.id });
  stage = 'retention coverage and historical availability';
  await runRetentionCoverageChecks();
  // Hosted CI runs the complete Explorer suite in its dedicated database above.
  if(process.env.GITHUB_ACTIONS!=='true')await runExplorerChecks();
  stage = 'scoped API keys';
  await runApiKeyChecks({ baseUrl: base.href, appUrl: config.appUrl, ownerCookie, ownerId: owner.body.user.id, workspaceId: workspaceA });
  stage = 'account security lifecycle';
  await runAccountSecurityChecks({ baseUrl: base.href, appUrl: config.appUrl, ownerCookie, ownerId: owner.body.user.id, workspaceId: workspaceA });
  console.log('PASS account security, password/session revocation, TOTP and one-use recovery codes');
  stage = 'provider credentials and spending controls';
  await runProviderChecks({ baseUrl: base.href, appUrl: config.appUrl, ownerCookie, ownerId: owner.body.user.id, workspaceId: workspaceA });
  stage = 'OIDC identity lifecycle';
  await runOidcChecks({ baseUrl: base.href, appUrl: config.appUrl, ownerCookie, ownerId: owner.body.user.id, workspaceId: workspaceA });
  stage = 'per-client identity rate limits';
  await runClientRateLimitChecks();
  stage = 'per-client setup rate limit';
  await runSetupRateLimitChecks();
  stage = 'SES email suppression';
  await runEmailSuppressionChecks();
  stage = 'account closure tombstone, scrub and refusals';
  await runAccountClosureChecks();
  stage = 'closed-account 7-year retention';
  await runClosedAccountRetentionChecks();
  stage = 'startup migration lock, failure and timeout';
  await runStartupMigrateChecks();
  stage = 'browser destination revisions and isolation';
  await runDestinationChecks({ baseUrl: base.href, appUrl: config.appUrl, ownerCookie, ownerId: owner.body.user.id, workspaceId: workspaceA });
  console.log('PASS destination drafts, previews, immutable publishing, rollback and origin/tenant/environment isolation');
  stage = 'session revocation';
  await expectStatus('/api/auth/sign-out', 200, { method: 'POST', cookie: other.cookie, body: {} });
  await expectStatus('/api/me', 401, { cookie: other.cookie });
  console.log('PASS logout invalidates the previous session');
  console.log('Integration checks passed. Test fixtures remain in the isolated database.');
} catch (error) {
  // Do not serialize HTTP bodies, cookies, credentials, SQL parameters or database errors.
  console.error(`Integration checks failed during: ${stage}.`);
  if (error instanceof assert.AssertionError) console.error(error.message);
  else console.error('Unexpected request or database failure. Check the local test services and configuration.');
  process.exitCode = 1;
} finally {
  await stopJobs().catch(() => { console.error('Test queue shutdown failed.'); process.exitCode = 1; });
  await closeDatabase().catch(() => { console.error('Test database shutdown failed.'); process.exitCode = 1; });
}
