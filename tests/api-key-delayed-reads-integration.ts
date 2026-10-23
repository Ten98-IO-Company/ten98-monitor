import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';
import type {PoolClient} from 'pg';
import {handleApi} from '../src/server/api.ts';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase,assertSchema} from '../src/server/db.ts';
import {apiKeyScopes,createApiKey,revokeApiKey} from '../src/server/api-keys.ts';
import {changeRole,removeMember} from '../src/server/teams.ts';
import {runApiKeyChecks} from './api-keys-integration.ts';

// Runnable only against an explicitly created, empty synthetic fixture. HTTP
// requests reach the real handler; PostgreSQL locks provide the delay oracle.
export async function runDelayedApiKeyReadChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
  assert.equal(process.env.TEN98_API_KEY_DELAYED_READ_TEST,'1');
  const config=getConfig(),database=new URL(config.databaseUrl),origin='http://127.0.0.1:3111';
  assert.equal(database.hostname,'127.0.0.1');const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&database.pathname==='/ten98_key_reads_ci';assert.equal(database.port,ci?'5432':'55501');
  if(!ci)assert.match(database.pathname,/^\/ten98_key_reads_[a-f0-9]{12}$/);assert.equal(database.search,'');assert.equal(database.hash,'');
  assert.equal(config.appUrl,origin);
  for(const name of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[name],undefined);
  await assertSchema();const {pool}=getDatabase();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
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
    const owner=(await pool.query("SELECT user_id,workspace_id FROM membership WHERE role='owner'")).rows[0],workspace=owner.workspace_id as string,ownerId=owner.user_id as string;
    const project=randomUUID(),visitor='a'.repeat(64),visit='b'.repeat(64),day=new Date().toISOString().slice(0,10);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Synthetic project','https://key-reads.test',gen_random_uuid(),'infinity')",[project,workspace]);
    await pool.query('INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,clock_timestamp(),clock_timestamp())',[project,visitor]);
    await pool.query("INSERT INTO event(id,project_id,event_name,path,visitor_id,visit_id,source,collection_basis) VALUES(gen_random_uuid(),$1,'page_view','/synthetic-retained',$2,$3,'browser','consent')",[project,visitor,visit]);
    const dates='from='+day+'&to='+day,paths={team:'/api/workspaces/'+workspace+'/team',projects:'/api/workspaces/'+workspace+'/projects',events:'/api/projects/'+project+'/events',explore:'/api/projects/'+project+'/explore?'+dates};
    async function memberKey(){const userId=randomUUID();await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Synthetic reader\',$2)',[userId,userId+'@key-reads.test']);await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')",[workspace,userId]);return {userId,...await createApiKey(workspace,userId,{name:'Delayed fixture',scopes:[...apiKeyScopes]})};}
    async function waiting(lock:PoolClient,pattern:string,minimum=1){
      const end=Date.now()+5000;while(Date.now()<end){await lock.query('SELECT pg_stat_clear_snapshot()');const result=await lock.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1",[pattern]);if((result.rowCount??0)>=minimum)return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('The actual request did not reach its expected PostgreSQL lock.');
    }
    const shape=(name:keyof typeof paths,body:any)=>{
      if(name==='team'){assert.ok(body.members.some((row:any)=>row.userId===ownerId));assert.equal(body.workspace.id,workspace);}
      if(name==='projects'){assert.equal(body.projects.find((row:any)=>row.id===project).eventCount,1);}
      if(name==='events'){assert.equal(body.total,1);assert.equal(body.events[0].path,'/synthetic-retained');}
      if(name==='explore'){assert.equal(body.totals.events,1);assert.equal(body.totals.pageViews,1);}
    };
    const all=await createApiKey(workspace,ownerId,{name:'Valid fixture',scopes:[...apiKeyScopes]});
    for(const name of Object.keys(paths)as(keyof typeof paths)[]){const bearer=await http(paths[name],{authorization:'Bearer '+all.token}),browser=await http(paths[name],{cookie});assert.equal(bearer.status,200);assert.equal(browser.status,200);shape(name,bearer.body);shape(name,browser.body);if(name!=='explore')assert.deepEqual(bearer.body,browser.body);}
    console.log('PASS real HTTP valid bearer and unchanged browser DTOs on all four readers');

    for(const name of Object.keys(paths)as(keyof typeof paths)[])for(const action of ['expiry','revocation','demotion','removal']as const){
      const actor=await memberKey(),lock=await pool.connect();let pending:ReturnType<typeof http>|undefined,mutation:Promise<void>|undefined;
      try{
        await lock.query('BEGIN');
        if(name==='team'){
          await lock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);
          // Queue supported mutations first; their lock remains behind this
          // fixture, while the HTTP request still authenticates the valid key.
          if(action!=='expiry'){
            mutation=action==='revocation'?revokeApiKey(workspace,ownerId,actor.key.id):action==='demotion'?changeRole(workspace,ownerId,actor.userId,{role:'viewer'}):removeMember(workspace,ownerId,actor.userId);
            void mutation.catch(()=>{});await waiting(lock,action==='revocation'?'SELECT id FROM workspace WHERE id=$1 FOR UPDATE':'SELECT id,name FROM workspace WHERE id=$1 FOR UPDATE');
          }
        }else await lock.query('LOCK TABLE event IN ACCESS EXCLUSIVE MODE');
        pending=http(paths[name],{authorization:'Bearer '+actor.token});void pending.catch(()=>{});
        await waiting(lock,name==='team'?'SELECT id,name FROM workspace WHERE id=$1 FOR UPDATE':name==='projects'?'SELECT p.id,p.name,p.origin,%':name==='events'?'WITH retained AS MATERIALIZED%':'WITH RECURSIVE target AS MATERIALIZED%',name==='team'&&(action==='demotion'||action==='removal')?2:1);
        if(action==='expiry')await pool.query("UPDATE api_key SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[actor.key.id]);
        else if(name!=='team')await(action==='revocation'?revokeApiKey(workspace,ownerId,actor.key.id):action==='demotion'?changeRole(workspace,ownerId,actor.userId,{role:'viewer'}):removeMember(workspace,ownerId,actor.userId));
        await lock.query('COMMIT');await mutation;const actual=await pending;
        const expected=action==='demotion'?(name==='team'?404:200):action==='removal'&&name==='team'?404:401;
        console.log(JSON.stringify({route:name,action,expected,actual:actual.status,hasData:Object.keys(actual.body).some(key=>key!=='error')}));
        assert.equal(actual.status,expected,name+' must apply current '+action+' authority after delayed work.');
        if(expected===200)shape(name,actual.body);else assert.deepEqual(Object.keys(actual.body),['error']);
      }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await mutation?.catch(()=>{});await pending?.catch(()=>{});}
    }
    console.log('PASS locked HTTP expiry, revocation, demotion and membership removal across all four readers; viewer-readable reports stay readable');

    const limited=await createApiKey(workspace,ownerId,{name:'Wrong scope',scopes:['events:write']}),foreignUser=randomUUID(),foreignWorkspace=randomUUID();
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Foreign owner\',$2)',[foreignUser,foreignUser+'@key-reads.test']);await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Foreign workspace')",[foreignWorkspace]);await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[foreignWorkspace,foreignUser]);const foreign=await createApiKey(foreignWorkspace,foreignUser,{name:'Foreign key',scopes:[...apiKeyScopes]});
    for(const path of Object.values(paths)){
      assert.equal((await http(path,{authorization:'Bearer '+limited.token})).status,403);
      assert.equal((await http(path,{authorization:'Bearer '+foreign.token})).status,404);
      assert.equal((await http(path,{authorization:'Bearer '+all.token,cookie})).status,400);
      assert.equal((await http(path)).status,401);
    }
    const stronger=['/analytics?'+dates,'/realtime','/sessions?'+dates+'&timeZone=UTC','/sessions/'+visitor+'?'+dates+'&timeZone=UTC','/sessions/'+visitor+'/linked-activity?'+dates+'&timeZone=UTC','/context','/segments'];
    for(const suffix of stronger){const path='/api/projects/'+project+suffix,result=await http(path,{authorization:'Bearer '+all.token});assert.equal(result.status,200,suffix);assert.equal((await http(path,{authorization:'Bearer '+limited.token})).status,403);assert.equal((await http(path,{authorization:'Bearer '+foreign.token})).status,404);}
    await revokeApiKey(workspace,ownerId,all.key.id);for(const suffix of stronger)assert.equal((await http('/api/projects/'+project+suffix,{authorization:'Bearer '+all.token})).status,401);
    console.log('PASS exact scope, tenant and credential boundaries; existing analytics/realtime/session readers and the context and segments readers retain their authority gates');
    await runApiKeyChecks({baseUrl:origin,appUrl:origin,ownerCookie:cookie,ownerId,workspaceId:workspace});
    console.log('PASS all original API-key integration oracles preserved unchanged');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}

if(process.env.TEN98_API_KEY_DELAYED_READ_TEST==='1')runDelayedApiKeyReadChecks().catch(error=>{console.error('FAIL delayed API-key integration',error instanceof Error?{name:error.name,message:error.message}:{name:'UnknownError'});process.exitCode=1;}).finally(closeDatabase);
