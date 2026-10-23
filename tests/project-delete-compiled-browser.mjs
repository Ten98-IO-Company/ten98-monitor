// TEN98_PROJECT_DELETE_COMPILED=1 BASE_URL=http://127.0.0.1:3111 OUT_DIR=<new private dir> PLAYWRIGHT_MODULE=<owned playwright> node tests/project-delete-compiled-browser.mjs
// Drives the real built server (node .output/server/index.mjs) on a FRESH, UNCLAIMED, migrated local database with headless Edge.
// Claims the owner, creates two synthetic websites, deletes one from Collection and privacy, then checks router, selector, reload, 404 and stale deep link.
// Then creates a public website link on the surviving website and opens it in a fresh context (sections, fragment scrub, capability-only reads, 44 px, revoke, reload).
import assert from 'node:assert/strict';assert.equal(process.env.TEN98_PROJECT_DELETE_COMPILED,'1');assert.match(process.env.BASE_URL??'',/^http:\/\/127\.0\.0\.1:\d+$/,'Point BASE_URL at a local throwaway server; never a saved installation.');
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {launchChromium} from './helpers/playwright.mjs';
const base=process.env.BASE_URL,out=process.env.OUT_DIR;
const browser=await launchChromium();const evidence={steps:[],errors:[],api:[],csp:null};
const context=await browser.newContext({viewport:{width:1440,height:1000}});
// Every frame reports Content-Security-Policy violations as console errors, so a blocked script, style, image or frame fails the harness.
await context.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>console.error('csp '+e.effectiveDirective+' '+e.blockedURI)));
const page=await context.newPage();page.setDefaultTimeout(10000);
page.on('pageerror',e=>evidence.errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('Failed to load resource:'))evidence.errors.push(m.text());});page.on('response',r=>{if(r.url().includes('/api/'))evidence.api.push(r.request().method()+' '+r.status()+' '+new URL(r.url()).pathname);});
const step=(name)=>{evidence.steps.push(name);console.log('STEP '+name);};
try{
 const projectSelect=()=>page.locator('aside.t98-shell-sidebar').getByLabel('Project',{exact:true}),projectOption=name=>projectSelect().locator('option').filter({hasText:new RegExp('^'+name+'$')});
 const landing=await page.goto(base+'/',{waitUntil:'domcontentloaded'});
 evidence.csp=landing.headers()['content-security-policy']??null;const headerNonce=evidence.csp?.match(/'nonce-([^']+)'/)?.[1];assert.ok(headerNonce,'The compiled document must carry a nonce policy.');
 assert.equal(await page.evaluate(()=>document.querySelector('script[type="module"]').nonce),headerNonce,'The module entry script must carry the header nonce.');step('document policy nonce matches the module entry script');
 await page.getByRole('heading',{name:'Create owner account'}).waitFor();
 await page.getByLabel('Setup token',{exact:true}).fill('not-used');await page.getByLabel('Your name',{exact:true}).fill('Compiled owner');await page.getByLabel('Email address',{exact:true}).fill('owner@compiled-delete.test');await page.getByLabel('Password',{exact:true}).fill('synthetic-password-12345');await page.getByLabel('Workspace name',{exact:true}).fill('Compiled workspace');
 await page.getByRole('button',{name:'Create owner account'}).click();
 await projectSelect().waitFor({state:'attached'});step('owner claimed and signed in');
 // Mirrors the ReplayPreview player document in src/components/SessionReplayPanel.tsx: a data: frame inherits the page policy, mints its own
 // nonce and must still execute /replay.js (which injects its <style>); a template change there must be mirrored here.
 await page.evaluate(()=>new Promise((done,fail)=>{const nonce=crypto.randomUUID().replaceAll('-',''),asset=new URL('/replay.js',window.location.href);
  const html=`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; worker-src 'none'; frame-src about:; font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><div id="replay-root"></div><script nonce="${nonce}" data-ten98-replay="player" referrerpolicy="no-referrer" src="${asset.href}"></script>`;
  const frame=document.createElement('iframe');frame.title='csp replay probe';frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.referrerPolicy='no-referrer';frame.src='data:text/html;charset=utf-8,'+encodeURIComponent(html);frame.onload=()=>done();frame.onerror=()=>fail(new Error('replay probe frame failed to load'));document.body.appendChild(frame);}));
 const replayFrame=page.frames().find(f=>f.url().startsWith('data:'));assert.ok(replayFrame,'The replay probe frame must exist.');
 await replayFrame.waitForFunction(()=>document.head.querySelector('style')!==null,null,{timeout:10000});
 await page.evaluate(()=>document.querySelector('iframe[title="csp replay probe"]').remove());step('replay data: frame executed /replay.js under the inherited document policy');
 const workspaceId=await page.getByRole('combobox',{name:'Workspace',exact:true}).inputValue();assert.match(workspaceId,/^[0-9a-f-]{36}$/);
 async function create(name,origin){await page.goto(base+'/?workspace='+workspaceId+'&view=new-project',{waitUntil:'domcontentloaded'});await page.getByLabel('Project name',{exact:true}).fill(name);await page.getByLabel('Website address',{exact:true}).fill(origin);await page.getByRole('button',{name:'Create project'}).click();await projectOption(name).waitFor({state:'attached'});}
 await create('Doomed website','https://doomed.compiled-delete.test');await create('Surviving website','https://surviving.compiled-delete.test');step('two projects created');
 const doomedId=await projectOption('Doomed website').getAttribute('value');assert.match(doomedId,/^[0-9a-f-]{36}$/);
 await page.goto(base+'/?workspace='+workspaceId+'&project='+doomedId+'&view=collection',{waitUntil:'domcontentloaded'});
 await page.getByRole('heading',{name:'Collection and privacy',level:2}).waitFor();
 await page.getByRole('button',{name:'Delete website',exact:true}).click();await page.locator('main').getByText('Doomed website',{exact:true}).first().waitFor();
 await page.getByRole('textbox',{name:'Type DELETE to confirm',exact:true}).fill('DELETE');await page.getByRole('button',{name:'Permanently delete website'}).click();step('deletion confirmed in the compiled settings view');
 await page.waitForURL(url=>{const p=new URL(url).searchParams;return p.get('workspace')===workspaceId&&p.get('view')==='project'&&p.get('project')===null;});step('router navigated to the workspace project view without a project parameter');
 await projectOption('Surviving website').waitFor({state:'attached'});
 await page.waitForFunction(()=>![...document.querySelectorAll('nav[aria-label="Projects"] a')].some(a=>a.textContent==='Doomed website'));step('selector entry removed while the surviving project remains');
 const settings=await page.evaluate(async id=>{const r=await fetch('/api/projects/'+id+'/analytics-settings',{credentials:'same-origin'});return r.status;},doomedId);assert.equal(settings,404);step('deleted project settings answer 404 for the signed-in owner');
 await page.reload({waitUntil:'domcontentloaded'});await projectOption('Surviving website').waitFor({state:'attached'});assert.equal(await projectOption('Doomed website').count(),0);step('reloaded catalog omits the deleted project');
 await page.goto(base+'/?workspace='+workspaceId+'&project='+doomedId+'&view=project',{waitUntil:'domcontentloaded'});await page.getByText('That project is no longer available in this workspace. Choose a current project.',{exact:true}).waitFor();step('stale deep link reports the project as no longer available');
 await page.screenshot({path:resolve(out,'after-delete.png'),fullPage:true});
 // Website public share (P45): the owner creates a link in Collection and privacy; a fresh context carrying the owner's cookies opens it.
 const survivingId=await projectOption('Surviving website').getAttribute('value');
 await page.goto(base+'/?workspace='+workspaceId+'&project='+survivingId+'&view=collection',{waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'Collection and privacy',level:2}).waitFor();
 await page.getByRole('button',{name:'New public link',exact:true}).click();await page.getByRole('textbox',{name:'Link name',exact:true}).fill('Compiled public link');await page.getByRole('button',{name:'Create public link',exact:true}).click();
 const shareUrl=await page.getByRole('textbox',{name:'New public website URL'}).inputValue();assert.match(shareUrl,new RegExp('^'+base.replaceAll('.','\\.')+'/share/websites/[0-9a-f-]{36}#[A-Za-z0-9_-]{43}$'));step('owner created a public website link from Collection and privacy');
 const recipient=await browser.newContext({viewport:{width:390,height:900}});await recipient.addCookies(await context.cookies());await recipient.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>console.error('csp '+e.effectiveDirective+' '+e.blockedURI)));
 const visitor=await recipient.newPage();visitor.setDefaultTimeout(10000);const recipientErrors=[],reads=[];
 visitor.on('pageerror',e=>recipientErrors.push(e.message));visitor.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('Failed to load resource:'))recipientErrors.push(m.text());});visitor.on('request',r=>{if(r.url().includes('/api/website-shares/'))reads.push(r.allHeaders());});
 await visitor.goto(shareUrl,{waitUntil:'domcontentloaded'});await visitor.getByRole('heading',{name:'Shared website',level:1}).waitFor();await visitor.getByRole('heading',{name:'Compiled public link'}).waitFor();
 await visitor.getByRole('region',{name:'Shared overview'}).waitFor();await visitor.getByRole('region',{name:'Shared events'}).waitFor();assert.equal(await visitor.getByRole('region',{name:'Shared locations'}).count(),0,'Regions and cities are opt-in.');
 assert.equal(new URL(visitor.url()).hash,'','The secret is removed from the address bar.');step('recipient sees the granted overview and events sections and the fragment is scrubbed');
 const sent=await Promise.all(reads);assert.ok(sent.length>=1);for(const headers of sent){assert.match(headers['x-ten98-website-share']??'',/^[A-Za-z0-9_-]{43}$/);for(const name of ['cookie','authorization','referer'])assert.equal(headers[name],undefined,name+' must not be sent with a share read.');}step('share reads carry only the capability header: no cookie, authorization or referer');
 assert.ok(await visitor.evaluate(()=>[...document.querySelectorAll('main button, main input')].every(el=>el.getBoundingClientRect().height>=44)),'Recipient controls measure at least 44 px.');step('recipient controls measure at least 44 px');
 await page.getByRole('button',{name:'Load public links',exact:true}).click();await page.getByRole('button',{name:'Revoke: Compiled public link'}).click();await page.getByRole('dialog',{name:'Revoke this public link now?',exact:true}).getByRole('button',{name:'Revoke link',exact:true}).click();await page.getByText('Shared link revoked. It stops working on its next read.',{exact:true}).waitFor();
 await visitor.getByRole('button',{name:'Refresh shared website',exact:true}).click();await visitor.getByText('This shared website is unavailable, revoked, expired or could not be verified.',{exact:true}).waitFor();step('after revocation the recipient refresh shows the unavailable alert');
 const before=reads.length;await visitor.reload({waitUntil:'domcontentloaded'});await visitor.getByText('This link is incomplete or malformed. Open the original link from its owner. No website data was requested.',{exact:true}).waitFor();assert.equal(reads.length,before,'A reload without the fragment sends no share request.');step('reload without the fragment sends no request');
 await visitor.screenshot({path:resolve(out,'website-share.png'),fullPage:true});await recipient.close();assert.deepEqual(recipientErrors,[],'The recipient page must run without console errors or policy violations.');step('recipient page has zero console errors and zero policy violations');
 assert.deepEqual(evidence.errors,[],'The compiled app must run without console errors or policy violations.');step('zero console errors and zero policy violations');evidence.phase='passed';
}catch(error){evidence.phase='failed';evidence.failure=String(error.stack||error);await page.screenshot({path:resolve(out,'failure.png'),fullPage:true}).catch(()=>{});}
finally{await writeFile(resolve(out,'evidence.json'),JSON.stringify(evidence,null,1));await browser.close();}
console.log(JSON.stringify({phase:evidence.phase,steps:evidence.steps.length,errors:evidence.errors,failure:evidence.failure??null}));if(evidence.phase!=='passed')process.exit(1);
