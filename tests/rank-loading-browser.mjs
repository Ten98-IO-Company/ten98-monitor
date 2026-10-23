// Production-bundle acceptance; run only after the supervising agent releases port 3094.
// TEN98_RANK_LOADING_BROWSER=1 PLAYWRIGHT_MODULE=<installed module> node tests/rank-loading-browser.mjs
// Needs a fresh local app on BASE_URL (default http://localhost:3094), unclaimed; tests/fixtures/navigation-review.mjs
// provisions the synthetic viewer session at run time (TEN98_SHELL_FIXTURE may name a private session JSON instead).
// No database access, provisioning, real auth writes, rank checks, provider calls, or browser install.
// Session races use explicitly intercepted auth/Me replies; they test client fencing, not server auth.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadNavigationSession} from './fixtures/navigation-review.mjs';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {launchChromium} from './helpers/playwright.mjs';

assert.equal(process.env.TEN98_RANK_LOADING_BROWSER, '1', 'Explicit production-fixture opt-in required');
const cwd = process.cwd(), artifactDir = resolve(cwd, 'private/rank-loading-browser');
const fixture = await loadNavigationSession({baseUrl: process.env.BASE_URL ?? 'http://localhost:3094', override: process.env.TEN98_SHELL_FIXTURE});
assert.equal(fixture.synthetic, true); assert.equal(fixture.role, 'viewer'); assert.equal(fixture.externalRequests, 0);
const initialUrl = new URL(fixture.url), origin = initialUrl.origin;
assert.equal(origin, 'http://localhost:3094', 'Only the released, owned synthetic app is allowed');
const workspaceId = initialUrl.searchParams.get('workspace'), projectId = initialUrl.searchParams.get('project');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
assert.match(workspaceId ?? '', uuid); assert.match(projectId ?? '', uuid);
const storageState = fixture.storageState;

