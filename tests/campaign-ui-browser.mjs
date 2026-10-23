// Actual App/controller with explicitly synthetic responses. No database, real account,
// provider, saved-preference, permission-enforcement or authentication acceptance claim.
// Node24: TEN98_CAMPAIGN_UI_BROWSER=1 PLAYWRIGHT_MODULE=<installed entry> node tests/campaign-ui-browser.mjs
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {launchChromium} from './helpers/playwright.mjs';
assert.equal(process.env.TEN98_CAMPAIGN_UI_BROWSER,'1');
assert.ok(process.env.PLAYWRIGHT_MODULE);
const root=process.cwd(),out=resolve('private/campaign-ui-evidence'),unexpected=[],errors=[],requests=[],passed=[];
const user={id:'ui-user',name:'UI example',email:'ui@example.com'},workspace='10000000-0000-4000-8000-000000000001',project='20000000-0000-4000-8000-000000000002',provider='30000000-0000-4000-8000-000000000003',invite='a'.repeat(43);
const widths=[1600,1440,1200,960,760,360,320],note='Explicit synthetic report unavailable; no measured result supplied.';
await mkdir(out,{recursive:true});
const server=await createServer({configFile:false,envDir:false,root,cacheDir:out+'/vite-cache',appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router','zod']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}});
server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ten98 Discover synthetic UI check</title><div id="root"></div><script type="module" src="/tests/account-preferences-browser-fixture.tsx"></script></html>');});
let browser,context,page,origin,factor;
const factorGate='This workspace requires two-factor authentication. Turn it on in Account security, then try again.';
const pass=name=>{passed.push(name);console.log('PASS '+name);};
const ratio=(a,b)=>{const luminance=s=>s.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0),x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
const style=async locator=>locator.evaluate(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return{width:r.width,height:r.height,minHeight:s.minHeight,x:r.x,y:r.y,bottom:r.bottom,color:s.color,background:s.backgroundColor,border:s.borderTopWidth,borderColor:s.borderTopColor,radius:s.borderTopLeftRadius,weight:s.fontWeight,font:s.fontSize,position:s.position,maxWidth:s.maxWidth,outline:s.outlineWidth,paddingBottom:s.paddingBottom,display:s.display};});
async function fresh({mode='signin',view='project',theme='light',operator=false,hasPassword=true,withProject=false,providers=true,fragment='',locked=false,eventsDown=false,providerSignOut=null,otherSession=false,scheme='light'}={}){
 factor={enrolled:false,signedOut:false,other:otherSession};
 await context?.close();context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce',colorScheme:scheme});
 await context.route('**/*',async route=>{
  try{
   const req=route.request(),url=new URL(req.url()),path=url.pathname,method=req.method();
   if(url.origin!==origin){unexpected.push(method+' '+url.href);return route.abort();}
   if(!path.startsWith('/api/')){if(method==='GET')return route.continue();unexpected.push(method+' '+path);return route.abort();}
   requests.push({method,path});let body,status=200;
   const get=()=>assert.equal(method,'GET',path+' is read-only in this probe');
   if(path==='/api/session'){get();body={setupRequired:mode==='setup',appUrl:origin,user:null};}
   else if(path==='/api/me'){get();if(mode!=='app'||factor.signedOut){status=401;body={error:'Synthetic sign-in required'};}else body={user,instanceOperator:operator,workspaces:withProject?[{id:workspace,name:'Synthetic workspace',role:'owner',...locked?{twoFactorLocked:!factor.enrolled}:{}}]:[]};}
   else if(path==='/api/account/preferences'){get();body={version:'account-preferences-v1',user,preferences:{revision:1,timeZone:'UTC',locale:'en-US',theme,updatedAt:'2026-10-18T00:00:00.000Z'}};}
   else if(path==='/api/auth/oidc/providers'){get();body={providers:providers?[{id:provider,name:'Example organization'}]:[]};}
   else if(path==='/api/auth/password-reset-status'){get();body={configured:true};}
   else if(path==='/api/auth/sign-in/email'){assert.equal(method,'POST');assert.deepEqual(req.postDataJSON(),{email:user.email,password:'Synthetic-password-only'});body={twoFactorRedirect:true};}
   else if(path==='/api/account/security'){get();body={user:{...user,twoFactorEnabled:factor.enrolled},hasPassword,sessions:[{id:'synthetic-session',createdAt:'2026-10-18T00:00:00.000Z',expiresAt:'2026-10-25T00:00:00.000Z',userAgent:'Synthetic browser session',current:true},...factor.other?[{id:'synthetic-other',createdAt:'2026-10-17T00:00:00.000Z',expiresAt:'2026-10-24T00:00:00.000Z',userAgent:'Synthetic other browser',current:false}]:[]]};}
   else if(path==='/api/auth/sign-out'){assert.equal(method,'POST');assert.ok(providerSignOut);factor.signedOut=true;body={providerSignOutUrl:providerSignOut};}
   else if(path==='/api/account/password'){assert.equal(method,'POST');assert.deepEqual(req.postDataJSON(),{currentPassword:'Synthetic-password-only',newPassword:'Synthetic-new-password'});body={};}
   else if(path==='/api/account/sessions/revoke'){assert.equal(method,'POST');assert.deepEqual(req.postDataJSON(),{sessionId:'synthetic-other'});factor.other=false;body={};}
   else if(path==='/api/account/closure'){get();body={blockers:{workspaces:[],lastOperator:false},hasPassword,twoFactorEnabled:factor.enrolled};}
   else if(path==='/api/account/two-factor/enable'){assert.equal(method,'POST');assert.equal(locked,true);assert.deepEqual(req.postDataJSON(),{password:'Synthetic-password-only'});body={totpURI:'otpauth://totp/ten98:ui%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=ten98',backupCodes:Array.from({length:10},(_,i)=>'synthetic-code-'+i)};}
   else if(path==='/api/account/two-factor/verify'){assert.equal(method,'POST');assert.equal(locked,true);assert.deepEqual(req.postDataJSON(),{code:'123456'});factor.enrolled=true;body={};}
   else if(path==='/api/account/oidc/identities'){get();body={identities:[{id:'synthetic-identity',issuer:'https://identity.example.com',subject:'synthetic-subject',createdAt:'2026-10-18T00:00:00.000Z',providerId:provider,providerName:'Example organization',enabled:true}]};}
   else if(path==='/api/identity/oidc/providers'){get();assert.equal(operator,true,'Operator endpoint must not be requested for an ordinary account');body={callbackUrl:origin+'/api/auth/oidc/callback',vaultConfigured:true,providers:[{id:provider,revision:1,enabled:true,activeRevision:1,testedRevision:1,testedAt:'2026-10-18T00:00:00.000Z',settings:{name:'Example organization',issuer:'https://identity.example.com',clientId:'synthetic-client',authentication:'basic',allowedOrigins:[],allowedAddresses:[],trustVerifiedEmail:false}}]};}
   else if(path==='/api/invitations/inspect'){assert.equal(method,'POST');assert.deepEqual(req.postDataJSON(),{token:invite});assert.equal(url.href.includes(invite),false,'Invitation capability stays out of request URLs');body={workspaceName:'Synthetic team',email:user.email,role:'editor',expiresAt:'2099-10-25T00:00:00.000Z'};}
   else if(path==='/api/workspaces/'+workspace+'/projects'&&locked&&!factor.enrolled){get();status=403;body={error:factorGate};}
   else if(path==='/api/projects/'+project+'/events'&&eventsDown){get();status=503;body={error:'Explicit synthetic event history outage.'};}
   else if(path==='/api/workspaces/'+workspace+'/projects'){get();body={projects:[{id:project,name:'Synthetic website',origin:'https://site.example.com',publicKey:'synthetic-tracker-key',eventCount:0,lastEventAt:null,retainedFrom:null}]};}
   else if(path==='/api/projects/'+project+'/events'){get();body={events:[],total:0,retainedFrom:null};}
   else if(path==='/api/projects/'+project+'/jobs'){get();body={jobs:[]};}
   else if([`/api/projects/${project}/analytics`,`/api/projects/${project}/ai-search`,`/api/projects/${project}/ai-search/analysis`,`/api/projects/${project}/annotations`,`/api/projects/${project}/annotations/timeline`].includes(path)){get();status=503;body={error:note};}
   else {unexpected.push(method+' '+path);return route.abort();}
   return route.fulfill({status,contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify(body)});
  }catch(error){errors.push('Fixture boundary: '+error.message);return route.abort();}
 });
 page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 const query=mode==='app'?new URLSearchParams({...withProject?{workspace,project}:{},view}).toString():'';
 await page.goto(origin+'/?'+query+fragment);return page;
}
async function viewport(width,dir='ltr'){await page.setViewportSize({width,height:1000});await page.evaluate(dir=>document.documentElement.dir=dir,dir);}
async function containment(label){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+' viewport containment');}
async function targets(locator,label){for(const target of await locator.evaluateAll(es=>es.map(e=>({height:e.getBoundingClientRect().height,name:e.id||e.textContent?.trim()||e.tagName})).filter(e=>e.height)))assert.ok(target.height>=44,label+' 44px target '+target.name+' (actual '+target.height+'px)');}
async function authGeometry(label){
 assert.equal(await page.locator('.auth-story a').count(),0,'Auth brand cannot reload away an in-memory capability');
 assert.equal(await page.locator('h1').count(),1,'The form supplies the only screen heading');
 assert.equal(await page.locator('main').count(),1,'Each authentication screen has exactly one main landmark');
 for(const dir of ['ltr','rtl'])for(const width of widths){
  await viewport(width,dir);await containment(label+' '+width+'/'+dir);assert.equal(await page.locator('.auth-story-title').isVisible(),true,label+' story remains visible at '+width);
  const story=await style(page.locator('.auth-story')),form=await style(page.locator('.auth-form'));
  if(width>760){
   assert.ok(Math.abs(story.y-form.y)<1,label+' '+width+'/'+dir+' aligned split layout');
   assert.ok(Math.abs(story.x+story.width-form.x)<1||Math.abs(form.x+form.width-story.x)<1,label+' '+width+'/'+dir+' adjacent columns');
   assert.ok(Math.abs(story.width-width*(width<=960?.45:.5))<1,label+' '+width+'/'+dir+' Campaign story proportion');
  }
  else{assert.ok(form.y>=story.bottom-1,label+' stacked layout');assert.equal(await page.locator('.auth-channels').isVisible(),false,label+' mobile story hides channels');assert.equal((await page.locator('.auth-story-title').innerText()).replace(/\s+/g,' ').trim(),'Website analytics and search research.',label+' mobile headline keeps word spaces');}
  await targets(page.locator('.auth-form input:not([type=checkbox]):not([type=radio]),.auth-form button'),label);
 }
 await viewport(1440);
}
async function brandAndAuthChrome(){
 // Exact visible values from the inspected ten98-campaign src/styles.css and SVG contract;
 // 44px hit targets are the existing Discover accessibility exception to 43px auth controls.
 assert.equal((await style(page.locator('.auth-story'))).background,'rgb(238, 233, 250)');
 const mark=await style(page.locator('.auth-story .brand-mark'));assert.equal(mark.width,37);assert.equal(mark.height,37);assert.equal(mark.radius,'11px');
 assert.equal(await page.locator('.auth-story .brand strong').textContent(),'ten98.');assert.equal(await page.locator('.auth-story .brand small').textContent(),'DISCOVER');
 assert.equal((await style(page.locator('.auth-story .brand strong'))).font,'25px');
 assert.equal((await style(page.locator('.auth-story .brand'))).paddingBottom,'0px');
 const orbit=await style(page.locator('.auth-orbit'));assert.equal(orbit.width,550);assert.equal(orbit.height,550);assert.equal(orbit.border,'90px');assert.equal(orbit.borderColor,'rgb(228, 218, 243)');
 assert.equal((await style(page.locator('.auth-form-inner'))).maxWidth,'360px');
 assert.equal(await page.locator('.auth-channels > span').count(),3);
 for(const span of await page.locator('.auth-channels > span').all()){assert.equal((await style(span)).border,'0px');const svg=span.locator('svg');assert.equal(await svg.getAttribute('viewBox'),'0 0 24 24');assert.equal(await svg.getAttribute('stroke-width'),'1.7');assert.equal(await svg.getAttribute('stroke-linecap'),'round');assert.equal((await style(svg)).width,17);}
 assert.equal(await page.locator('.auth-channels > span').first().locator('svg path').getAttribute('d'),'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z');
 // Retain upstream story-copy/footer/product-tint contrast checks with the Campaign markup.
 for(const selector of ['.auth-story p:not(.auth-story-title)','.auth-story > small','.auth-story .brand small','.auth-story .brand strong']){const pair=await page.locator(selector).evaluate(e=>({text:getComputedStyle(e).color,surface:getComputedStyle(e.closest('.auth-story')).backgroundColor}));assert.ok(ratio(pair.text,pair.surface)>=4.5,selector+' readable story contrast');}
 const button=await style(page.getByRole('button',{name:'Sign in',exact:true}));assert.equal(button.radius,'8px');assert.equal(button.font,'13px');assert.equal(button.weight,'600');assert.ok(ratio(button.color,button.background)>=4.5,'Primary button contrast');
}
async function authThemePairs(){
 const pairs=[],selectors=[
  ['title','.auth-story-title',3,true],['emphasis','.auth-story-title em',3,true],
  ['product label','.auth-story .brand small',4.5,true],['eyebrow','.auth-story .eyebrow',4.5,false],
  ['form heading','.auth-form h1',4.5,true],['form label','.auth-form label',4.5,true],
  ['brand','.auth-story .brand strong',4.5,true],['body','.auth-story p:not(.auth-story-title)',4.5,false],
  ['footer','.auth-story > small',4.5,false],['channels','.auth-channels',4.5,false]
 ];
 try{
  for(const theme of ['light','dark'])for(const width of [1440,360]){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await viewport(width);await containment(theme+' auth '+width);
   assert.equal((await page.locator('.auth-story-title').innerText()).replace(/\s+/g,' ').trim(),'Website analytics and search research.',theme+' '+width+' complete headline');
   for(const [label,selector,minimum,requiredMobile] of selectors){
    const visible=await page.locator(selector).evaluateAll(elements=>elements.filter(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return r.width>0&&r.height>0&&s.visibility==='visible';}).map(e=>{
     let surface='rgba(0, 0, 0, 0)';for(let node=e;node;node=node.parentElement){const color=getComputedStyle(node).backgroundColor,channels=color.match(/[\d.]+/g)?.map(Number);if(channels&&(channels.length===3||channels[3]===1)){surface=color;break;}}
     return{text:getComputedStyle(e).color,surface,content:e.textContent?.replace(/\s+/g,' ').trim()};
    }));
    if(width===1440||requiredMobile)assert.ok(visible.length>0,theme+' '+width+' visible '+label);
    for(const pair of visible){const contrast=ratio(pair.text,pair.surface);pairs.push({theme,width,label,selector,...pair,contrast,minimum});assert.ok(contrast>=minimum,theme+' '+width+' '+label+' contrast '+contrast.toFixed(2)+' >= '+minimum);}
   }
   await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:out+'/signin-'+theme+'-'+width+'.png',fullPage:true});
  }
 }finally{
  try{await writeFile(out+'/signin-theme-pairs.json',JSON.stringify(pairs,null,2));}
  finally{await page.evaluate(()=>document.documentElement.dataset.theme='light');await viewport(1440);}
 }
}
async function headerContentContained(){
 return page.locator('.t98-shell-header').evaluate(header=>{
  const bounds=header.getBoundingClientRect(),visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility==='visible',inside=e=>{const r=e.getBoundingClientRect();return r.left>=bounds.left-1&&r.right<=bounds.right+1&&r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1;};
  const required=['.t98-app-topbar__breadcrumb','.t98-app-topbar__current','.t98-app-topbar__actions','.avatar'].map(selector=>header.querySelector(selector));
  if(innerWidth<=760)required.push(header.querySelector('.t98-app-topbar__menu'));
  if(required.some(e=>!e))return false;
  return required.every(e=>visible(e)&&inside(e))&&[...header.querySelectorAll('.t98-app-topbar__crumbs > *,.t98-app-topbar__actions > *')].filter(visible).every(inside);
 });
}
async function shellGeometry(label){
 for(const dir of ['ltr','rtl'])for(const width of widths){
  await viewport(width,dir);await containment(label+' '+width+'/'+dir);
  const sidebar=page.locator('.t98-shell-sidebar'),side=await style(sidebar),bar=await style(page.locator('.t98-shell-header'));
  const minimum=width<=760?56:69;
  assert.equal(side.position,width<=760?'fixed':'sticky',label+' shared sidebar');assert.equal(bar.position,'static',label+' shared header');assert.equal(bar.minHeight,minimum+'px',label+' Campaign header minimum');assert.ok(bar.height>=minimum,label+' header grows to fit content');assert.equal(await headerContentContained(),true,label+' visible header context fits '+width+'/'+dir);
  if(width===320&&dir==='ltr'){
   const header=page.locator('.t98-shell-header'),original=await header.evaluate(e=>({value:e.style.getPropertyValue('height'),priority:e.style.getPropertyPriority('height')}));
   assert.ok(bar.height>56,label+' narrow specimen wraps above its minimum');
   try{await header.evaluate(e=>e.style.height='56px');assert.equal(await headerContentContained(),false,label+' fixed-height fault overflows visible header context');}
   finally{await header.evaluate((e,original)=>{if(original.value)e.style.setProperty('height',original.value,original.priority);else e.style.removeProperty('height');},original);}
   assert.equal(await headerContentContained(),true,label+' header context recovers after restoring inline height');
  }
  if(width>760)assert.equal(side.width,width>=1500?245:width<=1200?210:232,label+' Campaign sidebar width');
  else{
   const menu=page.getByRole('button',{name:'Menu',exact:true});await menu.click();await page.locator('.t98-shell-sidebar[data-sidebar-state="open"]').waitFor();assert.equal((await style(sidebar)).width,Math.min(320,width-32));assert.equal(await page.locator('.t98-shell-workspace').evaluate(e=>e.inert),true,'Background becomes inert');
   const focusables=page.locator('.t98-shell-sidebar a[href]:visible,.t98-shell-sidebar button:not(:disabled):visible,.t98-shell-sidebar select:not(:disabled):visible');const first=focusables.first(),last=focusables.last();await last.focus();await page.keyboard.press('Tab');assert.equal(await first.evaluate(e=>document.activeElement===e),true,'Drawer Tab wraps to first');await page.keyboard.press('Shift+Tab');assert.equal(await last.evaluate(e=>document.activeElement===e),true,'Drawer Shift+Tab wraps to last');
   await page.keyboard.press('Escape');await page.locator('.t98-shell-sidebar[data-sidebar-state="open"]').waitFor({state:'hidden'});assert.equal(await menu.evaluate(e=>document.activeElement===e),true,'Escape restores menu focus');assert.equal(await page.locator('.t98-shell-shade').count(),0);await menu.click();await page.locator('.t98-shell-sidebar[data-sidebar-state="open"]').waitFor();await page.locator('.t98-shell-shade').click({position:{x:dir==='rtl'?1:width-1,y:10}});await page.locator('.t98-shell-sidebar[data-sidebar-state="open"]').waitFor({state:'hidden'});assert.equal(await menu.evaluate(e=>document.activeElement===e),true,'Backdrop close restores menu focus');
  }
 }
 await viewport(1440);
}
async function settingsGeometry(label){for(const dir of ['ltr','rtl'])for(const width of widths){await viewport(width,dir);await containment(label+' '+width+'/'+dir);}await viewport(320,'rtl');await page.evaluate(()=>document.documentElement.style.fontSize='200%');await containment(label+'200%');await page.evaluate(()=>document.documentElement.style.fontSize='');await viewport(1440);}
try{
 await server.listen();origin='http://127.0.0.1:'+server.httpServer.address().port;
 await server.environments.client.transformRequest('/tests/account-preferences-browser-fixture.tsx');await server.environments.client.waitForRequestsIdle();
 const optimizer=server.environments.client.depsOptimizer;await optimizer.scanProcessing;await Promise.all(Object.values(optimizer.metadata.discovered).map(d=>d.processing));
 browser=await launchChromium();
 await fresh({mode:'setup'});await page.getByRole('heading',{name:'Create owner account',exact:true}).waitFor();assert.equal(await page.getByLabel('Setup token',{exact:true}).getAttribute('type'),'password');assert.equal(await page.getByLabel('Password',{exact:true}).getAttribute('minlength'),'12');assert.equal(await page.getByLabel('Workspace name',{exact:true}).inputValue(),'My workspace','The optional workspace name starts as My workspace.');await authGeometry('Owner setup');pass('Actual owner setup fields, split/stacked Campaign layout and seven LTR/RTL widths.');
 await fresh();await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();await page.getByRole('button',{name:'Continue with Example organization',exact:true}).waitFor();assert.equal(await page.locator('.or-divider').count(),1);await brandAndAuthChrome();await authThemePairs();await authGeometry('Sign in');await page.getByLabel('Email address', { exact: true }).focus();assert.equal((await style(page.getByLabel('Email address', { exact: true }))).outline,'3px');await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:out+'/signin-desktop.png'});await viewport(360);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:out+'/signin-mobile.png'});
 await page.getByLabel('Email address', { exact: true }).fill(user.email);await page.getByLabel('Password',{exact:true}).fill('Synthetic-password-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Verify your sign-in',exact:true}).waitFor();await authGeometry('Second factor');await page.getByRole('button',{name:'Use a recovery code',exact:true}).click();assert.equal(await page.getByLabel('Recovery code',{exact:true}).getAttribute('inputmode'),'text');await page.getByRole('button',{name:'Back to sign in',exact:true}).click();await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();await page.getByRole('button',{name:'Forgot password?',exact:true}).click();await page.getByRole('heading',{name:'Reset your password',exact:true}).waitFor();await page.getByLabel('Email address',{exact:true}).waitFor();await authGeometry('Password recovery');pass('Exact Campaign brand/SVG/orbit/form and native sign-in/factor/recovery UI transitions; no real authentication claimed.');
 await fresh({providers:false});await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();await page.getByText('Loading sign-in options…',{exact:true}).waitFor({state:'hidden'});assert.equal(await page.locator('.t98-auth-provider,.or-divider').count(),0);pass('Conditional OIDC controls and divider absent when the synthetic provider inventory is empty.');
 await fresh({fragment:'#invite='+invite});await page.getByRole('heading',{name:'You’re invited to join Synthetic team',exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'','Native invitation fragment scrubbed');assert.equal(await page.getByLabel('Password',{exact:true}).getAttribute('minlength'),'12');await page.getByRole('button',{name:'Create account and join',exact:true}).waitFor();await authGeometry('Invitation signup');assert.ok(requests.some(r=>r.path==='/api/invitations/inspect'&&r.method==='POST'));pass('Actual invitation account-creation fields render; capability scrubbed and inspected only in POST body; no account creation submitted.');
 for(const theme of ['light','dark','system']){await fresh({mode:'app',theme,withProject:true});await page.locator('.t98-app-shell').waitFor();await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);assert.equal((await style(page.locator('.t98-shell-sidebar'))).background,theme==='dark'?'rgb(23, 32, 44)':'rgb(255, 255, 255)');await shellGeometry(theme+' workspace shell');
 for(const selector of ['.t98-switcher__role','.t98-switcher__avatar']){const pair=await page.locator(selector).evaluate(e=>{const text=getComputedStyle(e).color;let surface='rgba(0, 0, 0, 0)';for(let node=e;node&&surface==='rgba(0, 0, 0, 0)';node=node.parentElement)surface=getComputedStyle(node).backgroundColor;return{text,surface};});assert.ok(ratio(pair.text,pair.surface)>=4.5,theme+' '+selector+' shell contrast');}
if(theme==='system'){const before=(await style(page.locator('.t98-shell-sidebar'))).background;await page.emulateMedia({colorScheme:'dark'});assert.notEqual((await style(page.locator('.t98-shell-sidebar'))).background,before);await page.emulateMedia({colorScheme:'light'});}if(theme==='light'){await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:out+'/workspace-desktop.png'});}}pass('Actual workspace shell, Campaign fixed/sidebar/header sizes, mobile overlay/Escape focus, light/dark/System and seven LTR/RTL widths.');
 await fresh({mode:'app',view:'preferences',withProject:true});const preferences=page.getByRole('region',{name:'Profile and appearance',exact:true});await preferences.getByLabel('Display name',{exact:true}).waitFor();await page.waitForFunction(name=>document.querySelector('input[autocomplete="name"]')?.value===name,user.name);assert.equal(await preferences.getByLabel('Display name',{exact:true}).inputValue(),user.name);await preferences.getByRole('heading',{name:'Your account',exact:true}).waitFor();await preferences.getByRole('heading',{name:'Regional format',exact:true}).waitFor();await preferences.getByRole('heading',{name:'Appearance',exact:true}).waitFor();assert.equal(await preferences.getByRole('button',{name:'Save preferences',exact:true}).isDisabled(),true);const disabled=await style(preferences.getByRole('button',{name:'Save preferences',exact:true}));assert.equal(disabled.background,'rgb(245, 244, 250)');const savePreferences=preferences.getByRole('button',{name:'Save preferences',exact:true}),disabledRole=await page.evaluate(()=>{const probe=document.createElement('span');probe.style.color=getComputedStyle(document.documentElement).getPropertyValue('--t98-disabled-text').trim();return probe.style.color;}),checkDisabledText=async()=>assert.equal((await style(savePreferences)).color,disabledRole,'Save preferences canonical disabled-text role');assert.equal(disabledRole,'rgb(105, 99, 116)','Published disabled-text token');
 await checkDisabledText();
 const originalColor=await savePreferences.evaluate(e=>({value:e.style.getPropertyValue('color'),priority:e.style.getPropertyPriority('color')}));
 try{await savePreferences.evaluate(e=>e.style.setProperty('color','rgb(104, 117, 138)','important'));await assert.rejects(checkDisabledText,{name:'AssertionError'});}
 finally{await savePreferences.evaluate((e,original)=>{if(original.value)e.style.setProperty('color',original.value,original.priority);else e.style.removeProperty('color');},originalColor);}
 await checkDisabledText();
 assert.equal((await style(preferences.locator('.settings-panel').first())).radius,'9px');assert.equal((await style(preferences.locator('.account-settings-grid'))).display,'grid');await preferences.getByRole('radio',{name:'Dark',exact:true}).check();assert.equal(await page.locator('html').getAttribute('data-theme'),'light','Appearance remains a draft until Save');await settingsGeometry('Profile/preferences');await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:out+'/profile-desktop.png'});pass('Actual profile/regional/appearance forms, Campaign panels, disabled colors, staged theme and seven-width RTL/200% containment.');
 await fresh({mode:'app',view:'security'});await page.getByRole('heading',{name:'Sessions',exact:true}).waitFor();await page.getByRole('heading',{name:'Password',exact:true}).waitFor();await page.getByRole('heading',{name:'Two-factor authentication',exact:true}).waitFor();await page.getByRole('rowheader',{name:'Synthetic browser session This session',exact:true}).waitFor();assert.equal(await page.getByLabel('New password',{exact:true}).getAttribute('minlength'),'12');await settingsGeometry('Security');await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:out+'/security-desktop.png'});pass('Actual security/password/2FA/session rendering with explicit synthetic session metadata; no security mutation submitted.');
 const beforeIdentity=requests.length;await fresh({mode:'app',view:'identity'});await page.getByRole('heading',{name:'Your sign-in methods',exact:true}).waitFor();await page.getByText('synthetic-subject',{exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Identity providers (operator)',exact:true}).count(),0);assert.equal(requests.slice(beforeIdentity).some(r=>r.path==='/api/identity/oidc/providers'),false);await settingsGeometry('Linked identity');pass('Actual linked-identity card rendering and ordinary-account operator-control absence; server authorization is not inferred.');
 await fresh({mode:'app',view:'identity',operator:true});await page.getByRole('heading',{name:'Identity providers (operator)',exact:true}).waitFor();await page.getByRole('button',{name:'Edit draft',exact:true}).click();assert.equal(await page.getByLabel('Issuer URL',{exact:true}).inputValue(),'https://identity.example.com');assert.equal(await page.getByLabel('Client ID',{exact:true}).inputValue(),'synthetic-client');assert.equal(await page.getByLabel('Client secret',{exact:true}).inputValue(),'');assert.equal(await page.getByLabel('Client secret',{exact:true}).getAttribute('type'),'password');await page.getByRole('button',{name:'Save draft',exact:true}).waitFor();await settingsGeometry('Operator identity');await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:out+'/identity-desktop.png'});pass('Actual OIDC operator card and native draft editor render synthetic public metadata; no secret retrieval/provider test/save/enable call.');
 await fresh({mode:'app',view:'identity',hasPassword:false});await page.getByRole('heading',{name:'Identity account security',exact:true}).waitFor();await page.getByRole('button',{name:'Verify with Example organization',exact:true}).waitFor();await settingsGeometry('OIDC account recovery');pass('Actual passwordless identity-account recovery controls render without beginning provider verification.');
 await fresh({mode:'app',withProject:true,view:'project'});await page.locator('.analytics-toolbar').waitFor();await page.getByText(note,{exact:false}).first().waitFor();assert.equal(await page.locator('.analytics-stats').count(),0,'Unavailable analytics must not invent metric cards');await settingsGeometry('Unavailable analytics');
 await fresh({mode:'app',withProject:true,view:'attribution'});await page.getByRole('region',{name:'Attribution',exact:true}).getByLabel('Conversion value',{exact:true}).waitFor();assert.equal(await page.getByLabel('Conversion value',{exact:true}).inputValue(),'');assert.equal(await page.locator('.attribution-metrics').count(),0);await settingsGeometry('Unapplied attribution');
 await fresh({mode:'app',withProject:true,view:'ai-search'});await page.getByRole('group',{name:'AI search sections',exact:true}).waitFor();await page.getByText(note,{exact:false}).first().waitFor();assert.equal(await page.locator('.ai-search-cards').count(),0);await settingsGeometry('Unavailable AI search');pass('Representative actual Analytics/Attribution/AI-search chrome renders honest unavailable/unapplied states; no synthetic metrics presented as measured data.');
 await fresh({mode:'app',withProject:true,view:'security',locked:true});const lock=page.getByText('Two-factor authentication required',{exact:true}),retry=page.getByRole('button',{name:'Retry projects',exact:true});await lock.waitFor();await retry.waitFor();assert.equal(await page.getByRole('alert').filter({hasText:factorGate}).count(),1,'A locked workspace still shows the projects failure and its retry');
 const meReads=requests.filter(r=>r.path==='/api/me').length;await page.locator('#tfa-enable-pw').fill('Synthetic-password-only');await page.getByRole('button',{name:'Start 2FA setup',exact:true}).click();await page.locator('#tfa-code').fill('123456');await page.getByRole('button',{name:'Verify and turn on 2FA',exact:true}).click();
 await lock.waitFor({state:'detached'});await retry.waitFor({state:'detached'});assert.ok(requests.filter(r=>r.path==='/api/me').length>meReads,'Enrolment re-reads memberships');await page.locator('.t98-sidebar-status').getByText('No retained events yet',{exact:true}).waitFor();pass('The workspace two-factor banner clears after enrolment and the projects reload; while locked the projects failure keeps its retry.');
 await fresh({mode:'app',withProject:true,view:'events',eventsDown:true});await page.locator('.t98-sidebar-status').getByText('Event history unavailable',{exact:true}).waitFor();assert.equal(await page.locator('.t98-sidebar-status').getByText('No retained events yet',{exact:true}).count(),0,'Unavailable event history is not reported as zero');pass('Sidebar status keeps unavailable event history distinct from no events.');
 for(const width of [1440,320]){await fresh({scheme:'dark'});await viewport(width);await page.getByRole('heading',{name:'Sign in',exact:true,level:1}).waitFor();assert.equal(await page.locator('html').getAttribute('data-theme'),'system','Before sign-in the browser preference applies');
  const dark=await page.evaluate(()=>{const rgba=v=>v.match(/[\d.]+/g)?.map(Number)??[],blend=(f,b)=>[0,1,2].map(i=>f[i]*(f[3]??1)+b[i]*(1-(f[3]??1))),lum=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
   const bgOf=el=>{let bg=[255,255,255];const chain=[];for(let n=el;n;n=n.parentElement)chain.push(n);for(const n of chain.reverse())bg=blend(rgba(getComputedStyle(n).backgroundColor),bg);return bg;};
   const texts=[...document.querySelectorAll('h1,h2,p,label,button,a,legend,small,span')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()));
   return {page:lum(bgOf(document.querySelector('main')??document.body)),low:texts.map(el=>{const b=bgOf(el),f=blend(rgba(getComputedStyle(el).color),b),x=lum(f),y=lum(b);return{text:el.textContent.trim().slice(0,40),ratio:(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};}).filter(t=>t.ratio<4.5),count:texts.length};});
  assert.ok(dark.page<0.1,'The sign-in screen renders dark under a dark system preference');assert.ok(dark.count>5);assert.deepEqual(dark.low,[],'Dark sign-in text keeps 4.5:1 contrast at '+width);}
 pass('Before sign-in the screens follow the browser light or dark preference; dark sign-in keeps 4.5:1 text contrast at 1440 and 320.');
 await fresh({mode:'app',view:'security',otherSession:true});const password=page.getByRole('region',{name:'Password',exact:true}),sessions=page.getByRole('region',{name:'Sessions',exact:true});await password.getByLabel('Current password',{exact:true}).waitFor();
 const fillPassword=async repeat=>{await password.getByLabel('Current password',{exact:true}).fill('Synthetic-password-only');await password.getByLabel('New password',{exact:true}).fill('Synthetic-new-password');await password.getByLabel('Repeat new password',{exact:true}).fill(repeat);await password.getByRole('button',{name:'Change password',exact:true}).click();};
 await fillPassword('Synthetic-other-password');await password.getByText('The new passwords do not match. Re-enter them.',{exact:true}).waitFor();assert.equal(requests.filter(r=>r.path==='/api/account/password').length,0,'A mismatch never sends the password');
 await fillPassword('Synthetic-new-password');await password.getByText('Password changed. Your other sessions were signed out.',{exact:true}).waitFor();assert.equal(requests.filter(r=>r.path==='/api/account/password').length,1);assert.equal(await password.getByLabel('Current password',{exact:true}).inputValue(),'','Submitted passwords are cleared from the form');
 assert.equal(await sessions.getByRole('button',{name:'Revoke: Synthetic browser session',exact:true}).count(),0,'The current session offers no revoke');await sessions.getByRole('button',{name:'Revoke: Synthetic other browser',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Revoke',exact:true}).click();await sessions.getByText('Synthetic other browser',{exact:true}).waitFor({state:'detached'});await sessions.getByText('Synthetic browser session',{exact:true}).waitFor();
 assert.ok((await style(page.getByRole('button',{name:'Refresh sessions',exact:true}))).height>=44,'Refresh sessions is a 44px control');
 pass('Password change validates the repeat locally, sends only the two passwords and clears them; another session is revoked through a confirmation while the current one cannot be.');
 for(const [url,leaves] of [['https://idp.example.com/end-session#state',false],['https://idp.example.com/end-session?client_id=synthetic',true]]){
  await fresh({mode:'app',view:'security',providerSignOut:url});await page.getByRole('heading',{name:'Account security',exact:true,level:1}).waitFor();
  const leaving=leaves?page.waitForRequest(r=>r.url()===url):null;await page.getByRole('button',{name:'Account menu',exact:true}).click();await page.locator('.t98-account-menu').getByRole('button',{name:'Sign out',exact:true}).click();
  if(leaves){await leaving;for(const until=Date.now()+5000;!unexpected.length&&Date.now()<until;)await new Promise(done=>setTimeout(done,10));assert.deepEqual(unexpected.splice(0),['GET '+url],'A clean https provider sign-out URL is the only external navigation');}
  else{await page.getByRole('heading',{name:'Sign in',exact:true,level:1}).waitFor();assert.equal(new URL(page.url()).origin,origin,'A provider sign-out URL with a fragment is never navigated');assert.deepEqual(unexpected,[]);}
 }pass('Provider sign-out goes through navigableHttpUrl: a fragment URL the old prefix check accepted is refused; a clean https URL navigates.');
 assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);assert.ok(requests.some(r=>r.path==='/api/auth/sign-in/email'&&r.method==='POST'));assert.ok(requests.filter(r=>r.method!=='GET').every(r=>['/api/auth/sign-in/email','/api/invitations/inspect','/api/account/two-factor/enable','/api/account/two-factor/verify','/api/auth/sign-out','/api/account/password','/api/account/sessions/revoke'].includes(r.path)));pass('Zero unexpected API/external requests/browser errors; only the explicitly synthetic auth/inspect and locked-workspace enrolment and provider sign-out POST contracts allowed.');
 await writeFile(out+'/result.json',JSON.stringify({passed,requests,limits:['Actual App/controller UI with synthetic API responses only.','No real authentication, persistence, database, server authorization, provider or paid-work validation.','Feature screens intentionally use unavailable or unapplied states; no measured metrics fabricated.']},null,2));
}catch(error){await page?.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});await writeFile(out+'/result.json',JSON.stringify({passed,unexpected,errors,failure:{message:error.message,stack:error.stack}},null,2));throw error;}
finally{await context?.close();await browser?.close();await server.close();}
