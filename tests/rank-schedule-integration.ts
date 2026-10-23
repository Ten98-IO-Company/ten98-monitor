import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase,migrationSources,assertSchema} from '../src/server/db.ts';

// Explicit, disposable local fixture only. Applies actual registered migrations
// through the production CLI; never changes an existing installation.
// node --env-file=<private synthetic env> tests/rank-schedule-integration.ts
// Requires TEN98_INTEGRATION_TEST=1. Leaves all evidence; never drops/resets data.
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1','Explicit integration opt-in required.');
const config=getConfig(),database=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
assert.ok(local.includes(database.hostname)&&local.includes(new URL(config.appUrl).hostname));
const hostedCi=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&database.pathname==='/ten98_rank_schedule_ci';
assert.equal(database.port,hostedCi?'5432':'55501');assert.equal(database.search,'');assert.equal(database.hash,'');
assert.match(database.pathname,/^\/ten98_rank_schedule_[a-z0-9_]+$/);
const {pool}=getDatabase();let stage='empty fixture safety check';
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Provider traffic is forbidden in rank schedule checks.');};
type Interval='daily'|'weekly'|'monthly';
async function next(interval:Interval,zone:string,hour:number,minute:number,weekday:number|null,after:string){
  const row=(await pool.query<{due:Date}>('SELECT rank_next_due($1,$2,$3,$4,$5,$6::timestamptz) AS due',[interval,zone,hour,minute,weekday,after])).rows[0];
  return row.due.toISOString();
}
const stateCode=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===code;
try{
  assert.equal((await pool.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','S','f') LIMIT 1")).rowCount,0,'Use a fresh empty owned rank schedule database.');
  stage='base and new migration';
  const versions=(await migrationSources()).map(source=>source.version);
  for(const required of ['0023','0024'])assert.ok(versions.includes(required),'Rank migrations must remain registered.');
  const noNetwork='data:text/javascript,'+encodeURIComponent("globalThis.fetch=async()=>{throw new Error('Provider traffic forbidden in migration');}");
  const migrated=spawnSync(process.execPath,['--import',noNetwork,join(process.cwd(),'src/server/cli.ts'),'migrate'],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:45_000,maxBuffer:256_000,windowsHide:true});
  assert.equal(migrated.status,0,'Base migration failed (inspect privately; configuration is never printed).');
  for(const secret of [config.databaseUrl,config.authSecret,process.env.CREDENTIAL_KEYS])if(secret)assert.ok(!(migrated.stdout+migrated.stderr).includes(secret),'Migration output exposed private configuration.');
  await assertSchema();
  assert.deepEqual((await pool.query<{version:string}>('SELECT version FROM schema_version ORDER BY version')).rows.map(row=>row.version),versions);
  console.log(`PASS fresh registered${versions[0]}–${versions.at(-1)} migration through production CLI`);

  stage='New York gap and fold';
  assert.equal(await next('daily','America/New_York',2,30,null,'2026-03-08T05:00:00Z'),'2026-03-08T07:30:00.000Z');
  assert.equal(await next('daily','America/New_York',2,30,null,'2026-03-08T07:30:00Z'),'2026-03-09T06:30:00.000Z');
  assert.equal(await next('daily','America/New_York',1,30,null,'2026-11-01T05:30:00Z'),'2026-11-01T06:30:00.000Z');
  assert.equal(await next('daily','America/New_York',1,30,null,'2026-11-01T06:30:00Z'),'2026-11-02T06:30:00.000Z');
  console.log('PASS New York nonexistent time moves forward and repeated time runs once at later occurrence');

  stage='half-hour and skipped-date transitions';
  assert.equal(await next('daily','Australia/Lord_Howe',2,15,null,'2026-10-03T13:00:00Z'),'2026-10-03T15:45:00.000Z');
  assert.equal(await next('daily','Australia/Lord_Howe',1,45,null,'2026-04-04T14:50:00Z'),'2026-04-04T15:15:00.000Z');
  assert.equal(await next('daily','Pacific/Apia',9,0,null,'2011-12-29T20:00:00Z'),'2011-12-30T19:00:00.000Z');
  assert.equal(await next('daily','Pacific/Apia',9,0,null,'2011-12-30T19:00:00Z'),'2011-12-31T19:00:00.000Z');
  assert.equal(await next('weekly','Pacific/Apia',9,0,5,'2011-12-29T20:00:00Z'),'2011-12-30T19:00:00.000Z');
  assert.equal(await next('weekly','Pacific/Apia',9,0,5,'2011-12-30T19:00:00Z'),'2012-01-05T19:00:00.000Z');
  console.log('PASS Lord Howe half-hour changes and Apia skipped civil date without duplicate occurrence');

  stage='calendar and exclusive cutoff';
  assert.equal(await next('monthly','UTC',9,0,null,'2024-01-31T09:00:00Z'),'2024-02-29T09:00:00.000Z');
  assert.equal(await next('monthly','UTC',9,0,null,'2025-01-31T09:00:00Z'),'2025-02-28T09:00:00.000Z');
  assert.equal(await next('monthly','Pacific/Kiritimati',23,30,null,'2024-01-31T00:00:00Z'),'2024-01-31T09:30:00.000Z');
  assert.equal(await next('daily','UTC',9,0,null,'2026-10-13T08:59:59.999999Z'),'2026-10-13T09:00:00.000Z');
  assert.equal(await next('daily','UTC',9,0,null,'2026-10-13T09:00:00Z'),'2026-10-14T09:00:00.000Z');
  assert.equal(await next('daily','UTC',9,0,null,'2026-10-13T09:00:00.000001Z'),'2026-10-14T09:00:00.000Z');
  assert.equal(await next('weekly','UTC',9,0,1,'2026-10-13T12:00:00Z'),'2026-10-19T09:00:00.000Z');
  assert.equal(await next('monthly','UTC',9,0,null,'2026-10-13T12:00:00Z'),'2026-10-31T09:00:00.000Z');
  // A restart months after an old due date starts from current time, not old anchor.
  assert.equal(await next('weekly','UTC',9,0,1,'2027-02-04T12:00:00Z'),'2027-02-08T09:00:00.000Z');
  console.log('PASS leap/non-leap local month ends, exact microsecond boundary and downtime advancement');

  stage='invalid recurrence inputs';
  const valid:unknown[]=['daily','UTC',9,0,null,'2026-10-13T00:00:00Z'];
  const invalid:unknown[][]=[['hourly',...valid.slice(1)],['manual',...valid.slice(1)],['daily','not/a-zone',9,0,null,valid[5]],['daily','UTC',24,0,null,valid[5]],['daily','UTC',9,60,null,valid[5]],['weekly','UTC',9,0,null,valid[5]],['weekly','UTC',9,0,7,valid[5]],['monthly','UTC',9,0,1,valid[5]],['daily','UTC',9,0,null,'infinity'],['daily','UTC',9,0,null,'-infinity']];
  for(const index of [0,1,2,3,5]){const values=[...valid];values[index]=null;invalid.push(values);}
  for(const values of invalid)await assert.rejects(pool.query('SELECT rank_next_due($1,$2,$3,$4,$5,$6::timestamptz)',values),error=>stateCode('P0001')(error)&&error instanceof Error&&error.message==='Invalid rank schedule');
  console.log('PASS invalid/null/nonfinite inputs fail with a fixed safe error');

  stage='schema scope and rank provenance';
  const owner=randomUUID(),workspace=randomUUID(),project=randomUUID(),foreignProject=randomUUID(),configId=randomUUID(),connection=randomUUID(),run=randomUUID(),dispatch=randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Rank fixture\',$2)',[owner,owner+'@rank-schedule.integration.test']);
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Rank fixture')",[workspace]);
  for(const [id,origin]of[[project,'https://rank.integration.test'],[foreignProject,'https://foreign-rank.integration.test']])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,'Rank fixture',$3,$4)",[id,workspace,origin,randomUUID()]);
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'dataforseo','Synthetic only')",[connection,workspace]);
  await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
    VALUES($1,$2,$3,'rank.integration.test','rank.integration.test',2840,'United States','Country',2840,'US','en','English',clock_timestamp(),'both',100,1)`,[configId,workspace,project]);
  assert.equal((await pool.query('SELECT max_crawl_pages FROM rank_config WHERE id=$1',[configId])).rows[0].max_crawl_pages,1,'Page cap is independent from requested depth.');
  await assert.rejects(pool.query('UPDATE rank_config SET revision=2147483647 WHERE id=$1',[configId]),stateCode('23514'));
  await assert.rejects(pool.query("INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword) VALUES($1,$2,$3,$4,'foreign')",[randomUUID(),workspace,foreignProject,configId]),stateCode('23503'));
  await pool.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,connection_id,connection_revision,account_fingerprint,connection_name,request,request_hash,task_count,estimate_micros,price_as_of,expires_at,request_key,started_at)
    VALUES($1,$2,$3,$4,$5,'manual','queued','queued',1,1,$6,1,$7,'Synthetic only','{}',$7,3,10000,clock_timestamp(),clock_timestamp()+interval '5 minutes',$8,clock_timestamp())`,[run,workspace,project,configId,owner,connection,'a'.repeat(64),randomUUID()]);
  await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,status,budget_month)
    VALUES($1,$2,$3,1,$4,$5,'rank.queued',$6,10000,'reserved','2026-10-01')`,[dispatch,workspace,connection,owner,randomUUID(),'b'.repeat(64)]);
  await pool.query(`INSERT INTO rank_dispatch(id,workspace_id,project_id,run_id,ordinal,method,task_count,request,request_hash,phase)
    VALUES($1,$2,$3,$4,0,'queued',3,'[{},{},{}]',$5,'reserved')`,[dispatch,workspace,project,run,'c'.repeat(64)]);
  const keyword=randomUUID();
  await pool.query(`INSERT INTO rank_task(id,workspace_id,project_id,run_id,dispatch_id,keyword_id,keyword,match_case,device,result_status,checked_depth,returned_item_count,observed_at,retrieved_at)
    VALUES($1,$2,$3,$4,$5,$6,'no organic results',false,'desktop','not_found',0,0,clock_timestamp(),clock_timestamp())`,[randomUUID(),workspace,project,run,dispatch,keyword]);
  const ranked=randomUUID();
  await pool.query(`INSERT INTO rank_task(id,workspace_id,project_id,run_id,dispatch_id,keyword_id,keyword,match_case,device,result_status,position,rank_basis,absolute_position,ranking_url,checked_depth,returned_item_count,observed_at,retrieved_at)
    VALUES($1,$2,$3,$4,$5,$6,'absolute fallback',false,'mobile','ranked',7,'absolute',7,'https://rank.integration.test/',3,10,clock_timestamp(),clock_timestamp())`,[ranked,workspace,project,run,dispatch,keyword]);
  await assert.rejects(pool.query('UPDATE rank_task SET absolute_position=8 WHERE id=$1',[ranked]),stateCode('23514'));
  await assert.rejects(pool.query('UPDATE rank_task SET returned_item_count=10001 WHERE id=$1',[ranked]),stateCode('23514'));
  await assert.rejects(pool.query('UPDATE rank_task SET project_id=$2 WHERE id=$1',[ranked,foreignProject]),stateCode('23503'));
  await pool.query('UPDATE rank_task SET position=NULL,rank_basis=NULL,absolute_position=NULL,ranking_url=NULL,serp_features=NULL,raw_evidence=NULL,data_expired_at=clock_timestamp() WHERE id=$1',[ranked]);
  assert.equal((await pool.query('SELECT result_status FROM rank_task WHERE id=$1',[ranked])).rows[0].result_status,'ranked','Expiry preserves the observation outcome.');
  console.log('PASS composite tenant scope, bounded integer revisions, independent page cap, zero coverage and explicit absolute fallback provenance');
}catch(error){console.error('FAIL rank schedule integration at '+stage);throw error;}
finally{globalThis.fetch=originalFetch;await closeDatabase();}
