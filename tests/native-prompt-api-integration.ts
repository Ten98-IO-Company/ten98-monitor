import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';
import type {PoolClient} from 'pg';
import {handleApi} from '../src/server/api.ts';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase,assertSchema,migrationSources} from '../src/server/db.ts';
import {apiKeyScopes,authenticateApiKey,createApiKey,revokeApiKey} from '../src/server/api-keys.ts';
import {changeRole,removeMember} from '../src/server/teams.ts';
import {initializeProviderAccountIdentity} from '../src/server/provider-account-identity.ts';
import {getPrompt} from '../src/server/prompts.ts';
import {FoundationError} from '../src/server/auth.ts';
import {runApiKeyChecks} from './api-keys-integration.ts';

// Runnable only against an explicitly created, empty synthetic fixture. HTTP
// requests reach the real handler; PostgreSQL locks provide the delay oracle.
export async function runNativePromptApiChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
  assert.equal(process.env.TEN98_NATIVE_PROMPT_API_TEST,'1');
  const config=getConfig(),database=new URL(config.databaseUrl),origin='http://127.0.0.1:3111';
  assert.equal(database.hostname,'127.0.0.1');const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&database.pathname==='/ten98_prompt_api_ci';assert.equal(database.port,ci?'5432':'55501');
  if(!ci)assert.match(database.pathname,/^\/ten98_prompt_api_[a-f0-9]{12}$/);assert.equal(database.search,'');assert.equal(database.hash,'');
  assert.equal(config.appUrl,origin);
  for(const name of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[name],undefined);
  const {pool}=getDatabase();
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0,'Use a fresh empty database; fixtures are retained.');
  const sources=await migrationSources(),upgrade=sources.find(source=>source.version==='0041')!;assert.equal(upgrade.version,'0041');
  const migration=await pool.connect(),oldUser=randomUUID(),oldWorkspace=randomUUID(),oldKey=randomUUID(),oldToken='t98k_'+randomBytes(32).toString('base64url');
  try{await migration.query('BEGIN');await migration.query('CREATE TABLE schema_version(version text PRIMARY KEY,checksum text NOT NULL)');
   for(const source of sources.filter(source=>source.version<'0041')){await migration.query(source.sql);await migration.query('INSERT INTO schema_version VALUES($1,$2)',[source.version,source.checksum]);}
   await initializeProviderAccountIdentity(migration,true);
   await migration.query(`INSERT INTO "user"(id,name,email) VALUES($1,'Prior key issuer',$2)`,[oldUser,oldUser+'@prompt-api.test']);
   await migration.query(`INSERT INTO workspace(id,name) VALUES($1,'Prior workspace')`,[oldWorkspace]);await migration.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[oldWorkspace,oldUser]);
   await migration.query("INSERT INTO api_key(id,workspace_id,issuer_user_id,name,token_hash,scopes,expires_at) VALUES($1,$2,$3,'Prior key',$4,ARRAY['projects:read','analytics:read'],clock_timestamp()+interval '1 day')",[oldKey,oldWorkspace,oldUser,createHash('sha256').update(oldToken).digest('hex')]);
   await migration.query('COMMIT');
   const before=(await migration.query('SELECT * FROM api_key WHERE id=$1',[oldKey])).rows[0];
   await migration.query('BEGIN');await migration.query(upgrade.sql);await migration.query('INSERT INTO schema_version VALUES($1,$2)',[upgrade.version,upgrade.checksum]);await migration.query('COMMIT');
   assert.deepEqual((await migration.query('SELECT * FROM api_key WHERE id=$1',[oldKey])).rows[0],before);
   // authenticateApiKey also reads workspace_two_factor_requirement (0068), which a 0041 database cannot have: the stored key row is
   // compared byte-for-byte at 0041 above, and the same authentication with the exact grants is asserted after the full upgrade below.
   await migration.query('BEGIN');
   for(const source of sources.filter(source=>source.version>'0041')){await migration.query(source.sql);await migration.query('INSERT INTO schema_version VALUES($1,$2)',[source.version,source.checksum]);}
   await migration.query('COMMIT');
   assert.deepEqual((await migration.query('SELECT * FROM api_key WHERE id=$1',[oldKey])).rows[0],before);
   assert.deepEqual((await authenticateApiKey(oldToken)).scopes,['projects:read','analytics:read']);await assertSchema();
   console.log('PASS actual 40-to-41 migration preserves every prior key field and exact grants without retrogrant');
  }finally{await migration.query('ROLLBACK').catch(()=>{});migration.release();}
  const server=createServer(async(req,res)=>{
    try{
      const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(', '):value);
      const request=new Request(origin+req.url,{method:req.method,headers,...!['GET','HEAD'].includes(req.method??'GET')?{body:Readable.toWeb(req),duplex:'half'}:{}} as RequestInit);
      const response=await handleApi(request);res.statusCode=response.status;
      for(const [name,value]of response.headers)if(name!=='set-cookie')res.setHeader(name,value);
      const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('set-cookie',cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.statusCode=500;res.end('{"error":"Fixture transport failed."}');}
  });
  const http=(path:string,headers:Record<string,string>={},body?:unknown)=>new Promise<{status:number;body:any;cookies:string[]}>((resolve,reject)=>{
    const encoded=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    const req=httpRequest(origin+path,{method:encoded?'POST':'GET',headers:{...headers,...encoded?{'content-type':'application/json','content-length':String(encoded.length),origin}:{}},agent:false},res=>{
      const chunks:Buffer[]=[];let bytes=0;res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>8*1024*1024){req.destroy(new Error('Fixture response exceeded its bound.'));return;}chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>{try{assert.ok(res.complete);resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString('utf8')),cookies:res.headers['set-cookie']??[]});}catch(error){reject(error);}});
    });req.setTimeout(15000,()=>req.destroy(new Error('Fixture HTTP deadline.')));req.on('error',reject);req.end(encoded);
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(3111,'127.0.0.1',resolve);});
  try{
    const setup=await http('/api/setup',{}, {name:'Synthetic key reader',email:randomUUID()+'@key-reads.test',password:randomBytes(32).toString('hex'),workspaceName:'Delayed key reads'});
    assert.equal(setup.status,200);const cookie=setup.cookies.map(value=>value.split(';')[0]).join('; ');assert.ok(cookie);
    const owner=(await pool.query("SELECT user_id,workspace_id FROM membership WHERE role='owner' AND workspace_id<>$1",[oldWorkspace])).rows[0],workspace=owner.workspace_id as string,ownerId=owner.user_id as string;
    const project=randomUUID();await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Prompt fixture','https://prompt-api.test',gen_random_uuid(),'infinity')",[project,workspace]);
    const base='/api/projects/'+project+'/prompts';
    const all=await createApiKey(workspace,ownerId,{name:'All sixteen',scopes:[...apiKeyScopes]}),read=await createApiKey(workspace,ownerId,{name:'Read only',scopes:['prompts:read']}),write=await createApiKey(workspace,ownerId,{name:'Write only',scopes:['prompts:write']});
    const bearer=(token=all.token)=>({authorization:'Bearer '+token});
    const counts=async()=> (await pool.query(`SELECT (SELECT count(*)::int FROM project_prompt WHERE project_id=$1) AS prompts,(SELECT count(*)::int FROM prompt_text_version WHERE project_id=$1) AS versions,(SELECT count(*)::int FROM project_content_request WHERE project_id=$1) AS receipts`,[project])).rows[0];
    const batch={requestId:randomUUID(),prompts:Array.from({length:100},(_,i)=>({text:'Atomic '+i}))};
    const created=await http(base+'/bulk',bearer(write.token),batch);assert.equal(created.status,201);assert.equal(created.body.items.length,100);assert.equal(created.body.replayed,false);
    const first=created.body.items[0];assert.equal(first.enabled,false);assert.equal(first.topic,'General');assert.equal(first.revision,1);
    const replay=await http(base+'/bulk',bearer(write.token),batch);assert.equal(replay.status,201);assert.equal(replay.body.replayed,true);assert.deepEqual(replay.body.items,created.body.items);assert.deepEqual(await counts(),{prompts:100,versions:100,receipts:1});
    const listing=await http(base,bearer(read.token));assert.equal(listing.status,200);assert.equal(listing.body.items.length,50);assert.ok(listing.body.nextCursor);
    const second=await http(base+'?cursor='+listing.body.nextCursor,bearer(read.token));assert.equal(second.status,200);assert.equal(second.body.items.length,50);assert.equal(second.body.nextCursor,null);assert.equal(new Set([...listing.body.items,...second.body.items].map((x:any)=>x.id)).size,100);
    assert.deepEqual((await http(base+'/'+first.id,bearer(read.token))).body,(await http(base+'/'+first.id,{cookie})).body);
    const patch={requestId:randomUUID(),revision:1,text:'Version two',tags:['BRANDED']};const updated=await http(base+'/'+first.id+'/update',bearer(write.token),patch);assert.equal(updated.status,200);assert.equal(updated.body.prompt.revision,2);
    assert.equal((await http(base+'/'+first.id+'/update',bearer(write.token),patch)).body.replayed,true);
    const versions=await http(base+'/'+first.id+'/versions',bearer(read.token));assert.equal(versions.status,200);assert.deepEqual(versions.body.versions.map((x:any)=>x.number),[2,1]);
    const archive=await http(base+'/'+first.id+'/archive',bearer(write.token),{requestId:randomUUID(),revision:2});assert.equal(archive.status,200);assert.ok(archive.body.prompt.archivedAt);
    const restore=await http(base+'/'+first.id+'/restore',bearer(write.token),{requestId:randomUUID(),revision:3});assert.equal(restore.status,200);assert.equal(restore.body.prompt.archivedAt,null);
    assert.equal((await http(base+'/bulk',bearer(write.token),batch)).body.items[0].revision,4,'Receipt returns current DTOs.');
    const concurrent={requestId:randomUUID(),prompts:[{text:'Concurrent replay'}]},concurrentResults=await Promise.all([http(base+'/bulk',bearer(),concurrent),http(base+'/bulk',bearer(),concurrent)]);
    assert.ok(concurrentResults.every(x=>x.status===201));assert.deepEqual(concurrentResults.map(x=>x.body.replayed).sort(),[false,true]);
    const beforeConflict=await counts();assert.equal((await http(base+'/bulk',bearer(),{requestId:randomUUID(),prompts:[{text:'Must roll back'},{text:'Atomic 1'}]})).status,409);assert.deepEqual(await counts(),beforeConflict);
    assert.equal((await http(base+'/bulk',bearer(),{...batch,prompts:[{text:'Changed receipt'}]})).status,409);
    console.log('PASS real HTTP all seven operations, 100 atomic rows, cursors, immutable versions, current-DTO replay and concurrent idempotency');

    const foreign=await createApiKey(oldWorkspace,oldUser,{name:'Other workspace',scopes:['prompts:read','prompts:write']});
    const methods:{path:string;body?:unknown}[]=[{path:base},{path:base+'/'+first.id},{path:base+'/'+first.id+'/versions'},...['bulk','update','archive','restore'].map(action=>({path:action==='bulk'?base+'/bulk':base+'/'+first.id+'/'+action,body:action==='bulk'?{requestId:randomUUID(),prompts:[{text:'Never inserted'}]}:{requestId:randomUUID(),revision:4, ...action==='update'?{topic:'Never updated'}:{}}}))];
    for(const op of methods){const wrong=op.body?read.token:write.token;assert.equal((await http(op.path,bearer(wrong),op.body)).status,403);assert.equal((await http(op.path,bearer(foreign.token),op.body)).status,404);assert.equal((await http(op.path,{...bearer(),cookie},op.body)).status,400);}
    const context='/api/projects/'+project+'/context';assert.equal((await http(context,bearer())).status,200,'context:read admits the full-scope key');assert.equal((await http(context,bearer(read.token))).status,403,'prompts:read must not retrogrant context:read');
    for(const path of ['/api/projects/'+project+'/prompt-executions','/api/projects/'+project+'/ai-suggestions'])assert.equal((await http(path,bearer())).status,403);
    assert.equal((await http(base,{authorization:'Bearer '+oldToken})).status,404);
    const oldSame=await createApiKey(workspace,ownerId,{name:'Original grants',scopes:['projects:read','projects:write','analytics:read','events:write','team:read']});assert.equal((await http(base,bearer(oldSame.token))).status,403);
    const fixtureId=randomUUID(),contentRoutes:{path:string;body?:unknown}[]=[{path:context},{path:context+'/research-log'},{path:context+'/update',body:{requestId:randomUUID(),revision:1}},
      ...['segments','segments/'+fixtureId,'cohorts','cohorts/'+fixtureId,'annotations','annotations/timeline?from=2026-01-01&to=2026-01-02','annotations/'+fixtureId,'rank-trackers','rank-trackers/'+fixtureId,'rank-trackers/'+fixtureId+'/distribution','rank-trackers/'+fixtureId+'/matrix?device=desktop','rank-trackers/'+fixtureId+'/runs','rank-trackers/'+fixtureId+'/results','rank-trackers/'+fixtureId+'/keywords/'+fixtureId+'/history','google','google/imports/'+fixtureId,'domains','domains/'+fixtureId+'/redirect-checks','audits','audits/'+fixtureId,'audits/'+fixtureId+'/issues'].map(suffix=>({path:'/api/projects/'+project+'/'+suffix})),
      {path:'/api/projects/'+project+'/saved-keywords/list',body:{}},{path:'/api/projects/'+project+'/saved-keywords/tags/list',body:{}}];
    assert.equal(contentRoutes.length,26);
    for(const op of contentRoutes)assert.equal((await http(op.path,bearer(oldSame.token),op.body)).status,403,'The five original grants never reach a content route: '+op.path);
    assert.equal((await http('/api/projects/'+project+'/segments',bearer(read.token))).status,403,'prompts:read must not retrogrant segments:read');
    await assert.rejects(getPrompt(project,oldUser,first.id,all.token),(e:unknown)=>e instanceof FoundationError&&e.status===404,'Token cannot be attributed to a different supplied user.');
    const beforeInvalid=await counts();
    for(const input of [{requestId:randomUUID(),prompts:[]},{requestId:randomUUID(),prompts:Array.from({length:101},(_,i)=>({text:'Too many '+i}))},{requestId:randomUUID(),prompts:[{text:'bad',execute:true}]},{requestId:randomUUID(),prompts:[{text:'repeat'},{text:' repeat '}]},{requestId:randomUUID(),prompts:[{text:'\ud800'}]},{requestId:randomUUID(),prompts:[{text:'x'}],execute:true}])assert.equal((await http(base+'/bulk',bearer(),input)).status,400);
    assert.equal((await http(base+'/bulk',bearer(),{requestId:randomUUID(),prompts:[{text:'x'.repeat(270000)}]})).status,413);
    for(const query of ['?q=x&q=y','?unknown=1','?status=deleted','?cursor=invalid'])assert.equal((await http(base+query,bearer())).status,400);
    assert.equal((await http(base+'/'+first.id+'/update',bearer(),{requestId:randomUUID(),revision:4})).status,400);assert.deepEqual(await counts(),beforeInvalid);
    console.log('PASS read/write separation, no retrogrant, tenant/issuer binding, denied paid routes and strict body/query limits');

    async function actor(){const userId=randomUUID();await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Prompt actor\',$2)',[userId,userId+'@prompt-api.test']);await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')",[workspace,userId]);return {userId,...await createApiKey(workspace,userId,{name:'Authority fixture',scopes:[...apiKeyScopes]})};}
    const roles=await actor();assert.deepEqual((await authenticateApiKey(roles.token)).scopes,[...apiKeyScopes]);await changeRole(workspace,ownerId,roles.userId,{role:'editor'});assert.deepEqual((await authenticateApiKey(roles.token)).scopes,apiKeyScopes.filter(s=>s!=='team:read'&&s!=='domains:read'));await changeRole(workspace,ownerId,roles.userId,{role:'viewer'});assert.deepEqual((await authenticateApiKey(roles.token)).scopes,['projects:read','analytics:read','prompts:read','context:read','segments:read','annotations:read','rank:read','keywords:read','google:read','audits:read']);assert.equal((await http(base,bearer(roles.token))).status,200);assert.equal((await http(base+'/bulk',bearer(roles.token),{requestId:randomUUID(),prompts:[{text:'Viewer denied'}]})).status,403);
    console.log('PASS sixteen-grant owner/admin/editor/viewer projections without write-implies-read');
    async function waiting(lock:PoolClient,pattern:string){const end=Date.now()+4000;while(Date.now()<end){await lock.query('SELECT pg_stat_clear_snapshot()');if((await lock.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1",[pattern])).rowCount)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Actual HTTP work did not reach the expected database lock.');}
    for(const writeMode of [false,true])for(const action of ['expiry','revocation','demotion','removal']as const){
     const key=await actor(),lock=await pool.connect();let pending:ReturnType<typeof http>|undefined,mutation:Promise<void>|undefined;
     try{await lock.query('BEGIN');await lock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);
      if(action!=='expiry'){mutation=action==='revocation'?revokeApiKey(workspace,ownerId,key.key.id):action==='demotion'?changeRole(workspace,ownerId,key.userId,{role:'viewer'}):removeMember(workspace,ownerId,key.userId);void mutation.catch(()=>{});await waiting(lock,action==='revocation'?'SELECT id FROM workspace WHERE id=$1 FOR UPDATE':'SELECT id,name FROM workspace WHERE id=$1 FOR UPDATE');}
      pending=http(writeMode?base+'/bulk':base,bearer(key.token),writeMode?{requestId:randomUUID(),prompts:[{text:'Admission '+randomUUID()}]}:undefined);void pending.catch(()=>{});await waiting(lock,'SELECT w.id FROM workspace w JOIN project p ON p.workspace_id=w.id WHERE p.id=$1 FOR % OF w');
      if(action==='expiry')await pool.query("UPDATE api_key SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[key.key.id]);
      await lock.query('COMMIT');await mutation;const response=await pending,expected=action==='demotion'?(writeMode?403:200):401;assert.equal(response.status,expected);if(expected!==200)assert.deepEqual(Object.keys(response.body),['error']);
     }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await mutation?.catch(()=>{});await pending?.catch(()=>{});}
    }
    console.log('PASS eight real workspace admission waits apply current expiry, revocation, role and membership');
    for(const operation of ['list','detail','versions','bulk','update','archive','restore']as const){
     const key=await actor(),lock=await pool.connect(),isWrite=['bulk','update','archive','restore'].includes(operation),before=await counts();let pending:ReturnType<typeof http>|undefined;
     const path=operation==='list'?base:operation==='detail'?base+'/'+first.id:operation==='bulk'?base+'/bulk':base+'/'+first.id+'/'+operation;
     const body=operation==='bulk'?{requestId:randomUUID(),prompts:[{text:'Late expiry '+randomUUID()}]}:isWrite?{requestId:randomUUID(),revision:4,...operation==='update'?{text:'Rolled back version'}:{}}:undefined;
     try{await lock.query('BEGIN');await lock.query(isWrite?'LOCK TABLE project_content_request IN SHARE MODE':'LOCK TABLE project_prompt IN ACCESS EXCLUSIVE MODE');pending=http(path,bearer(key.token),body);void pending.catch(()=>{});
      await waiting(lock,isWrite?'INSERT INTO project_content_request%':operation==='list'?'WITH matches AS%':'SELECT p.id,p.revision,%');
      // Natural expiry while actual work waits. This does not need the held workspace mutation lock.
      await pool.query("UPDATE api_key SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[key.key.id]);
      await lock.query('SELECT pg_sleep(0.2)');assert.equal((await lock.query('SELECT expires_at<=clock_timestamp() AS expired FROM api_key WHERE id=$1',[key.key.id])).rows[0].expired,true);
      await lock.query('COMMIT');const response=await pending;assert.equal(response.status,401,operation+' must refuse publication/commit after expiry');assert.deepEqual(Object.keys(response.body),['error']);assert.deepEqual(await counts(),before,'Late expiry must roll back rows, versions and receipts');
      assert.equal((await http(base+'/'+first.id,bearer(read.token))).body.prompt.revision,4);
     }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}
    }
    console.log('PASS seven late-expiry publication/commit checks, including inserted rows/version/receipt rollback');
    const timeoutKey=await actor(),block=await pool.connect();try{await block.query('BEGIN');await block.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);const start=Date.now(),response=await http(base,bearer(timeoutKey.token));assert.equal(response.status,503);assert.ok(Date.now()-start>=4500&&Date.now()-start<10000);}finally{await block.query('ROLLBACK');block.release();}
    console.log('PASS bounded workspace lock wait returns sanitized retryable response');
    await runApiKeyChecks({baseUrl:origin,appUrl:origin,ownerCookie:cookie,ownerId,workspaceId:workspace});console.log('PASS original API-key integration assertions retained with original five-grant role fixture');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
if(process.env.TEN98_NATIVE_PROMPT_API_TEST==='1')runNativePromptApiChecks().catch(error=>{console.error('FAIL native prompt API integration',error instanceof Error?{name:error.name,message:error.message}:{name:'UnknownError'});process.exitCode=1;}).finally(closeDatabase);
