// Opt-in production acceptance. Reuses the contained Research fixture boundary;
// no live provider, background worker, database discovery or fixture reset.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fixtureGuard,evidenceDir} from '../research-ui/guard.mjs';
import {createKeywordCase,readFixture} from '../research-ui/fixtures.mjs';
import {browserSession,providerCounts,href,assertLayout,openKeywordForm,projectSection,holdNextGet,deferred,bounded,captureFailure,accountMenu} from '../research-ui/browser.mjs';
import {runKeyword} from '../research-ui/jobs.mjs';
import {getDatabase,closeDatabase} from '../../src/server/db.ts';
import {stopJobs} from '../../src/server/jobs.ts';
import {changeRole,removeMember} from '../../src/server/teams.ts';

fixtureGuard();assert.equal(process.env.TEN98_SAVED_KEYWORDS_BROWSER,'1');
assert.ok(process.argv.length<=3,'Optional argument: one fresh lowercase/hyphen fixture suffix.');
const suffix=process.argv[2]??'first';assert.match(suffix,/^[a-z][a-z-]{0,11}$/);
const {pool}=getDatabase();
const fixture=await readFixture();let session,stage='initial';const cleanup=[];
const savedPanel=page=>page.locator('section[aria-label="Saved keywords"]');
const researchPanel=page=>page.locator('section[aria-label="Keyword research"]');
const table=page=>page.getByRole('region',{name:'Saved keyword table',exact:true});
const refresh=page=>page.locator('[aria-label="Saved metric refresh"]');
const selectedRefresh=page=>page.getByRole('region',{name:'Selected metric refresh',exact:true});
const pathFor=group=>'/api/projects/'+group.main.id+'/saved-keywords';
const matchingResponse=(path,method='POST')=>response=>new URL(response.url()).pathname===path&&response.request().method()===method;

async function phase(label){
  if(session){assert.deepEqual(session.errors,[]);assert.deepEqual(session.outbound,[]);await session.browser.close();}
  const group=await createKeywordCase('saved-'+label+'-'+suffix);session=await browserSession(group.owner);
  await session.page.goto(href(group,'keywords'),{waitUntil:'networkidle'});
  await researchPanel(session.page).getByRole('heading',{name:'Recent runs',exact:true}).waitFor();
  return {group,page:session.page,base:pathFor(group)};
}
async function openSaved(page){
  await page.getByRole('button',{name:'Saved keywords',exact:true}).click();
  await savedPanel(page).getByRole('heading',{name:/^\d[\d,]* matching keywords$/}).waitFor();
}
async function post(page,path,act,status=200){
  const response=page.waitForResponse(matchingResponse(path));await act();const result=await response;
  assert.equal(result.status(),status,'Expected the real application route contract.');return result.json();
}
async function fillManual(page,words,tags=''){
  const panel=savedPanel(page);await panel.getByRole('button',{name:'Add keywords',exact:true}).click();
  const form=panel.getByRole('form',{name:'Save keywords',exact:true});await form.getByLabel('Keywords, one per line',{exact:true}).fill(words);
  await form.getByLabel('Location code',{exact:true}).fill('2840');await form.getByLabel('Language code',{exact:true}).fill('en');
  await form.getByLabel('Tags, one per line (optional)',{exact:true}).fill(tags);return form;
}
async function manual(page,base,words,tags=''){
  const form=await fillManual(page,words,tags),result=await post(page,base,()=>form.getByRole('button',{name:'Save keywords',exact:true}).click());
  await form.waitFor({state:'hidden'});await table(page).locator('tbody tr').filter({hasText:words.split('\n')[0].trim().toLowerCase()}).waitFor();return result;
}
async function refreshQuote(page,base){
  await savedPanel(page).getByRole('button',{name:'Refresh all matching metrics',exact:true}).click();
  const result=await post(page,base+'/refresh-quote',()=>refresh(page).getByRole('button',{name:'Prepare refresh quote',exact:true}).click());
  await refresh(page).getByRole('heading',{name:'Review metric refresh',exact:true}).waitFor();return result.quote;
}
async function startRefresh(page,base,double=false){
  const button=refresh(page).getByRole('button',{name:'Start quoted refresh (paid)',exact:true});
  const result=await post(page,base+'/refreshes',()=>double?button.evaluate(element=>{element.click();element.click();}):button.click(),202);
  await selectedRefresh(page).waitFor();return result.plan;
}
async function holdList(page,path,status){
  const entered=deferred(),release=deferred();let first=true;
  const handler=async route=>{if(!first)return route.continue();first=false;const response=await route.fetch();entered.resolve();await release.promise;
    await (status?route.fulfill({status,json:{error:'Synthetic stale saved list.'}}):route.fulfill({response})).catch(()=>{});};
  await page.route('**'+path,handler);const held={entered:entered.promise,release:release.resolve,dispose:async()=>{release.resolve();await page.unroute('**'+path,handler);}};
  cleanup.push(held.dispose);return held;
}

