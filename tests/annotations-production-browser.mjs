// Run after the unchanged Explorer browser suite on a fresh, isolated production fixture.
async function editExplore(target){
  const dialog=target.getByRole('dialog',{name:'Explore filters',exact:true}),button=target.getByRole('button',{name:'Edit filters',exact:true});
  if(await button.count()){if(!await dialog.isVisible())await button.click();const presets=dialog.locator('details.explorer-presets');if(!await presets.evaluate(node=>node.open))await presets.locator(':scope > summary').click();}
  return target;
}
async function closeExplore(target){
  const dialog=target.getByRole('dialog',{name:'Explore filters',exact:true});if(await dialog.isVisible())await dialog.getByRole('button',{name:'Close filters',exact:true}).click();return target;
}
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {launchChromium} from './helpers/playwright.mjs';
import {openView} from './helpers/app-navigation.ts';

assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_ANNOTATIONS_PRODUCTION_BROWSER,'1');
const config=getConfig(),db=new URL(config.databaseUrl),origin=config.appUrl;
assert.ok(['127.0.0.1','localhost','[::1]'].includes(db.hostname));assert.equal(db.port,'55501');assert.match(db.pathname,/^\/ten98_annotations_[a-f0-9]{12}$/);assert.equal(db.search,'');assert.equal(db.hash,'');assert.equal(origin,'http://127.0.0.1:3099');
for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE','PGOPTIONS','DATABASE_URL_FILE'])assert.equal(process.env[key],undefined);
assert.ok(process.env.PLAYWRIGHT_MODULE);
const {pool}=getDatabase(),workspace=randomUUID(),project=randomUUID(),capacity=randomUUID(),owner=randomUUID(),second=randomUUID(),timed=randomUUID();
const password=randomBytes(24).toString('base64url'),evidence='private/annotations-production-browser-evidence',errors=[],contexts=[];
const endpoint='/api/projects/'+project+'/annotations',explore='/api/projects/'+project+'/explore';
let browser,page,stage='fixture',outbound=0,analyticsGets=0;
await mkdir(evidence,{recursive:true});
try{
  await assertSchema();assert.equal((await pool.query("SELECT claimed FROM installation WHERE id='instance'")).rows[0].claimed,true);
  for(const table of ['analytics_cohort','analytics_annotation','analytics_segment'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0,'Use a fresh synthetic installation (tests/helpers/native-browser.mjs).');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM analytics_annotation')).rows[0].n,0,'Production acceptance requires untouched annotation fixtures.');
  const hashed=await hashPassword(password);
  for(const uid of [owner,second]){await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Annotation reviewer\',$2)',[uid,uid+'@annotations-browser.integration.test']);await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),uid,hashed]);}
  await pool.query("INSERT INTO workspace(id,name,raw_analytics_days) VALUES($1,'Annotation browser fixture',3650)",[workspace]);
  for(const uid of [owner,second])await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,uid]);
  for(const [id,name]of [[project,'Annotation sample'],[capacity,'Many note sample']])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,$3,'https://'||$1||'.integration.test',$4,'infinity')",[id,workspace,name,randomUUID()]);
  for(const path of ['/one','/two'])await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at) VALUES(gen_random_uuid(),$1,'signup',$2,'2026-03-08T12:00:00Z')",[project,path]);
  await pool.query("INSERT INTO analytics_annotation(id,project_id,user_id,date,all_day,note) VALUES($1,$2,$3,'2026-03-09T03:30:00.123Z',false,'Timed marker')",[timed,project,owner]);
  await pool.query("INSERT INTO analytics_annotation(id,project_id,user_id,date,all_day,note) SELECT gen_random_uuid(),$1,$2,'2026-03-08T12:00:00Z',true,CASE WHEN n<=4 THEN 'Capacity %_ note '||n ELSE 'Capacity note '||n END FROM generate_series(1,1005)n",[capacity,second]);
  browser=await launchChromium();
  async function session(uid){
    const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,serviceWorkers:'block'});contexts.push(context);
    await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();outbound++;return route.abort();});
    assert.equal((await context.request.post(origin+'/api/auth/sign-in/email',{headers:{origin},data:{email:uid+'@annotations-browser.integration.test',password}})).status(),200);
    page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='GET'&&/\/(analytics|explore)$/.test(new URL(r.url()).pathname))analyticsGets++;});await page.goto(origin);return context;
  }
  async function nav(label){await closeExplore(page);const menu=page.getByRole('button',{name:'Menu',exact:true});if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')==='false')await menu.click();const project=page.locator('aside.t98-shell-sidebar').getByLabel('Website',{exact:true});if(await project.evaluate((select,name)=>[...select.options].some(option=>option.text===name),label)){await project.selectOption({label});return;}await (await closeExplore(page)).getByRole('link',{name:label,exact:true}).click();}
  const notes=()=>page.getByRole('region',{name:'Annotations',exact:true}),button=name=>notes().getByRole('button',{name,exact:true}),editor=()=>notes().getByRole('form',{name:/^(Add|Edit) annotation$/}),note=()=>notes().getByLabel('Note',{exact:true});
  const settled=()=>page.waitForFunction(()=>{const region=document.querySelector('section[aria-label="Annotations"]');return region&&![...document.querySelectorAll('[role="status"]')].some(n=>/^(Loading annotations|Saving annotation|Loading saved filters|Saving filters|Loading analytics)/.test(n.textContent));});
  async function open(label,within=page){const summary=within.locator('summary').filter({hasText:label});if(!await summary.locator('..').evaluate(n=>n.open))await summary.click();}
  const manager=()=>open('View or manage notes',notes());
  async function apply(from='2026-03-08',to='2026-03-09',zone='America/New_York',pid=project){await (await editExplore(page)).getByLabel('From',{exact:true}).fill(from);await (await editExplore(page)).getByLabel('To',{exact:true}).fill(to);await (await editExplore(page)).getByLabel('Time zone',{exact:true}).fill(zone);const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/projects/${pid}/explore`&&r.request().method()==='GET');await (await editExplore(page)).getByRole('button',{name:'Apply filters',exact:true}).click();const result=await response;assert.equal(result.status(),200);await (await closeExplore(page)).getByRole('button',{name:'Download CSV',exact:true}).waitFor();await settled();return result.json();}
  async function csv(){const event=page.waitForEvent('download');await (await closeExplore(page)).getByRole('button',{name:'Download CSV',exact:true}).click();return readFile(await(await event).path(),'utf8');}
  async function post(context,suffix,body){const response=await context.request.post(origin+endpoint+suffix,{headers:{origin},data:body});assert.equal(response.status(),200);return response.json();}
  async function mutation(click,expected=200){const response=page.waitForResponse(r=>new URL(r.url()).pathname.startsWith(endpoint)&&r.request().method()==='POST');await click();const result=await response;assert.equal(result.status(),expected);const body=await result.json();await settled();return body;}
  async function add(text){await closeExplore(page);await button('Add annotation').click();await note().fill(text);}
  const submit=()=>mutation(()=>editor().getByRole('button',{name:/^(Add|Save) annotation$/}).click());
  const search=async text=>{await notes().getByLabel('Search notes',{exact:true}).fill(text);await notes().getByLabel('Search notes',{exact:true}).press('Enter');await settled();};
  const row=text=>notes().locator('article').filter({has:page.getByText(text,{exact:true})});
  const stored=async id=>(await pool.query('SELECT date,all_day,note,revision FROM analytics_annotation WHERE id=$1',[id])).rows[0];
  const shot=label=>page.screenshot({path:evidence+'/'+label+'.png',fullPage:true,animations:'disabled'});

  const context=await session(owner);stage='applied range and creation';await nav('Annotation sample');await closeExplore(page);await openView(page,'explore');await (await closeExplore(page)).getByRole('button',{name:'Download CSV',exact:true}).waitFor();const applied=await apply();await manager();assert.equal(applied.totals.events,2);const originalCsv=await csv(),reads=analyticsGets;
  await (await editExplore(page)).getByLabel('Time zone',{exact:true}).fill('Asia/Dubai');await (await editExplore(page)).getByLabel('To',{exact:true}).fill('2026-03-10');
  const literal='<b>Launch 100%_ 🐎</b>';await add(literal);assert.equal(await editor().getByLabel('Annotation date (America/New_York)',{exact:true}).inputValue(),'2026-03-09');const created=await submit();assert.equal(created.item.definition.date,'2026-03-09T04:00:00.000Z');assert.equal(created.item.definition.allDay,true);assert.equal(await notes().locator('article b').count(),0);
  await open('Daily data');await page.getByRole('button',{name:'2026-03-08: 1 annotation',exact:true}).click();await settled();assert.equal(await notes().locator('article').count(),1);await button('Edit annotation').click();await settled();await note().fill('Timed text edit');const edited=await submit();assert.equal(edited.item.id,timed);assert.deepEqual(edited.item.definition,{date:'2026-03-09T03:30:00.123Z',allDay:false,note:'Timed text edit'});
  await button('All notes').click();await settled();await add('Future project note');await editor().getByLabel('Annotation date (America/New_York)',{exact:true}).fill('2099-01-02');const future=await submit();assert.equal(future.item.definition.date,'2099-01-02T05:00:00.000Z');await search('100%_');assert.equal(await notes().locator('article').count(),1);assert.equal(await row(literal).count(),1);assert.equal(analyticsGets,reads);assert.equal(await csv(),originalCsv);
  console.log('PASS real all-day applied-zone creation, inert literal search, future all-notes access, timed text edit and unchanged analytics/CSV');

  stage='conflict and delete';await search('');await row('Timed text edit').getByRole('button',{name:'Edit annotation',exact:true}).click();await settled();const competing=await post(context,'/'+timed+'/update',{requestId:randomUUID(),revision:2,definition:{...edited.item.definition,note:'Concurrent saved text'}});assert.equal(competing.item.revision,3);await note().fill('Stale draft');await mutation(()=>editor().getByRole('button',{name:'Save annotation',exact:true}).click(),409);await notes().getByRole('alert').filter({hasText:'Review its reloaded version'}).waitFor();assert.equal(await note().inputValue(),'Concurrent saved text');await note().fill('Reviewed concurrent text');const reviewed=await submit();assert.equal(reviewed.item.revision,4);await mutation(async()=>{await row('Reviewed concurrent text').getByRole('button',{name:'Delete annotation',exact:true}).click();await page.getByRole('dialog',{name:'Delete this annotation?',exact:true}).getByRole('button',{name:'Delete annotation',exact:true}).click();});assert.equal(await stored(timed),undefined);assert.equal(analyticsGets,reads);assert.equal(await csv(),originalCsv);
  console.log('PASS real concurrent revision conflict, fresh editor reload, reviewed save and confirmed deletion');

  stage='lost acknowledgements';
  async function loseAcknowledgement(text){
    await add(text);let committed,body;
    await page.route('**'+endpoint,async route=>{assert.equal(route.request().method(),'POST');body=route.request().postData();const response=await route.fetch();assert.equal(response.status(),200);committed=await response.json();await route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic acknowledgement loss after commit"}'});},{times:1});
    await mutation(()=>editor().getByRole('button',{name:'Add annotation',exact:true}).click(),503);await notes().getByRole('alert').filter({hasText:'outcome is unknown'}).waitFor();assert.ok(committed?.item);assert.equal(await note().isDisabled(),true);assert.equal((await pool.query('SELECT count(*)::int AS n FROM analytics_annotation WHERE project_id=$1 AND note=$2',[project,text])).rows[0].n,1);return {committed,body};
  }
  const lost=await loseAcknowledgement('Committed once');let retry=page.waitForRequest(r=>new URL(r.url()).pathname===endpoint&&r.method()==='POST');const replay=await mutation(()=>button('Retry same request').click());assert.equal((await retry).postData(),lost.body);assert.equal(replay.replayed,true);assert.equal(replay.item.id,lost.committed.item.id);assert.equal((await stored(replay.item.id)).revision,1);
  const deleted=await loseAcknowledgement('Deleted before confirmation');await post(context,'/'+deleted.committed.item.id+'/delete',{requestId:randomUUID(),revision:1});retry=page.waitForRequest(r=>new URL(r.url()).pathname===endpoint&&r.method()==='POST');const tombstone=await mutation(()=>button('Retry same request').click());assert.equal((await retry).postData(),deleted.body);assert.equal(tombstone.replayed,true);assert.equal(tombstone.deleted,true);assert.equal(tombstone.item,null);await notes().getByText('The original save was confirmed, but the annotation was since deleted.',{exact:false}).waitFor();assert.equal(await stored(deleted.committed.item.id),undefined);assert.equal(await row('Deleted before confirmation').count(),0);assert.equal(analyticsGets,reads);assert.equal(await csv(),originalCsv);
  await shot('notes-desktop-1440');for(const width of [320,360]){await page.setViewportSize({width,height:950});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Notes must not overflow the mobile document');await shot('notes-mobile-'+width);}
  console.log('PASS committed-but-lost exact retries, deleted-null receipt without resurrection, immutable report/CSV and320/360px layouts');

  await context.close();stage='pagination and unavailable traffic';const secondContext=await session(second);await nav('Many note sample');await closeExplore(page);await openView(page,'explore');await (await closeExplore(page)).getByRole('button',{name:'Download CSV',exact:true}).waitFor();await apply('2026-03-08','2026-03-08','UTC',capacity);await manager();await open('Daily data');await page.getByRole('button',{name:'2026-03-08: 1005 annotations',exact:true}).waitFor();assert.equal(await notes().locator('article').count(),50);
  const actualTimeline=await(await secondContext.request.get(origin+`/api/projects/${capacity}/annotations/timeline?from=2026-03-08&to=2026-03-08&timeZone=UTC`)).json();assert.equal(actualTimeline.totalCount,1005);assert.equal(actualTimeline.days[0].previews.length,3);
  const capacityReads=analyticsGets,capacityCsv=await csv();await button('Load more notes').click();await settled();assert.equal(await notes().locator('article').count(),100);const texts=await notes().locator('article>p:nth-child(2)').allTextContents();assert.equal(new Set(texts).size,100);await search('%_');assert.equal(await notes().locator('article').count(),4);assert.equal(analyticsGets,capacityReads);assert.equal(await csv(),capacityCsv);
  await pool.query("UPDATE project SET analytics_retained_from='2026-03-09T00:00:00Z' WHERE id=$1",[capacity]);const unavailable=await apply('2026-03-08','2026-03-08','UTC',capacity);assert.equal(unavailable.coverage.status,'unavailable');assert.equal(unavailable.totals.events,null);await open('Daily data');await page.getByRole('button',{name:'2026-03-08: 1005 annotations',exact:true}).waitFor();await button('Current range').click();await search('');assert.equal(await notes().locator('article').count(),50);const unavailableCsv=await csv(),unavailableReads=analyticsGets;await page.getByRole('button',{name:'2026-03-08: 1005 annotations',exact:true}).click();await settled();assert.equal(analyticsGets,unavailableReads);assert.equal(await csv(),unavailableCsv);await shot('unavailable-traffic-authored-notes');
  console.log('PASS1005 exact notes/three previews,50-to100-row UI pagination, literal search and notes surviving unavailable traffic');

  stage='overview and current viewer role';await closeExplore(page);await openView(page,'project');await open('Custom dates');await page.getByLabel('From (UTC)',{exact:true}).fill('2026-03-08');await page.getByLabel('To (UTC)',{exact:true}).fill('2026-03-08');const overview=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/projects/${capacity}/analytics`);await page.getByRole('button',{name:'Apply',exact:true}).click();assert.equal((await(await overview).json()).coverage.status,'unavailable');await page.locator('.annotation-dates').getByRole('button',{name:'2026-03-08: 1005 annotations',exact:true}).click();await settled();assert.equal(await notes().locator('article').count(),50);await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,second]);const overviewReads=analyticsGets;await (await closeExplore(page)).getByRole('button',{name:'Reload annotations',exact:true}).click();await settled();await notes().getByText('You can read notes.',{exact:false}).waitFor();assert.equal(await button('Add annotation').count(),0);assert.equal(await button('Edit annotation').count(),0);assert.equal(analyticsGets,overviewReads);await page.setViewportSize({width:360,height:950});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('overview-viewer-unavailable-360');
  assert.deepEqual(errors,[]);assert.equal(outbound,0);await writeFile(evidence+'/result.json',JSON.stringify({status:'passed',database:db.pathname.slice(1),origin,checkedAt:new Date().toISOString(),pageErrors:errors,outboundRequests:outbound,analyticsGets},null,2)+'\n');
  console.log('PASS Overview note markers on unavailable traffic, live viewer role removes writes, no browser errors or external requests');
}catch(error){await page?.screenshot({path:evidence+'/failure.png',fullPage:true}).catch(()=>{});console.error('FAILED annotation production browser stage: '+stage);throw error;}
finally{for(const context of contexts)await context.close().catch(()=>{});await browser?.close();await closeDatabase();}
