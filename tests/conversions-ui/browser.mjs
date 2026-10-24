import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fixtureGuard,evidenceDir,appUrl} from './guard.mjs';
import {readFixture} from './fixture.mjs';
import {getDatabase,closeDatabase} from '../../src/server/db.ts';
import {launchChromium} from '../helpers/playwright.mjs';

fixtureGuard();const fixture=await readFixture(),pool=getDatabase().pool;
const browser=await launchChromium();
const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US',timezoneId:'UTC',serviceWorkers:'block'});
const page=await context.newPage(),errors=[],outbound=[],cleanups=[];let stage='login';
page.setDefaultTimeout(15_000);page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',route=>{
  let origin;try{origin=new URL(route.request().url()).origin;}catch{}
  if(origin===appUrl)return route.continue();outbound.push('unexpected browser request');return route.abort('blockedbyclient');
});
page.on('dialog',dialog=>void dialog.accept());
const panel=page.getByRole('region',{name:'Conversions',exact:true});
const href=(project,workspace=fixture.workspace)=>appUrl+'/?'+new URLSearchParams({workspace:workspace.id,project:project.id,view:'conversions'});
const apiPath=(project,kind='funnels',id='')=>'/api/projects/'+project.id+'/'+kind+(id?'/'+id:'');
const later=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Browser coordination timed out.')),20_000))]);}finally{clearTimeout(timer);}}
async function json(path,{method='GET',data,status=200}={}){
  assert.ok(path.startsWith('/api/')&&!path.startsWith('//'));
  const response=await context.request.fetch(appUrl+path,{method,data,headers:{Origin:appUrl},maxRedirects:0,timeout:15_000});
  assert.equal(response.status(),status,'Real application API status: '+path);return response.json();
}
async function focused(locator){await locator.waitFor();await page.waitForFunction(element=>document.activeElement===element,await locator.elementHandle());}
async function idle(){await panel.getByRole('button',{name:'Apply filters',exact:true}).waitFor();await page.waitForFunction(element=>!element.disabled,await panel.getByRole('button',{name:'Apply filters',exact:true}).elementHandle());}
async function period(){await idle();await panel.getByLabel('From',{exact:true}).fill('2026-01-31');await panel.getByLabel('To',{exact:true}).fill('2026-01-31');await panel.getByRole('button',{name:'Apply filters',exact:true}).click();await idle();}
async function list(){await panel.getByRole('button',{name:'← Back to list',exact:true}).click();await panel.getByRole('heading',{name:/^Saved (funnels|goals)$/}).waitFor();}
// The shared FunnelBreakdown renders one list item per step: its count, "Conversion: <rate> overall" and the
// panel's "Drop-off: <n> · From previous: <rate>" detail. Read them as [count, drop-off, from previous, overall].
async function funnelSteps(){
  const results=panel.getByRole('region',{name:'Funnel conversion results',exact:true});await results.waitFor();
  return results.locator('ol > li').evaluateAll(items=>items.map(item=>{
    const text=selector=>item.querySelector(selector)?.textContent??'';
    const detail=/^Drop-off: (.*) · From previous: (.*)$/.exec(text('.t98-funnel-detail > p'))??[];
    return [text('.t98-funnel-count > span'),detail[1],detail[2],/^Conversion: (.*?)(?: overall)?$/.exec(text('.t98-funnel-conversion'))?.[1]];
  }));
}
async function funnelCounts(counts){
  const steps=await funnelSteps();assert.equal(steps.length,counts.length);
  assert.deepEqual(steps.map(step=>step[0]),counts.map(String));
}
async function newFunnel(name){
  await panel.getByRole('button',{name:'New funnel',exact:true}).click();await panel.getByLabel('Name',{exact:true}).fill(name);
  await panel.getByLabel('Minutes between steps',{exact:true}).fill('5');await panel.getByRole('button',{name:'Add step',exact:true}).click();
  for(const [index,event]of ['A','B','C'].entries()){
    const step=panel.getByRole('group',{name:'Step '+(index+1),exact:true});
    await step.getByLabel('Action',{exact:true}).selectOption('event');await step.getByRole('combobox',{name:'Event name',exact:true}).fill(event);
  }
}
// Forward the real mutation and discard only its response. No mocked success DTO.
async function loseAcknowledgement(path,failure){
  const bodies=[],accepted=[];let first=true;
  const handler=async route=>{
    if(route.request().method()!=='POST')return route.continue();
    const body=route.request().postDataJSON();bodies.push(body);
    if(bodies.length>1)assert.deepEqual(body,bodies[0],'An explicit retry must retain the exact frozen payload and request ID.');
    const response=await route.fetch({maxRedirects:0});assert.equal(response.status(),200);accepted.push(await response.json());
    if(first){first=false;return failure==='503'?route.fulfill({status:503,json:{error:'Synthetic lost acknowledgement.'}}):route.fulfill({status:200,json:{role:'owner',deleted:false,replayed:false,item:{}}});}
    return route.fulfill({response});
  };
  await page.route(appUrl+path,handler);const dispose=()=>page.unroute(appUrl+path,handler);cleanups.push(dispose);return{bodies,accepted,dispose};
}
async function heldGet(path,{status}={}){
  const entered=later(),release=later();let first=true;
  const handler=async route=>{
    if(route.request().method()!=='GET'||!first)return route.continue();first=false;
    const response=await route.fetch({maxRedirects:0});assert.equal(response.status(),200);entered.resolve();await release.promise;
    try{await(status?route.fulfill({status,json:{error:'Synthetic obsolete authorization response.'}}):route.fulfill({response}));}catch(e){if(!/closed|handled|intercepted|invalid|cancel/i.test(String(e)))throw e;}
  };
  await page.route(path,handler);const dispose=async()=>{release.resolve();await page.unroute(path,handler);};cleanups.push(dispose);return{entered:entered.promise,release:release.resolve,dispose};
}
async function layout(label){
  await mkdir(resolve(evidenceDir,'screenshots'),{recursive:true});
  for(const width of [1440,360]){
    await page.setViewportSize({width,height:width===360?860:1000});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No page-wide horizontal overflow.');
    for(const region of await panel.getByRole('region').all())if(await region.locator('table').count()){
      if(await region.evaluate(el=>el.scrollWidth>el.clientWidth+1)){
        assert.equal(await region.getAttribute('tabindex'),'0');await region.evaluate(el=>el.scrollLeft=0);await region.focus();await region.press('ArrowRight');
        await page.waitForFunction(el=>el.scrollLeft>0,await region.elementHandle(),{timeout:3000});
      }
    }
    await page.screenshot({path:resolve(evidenceDir,'screenshots',label+'-'+width+'.png'),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
}
async function workspace(id){
  const menu=page.getByRole('button',{name:/^(Menu|Close menu)$/});if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')==='false')await menu.click();
  await page.getByLabel('Workspace',{exact:true}).selectOption(id);
  await page.waitForFunction(id=>new URLSearchParams(location.search).get('workspace')===id,id);
}
async function conversionsFor(project){
  const menu=page.getByRole('button',{name:/^(Menu|Close menu)$/});if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')==='false')await menu.click();
  await page.locator('aside.t98-shell-sidebar').getByRole('combobox',{name:'Website',exact:true}).selectOption({label:project.name});
  await page.waitForFunction(id=>new URLSearchParams(location.search).get('project')===id,project.id);
  if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')==='false')await menu.click();
  // Conversions is a sidebar section whose first tab, Goals, holds the panel's Goals/Funnels switch (Goals first).
  await page.locator('aside.t98-shell-sidebar').getByRole('navigation',{name:'Sections',exact:true}).getByRole('link',{name:'Conversions',exact:true}).click();
  await page.getByRole('navigation',{name:'Conversions pages',exact:true}).getByRole('link',{name:'Goals',exact:true}).click();
  await panel.getByRole('button',{name:'Funnels',exact:true}).click();
  await panel.getByRole('heading',{name:'Saved funnels',exact:true}).waitFor();
}
async function assertGoal(){
  await idle();
  const values=await panel.locator('.metric-value').allTextContents();assert.deepEqual(values,['1','3','33.3%']);
  assert.match(await panel.textContent(),/2 observations without a visitor identity are excluded/);
}
try{
  await json('/api/auth/sign-in/email',{method:'POST',data:{email:fixture.owner.email,password:fixture.owner.password}});
  await page.goto(href(fixture.chains));await panel.getByRole('button',{name:'Funnels',exact:true}).click();await panel.getByRole('button',{name:'New funnel',exact:true}).waitFor();
  stage='create and exact immutable retry after accepted 503';
  await newFunnel('Three observed steps');const create=await loseAcknowledgement(apiPath(fixture.chains),'503');
  await panel.getByRole('button',{name:'Save funnel',exact:true}).click();await panel.getByRole('button',{name:'Retry same save',exact:true}).waitFor();
  assert.equal(await panel.getByLabel('Name',{exact:true}).isDisabled(),true);
  await panel.getByRole('button',{name:'Retry same save',exact:true}).click();await idle();
  assert.equal(create.bodies.length,2);assert.equal(create.accepted[1].replayed,true);const funnelId=create.accepted[0].item.id;await create.dispose();
  assert.equal((await pool.query('SELECT count(*) n FROM analytics_definition WHERE project_id=$1',[fixture.chains.id])).rows[0].n,'1');
  await period();await funnelCounts([3,2,1]);
  assert.deepEqual((await funnelSteps()).map(step=>step.slice(1)),[['—','—','100%'],['1','66.7%','66.7%'],['1','50%','33.3%']]);
  console.log('PASS real saved funnel, exact 3/2/1 visitor counts, drop-offs, rates and immutable accepted-503 retry');

  stage='witness chain and responsive keyboard evidence';
  await panel.getByRole('button',{name:'View matching activity',exact:true}).nth(2).click();
  await focused(panel.getByRole('heading',{name:'Matching activity for step 3',exact:true}));
  assert.equal(await panel.locator('.conversion-witness').count(),1);
  assert.deepEqual(await panel.locator('.conversion-witness li > p:first-child').allTextContents(),['/A','/B','/C']);
  const witness=await json(apiPath(fixture.chains,'funnels',funnelId)+'/witnesses?revision=1&from=2026-01-31&to=2026-01-31&timeZone=UTC&step=3');
  const observations=witness.witnesses[0].events.map(e=>fixture.events.find(saved=>saved.id===e.id));
  assert.ok(observations.every(Boolean));assert.equal(new Set(observations.map(e=>e.visitor)).size,1);assert.deepEqual(observations.map(e=>e.eventName),['A','B','C']);
  for(let i=1;i<observations.length;i++)assert.ok(Date.parse(observations[i].receivedAt)>Date.parse(observations[i-1].receivedAt));
  for(const observation of observations)assert.ok(!JSON.stringify(witness).includes(observation.visitor),'Visitor hashes must remain private.');
  await panel.getByRole('button',{name:'← Back to results',exact:true}).click();await focused(panel.getByRole('button',{name:'View matching activity',exact:true}).nth(2));
  await layout('funnel-results');

  stage='property edit and malformed accepted acknowledgement';
  await panel.getByRole('button',{name:'Edit definition',exact:true}).click();await focused(panel.getByRole('heading',{name:'Edit funnel',exact:true}));
  const middle=panel.getByRole('group',{name:'Step 2',exact:true});await middle.locator('summary').filter({hasText:'Property filters'}).click();
  await middle.getByRole('button',{name:'Add property filter',exact:true}).click();await middle.getByLabel('Property key',{exact:true}).fill('plan');
  await middle.getByLabel('Operator',{exact:true}).selectOption('eq');await middle.getByLabel('Type',{exact:true}).selectOption('string');await middle.getByLabel('JSON value',{exact:true}).fill('"pro"');
  const update=await loseAcknowledgement(apiPath(fixture.chains,'funnels',funnelId)+'/update','malformed');
  await panel.getByRole('button',{name:'Save funnel',exact:true}).click();await panel.getByRole('button',{name:'Retry same save',exact:true}).click();await idle();
  assert.equal(update.bodies.length,2);assert.equal(update.accepted[1].replayed,true);assert.equal(update.accepted[1].item.revision,2);await update.dispose();await funnelCounts([3,1,1]);
  console.log('PASS actual property-filtered result and unchanged malformed-2xx retry without duplicate revisions');

  stage='failed edit read cannot become create';
  const itemUrl=appUrl+apiPath(fixture.chains,'funnels',funnelId);let failRead=true;
  const failedEdit=async route=>{if(route.request().method()==='GET'&&failRead){failRead=false;return route.fulfill({status:503,json:{error:'Synthetic read unavailable.'}});}return route.continue();};
  await page.route(itemUrl,failedEdit);cleanups.push(()=>page.unroute(itemUrl,failedEdit));
  await panel.getByRole('button',{name:'Edit definition',exact:true}).click();await panel.getByRole('button',{name:'Retry loading definition',exact:true}).waitFor();
  assert.equal(await panel.getByRole('button',{name:'Save funnel',exact:true}).isDisabled(),true);assert.equal(await panel.getByLabel('Name',{exact:true}).isDisabled(),true);
  await panel.getByRole('button',{name:'Retry loading definition',exact:true}).click();await focused(panel.getByRole('heading',{name:'Edit funnel',exact:true}));await page.unroute(itemUrl,failedEdit);
  assert.equal(await panel.getByLabel('Name',{exact:true}).inputValue(),'Three observed steps');
  assert.equal((await pool.query('SELECT count(*) n FROM analytics_definition WHERE project_id=$1',[fixture.chains.id])).rows[0].n,'1');

  stage='real concurrent revision preserves draft until explicit reload';
  const before=(await json(apiPath(fixture.chains,'funnels',funnelId))).item;
  await json(apiPath(fixture.chains,'funnels',funnelId)+'/update',{method:'POST',data:{requestId:randomUUID(),revision:before.revision,definition:{...before.definition,name:'Concurrent saved revision'}}});
  await panel.getByLabel('Name',{exact:true}).fill('Uncommitted local draft');await panel.getByRole('button',{name:'Save funnel',exact:true}).click();
  await panel.getByRole('button',{name:'Reload saved definition',exact:true}).waitFor();assert.equal(await panel.getByLabel('Name',{exact:true}).inputValue(),'Uncommitted local draft');
  assert.equal(await panel.getByRole('button',{name:'Save funnel',exact:true}).isDisabled(),true);
  await panel.getByRole('button',{name:'Reload saved definition',exact:true}).click();await page.getByRole('dialog',{name:'Discard this draft and load the latest saved definition?',exact:true}).getByRole('button',{name:'Load saved definition',exact:true}).click();await page.waitForFunction(el=>el.value==='Concurrent saved revision',await panel.getByLabel('Name',{exact:true}).elementHandle());
  await panel.getByLabel('Name',{exact:true}).fill('Final saved funnel');await panel.getByRole('button',{name:'Save funnel',exact:true}).click();await idle();await funnelCounts([3,1,1]);
  console.log('PASS failed edit-read guard and real revision conflict with draft preservation');

  stage='real permission loss purges stale manager controls';
  await panel.getByRole('button',{name:'Edit definition',exact:true}).click();await focused(panel.getByRole('heading',{name:'Edit funnel',exact:true}));await panel.getByLabel('Name',{exact:true}).fill('Forbidden edit');
  await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[fixture.workspace.id,fixture.owner.id]);
  await panel.getByRole('button',{name:'Save funnel',exact:true}).click();await panel.getByRole('button',{name:'Reload access',exact:true}).waitFor();
  assert.equal(await panel.getByLabel('Name',{exact:true}).count(),0);assert.equal(await panel.getByRole('button',{name:'New funnel',exact:true}).count(),0);
  await panel.getByRole('button',{name:'Reload access',exact:true}).click();await panel.getByRole('button',{name:'View results',exact:true}).waitFor();
  assert.equal(await panel.getByRole('button',{name:'New funnel',exact:true}).count(),0);await panel.getByRole('button',{name:'View results',exact:true}).click();await idle();
  assert.equal(await panel.getByRole('button',{name:'Edit definition',exact:true}).count(),0);
  assert.equal((await json(apiPath(fixture.chains,'funnels',funnelId))).item.definition.name,'Final saved funnel');
  await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[fixture.workspace.id,fixture.owner.id]);

  stage='stale success and 401 cannot cross workspace selection';
  for(const status of [undefined,401]){
    await page.goto(href(fixture.chains));await panel.getByRole('button',{name:'Funnels',exact:true}).click();await panel.getByRole('button',{name:'View results',exact:true}).click();await idle();
    const held=await heldGet(appUrl+apiPath(fixture.chains,'funnels',funnelId)+'/result?*',{status});
    await panel.getByRole('button',{name:'Refresh results',exact:true}).click();await bounded(held.entered);
    await workspace(fixture.otherWorkspace.id);await conversionsFor(fixture.empty);await panel.getByText('No saved funnels yet.',{exact:true}).waitFor();
    held.release();await held.dispose();await page.waitForTimeout(100);
    assert.equal(await panel.getByRole('heading',{name:'Final saved funnel',exact:true}).count(),0);assert.equal(await page.getByRole('heading',{name:'Sign in',exact:true}).count(),0);
    assert.equal(new URL(page.url()).searchParams.get('workspace'),fixture.otherWorkspace.id);await panel.getByRole('button',{name:'New funnel',exact:true}).waitFor();
  }
  console.log('PASS live role loss and obsolete success/401 responses across workspace changes');

  stage='goal page-view numerator and all-activity known-visitor denominator';
  await page.goto(href(fixture.goals));await panel.getByRole('button',{name:'Goals',exact:true}).click();await panel.getByRole('button',{name:'New goal',exact:true}).click();
  await panel.getByLabel('Name',{exact:true}).fill('Thank-you page');await panel.getByRole('combobox',{name:'Page path',exact:true}).fill('/thank-you');await panel.getByRole('button',{name:'Save goal',exact:true}).click();await period();await assertGoal();
  const goal=(await json(apiPath(fixture.goals,'goals'))).items[0];
  await panel.getByRole('button',{name:'View matching activity',exact:true}).click();await focused(panel.getByRole('heading',{name:'Matching activity for this goal',exact:true}));
  assert.equal(await panel.locator('.conversion-witness').count(),1);assert.match(await panel.locator('.conversion-witness').textContent(),/page_view/);
  await panel.getByRole('button',{name:'← Back to results',exact:true}).click();await focused(panel.getByRole('button',{name:'View matching activity',exact:true}));await layout('goal-results');
  await panel.getByRole('button',{name:'Edit definition',exact:true}).click();await focused(panel.getByRole('heading',{name:'Edit goal',exact:true}));
  await panel.getByLabel('Action',{exact:true}).selectOption('event');await panel.getByRole('combobox',{name:'Event name',exact:true}).fill('purchase');await panel.getByLabel('Name',{exact:true}).fill('Purchase event');
  await panel.getByRole('button',{name:'Save goal',exact:true}).click();await assertGoal();
  const realGoal=await json(apiPath(fixture.goals,'goals',goal.id)+'/result?revision=2&from=2026-01-31&to=2026-01-31&timeZone=UTC');
  assert.deepEqual(realGoal.goal,{visitors:1,totalVisitors:3,rate:1/3});
  console.log('PASS page-view and custom-event goals, repeated activity deduplication and honest unidentified exclusion');

  stage='delete exact retry and event preservation';
  const deletion=await loseAcknowledgement(apiPath(fixture.goals,'goals',goal.id)+'/delete','503');
  await panel.getByRole('button',{name:'Delete definition',exact:true}).click();await page.getByRole('dialog',{name:'Delete “Purchase event”?',exact:true}).getByRole('button',{name:'Delete definition',exact:true}).click();await panel.getByRole('button',{name:'Retry same delete',exact:true}).click();
  await panel.getByText('No saved goals yet.',{exact:true}).waitFor();assert.equal(deletion.bodies.length,2);assert.equal(deletion.accepted[1].replayed,true);await deletion.dispose();
  await focused(panel.getByRole('heading',{name:'Saved goals',exact:true}));
  assert.equal((await pool.query('SELECT count(*) n FROM analytics_definition WHERE id=$1',[goal.id])).rows[0].n,'0');
  assert.equal((await pool.query('SELECT count(*) n FROM event WHERE project_id=ANY($1::text[])',[[fixture.chains.id,fixture.goals.id]])).rows[0].n,String(fixture.events.length));
  assert.deepEqual(errors,[]);assert.deepEqual(outbound,[]);
  await writeFile(resolve(evidenceDir,'acceptance.json'),JSON.stringify({status:'passed',completedAt:new Date().toISOString(),cases:['real CRUD and exact chained visitor metrics','typed property edit','goal denominator and deduplication','accepted 503 and malformed 2xx immutable retry','failed edit-read and real revision conflict','real viewer demotion and stale workspace response','responsive tables and focus restoration','idempotent delete preserves events']},null,2)+'\n');
  console.log('PASS definition deletion, unchanged collected events, no browser exceptions or external browser requests');
}catch(error){
  const secrets=[fixture.owner.password,process.env.DATABASE_URL,process.env.AUTH_SECRET,process.env.BOOTSTRAP_TOKEN].filter(Boolean);
  const redact=value=>secrets.reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),String(value));
  await mkdir(evidenceDir,{recursive:true});await writeFile(resolve(evidenceDir,'failure.txt'),redact(stage+'\n'+(error.stack??error))+'\n',{mode:0o600});
  await page.screenshot({path:resolve(evidenceDir,'failure.png'),fullPage:true}).catch(()=>{});
  console.error('FAIL conversions browser acceptance: '+stage+' (private evidence saved).');process.exitCode=1;
}finally{
  for(const dispose of cleanups.reverse())await dispose().catch(()=>{});
  try{await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[fixture.workspace.id,fixture.owner.id]);}
  finally{await context.close();await browser.close();await closeDatabase();}
}
