// Real application routes and saved body evidence; only the crawler transport is synthetic.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAuditCase} from './fixtures.mjs';
import {fixtureGuard,appUrl} from './guard.mjs';
import {browserSession,providerCounts,href,assertLayout,captureFailure} from './browser.mjs';
import {runAudit} from './jobs.mjs';
import {getDatabase,closeDatabase} from '../../src/server/db.ts';
import {runRetentionBatch} from '../../src/server/retention.ts';
import {stopJobs} from '../../src/server/jobs.ts';

fixtureGuard();
const label=process.argv[2]??'body';assert.match(label,/^[a-z][a-z-]{0,19}$/);assert.ok(process.argv.length<=3);
const {pool}=getDatabase();
let session,stage='fixture setup';
const panel=page=>page.locator('section[aria-label="Site audits"]');
const literal='<script>window.syntheticBodyUnsafe=true</script> <img src=x onerror=window.syntheticBodyUnsafe=true>';
const expected='Captured synthetic page '+literal+' CSS-only hidden text Footer boilerplate '+Array(170).fill('word').join(' ');
const escaped=literal.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const html='<!doctype html><html><head><title>Captured body fixture</title><meta name="description" content="'+('Synthetic description '.repeat(8))+'"></head><body><h1>Captured synthetic page</h1><p>'+escaped+'</p><p style="display:none">CSS-only hidden text</p><footer>Footer boilerplate</footer><p>'+Array(170).fill('word').join(' ')+'</p><p hidden>EXCLUDED_HIDDEN_TEXT</p><script>EXCLUDED_SCRIPT_TEXT</script></body></html>';
try{
  const group=await createAuditCase(label),before=await providerCounts();
  session=await browserSession(group.owner);const {page,context}=session,p=panel(page),base='/api/projects/'+group.main.id+'/audits';
  await page.goto(href(group,'audits'),{waitUntil:'networkidle'});await p.getByRole('heading',{name:'Audit history',exact:true}).waitFor();
  stage='explicit default-off opt-in and immutable queued receipt';
  const checkbox=p.getByRole('checkbox',{name:'Retain page text for content analysis',exact:true});
  await checkbox.waitFor();assert.equal(await checkbox.isChecked(),false);
  assert.match(await p.innerText(),/public personal information and boilerplate/);assert.match(await p.innerText(),/Does not send it to AI/);
  await checkbox.check();
  const starting=page.waitForResponse(response=>new URL(response.url()).pathname===base&&response.request().method()==='POST');
  await p.getByRole('button',{name:'Queue audit',exact:true}).click();const accepted=await starting;assert.equal(accepted.status(),202);
  assert.equal(accepted.request().postDataJSON().retainBodyText,true);const {run}=await accepted.json();assert.equal(run.config.retainBodyText,true);assert.equal(run.status,'queued');assert.equal(run.progress.requests,0);
  assert.equal((await pool.query('SELECT config->>\'retainBodyText\' AS opt_in FROM site_audit_run WHERE id=$1 AND project_id=$2',[run.id,group.main.id])).rows[0].opt_in,'true');
  assert.deepEqual(await providerCounts(),before);
  console.log('PASS actual UI defaults body retention off and records explicit opt-in before any contained crawl.');

  stage='contained crawl and list/detail body projection';
  const crawled=await runAudit(run.id,{route:url=>url.pathname==='/robots.txt'?{status:404}:url.pathname==='/sitemap.xml'?{body:'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>'+group.main.origin+'/</loc></url></urlset>',headers:['Content-Type','application/xml']}:{body:html}});
  assert.deepEqual([...crawled.requests].sort(),['/','/robots.txt','/sitemap.xml'].sort());
  await p.getByRole('button',{name:'Refresh status',exact:true}).click();await p.getByRole('button',{name:'Delete audit',exact:true}).waitFor();
  const listing=page.waitForResponse(response=>new URL(response.url()).pathname===base+'/'+run.id+'/pages');
  await p.getByRole('navigation',{name:'Audit results',exact:true}).getByRole('button',{name:'Pages',exact:true}).click();
  const listResponse=await listing;assert.equal(listResponse.status(),200);const listed=await listResponse.json();assert.equal(listed.pages.length,1);
  const item=listed.pages[0],bytes=Buffer.byteLength(expected);
  assert.deepEqual(item.bodyEvidence,{status:'available',version:'static-dom-body-v1',utf8Bytes:bytes,textIncluded:false,text:null});
  assert.ok(!JSON.stringify(listed).includes(literal));
  const detailPath=base+'/'+run.id+'/pages/'+item.id,reading=page.waitForResponse(response=>new URL(response.url()).pathname===detailPath);
  await p.getByRole('region',{name:'Recorded audit pages',exact:true}).getByRole('button',{name:/^View page: /}).click();
  const detailResponse=await reading;assert.equal(detailResponse.status(),200);const detail=await detailResponse.json();
  assert.deepEqual(detail.page.bodyEvidence,{...item.bodyEvidence,textIncluded:true,text:expected});
  assert.equal(detail.page.analysis.facts.contentHash,createHash('sha256').update(expected).digest('hex'));assert.equal(detail.page.analysis.facts.wordCount,expected.split(' ').length);
  assert.equal(detail.page.url,group.main.origin+'/');assert.ok(detail.page.observedAt);
  const history=await context.request.get(appUrl+base);assert.equal(history.status(),200);assert.ok(!JSON.stringify(await history.json()).includes(literal));
  const captured=p.locator('details').filter({has:page.locator('summary').filter({hasText:/^Captured page text$/})});
  await captured.locator(':scope > summary').click();await captured.locator('div.mono').waitFor();assert.equal(await captured.locator('div.mono').textContent(),expected);
  assert.equal(await captured.locator('script,img,iframe').count(),0);assert.equal(await page.evaluate(()=>window.syntheticBodyUnsafe),undefined);
  assert.match(await captured.innerText(),/not rendered or live page content/);assert.ok(!(await captured.innerText()).includes('EXCLUDED_HIDDEN_TEXT'));assert.ok(!(await captured.innerText()).includes('EXCLUDED_SCRIPT_TEXT'));
  await assertLayout(page,'audit-body-captured');assert.deepEqual(session.errors,[]);assert.deepEqual(session.outbound,[]);assert.deepEqual(await providerCounts(),before);
  console.log('PASS contained real parser capture stays out of list/history, arrives through authorized detail and renders encoded HTML inertly with source/hash/byte provenance.');

  stage='fresh raw expiry before cleanup and permanent no-resurrection';
  // Backdate only this owned synthetic run to exercise real policy reads without a wall-clock wait.
  await pool.query("WITH stamp AS (SELECT clock_timestamp()-interval '100 days' AS at) UPDATE site_audit_run SET created_at=stamp.at-interval '1 minute',started_at=stamp.at-interval '1 minute',deadline_at=stamp.at+interval '29 minutes',completed_at=stamp.at FROM stamp WHERE id=$1 AND project_id=$2 AND status IN('completed','partial')",[run.id,group.main.id]);
  const expiring=page.waitForResponse(response=>new URL(response.url()).pathname===detailPath+'/links');
  await p.getByRole('button',{name:'Refresh links',exact:true}).click();const expiredEnvelope=await (await expiring).json();assert.equal(expiredEnvelope.run.rawEvidenceStatus,'expired');
  await captured.getByText('Captured page text expired under workspace raw-evidence retention.',{exact:true}).waitFor();assert.equal(await captured.locator('div.mono').count(),0);
  const stored=(await pool.query('SELECT r.raw_expired_at,p.body_text,p.facts,p.observed_at FROM site_audit_run r JOIN site_audit_page p ON p.run_id=r.id WHERE r.id=$1 AND p.id=$2',[run.id,item.id])).rows[0];
  assert.ok(stored.raw_expired_at);assert.equal(stored.body_text,expected,'Fresh reads hide raw text before physical cleanup.');assert.equal(stored.observed_at.toISOString(),detail.page.observedAt);assert.equal(stored.facts.contentHash,detail.page.analysis.facts.contentHash);
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650,derived_history_days=3650 WHERE id=$1',[group.workspace.id]);
  const afterExtension=await context.request.get(appUrl+detailPath);assert.equal(afterExtension.status(),200);
  assert.deepEqual((await afterExtension.json()).page.bodyEvidence,{status:'expired',version:'static-dom-body-v1',utf8Bytes:null,textIncluded:false,text:null});
  // A fresh load of the audit list (a reload would reopen the URL's selected audit page).
  await page.goto(href(group,'audits'),{waitUntil:'networkidle'});await p.getByRole('button',{name:'View audit',exact:true}).click();await p.getByRole('navigation',{name:'Audit results',exact:true}).getByRole('button',{name:'Pages',exact:true}).click();
  await p.getByRole('region',{name:'Recorded audit pages',exact:true}).getByRole('button',{name:/^View page: /}).click();await captured.locator(':scope > summary').click();
  await captured.getByText('Captured page text expired under workspace raw-evidence retention.',{exact:true}).waitFor();assert.equal(await captured.locator('div.mono').count(),0);
  await runRetentionBatch(group.main.id);assert.equal((await pool.query('SELECT body_text FROM site_audit_page WHERE id=$1',[item.id])).rows[0].body_text,null);
  assert.deepEqual((await runAudit(run.id)).requests,[],'Completed replay cannot recrawl or restore cleared body.');
  const afterCleanup=await context.request.get(appUrl+detailPath);assert.equal(afterCleanup.status(),200);assert.equal((await afterCleanup.json()).page.bodyEvidence.status,'expired');
  await assertLayout(page,'audit-body-expired');assert.deepEqual(session.errors,[]);assert.deepEqual(session.outbound,[]);assert.deepEqual(await providerCounts(),before);
  console.log('PASS current raw cutoff hides copied text before cleanup; policy extension, fresh UI reload and completed-job replay cannot resurrect it.');
}catch(error){await captureFailure(session?.page,error,stage).catch(()=>{});console.error('FAIL audit body UI stage: '+stage+' ('+(error?.name??'Error')+'). Details saved privately.');process.exitCode=1;}
finally{await session?.browser.close();await stopJobs();await closeDatabase();}
