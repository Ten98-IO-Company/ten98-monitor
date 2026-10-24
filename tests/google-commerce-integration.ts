import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { handleApi } from '../src/server/api.ts';
import { getConfig } from '../src/server/config.ts';
import { closeDatabase, getDatabase, migrationSources } from '../src/server/db.ts';
import { stopJobs } from '../src/server/jobs.ts';
import { withGoogleTransportForTests } from '../src/server/google-http.ts';
import { runGoogleImport } from '../src/server/google-jobs.ts';
import { expireGoogleImportPages } from '../src/server/google-retention.ts';
import { runGoogleGa4Checks, type GoogleGa4BrowserFixture } from './google-ga4-integration.ts';

// Literal contracts independent of the production catalog and parser.
const profiles = {
  ga4_ecommerce_items: { dimensions: ['itemName','itemId'], metrics: ['itemsViewed','itemsAddedToCart','itemsPurchased','itemRevenue'] },
  ga4_ecommerce_landing: { dimensions: ['hostName','landingPage'], metrics: ['sessions','transactions','purchaseRevenue'] },
  ga4_site_search: { dimensions: ['searchTerm'], metrics: ['eventCount','activeUsers','sessions','engagedSessions','engagementRate'] },
  ga4_audience_device: { dimensions: ['deviceCategory'], metrics: ['activeUsers','sessions','engagementRate','keyEvents'] },
  ga4_audience_country: { dimensions: ['country'], metrics: ['activeUsers','sessions','engagementRate','keyEvents'] },
  ga4_audience_returning: { dimensions: ['newVsReturning'], metrics: ['activeUsers','sessions','engagementRate','keyEvents'] },
} as const;
type Report = keyof typeof profiles;
type Actor = { id:string; email:string; role:string; cookies:Map<string,string> };
const reports=Object.keys(profiles) as Report[];

/** Reuse the existing native OAuth/queue fixture and keep all its original checks. */
export async function runGoogleCommerceChecks() {
  assert.equal(process.env.TEN98_GOOGLE_COMMERCE_INTEGRATION,'1');
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.ANALYTICS_NETWORK_MODE,'off');
  assert.equal((await migrationSources()).at(-1)?.filename,'0074_api_key_prefix_last_used.sql','Integrate registered0052 through0069 first; no private migration bypass.');
  let commerce:Awaited<ReturnType<typeof commerceChecks>>|undefined;
  const original=await runGoogleGa4Checks(async fixture=>{commerce=await commerceChecks(fixture);});
  assert.ok(commerce);assert.equal(commerce.groups.length,8);
  return {original,commerce};
}