// Read the emitted manifest and module graph; never guess a chunk hash or execute application modules.
const serverDir = resolve(cwd, '.output/server'), publicDir = resolve(cwd, '.output/public');
const manifests = (await readdir(serverDir)).filter(name => /^_tanstack-start-manifest.*\.mjs$/.test(name));
assert.equal(manifests.length, 1, 'One production manifest expected');
const manifestText = await readFile(resolve(serverDir, manifests[0]), 'utf8');
const manifest = (await import(pathToFileURL(resolve(serverDir, manifests[0])).href)).tsrStartManifest();
const preloads = [...(manifest.routes.__root__.preloads ?? []), ...(manifest.routes['/'].preloads ?? [])];
const routeAssets = (manifest.routes['/'].preloads ?? []).filter(path => path.endsWith('.js'));
assert.equal(routeAssets.length, 1);
const modules = new Map();
for (const name of (await readdir(resolve(publicDir, 'assets'))).filter(name => name.endsWith('.js'))) {
  modules.set('/assets/' + name, await readFile(resolve(publicDir, 'assets', name), 'utf8'));
}
const candidates = [...modules].filter(([, code]) => code.includes('Saved trackers') && code.includes('Maximum billable pages'));
assert.equal(candidates.length, 1, 'Find the emitted rank family by its real code, not a filename guess');
const [rankAsset, rankCode] = candidates[0], routeAsset = routeAssets[0], routeCode = modules.get(routeAsset);
assert.ok(routeCode); assert.notEqual(rankAsset, routeAsset, 'Rank family must leave the eagerly loaded routes chunk');
const imports = (path, dynamic) => [...modules.get(path).matchAll(dynamic
  ? /\bimport\(\s*(["'`])([^"'`]+)\1\s*\)/g
  : /(?:\bfrom\s*|\bimport\s*)(["'])(\.{1,2}\/[^"']+\.js)\1/g)]
  .map(match => new URL(match[2], origin + path).pathname).filter(path => modules.has(path));
const closure = roots => { const found = new Set(); function visit(path) { if (found.has(path) || !modules.has(path)) return; found.add(path); for (const next of imports(path, false)) visit(next); } roots.forEach(visit); return found; };
const eager = closure(preloads);
assert.equal(eager.has(rankAsset), false, 'Root/route static dependency graph must exclude rank implementation');
assert.ok([...eager].some(path => imports(path, true).includes(rankAsset)), 'Rank is a literal dynamic dependency of the current entry graph');
assert.equal([...eager].some(path => modules.get(path).includes('Saved trackers')), false);
const hash = value => createHash('sha256').update(value).digest('hex');
const measurements = {manifest: manifests[0], manifestSha256: hash(manifestText), routeAsset, rankAsset,
  routeBytes: Buffer.byteLength(routeCode), routeGzipBytes: gzipSync(routeCode).length,
  rankBytes: Buffer.byteLength(rankCode), rankGzipBytes: gzipSync(rankCode).length,
  routeSha256: hash(routeCode), rankSha256: hash(rankCode), eagerJs: [...eager],
  limitations: ['Existing synthetic viewer session; no database changes.', 'Scope/session races intercept only named local API replies; not server authorization acceptance.']};
await mkdir(artifactDir, {recursive: true});
console.log('PASS emitted manifest: rank implementation is a dynamic chunk outside the initial static graph.');

const browser = await launchChromium();
const results = [], fixtureData = {me: null, projects: null};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const rankApi = path => /^\/api\/projects\/[^/]+\/rank-trackers(?:\/|$)/.test(path);
const emptyList = () => ({role: 'viewer', vaultConfigured: false, connections: [], trackers: [], nextCursor: null});
const otherProjectId = 'f0000000-0000-4000-8000-000000000002';
const actorB = 'f0000000-0000-4000-8000-000000000003';
async function run(name, options, check) {
  const context = await browser.newContext({storageState: options.anonymous ? undefined : storageState, viewport: {width: options.width ?? 1440, height: 1000}, serviceWorkers: 'block'});
  const calls = [], blocked = [], errors = [], tasks = [], observedAssets = new Set();
  let releaseCode, codeHeld = false, actor = 'A', failed = false, syntheticProject = false;
  const gate = new Promise(resolve => { releaseCode = resolve; });
  const respond = (route, json, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(json)});
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    calls.push({path, method: request.method(), actor, resource: request.resourceType()});
    if (url.origin !== origin) { blocked.push('external request'); return route.abort(); }
    if (options.session && request.method() === 'POST' && path === '/api/auth/sign-out') { actor = null; return respond(route, {success: true}); }
    if (options.session && request.method() === 'POST' && path === '/api/auth/sign-in/email') {
      const data = request.postDataJSON();
      assert.ok(['a@rank-loading.invalid', 'b@rank-loading.invalid'].includes(data.email));
      actor = data.email.startsWith('a@') ? 'A' : 'B'; return respond(route, {user: {}, session: {}});
    }
    if (!['GET', 'HEAD'].includes(request.method())) { blocked.push('unexpected write: ' + path); return route.abort(); }
    if (path === rankAsset) {
      if (options.code === 'fail' && !failed) { failed = true; return route.abort('failed'); }
      if (options.code === 'hold') { codeHeld = true; await gate; }
    }
    if (options.session && path === '/api/account/preferences' && actor === 'B') {
      // The app verifies the preferences identity against /api/me, so session B must be consistent across both reads.
      const response = await route.fetch({maxRedirects: 0}); assert.equal(response.status(), 200);
      const data = await response.json();
      return respond(route, {...data, user: {...data.user, id: actorB, name: 'Synthetic session B', email: 'b@rank-loading.invalid'}});
    }
    if (options.session && path === '/api/me') {
      assert.ok(fixtureData.me);
      if (actor === null) return respond(route, {error: 'Synthetic session ended'}, 401);
      const me = structuredClone(fixtureData.me);
      if (actor === 'B') me.user = {...me.user, id: actorB, name: 'Synthetic session B', email: 'b@rank-loading.invalid'};
      return respond(route, me);
    }
    if (path === '/api/me' || path === `/api/workspaces/${workspaceId}/projects`) {
      const response = await route.fetch({maxRedirects: 0});
      if (options.anonymous && path === '/api/me') { assert.equal(response.status(), 401); return route.fulfill({response}); }
      assert.equal(response.status(), 200, 'Existing synthetic viewer session must remain valid');
      const data = await response.json();
      if (path === '/api/me') fixtureData.me = data;
      else {
        fixtureData.projects = data.projects;
        if (options.project && !data.projects.some(project => project.id !== projectId)) {
          const original = data.projects.find(project => project.id === projectId); assert.ok(original);
          data.projects.push({...original, id: otherProjectId, name: 'Contained alternate project', origin: 'https://rank-loading.invalid'});
          syntheticProject = true;
          return respond(route, data);
        }
      }
      return route.fulfill({response});
    }
    if (rankApi(path) && (options.session || options.project || options.denied)) {
      assert.equal(path.split('/').length, 5, 'Race fixtures never initiate catalog, paid checks, or child reads');
      return respond(route, options.denied ? {error: 'Synthetic current access denied'} : emptyList(), options.denied ? 403 : 200);
    }
    if (syntheticProject && path.startsWith(`/api/projects/${otherProjectId}/`)) {
      if (path.endsWith('/events')) return respond(route, {events: [], total: 0, retainedFrom: null});
      if (path.endsWith('/jobs')) return respond(route, {jobs: []});
      return respond(route, {error: 'Contained alternate project has no analytics fixture'}, 503);
    }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if ([routeAsset, rankAsset].includes(path) && response.status() === 200) {
      tasks.push(response.body().then(body => { assert.equal(hash(body), hash(modules.get(path)), 'Running server must serve this exact build'); observedAssets.add(path); }).catch(error => { errors.push(error.message); }));
    }
  });
  const url = (view = 'project', id = projectId) => origin + '/?' + new URLSearchParams({workspace: workspaceId, project: id, view});
  async function menu() {
    const button = page.getByRole('button', {name: /^(Menu|Close menu)$/});
    if (await button.isVisible() && await button.getAttribute('aria-expanded') === 'false') await button.click();
  }
  async function link(name) {
    await menu();
    const target = page.locator('aside.t98-shell-sidebar').getByRole('link', {name, exact: true, includeHidden: true});
    await target.waitFor({state: 'attached'});
    for (const details of await target.locator('xpath=ancestor::details').all()) {
      if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
    }
    return target;
  }
  // Projects are chosen in the shared Workspace/Project switcher (a native select), not as sidebar links.
  async function selectProject(name) { await menu(); await page.locator('aside.t98-shell-sidebar').getByLabel('Project', {exact: true}).selectOption({label: name}); }
  async function open() { await page.goto(url()); await page.locator('main').waitFor(); await page.waitForURL(/analyticsTo=/, {timeout: 3000}).catch(() => {}); /* the app may normalize the URL once, closing a drawer opened earlier */ await (await link('Analytics')).waitFor(); }
  const loaded = () => page.getByRole('heading', {name: 'Saved trackers', exact: true}).waitFor();
  const loading = () => page.getByRole('status').filter({hasText: 'Loading rank tracking'}).waitFor();
  const rankCalls = () => calls.filter(call => rankApi(call.path));
  try {
    await check({page, context, calls, url, open, menu, link, selectProject, loaded, loading, rankCalls,
      held: () => codeHeld, release: releaseCode, observedAssets, syntheticProject: () => syntheticProject});
    await Promise.all(tasks);
    assert.ok(observedAssets.has(routeAsset), 'Actual production routes module was exercised');
    assert.deepEqual(blocked, [], 'No unexpected write or non-loopback request');
    assert.deepEqual(errors, [], 'No uncaught browser exception');
    results.push({name, rankRequests: rankCalls().length, containedSession: !!options.session, containedProject: syntheticProject});
    console.log('PASS ' + name);
  } finally { releaseCode(); await context.close(); }
}

try {
  await run('cold real sign-in excludes rank code/API', {anonymous: true}, async t => {
    await t.page.goto(origin); await t.page.getByRole('heading', {name: 'Sign in', level: 1, exact: true}).waitFor(); await wait(150);
    assert.equal(t.calls.some(call => call.path === rankAsset), false); assert.equal(t.rankCalls().length, 0);
  });
  await run('cold overview excludes rank code/API; first keyboard entry reads the current real scope', {}, async t => {
    await t.open(); await wait(150);
    assert.equal(t.calls.some(call => call.path === rankAsset), false); assert.equal(t.rankCalls().length, 0);
    const target = await t.link('Rank tracking'); await target.focus(); await wait(100);
    assert.equal(t.calls.some(call => call.path === rankAsset), false, 'Focusing navigation must not preload the rank family');
    await target.press('Enter'); await t.loaded();
    assert.equal(t.calls.filter(call => call.path === rankAsset).length, 1);
    assert.deepEqual(t.rankCalls().map(call => call.path), [`/api/projects/${projectId}/rank-trackers`]);
    assert.equal(new URL(t.page.url()).searchParams.get('view'), 'ranks');
    assert.equal(await t.page.getByRole('button', {name: 'New tracker', exact: true}).count(), 0, 'Real viewer remains read only');
    await t.page.screenshot({path: resolve(artifactDir, 'rank-loaded-1440.png'), fullPage: true});
  });
  await run('delayed code can be abandoned for another view without a stale rank read or mount', {code: 'hold'}, async t => {
    await t.open(); await (await t.link('Rank tracking')).click(); await t.loading(); assert.equal(t.held(), true);
    await (await t.link('Recent events')).click(); await t.page.getByRole('heading', {name: 'Recent events', level: 1, exact: true}).waitFor();
    t.release(); await wait(250);
    assert.equal(t.rankCalls().length, 0); assert.equal(await t.page.getByRole('heading', {name: 'Saved trackers', exact: true}).count(), 0);
    await (await t.link('Rank tracking')).click(); await t.loaded(); assert.equal(t.rankCalls().length, 1);
  });
  await run('project A→B→A during a held module mounts only the final selected scope', {code: 'hold', project: true}, async t => {
    await t.open(); const first = fixtureData.projects.find(project => project.id === projectId);
    const second = fixtureData.projects.find(project => project.id !== projectId) ?? {id: otherProjectId, name: 'Contained alternate project'};
    assert.ok(first); await (await t.link('Rank tracking')).click(); await t.loading();
    await t.selectProject(second.name); await (await t.link('Rank tracking')).click(); await t.loading();
    assert.equal(new URL(t.page.url()).searchParams.get('project'), second.id);
    await t.selectProject(first.name); await (await t.link('Rank tracking')).click(); await t.loading();
    assert.equal(t.rankCalls().length, 0); t.release(); await t.loaded();
    assert.deepEqual(t.rankCalls().map(call => call.path), [`/api/projects/${projectId}/rank-trackers`]);
    assert.equal(new URL(t.page.url()).searchParams.get('project'), projectId);
  });
  await run('contained session A→B→A while code waits never mounts for an ended session', {code: 'hold', session: true}, async t => {
    async function signOut() { await t.page.getByRole('button', {name: 'Account menu', exact: true}).click(); await t.page.getByRole('button', {name: 'Sign out', exact: true}).click(); await t.page.getByLabel('Password', {exact: true}).waitFor(); }
    async function signIn(actor) { await t.page.getByLabel('Email address', { exact: true }).fill(actor + '@rank-loading.invalid'); await t.page.getByLabel('Password', {exact: true}).fill('Contained fixture only 123!'); await t.page.getByRole('button', {name: 'Sign in', exact: true}).click(); await t.page.locator('main').waitFor(); }
    await t.open(); await (await t.link('Rank tracking')).click(); await t.loading();
    await signOut(); assert.equal(t.rankCalls().length, 0);
    await signIn('b'); await (await t.link('Rank tracking')).click(); await t.loading();
    await signOut(); await signIn('a'); await (await t.link('Rank tracking')).click(); await t.loading();
    assert.equal(t.rankCalls().length, 0); t.release(); await t.loaded();
    assert.deepEqual(t.rankCalls().map(call => call.actor), ['A']);
    assert.equal(await t.page.getByRole('button', {name: 'New tracker', exact: true}).count(), 0);
  });
  await run('missing chunk has local recovery, usable navigation, and only an explicit page reload retries', {code: 'fail'}, async t => {
    await t.open(); await (await t.link('Rank tracking')).click();
    await t.page.getByRole('alert').filter({hasText: 'Rank tracking'}).waitFor();
    assert.equal(t.rankCalls().length, 0); await wait(250);
    assert.equal(t.calls.filter(call => call.resource === 'document').length, 1, 'No automatic page reload');
    await (await t.link('Recent events')).click(); await t.page.getByRole('heading', {name: 'Recent events', level: 1, exact: true}).waitFor();
    await (await t.link('Rank tracking')).click(); await t.page.getByRole('alert').filter({hasText: 'Rank tracking'}).waitFor();
    assert.equal(t.calls.filter(call => call.path === rankAsset).length, 1, 'No automatic failed-module retry');
    await t.page.getByRole('button', {name: 'Reload page', exact: true}).click(); await t.loaded();
    assert.equal(t.calls.filter(call => call.resource === 'document').length, 2);
    assert.equal(t.rankCalls().length, 1);
  });
  await run('loaded code still obeys the current API denial without exposing writer actions', {denied: true}, async t => {
    await t.open(); await (await t.link('Rank tracking')).click();
    await t.page.getByRole('alert').filter({hasText: 'Synthetic current access denied'}).waitFor();
    assert.equal(await t.page.getByRole('heading', {name: 'Saved trackers', exact: true}).count(), 0);
    assert.equal(await t.page.getByRole('button', {name: 'New tracker', exact: true}).count(), 0);
    await t.page.getByRole('button', {name: 'Reload access', exact: true}).click();
    await t.page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent?.includes('Synthetic current access denied'));
    assert.equal(t.rankCalls().length, 2);
  });
  await run('360px keyboard navigation preserves the shell, focus and readable pending/loaded content', {code: 'hold', width: 360}, async t => {
    await t.open(); const target = await t.link('Rank tracking'); await target.focus(); await target.press('Enter'); await t.loading();
    await t.page.waitForFunction(() => document.activeElement?.tagName === 'MAIN');
    assert.equal(await t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await t.page.screenshot({path: resolve(artifactDir, 'rank-loading-360.png'), fullPage: true});
    await t.menu(); assert.equal(await (await t.link('Recent events')).isVisible(), true);
    const close = t.page.getByRole('button', {name: 'Close navigation', exact: true}); if (await close.isVisible()) await close.click();
    t.release(); await t.loaded();
    assert.equal(await t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await t.page.getByRole('button', {name: 'Refresh', exact: true}).focus();
    assert.equal(await t.page.getByRole('button', {name: 'Refresh', exact: true}).evaluate(element => element === document.activeElement), true);
    await t.page.screenshot({path: resolve(artifactDir, 'rank-loaded-360.png'), fullPage: true});
  });
  await writeFile(resolve(artifactDir, 'result.json'), JSON.stringify({...measurements, groups: results, passed: 1 + results.length}, null, 2));
  console.log(`PASS all ${1 + results.length} production rank-loading groups; no database or provider work.`);
} finally { await browser.close(); }