try{
  stage='save real research rows and manual identities';{
    const {group,page,base}=await phase('core'),research=researchPanel(page),B='/api/projects/'+group.main.id+'/keyword-research';
    await openKeywordForm(research);await research.getByLabel('Keywords (one per line)',{exact:true}).fill('Saved source\nOmitted source');
    await research.getByLabel('Country or territory and language',{exact:true}).selectOption('2840|en');
    await post(page,B+'/quote',()=>research.getByRole('button',{name:'Prepare quote',exact:true}).click());
    const run=(await post(page,B+'/runs',()=>research.getByRole('button',{name:'Run quoted research (paid)',exact:true}).click(),202)).run;
    await runKeyword(run.id);await research.getByRole('button',{name:'Check status',exact:true}).click();
    await research.getByRole('region',{name:'Keyword data table',exact:true}).waitFor();
    const beforeSave=await providerCounts();await research.getByLabel('Select research keyword saved source',{exact:true}).check();
    await research.getByRole('button',{name:'Save 1 selected keywords',exact:true}).click();
    const form=savedPanel(page).getByRole('form',{name:'Save keywords',exact:true});await form.getByLabel('Tags, one per line (optional)',{exact:true}).fill('Intent High');
    const saved=await post(page,base,()=>form.getByRole('button',{name:'Save keywords',exact:true}).click());await form.waitFor({state:'hidden'});
    const source=table(page).locator('tbody tr').filter({hasText:'saved source'});await source.waitFor();
    assert.equal(await source.locator('td').nth(2).innerText(),'0');assert.equal(await source.locator('td').nth(3).innerText(),'Unavailable');
    assert.equal((await pool.query('SELECT metric_source_run_id FROM saved_keyword WHERE id=$1',[saved.ids[0]])).rows[0].metric_source_run_id,run.id);
    await manual(page,base,'Manual fixture\n=1+1\nC++\n%_literal','Intent High');
    await savedPanel(page).getByRole('heading',{name:'5 matching keywords',exact:true}).waitFor();
    assert.deepEqual(await providerCounts(),beforeSave,'Saving and reading must invoke no provider endpoint.');

    stage='bulk tags rename and safe full export';
    await savedPanel(page).getByLabel('Select manual fixture, 2840 en',{exact:true}).check();
    await savedPanel(page).getByText('Manage 1 selected keywords',{exact:true}).click();
    await savedPanel(page).getByLabel('Tag action',{exact:true}).selectOption('replace');await savedPanel(page).getByLabel('Tags, one per line',{exact:true}).fill('Reviewed');
    await post(page,base+'/bulk-tags',()=>savedPanel(page).getByRole('button',{name:'Apply tag action',exact:true}).click());
    await table(page).locator('tbody tr').filter({hasText:'manual fixture'}).getByText('Reviewed',{exact:true}).waitFor();
    await savedPanel(page).getByText('Manage project tags',{exact:true}).click();await savedPanel(page).getByRole('button',{name:'Edit Reviewed',exact:true}).click();
    await savedPanel(page).getByLabel('Tag name',{exact:true}).fill('Checked');await savedPanel(page).getByLabel('Tag color',{exact:true}).selectOption('sky');
    const tag=(await pool.query("SELECT id FROM saved_keyword_tag WHERE project_id=$1 AND normalized_name='reviewed'",[group.main.id])).rows[0];
    await post(page,base+'/tags/'+tag.id+'/update',()=>savedPanel(page).getByRole('button',{name:'Save tag',exact:true}).click());
    await table(page).locator('tbody tr').filter({hasText:'manual fixture'}).getByText('Checked',{exact:true}).waitFor();
    stage='literal phrase market tag and nullable metric filters';
    const panel=savedPanel(page),applyFilters=async(expected)=>{
      const result=await post(page,base+'/list',()=>panel.getByRole('button',{name:'Apply filters',exact:true}).click());
      assert.equal(result.total,expected);await panel.getByRole('heading',{name:expected+' matching keywords',exact:true}).waitFor();return result;
    },resetFilters=async()=>{await post(page,base+'/list',()=>panel.getByRole('button',{name:'Reset filters',exact:true}).click());await panel.getByRole('heading',{name:'5 matching keywords',exact:true}).waitFor();};
    await panel.getByLabel('Search',{exact:true}).fill('%_');assert.equal((await applyFilters(1)).rows[0].keyword,'%_literal');await resetFilters();
    await panel.getByText('More filters',{exact:true}).click();
    await panel.getByLabel('Include phrases',{exact:true}).fill('manual\nfixture');await panel.getByLabel('Exclude phrases',{exact:true}).fill('source');
    await panel.getByLabel('Location code',{exact:true}).fill('2840');await panel.getByLabel('Language code',{exact:true}).fill('en');
    assert.equal((await applyFilters(1)).rows[0].keyword,'manual fixture');await resetFilters();
    await panel.getByLabel('Min search volume',{exact:true}).fill('0');await panel.getByLabel('Max search volume',{exact:true}).fill('0');
    assert.equal((await applyFilters(1)).rows[0].keyword,'saved source');
    await panel.getByLabel('Min CPC (USD)',{exact:true}).fill('0.000000');await applyFilters(0);await resetFilters();
    await panel.getByLabel('Metric state',{exact:true}).selectOption('unavailable');await applyFilters(4);await resetFilters();
    await panel.getByLabel('Checked',{exact:true}).check();assert.equal((await applyFilters(1)).rows[0].keyword,'manual fixture');await resetFilters();
    await panel.getByText('More filters',{exact:true}).click();
    for(const format of ['csv','tsv']){
      const downloaded=page.waitForEvent('download'),response=page.waitForResponse(matchingResponse(base+'/export'));
      await savedPanel(page).getByRole('button',{name:format==='csv'?'Export all matching CSV':'Export TSV',exact:true}).click();
      const output=await response;assert.equal(output.status(),200);assert.equal(output.headers()['x-export-row-count'],'5');
      const download=await downloaded,text=await readFile(await download.path(),'utf8');
      assert.ok(text.includes("'=1+1"),'Spreadsheet formulas must be neutralized.');assert.ok(text.includes('manual fixture'));assert.ok(text.includes('Checked'));
      assert.ok(text.includes('unavailable')&&text.includes('available'));assert.ok(!text.includes('synthetic-never-live'));
    }
    assert.deepEqual(await providerCounts(),beforeSave);await assertLayout(page,'saved-keywords-core');
    await page.setViewportSize({width:360,height:860});await table(page).evaluate(el=>{el.scrollLeft=0;});await page.evaluate(()=>window.scrollTo({top:0,left:0,behavior:'instant'}));
    await page.screenshot({path:resolve(evidenceDir,'research-evidence','saved-keywords-core-360-first-columns.png'),fullPage:true});
    console.log('PASS saved research provenance, manual identities, literal/nullable filters, tag editing, safe CSV/TSV and keyboard/mobile layout.');
  }

  stage='committed manual save acknowledgement loss';{
    const {group,page,base}=await phase('save-ack');await openSaved(page);const form=await fillManual(page,'Saved acknowledgement');
    const bodies=[];let first=true;const handler=async route=>{if(route.request().method()!=='POST')return route.continue();bodies.push(route.request().postDataJSON());const response=await route.fetch();assert.equal(response.status(),200);
      if(first){first=false;return route.abort('connectionreset');}return route.fulfill({response});};
    await page.route('**'+base,handler);cleanup.push(()=>page.unroute('**'+base,handler));
    await form.getByRole('button',{name:'Save keywords',exact:true}).click();const retry=savedPanel(page).getByRole('button',{name:'Retry same request',exact:true});await retry.waitFor();
    assert.equal(await page.getByRole('button',{name:'Research',exact:true}).isDisabled(),true);
    await post(page,base,()=>retry.click());await retry.waitFor({state:'hidden'});await table(page).locator('tbody tr').filter({hasText:'saved acknowledgement'}).waitFor();
    assert.equal(bodies.length,2);assert.deepEqual(bodies[1],bodies[0]);assert.equal((await pool.query('SELECT count(*) AS n FROM saved_keyword WHERE project_id=$1',[group.main.id])).rows[0].n,'1');
    await page.unroute('**'+base,handler);console.log('PASS committed authored save retries the exact request/revision with one saved row.');
  }

  for(const fault of ['lost','changed']){
    stage='refresh '+fault+' acknowledgement, expired replay and double click';
    const {group,page,base}=await phase('refresh-'+fault);await openSaved(page);await manual(page,base,'Refresh '+fault+' target');
    const quote=await refreshQuote(page,base),bodies=[];let first=true;const before=await providerCounts();
    const handler=async route=>{
      if(route.request().method()!=='POST')return route.continue();
      bodies.push(route.request().postDataJSON());const response=await route.fetch();assert.equal(response.status(),202);const accepted=await response.json();
      if(first){first=false;for(const child of accepted.plan.children)await runKeyword(child.runId);
        // Only the browser clock advances: immutable server quote metadata stays
        // intact. Independent PG acceptance covers actual server-expired replay.
        await page.evaluate(expires=>{const now=Date.parse(expires)+1000;Date.now=()=>now;},quote.expiresAt);
        if(fault==='lost')return route.abort('connectionreset');
        const child=accepted.plan.children[0];return route.fulfill({status:202,json:{...accepted,plan:{...accepted.plan,children:[{...child,request:{...child.request,keywords:['wrong acknowledged keyword']},targetIds:[randomUUID()]}]}}});
      }
      assert.deepEqual(bodies.at(-1),bodies[0]);return route.fulfill({response});
    };
    await page.route('**'+base+'/refreshes',handler);cleanup.push(()=>page.unroute('**'+base+'/refreshes',handler));
    await refresh(page).getByRole('button',{name:'Start quoted refresh (paid)',exact:true}).evaluate(element=>{element.click();element.click();});
    const retry=refresh(page).getByRole('button',{name:'Retry same refresh request',exact:true});await retry.waitFor();assert.equal(bodies.length,1);
    assert.equal(await page.getByRole('button',{name:'Research',exact:true}).isDisabled(),true);
    const result=await post(page,base+'/refreshes',()=>retry.click(),202);assert.equal(result.plan.id,quote.id);await retry.waitFor({state:'hidden'});
    await selectedRefresh(page).getByRole('heading',{name:'Refresh completed',exact:true}).waitFor();
    assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1]);assert.equal((await pool.query('SELECT count(*) AS n FROM keyword_research_run WHERE project_id=$1',[group.main.id])).rows[0].n,'1');
    assert.equal((await providerCounts())['keyword-dispatch']-(before['keyword-dispatch']??0),1);
    await refresh(page).getByRole('button',{name:'Update keyword table',exact:true}).click();await table(page).locator('tbody tr').getByText(/^Last refresh: completed/).waitFor();
    await page.unroute('**'+base+'/refreshes',handler);
    console.log('PASS refresh '+fault+' acknowledgement preserves approved children and request key after browser-clock expiry, with one synthetic dispatch.');
  }

  stage='held status read interrupted by queued cancellation';{
    const {group,page,base}=await phase('cancel');await openSaved(page);await manual(page,base,'Cancel target');await refreshQuote(page,base);const plan=await startRefresh(page,base);
    const before=await providerCounts(),held=await holdNextGet(page,'**'+base+'/refreshes/'+plan.id);cleanup.push(held.dispose);
    await refresh(page).getByRole('button',{name:'Check refresh status',exact:true}).click();await bounded(held.entered);
    await post(page,base+'/refreshes/'+plan.id+'/cancel',()=>refresh(page).getByRole('button',{name:'Cancel undispatched requests',exact:true}).click());
    await selectedRefresh(page).getByRole('heading',{name:'Refresh cancelled',exact:true}).waitFor();held.release();await held.dispose();
    await page.waitForTimeout(100);assert.ok(await selectedRefresh(page).getByRole('heading',{name:'Refresh cancelled',exact:true}).isVisible());
    for(const child of plan.children)await runKeyword(child.runId);assert.deepEqual(await providerCounts(),before,'Cancelled queued jobs must not call the provider, including account checks.');
    assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[plan.children[0].runId])).rows[0].status,'cancelled');
    console.log('PASS held reads cannot overwrite cancellation; cancelled queued work never dispatches.');
  }

  stage='malformed nested list cannot crash';{
    const {group,page,base}=await phase('scope');await openSaved(page);await manual(page,base,'Scope secret fixture');
    let first=true;const malformed=async route=>{const response=await route.fetch();if(!first)return route.fulfill({response});first=false;const body=await response.json();
      body.rows[0].metrics={...body.rows[0].metrics,status:'available',row:{keyword:'bad',searchVolume:0,cpcUsd:null,competition:null,competitionLevel:null,keywordDifficulty:null,intent:null,metricsUpdatedAt:null,intentUpdatedAt:null,monthlySearches:[null]}};
      return route.fulfill({status:200,json:body});};
    await page.route('**'+base+'/list',malformed);cleanup.push(()=>page.unroute('**'+base+'/list',malformed));
    await savedPanel(page).getByRole('button',{name:'Reload list',exact:true}).click();await savedPanel(page).getByRole('alert').waitFor();assert.deepEqual(session.errors,[]);await page.unroute('**'+base+'/list',malformed);
    stage='A to B to A stale response isolation';
    for(const status of [undefined,401]){
      const held=await holdList(page,base+'/list',status);await savedPanel(page).getByRole('button',{name:'Reload list',exact:true}).click();await bounded(held.entered);
      await projectSection(page,group.other,'Search','Keywords');await openSaved(page);await savedPanel(page).getByRole('heading',{name:'0 matching keywords',exact:true}).waitFor();
      if(status){await projectSection(page,group.main,'Search','Keywords');await openSaved(page);await table(page).locator('tbody tr').filter({hasText:'scope secret fixture'}).waitFor();}
      held.release();await held.dispose();await page.waitForTimeout(100);
      assert.equal(await page.getByText('Synthetic stale saved list.',{exact:true}).count(),0);await accountMenu(page);assert.ok(await page.getByRole('button',{name:'Sign out',exact:true}).isVisible());await page.keyboard.press('Escape');
      if(!status){assert.equal(await table(page).count(),0);await projectSection(page,group.main,'Search','Keywords');await openSaved(page);await table(page).waitFor();}
    }
    stage='live viewer downgrade and cross-tab access removal';
    await changeRole(group.workspace.id,fixture.bootstrap.id,group.owner.id,{role:'viewer'});
    const listResponse=page.waitForResponse(matchingResponse(base+'/list'));await savedPanel(page).getByRole('button',{name:'Reload list',exact:true}).click();assert.equal((await (await listResponse).json()).role,'viewer');
    await savedPanel(page).getByRole('button',{name:'Add keywords',exact:true}).waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Research',exact:true}).click();await researchPanel(page).getByText(/Ask a workspace owner/).waitFor();assert.equal(await researchPanel(page).getByRole('button',{name:'Prepare quote',exact:true}).count(),0);
    await openSaved(page);await removeMember(group.workspace.id,fixture.bootstrap.id,group.owner.id);
    await savedPanel(page).getByRole('button',{name:'Reload list',exact:true}).click();await savedPanel(page).getByRole('alert').waitFor();await table(page).waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Research',exact:true}).click();await researchPanel(page).getByRole('alert').waitFor();
    assert.equal(await page.getByText('scope secret fixture',{exact:true}).count(),0);
    console.log('PASS malformed nested data, stale project responses, viewer gates and cross-tab purge after actual membership removal.');
  }
  assert.deepEqual(session.errors,[]);assert.deepEqual(session.outbound,[]);
}catch(error){await captureFailure(session?.page,error,stage).catch(()=>{});console.error('FAIL saved keyword UI stage: '+stage+' ('+(error?.name??'Error')+'). Details saved privately.');process.exitCode=1;}
finally{for(const fn of cleanup)await fn().catch(()=>{});await session?.browser.close();await stopJobs();await closeDatabase();}
