// Real audit routes and receipts; only the native crawler transport is synthetic.
import assert from 'node:assert/strict';
import {readFixture,createKeywordCase,createAuditCase} from './fixtures.mjs';
import {fixtureGuard} from './guard.mjs';
import {browserSession,providerCounts,href,assertLayout,loseFirstPost,holdNextGet,bounded,deferred,projectSection,captureFailure,accountMenu} from './browser.mjs';
import {runAudit} from './jobs.mjs';
import {getDatabase,closeDatabase} from '../../src/server/db.ts';
import {stopJobs} from '../../src/server/jobs.ts';

fixtureGuard();
const args=process.argv.slice(2);assert.ok(args.length===0||args.length===1&&/^[a-z][a-z-]{0,19}$/.test(args[0]),'Optional argument: a fresh lowercase/hyphen audit suffix, maximum 20 characters.');
const phaseLabel=label=>label+(args.length?'-'+args[0]:'');
const {pool}=getDatabase();let session,stage='initial';const cleanups=[];
const panel=page=>page.locator('section[aria-label="Site audits"]');
async function begin(group){
  await session?.browser.close();session=await browserSession(group.owner);const page=session.page;
  await page.goto(href(group,'audits'),{waitUntil:'networkidle'});await panel(page).getByRole('heading',{name:'Audit history',exact:true}).waitFor();
  await panel(page).getByLabel('Domain',{exact:true}).waitFor();return page;
}
async function start(page,B){
  const response=page.waitForResponse(r=>r.url().endsWith(B)&&r.request().method()==='POST');
  await panel(page).getByRole('button',{name:/^(Start|Queue) audit$/}).click();const received=await response;assert.equal(received.status(),202);
  const body=await received.json();await panel(page).getByRole('button',{name:'Refresh status',exact:true}).waitFor();return body.run;
}
async function back(page){await panel(page).getByRole('button',{name:'← Back to audits',exact:true}).click();await panel(page).getByRole('heading',{name:'Audit history',exact:true}).waitFor();}
async function openForm(page){const disclosure=panel(page).locator('details').filter({has:page.locator('summary').filter({hasText:'Start another audit'})});if(await disclosure.count()&&(await disclosure.getAttribute('open'))===null)await disclosure.locator('summary').first().click();}
function cleanBrowser(){assert.deepEqual(session.errors,[]);assert.deepEqual(session.outbound,[]);}

