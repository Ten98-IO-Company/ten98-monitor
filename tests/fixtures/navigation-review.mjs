// SYNTHETIC navigation-review session for the opt-in shell and rank-loading browser suites.
// Nothing here is real customer, provider or installation data and no secret is committed:
// the suites need a real signed-in session, so this module provisions one at run time against a
// FRESH, UNCLAIMED, migrated local app (BASE_URL); its first sign-up claims the installation. It claims a
// throwaway owner, creates one synthetic website, invites a throwaway viewer and accepts the
// invitation. Passwords are random per run, held in memory only, and the returned session is a
// Playwright storage-state object (never written to disk).
// TEN98_SHELL_FIXTURE may still point at a private JSON ({synthetic, url, state, role}) for an existing session.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {loadPlaywright} from '../helpers/playwright.mjs';

export const insidePrivate = path => !isAbsolute(relative(resolve('private'), path)) && !relative(resolve('private'), path).split(sep).includes('..');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns {synthetic, role:'viewer', externalRequests:0, url, storageState} (storageState is an object or a private file path). */
export async function loadNavigationSession({baseUrl, override} = {}) {
  if (override) {
    const path = resolve(override);
    assert.ok(insidePrivate(path), 'Use a private synthetic navigation artifact.');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(typeof saved.state, 'string');
    const state = resolve(saved.state);
    assert.ok(insidePrivate(state), 'Authentication state must remain in private artifacts.');
    return {...saved, storageState: state};
  }
  assert.ok(baseUrl, 'baseUrl required');
  const secret = () => randomBytes(24).toString('base64url');
  const owner = {email: 'owner@navigation-review.test', password: secret()}, viewer = {email: 'viewer@navigation-review.test', password: secret()};
  const {request} = await loadPlaywright();
  const call = async (api, path, data, status) => {
    const response = await api.post(path, {data, headers: {origin: baseUrl}});
    assert.equal(response.status(), status, `Fixture provisioning ${path} answered ${response.status()}.`);
    return response.json();
  };
  const ownerApi = await request.newContext({baseURL: baseUrl});
  const viewerApi = await request.newContext({baseURL: baseUrl});
  try {
    await call(ownerApi, '/api/auth/setup', {name: 'Navigation owner', ...owner, workspaceName: 'Navigation review workspace'}, 200);
    const me = await (await ownerApi.get('/api/me')).json();
    const workspace = me.workspaces[0].id;
    assert.match(workspace, uuid);
    const created = await call(ownerApi, `/api/workspaces/${workspace}/projects`, {name: 'Navigation review website', origin: 'https://navigation-review.example.test'}, 201);
    const project = created.project?.id ?? created.id;
    assert.match(project, uuid);
    const {inviteUrl} = await call(ownerApi, `/api/workspaces/${workspace}/invitations`, {email: viewer.email, role: 'viewer'}, 201);
    await call(viewerApi, '/api/invitations/accept', {token: new URL(inviteUrl).hash.replace(/^#invite=/, ''), name: 'Navigation viewer', password: viewer.password}, 200);
    return {synthetic: true, role: 'viewer', externalRequests: 0, storageState: await viewerApi.storageState(),
      url: `${baseUrl}/?${new URLSearchParams({workspace, project, view: 'project'})}`};
  } finally { await ownerApi.dispose(); await viewerApi.dispose(); }
}
