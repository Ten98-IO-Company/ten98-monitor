import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase,migrationSources,assertSchema} from '../src/server/db.ts';
import {stopJobs} from '../src/server/jobs.ts';
import {saveProvider,saveBudget,assertCredentialKeys} from '../src/server/providers.ts';
import {getProviderAccountIdentityKey,assertProviderAccountIdentityReadable,rotateProviderAccountIdentityEncryption} from '../src/server/provider-account-identity.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {readKeywordAccount} from '../src/server/dataforseo-keywords.ts';
import {quoteKeywordResearch,executeKeywordResearch,reconcileKeywordResearch} from '../src/server/keyword-research.ts';
import {quoteSavedKeywordRefresh,startSavedKeywordRefresh} from '../src/server/saved-keyword-refresh.ts';
import {saveSavedKeywords} from '../src/server/saved-keywords.ts';
import {keywordAccountEndpoint,keywordReconcileEndpoint,keywordEndpoints,keywordPayload,type KeywordRequest} from '../src/server/keyword-research-input.ts';
import {aiSearchProfileId,aiSearchPriceEvidence} from '../src/lib/ai-search.ts';

// Five invocations, each with a different initially empty owned database:
// TEN98_IDENTITY_TEST_CASE=legacy|deferred|rank|upgrade22|ai_search node --env-file=<private env> tests/provider-account-identity-integration.ts
// Fixtures are retained; this test never drops a database/schema or clears user data.
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
const scenario=process.env.TEN98_IDENTITY_TEST_CASE;assert.ok(scenario==='legacy'||scenario==='deferred'||scenario==='rank'||scenario==='upgrade22'||scenario==='ai_search');
const config=getConfig(),url=new URL(config.databaseUrl);
const hostedCi=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname===`/ten98_provider_identity_${scenario}_ci`;
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.equal(url.port,hostedCi?'5432':'55501');assert.equal(url.search,'');assert.equal(url.hash,'');
assert.match(url.pathname,/^\/ten98_provider_identity_[a-z0-9_]+$/);assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(config.appUrl).hostname));
assert.ok(process.env.CREDENTIAL_KEYS&&!process.env.CREDENTIAL_KEYS_FILE&&process.env.CREDENTIAL_ACTIVE_KEY,'Use a direct synthetic test keyring.');
const original={auth:process.env.AUTH_SECRET,keys:process.env.CREDENTIAL_KEYS,active:process.env.CREDENTIAL_ACTIVE_KEY,fetch:globalThis.fetch};
const {pool}=getDatabase();let stage='initial safety check',unexpected=0,paid=0,accountCalls=0,metadataCalls=0;
globalThis.fetch=async()=>{unexpected++;throw new Error('External traffic is forbidden in identity acceptance.');};
const account='synthetic-account@identity.integration.test';let returnedAccount=account,reconcileItems:unknown[]=[];
const free=(result:unknown[])=>Response.json({status_code:20000,cost:0,tasks_count:1,tasks:[{status_code:20000,cost:0,result}]});
const send:typeof fetch=async(target,init)=>{
  assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);
  if(target===keywordAccountEndpoint){accountCalls++;const prices={priority_normal:[{cost_type:'per_request',cost:0.012},{cost_type:'per_result',cost:0.00012}]};return free([{login:returnedAccount,price:{dataforseo_labs:{keyword_overview:{live:prices}}}}]);}
  if(target===keywordReconcileEndpoint){metadataCalls++;return free(reconcileItems);}
  assert.equal(target,keywordEndpoints.overview);paid++;throw new Error('Synthetic response lost after dispatch.');
};
const failed=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===status;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const oldFingerprint=(secret:string)=>createHmac('sha256',secret).update('ten98.dataforseo.account.v1:'+account).digest('hex');
function cli(command:'migrate'|'rekey',expected:number){
  const block='data:text/javascript,'+encodeURIComponent("globalThis.fetch=async()=>{throw new Error('External traffic disabled in migration test');}");
  const result=spawnSync(process.execPath,['--import',block,join(process.cwd(),'src/server/cli.ts'),command],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:45_000,maxBuffer:256_000,windowsHide:true});
  assert.equal(result.status,expected,stage+': CLI exit');
  for(const secret of [config.databaseUrl,config.bootstrapToken,original.auth,process.env.AUTH_SECRET,process.env.CREDENTIAL_KEYS])if(secret)assert.ok(!(result.stdout+result.stderr).includes(secret),'CLI leaked secret configuration.');
}
type Fixture={owner:string;workspace:string;project:string;connection:string;request:KeywordRequest};
async function fixture():Promise<Fixture>{
  const owner=randomUUID(),workspace=randomUUID(),project=randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Identity fixture\',$2)',[owner,owner+'@identity.integration.test']);
  await pool.query('INSERT INTO workspace(id,name) VALUES($1,\'Identity fixture\')',[workspace]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Identity fixture','https://identity.integration.test',$3,'infinity')",[project,workspace,randomUUID()]);
  const connection=(await saveProvider(workspace,owner,{provider:'dataforseo',name:'Synthetic identity account',credentials:{login:account,password:'synthetic-never-live'}})).connection.id;
  await saveBudget(workspace,owner,{paused:false});
  await pool.query('INSERT INTO keyword_market_catalog(workspace_id,markets) VALUES($1,$2)',[workspace,JSON.stringify([{locationCode:2840,locationName:'United States',languageCode:'en',languageName:'English'}])]);
  return {owner,workspace,project,connection,request:{connectionId:connection,mode:'overview',keywords:['identity'],locationCode:2840,languageCode:'en',limit:100}};
}
async function legacy(f:Fixture,secret:string){
  const quote=randomUUID(),run=randomUUID(),fingerprint=oldFingerprint(secret),reference='synthetic-'+randomUUID();
  await pool.query(`INSERT INTO keyword_quote(id,workspace_id,project_id,user_id,connection_id,connection_revision,request,account_fingerprint,per_task_micros,per_item_micros,estimate_micros,price_as_of,expires_at)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,12000,120,12120,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,[quote,f.workspace,f.project,f.owner,f.connection,JSON.stringify(f.request),fingerprint]);
  await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,status,budget_month,provider_reference)
    VALUES($1,$2,$3,1,$4,$5,'keyword.overview',$6,12120,'uncertain',date_trunc('month',now())::date,$7)`,[run,f.workspace,f.connection,f.owner,randomUUID(),'a'.repeat(64),reference]);
  await pool.query(`INSERT INTO keyword_research_run(id,workspace_id,project_id,user_id,quote_id,status,dispatched_at,completed_at,reconciliation_evidence)
    VALUES($1,$2,$3,$4,$5,'uncertain',clock_timestamp()-interval '2 seconds',clock_timestamp(),'{}')`,[run,f.workspace,f.project,f.owner,quote]);
  return {quote,run,fingerprint,reference};
}
async function charge(id:string){return (await pool.query('SELECT status,actual_micros,provider_reference FROM provider_request WHERE id=$1',[id])).rows[0];}
async function capsule(){return (await pool.query("SELECT provider_account_identity FROM installation WHERE id='instance'")).rows[0].provider_account_identity;}
function noVault(){delete process.env.CREDENTIAL_KEYS;delete process.env.CREDENTIAL_ACTIVE_KEY;}
function initialVault(){process.env.CREDENTIAL_KEYS=original.keys;process.env.CREDENTIAL_ACTIVE_KEY=original.active;}
async function rejectMissingCapsule(){
  const saved=await capsule();await pool.query("UPDATE installation SET provider_account_identity=NULL WHERE id='instance'");
  try{
    await assert.rejects(getProviderAccountIdentityKey(2),failed(503));
    await assert.rejects(assertProviderAccountIdentityReadable(),failed(503));
    await assert.rejects(rotateProviderAccountIdentityEncryption(),failed(503));
    assert.equal(await capsule(),null);
    cli('migrate',0);assert.equal(await capsule(),null,'A no-op migrate must never guess missing recovery keys.');
  }finally{await pool.query("UPDATE installation SET provider_account_identity=$1 WHERE id='instance'",[saved]);}
}