try{
  const group=args.length?await createAuditCase(args[0]):(await readFixture()).groups.audit,page=await begin(group),B='/api/projects/'+group.main.id+'/audits',p=panel(page);
  assert.equal((await pool.query('SELECT count(*) AS n FROM site_audit_run WHERE project_id=$1',[group.main.id])).rows[0].n,'0','Audit core group must be unused.');
  const before=await providerCounts();
  stage='eligible scope and explicit queue-only start';
  const options=await p.getByLabel('Domain',{exact:true}).locator('option').allTextContents();
  assert.ok(options.some(s=>s.includes(group.main.origin)&&s.includes('Project origin')));
  assert.ok(options.some(s=>s.includes(group.domains.serving.hostname)&&s.includes('Verified serving domain')));
  assert.ok(options.every(s=>!s.includes(group.domains.redirect_alias.hostname)));
  assert.match(await p.innerText(),/The audit service is unavailable\./);assert.equal(await p.getByLabel('Maximum HTML pages',{exact:true}).inputValue(),'50');
  let starts=0;const countStarts=route=>{if(route.request().method()==='POST')starts++;return route.continue();};await page.route('**'+B,countStarts);
  await p.getByLabel('Start path',{exact:true}).fill('/?excluded=value');await p.getByRole('button',{name:'Queue audit',exact:true}).click();await p.getByRole('alert').waitFor();assert.equal(starts,0);
  await p.getByLabel('Start path',{exact:true}).fill('/');const run=await start(page,B);await page.unroute('**'+B,countStarts);
  assert.equal(starts,1);assert.equal(run.status,'queued');assert.equal(run.progress.requests,0);assert.equal(run.summary,null);assert.deepEqual(await providerCounts(),before);
  assert.match(await p.innerText(),/Summary not produced/);

  stage='actual contained crawl, observed findings and page evidence';
  const observed=await runAudit(run.id);assert.ok(observed.requests.includes('/missing'));assert.ok(!observed.requests.includes('/private'));
  await p.getByRole('button',{name:'Refresh status',exact:true}).click();await p.getByRole('region',{name:'Audit findings',exact:true}).waitFor();
  assert.match(await p.innerText(),/Coverage is incomplete/);assert.equal((await pool.query('SELECT status FROM site_audit_run WHERE id=$1',[run.id])).rows[0].status,'partial');
  await p.locator('summary').filter({hasText:/^Filters$/}).click();
  await p.getByLabel('Issue type',{exact:true}).selectOption('broken-internal-link');await p.getByRole('button',{name:'Apply filters',exact:true}).click();
  await p.getByRole('region',{name:'Audit findings',exact:true}).getByText('Broken internal link',{exact:true}).first().waitFor();
  assert.equal(await p.getByRole('region',{name:'Audit findings',exact:true}).getByText('Duplicate title',{exact:true}).count(),0);
  await p.getByRole('navigation',{name:'Audit results',exact:true}).getByRole('button',{name:'Pages',exact:true}).click();
  const pages=p.getByRole('region',{name:'Recorded audit pages',exact:true});await pages.waitFor();
  await pages.getByRole('cell',{name:/^Disallowed by robots\s*Resource:\s*Excluded$/}).waitFor();
  await pages.getByRole('cell',{name:/^HTTP error\s*Resource:\s*Done$/}).waitFor();
  const row=pages.getByRole('row').filter({has:page.getByRole('button',{name:'View page: '+group.main.origin+'/',exact:true})});await row.getByRole('button',{name:'View page: '+group.main.origin+'/',exact:true}).click();
  await p.getByRole('heading',{name:'Title',exact:true}).waitFor();await p.getByRole('heading',{name:'Title',exact:true}).locator('xpath=following-sibling::p[1]').getByText('Synthetic technical page',{exact:true}).waitFor();
  await page.waitForFunction(el=>document.activeElement===el,await p.getByRole('heading',{name:group.main.origin+'/',exact:true}).elementHandle());
  assert.equal(await p.locator('img,iframe,script').count(),0);await p.getByRole('table',{name:'Recorded page links',exact:true}).waitFor();
  await p.getByRole('button',{name:'Incoming',exact:true}).click();await p.getByRole('table',{name:'Recorded page links',exact:true}).getByRole('button',{name:'View source page',exact:true}).first().waitFor();
  await p.getByRole('button',{name:'Outgoing',exact:true}).click();await p.getByRole('table',{name:'Recorded page links',exact:true}).getByText('Second page',{exact:true}).waitFor();
  await assertLayout(page,'audit-page-evidence');cleanBrowser();
  console.log('PASS audit scope excludes redirect aliases, explicit queueing, contained robots/HTML graph, partial findings and responsive page/link evidence.');

  stage='earlier-launched link read observes later expiry';
  const rootPage=(await pool.query('SELECT id FROM site_audit_page WHERE run_id=$1 AND url=$2',[run.id,group.main.origin+'/'])).rows[0];
  const entered=deferred(),release=deferred(),linkPath='**'+B+'/'+run.id+'/pages/'+rootPage.id+'/links?*';let firstLink=true;
  const lateLink=async route=>{
    if(!firstLink)return route.continue();firstLink=false;entered.resolve();await release.promise;
    const response=await route.fetch();assert.equal((await response.json()).run.rawEvidenceStatus,'expired');await route.fulfill({response});
  };
  await page.route(linkPath,lateLink);cleanups.push(async()=>{release.resolve();await page.unroute(linkPath,lateLink);});
  await p.getByRole('button',{name:'Refresh links',exact:true}).click();await bounded(entered.promise);
  const availableRefresh=page.waitForResponse(r=>r.url().endsWith(B+'/'+run.id)&&r.request().method()==='GET');
  await p.getByRole('button',{name:'Refresh status',exact:true}).click();assert.equal((await (await availableRefresh).json()).run.rawEvidenceStatus,'available');
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Refresh status')?.disabled===false);
  await pool.query('UPDATE site_audit_run SET raw_expired_at=clock_timestamp() WHERE id=$1',[run.id]);
  release.resolve();await p.getByText('Copied page evidence expired; retained facts may still be available.',{exact:true}).waitFor();await page.unroute(linkPath,lateLink);
  assert.equal(await p.getByText('Synthetic technical page',{exact:true}).count(),0);assert.equal(await p.getByText('Second page',{exact:true}).count(),0);
  assert.ok(await p.getByText('Title Length',{exact:true}).count()||await p.getByText('Title length',{exact:true}).count());

  stage='late available page cannot restore expired details';
  await p.getByRole('button',{name:'← Back to results',exact:true}).click();await pages.waitFor();
  await page.waitForFunction(el=>document.activeElement===el,await row.getByRole('button',{name:'View page: '+group.main.origin+'/',exact:true}).elementHandle());
  const held=await holdNextGet(page,'**'+B+'/'+run.id+'/pages/'+rootPage.id);cleanups.push(held.dispose);
  await row.getByRole('button',{name:'View page: '+group.main.origin+'/',exact:true}).click();await bounded(held.entered);
  await pool.query('UPDATE site_audit_run SET data_expired_at=clock_timestamp() WHERE id=$1',[run.id]);
  await p.getByRole('button',{name:'Refresh status',exact:true}).click();await p.getByText(/Detailed audit results expired/).waitFor();
  held.release();await held.dispose();await page.waitForTimeout(100);
  assert.equal(await p.getByRole('table',{name:'Recorded page links',exact:true}).count(),0);assert.equal(await p.getByRole('navigation',{name:'Audit results',exact:true}).count(),0);
  await p.getByText('Pages analyzed',{exact:true}).waitFor();
  await p.getByRole('button',{name:'Delete audit',exact:true}).click();await page.getByRole('dialog',{name:'Delete this audit and its collected details?',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('dialog',{name:'Delete this audit and its collected details?',exact:true}).waitFor({state:'hidden'});assert.equal((await pool.query('SELECT deleted_at FROM site_audit_run WHERE id=$1',[run.id])).rows[0].deleted_at,null);
  await p.getByRole('button',{name:'Delete audit',exact:true}).click();await page.getByRole('dialog',{name:'Delete this audit and its collected details?',exact:true}).getByRole('button',{name:'Delete audit',exact:true}).click();await p.getByText('Audit deleted. Collected details are queued for cleanup.',{exact:true}).waitFor();
  assert.ok((await pool.query('SELECT deleted_at FROM site_audit_run WHERE id=$1',[run.id])).rows[0].deleted_at);cleanBrowser();
  console.log('PASS lower-ticket newly observed expiry wins, older available details cannot resurrect, page/back focus works and deletion needs confirmation.');

  stage='committed start loss and malformed acknowledgement retry';{
    const g=await createKeywordCase(phaseLabel('audit-ack')),pg=await begin(g),base='/api/projects/'+g.main.id+'/audits';
    for(const failure of ['disconnect','malformed']){
      await openForm(pg);const fault=await loseFirstPost(pg,'**'+base,{failure});cleanups.push(fault.dispose);
      await panel(pg).getByRole('button',{name:/^(Start|Queue) audit$/}).evaluate(el=>{el.click();el.click();});
      await panel(pg).getByRole('button',{name:'Retry start request',exact:true}).waitFor();assert.equal(fault.bodies.length,1);assert.equal(await panel(pg).getByLabel('Start path',{exact:true}).isDisabled(),true);
      await panel(pg).getByRole('button',{name:'Retry start request',exact:true}).click();await panel(pg).getByRole('button',{name:'Cancel audit',exact:true}).waitFor();
      assert.equal(fault.bodies.length,2);assert.deepEqual(fault.bodies[0],fault.bodies[1]);const saved=(await pool.query('SELECT id FROM site_audit_run WHERE project_id=$1 AND request_id=$2',[g.main.id,fault.bodies[0].requestId])).rows;assert.equal(saved.length,1);await fault.dispose();
      await panel(pg).getByRole('button',{name:'Cancel audit',exact:true}).click();await pg.getByRole('dialog',{name:'Cancel this audit?',exact:true}).getByRole('button',{name:'Cancel audit',exact:true}).click();await panel(pg).getByText('Audit cancellation confirmed.',{exact:true}).waitFor();
      assert.deepEqual((await runAudit(saved[0].id)).requests,[]);await back(pg);cleanBrowser();
    }
    console.log('PASS audit committed loss/malformed2xx and double click preserve one immutable request; queued cancellation dispatches no crawl.');
  }

  stage='held poll cancellation, stale project response and live role';{
    const g=await createKeywordCase(phaseLabel('audit-cancel')),pg=await begin(g),base='/api/projects/'+g.main.id+'/audits',ap=panel(pg),run=await start(pg,base);
    const held=await holdNextGet(pg,'**'+base+'/'+run.id);cleanups.push(held.dispose);await bounded(held.entered,12_000);
    assert.equal(await ap.getByRole('button',{name:'Cancel audit',exact:true}).isEnabled(),true);await ap.getByRole('button',{name:'Cancel audit',exact:true}).click();await pg.getByRole('dialog',{name:'Cancel this audit?',exact:true}).getByRole('button',{name:'Cancel audit',exact:true}).click();
    await ap.getByText('Audit cancellation confirmed.',{exact:true}).waitFor();held.release();await held.dispose();assert.deepEqual((await runAudit(run.id)).requests,[]);
    const stale=await holdNextGet(pg,'**'+base+'/'+run.id,{status:401});cleanups.push(stale.dispose);await ap.getByRole('button',{name:'Refresh status',exact:true}).click();await bounded(stale.entered);
    await projectSection(pg,g.other,'Search','Site health');await panel(pg).getByText(/No audits yet/).waitFor();await projectSection(pg,g.main,'Search','Site health');await panel(pg).getByRole('table',{name:'Audit history',exact:true}).waitFor();stale.release();await stale.dispose();await pg.waitForTimeout(150);
    await accountMenu(pg);
    assert.ok(await pg.getByRole('button',{name:'Sign out',exact:true}).isVisible());
    await panel(pg).getByRole('button',{name:'View audit',exact:true}).click();await panel(pg).getByRole('button',{name:'Delete audit',exact:true}).waitFor();
    await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[g.workspace.id,g.owner.id]);await panel(pg).getByRole('button',{name:'Refresh status',exact:true}).click();
    await pg.waitForFunction(()=>![...document.querySelectorAll('button')].some(b=>b.textContent==='Delete audit'));await back(pg);await panel(pg).getByText(/You can inspect audits/).waitFor();assert.equal(await panel(pg).getByLabel('Domain',{exact:true}).count(),0);cleanBrowser();
    console.log('PASS real cancellation interrupts a held poll; SPA A→B→A ignores stale401 and live viewer role removes management.');
  }

  stage='current denied read purges evidence before access recovery';{
    const g=await createKeywordCase(phaseLabel('audit-access')),pg=await begin(g),base='/api/projects/'+g.main.id+'/audits',ap=panel(pg),run=await start(pg,base);
    await ap.getByRole('button',{name:'Cancel audit',exact:true}).click();await pg.getByRole('dialog',{name:'Cancel this audit?',exact:true}).getByRole('button',{name:'Cancel audit',exact:true}).click();await ap.getByText('Audit cancellation confirmed.',{exact:true}).waitFor();await runAudit(run.id);
    const path='**'+base+'**',deny=route=>route.request().method()==='GET'?route.fulfill({status:403,json:{error:'Synthetic audit access lost.'}}):route.continue();await pg.route(path,deny);
    await ap.getByRole('button',{name:'Refresh status',exact:true}).click();await ap.getByRole('button',{name:'Reload access',exact:true}).waitFor();assert.equal(await ap.getByRole('button',{name:'Delete audit',exact:true}).count(),0);assert.equal(await ap.getByRole('navigation',{name:'Audit results',exact:true}).count(),0);
    await pg.unroute(path,deny);await ap.getByRole('button',{name:'Reload access',exact:true}).click();await ap.getByRole('table',{name:'Audit history',exact:true}).waitFor();cleanBrowser();
    console.log('PASS current audit403 removes selected evidence and management until a deliberate access reload.');
  }
}catch(error){await captureFailure(session?.page,error,stage).catch(()=>{});console.error('FAIL audit UI stage: '+stage+' ('+(error?.name??'Error')+'). Details saved privately.');process.exitCode=1;}
finally{for(const done of cleanups)await done().catch(()=>{});await session?.browser.close();await stopJobs();await closeDatabase();}
