import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {hashPassword} from 'better-auth/crypto';
import {claimInstallation} from '../src/server/auth.ts';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {createWorkspace,removeMember} from '../src/server/teams.ts';
import {launchChromium} from './helpers/playwright.mjs';

// Real local UI acceptance. Playwright is optional operator tooling, not an application dependency.
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
const config=getConfig();
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(config.appUrl).hostname));
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(config.databaseUrl).hostname));
assert.ok(process.env.PLAYWRIGHT_MODULE,'Set PLAYWRIGHT_MODULE to the installed Playwright module URL.');
let browser:any,releaseProjects:(()=>void)|undefined;
try {
  await assertSchema();
  const {pool}=getDatabase();
  const email=`${randomUUID()}@reports-ui.integration.test`,password=randomBytes(24).toString('base64url');
  if(!(await pool.query("SELECT claimed FROM installation WHERE id='instance'")).rows[0].claimed) {
    await claimInstallation({name:'Report UI owner',email,password,workspaceName:'Report UI checks'});
  } else {
    const userId=randomUUID();
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[userId,'Report UI owner',email]);
    await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,$3,$2,$4)',[randomUUID(),userId,'credential',await hashPassword(password)]);
    await createWorkspace(userId,{name:'Report UI checks'});
  }
  browser=await launchChromium();
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  const request=async(path:string,body?:unknown)=>{
    const response=body===undefined?await context.request.get(config.appUrl+path):await context.request.post(config.appUrl+path,{headers:{origin:config.appUrl},data:body});
    assert.ok(response.ok(),`Fixture API failed at ${path}`);return response.json();
  };
  await request('/api/auth/sign-in/email',{email,password});
  const me=await request('/api/me'),workspaceId=me.workspaces[0].id;
  const project=(await request(`/api/workspaces/${workspaceId}/projects`,{name:'UI report project',origin:'https://report-ui.integration.test'})).project;
  const otherProject=(await request(`/api/workspaces/${workspaceId}/projects`,{name:'Other report project',origin:'https://other-report-ui.integration.test'})).project;
  const page=await context.newPage();let pageErrors=0;page.on('pageerror',()=>{pageErrors++;});
  async function navigation() {
    const toggle=page.getByRole('button',{name:/^(Menu|Close menu)$/});
    if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')==='false') await toggle.click();
  }
  async function selectProject(name:string) {
    await navigation();await page.getByRole('navigation',{name:'Projects',exact:true}).getByRole('button',{name,exact:true}).click();
  }
  async function section(name:string) {
    await navigation();await page.getByRole('navigation',{name:'Project sections',exact:true}).getByRole('button',{name,exact:true}).click();
  }
  // A late first-project response must not replace an explicitly chosen account view.
  const projectPath=`**/api/workspaces/${workspaceId}/projects`;
  const projectGate=new Promise<void>(resolve=>{releaseProjects=resolve;});
  await page.route(projectPath,async(route:any)=>{const response=await route.fetch();await projectGate;await route.fulfill({response});});
  await page.goto(config.appUrl,{waitUntil:'domcontentloaded'});
  await page.getByRole('navigation',{name:'Workspace settings',exact:true}).getByRole('button',{name:'Account security',exact:true}).click();
  await page.getByRole('heading',{name:'Two-factor authentication',exact:true}).waitFor();
  releaseProjects?.();
  await page.getByRole('navigation',{name:'Projects',exact:true}).getByRole('button',{name:'UI report project',exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Two-factor authentication',exact:true}).isVisible(),true,'Late project loading must preserve newer explicit navigation.');
  await page.unroute(projectPath);
  // Exercise callback navigation without an IdP: this deliberately invalid proof
  // must stay on its identity result view, never be mistaken for successful sign-in.
  const identityPage=await context.newPage();let releaseIdentity!:()=>void;
  const identityGate=new Promise<void>(resolve=>{releaseIdentity=resolve;});
  try {
    await identityPage.route(projectPath,async(route:any)=>{const response=await route.fetch();await identityGate;await route.fulfill({response});});
    await identityPage.goto(`${config.appUrl}/#oidc-proof=${randomUUID()}`,{waitUntil:'domcontentloaded'});
    await identityPage.getByRole('heading',{name:'Your sign-in methods',exact:true}).waitFor();
    releaseIdentity();
    await identityPage.getByRole('navigation',{name:'Projects',exact:true}).getByRole('button',{name:'UI report project',exact:true}).waitFor();
    assert.equal(await identityPage.getByRole('heading',{name:'Your sign-in methods',exact:true}).isVisible(),true,'Project loading must preserve identity callback navigation.');
    assert.equal(new URL(identityPage.url()).hash,'','Identity callback fragments must be cleared.');
  } finally {releaseIdentity();await identityPage.close();}
  await selectProject('UI report project');
  await section('Reports');
  // Selectors below intentionally follow visible labels rather than internal component state.
  await page.getByRole('button',{name:'New report',exact:true}).click();
  await page.getByLabel('Report title',{exact:true}).fill('Quarterly review');
  const source='<html><head><title>Quarterly review</title></head><body><h1>Public snapshot one</h1><script>window.reportExecuted=true</script></body></html>';
  await page.getByLabel('HTML source',{exact:true}).fill(source);
  await page.getByRole('button',{name:'Save report',exact:true}).click();
  await page.getByRole('button',{name:'Preview saved report',exact:true}).click();
  const frame=page.frameLocator('iframe[title]');
  await frame.getByRole('heading',{name:'Public snapshot one'}).waitFor();
  assert.equal(await frame.locator('script').count(),0);
  const saved=(await request(`/api/projects/${project.id}/reports`)).reports.find((row:any)=>row.title==='Quarterly review');
  assert.ok(saved);assert.equal((await request(`/api/projects/${project.id}/reports/${saved.id}`)).report.html,source);
  await page.reload({waitUntil:'networkidle'});
  await selectProject('UI report project');
  await section('Reports');
  await page.getByRole('button',{name:'Quarterly review',exact:true}).click();
  assert.equal(await page.getByLabel('HTML source',{exact:true}).inputValue(),source);
  // A competing saved revision must never overwrite a typed draft silently.
  await page.getByLabel('HTML source',{exact:true}).fill('<h1>My unsaved draft</h1>');
  await request(`/api/projects/${project.id}/reports/${saved.id}`,{title:'Quarterly review',html:'<h1>Concurrent version</h1>',revision:1});
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.getByText(/changed.*reload/i).first().waitFor();
  assert.equal(await page.getByLabel('HTML source',{exact:true}).inputValue(),'<h1>My unsaved draft</h1>');
  await page.getByRole('button',{name:'Reload saved version',exact:true}).click();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('textarea')).some(input=>input.value==='<h1>Concurrent version</h1>'));
  console.log('PASS report UI: real save/reload, preserved private source, isolated preview and optimistic-conflict draft preservation');

  const panel=page.getByRole('region',{name:'Reports and sharing',exact:true});
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Fixture clipboard denial');}}}));
  await page.getByLabel('Link label',{exact:true}).fill('Client alpha');
  await page.getByRole('checkbox',{name:/I have reviewed saved revision 2/}).check();
  // Synchronous duplicate activation must still produce exactly one capability.
  await page.getByRole('button',{name:'Create public link',exact:true}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
  const oneTime=page.getByLabel('One-time share URL',{exact:true});
  await oneTime.waitFor();const firstUrl=await oneTime.inputValue();
  let links=await request(`/api/projects/${project.id}/reports/${saved.id}/shares`);
  assert.equal(links.shares.length,1);assert.equal(JSON.stringify(links).includes(firstUrl),false);
  const publicSnapshot=await context.request.get(firstUrl);assert.equal(publicSnapshot.status(),200);assert.match(await publicSnapshot.text(),/Concurrent version/);
  await page.getByRole('button',{name:'Copy link',exact:true}).click();
  await page.getByText(/Automatic copy is unavailable/).waitFor();
  const selection=await oneTime.evaluate((input:HTMLInputElement)=>({start:input.selectionStart,end:input.selectionEnd,length:input.value.length}));
  assert.deepEqual(selection,{start:0,end:selection.length,length:selection.length});
  await page.getByLabel('HTML source',{exact:true}).fill('<h1>Private version three</h1>');
  assert.equal(await page.getByRole('button',{name:'Create public link',exact:true}).isDisabled(),true,'Dirty source cannot be shared as though saved.');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.getByText('Report saved. Preview the saved version before sharing.').waitFor();
  assert.equal(await oneTime.count(),0);assert.match(await (await context.request.get(firstUrl)).text(),/Concurrent version/);
  const firstRow=page.getByRole('row').filter({hasText:'Client alpha'});
  await firstRow.getByRole('button',{name:'Revoke link',exact:true}).click();
  await firstRow.getByRole('button',{name:'Revoke link',exact:true}).click();
  await firstRow.getByText('Revoked',{exact:true}).waitFor();assert.equal((await context.request.get(firstUrl)).status(),404);
  await page.getByLabel('Link label',{exact:true}).fill('Current link');
  await page.getByRole('checkbox',{name:/I have reviewed saved revision 3/}).check();
  await page.getByRole('button',{name:'Create public link',exact:true}).click();await oneTime.waitFor();
  const currentUrl=await oneTime.inputValue();
  const currentRow=page.getByRole('row').filter({hasText:'Current link'});
  await currentRow.getByRole('button',{name:'Revoke link',exact:true}).click();
  await currentRow.getByRole('button',{name:'Revoke link',exact:true}).click();
  await currentRow.getByText('Revoked',{exact:true}).waitFor();assert.equal(await oneTime.count(),0);assert.equal((await context.request.get(currentUrl)).status(),404);
  console.log('PASS report UI: duplicate-submit lock, immutable snapshots, dirty-share gate, clipboard fallback and matching-link revocation clears the capability');

  let failTemplateRead=true;
  const templatePath=`**/api/projects/${project.id}/report-templates`;
  await page.route(templatePath,async(route:any)=>{
    if(route.request().method()==='GET'&&failTemplateRead) {failTemplateRead=false;await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Template list temporarily unavailable.'})});}
    else await route.continue();
  });
  await panel.getByRole('button',{name:'Templates',exact:true}).click();
  await page.getByText('No templates saved yet.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Quarterly review',exact:true}).count(),0,'Access-error recovery must refresh the selected collection, not the previous tab.');
  await page.unroute(templatePath);
  await page.getByRole('button',{name:'New template',exact:true}).click();
  await page.getByLabel('Template name',{exact:true}).fill('Monthly briefing');
  await page.getByLabel('Template brief',{exact:true}).fill('Compare the previous month. <script>This is plain text.</script>');
  await page.getByRole('button',{name:'Save template',exact:true}).click();await page.getByText('Template saved.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Copy brief',exact:true}).click();await page.getByText(/Automatic copy is unavailable/).waitFor();
  assert.equal(await page.getByLabel('Template brief',{exact:true}).evaluate((input:HTMLTextAreaElement)=>input.selectionEnd===input.value.length&&input.selectionStart===0),true);
  await page.getByLabel('Template brief',{exact:true}).fill('Changed draft');
  assert.equal(await panel.getByRole('button',{name:'Reports',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Cancel edits',exact:true}).click();
  assert.equal(await page.getByLabel('Template brief',{exact:true}).inputValue(),'Compare the previous month. <script>This is plain text.</script>');
  await page.getByRole('button',{name:'Delete template',exact:true}).click();await page.getByRole('button',{name:'Delete template permanently',exact:true}).click();
  await page.getByText('Template deleted.',{exact:true}).waitFor();assert.equal((await request(`/api/projects/${project.id}/report-templates`)).templates.length,0);
  await panel.getByRole('button',{name:'Reports',exact:true}).click();await page.getByRole('button',{name:'Quarterly review',exact:true}).click();

  let received!:()=>void,release!:()=>void;
  const intercepted=new Promise<void>(resolve=>{received=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
  const sharePath=`**/api/projects/${project.id}/reports/${saved.id}/shares`;
  await page.route(sharePath,async(route:any)=>{
    if(route.request().method()!=='POST') {await route.continue();return;}
    const response=await route.fetch();received();await released;
    try {await route.fulfill({response});} catch {/* The component aborts its request on project switch. */}
  });
  await page.getByLabel('Link label',{exact:true}).fill('Delayed result');
  await page.getByRole('checkbox',{name:/I have reviewed saved revision 3/}).check();
  await page.getByRole('button',{name:'Create public link',exact:true}).click();
  await Promise.race([intercepted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Share response was not intercepted.')),10000))]);
  await selectProject('Other report project');release();
  await section('Reports');await page.getByText('No reports saved yet.',{exact:false}).waitFor();
  assert.equal(await oneTime.count(),0);assert.equal(await page.getByLabel('HTML source',{exact:true}).count(),0);
  await page.unroute(sharePath);
  await selectProject('UI report project');await section('Reports');await page.getByRole('button',{name:'Quarterly review',exact:true}).click();
  assert.equal(await oneTime.count(),0,'Returning to a record must never recover a one-time URL.');
  await page.getByLabel('Link label',{exact:true}).fill('Clipboard race');await page.getByRole('checkbox',{name:/I have reviewed saved revision 3/}).check();
  await page.getByRole('button',{name:'Create public link',exact:true}).click();await oneTime.waitFor();
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise<void>(resolve=>{(window as unknown as {finishFixtureCopy:()=>void}).finishFixtureCopy=resolve;})}}));
  await page.getByRole('button',{name:'Copy link',exact:true}).click();
  await selectProject('Other report project');
  await page.evaluate(()=>(window as unknown as {finishFixtureCopy:()=>void}).finishFixtureCopy());
  await section('Reports');await page.getByText('No reports saved yet.',{exact:false}).waitFor();
  assert.equal(await page.getByText('Copied.',{exact:true}).count(),0);assert.equal(await oneTime.count(),0);
  await page.getByRole('button',{name:'New report',exact:true}).click();await page.getByLabel('Report title',{exact:true}).fill('Temporary deletion check');await page.getByLabel('HTML source',{exact:true}).fill('<p>Delete this fixture</p>');
  await page.getByRole('button',{name:'Save report',exact:true}).click();await page.getByRole('checkbox',{name:/I have reviewed saved revision 1/}).check();
  await page.getByRole('button',{name:'Create public link',exact:true}).click();await oneTime.waitFor();const deletedUrl=await oneTime.inputValue();
  await page.getByRole('button',{name:'Delete report',exact:true}).click();await page.getByRole('button',{name:'Delete report permanently',exact:true}).click();
  await page.getByText('Report deleted. Its public links are now unavailable.',{exact:true}).waitFor();
  assert.equal((await context.request.get(deletedUrl)).status(),404);assert.equal((await request(`/api/projects/${otherProject.id}/reports`)).reports.length,0);
  console.log('PASS report UI: templates are reusable plain text; dirty navigation, deletion and late share/clipboard results cannot cross project boundaries');

  await selectProject('UI report project');await section('Reports');
  let failHistory=true;
  await page.route(sharePath,async(route:any)=>{
    if(route.request().method()==='GET'&&failHistory) {failHistory=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Link history temporarily unavailable.'})});}
    else await route.continue();
  });
  await page.getByRole('button',{name:'Quarterly review',exact:true}).click();await page.getByRole('alert').filter({hasText:'Link history temporarily unavailable.'}).waitFor();
  await page.getByText('Link history has not loaded. Choose Refresh links to try again.',{exact:true}).waitFor();
  assert.equal(await page.getByText('No public links have been created.',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Refresh links',exact:true}).click();await page.getByRole('row').filter({hasText:'Client alpha'}).waitFor();await page.unroute(sharePath);
  await mkdir('private/reports-screenshots',{recursive:true});
  for(const width of [1280,360]) {
    await page.setViewportSize({width,height:900});
    if(width===360) {
      const menu=page.getByRole('button',{name:'Menu',exact:true});
      assert.equal(await menu.getAttribute('aria-expanded'),'false');assert.equal(await menu.getAttribute('aria-controls'),'app-navigation');
      assert.equal(await page.getByRole('navigation',{name:'Project sections',exact:true}).isVisible(),false);
      await menu.focus();await page.keyboard.press('Enter');
      const close=page.getByRole('button',{name:'Close menu',exact:true});assert.equal(await close.getAttribute('aria-expanded'),'true');
      const install=page.getByRole('navigation',{name:'Project sections',exact:true}).getByRole('button',{name:'Install tracker',exact:true});
      await install.focus();await page.keyboard.press('Enter');
      await page.getByRole('heading',{name:'Install the tracker',exact:true}).waitFor();
      await page.waitForFunction(()=>document.activeElement===document.querySelector('main'));
      assert.equal(await menu.getAttribute('aria-expanded'),'false');assert.equal(await page.getByRole('navigation',{name:'Project sections',exact:true}).isVisible(),false);
      assert.match(await page.locator('pre.snippet').textContent()??'',/tracker\.js/);
      await menu.focus();await page.keyboard.press('Space');
      const recent=page.getByRole('navigation',{name:'Project sections',exact:true}).getByRole('button',{name:'Recent events',exact:true});
      await recent.focus();await page.keyboard.press('Enter');
      await page.getByRole('heading',{name:'Recent events',level:1,exact:true}).waitFor();
      assert.equal(await page.locator('pre.snippet').count(),0,'Recent events must not expose the installation panel.');
      await selectProject('Other report project');await page.getByRole('heading',{name:'Web analytics',level:1,exact:true}).waitFor();
      await selectProject('UI report project');await section('Reports');await page.getByRole('button',{name:'Quarterly review',exact:true}).click();
      await page.getByRole('row').filter({hasText:'Client alpha'}).waitFor();
      assert.equal(await menu.getAttribute('aria-expanded'),'false');
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Report UI must fit viewport ${width}.`);
    assert.equal(await oneTime.count(),0,'Screenshots must not contain a one-time capability.');
    await page.screenshot({path:`private/reports-screenshots/reports-${width}.png`,fullPage:true});
  }
  const extraOwner=randomUUID();await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[extraOwner,'Permission fixture owner',`${randomUUID()}@reports-ui.integration.test`]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,extraOwner]);
  await page.getByLabel('Link label',{exact:true}).fill('Permission race');await page.getByRole('checkbox',{name:/I have reviewed saved revision 3/}).check();
  await pool.query("UPDATE membership SET role='editor' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,me.user.id]);
  await page.getByRole('button',{name:'Create public link',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Your current role cannot perform this report action.'}).waitFor();
  assert.equal(await page.getByLabel('HTML source',{exact:true}).count(),0);assert.equal(await page.getByRole('region',{name:'Public report links',exact:true}).count(),0);assert.equal(await oneTime.count(),0);
  await page.getByRole('button',{name:'Quarterly review',exact:true}).click();
  assert.equal(await page.getByLabel('HTML source',{exact:true}).isEditable(),true);
  await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,me.user.id]);
  await page.getByRole('button',{name:'Refresh list',exact:true}).click();
  await page.getByRole('button',{name:'New report',exact:true}).waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('#report-body')?.readOnly===true);
  assert.equal(await page.getByRole('button',{name:'New report',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Delete report',exact:true}).count(),0);
  await removeMember(workspaceId,extraOwner,me.user.id);
  await page.getByRole('button',{name:'Refresh list',exact:true}).click();await page.getByRole('alert').filter({hasText:'Report not found or unavailable.'}).waitFor();
  assert.equal(await page.getByLabel('HTML source',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Quarterly review',exact:true}).count(),0);
  await pool.query('DELETE FROM session WHERE "userId"=$1',[me.user.id]);await page.getByRole('button',{name:'Retry loading',exact:true}).click();
  await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();assert.equal(await panel.count(),0);
  console.log('PASS report UI: late account/identity navigation, keyboard mobile menu and focus, separate install/events views, 1280/360px layouts, owner-to-editor sharing denial, viewer read-only state, removal purge and revoked session sign-in');
  assert.equal(pageErrors,0,'Report flows must not raise uncaught browser errors.');
} finally {releaseProjects?.();await browser?.close();await closeDatabase();}