async function commerceChecks(parent:GoogleGa4BrowserFixture) {
  const config=getConfig(),{pool}=getDatabase(),base=`/api/projects/${parent.projectId}/google`,password=randomBytes(24).toString('base64url');
  const finance=async()=>createHash('sha256').update(JSON.stringify((await pool.query('SELECT to_jsonb(p) AS row FROM provider_request p ORDER BY id')).rows)).digest('hex'),financialBefore=await finance();
  // A genuine additional owner has its own unchanged native rate budget.
  const actors:Actor[]=[];
  for(const role of ['owner','admin','editor','viewer','foreign','owner']){const id=randomUUID(),email=id+'@commerce.integration.test';await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,$2,$3)',[id,'Commerce '+role,email]);await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password)VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),id,await hashPassword(password)]);if(role!=='foreign')await pool.query('INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,$3)',[parent.workspaceId,id,role]);actors.push({id,email,role,cookies:new Map()});}
  const [owner,admin,editor,viewer,foreign,numericOwner]=actors,posts=new Map<string,number>(),snapshots:Record<string,any>={},groups:string[]=[],ids:string[]=[];
  async function call(path:string,body?:unknown,actor=owner,origin=config.appUrl){const headers=new Headers({cookie:[...actor.cookies].map(([key,value])=>`${key}=${value}`).join('; ')});if(body!==undefined){headers.set('origin',origin);headers.set('content-type','application/json');if(origin===config.appUrl&&path.startsWith(base))posts.set(actor.id,(posts.get(actor.id)??0)+1);}const response=await handleApi(new Request(config.appUrl+path,{method:body===undefined?'GET':'POST',headers,...body===undefined?{}:{body:JSON.stringify(body)}}));for(const cookie of response.headers.getSetCookie()){const first=cookie.split(';')[0],at=first.indexOf('=');actor.cookies.set(first.slice(0,at),first.slice(at+1));}const text=await response.text();return {response,data:text?JSON.parse(text):null};}
  for(const actor of actors)assert.equal((await call('/api/auth/sign-in/email',{email:actor.email,password},actor)).response.status,200);
  let mode='normal',providerCalls=0,reportCalls=0,compatibilityCalls=0,resumeFailed=false;
  const offsets:number[]=[];
  const transport=async(url:string,init:RequestInit):Promise<Response>=>{
    providerCalls++;assert.equal(init.redirect,'error');assert.ok(init.signal);assert.match(new Headers(init.headers).get('authorization')??'',/^Bearer [A-Za-z0-9_-]+$/);
    const u=new URL(url);assert.equal(u.origin,'https://analyticsdata.googleapis.com');assert.ok(['/v1beta/properties/123:checkCompatibility','/v1beta/properties/123:runReport'].includes(u.pathname));assert.equal(u.search,'');assert.equal(init.method,'POST');
    const body=JSON.parse(String(init.body)),report=reports.find(key=>JSON.stringify(body.dimensions)===JSON.stringify(profiles[key].dimensions.map(name=>({name}))));assert.ok(report);
    const profile=profiles[report],filter=report==='ga4_site_search'?{dimensionFilter:{andGroup:{expressions:[{filter:{fieldName:'eventName',stringFilter:{matchType:'EXACT',value:'view_search_results',caseSensitive:true}}},{notExpression:{filter:{fieldName:'searchTerm',stringFilter:{matchType:'EXACT',value:'(not set)',caseSensitive:true}}}}]}}}:{};
    const selected={dimensions:profile.dimensions.map(name=>({name})),metrics:profile.metrics.map(name=>({name})),...filter};
    if(u.pathname.endsWith(':checkCompatibility')){compatibilityCalls++;assert.deepEqual(body,selected);const value={dimensionCompatibilities:profile.dimensions.map(apiName=>({dimensionMetadata:{apiName},compatibility:mode==='incompatible'?'INCOMPATIBLE':'COMPATIBLE'})),metricCompatibilities:profile.metrics.map(apiName=>({metricMetadata:{apiName},compatibility:'COMPATIBLE'}))};if(mode==='missingCompatibility')value.metricCompatibilities.pop();return Response.json(value);}
    reportCalls++;assert.deepEqual(body,{dateRanges:[{startDate:'2024-03-01',endDate:'2024-03-10'}],...selected,orderBys:profile.dimensions.map(dimensionName=>({dimension:{dimensionName,orderType:'ALPHANUMERIC'}})),offset:body.offset,limit:'1000',returnPropertyQuota:true,keepEmptyRows:true});
    const offset=Number(body.offset);assert.equal(body.offset,String(offset));assert.ok(Number.isSafeInteger(offset)&&offset>=0&&offset<=9000);offsets.push(offset);
    if(mode==='quota')return new Response('{}',{status:429});if(mode==='oversize')return new Response(' '.repeat(2097153));if(mode==='empty')return Response.json({});
    if(mode==='resume'&&offset===1000&&!resumeFailed){resumeFailed=true;return new Response('{}',{status:429});}
    const paged=['1001','10001','changedCount','duplicate','currency','timezone','resume'].includes(mode),total=mode==='10001'?10001:paged?1001:1,length=Math.min(1000,total-offset);
    const rows=Array.from({length},(_,i)=>({dimensionValues:profile.dimensions.map(name=>({value:name==='hostName'?'shop.example.test':name==='deviceCategory'?'mobile':name==='country'?'United Arab Emirates':name==='newVsReturning'?'returning':`${name==='landingPage'?'/shop/':'term 🛒 '}${mode==='duplicate'&&offset?0:offset+i}`})),metricValues:profile.metrics.map(name=>({value:mode==='precisionRate'&&name==='engagementRate'?'1.0000000000000001':mode==='negativeUnderflow'&&name==='itemsViewed'?'-1e-400':name==='itemRevenue'||name==='purchaseRevenue'?'-9007199254740993.1250':name==='engagementRate'?'0.5':name==='keyEvents'?'0.25':name==='activeUsers'?'9007199254740993':'0'}))}));
    const value:Record<string,unknown>={dimensionHeaders:profile.dimensions.map(name=>({name})),metricHeaders:profile.metrics.map(name=>({name})),rows,rowCount:mode==='changedCount'&&offset?1002:total,metadata:{timeZone:mode==='timezone'&&offset?'Asia/Tokyo':'America/New_York',...report==='ga4_ecommerce_items'||report==='ga4_ecommerce_landing'?{currencyCode:mode==='currency'&&offset?'USD':'AED'}:{},subjectToThresholding:true,dataLossFromOtherRow:true,samplingMetadatas:[{samplesReadCount:'10',samplingSpaceSize:'100'}],...mode==='restricted'?{schemaRestrictionResponse:{activeMetricRestrictions:[{metricName:'itemRevenue',restrictedMetricTypes:['REVENUE_DATA']}]}}:{}},propertyQuota:{tokensPerDay:{consumed:1,remaining:199999}}};if(mode==='missingCount')delete value.rowCount;return Response.json(value);
  };
  await withGoogleTransportForTests(transport,async()=>{
    async function queue(report:Report='ga4_ecommerce_items',actor=owner){const input={requestId:randomUUID(),report,from:'2024-03-01',to:'2024-03-10'},result=await call(`${base}/connections/${parent.connectionId}/imports`,input,actor);assert.equal(result.response.status,202);ids.push(result.data.import.id);return {id:result.data.import.id as string,input};}
    async function snapshot(id:string,offset=0){const result=await call(`${base}/imports/${id}?offset=${offset}`);assert.equal(result.response.status,200);return result.data;}
    const initial:Partial<Record<Report,Awaited<ReturnType<typeof queue>>>>={};
    for(const report of reports){const queued=await queue(report),before=compatibilityCalls;await runGoogleImport(queued.id);assert.equal(compatibilityCalls,before+1);const value=await snapshot(queued.id);assert.equal(value.import.status,'completed');assert.equal(value.import.rowCount,1);assert.equal(value.import.pages,1);assert.deepEqual(value.dimensions,profiles[report].dimensions);assert.deepEqual(value.metrics,profiles[report].metrics);assert.equal(value.source.timeZone,'America/New_York');assert.equal(value.source.currencyCode,'AED');assert.equal(value.nextOffset,null);assert.ok(value.quality.warnings.length>=3);for(const metric of profiles[report].metrics)assert.equal(value.rows[0].metrics[metric],metric==='itemRevenue'||metric==='purchaseRevenue'?'-9007199254740993.1250':metric==='engagementRate'?'0.5':metric==='keyEvents'?'0.25':metric==='activeUsers'?'9007199254740993':'0');initial[report]=queued;snapshots[report]=value;}
    const first=initial.ga4_ecommerce_items!,before=providerCalls;
    assert.equal((await call(`${base}/connections/${parent.connectionId}/imports`,first.input)).data.import.id,first.id);assert.equal((await call(`${base}/connections/${parent.connectionId}/imports`,{...first.input,report:'ga4_site_search'})).response.status,409);
    for(const actor of [owner,admin,editor,viewer])assert.deepEqual((await call(`${base}/imports/${first.id}`,undefined,actor)).data,snapshots.ga4_ecommerce_items);
    for(const actor of [admin,editor,viewer])assert.equal((await call(`${base}/connections/${parent.connectionId}/imports`,{...first.input,requestId:randomUUID()},actor)).response.status,404);
    assert.equal((await call(`${base}/imports/${first.id}`,undefined,foreign)).response.status,404);assert.equal((await call(`${base}/connections/${parent.connectionId}/imports`,{...first.input,requestId:randomUUID()},owner,'https://foreign.test')).response.status,403);assert.equal(providerCalls,before);
    groups.push('six exact native range snapshots, four-role reads, owner-only import, same-key replay/conflict and origin refusal');

    mode='1001';let queued=await queue('ga4_site_search');await runGoogleImport(queued.id);let value=await snapshot(queued.id);assert.equal(value.import.status,'completed');assert.equal(value.import.pages,2);assert.equal(value.import.rowCount,1001);assert.equal(value.rows.length,50);assert.equal(value.nextOffset,50);let readsBefore=providerCalls;assert.equal((await snapshot(queued.id,1000)).rows.length,1);assert.equal(providerCalls,readsBefore);snapshots.paged=value;
    mode='10001';queued=await queue();await runGoogleImport(queued.id);value=await snapshot(queued.id);assert.equal(value.import.status,'partial');assert.equal(value.import.pages,10);assert.equal(value.import.rowCount,10000);assert.equal((await pool.query('SELECT provider_row_count FROM google_import WHERE id=$1',[queued.id])).rows[0].provider_row_count,10001);assert.match(value.quality.warnings.join(' '),/10,000/);snapshots.partial=value;
    mode='empty';queued=await queue('ga4_audience_returning');await runGoogleImport(queued.id);value=await snapshot(queued.id);assert.equal(value.import.status,'completed');assert.equal(value.import.rowCount,0);assert.deepEqual(value.rows,[]);snapshots.empty=value;
    mode='restricted';queued=await queue();await runGoogleImport(queued.id);value=await snapshot(queued.id);assert.equal(value.rows[0].metrics.itemRevenue,null);assert.equal(value.rows[0].metrics.itemsViewed,'0');snapshots.restricted=value;
    groups.push('1001 complete and10001 partial, native50-row paging without provider reads, empty and restricted values');

    for(const bad of ['incompatible','missingCompatibility','missingCount','changedCount','duplicate','currency','timezone','precisionRate','negativeUnderflow']){mode=bad;const before=reportCalls;queued=await queue(bad==='precisionRate'?'ga4_audience_device':'ga4_ecommerce_items',['precisionRate','negativeUnderflow'].includes(bad)?numericOwner:owner);await runGoogleImport(queued.id);value=await snapshot(queued.id);assert.ok(['failed','denied'].includes(value.import.status),bad);assert.deepEqual(value.rows,[]);assert.deepEqual(value.quality,{warnings:[],metadata:{}});if(['incompatible','missingCompatibility'].includes(bad))assert.equal(reportCalls,before);snapshots[bad]=value;}
    groups.push('incompatible fields, missing/changing totals, repeated rows and changed currency/timezone cannot publish observations');

    for(const bad of ['quota','oversize']){mode=bad;queued=await queue();await assert.rejects(runGoogleImport(queued.id),/temporarily unavailable/);value=await snapshot(queued.id);assert.equal(value.import.status,'queued');assert.deepEqual(value.rows,[]);mode='normal';await runGoogleImport(queued.id);assert.equal((await snapshot(queued.id)).import.status,'completed');}
    mode='resume';queued=await queue();const compatibilityBefore=compatibilityCalls,offsetStart=offsets.length;await assert.rejects(runGoogleImport(queued.id),/temporarily unavailable/);value=await snapshot(queued.id);assert.equal(value.import.pages,1);assert.equal(value.import.status,'queued');assert.deepEqual(value.rows,[]);assert.deepEqual(value.quality,{warnings:[],metadata:{}});await runGoogleImport(queued.id);assert.equal((await snapshot(queued.id)).import.rowCount,1001);assert.equal(compatibilityCalls,compatibilityBefore+1);assert.deepEqual(offsets.slice(offsetStart),[0,1000,1000]);
    groups.push('quota/body bounds preserve explicit retry and committed checkpoints without repeated page zero');

    mode='normal';queued=await queue();await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[parent.workspaceId,owner.id]);readsBefore=providerCalls;await runGoogleImport(queued.id);assert.equal(providerCalls,readsBefore);assert.equal((await snapshot(queued.id)).import.status,'denied');await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[parent.workspaceId,owner.id]);
    queued=await queue();const connectionBefore=(await pool.query('SELECT revision,encrypted_tokens FROM google_connection WHERE id=$1',[parent.connectionId])).rows[0];
    // Deliberately stale revision-bound ciphertext must be rejected before decryption or refresh.
    try{await pool.query('UPDATE google_connection SET revision=revision+1 WHERE id=$1',[parent.connectionId]);readsBefore=providerCalls;await runGoogleImport(queued.id);assert.equal(providerCalls,readsBefore);const denied=await snapshot(queued.id);assert.equal(denied.import.status,'denied');assert.match(denied.import.diagnostic,/source changed/);assert.equal(denied.import.pages,0);assert.deepEqual(denied.rows,[]);}
    finally{await pool.query('UPDATE google_connection SET revision=$2,encrypted_tokens=$3 WHERE id=$1',[parent.connectionId,connectionBefore.revision,connectionBefore.encrypted_tokens]);}
    assert.deepEqual((await pool.query('SELECT revision,encrypted_tokens FROM google_connection WHERE id=$1',[parent.connectionId])).rows[0],connectionBefore);
    groups.push('current owner and connection revision are rechecked before compatibility or report dispatch');

    const savedQuality=(await pool.query('SELECT quality FROM google_import WHERE id=$1',[first.id])).rows[0].quality;await pool.query('UPDATE google_import SET quality=$2 WHERE id=$1',[first.id,{warnings:[],metadata:{oversized:'x'.repeat(2097152)}}]);try{readsBefore=providerCalls;assert.equal((await call(`${base}/imports/${first.id}`)).response.status,503);assert.equal(providerCalls,readsBefore);}finally{await pool.query('UPDATE google_import SET quality=$2 WHERE id=$1',[first.id,savedQuality]);}
    groups.push('complete native JSON refuses oversized combined metadata without truncating or contacting Google');

    const expired=Object.values(initial).map(item=>item!.id),receiptBefore=(await pool.query('SELECT id,request_id,report,status,row_count,source FROM google_import WHERE id=ANY($1::uuid[]) ORDER BY id',[expired])).rows;
    await pool.query("UPDATE google_import SET completed_at=clock_timestamp()-interval '400 days' WHERE id=ANY($1::uuid[])",[expired]);const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[parent.workspaceId]);await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[parent.projectId]);assert.equal((await expireGoogleImportPages(client,parent.projectId,new Date(Date.now()-365*864e5))).expiredImports,6);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    readsBefore=providerCalls;for(const item of Object.values(initial)){value=await snapshot(item!.id);assert.equal(value.import.dataStatus,'expired');assert.deepEqual(value.rows,[]);assert.deepEqual(value.quality,{warnings:[],metadata:{}});assert.equal((await call(`${base}/connections/${parent.connectionId}/imports`,item!.input)).data.import.id,item!.id);}assert.equal(providerCalls,readsBefore);assert.deepEqual((await pool.query('SELECT id,request_id,report,status,row_count,source FROM google_import WHERE id=ANY($1::uuid[]) ORDER BY id',[expired])).rows,receiptBefore);
    groups.push('all six profile kinds expire observations while preserving immutable receipts and exact replay');

    assert.equal(await finance(),financialBefore);assert.equal((await pool.query('SELECT count(*)::int AS n FROM event WHERE project_id=$1',[parent.projectId])).rows[0].n,0);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);
    assert.equal(ids.length,24);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name='google-report-import' AND id=ANY($1::uuid[])",[ids])).rows[0].n,24);assert.equal(posts.get(owner.id),30);assert.ok([...posts.values()].every(n=>n<=30));assert.equal(posts.get(numericOwner.id),2);assert.equal(reportCalls,38);assert.equal(compatibilityCalls,24);assert.equal(providerCalls,62);
    groups.push('24 native imports/jobs, unchanged financial rows, no native-event mixing and unchanged admission bounds');
    if(process.env.TEN98_GOOGLE_COMMERCE_OUTPUT){const output=resolve(process.env.TEN98_GOOGLE_COMMERCE_OUTPUT),prefix=resolve('private/ga4-commerce/native');assert.ok(output.startsWith(prefix+'/')||output.startsWith(prefix+'\\'));assert.ok(output.endsWith('.json'));await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify({groups,snapshots,providerCalls,reportCalls,compatibilityCalls,nativeGooglePostsByActor:Object.fromEntries(posts),imports:ids.length,financialBefore,financialAfter:await finance()})+'\n');}
  });
  return {groups,providerCalls,reportCalls,compatibilityCalls,imports:ids.length};
}

if(import.meta.main)try{console.log(await runGoogleCommerceChecks());}finally{await stopJobs();await closeDatabase();}
