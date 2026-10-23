// SYNTHETIC source-renderer acceptance: actual App/router/inputs, no native auth/email proof.
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import {launchChromium} from './helpers/playwright.mjs';
assert.equal(process.env.TEN98_PASSWORD_RECOVERY_BROWSER, '1');
assert.ok(process.env.PLAYWRIGHT_MODULE);
const root = process.cwd();
const out = resolve(root, 'private/password-recovery/app-browser-' + randomBytes(6).toString('hex')); mkdirSync(out, { recursive: true });
const evidence = { phase: 'starting', synthetic: true, qualification: 'Actual App/file-route/controller with explicitly synthetic native-shaped API bodies. No real cookie authority, reset token, email delivery, SQL, provider or compiled proof.', groups: [], contexts: 0, requests: [], unexpected: [], external: [], pageErrors: [], screenshots: [], layout: [], races: [], cleanup: [] };
const startupAt = performance.now(), staticRequests = new Map(), pendingStatic = new Set();
evidence.startup = { phases: [], staticEvents: [], droppedRequests: 0, droppedEvents: 0, qualification: 'Diagnostic only: first synthetic context; same-origin non-API paths without query, fragment, bodies, headers or credentials. At most512 requests/2048 events; failure DOM read capped at250ms within the existing outer deadline.' };
const save = () => writeFileSync(out + '/evidence.json', JSON.stringify(evidence, null, 2) + '\n'); save();
const startupPhase = name => { evidence.startup.phases.push({ name, elapsedMs: Math.round(performance.now() - startupAt) }); save(); };
const staticEvent = (event, request, status = null) => {
  const item = staticRequests.get(request); if (!item) return;
  if (status !== null) item.status = status;
  if (event === 'finished' || event === 'failed') pendingStatic.delete(item.id);
  if (evidence.startup.staticEvents.length < 2048) evidence.startup.staticEvents.push({ event, ...item, elapsedMs: Math.round(performance.now() - startupAt) }); else evidence.startup.droppedEvents++;
};
// Throwaway capability tokens and password: random per run, in memory only, never committed.
const alphanumeric = length => { let value = ''; while (value.length < length) value += randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g, ''); return value.slice(0, length); };
const tokenA = alphanumeric(24), tokenB = alphanumeric(24), password = 'Synthetic ' + randomBytes(12).toString('hex') + ' 2026!', email = 'synthetic@example.com';
assert.notEqual(tokenA, tokenB);
let server, browser, context, page, origin, override, state, held = [];
const button = name => page.getByRole('button', { name, exact: true }), heading = name => page.getByRole('heading', { name, exact: true });
const reply = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(value) });
const pass = name => { evidence.groups.push(name); save(); console.log('PASS ' + name); };
const wait = async predicate => { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() >= end) throw Error('Bounded synthetic browser condition not reached.'); await new Promise(resolve => setTimeout(resolve, 20)); } };
const count = path => evidence.requests.filter(call => call.context === evidence.contexts && call.path === path && call.method === 'POST').length;
async function fresh(fragment = '', responder = async () => false, options = {}) {
  for (const route of held) await route.abort().catch(() => {}); held = []; await context?.close();
  override = responder; state = { configured: true, ...options }; evidence.contexts++;
  context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 1000 }, serviceWorkers: 'block', colorScheme: 'light' }); context.setDefaultTimeout(10000);
  await context.addInitScript(({ direction, zoom }) => addEventListener('DOMContentLoaded', () => { document.documentElement.dir = direction; document.body.style.zoom = String(zoom); }), { direction: options.dir ?? 'ltr', zoom: options.zoom ?? 1 });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { evidence.external.push(url.origin); save(); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const bodyText = request.postData(), body = bodyText === null ? null : request.postDataJSON();
    const call = { context: evidence.contexts, path: url.pathname, method: request.method(), searchKeys: [...url.searchParams.keys()], bodyKeys: body && typeof body === 'object' ? Object.keys(body).sort() : null, bodySha256: bodyText === null ? null : createHash('sha256').update(bodyText).digest('hex') };
    evidence.requests.push(call); save(); assert.equal(url.hash, ''); assert.equal(url.search, '', 'Recovery capabilities never become API query parameters.');
    if (await override(route, { ...call, body }, request)) return;
    if (call.method === 'GET' && call.path === '/api/session') return reply(route, { setupRequired: false, appUrl: origin, user: null });
    if (call.method === 'GET' && call.path === '/api/me') return reply(route, { error: 'Synthetic signed-out session.' }, 401);
    if (call.method === 'GET' && call.path === '/api/auth/oidc/providers') return reply(route, { providers: [] });
    if (call.method === 'GET' && call.path === '/api/auth/password-reset-status') return reply(route, { configured: state.configured });
    evidence.unexpected.push(call); save(); await route.abort(); throw Error('Unplanned synthetic App request.');
  });
  page = await context.newPage(); page.on('pageerror', error => { evidence.pageErrors.push(error.message); save(); });
  if (evidence.contexts === 1) {
    page.on('request', request => {
      const url = new URL(request.url()); if (url.origin !== origin || url.pathname.startsWith('/api/')) return;
      if (staticRequests.size >= 512) { evidence.startup.droppedRequests++; return; }
      const item = { id: staticRequests.size + 1, path: url.pathname.slice(0, 512), type: request.resourceType(), status: null };
      staticRequests.set(request, item); pendingStatic.add(item.id); staticEvent('request', request);
    });
    page.on('response', response => staticEvent('response', response.request(), response.status()));
    page.on('requestfinished', request => staticEvent('finished', request));
    page.on('requestfailed', request => staticEvent('failed', request));
    page.on('domcontentloaded', () => startupPhase('domcontentloaded')); page.on('load', () => startupPhase('load'));
    startupPhase('goto-start');
  }
  await page.goto(origin + fragment, { waitUntil: 'domcontentloaded' });
  if (evidence.contexts === 1) startupPhase('goto-complete');
}
async function requestMode() { await heading('Sign in').waitFor(); await page.getByLabel('Email address', { exact: true }).fill(email); await button('Forgot password?').click(); await heading('Reset your password').waitFor(); }
async function resetMode(token = tokenA) { await fresh('#password-reset=' + token); await heading('Choose a new password').waitFor(); }
async function fillReset(value = password, confirmation = value) { await page.getByLabel('New password', { exact: true }).fill(value); await page.getByLabel('Confirm new password', { exact: true }).fill(confirmation); }
async function privateCapabilityAbsent() {
  await page.waitForFunction(() => location.hash === '');
  const exposed = await page.evaluate(tokens => ({ hash: location.hash, search: location.search, dom: tokens.some(token => document.documentElement.outerHTML.includes(token)), storage: tokens.some(token => [...Object.keys(localStorage).map(key => key + localStorage.getItem(key)), ...Object.keys(sessionStorage).map(key => key + sessionStorage.getItem(key))].some(value => value.includes(token))) }), [tokenA, tokenB]);
  assert.equal(exposed.hash, ''); assert.ok(!exposed.search.includes('password-reset') && !exposed.search.includes(tokenA) && !exposed.search.includes(tokenB)); assert.equal(exposed.dom, false); assert.equal(exposed.storage, false);
}
try {
  server = await createServer({ configFile: false, root, cacheDir: out + '/vite-cache', appType: 'custom', resolve: { dedupe: ['react', 'react-dom'] }, optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-dev-runtime', '@tanstack/react-router', 'zod', '@ten98/runtime', '@ten98/ui', '@ten98/ui/app'] }, server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false } });
  server.middlewares.use((req, res, next) => { if (req.url?.split('?')[0] !== '/') return next(); res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recovery synthetic App acceptance</title><div id="root"></div><script type="module" src="/tests/password-recovery-browser-fixture.tsx"></script></html>'); });
  await server.listen(); const address = server.httpServer.address(); assert.equal(address.address, '127.0.0.1'); origin = 'http://127.0.0.1:' + address.port;
  startupPhase('transform-start'); assert.ok(await server.environments.client.transformRequest('/tests/password-recovery-browser-fixture.tsx')); startupPhase('transform-complete');
  startupPhase('crawl-start'); await server.environments.client.waitForRequestsIdle(); startupPhase('crawl-complete');
  const optimizer = server.environments.client.depsOptimizer; assert.ok(optimizer);
  startupPhase('optimizer-commit-start');
  await optimizer.scanProcessing;
  const pendingDependencies = Object.values(optimizer.metadata.discovered);
  await Promise.all(pendingDependencies.map(dependency => dependency.processing));
  assert.ok(Object.keys(optimizer.metadata.optimized).length > 0, 'Cold dependency bundles must be committed before browser navigation.');
  for (const dependency of pendingDependencies) assert.ok(optimizer.metadata.optimized[dependency.id], dependency.id + ' was not committed.');
  startupPhase('optimizer-commit-complete'); startupPhase('browser-launch-start');
   browser = await launchChromium({args: ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability']});
  startupPhase('browser-launch-complete');

  for (const account of ['synthetic@example.com', 'unknown@example.com']) {
    await fresh('', async (route, call) => { if (call.path !== '/api/auth/request-password-reset') return false; assert.equal(call.method, 'POST'); assert.deepEqual(call.body, { email: account }); await reply(route, { ok: true }); return true; });
    await requestMode(); assert.equal(await page.getByLabel('Email address', { exact: true }).inputValue(), email); await page.getByLabel('Email address', { exact: true }).fill(account); await button('Send reset link').click();
    await page.getByRole('status').filter({ hasText: 'If a local password account matches this email' }).waitFor(); await page.getByText('Delivery is not confirmed here.', { exact: false }).waitFor(); assert.equal(count('/api/auth/request-password-reset'), 1); assert.equal(await button('Send reset link').count(), 0);
  } pass('SYNTHETIC actual forgot flow preserves entered email and opaque account-independent delivery-unconfirmed acknowledgement');

  for (const configured of [false, 'malformed']) {
    await fresh('', async () => false, { configured }); await requestMode();
    if (configured === false) await page.getByRole('status').filter({ hasText: 'Email recovery is not configured' }).waitFor(); else await page.getByRole('alert').filter({ hasText: 'availability could not be checked' }).waitFor();
    assert.equal(await page.getByLabel('Email address', { exact: true }).count(), 0); assert.equal(count('/api/auth/request-password-reset'), 0); await button('Back to sign in').click(); await heading('Sign in').waitFor();
  } pass('SYNTHETIC disabled or malformed configuration cannot submit and retains a real return-to-sign-in control');

  await resetMode(); await privateCapabilityAbsent(); assert.equal(evidence.requests.filter(call => call.context === evidence.contexts).length, 0, 'Initial reset capture protects boot identity and scrubs before any API read.');
  // Synchronous stale controls exercise the same parent callbacks used by the
  // asynchronous ACK, before the old keyed component can run passive cleanup.
  // Keep the separate held-response case below; this is not network-delivery proof.
  // The shared recovery flow offers 'Request a new link' only after an invalid-link
  // refusal, where the form is replaced by an alert; that alert is the stale anchor.
  for (const [token, control] of [[tokenB, 'Back to sign in'], [tokenA, 'Request a new link']]) {
    let anchor = 'input[id$="-password"]', baseline = 0;
    if (control === 'Request a new link') {
      await fresh('#password-reset=' + tokenB, async (route, call) => { if (call.path !== '/api/auth/reset-password') return false; await reply(route, { error: 'Synthetic invalid reset link.' }, 400); return true; }); await heading('Choose a new password').waitFor();
      await fillReset(); await button('Change password').click(); await page.getByRole('alert').filter({ hasText: 'This link is invalid, expired or already used.' }).waitFor(); anchor = '[role="alert"]'; baseline = evidence.requests.filter(call => call.context === evidence.contexts).length;
    }
    const previousInput = await page.locator(anchor).first().elementHandle(); assert.ok(previousInput);
    const observed = await page.evaluate(({ token, control, anchor }) => {
      const oldControl = [...document.querySelectorAll('button')].find(button => button.textContent === control), oldInput = document.querySelector(anchor);
      if (!oldControl || oldControl.disabled || !oldInput) throw Error('Expected enabled old recovery controls.');
      const oldURL = location.href, next = new URL(oldURL); next.hash = 'password-reset=' + token;
      history.replaceState(history.state, '', next.href);
      dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: next.href }));
      const connectedBeforeClick = oldControl.isConnected && oldInput.isConnected;
      let clicked = 0; oldControl.addEventListener('click', () => clicked++, { once: true }); oldControl.click();
      return { connectedBeforeClick, clicked };
    }, { token, control, anchor });
    assert.deepEqual(observed, { connectedBeforeClick: true, clicked: 1 }, 'Old controls must still be connected when the replacement intent synchronously takes ownership.');
    await wait(() => previousInput.evaluate(element => !element.isConnected)); await heading('Choose a new password').waitFor(); await privateCapabilityAbsent();
    assert.equal(await page.getByLabel('New password', { exact: true }).inputValue(), ''); assert.equal(evidence.requests.filter(call => call.context === evidence.contexts).length, baseline);
    evidence.races.push({ kind: 'synchronous replacement before old ' + control, qualification: 'Actual hash listener followed by native old-control click in one browser task before old DOM detaches; no forced or claimed ACK delivery.' });
  }
  await resetMode(); // The invalid-link case above spent its own context's reset POST.
  assert.equal(await page.getByLabel('New password', { exact: true }).getAttribute('maxlength'), '128'); assert.equal(await page.getByLabel('New password', { exact: true }).getAttribute('autocomplete'), 'new-password');
  await fillReset(password, password + ' differs'); await button('Change password').click(); await page.getByRole('alert').filter({ hasText: 'enter the same password twice' }).waitFor(); assert.equal(count('/api/auth/reset-password'), 0);
  let manual = 0; override = async (route, call) => {
    if (call.path === '/api/auth/reset-password') { assert.equal(call.method, 'POST'); assert.deepEqual(call.body, { token: tokenA, newPassword: password }); await reply(route, { ok: true }); return true; }
    if (call.path === '/api/auth/sign-in/email') { manual++; assert.deepEqual(call.body, { email, password }); await reply(route, { twoFactorRedirect: true }); return true; } return false;
  };
  await fillReset(); await button('Change password').click(); await heading('Sign in').waitFor(); await page.getByRole('status').filter({ hasText: 'Password changed. Sign in with your new password.' }).waitFor(); assert.equal(manual, 0); assert.equal(count('/api/auth/reset-password'), 1); assert.equal(await page.getByLabel('New password', { exact: true }).count(), 0); await privateCapabilityAbsent();
  await page.getByLabel('Email address', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password); await button('Sign in').click(); await heading('Verify your sign-in').waitFor(); assert.equal(manual, 1); await page.getByLabel('Authenticator code', { exact: true }).waitFor();
  pass('SYNTHETIC initial fragment stays memory-only, confirmation is local, reset returns manual sign-in and preserves the two-factor step');

  for (const reason of ['expired', 'used']) {
    await fresh('#password-reset=' + tokenA, async (route, call) => { if (call.path !== '/api/auth/reset-password') return false; await reply(route, { error: 'Synthetic ' + reason }, 400); return true; }); await heading('Choose a new password').waitFor(); await fillReset(); await button('Change password').click();
    await page.getByRole('alert').filter({ hasText: 'invalid, expired or already used' }).waitFor(); assert.equal(await page.getByLabel('New password', { exact: true }).count(), 0); assert.equal(count('/api/auth/reset-password'), 1); await button('Request a new link').click(); await heading('Reset your password').waitFor();
  }
  await fresh('#password-reset=bad'); await heading('Choose a new password').waitFor(); await page.getByRole('alert').filter({ hasText: 'invalid or incomplete' }).waitFor(); await privateCapabilityAbsent(); assert.equal(await button('Change password').count(), 0);
  await resetMode(); await page.reload({ waitUntil: 'domcontentloaded' }); await heading('Sign in').waitFor(); assert.equal(count('/api/auth/reset-password'), 0); await page.goto(origin + '#password-reset=' + tokenA); await heading('Choose a new password').waitFor(); await privateCapabilityAbsent(); assert.equal(await page.getByLabel('New password', { exact: true }).inputValue(), '');
  pass('SYNTHETIC expired/used/malformed links are refused and reload requires reopening the email capability');

  for (const mode of ['request-500', 'reset-500', 'reset-429']) {
    const asking = mode.startsWith('request'); await fresh(asking ? '' : '#password-reset=' + tokenA, async (route, call) => { if (call.path !== (asking ? '/api/auth/request-password-reset' : '/api/auth/reset-password')) return false; await reply(route, { error: 'Synthetic private backend text never shown' }, mode.endsWith('429') ? 429 : 500); return true; });
    if (asking) await requestMode(); else { await heading('Choose a new password').waitFor(); await fillReset(); }
    await button(asking ? 'Send reset link' : 'Change password').click(); const expected = mode.endsWith('429') ? 'Too many attempts.' : asking ? 'The request could not be confirmed.' : 'The password change could not be confirmed.'; await page.getByRole('alert').filter({ hasText: expected }).waitFor();
    assert.equal(count(asking ? '/api/auth/request-password-reset' : '/api/auth/reset-password'), 1); assert.equal(await page.getByText('Synthetic private backend text never shown', { exact: true }).count(), 0);
  } pass('SYNTHETIC failed and rate-limited POSTs use stable uncertain copy and never automatically retry or sign in');

  let oldMe; await fresh('', async (route, call) => { if (call.path === '/api/me') { oldMe = route; held.push(route); return true; } return false; }); await wait(() => Boolean(oldMe));
  await page.evaluate(token => { location.hash = 'password-reset=' + token; }, tokenA); await heading('Choose a new password').waitFor();
  const observedOldMe = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me' && response.status() === 200).then(async response => ({ status: response.status(), body: await response.json() }));
  const oldIdentity = { user: { id: 'ed000000-0000-4000-8000-000000000001', name: 'OLD SYNTHETIC ACCOUNT', email: 'old@example.com' }, instanceOperator: false, workspaces: [] }; await reply(oldMe, oldIdentity); assert.deepEqual(await observedOldMe, { status: 200, body: oldIdentity }); await heading('Choose a new password').waitFor(); await privateCapabilityAbsent();
  await fillReset(); assert.equal(await page.getByLabel('New password', { exact: true }).inputValue(), password); await heading('Choose a new password').waitFor();
  assert.equal(await page.getByText('OLD SYNTHETIC ACCOUNT', { exact: true }).count(), 0); assert.equal(evidence.requests.filter(call => call.context === evidence.contexts && call.path === '/api/account/preferences').length, 0); evidence.races.push({ kind: 'boot-Me replaced by reset', qualification: 'Synthetic held response; no real session or actor is fabricated as native evidence.' });
  pass('SYNTHETIC held initial boot identity cannot restore the App over a newer reset intent');

  let oldReset; await fresh('#password-reset=' + tokenA, async (route, call) => { if (call.path === '/api/auth/reset-password') { oldReset = route; held.push(route); return true; } return false; }); await heading('Choose a new password').waitFor(); await fillReset(); await button('Change password').click(); await wait(() => Boolean(oldReset));
  await page.evaluate(token => { location.hash = 'password-reset=' + token; }, tokenB); await heading('Choose a new password').waitFor(); await wait(() => page.getByLabel('New password', { exact: true }).inputValue().then(value => value === '')); await reply(oldReset, { ok: true }).catch(() => {}); await heading('Choose a new password').waitFor(); assert.equal(await page.getByText('Password changed. Sign in with your new password.', { exact: false }).count(), 0); await privateCapabilityAbsent();
  override = async (route, call) => { if (call.path !== '/api/auth/reset-password') return false; assert.deepEqual(call.body, { token: tokenB, newPassword: password }); await reply(route, { error: 'Synthetic replacement used' }, 400); return true; }; await fillReset(); await button('Change password').click(); await page.getByRole('alert').filter({ hasText: 'invalid, expired or already used' }).waitFor(); assert.equal(count('/api/auth/reset-password'), 2);
  let oldStatus; await fresh('', async (route, call) => { if (call.path === '/api/auth/password-reset-status') { oldStatus = route; held.push(route); return true; } return false; }); await requestMode(); await wait(() => Boolean(oldStatus)); await button('Back to sign in').click(); await heading('Sign in').waitFor(); await reply(oldStatus, { configured: true }).catch(() => {}); await heading('Sign in').waitFor(); assert.equal(await button('Send reset link').count(), 0);
  evidence.races.push({ kind: 'replacement reset and sign-in after held reads/writes', qualification: 'Real AbortSignal/unmount fences; aborted late route is not claimed as a delivered successful ACK.' });
  pass('SYNTHETIC replacement link owns its token and late reset/status completions cannot change the new recovery or sign-in identity');

  for (const width of [320, 1440]) for (const dir of ['ltr', 'rtl']) for (const zoom of [1, 2]) {
    await fresh('', async () => false, { width, dir, zoom }); await requestMode(); await page.getByLabel('Email address', { exact: true }).waitFor(); await page.getByLabel('Email address', { exact: true }).fill(email); await page.keyboard.press('Tab');
    assert.equal(await page.locator('html').getAttribute('dir'), dir); assert.equal(await page.locator('body').evaluate(element => getComputedStyle(element).zoom), String(zoom));
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Send reset link', 'Native Tab follows the actual email input; no programmatic focus or tabindex injection.');
    const bounds = await page.locator('main').evaluate(element => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })); assert.ok(bounds.scroll <= bounds.client + 1); assert.ok(bounds.left >= -1 && bounds.right <= width + 1);
    assert.ok(await page.locator('.auth-form-inner').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'High-zoom headings and controls stay inside the auth card.');
    for (const control of await page.locator('main input, main button').all()) { const box = await control.boundingBox(); assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1); assert.ok(box.height >= 44, 'Native form controls retain44CSSpx targets at bodyStyleZoom>=1.'); }
    const screenshot = out + '/recovery-' + width + '-' + dir + '-bodyzoom' + zoom + '.png'; await page.screenshot({ path: screenshot, fullPage: true }); evidence.screenshots.push(screenshot); evidence.layout.push({ width, dir, bodyStyleZoom: zoom, bounds });
  } pass('SYNTHETIC actual recovery App inputs keep native keyboard order and320/1440LTR/RTL body-style200percent containment');
  assert.equal(evidence.groups.length, 8); assert.equal(evidence.contexts, 25); assert.equal(evidence.screenshots.length, 8);
  assert.deepEqual(evidence.requests.filter(call => call.method === 'POST').reduce((counts, call) => ({ ...counts, [call.path]: (counts[call.path] ?? 0) + 1 }), {}), { '/api/auth/request-password-reset': 3, '/api/auth/reset-password': 8, '/api/auth/sign-in/email': 1 });
  assert.deepEqual(evidence.external, []); assert.deepEqual(evidence.unexpected, []); assert.deepEqual(evidence.pageErrors, []); evidence.phase = 'passed';
} catch (error) {
  evidence.phase = 'failed'; evidence.failure = { name: error.name, message: error.message }; process.exitCode = 1; startupPhase('failure');
  if (evidence.contexts === 1 && page) {
    evidence.startup.pendingStatic = [...staticRequests.values()].filter(item => pendingStatic.has(item.id));
    let diagnosticTimer;
    try {
      evidence.startup.dom = await Promise.race([
        page.evaluate(values => ({ readyState: document.readyState, origin: location.origin, pathname: location.pathname.slice(0, 512), headings: [...document.querySelectorAll('h1,h2,h3')].slice(0, 8).map(element => values.reduce((text, value) => text.replaceAll(value, '[redacted]'), element.textContent).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160)) }), [tokenA, tokenB, password, email]).catch(() => ({ unavailable: 'DOM read refused or context closed.' })),
        new Promise(resolve => { diagnosticTimer = setTimeout(() => resolve({ unavailable: 'DOM read exceeded diagnostic250ms bound.' }), 250); })
      ]);
    } finally { clearTimeout(diagnosticTimer); }
    save();
  }
}
finally {
  for (const route of held) await route.abort().catch(() => {});
  for (const [name, close] of [['context', () => context?.close()], ['browser', () => browser?.close()], ['vite', async () => { await server?.close(); assert.notEqual(server?.httpServer?.listening, true); }]]) { try { await close(); evidence.cleanup.push({ name, closed: true }); } catch (error) { evidence.cleanup.push({ name, closed: false, message: error.message }); evidence.phase = 'failed'; process.exitCode = 1; } }
  evidence.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify({ phase: evidence.phase, evidence: out + '/evidence.json' }));
}
