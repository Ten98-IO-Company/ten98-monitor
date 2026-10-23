import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collectorAliasResponse, collectorAliases, collectorRoutePath } from '../src/server/collector-alias.ts';
import { getConfig } from '../src/server/config.ts';

const env = { COLLECT_PATH_ALIAS: '/t/e', TRACKER_SCRIPT_ALIAS: '/stats.js' };
const tracker = readFileSync(new URL('../public/tracker.js', import.meta.url), 'utf8');

test('collector aliases are optional and accept single safe absolute paths', () => {
  assert.deepEqual(collectorAliases({}), { collectPath: null, scriptPath: null });
  assert.deepEqual(collectorAliases({ COLLECT_PATH_ALIAS: '', TRACKER_SCRIPT_ALIAS: ' ' }), { collectPath: null, scriptPath: null }, 'Compose passes unset values as empty strings.');
  assert.deepEqual(collectorAliases(env), { collectPath: '/t/e', scriptPath: '/stats.js' });
  assert.deepEqual(collectorAliases({ COLLECT_PATH_ALIAS: '/Metrics_2/ingest-v1', TRACKER_SCRIPT_ALIAS: '/js/site-1.js' }), { collectPath: '/Metrics_2/ingest-v1', scriptPath: '/js/site-1.js' });
  assert.equal(collectorAliases({ COLLECT_PATH_ALIAS: '/' + 'a'.repeat(64) }).collectPath?.length, 65);
  const base = { APP_URL: 'https://discover.example', DATABASE_URL: 'postgresql://u:p@db/x', AUTH_SECRET: 'a'.repeat(32) };
  const config = getConfig({ ...base, ...env });
  assert.equal(config.collectPathAlias, '/t/e'); assert.equal(config.trackerScriptAlias, '/stats.js');
  assert.throws(() => getConfig({ ...base, COLLECT_PATH_ALIAS: '/api/collect' }), /COLLECT_PATH_ALIAS collides/);
});

test('collector aliases reject unsafe, malformed and colliding paths', () => {
  for (const value of ['t/e', '/', '/-x', '/_build', '/t/', '/t//e', '/t/../e', '/t.e', '/t?e', '/t#e', '/t e', '/%2e', '//evil.example', 'https://x.example/t', '/' + 'a'.repeat(65), '/ü'])
    assert.throws(() => collectorAliases({ COLLECT_PATH_ALIAS: value }), /COLLECT_PATH_ALIAS must be a single absolute path/, value);
  for (const value of ['/stats', '/stats.mjs', '/stats.js/', '/.js', '/a/../b.js', '/' + 'a'.repeat(62) + '.js'])
    assert.throws(() => collectorAliases({ TRACKER_SCRIPT_ALIAS: value }), /TRACKER_SCRIPT_ALIAS must be a single absolute path/, value);
  for (const value of ['/api', '/api/collect', '/API/Collect', '/share', '/share/x', '/assets/x', '/vendor', '/src/x', '/node_modules/x'])
    assert.throws(() => collectorAliases({ COLLECT_PATH_ALIAS: value }), /collides with an existing application route/, value);
  for (const value of ['/tracker.js', '/Tracker.js', '/destinations.js', '/replay.js', '/performance.js', '/api/x.js', '/assets/index.js'])
    assert.throws(() => collectorAliases({ TRACKER_SCRIPT_ALIAS: value }), /collides with an existing application route/, value);
});

test('the collect alias hands the original request to the API handler, which maps it onto /api/collect', async () => {
  assert.equal(collectorRoutePath('/t/e', env), '/api/collect');
  assert.equal(collectorRoutePath('/api/collect', env), '/api/collect', '/api/collect keeps working with an alias configured.');
  assert.equal(collectorRoutePath('/api/collect', {}), '/api/collect');
  assert.equal(collectorRoutePath('/t/e', {}), '/t/e', 'Without the setting the alias is an ordinary unknown path.');
  assert.equal(collectorRoutePath('/T/E', env), '/T/E');
  assert.equal(collectorRoutePath('/api/health/live', { COLLECT_PATH_ALIAS: 'invalid' }), '/api/health/live', 'API routes never depend on alias parsing.');
  const handled: Request[] = [], handle = async (request: Request) => { handled.push(request); return new Response('collected', { status: 202 }); };
  for (const method of ['POST', 'OPTIONS']) {
    const request = new Request('https://discover.example/t/e', { method, headers: { origin: 'https://www.site.example' } });
    const response = await collectorAliasResponse(request, tracker, handle, env);
    assert.equal(response?.status, 202); assert.equal(handled.at(-1), request, 'The same Request object keeps its transport peer and headers.');
  }
  assert.equal(collectorAliasResponse(new Request('https://discover.example/t/e'), tracker, handle, {}), undefined);
  for (const path of ['/', '/api/collect', '/tracker.js', '/t/e/x', '/t']) assert.equal(collectorAliasResponse(new Request('https://discover.example' + path), tracker, handle, env), undefined, path);
  assert.equal(handled.length, 2);
});

test('the script alias serves the tracker bytes for GET and HEAD only', async () => {
  const response = await collectorAliasResponse(new Request('https://discover.example/stats.js'), tracker, async () => assert.fail('not a collect request'), env);
  assert.equal(response?.status, 200); assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await response.text(), tracker);
  const etag = response.headers.get('etag')!;
  assert.equal((await collectorAliasResponse(new Request('https://discover.example/stats.js', { headers: { 'if-none-match': etag } }), tracker, async () => new Response(), env))?.status, 304);
  const head = await collectorAliasResponse(new Request('https://discover.example/stats.js', { method: 'HEAD' }), tracker, async () => new Response(), env);
  assert.equal(head?.status, 200); assert.equal(head.body, null);
  const post = await collectorAliasResponse(new Request('https://discover.example/stats.js', { method: 'POST' }), tracker, async () => new Response(), env);
  assert.equal(post?.status, 405); assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('example aliases avoid the EasyPrivacy /api/collect| rule that blocks the default path', () => {
  const easyPrivacy = /\/api\/collect$/; // Adblock `|` anchors the end of the URL.
  assert.ok(easyPrivacy.test('https://discover.example/api/collect'));
  for (const path of ['/t/e', '/stats/event', '/metrics/ingest']) assert.equal(easyPrivacy.test('https://www.site.example' + collectorAliases({ COLLECT_PATH_ALIAS: path }).collectPath), false, path);
});
