// Opt-in production-browser acceptance. The web process must use the strict synthetic preload.
import assert from 'node:assert/strict';
import {readFixture,createPromptCase} from './fixtures.mjs';
import {fixtureGuard} from './guard.mjs';
import {browserSession,providerCounts,href,assertLayout,loseFirstPost,holdNextGet,bounded,projectSection,captureFailure,accountMenu} from './browser.mjs';
import {runPrompt} from './jobs.mjs';
import {getDatabase,closeDatabase} from '../../src/server/db.ts';
import {stopJobs} from '../../src/server/jobs.ts';
fixtureGuard();

const args=process.argv.slice(2),lifecycleOnly=args.length===2&&args[0]==='--lifecycle-only'&&/^[a-z][a-z-]{0,19}$/.test(args[1]);
assert.ok(args.length===0||lifecycleOnly,'Optional arguments: --lifecycle-only NEW-LOWERCASE-LABEL (maximum 20 letters/hyphens).');
const phaseLabel=label=>label+(lifecycleOnly?'-'+args[1]:'');
const {pool}=getDatabase();let session,stage='initial';const cleanup=[];
const execution=page=>page.locator('section[aria-label="Prompt execution"]');
const library=page=>page.locator('section[aria-label="Prompt library"]');
async function begin(group){await session?.browser.close();session=await browserSession(group.owner);await session.page.goto(href(group,'prompts'),{waitUntil:'networkidle'});await library(session.page).getByRole('button',{name:'Recent runs',exact:true}).waitFor();return session.page;}
async function filter(page,text,status='active'){
  const lib=library(page);await lib.getByLabel('Text contains',{exact:true}).fill(text);await lib.getByLabel('Status',{exact:true}).selectOption(status);
  const response=page.waitForResponse(response=>response.url().includes('/prompts?')&&response.request().method()==='GET');await lib.getByRole('button',{name:'Apply filters',exact:true}).click();await response;
  await lib.getByRole('button',{name:'Apply filters',exact:true}).waitFor({state:'visible'});
}
async function review(page,prompt){await page.locator('#pl-run-'+prompt.id).click();await execution(page).getByRole('heading',{name:'Review a prompt run',exact:true}).waitFor();}
async function prepare(page,group,{both=false,system='',fresh=false}={}){
  const panel=execution(page);await panel.getByLabel('OpenRouter connection',{exact:true}).selectOption(group.connections.openrouter);
  // Models start unselected; the free catalog refresh is needed once per web process (synthetic in provider.mjs).
  if(await panel.getByText('Model list unavailable',{exact:true}).count())await panel.getByRole('button',{name:'Refresh model list',exact:true}).click();
  const choice=id=>panel.getByRole('region',{name:'Model catalog choices',exact:true}).getByRole('checkbox',{name:new RegExp('· '+id+'$')});
  await choice('openai/gpt-4o-mini').check();if(both)await choice('openai/gpt-4o').check();
  if(fresh)await panel.getByLabel('Answer source',{exact:true}).selectOption('fresh');
  if(system){await panel.getByText('Optional system message',{exact:true}).click();await panel.getByLabel('System message',{exact:true}).fill(system);}
  await panel.getByRole('checkbox',{name:'This connection uses OpenRouter funded credits.',exact:true}).check();
  const response=page.waitForResponse(response=>response.url().endsWith('/prompt-executions/quote')&&response.request().method()==='POST');
  await panel.getByRole('button',{name:'Get quote',exact:true}).click();const result=await (await response).json();
  await panel.getByRole('heading',{name:'Review before spending',exact:true}).waitFor();return result.quote;
}
async function start(page,n=1){const panel=execution(page),response=page.waitForResponse(response=>response.url().endsWith('/prompt-executions/comparisons')&&response.request().method()==='POST');
  await panel.getByRole('button',{name:'Start '+n+' paid '+(n===1?'request':'requests'),exact:true}).click();const received=await response;assert.equal(received.status(),202);const result=await received.json();await panel.getByRole('heading',{name:'Prompt run',exact:true}).waitFor();return result.comparison;}
