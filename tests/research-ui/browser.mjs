import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fixtureGuard,appUrl,evidenceDir} from './guard.mjs';
import {launchChromium} from '../helpers/playwright.mjs';

export function deferred(){let done;const promise=new Promise(resolve=>done=resolve);return {promise,resolve:done};}
export async function bounded(promise,ms=30_000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic browser coordination timed out.')),ms);})]);}finally{clearTimeout(timer);}}
export async function providerCounts(){
  let lines;try{lines=await readFile(resolve(evidenceDir,'research-provider-calls.ndjson'),'utf8');}catch(error){if(error.code==='ENOENT')return {};throw error;}
  return lines.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).reduce((counts,event)=>({...counts,[event.operation]:(counts[event.operation]??0)+1}),{});
}
export async function browserSession(user){
  fixtureGuard();const browser=await launchChromium();
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage(),errors=[],outbound=[];
  page.on('pageerror',error=>errors.push(error));
  await context.route('**/*',route=>{
    let origin;try{origin=new URL(route.request().url()).origin;}catch{}
    if(origin===appUrl)return route.continue();outbound.push('unexpected-browser-request');return route.abort('blockedbyclient');
  });
  const signed=await context.request.post(appUrl+'/api/auth/sign-in/email',{headers:{Origin:appUrl},data:{email:user.email,password:user.password}});
  assert.equal(signed.status(),200,'Synthetic local sign-in must succeed.');
  return {browser,context,page,errors,outbound};
}
export const href=(group,view,project=group.main)=>appUrl+'/?'+new URLSearchParams({workspace:group.workspace.id,project:project.id,view});
export async function sidebar(page){const button=page.getByRole('button',{name:/^(Menu|Close menu)$/});if(await button.isVisible()&&await button.getAttribute('aria-expanded')==='false')await button.click();}
export async function projectSection(page,project,section){
  await sidebar(page);await page.getByRole('navigation',{name:'Projects',exact:true}).getByRole('link',{name:project.name,exact:true}).click();
  await page.waitForFunction(id=>new URLSearchParams(location.search).get('project')===id,project.id);
  await sidebar(page);const target=page.getByRole('navigation',{name:'Project sections',exact:true}).getByRole('link',{name:section,exact:true,includeHidden:true});
  await target.waitFor({state:'attached'});
  for(const disclosure of await target.locator('xpath=ancestor::details').all())if(await disclosure.getAttribute('open')===null)await disclosure.locator(':scope > summary').click();
  await target.click();
}
export async function captureFailure(page,error,stage){
  const secrets=[process.env.AUTH_SECRET,process.env.DATABASE_URL,process.env.CREDENTIAL_KEYS];
  try{const fixture=JSON.parse(await readFile(resolve(evidenceDir,'fixtures.json'),'utf8'));secrets.push(fixture.bootstrap.password,...Object.values(fixture.groups).flatMap(group=>[group.owner?.password,group.editor?.password,group.viewer?.password]));}catch{}
  const redact=value=>secrets.filter(value=>typeof value==='string'&&value.length>5).reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),String(value));
  const dir=resolve(evidenceDir,'research-evidence');await mkdir(dir,{recursive:true});
  const name='failure-'+Date.now();await writeFile(resolve(dir,name+'.txt'),redact(stage+'\n'+(error?.stack??error))+'\n',{mode:0o600});
  if(page&&!page.isClosed()){await writeFile(resolve(dir,name+'.html'),redact(await page.content()),{mode:0o600});await page.screenshot({path:resolve(dir,name+'.png'),fullPage:true}).catch(()=>{});}
}
export async function selectedKeywordFocus(page,panel){
  const heading=panel.getByRole('heading',{name:/^Keyword (overview|ideas) results$/});await heading.waitFor();
  await page.waitForFunction(element=>document.activeElement===element,await heading.elementHandle());
}
export async function openKeywordForm(panel){
  const summary=panel.getByText('New keyword research',{exact:true});
  if((await summary.locator('..').getAttribute('open'))===null)await summary.click();
}
export async function assertLayout(page,name){
  await mkdir(resolve(evidenceDir,'research-evidence'),{recursive:true});
  for(const width of [1440,360]){
    await page.setViewportSize({width,height:width===360?860:1000});
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No page-wide horizontal overflow.');
    for(const region of await page.getByRole('region').all()){
      const table=region.locator('table');if(!await table.count())continue;
      const overflowing=await region.evaluate(el=>el.scrollWidth>el.clientWidth+1);
      if(overflowing){assert.equal(await region.getAttribute('tabindex'),'0');await region.evaluate(el=>{el.scrollLeft=0;});await region.focus();await region.press('ArrowRight');
        await page.waitForFunction(el=>el.scrollLeft>0,await region.elementHandle(),{timeout:3000});
        await region.evaluate(el=>{el.scrollLeft=el.scrollWidth;});}
    }
    await page.evaluate(()=>window.scrollTo({top:0,left:0,behavior:'instant'}));
    await page.screenshot({path:resolve(evidenceDir,'research-evidence',name+'-'+width+'.png'),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
}
// Executes the real POST once, then loses only its acknowledgement. Every later
// explicit retry is forwarded unchanged and checked against the immutable body.
export async function loseFirstPost(page,path,{onCommitted,failure='disconnect'}={}){
  assert.ok(['disconnect','503','malformed','malformed-row'].includes(failure));
  const bodies=[];let first=true;
  const handler=async route=>{
    if(route.request().method()!=='POST')return route.continue();
    const body=route.request().postDataJSON();bodies.push(body);
    if(bodies.length>1)assert.deepEqual(body,bodies[0],'Retry must preserve the exact accepted body.');
    const response=await route.fetch();assert.ok([200,202].includes(response.status()),'Acceptance must commit before the response is dropped.');
    if(first){first=false;const accepted=await response.json();await onCommitted?.(body,accepted);
      if(failure==='503')return route.fulfill({status:503,json:{error:'Synthetic acknowledgement unavailable.'}});
      if(failure==='malformed')return route.fulfill({status:202,contentType:'application/json',body:'{}'});
      if(failure==='malformed-row')return route.fulfill({status:202,json:{...accepted,run:{...accepted.run,result:{retrievedAt:new Date().toISOString(),source:'DataForSEO Labs / Google',rows:[{}],missingKeywords:[],totalCount:1,limited:false}}}});
      return route.abort('connectionreset');}
    return route.fulfill({response});
  };
  await page.route(path,handler);return {bodies,dispose:()=>page.unroute(path,handler)};
}
export async function holdNextGet(page,path,{status}={}){
  const entered=deferred(),released=deferred();let first=true;
  const handler=async route=>{
    if(route.request().method()!=='GET'||!first)return route.continue();first=false;
    const response=await route.fetch();entered.resolve();await released.promise;
    await (status?route.fulfill({status,json:{error:'Synthetic stale response.'}}):route.fulfill({response})).catch(()=>{});
  };
  await page.route(path,handler);return {entered:entered.promise,release:released.resolve,dispose:async()=>{released.resolve();await page.unroute(path,handler);}};
}
