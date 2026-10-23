// Opt in: TEN98_WEBSITE_SHARE_EXIT_BROWSER=1 PLAYWRIGHT_MODULE=<absolute index.mjs> node tests/website-share-exit-browser.mjs
// Actual App/router/settings parent; synthetic transport only. No server/grant/provider acceptance.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {execFileSync} from 'node:child_process';
import {launchChromium} from './helpers/playwright.mjs';
assert.equal(process.env.TEN98_WEBSITE_SHARE_EXIT_BROWSER,'1');assert.ok(process.env.PLAYWRIGHT_MODULE);
const control=process.env.TEN98_WEBSITE_SHARE_EXIT_CONTROL==='1';
const root=process.cwd(),out=resolve('private/swarm/share-exit-'+randomBytes(5).toString('hex'));mkdirSync(out,{recursive:true});
const files=['src/components/WebsiteSharePanel.tsx','src/components/AnalyticsSettingsPanel.tsx','src/routes/index.tsx','tests/website-share-exit-browser-fixture.tsx','tests/website-share-exit-browser.mjs'];
const hashes=()=>Object.fromEntries(files.map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));
const evidence={qualification:'Actual App/router/AnalyticsSettingsPanel, synthetic native-shaped transport. No database, grants, providers or built-app proof.',groups:[],contexts:0,requests:0,external:[],unexpected:[],errors:[],before:hashes(),cleanup:[]};
const save=()=>writeFileSync(out+'/evidence.json',JSON.stringify(evidence,null,2)+'\n'),pass=name=>{evidence.groups.push(name);save();console.log('PASS '+name);};
const id=n=>'49000000-0000-4000-8000-'+String(n).padStart(12,'0'),workspace=id(1),project=id(2),user=id(3),share=id(4),base='/api/projects/'+project+'/website-shares',search={workspace,project,view:'collection'};
let server,browser,context,page,origin,state,dialogs=[],accept=false,calls=[];
const btn=name=>page.getByRole('button',{name,exact:true}),name=()=>page.getByRole('textbox',{name:'Link name',exact:true});
const wait=async fn=>{const deadline=Date.now()+7000;while(!await fn()){assert.ok(Date.now()<deadline,'Bounded browser condition failed');await new Promise(done=>setTimeout(done,20));}};
const reply=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify(body)});
const row=(body={label:'Existing public link',sections:['overview'],expiresAt:new Date(Date.now()+7*864e5).toISOString()})=>({id:share,label:body.label,sections:body.sections,expiresAt:body.expiresAt,createdAt:'2026-10-01T00:00:00.000Z',revokedAt:null,state:'active',creator:{name:'Synthetic owner',email:'synthetic@example.org',member:true}});
async function fresh(){
 await context?.close();state={mode:'ok',rows:[row()],settingsStatus:200};calls=[];dialogs=[];accept=false;assert.ok(++evidence.contexts<=12);
 context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});context.setDefaultTimeout(7000);
 await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin){evidence.external.push(url.origin);return route.abort();}if(!url.pathname.startsWith('/api/'))return route.continue();assert.ok(++evidence.requests<=100);
 const path=url.pathname,method=request.method(),raw=request.postData(),body=raw?request.postDataJSON():null;calls.push({path,method,raw,body});
 if(path==='/api/session')return reply(route,{setupRequired:false,appUrl:origin,user:null});
 if(path==='/api/me')return reply(route,{user:{id:user,name:'Synthetic owner',email:'synthetic@example.org'},instanceOperator:false,workspaces:[{id:workspace,name:'Synthetic workspace',role:'owner'}]});
 if(path==='/api/account/preferences')return reply(route,{version:'account-preferences-v1',user:{id:user,name:'Synthetic owner',email:'synthetic@example.org'},preferences:{revision:1,timeZone:'UTC',locale:'en-US',theme:'light',updatedAt:'2026-10-01T00:00:00.000Z'}});
 if(path==='/api/workspaces/'+workspace+'/projects')return reply(route,{projects:[{id:project,name:'Synthetic website',origin:'https://example.org',publicKey:'synthetic-public-key',eventCount:0,lastEventAt:null,retainedFrom:null}]});
 if(path==='/api/projects/'+project+'/analytics-settings')return state.settingsStatus===200?reply(route,{role:'owner',revision:1,networkMode:'direct',settings:{enabled:true,collectionMode:'cookieless',consentMode:'builtin',captureReferrer:true,captureCampaigns:true,captureScreen:false,excludeBots:true,excludedPaths:[]}}):reply(route,{error:'Synthetic settings authority loss'},state.settingsStatus);
 if(path==='/api/projects/'+project+'/events')return reply(route,{total:0,retainedFrom:null,events:[]});
 if(path==='/api/auth/sign-out')return reply(route,{success:true});
 if(path==='/api/auth/oidc/providers')return reply(route,{providers:[]});
 if(path===base&&method==='GET')return state.mode==='401'?reply(route,{error:'Synthetic session loss'},401):reply(route,{projectId:project,role:'owner',items:state.rows,nextCursor:null});
 if(path.startsWith(base)&&method==='POST'){
  if(state.mode==='unknown')return reply(route,{error:'Synthetic uncertain outcome'},503);
  const operation=path.endsWith('/revoke')?'revoke':'create',item=operation==='create'?row(body):{...state.rows[0],state:'revoked',revokedAt:new Date().toISOString()};state.rows=[item];
  return reply(route,{projectId:project,ack:{requestId:body.requestId,operation,shareId:share},item,replayed:state.mode==='retry'});
 }
 evidence.unexpected.push({path,method});return route.abort();});
 page=await context.newPage();page.on('pageerror',error=>evidence.errors.push(error.message));page.on('dialog',async dialog=>{dialogs.push({type:dialog.type(),message:dialog.message()});await(accept?dialog.accept():dialog.dismiss());});
 await page.goto(origin+'/?'+new URLSearchParams(search),{waitUntil:'domcontentloaded'});await btn('New public link').waitFor();
}
async function draft(label='Unsaved public link'){await btn('New public link').click();await name().fill(label);}
// Local New/Cancel/Revoke actions ask through the shared ConfirmDialog; it is recorded beside native router/unload prompts.
async function inPage(title,confirmLabel,choice){const confirmation=page.getByRole('dialog',{name:title,exact:true});dialogs.push({type:'in-page',message:title+' '+await confirmation.innerText()});await confirmation.getByRole('button',{name:choice?confirmLabel:'Cancel',exact:true}).click();await confirmation.waitFor({state:'hidden'});}
async function navigate(view){await page.evaluate(search=>{void window.websiteShareExitFixture.navigate(search);},{workspace,project,view});}
async function sameDraft(label){assert.equal(await name().inputValue(),label);assert.equal(new URL(page.url()).searchParams.get('view'),'collection');}
async function away(){await page.getByRole('region',{name:'Profile and appearance',exact:true}).waitFor();}
async function run(){
 const baseline=control?execFileSync('git',['show','0d07f10:src/components/WebsiteSharePanel.tsx'],{cwd:root,encoding:'utf8'}):null;
 server=await createServer({plugins:baseline?[{name:'original-website-share-control',enforce:'pre',transform(code,id){return id.replaceAll('\\','/').endsWith('/src/components/WebsiteSharePanel.tsx')?baseline:null;}}]:[],configFile:false,envDir:false,root,cacheDir:out+'/vite-cache',appType:'custom',resolve:{dedupe:['react','react-dom']},optimizeDeps:{entries:['tests/website-share-exit-browser-fixture.tsx'],include:['react','react-dom','react-dom/client','react/jsx-dev-runtime','@tanstack/react-router','zod']},server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false},logLevel:'error'});
 server.middlewares.use((request,response,next)=>{if(request.url?.split('?')[0]!=='/')return next();response.setHeader('content-type','text/html');response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Website share exit fixture</title><div id="root"></div><script type="module" src="/tests/website-share-exit-browser-fixture.tsx"></script></html>');});
 await server.listen();origin='http://127.0.0.1:'+server.httpServer.address().port;await server.environments.client.warmupRequest('/tests/website-share-exit-browser-fixture.tsx');await server.environments.client.waitForRequestsIdle();await server.environments.client.depsOptimizer?.scanProcessing;await Promise.all(Object.values(server.environments.client.depsOptimizer?.metadata.discovered??{}).map(value=>value.processing));
 browser=await launchChromium();
 if(control){await fresh();await draft();await navigate('preferences');await wait(()=>dialogs.length===1||new URL(page.url()).searchParams.get('view')==='preferences');assert.equal(dialogs.length,1,'Original source fails to protect the website-share draft on router exit');return;}
 await fresh();await draft();await btn('New public link').click();await inPage('Discard the unsaved public-link draft?','Discard draft',false);assert.equal(dialogs.length,1);await sameDraft('Unsaved public link');await btn('Cancel').click();await inPage('Discard the unsaved public-link draft?','Discard draft',false);assert.equal(dialogs.length,2);await sameDraft('Unsaved public link');accept=true;await btn('Cancel').click();await inPage('Discard the unsaved public-link draft?','Discard draft',true);assert.equal(await name().count(),0);await navigate('preferences');await away();assert.equal(dialogs.length,3);pass('Local New and Cancel protect drafts; confirmed discard and clean navigation work');
 await fresh();await draft('Sidebar draft');await page.getByRole('link',{name:'Settings',exact:true}).click();await wait(()=>dialogs.length===1);await sameDraft('Sidebar draft');await navigate('preferences');await wait(()=>dialogs.length===2);await sameDraft('Sidebar draft');accept=true;await navigate('preferences');await away();assert.equal(dialogs.length,3);await page.evaluate(()=>history.back());await btn('New public link').waitFor();assert.equal(await name().count(),0);pass('Actual sidebar and router cancellation keep draft/parent mounted; acceptance discards it');
 await fresh();await navigate('preferences');await away();await navigate('collection');await btn('New public link').waitFor();await draft('History draft');await page.evaluate(()=>history.back());await wait(()=>dialogs.length===1);await sameDraft('History draft');await page.evaluate(()=>{setTimeout(()=>location.reload(),0);});await wait(()=>dialogs.length===2);assert.equal(dialogs.at(-1).type,'beforeunload');await sameDraft('History draft');accept=true;await page.evaluate(()=>history.back());await away();assert.equal(dialogs.length,3);pass('Native Back cancel and accept use actual parent/router lifetimes');
 for(const operation of ['create','revoke']){
  await fresh();state.mode='unknown';if(operation==='create'){await draft('Exact pending payload');await btn('Create public link').click();}else{await btn('Load public links').click();await btn('Revoke: Existing public link').waitFor();await btn('Revoke: Existing public link').click();await inPage('Revoke this public link now?','Revoke link',true);}
  await btn('Retry the same request').waitFor();await wait(()=>btn('Retry the same request').isEnabled());const first=calls.find(call=>call.method==='POST'&&call.path.startsWith(base)).raw,at=dialogs.length;
  await navigate('preferences');await wait(()=>dialogs.length===at+1);assert.equal(await btn('Retry the same request').count(),1);assert.match(dialogs.at(-1).message,/exact retry/);
  await page.evaluate(()=>{setTimeout(()=>location.reload(),0);});await wait(()=>dialogs.length===at+2);assert.equal(dialogs.at(-1).type,'beforeunload');assert.equal(await btn('Retry the same request').count(),1);
  state.mode='retry';await btn('Retry the same request').click();await wait(()=>btn('Retry the same request').count().then(n=>n===0));const writes=calls.filter(call=>call.method==='POST'&&call.path.startsWith(base));assert.equal(writes.length,2);assert.equal(writes[1].raw,first);
  if(operation==='create'){await page.getByRole('textbox',{name:'New public website URL',exact:true}).waitFor();await btn('Dismiss public website URL').click();}
  if(operation==='create'){state.mode='unknown';await draft('Discard uncertain creation');await btn('Create public link').click();await btn('Retry the same request').waitFor();accept=true;}
  await navigate('preferences');await away();assert.equal(dialogs.length,at+(operation==='create'?3:2));
 }
 pass('Unconfirmed create and revoke retain exact payload after cancelled router exit/reload; confirmed retries become clean');
 await fresh();await draft('Once only');await btn('Create public link').click();const url=page.getByRole('textbox',{name:'New public website URL',exact:true});await url.waitFor();const token=new URL(await url.inputValue()).hash.slice(1);assert.equal(await page.evaluate(token=>location.href.includes(token)||JSON.stringify({...localStorage,...sessionStorage}).includes(token),token),false);
 await navigate('preferences');await wait(()=>dialogs.length===1);assert.match(dialogs[0].message,/shown once/);assert.equal(await url.count(),1);await btn('New public link').click();await inPage('Continue?','Continue',false);assert.equal(dialogs.length,2);assert.equal(await url.count(),1);await btn('Dismiss public website URL').click();await navigate('preferences');await away();assert.equal(dialogs.length,2);pass('One-time secret is memory-only, protected on exit/replacement and deliberately dismissible');
 for(const protectedState of ['draft','pending','secret']){
  await fresh();await draft('Session-bound draft');if(protectedState!=='draft'){state.mode=protectedState==='pending'?'unknown':'ok';await btn('Create public link').click();await(protectedState==='pending'?btn('Retry the same request'):page.getByRole('textbox',{name:'New public website URL',exact:true})).waitFor();}
  await btn('Account menu').click();await btn('Sign out').click();await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();assert.equal(dialogs.length,0);assert.equal(await name().count(),0);assert.equal(await btn('Retry the same request').count(),0);assert.equal(await page.getByRole('textbox',{name:'New public website URL',exact:true}).count(),0);
 }
 pass('Acknowledged actual App signout clears draft, uncertain request and secret without trapping navigation');
 await fresh();await draft('Lost authority');state.mode='unknown';await btn('Create public link').click();await btn('Retry the same request').waitFor();state.settingsStatus=403;await btn('Reload settings').click();await page.getByText('Analytics settings are not available for your current project access.',{exact:true}).waitFor();await navigate('preferences');await away();assert.equal(dialogs.length,0);await navigate('collection');state.settingsStatus=200;await btn('Reload settings').click();await btn('New public link').waitFor();assert.equal(await name().count(),0);assert.equal(await btn('Retry the same request').count(),0);pass('Actual parent settings authority denial removes pending retry; restored access cannot resurrect it');
 await fresh();await draft('Session loss');state.mode='401';await btn('Load public links').click();await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();assert.equal(dialogs.length,0);pass('Share read session loss clears draft without a navigation confirmation');
 assert.deepEqual(evidence.external,[]);assert.deepEqual(evidence.unexpected,[]);assert.deepEqual(evidence.errors,[]);assert.deepEqual(hashes(),evidence.before);evidence.phase='passed';
}
// The work gate enters finally at100s; the final watchdog caps a stalled cleanup at120s.
const watchdog=setTimeout(()=>{console.error('Website share browser exceeded120 seconds including cleanup');process.exit(1);},120000);
let timer;
try{await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Website share regression exceeded its 100 second hard work gate')),100000);})]);}
catch(error){evidence.phase='failed';evidence.failure={message:error.message,stack:error.stack};process.exitCode=1;}
finally{clearTimeout(timer);for(const[label,close]of[['context',()=>context?.close()],['browser',()=>browser?.close()],['vite',()=>server?.close()]]){try{await close();evidence.cleanup.push({label,closed:true});}catch(error){evidence.cleanup.push({label,closed:false,message:error.message});process.exitCode=1;}}evidence.after=hashes();save();clearTimeout(watchdog);console.log(JSON.stringify({phase:evidence.phase,groups:evidence.groups.length,evidence:out+'/evidence.json'}));}
