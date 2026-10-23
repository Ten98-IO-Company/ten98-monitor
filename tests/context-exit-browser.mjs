// Actual App, router, sidebar and sign-out; closed synthetic API, no backend/provider acceptance.
// TEN98_CONTEXT_EXIT_BROWSER=1 PLAYWRIGHT_MODULE=<installed entry> node tests/context-exit-browser.mjs
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {createServer} from 'vite';
import {launchChromium} from './helpers/playwright.mjs';
assert.equal(process.env.TEN98_CONTEXT_EXIT_BROWSER,'1');
assert.ok(process.env.PLAYWRIGHT_MODULE);
const W='10000000-0000-4000-8000-000000000001',P='20000000-0000-4000-8000-000000000001',U='30000000-0000-4000-8000-000000000001',stamp='2026-10-19T00:00:00Z';
const user={id:U,name:'Synthetic context user',email:'context@example.com'};
const original=()=>({project:{id:P,name:'Synthetic project',origin:'https://context.example'},role:'owner',revision:1,profile:{name:'Saved brand',aliases:[]},sections:[],missingSections:['business_overview','current_goal','positioning','writing_preferences'],customSections:[{key:'custom:audience',title:'Audience',content:'Saved audience',updatedAt:stamp,updatedBy:U}],competitors:[],keyPages:[],researchLog:[],researchLogNextCursor:null,reportTemplates:[],reportTemplatesTruncated:false});
const errors=[],unexpected=[],groups=[];let browser,context,page,origin,model,writeMode,held=null,signedOut,writes,apiRequests=0,contexts=0,signOutMode='ok',heldSignOut=null,signOutCalls=0;
// Regression control removes only the new blocker in Vite memory; source stays unchanged.
const oracle=process.env.TEN98_CONTEXT_EXIT_ORACLE==='1';
const plugins=oracle?[{name:'original-context-exit-control',enforce:'pre',transform(code,id){if(!id.replaceAll(String.fromCharCode(92),'/').endsWith('/src/components/ContextPanel.tsx'))return;const line=code.split(String.fromCharCode(10)).find(line=>line.startsWith('  useBlocker({shouldBlockFn:()=>protectExit'));assert.ok(line,'One reviewed context blocker must match');return code.replace(line,'');}}]:[];
const server=await createServer({plugins,configFile:false,envDir:false,root:process.cwd(),cacheDir:resolve('private/swarm/context-vite-cache'),appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{entries:['tests/context-exit-browser-fixture.tsx'],include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router','zod']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic context exits</title><div id="root"></div><script type="module" src="/tests/context-exit-browser-fixture.tsx"></script></html>');});
const watchdog=setTimeout(()=>process.exit(124),120000);watchdog.unref();
const deadline=setTimeout(()=>{console.error('Context exit check exceeded 110 seconds');void Promise.allSettled([context?.close(),browser?.close(),server.close()]).finally(()=>process.exit(1));},110000);deadline.unref();
const button=name=>page.getByRole('button',{name,exact:true}),brand=()=>page.getByLabel('Brand name',{exact:true}),sidebar=name=>page.locator('.t98-shell-sidebar').getByRole('link',{name,exact:true});
const pass=name=>{groups.push(name);console.log('PASS '+name);};
const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
const at=async view=>{await page.waitForFunction(view=>new URL(location.href).searchParams.get('view')===view,view);await frame();};
const ready=async()=>{await button('Edit business context').waitFor();await page.waitForFunction(()=>![...document.querySelectorAll('[role=status]')].some(el=>el.textContent==='Loading context…'));await frame();};
const settings=async()=>{await sidebar('Settings').click();await at('preferences');await page.getByLabel('Display name',{exact:true}).waitFor();};
const edit=async(name='Draft brand')=>{await button('Edit business context').click();if(name!==null)await brand().fill(name);await frame();};
const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
async function release(status=200){const pending=held;assert.ok(pending);held=null;await json(pending.route,status===200?pending.body:{error:'Synthetic save status '+status},status).catch(()=>{});}
async function fresh(view='context'){
 if(held){await held.route.abort().catch(()=>{});held=null;}await context?.close();model=original();writeMode=null;signedOut=false;writes=[];signOutMode='ok';signOutCalls=0;
 assert.ok(++contexts<=24,'24-context cap');context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  try{
   if(url.origin!==origin){unexpected.push(url.href);return route.abort();}if(!path.startsWith('/api/'))return req.method()==='GET'?route.continue():route.abort();
   assert.ok(++apiRequests<=100,'100-request cap');let body,status=200;
   if(path==='/api/session')body={setupRequired:false,appUrl:origin,user:null};
   else if(path==='/api/me'){status=signedOut?401:200;body=signedOut?{error:'Synthetic session ended'}:{user,instanceOperator:false,workspaces:[{id:W,name:'Synthetic workspace',role:'owner'}]};}
   else if(path==='/api/account/preferences')body={version:'account-preferences-v1',user,preferences:{revision:1,timeZone:'UTC',locale:'en-US',theme:'light',updatedAt:stamp}};
   else if(path==='/api/auth/oidc/providers')body={providers:[]};
   else if(path==='/api/auth/sign-out'&&req.method()==='POST'){signOutCalls++;if(signOutMode==='hold'){assert.equal(heldSignOut,null);heldSignOut=route;return;}signedOut=true;body=null;}
   else if(path===`/api/workspaces/${W}/projects`)body={projects:[{id:P,name:'Synthetic project',origin:'https://context.example',publicKey:'synthetic-key',eventCount:0,lastEventAt:null,retainedFrom:null}]};
   else if(path===`/api/projects/${P}/events`)body={events:[],total:0,retainedFrom:null};
   else if(path===`/api/projects/${P}/context`&&req.method()==='GET')body=structuredClone(model);
   else if(path===`/api/projects/${P}/context/update`&&req.method()==='POST'){
    writes.push(req.postData());const attempt=req.postDataJSON();assert.ok(attempt.requestId);assert.equal(attempt.revision,1);
    if(writeMode===409)return json(route,{error:'Synthetic revision conflict'},409);
    for(const op of attempt.updates){if(op.kind==='profile')model.profile={name:op.name,aliases:op.aliases};else if(op.kind==='remove-section')model.customSections=model.customSections.filter(section=>section.key!==op.key);else assert.fail('Unexpected synthetic operation '+op.kind);}
    model.revision=2;body=structuredClone(model);
    if(writeMode==='lost')return route.abort('connectionreset');
    if(writeMode==='hold'){assert.equal(held,null);held={route,body};return;}
   }else{unexpected.push(req.method()+' '+path);return route.abort();}
   return json(route,body,status);
  }catch(error){errors.push('Fixture: '+error.message);return route.abort();}
 });
 page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/?'+new URLSearchParams({workspace:W,project:P,view}));
 if(view==='context')await ready();else await page.getByLabel('Display name',{exact:true}).waitFor();
}
async function confirmAction(accept,action,type='confirm'){
 let count=0;const handler=async dialog=>{count++;assert.equal(dialog.type(),type);await(accept?dialog.accept():dialog.dismiss());};page.on('dialog',handler);
 try{await action();await frame();assert.equal(count,1,'Exactly one '+type+' confirmation');}finally{page.off('dialog',handler);}
}
// In-page confirmations use the shared ConfirmDialog; navigation and unload guards above stay native.
async function dialogAction(accept,action,title,confirmLabel){
 let count=0;const handler=async dialog=>{count++;await dialog.dismiss();};page.on('dialog',handler);
 try{await action();const dialog=page.getByRole('dialog',{name:title,exact:true});await dialog.getByRole('button',{name:accept?confirmLabel:'Cancel',exact:true}).click();await dialog.waitFor({state:'hidden'});await frame();assert.equal(count,0,'In-page confirmation opens no native prompt');}finally{page.off('dialog',handler);}
}
async function cleanAction(action){let count=0;const handler=async dialog=>{count++;await dialog.dismiss();};page.on('dialog',handler);try{await action();await frame();assert.equal(count,0,'Clean/unmounted state does not prompt');}finally{page.off('dialog',handler);}}
async function reloadCancelled(){await confirmAction(false,()=>page.reload({waitUntil:'commit',timeout:1000}).catch(error=>{assert.match(error.message,/ERR_ABORTED|interrupted|Timeout 1000ms exceeded/);}), 'beforeunload');}
async function waitHeld(){const end=Date.now()+5000;while(!held){assert.ok(Date.now()<end,'Held save was not reached');await new Promise(done=>setTimeout(done,10));}}
async function saved(){await page.getByText('Changes saved. No provider work was started.',{exact:true}).waitFor();await frame();}
try{
 await server.listen();assert.equal(server.httpServer.address().address,'127.0.0.1');origin='http://127.0.0.1:'+server.httpServer.address().port;
 await server.environments.client.transformRequest('/tests/context-exit-browser-fixture.tsx');await server.environments.client.waitForRequestsIdle();const optimizer=server.environments.client.depsOptimizer;await optimizer.scanProcessing;await Promise.all(Object.values(optimizer.metadata.discovered).map(item=>item.processing));
 browser=await launchChromium();
 await fresh();
 const appVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
 assert.equal(await page.locator('.t98-shell-sidebar').getByRole('button',{name:'Sign out',exact:true}).count(),0);
 assert.equal(await page.locator('.t98-sidebar-footer').getByText('Version '+appVersion,{exact:true}).count(),1);
 const requestCount=apiRequests;
 for(const width of [320,1440])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height:900});await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;},theme);await frame();
  const trigger=button('Account menu');await trigger.click();const panel=page.locator('[id="'+await trigger.getAttribute('aria-controls')+'"]');
  assert.deepEqual(await panel.getByRole('link').allTextContents(),['Profile and appearance','Account security','Identity sign-in']);
  const bounds=await panel.boundingBox();assert.ok(bounds&&bounds.x>=-1&&bounds.x+bounds.width<=width+1,'Account disclosure remains inside viewport');await page.screenshot({path:resolve('private/swarm/runtime13-ui19/account-'+width+'-'+theme+'.png'),fullPage:false});
  await page.keyboard.press('Escape');assert.equal(await trigger.getAttribute('aria-expanded'),'false');assert.equal(await trigger.evaluate(node=>document.activeElement===node),true);
 }
 assert.equal(apiRequests,requestCount,'Opening or closing account controls dispatches no API work');
 await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>{document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light';});
 await button('Account menu').click();await page.getByRole('link',{name:'Profile and appearance',exact:true}).click();await at('preferences');await page.getByLabel('Display name',{exact:true}).waitFor();assert.equal(await button('Account menu').getAttribute('aria-expanded'),'false');
 await page.screenshot({path:resolve('private/swarm/runtime13-ui19/profile-light.png'),fullPage:false});
 pass('Actual header account disclosure, native profile link, app-version footer, narrow/wide light/dark geometry and Escape focus');
 await cleanAction(settings);await sidebar('Project context').click();await ready();await edit();await button('Save changes').click();await saved();assert.equal(writes.length,1);await cleanAction(settings);pass('Clean loads and confirmed saves allow exits without prompting');
 await fresh();await edit(null);await confirmAction(false,()=>sidebar('Settings').click());assert.equal(await brand().inputValue(),'Saved brand');await brand().fill('Retained draft');await confirmAction(false,()=>sidebar('Settings').click());assert.equal(await brand().inputValue(),'Retained draft');await confirmAction(true,settings);await sidebar('Project context').click();await ready();assert.equal(await brand().count(),0);assert.equal(writes.length,0);pass('Opened and edited forms survive cancelled sidebar exits; confirmed discard clears the local form');
 await settings();await sidebar('Project context').click();await ready();await edit('Back draft');await confirmAction(false,()=>page.goBack());await at('context');assert.equal(await brand().inputValue(),'Back draft');await confirmAction(true,()=>page.goBack());await at('preferences');await page.goForward();await ready();await settings();await page.goBack();await ready();await edit('Forward draft');await confirmAction(false,()=>page.goForward());assert.equal(await brand().inputValue(),'Forward draft');await confirmAction(true,()=>page.goForward());await at('preferences');pass('Actual browser Back and Forward each preserve drafts on Cancel and navigate after discard');
 await sidebar('Project context').click();await ready();await edit('Conflict draft');writeMode=409;await button('Save changes').click();await button('Reload saved data (discard draft)').waitFor();await confirmAction(false,()=>sidebar('Settings').click());assert.equal(await brand().inputValue(),'Conflict draft');await reloadCancelled();await dialogAction(false,()=>button('Reload saved data (discard draft)').click(),'Discard the unsaved form and reload saved data?','Reload saved data');assert.equal(await brand().inputValue(),'Conflict draft');await dialogAction(true,()=>button('Reload saved data (discard draft)').click(),'Discard the unsaved form and reload saved data?','Reload saved data');await ready();assert.equal(await brand().count(),0);assert.equal(writes.length,1);await cleanAction(settings);pass('Conflict drafts block sidebar/native reload and retain the existing explicit local reload confirmation');
 writes=[];writeMode=null;model=original();await sidebar('Project context').click();await ready();await edit('Exact retry draft');writeMode='lost';await button('Save changes').click();await button('Retry same save').waitFor();await confirmAction(false,()=>sidebar('Settings').click());await reloadCancelled();assert.equal(writes.length,1);assert.equal(await brand().inputValue(),'Exact retry draft');writeMode=null;await button('Retry same save').click();await saved();assert.equal(writes.length,2);assert.equal(writes[0],writes[1],'Retry retains exact serialized body, revision and request ID');await cleanAction(settings);pass('Uncertain save survives cancelled router/native exits and retries the identical body only on explicit Retry');
 writes=[];model=original();await sidebar('Project context').click();await ready();writeMode='lost';await dialogAction(true,()=>button('Delete Audience').click(),'Delete this custom section?','Delete');await button('Retry same save').waitFor();assert.equal(await brand().count(),0);await confirmAction(false,()=>sidebar('Settings').click());writeMode=null;await button('Retry same save').click();await saved();assert.equal(writes[0],writes[1]);assert.equal(model.customSections.length,0);pass('Uncertain deletion is protected without an editor and retains its exact retry');
 for(const deletion of [false,true]){
  await settings();writes=[];model=original();await sidebar('Project context').click();await ready();writeMode='hold';if(deletion)await dialogAction(true,()=>button('Delete Audience').click(),'Delete this custom section?','Delete');else{await edit('In-flight draft');await button('Save changes').click();}await waitHeld();await confirmAction(false,()=>sidebar('Settings').click());await reloadCancelled();assert.equal(writes.length,1);if(deletion){await confirmAction(true,settings);await release(503);}else{await release(503);await button('Retry same save').waitFor();await confirmAction(true,settings);}assert.equal(writes.length,1);await sidebar('Project context').click();await ready();assert.equal(await button('Retry same save').count(),0);
 }pass('In-flight editor saves and editor-free deletions block exits, then uncertain attempts leave only after explicit discard');
 await edit('Discarded local draft');await reloadCancelled();await dialogAction(false,()=>button('Refresh').click(),'Discard the unsaved form and reload saved data?','Reload saved data');assert.equal(await brand().inputValue(),'Discarded local draft');await dialogAction(false,()=>button('Cancel').click(),'Discard this unsaved form?','Discard form');assert.equal(await brand().inputValue(),'Discarded local draft');await dialogAction(true,()=>button('Cancel').click(),'Discard this unsaved form?','Discard form');assert.equal(await brand().count(),0);await cleanAction(settings);pass('Native reload keeps open drafts and existing Refresh/Cancel confirmations retain their behavior');
 writes=[];model=original();await sidebar('Project context').click();await ready();await edit('Reload discarded draft');await confirmAction(true,()=>page.reload(),'beforeunload');await ready();assert.equal(await brand().count(),0);assert.equal(writes.length,0);pass('Accepting native reload discards only the local draft and dispatches no save');
 await edit('Forbidden draft');writeMode='hold';await button('Save changes').click();await waitHeld();await cleanAction(async()=>{await release(403);await page.getByText('Synthetic save status 403',{exact:true}).waitFor();});assert.equal(await brand().count(),0);assert.equal(await button('Retry same save').count(),0);await cleanAction(settings);model=original();await sidebar('Project context').click();await ready();pass('Save-time 403 purges protected data and permits a clean exit without navigation traps');
 await edit('Auth loss draft');writeMode='hold';await button('Save changes').click();await waitHeld();await cleanAction(async()=>{await release(401);await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();});assert.equal(await brand().count(),0);assert.equal(await button('Retry same save').count(),0);await cleanAction(()=>page.reload());pass('Save-time auth loss purges the form and unload blocker without trapping the signed-out screen');
 for(const unknown of [false,true]){
  await fresh();await edit('Sign-out draft');
  if(!unknown){
   signOutMode='hold';await cleanAction(async()=>{await button('Account menu').click();await button('Sign out').click();});
   const deadline=Date.now()+5000;while(!heldSignOut){assert.ok(Date.now()<deadline,'Held sign-out was not reached');await new Promise(done=>setTimeout(done,10));}
   await button('Account menu').click();const busy=button('Signing out…');await busy.waitFor();assert.equal(await busy.isDisabled(),true);assert.equal(await busy.getAttribute('aria-busy'),'true');await busy.evaluate(node=>node.click());await frame();assert.equal(signOutCalls,1,'Busy native control cannot dispatch duplicate sign-out');assert.equal(signedOut,false);assert.equal(await brand().inputValue(),'Sign-out draft');
   await json(heldSignOut,{error:'Synthetic sign-out unavailable'},503);heldSignOut=null;await page.getByText('Could not sign out: Synthetic sign-out unavailable',{exact:true}).waitFor();assert.equal(signedOut,false);assert.equal(await brand().inputValue(),'Sign-out draft');assert.equal(await button('Sign out').isEnabled(),true);assert.equal(signOutCalls,1);
   await page.keyboard.press('Escape');signOutMode='ok';
  }
  if(unknown){writeMode='lost';await button('Save changes').click();await button('Retry same save').waitFor();}await cleanAction(async()=>{await button('Account menu').click();await button('Sign out').click();await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();});assert.equal(await brand().count(),0);assert.equal(await button('Retry same save').count(),0);assert.equal(signedOut,true);assert.equal(signOutCalls,unknown?1:2);await cleanAction(()=>page.reload());
 }pass('Busy sign-out refuses duplicates; failure preserves session/draft; reopened dropdown retry and acknowledged sign-out clear drafts and uncertain attempts without prompts');
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS '+groups.length+' context-exit groups / '+apiRequests+' API requests / '+contexts+' contexts; synthetic client behavior only; zero external requests or page errors');
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:resolve('private/swarm/runtime13-ui19/context-failure.png'),fullPage:false,timeout:1500}).catch(()=>{});console.error('FAILURE_AX '+await page.locator('body').ariaSnapshot({timeout:1500}).catch(()=>'<unavailable>'));}throw error;}finally{clearTimeout(deadline);if(heldSignOut){await heldSignOut.abort().catch(()=>{});heldSignOut=null;}if(held){await held.route.abort().catch(()=>{});held=null;}await context?.close();await browser?.close();await server.close();assert.equal(browser?.isConnected()??false,false);assert.equal(server.httpServer?.listening??false,false);console.log('CLEANUP owned Edge and loopback Vite stopped');clearTimeout(watchdog);}