async function back(page){await execution(page).getByRole('button',{name:'Back to saved prompts',exact:true}).click();await library(page).getByRole('button',{name:'Recent runs',exact:true}).waitFor();}
// One "not sent" line per run card (the run cost summary repeats it as its status reason).
const notSent=page=>execution(page).locator('article > p').filter({hasText:/^This request was not sent\.$/});
function browserClean(){assert.deepEqual(session.errors,[]);assert.deepEqual(session.outbound,[]);}

try{
  if(!lifecycleOnly){
  const group=(await readFixture()).groups.prompt,page=await begin(group),B='/api/projects/'+group.main.id+'/prompt-executions';
  assert.equal((await pool.query('SELECT count(*) AS n FROM prompt_comparison WHERE project_id=$1',[group.main.id])).rows[0].n,'0','Core prompt group must be unused.');
  const initial=await providerCounts();
  stage='parent pagination/filter/focus and disabled saved version';
  await library(page).getByRole('button',{name:'Load more prompts',exact:true}).click();
  await page.locator('#pl-run-'+group.prompts.disabled.id).waitFor();
  const rowCount=await library(page).getByRole('region',{name:'Prompt library table',exact:true}).locator('tbody > tr').count();assert.equal(rowCount,54);
  await review(page,group.prompts.disabled);assert.equal(await execution(page).getByLabel('Maximum output tokens',{exact:true}).inputValue(),'1024');
  assert.equal(await execution(page).getByRole('checkbox',{name:'This connection uses OpenRouter funded credits.',exact:true}).isChecked(),false);
  await back(page);assert.equal(await library(page).getByRole('region',{name:'Prompt library table',exact:true}).locator('tbody > tr').count(),54);
  await page.waitForFunction(id=>document.activeElement?.id===id,'pl-run-'+group.prompts.disabled.id);
  await filter(page,'Synthetic disabled');await review(page,group.prompts.disabled);await back(page);
  assert.equal(await library(page).getByLabel('Text contains',{exact:true}).inputValue(),'Synthetic disabled');
  await page.waitForFunction(id=>document.activeElement?.id===id,'pl-run-'+group.prompts.disabled.id);
  assert.deepEqual(await providerCounts(),initial,'Parent inspection and review never call a provider.');

  stage='dirty draft discard and archived/historical version boundaries';
  const disabledRow=library(page).getByRole('row').filter({has:page.getByText(group.prompts.disabled.text,{exact:true})});await disabledRow.getByRole('button',{name:'Edit',exact:true}).click();
  await library(page).getByLabel('Prompt text',{exact:true}).fill('Unsaved draft must not execute');
  page.once('dialog',dialog=>dialog.dismiss());await disabledRow.getByRole('button',{name:'Review a run',exact:true}).click();assert.equal(await execution(page).count(),0);assert.equal(await library(page).getByLabel('Prompt text',{exact:true}).inputValue(),'Unsaved draft must not execute');
  page.once('dialog',dialog=>dialog.accept());await disabledRow.getByRole('button',{name:'Review a run',exact:true}).click();await execution(page).getByText(group.prompts.disabled.text,{exact:true}).waitFor();assert.equal(await execution(page).getByText('Unsaved draft must not execute',{exact:true}).count(),0);await back(page);
  await filter(page,'','archived');const archivedRow=library(page).getByRole('row').filter({has:page.getByText(group.prompts.archived.text,{exact:true})});await archivedRow.getByRole('button',{name:'View versions',exact:true}).click();
  await library(page).getByRole('heading',{name:/^Version history/}).waitFor();assert.equal(await library(page).getByRole('button',{name:'Review a run',exact:true}).count(),0);assert.equal(await library(page).getByRole('button',{name:'Review this version',exact:true}).count(),0);
  await library(page).getByRole('button',{name:'Close',exact:true}).click();await filter(page,'Synthetic disabled');
  await disabledRow.getByRole('button',{name:'View versions',exact:true}).click();await page.locator('#pl-version-run-'+group.prompts.original.currentVersionId).click();
  await execution(page).getByText(group.prompts.original.text,{exact:true}).waitFor();browserClean();
  console.log('PASS prompt parent pagination/filter/focus, disabled versus archived, explicit dirty discard and immutable history entry.');

  stage='two-model exact quote and real synthetic answer settlement';const system='  Explicit fixture system text\n';
  const quote=await prepare(page,group,{both:true,system});assert.equal(quote.input.maxCompletionTokens,1024);assert.equal(quote.input.versionId,group.prompts.original.currentVersionId);
  assert.deepEqual(quote.messages,[{role:'system',content:system},{role:'user',content:group.prompts.original.text}]);assert.equal((await providerCounts())['prompt-dispatch']??0,initial['prompt-dispatch']??0);
  const comparison=await start(page,2);await runPrompt(comparison.id);await execution(page).getByRole('button',{name:'Refresh status',exact:true}).click();
  for(const model of ['GPT-4o-mini','GPT-4o'])await execution(page).getByRole('region',{name:'Answer from '+model,exact:true}).waitFor();
  assert.equal(await execution(page).locator('script,img,iframe').count(),0);assert.equal(await page.evaluate(()=>window.syntheticUnsafe),undefined);
  assert.match(await execution(page).innerText(),/Settled price\s+USD 0\.000013/);
  for(const details of await execution(page).locator('details').filter({has:page.getByText('Reported citations (1)',{exact:true})}).all())await details.locator('summary').click();
  assert.equal(await execution(page).locator('a[href^="https://citation.example.com/"]').count(),2);
  for(const link of await execution(page).locator('a[href^="https://citation.example.com/"]').all()){assert.equal(await link.getAttribute('rel'),'noopener noreferrer');assert.equal(await link.getAttribute('target'),'_blank');}
  assert.equal((await providerCounts())['prompt-dispatch']-(initial['prompt-dispatch']??0),2);await assertLayout(page,'prompt-two-model');browserClean();
  console.log('PASS historical exact messages/two-model quote, explicit dispatch, plain text/citations, exact charges and360px answer cards.');

  stage='failed detail refresh preserves visibly stale answer';const detailPath='**'+B+'/comparisons/'+comparison.id+'/summary';
  const unavailable=route=>route.fulfill({status:503,json:{error:'Synthetic saved-status refresh unavailable.'}});await page.route(detailPath,unavailable);
  await execution(page).getByRole('button',{name:'Refresh status',exact:true}).click();await execution(page).getByRole('alert').waitFor();
  assert.equal(await execution(page).getByRole('region',{name:/^Answer from/}).count(),2);await page.unroute(detailPath,unavailable);

  stage='raw result and copied input expiry retains authored preview';
  await pool.query('UPDATE prompt_execution SET result=NULL,result_purged_at=clock_timestamp() WHERE comparison_id=$1',[comparison.id]);
  await pool.query('UPDATE prompt_execution_quote SET input=NULL,messages=NULL,input_purged_at=clock_timestamp() WHERE id=$1',[comparison.quoteId]);
  await execution(page).getByRole('button',{name:'Refresh status',exact:true}).click();await execution(page).getByText(/Copied execution input expired/).waitFor();
  assert.equal(await execution(page).getByRole('region',{name:/^Answer from/}).count(),0);assert.equal(await execution(page).getByText('Answer and citations expired under workspace retention.',{exact:true}).count(),2);
  assert.ok(await execution(page).getByText(group.prompts.original.text,{exact:true}).isVisible());assert.match(await execution(page).innerText(),/Settled price\s+USD 0\.000013/);

  stage='SPA project race and live viewer purge';const held=await holdNextGet(page,'**'+B+'/comparisons/'+comparison.id+'/summary',{status:401});cleanup.push(held.dispose);
  await execution(page).getByRole('button',{name:'Refresh status',exact:true}).click();await bounded(held.entered);
  await projectSection(page,group.other,'AI visibility','Prompts');await library(page).getByRole('button',{name:'Recent runs',exact:true}).click();await execution(page).getByText(/No prompt runs yet/).waitFor();
  await projectSection(page,group.main,'AI visibility','Prompts');await library(page).getByRole('button',{name:'Recent runs',exact:true}).click();await execution(page).getByRole('region',{name:'Recent prompt runs',exact:true}).waitFor();held.release();await held.dispose();
  await accountMenu(page);assert.ok(await page.getByRole('button',{name:'Sign out',exact:true}).isVisible());
  await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[group.workspace.id,group.owner.id]);
  await execution(page).getByRole('button',{name:'Refresh',exact:true}).click();await back(page);
  assert.equal(await library(page).getByRole('button',{name:'Review a run',exact:true}).count(),0);browserClean();
  await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[group.workspace.id,group.owner.id]);
  console.log('PASS prompt receipt-only expiry, preserved authored preview, SPA stale-session response and live viewer parent gating.');
  }

  stage='lost503/malformed acknowledged starts through expiry';{
    const g=await createPromptCase(phaseLabel('ack')),p=await begin(g),base='/api/projects/'+g.main.id+'/prompt-executions';await p.clock.install();
    for(const failure of ['disconnect','503','malformed']){
      await review(p,g.prompts.disabled);await prepare(p,g,{fresh:true});// Each fault needs a new paid start, not a reuse of the previous iteration's answer.
      const fault=await loseFirstPost(p,'**'+base+'/comparisons',{failure,onCommitted:async(body,accepted)=>{await runPrompt(accepted.comparison.id);await pool.query("UPDATE prompt_execution_quote SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[body.quoteId]);}});cleanup.push(fault.dispose);
      await execution(p).getByRole('button',{name:'Start 1 paid request',exact:true}).evaluate(element=>{element.click();element.click();});await execution(p).getByRole('button',{name:'Retry same start request',exact:true}).waitFor();assert.equal(fault.bodies.length,1);
      await p.clock.setSystemTime(new Date(Date.now()+360_000));await p.waitForTimeout(1100);
      const retry=execution(p).getByRole('button',{name:'Retry same start request',exact:true}),retried=p.waitForResponse(r=>r.url().endsWith(base+'/comparisons')&&r.request().method()==='POST');
      await retry.click();const response=await retried;assert.equal(response.status(),202);assert.equal((await response.json()).comparison.quoteId,fault.bodies[0].quoteId);
      await retry.waitFor({state:'hidden'});await execution(p).getByRole('heading',{name:'Prompt run',exact:true}).waitFor();await execution(p).getByRole('region',{name:'Answer from GPT-4o-mini',exact:true}).waitFor();
      assert.equal(fault.bodies.length,2);assert.deepEqual(fault.bodies[0],fault.bodies[1]);assert.equal((await pool.query('SELECT count(*) AS n FROM prompt_comparison WHERE quote_id=$1',[fault.bodies[0].quoteId])).rows[0].n,'1');await fault.dispose();await p.clock.setSystemTime(new Date());await back(p);browserClean();
    }
    console.log('PASS dropped/503/malformed committed prompt starts and double clicks recover identical intent after browser and server expiry.');
  }

  stage='held poll stop remaining without dispatch';{
    const g=await createPromptCase(phaseLabel('cancel')),p=await begin(g),base='/api/projects/'+g.main.id+'/prompt-executions';await review(p,g.prompts.disabled);await prepare(p,g,{both:true});const before=await providerCounts(),c=await start(p,2);
    const held=await holdNextGet(p,'**'+base+'/comparisons/'+c.id+'/summary');cleanup.push(held.dispose);await bounded(held.entered,12_000);
    const stop=execution(p).getByRole('button',{name:'Stop remaining requests',exact:true});assert.equal(await stop.isEnabled(),true);await stop.click();
    await notSent(p).first().waitFor();held.release();await held.dispose();await p.waitForTimeout(200);
    assert.equal(await notSent(p).count(),2);assert.equal((await providerCounts())['prompt-dispatch']??0,before['prompt-dispatch']??0);
    assert.deepEqual((await pool.query('SELECT status FROM prompt_execution WHERE comparison_id=$1',[c.id])).rows.map(r=>r.status),['cancelled','cancelled']);await runPrompt(c.id);browserClean();
    console.log('PASS a real stop action interrupts stale poll and cancels both undispatched model requests without charge dispatch.');
  }

  stage='current403 clears unused quote then recovers setup';{
    const g=await createPromptCase(phaseLabel('access')),p=await begin(g),base='/api/projects/'+g.main.id+'/prompt-executions';await review(p,g.prompts.disabled);await prepare(p,g);
    const denied=route=>route.fulfill({status:403,json:{error:'Synthetic current access lost.'}});await p.route('**'+base,denied);
    await execution(p).getByRole('button',{name:'Start 1 paid request',exact:true}).click();await execution(p).getByRole('heading',{name:'Access unavailable',exact:true}).waitFor();
    assert.equal(await execution(p).getByRole('heading',{name:'Exact request',exact:true}).count(),0);assert.equal(await execution(p).getByRole('button',{name:'Start 1 paid request',exact:true}).count(),0);
    assert.equal((await pool.query('SELECT count(*) AS n FROM prompt_comparison WHERE project_id=$1',[g.main.id])).rows[0].n,'0');
    await p.unroute('**'+base,denied);await execution(p).getByRole('button',{name:'Reload access',exact:true}).click();await execution(p).getByRole('heading',{name:'Review a prompt run',exact:true}).waitFor();
    assert.equal(await execution(p).getByRole('checkbox',{name:'This connection uses OpenRouter funded credits.',exact:true}).isChecked(),false);browserClean();
    console.log('PASS current403 purges the unused quote and deliberate access reload restores a fresh setup without paid intent.');
  }

  stage='owner reconciliation and empty answer are distinct';{
    const g=await createPromptCase(phaseLabel('receipt')),p=await begin(g);await review(p,g.prompts.disabled);await prepare(p,g);const before=await providerCounts(),c=await start(p);
    await runPrompt(c.id,'receipt-only');await execution(p).getByRole('button',{name:'Refresh status',exact:true}).click();await execution(p).getByRole('button',{name:'Check charge receipt',exact:true}).click();
    await execution(p).getByText('Only the charge was recovered. A new answer needs a fresh paid quote.',{exact:true}).waitFor();assert.match(await execution(p).innerText(),/Settled price\s+USD 0\.000013/);
    // Owner decision D3: charge reconciliation never pauses the workspace.
    assert.equal((await pool.query('SELECT paused FROM workspace_budget WHERE workspace_id=$1',[g.workspace.id])).rows[0].paused,false);assert.equal((await providerCounts())['prompt-dispatch']-(before['prompt-dispatch']??0),1);browserClean();
    const empty=await createPromptCase(phaseLabel('empty')),ep=await begin(empty);await review(ep,empty.prompts.disabled);await prepare(ep,empty);const ec=await start(ep);await runPrompt(ec.id,'empty');await execution(ep).getByRole('button',{name:'Refresh status',exact:true}).click();
    await execution(ep).getByText('Provider returned an empty answer.',{exact:true}).waitFor();assert.equal(await execution(ep).getByText('No supported answer is available. A failed request may still be charged.',{exact:true}).count(),0);browserClean();
    console.log('PASS known generation reconciliation leaves spending unpaused (D3) with no invented answer and an observed empty answer is labelled separately.');
  }
}catch(error){await captureFailure(session?.page,error,stage).catch(()=>{});console.error('FAIL prompt UI stage: '+stage+' ('+(error?.name??'Error')+'). Details saved privately.');process.exitCode=1;}
finally{for(const close of cleanup)await close().catch(()=>{});await session?.browser.close();await stopJobs();await closeDatabase();}
