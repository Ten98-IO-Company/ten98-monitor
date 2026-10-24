// Opt-in production-browser acceptance using only the synthetic fixture boundary.
import assert from 'node:assert/strict';
import {readFixture,createKeywordCase} from './fixtures.mjs';
import {fixtureGuard} from './guard.mjs';
import {browserSession,providerCounts,href,assertLayout,loseFirstPost,holdNextGet,bounded,projectSection,captureFailure,selectedKeywordFocus,openKeywordForm,accountMenu} from './browser.mjs';
import {runKeyword} from './jobs.mjs';
import {getDatabase,closeDatabase} from '../../src/server/db.ts';
import {stopJobs} from '../../src/server/jobs.ts';
fixtureGuard();

assert.ok(process.argv.length<=3,'Optional argument: a fresh lowercase-hyphen core fixture label.');
const group=process.argv[2]?await createKeywordCase(process.argv[2]):(await readFixture()).groups.keyword,{pool}=getDatabase();
let session,stage='initial',held;
const B='/api/projects/'+group.main.id+'/keyword-research';
try{
  assert.equal((await pool.query('SELECT count(*) AS n FROM keyword_research_run WHERE project_id=$1',[group.main.id])).rows[0].n,'0','This acceptance runner needs its unused seeded keyword group.');
  session=await browserSession(group.owner);const {page}=session;
  const initialCounts=await providerCounts();
  await page.goto(href(group,'keywords'),{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'Keyword research',exact:true}).last().waitFor();
  const panel=page.locator('section[aria-label="Keyword research"]');
  assert.deepEqual(await providerCounts(),initialCounts,'Opening the panel must cause no provider calls.');
  assert.ok(await panel.getByRole('link',{name:'Connections',exact:true}).isVisible());
  const quote=async(text,marketKey='2840|en')=>{
    await openKeywordForm(panel);
    await panel.getByLabel('Keywords (one per line)',{exact:true}).fill(text);
    await panel.getByLabel('Country or territory and language',{exact:true}).selectOption(marketKey);
    await panel.getByRole('button',{name:'Prepare quote',exact:true}).click();
    await panel.getByRole('heading',{name:'Quote for keyword overview',exact:true}).waitFor();
  };
  stage='real quote/start/manual synthetic dispatch';await quote(' Example \nEXAMPLE\nOmitted fixture');
  assert.ok((await panel.innerText()).includes('2 unique keywords'));
  assert.equal((await providerCounts())['keyword-dispatch']??0,initialCounts['keyword-dispatch']??0);
  const started=page.waitForResponse(response=>response.url().endsWith(B+'/runs')&&response.request().method()==='POST');
  await panel.getByRole('button',{name:'Run quoted research (paid)',exact:true}).click();
  const first=(await (await started).json()).run;assert.equal(first.status,'queued');await selectedKeywordFocus(page,panel);
  await runKeyword(first.id);
  await panel.getByRole('button',{name:'Check status',exact:true}).click();
  const table=panel.getByRole('region',{name:'Keyword data table',exact:true});await table.waitFor();
  const cells=await table.locator('tbody > tr').first().locator(':scope > td:not(:has(input[type=checkbox]))').allTextContents();
  assert.equal(cells[1],'0');assert.equal(cells[2],'Unavailable');assert.match(await panel.innerText(),/No data returned.*omitted fixture/);
  assert.match(await panel.innerText(),/DataForSEO Labs \/ Google/);assert.match(await panel.innerText(),/\$0\.012120/);
  await assertLayout(page,'keyword-result');console.log('PASS keyword free quote, explicit paid intent, one synthetic dispatch, exact charge/null metrics and responsive results.');

  stage='committed acknowledgement loss and expired retry';await quote('Lost acknowledgement fixture');
  const lost=await loseFirstPost(page,'**'+B+'/runs',{onCommitted:async(body,accepted)=>{
    await runKeyword(accepted.run.id);
    await pool.query("UPDATE keyword_quote SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[body.quoteId]);
  }});
  await panel.getByRole('button',{name:'Run quoted research (paid)',exact:true}).click();await panel.getByRole('button',{name:'Retry same request',exact:true}).waitFor();
  assert.equal(await panel.getByLabel('Keywords (one per line)',{exact:true}).isDisabled(),true);
  assert.equal((await pool.query('SELECT count(*) AS n FROM keyword_research_run WHERE project_id=$1',[group.main.id])).rows[0].n,'2');
  const retry=panel.getByRole('button',{name:'Retry same request',exact:true});
  const retried=page.waitForResponse(response=>response.url().endsWith(B+'/runs')&&response.request().method()==='POST');
  await retry.click();const acceptedRetry=await retried;assert.equal(acceptedRetry.status(),202);
  const retriedRun=(await acceptedRetry.json()).run;assert.deepEqual(retriedRun.request.keywords,['lost acknowledgement fixture']);
  await retry.waitFor({state:'hidden'});await table.locator(':scope > table > tbody > tr').filter({hasText:'lost acknowledgement fixture'}).waitFor();
  assert.equal(lost.bodies.length,2);assert.deepEqual(lost.bodies[0],lost.bodies[1]);await lost.dispose();
  assert.equal((await pool.query('SELECT count(*) AS n FROM keyword_research_run WHERE project_id=$1',[group.main.id])).rows[0].n,'2');
  assert.equal((await providerCounts())['keyword-dispatch']-(initialCounts['keyword-dispatch']??0),2);
  console.log('PASS dropped committed start retries identical quote/key after server quote expiry with exactly one receipt/dispatch.');

  stage='expired result is receipt-only';const second=(await pool.query('SELECT id FROM keyword_research_run WHERE project_id=$1 AND id<>$2',[group.main.id,first.id])).rows[0];
  await pool.query('UPDATE keyword_research_run SET result=NULL,result_purged_at=clock_timestamp() WHERE id=$1',[second.id]);
  await panel.getByRole('button',{name:'Check status',exact:true}).click();await panel.getByText(/saved result for this run was purged/).waitFor();assert.equal(await table.count(),0);

  stage='delayed prior project cannot overwrite new scope';held=await holdNextGet(page,'**'+B);
  await panel.getByRole('button',{name:'Reload access',exact:true}).click();await bounded(held.entered);
  await projectSection(page,group.other,'Search','Keywords');await page.getByText('No research runs have been saved for this project.',{exact:true}).waitFor();held.release();await held.dispose();held=null;
  assert.equal(await page.getByText(/saved result for this run was purged/).count(),0);
  assert.equal(await page.getByRole('region',{name:'Keyword data table',exact:true}).count(),0);

  stage='A to B to A ignores old session/error responses';await projectSection(page,group.main,'Search','Keywords');
  for(const status of [401,503]){
    await panel.getByRole('heading',{name:'Recent runs',exact:true}).waitFor();held=await holdNextGet(page,'**'+B,{status});
    await panel.getByRole('button',{name:'Reload access',exact:true}).click();await bounded(held.entered);
    await projectSection(page,group.other,'Search','Keywords');await page.getByText('No research runs have been saved for this project.',{exact:true}).waitFor();
    await projectSection(page,group.main,'Search','Keywords');await panel.getByRole('heading',{name:'Recent runs',exact:true}).waitFor();
    held.release();await held.dispose();held=null;await page.waitForTimeout(150);
    await accountMenu(page);
    assert.ok(await page.getByRole('button',{name:'Sign out',exact:true}).isVisible());assert.equal(await page.getByText('Your session expired. Sign in again.',{exact:true}).count(),0);
    assert.equal(await page.getByText('Synthetic stale response.',{exact:true}).count(),0);
  }
  stage='Region market selection retains exact quote and result scope';
  const regionCounts=await providerCounts();
  for(const [label,locationCode,languageCode,locationName] of [['region-taiwan',2158,'zh-TW','Taiwan'],['region-hong-kong-english',2344,'en','Hong Kong'],['region-hong-kong-chinese',2344,'zh-TW','Hong Kong']]){
    const regionGroup=await createKeywordCase(label),regionSession=await browserSession(regionGroup.owner);
    try{
      const {page}=regionSession,B='/api/projects/'+regionGroup.main.id+'/keyword-research';
      await page.goto(href(regionGroup,'keywords'),{waitUntil:'networkidle'});
      const panel=page.locator('section[aria-label="Keyword research"]'),table=panel.getByRole('region',{name:'Keyword data table',exact:true});
      await panel.getByRole('heading',{name:'Recent runs',exact:true}).waitFor();
      const quoted=page.waitForResponse(response=>response.url().endsWith(B+'/quote')&&response.request().method()==='POST');
      await openKeywordForm(panel);await panel.getByLabel('Keywords (one per line)',{exact:true}).fill('Region '+locationCode+' '+languageCode);
      await panel.getByLabel('Country or territory and language',{exact:true}).selectOption(locationCode+'|'+languageCode);
      await panel.getByRole('button',{name:'Prepare quote',exact:true}).click();await panel.getByRole('heading',{name:'Quote for keyword overview',exact:true}).waitFor();
      const quoteResponse=await quoted;assert.equal(quoteResponse.status(),200);const quoteBody=(await quoteResponse.json()).quote;
      assert.equal(quoteResponse.request().postDataJSON().locationCode,locationCode);assert.equal(quoteResponse.request().postDataJSON().languageCode,languageCode);
      assert.equal(quoteBody.request.locationCode,locationCode);assert.equal(quoteBody.request.languageCode,languageCode);assert.ok((await panel.innerText()).includes(locationName));
      const startedRegion=page.waitForResponse(response=>response.url().endsWith(B+'/runs')&&response.request().method()==='POST');
      await panel.getByRole('button',{name:'Run quoted research (paid)',exact:true}).click();const acceptedRegion=await startedRegion;assert.equal(acceptedRegion.status(),202);const regionRun=(await acceptedRegion.json()).run;await selectedKeywordFocus(page,panel);await runKeyword(regionRun.id);
      const finished=page.waitForResponse(response=>response.url().endsWith(B+'/runs/'+regionRun.id)&&response.request().method()==='GET');
      await panel.getByRole('button',{name:'Check status',exact:true}).click();const saved=(await (await finished).json()).run;
      assert.equal(saved.status,'completed');assert.equal(saved.request.locationCode,locationCode);assert.equal(saved.request.languageCode,languageCode);assert.equal(saved.result.rows[0].keyword,quoteBody.request.keywords[0]);
      await table.locator(':scope > table > tbody > tr').filter({hasText:saved.result.rows[0].keyword}).waitFor();
      assert.deepEqual(regionSession.errors,[]);assert.deepEqual(regionSession.outbound,[]);
    }finally{await regionSession.browser.close();}
  }
  assert.equal((await providerCounts())['keyword-dispatch']-(regionCounts['keyword-dispatch']??0),3);
  console.log('PASS Taiwan and Hong Kong Region selections retain exact language and location through quote, synthetic dispatch and displayed results.');
  stage='actual live-role downgrade removes writes';
  await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[group.workspace.id,group.owner.id]);
  await panel.getByRole('button',{name:'Reload access',exact:true}).click();await panel.getByText(/Ask a workspace owner/).waitFor();
  assert.equal(await panel.getByRole('button',{name:'Prepare quote',exact:true}).count(),0);assert.equal(await panel.getByRole('link',{name:'Connections',exact:true}).count(),0);
  assert.ok(await panel.getByRole('heading',{name:'Recent runs',exact:true}).isVisible());
  assert.deepEqual(session.errors,[]);assert.deepEqual(session.outbound,[]);
  console.log('PASS keyword expiry distinction, stale project response isolation and live viewer role gating.');
}catch(error){await captureFailure(session?.page,error,stage).catch(()=>{});console.error('FAIL keyword UI stage: '+stage+' ('+(error?.name??'Error')+'). Details saved privately.');process.exitCode=1;}
finally{
  await held?.dispose();
  await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[group.workspace.id,group.owner.id]).catch(()=>{});
  await session?.browser.close();await stopJobs();await closeDatabase();
}