try{
  assert.equal((await pool.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','S','f') LIMIT 1")).rowCount,0,'Use an initially empty owned database.');
  const sources=await migrationSources();assert.equal(sources.at(-1)?.version,'0074');
  if(scenario==='ai_search'){
    stage='AI-only modern reference after fresh install';cli('migrate',0);await assertSchema();
    const stable=await getProviderAccountIdentityKey(2),f=await fixture(),prompt=randomUUID(),version=randomUUID(),price=aiSearchPriceEvidence(),seed=await pool.connect();
    try{await seed.query('BEGIN');await seed.query('INSERT INTO project_prompt(id,project_id,current_version_id)VALUES($1,$2,$3)',[prompt,f.project,version]);
      await seed.query("INSERT INTO prompt_text_version(id,project_id,prompt_id,number,text,lower_text,created_by)VALUES($1,$2,$3,1,'Identity fixture','identity fixture',$4)",[version,f.project,prompt,f.owner]);
      await seed.query(`INSERT INTO ai_search_quote(id,workspace_id,project_id,user_id,request_id,prompt_id,version_id,connection_id,connection_revision,account_fingerprint,account_fingerprint_version,input_hash,profile_id,price_version,price_mode,price_source,price_checked_on,estimate_micros,input,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,2,$10,$11,$12,$13,$14,$15,4000,'{"fixture":true}',clock_timestamp()+interval '5 minutes')`,[randomUUID(),f.workspace,f.project,f.owner,randomUUID(),prompt,version,f.connection,'a'.repeat(64),'b'.repeat(64),aiSearchProfileId,price.version,price.mode,price.sourceUrl,price.checkedOn]);
      await seed.query('COMMIT');
    }finally{await seed.query('ROLLBACK').catch(()=>{});seed.release();}
    for(const table of ['keyword_quote','saved_keyword_refresh_plan','rank_run','rank_config','provider_request'])assert.equal((await pool.query(`SELECT 1 FROM ${table}`)).rowCount,0,'Isolate the AI-only recovery reference.');
    const before=digest(await capsule());await rejectMissingCapsule();
    process.env.AUTH_SECRET=randomBytes(32).toString('hex');assert.equal(await getProviderAccountIdentityKey(2),stable);assert.equal(digest(await capsule()),before);
    assert.equal(accountCalls,0);assert.equal(metadataCalls,0);assert.equal(paid,0);
    console.log('PASS AI-only reference blocks all three missing-capsule paths and no-op migration never regenerates it; exact restoration survives login-secret rotation');
  }else if(scenario==='deferred'||scenario==='rank'){
    stage='fresh install without credential vault';noVault();cli('migrate',0);await assertSchema();await assertProviderAccountIdentityReadable();assert.equal(await capsule(),null);
    await assert.rejects(getProviderAccountIdentityKey(2),failed(503));assert.equal(await capsule(),null);assert.equal(accountCalls,0);
    await assert.rejects(readKeywordAccount({login:account,password:'synthetic-never-live'},'overview',send),failed(503));assert.equal(accountCalls,0,'Missing recovery keys must fail before provider account traffic.');assert.equal(await capsule(),null);
    // An existing metadata-only connection must not make quoting invoke a provider without encryption configured.
    const owner=randomUUID(),workspace=randomUUID(),project=randomUUID(),connection=randomUUID();
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Deferred identity\',$2)',[owner,owner+'@identity.integration.test']);
    await pool.query('INSERT INTO workspace(id,name) VALUES($1,\'Deferred identity\')',[workspace]);await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,'Deferred identity','https://identity.integration.test',$3)",[project,workspace,randomUUID()]);
    await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'dataforseo','Metadata only')",[connection,workspace]);
    await pool.query('INSERT INTO keyword_market_catalog(workspace_id,markets) VALUES($1,$2)',[workspace,JSON.stringify([{locationCode:2840,languageCode:'en'}])]);
    await assert.rejects(quoteKeywordResearch(project,owner,{connectionId:connection,mode:'overview',keywords:['identity'],locationCode:2840,languageCode:'en',limit:100},send),failed(503));assert.equal(accountCalls,0);assert.equal(await capsule(),null);
    console.log('PASS fresh no-vault installation remains usable and cannot quote or persist identity keys');
    stage='concurrent deferred initialization';initialVault();const keys=await Promise.all(Array.from({length:12},()=>getProviderAccountIdentityKey(2)));assert.ok(keys.every(key=>key===keys[0]));assert.equal(Buffer.from(keys[0],'base64').length,32);const before=digest(await capsule());
    process.env.AUTH_SECRET=randomBytes(32).toString('hex');assert.equal(await getProviderAccountIdentityKey(2),keys[0]);assert.equal(digest(await capsule()),before);await assertProviderAccountIdentityReadable();
    console.log('PASS concurrent initialization produces one encrypted stable identity across login-secret rotation');
    if(scenario==='rank'){
    stage='approval-only and rank-only missing-capsule guards';
    const rank=await fixture(),rankConfig=randomUUID();
    await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages,approval_account_fingerprint)
      VALUES($1,$2,$3,'Identity reference','identity.integration.test',2840,'United States','Country',2840,'US','en','English',clock_timestamp(),'desktop',10,1,$4)`,[rankConfig,rank.workspace,rank.project,'c'.repeat(64)]);
    assert.equal((await pool.query('SELECT 1 FROM keyword_quote UNION ALL SELECT 1 FROM saved_keyword_refresh_plan UNION ALL SELECT 1 FROM rank_run LIMIT 1')).rowCount,0);
    await rejectMissingCapsule();
    // Clear only this synthetic inactive approval to isolate the rank-run branch.
    await pool.query('UPDATE rank_config SET approval_account_fingerprint=NULL WHERE id=$1',[rankConfig]);
    assert.equal((await pool.query('SELECT 1 FROM rank_config WHERE approval_account_fingerprint IS NOT NULL LIMIT 1')).rowCount,0);
    await pool.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,connection_id,connection_revision,account_fingerprint,connection_name,request,request_hash,task_count,estimate_micros,price_as_of,expires_at)
      VALUES($1,$2,$3,$4,$5,'manual','live','quoted',1,1,$6,1,$7,'Synthetic only','{}',$7,1,10000,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,[randomUUID(),rank.workspace,rank.project,rankConfig,rank.owner,rank.connection,'d'.repeat(64)]);
    await rejectMissingCapsule();assert.equal(await getProviderAccountIdentityKey(2),keys[0]);
    console.log('PASS approval-only and rank-only references independently block key/readiness/rekey replacement; no-op migrate does not repair missing keys');
    }else{
    stage='modern-only missing capsule fails closed';const modern=await fixture();await quoteKeywordResearch(modern.project,modern.owner,modern.request,send);
    assert.ok((await pool.query('SELECT account_fingerprint_version FROM keyword_quote')).rows.every(row=>row.account_fingerprint_version===2));const savedCapsule=await capsule();await pool.query("UPDATE installation SET provider_account_identity=NULL WHERE id='instance'");
    try{await assert.rejects(getProviderAccountIdentityKey(2),failed(503));await assert.rejects(assertProviderAccountIdentityReadable(),failed(503));assert.equal(await capsule(),null);}
    finally{await pool.query("UPDATE installation SET provider_account_identity=$1 WHERE id='instance'",[savedCapsule]);}
    console.log('PASS even modern-only existing quotes prohibit guessing a missing identity capsule');
    }
  }else if(scenario==='upgrade22'){
    stage='seed actual0022 schema and existing encrypted capsule';const client=await pool.connect();
    const priorStable=randomBytes(32).toString('base64');
    const priorEnvelope=encryptCredentials({version:1,legacyV1:original.auth!,stableV2:priorStable},{workspaceId:'instance',id:'provider-account-identity',provider:'dataforseo-account',revision:1});
    try{
      await client.query('BEGIN');await client.query('CREATE TABLE schema_version(version text PRIMARY KEY,checksum text NOT NULL)');
      for(const migration of sources.filter(m=>m.version<='0022')){await client.query(migration.sql);await client.query('INSERT INTO schema_version VALUES($1,$2)',[migration.version,migration.checksum]);}
      await client.query("UPDATE installation SET provider_account_identity=$1 WHERE id='instance'",[priorEnvelope]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const f=await fixture();await legacy(f,original.auth!);
    const storedEnvelope=await capsule();assert.deepEqual(storedEnvelope,priorEnvelope);
    const quotesBefore=digest((await pool.query('SELECT row_to_json(q) AS data FROM keyword_quote q ORDER BY id')).rows);
    async function unchanged22(){
      assert.equal((await pool.query("SELECT 1 FROM schema_version WHERE version>'0022'")).rowCount,0);
      assert.equal((await pool.query("SELECT to_regclass('public.rank_config') AS relation")).rows[0].relation,null);
      assert.equal(digest((await pool.query('SELECT row_to_json(q) AS data FROM keyword_quote q ORDER BY id')).rows),quotesBefore);
    }
    stage='0023 missing-vault upgrade rolls back';noVault();cli('migrate',1);await unchanged22();assert.equal(digest(await capsule()),digest(storedEnvelope));
    stage='0023 cannot recapture a missing legacy capsule';initialVault();process.env.AUTH_SECRET=randomBytes(32).toString('hex');
    await pool.query("UPDATE installation SET provider_account_identity=NULL WHERE id='instance'");
    try{cli('migrate',1);await unchanged22();assert.equal(await capsule(),null);}
    finally{await pool.query("UPDATE installation SET provider_account_identity=$1 WHERE id='instance'",[priorEnvelope]);}
    stage='0023 preserves existing capsule across login-secret rotation';cli('migrate',0);await assertSchema();
    assert.equal(digest(await capsule()),digest(storedEnvelope));assert.equal(await getProviderAccountIdentityKey(1),original.auth);assert.equal(await getProviderAccountIdentityKey(2),priorStable);
    assert.equal(digest((await pool.query('SELECT row_to_json(q) AS data FROM keyword_quote q ORDER BY id')).rows),quotesBefore);
    cli('migrate',0);assert.equal(digest(await capsule()),digest(storedEnvelope));
    console.log('PASS existing0022 capsule preservation,0023 missing-vault/legacy-key rollback, no legacy recapture and idempotent migration');
  }else{
    stage='create actual legacy rows before0022';const client=await pool.connect();
    try{await client.query('BEGIN');await client.query('CREATE TABLE schema_version(version text PRIMARY KEY,checksum text NOT NULL)');for(const migration of sources.filter(m=>m.version<'0022')){await client.query(migration.sql);await client.query('INSERT INTO schema_version VALUES($1,$2)',[migration.version,migration.checksum]);}await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const f=await fixture(),lost=await fixture(),correct=await legacy(f,original.auth!),orphan=await legacy(lost,randomBytes(32).toString('hex'));
    const oldRecords=digest((await pool.query('SELECT id,account_fingerprint,request FROM keyword_quote ORDER BY id')).rows);
    stage='legacy no-vault migration fails atomically';noVault();cli('migrate',1);
    assert.equal((await pool.query("SELECT 1 FROM schema_version WHERE version>='0022'")).rowCount,0);assert.equal((await pool.query("SELECT to_regclass('public.rank_config') AS relation")).rows[0].relation,null);assert.equal((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='installation' AND column_name='provider_account_identity'")).rowCount,0);assert.equal(digest((await pool.query('SELECT id,account_fingerprint,request FROM keyword_quote ORDER BY id')).rows),oldRecords);
    stage='capture legacy identity in0022 transaction';initialVault();cli('migrate',0);await assertSchema();assert.equal(await getProviderAccountIdentityKey(1),original.auth);const stable=await getProviderAccountIdentityKey(2);assert.notEqual(stable,original.auth);assert.equal(digest((await pool.query('SELECT id,account_fingerprint,request FROM keyword_quote ORDER BY id')).rows),oldRecords);
    assert.ok((await pool.query('SELECT account_fingerprint_version FROM keyword_quote')).rows.every(row=>row.account_fingerprint_version===1));
    const encrypted=JSON.stringify(await capsule());assert.ok(!encrypted.includes(original.auth!)&&!encrypted.includes(stable));const firstCapsule=digest(await capsule());cli('migrate',0);assert.equal(digest(await capsule()),firstCapsule);
    console.log('PASS pre0022 hash preservation, missing-vault upgrade rollback and encrypted idempotent capture');

    stage='rotate login secret and recover legacy charge';process.env.AUTH_SECRET=randomBytes(32).toString('hex');await assertProviderAccountIdentityReadable();assert.equal(await getProviderAccountIdentityKey(1),original.auth);assert.equal(await getProviderAccountIdentityKey(2),stable);
    reconcileItems=[{id:correct.reference,url:'v3/dataforseo_labs/google/keyword_overview/live',metadata:keywordPayload(f.request,correct.run),status:'20000',cost:0.01212}];
    returnedAccount='wrong-account@identity.integration.test';const prior=digest(await charge(correct.run)),metadataBefore=metadataCalls;assert.equal((await reconcileKeywordResearch(f.project,f.owner,correct.run,{connectionId:f.connection},send)).reconciliation.status,'inconclusive');assert.equal(digest(await charge(correct.run)),prior);assert.equal(metadataCalls,metadataBefore);
    returnedAccount=account;assert.equal((await reconcileKeywordResearch(f.project,f.owner,correct.run,{connectionId:f.connection},send)).reconciliation.status,'matched');assert.deepEqual(await charge(correct.run),{status:'settled',actual_micros:'12120',provider_reference:correct.reference});assert.equal(paid,0);
    reconcileItems=[{id:orphan.reference,url:'v3/dataforseo_labs/google/keyword_overview/live',metadata:keywordPayload(lost.request,orphan.run),status:'20000',cost:0.01212}];const orphanBefore=digest(await charge(orphan.run));assert.equal((await reconcileKeywordResearch(lost.project,lost.owner,orphan.run,{connectionId:lost.connection},send)).reconciliation.status,'inconclusive');assert.equal(digest(await charge(orphan.run)),orphanBefore);assert.equal((await pool.query('SELECT account_fingerprint FROM keyword_quote WHERE id=$1',[orphan.quote])).rows[0].account_fingerprint,orphan.fingerprint);
    console.log('PASS rotated login secret recovers proven legacy charges; wrong account and already-lost legacy secret fail closed');

    stage='new stable identity quote and saved refresh';const modern=await fixture();const quoted=(await quoteKeywordResearch(modern.project,modern.owner,modern.request,send)).quote;
    const modernBefore=(await pool.query('SELECT account_fingerprint,account_fingerprint_version FROM keyword_quote WHERE id=$1',[quoted.id])).rows[0];assert.equal(modernBefore.account_fingerprint_version,2);
    const saved=await saveSavedKeywords(modern.project,modern.owner,{requestId:randomUUID(),revision:1,source:{type:'manual',keywords:['identity'],locationCode:2840,languageCode:'en'}});
    const plan=(await quoteSavedKeywordRefresh(modern.project,modern.owner,{connectionId:modern.connection,selection:{type:'ids',keywordIds:saved.ids}},send)).quote;
    assert.equal((await pool.query('SELECT account_fingerprint_version FROM saved_keyword_refresh_plan WHERE id=$1',[plan.id])).rows[0].account_fingerprint_version,2);
    assert.ok((await pool.query('SELECT account_fingerprint_version FROM keyword_quote WHERE saved_refresh_plan_id=$1',[plan.id])).rows.every(row=>row.account_fingerprint_version===2));
    const started=(await startSavedKeywordRefresh(modern.project,modern.owner,{quoteId:plan.id,requestKey:randomUUID()})).plan,child=started.children[0];assert.ok(child.runId);
    process.env.AUTH_SECRET=randomBytes(32).toString('hex');const after=(await quoteKeywordResearch(modern.project,modern.owner,modern.request,send)).quote;assert.equal((await pool.query('SELECT account_fingerprint FROM keyword_quote WHERE id=$1',[after.id])).rows[0].account_fingerprint,modernBefore.account_fingerprint);
    await executeKeywordResearch(child.runId!,send);assert.equal(paid,1);assert.equal((await charge(child.runId!)).status,'uncertain');
    reconcileItems=[{id:'synthetic-modern-task',url:'v3/dataforseo_labs/google/keyword_overview/live',metadata:keywordPayload(child.request,child.runId!),status:'20000',cost:0.01212}];
    assert.equal((await reconcileKeywordResearch(modern.project,modern.owner,child.runId!,{connectionId:modern.connection},send)).reconciliation.status,'matched');assert.equal(paid,1,'Reconciliation must not issue a second paid request.');
    console.log('PASS version2 parent and child bindings survive rotation through dispatch and uncertain-charge recovery');

    stage='missing identity capsule cannot be guessed';const savedCapsule=await capsule();await pool.query("UPDATE installation SET provider_account_identity=NULL WHERE id='instance'");
    try{await assert.rejects(getProviderAccountIdentityKey(2),failed(503));await assert.rejects(assertProviderAccountIdentityReadable(),failed(503));await assert.rejects(rotateProviderAccountIdentityEncryption(),failed(503));assert.equal(await capsule(),null);}
    finally{await pool.query("UPDATE installation SET provider_account_identity=$1 WHERE id='instance'",[savedCapsule]);}
    assert.equal(await getProviderAccountIdentityKey(2),stable);

    stage='missing old encryption key must not overwrite identity';const replacement=randomBytes(32).toString('base64'),beforeFailure=digest(await capsule());process.env.CREDENTIAL_KEYS=JSON.stringify({replacement});process.env.CREDENTIAL_ACTIVE_KEY='replacement';
    await assert.rejects(getProviderAccountIdentityKey(2),failed(503));await assert.rejects(assertProviderAccountIdentityReadable(),failed(503));await assert.rejects(rotateProviderAccountIdentityEncryption(),failed(503));assert.equal(digest(await capsule()),beforeFailure);
    stage='keyring rotation preserves both identity versions';process.env.CREDENTIAL_KEYS=JSON.stringify({...JSON.parse(original.keys!),replacement});cli('rekey',0);
    assert.equal((await capsule()).keyId,'replacement');assert.notEqual(digest(await capsule()),beforeFailure);process.env.CREDENTIAL_KEYS=JSON.stringify({replacement});await assertProviderAccountIdentityReadable();await assertCredentialKeys();assert.equal(await getProviderAccountIdentityKey(1),original.auth);assert.equal(await getProviderAccountIdentityKey(2),stable);
    const requoted=(await quoteKeywordResearch(modern.project,modern.owner,modern.request,send)).quote;assert.equal((await pool.query('SELECT account_fingerprint FROM keyword_quote WHERE id=$1',[requoted.id])).rows[0].account_fingerprint,modernBefore.account_fingerprint);
    console.log('PASS missing old key fails without mutation; actual CLI rekey preserves legacy and stable identity');
  }
  assert.equal(unexpected,0);console.log('PASS identity acceptance completed without real provider traffic');
}catch(error){console.error('Provider identity acceptance failed at: '+stage);throw error;}
finally{try{await stopJobs();}finally{globalThis.fetch=original.fetch;process.env.AUTH_SECRET=original.auth;process.env.CREDENTIAL_KEYS=original.keys;process.env.CREDENTIAL_ACTIVE_KEY=original.active;await closeDatabase();}}
