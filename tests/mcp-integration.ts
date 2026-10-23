import assert from 'node:assert/strict';
import appManifest from '../package.json' with {type:'json'};
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {createRequire} from 'node:module';
import type {PoolClient} from 'pg';
import {handleApi} from '../src/server/api.ts';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase,migrationSources,assertSchema} from '../src/server/db.ts';
import {initializeProviderAccountIdentity} from '../src/server/provider-account-identity.ts';
import {apiKeyScopes,createApiKey,revokeApiKey} from '../src/server/api-keys.ts';
import {changeRole,removeMember} from '../src/server/teams.ts';
import {mcpTools} from '../src/server/mcp-tools.ts';

export async function runMcpChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_MCP_TEST,'1');
  const config=getConfig(),database=new URL(config.databaseUrl),origin='http://127.0.0.1:3111';
  assert.equal(database.hostname,'127.0.0.1');const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&database.pathname==='/ten98_mcp_ci';assert.equal(database.port,ci?'5432':'55501');if(!ci)assert.match(database.pathname,/^\/ten98_mcp_[a-f0-9]{12}$/);assert.equal(database.search,'');assert.equal(config.appUrl,origin);
  for(const name of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[name],undefined);
  const {pool}=getDatabase();
  // Saturate the current and next minute so a request that crosses a minute boundary still sees the limit; clear both rows once the 429 block ends so the seed cannot leak into later steps.
  const seedLimit=(key:string,count:number)=>pool.query("INSERT INTO request_limit(key,minute,count) SELECT $1,floor(extract(epoch FROM now())/60)+n,$2::integer FROM generate_series(0,1) n ON CONFLICT(key,minute) DO UPDATE SET count=excluded.count",[key,count]);
  const clearLimit=(key:string)=>pool.query('DELETE FROM request_limit WHERE key=$1',[key]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
  const client=await pool.connect();try{await client.query('BEGIN');await client.query('CREATE TABLE schema_version(version text PRIMARY KEY,checksum text NOT NULL)');for(const source of await migrationSources()){await client.query(source.sql);await client.query('INSERT INTO schema_version VALUES($1,$2)',[source.version,source.checksum]);}await initializeProviderAccountIdentity(client,true);await client.query('COMMIT');}finally{client.release();}await assertSchema();
  // Use the production server's lazy Node request adapter; eager toWeb consumes bodies even when headers reject them.
  const {toNodeHandler}=createRequire(import.meta.resolve('nitro/package.json'))('srvx/node');
  const server=createServer(toNodeHandler(handleApi));
  const http=(path:string,headers:Record<string,string>={},body?:unknown,method=body===undefined?'GET':'POST',raw?:Buffer)=>new Promise<{status:number;wire:any;headers:Record<string,any>;bytes:number;complete:boolean}>((resolve,reject)=>{
    const bytes=raw??(body===undefined?undefined:Buffer.from(JSON.stringify(body)));const req=httpRequest(origin+path,{method,agent:false,headers:{...bytes?{'content-type':'application/json','content-length':String(bytes.length)}:{},...headers}},res=>{
      const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{try{assert.equal(res.complete,true);const text=Buffer.concat(chunks).toString('utf8'),line=text.split('\n').find(x=>x.startsWith('data: {'));resolve({status:res.statusCode!,wire:text?JSON.parse(line?line.slice(6):text):null,headers:res.headers,bytes:Buffer.byteLength(text),complete:res.complete});}catch(error){reject(error);}});
    });req.setTimeout(15000,()=>req.destroy(new Error('Fixture HTTP deadline.')));req.on('error',error=>reject(new Error(`Fixture HTTP ${method} ${(body as {method?:string;id?:number}|undefined)?.method??'raw'} id=${(body as {id?:number}|undefined)?.id??'none'} bytes=${bytes?.length??0} failed: ${(error as {code?:string}).code??error.name}`)));req.end(bytes);
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(3111,'127.0.0.1',resolve);});
  try{
    const setup=await http('/api/setup',{origin},{name:'MCP fixture',email:randomUUID()+'@mcp.test',password:randomBytes(32).toString('hex'),workspaceName:'MCP synthetic'});assert.equal(setup.status,200);
    const owner=(await pool.query("SELECT user_id,workspace_id FROM membership WHERE role='owner'")).rows[0],workspace=owner.workspace_id as string,ownerId=owner.user_id as string,project=randomUUID(),visitor='a'.repeat(64);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'MCP project','https://mcp.test',gen_random_uuid(),'infinity')",[project,workspace]);
    await pool.query('INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,clock_timestamp(),clock_timestamp())',[project,visitor]);
    await pool.query("INSERT INTO event(id,project_id,event_name,path,source,metric_version,collection_basis,visitor_id,visit_id) VALUES($1,$2,'page_view','/mcp','browser','native-v1','cookieless',$3,$4)",[randomUUID(),project,visitor,'b'.repeat(64)]);
    const all=await createApiKey(workspace,ownerId,{name:'MCP all',scopes:[...apiKeyScopes]}),read=await createApiKey(workspace,ownerId,{name:'MCP read',scopes:['prompts:read']}),write=await createApiKey(workspace,ownerId,{name:'MCP write',scopes:['prompts:write']});
    let sequence=0;
    function rpc(method:string,params:Record<string,unknown>={},token=all.token,modern=true,headers:Record<string,string>={}){
      const meta=modern?{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}:{};
      return http('/api/mcp',{authorization:'Bearer '+token,accept:'application/json, text/event-stream','mcp-protocol-version':modern?'2026-07-28':'2025-11-25',...modern?{'mcp-method':method,...method==='tools/call'?{'mcp-name':String(params.name)}:{}}:{},...headers},{jsonrpc:'2.0',id:++sequence,method,params:{...params,...meta}});
    }
    const call=(name:string,args:Record<string,unknown>,token=all.token,modern=true)=>rpc('tools/call',{name,arguments:args},token,modern);
    const data=(response:Awaited<ReturnType<typeof rpc>>)=>{assert.equal(response.status,200,JSON.stringify(response.wire));assert.equal(response.wire.result?.isError,undefined,JSON.stringify(response.wire));assert.ok(response.bytes<=8*1024*1024);assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['mcp-session-id'],undefined);const result=response.wire.result;assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);return result.structuredContent;};
    for(const modern of [true,false]){
      const listed=await rpc('tools/list',{},all.token,modern);assert.equal(listed.status,200);assert.deepEqual(listed.wire.result.tools.map((x:any)=>x.name),mcpTools.map(t=>t.name));assert.equal(listed.headers['mcp-session-id'],undefined);
      const who=data(await call('ten98_whoami',{},all.token,modern));assert.equal(who.workspaceId,workspace);assert.equal(who.userId,ownerId);assert.equal(who.tools.length,38);
    }
    const discovery=await rpc('server/discover');assert.equal(discovery.status,200);assert.equal(discovery.wire.result.capabilities.tools.listChanged,false);for(const cap of ['tasks','resources','prompts','sampling'])assert.equal(discovery.wire.result.capabilities[cap],undefined);
    const init=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'native-protocol-fixture',version:'1'}},all.token,false);assert.equal(init.status,200);assert.equal(init.wire.result.protocolVersion,'2025-11-25');assert.equal(init.wire.result.serverInfo.version,appManifest.version);
    const subscription=await rpc('subscriptions/listen',{subscriptions:[]});assert.equal(subscription.status,200);assert.ok(subscription.wire.error);assert.equal(subscription.complete,true);
    console.log('PASS actual HTTP modern/legacy discovery, safe whoami, finite transports and no advertised extra capabilities');
    // The lane owner has no verified factor: while the workspace requires one, the key is refused on every invocation, then resumes.
    await pool.query('INSERT INTO workspace_two_factor_requirement(workspace_id) VALUES($1)',[workspace]);
    try{const suspended=await rpc('tools/list');assert.equal(suspended.status,401);assert.equal(suspended.wire.error.message,'A valid native Bearer API key is required.');}
    finally{await pool.query('DELETE FROM workspace_two_factor_requirement WHERE workspace_id=$1',[workspace]);}
    assert.equal((await rpc('tools/list')).status,200);assert.equal((await pool.query('SELECT 1 FROM api_key WHERE id=$1 AND revoked_at IS NULL',[all.key.id])).rowCount,1);
    console.log('PASS MCP refuses a key whose issuer lacks the factor a workspace two-factor requirement demands, without revoking it, and resumes when the requirement is lifted');

    const date=(await pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS date")).rows[0].date,calendar={from:date,to:date,timeZone:'UTC'};
    assert.equal(data(await call('ten98_read_analytics',{projectId:project,query:{from:date,to:date,compare:'prev',geoDetail:'city',geoSearch:'',geoPeriod:'comparison'}})).totals.pageViews,1);
    assert.equal(data(await call('ten98_read_realtime',{projectId:project})).totals.pageViews,1);
    assert.equal(data(await call('ten98_list_sessions',{projectId:project,query:calendar})).rows.length,1);
    assert.equal(data(await call('ten98_read_session',{projectId:project,visitorKey:visitor,query:calendar})).activity.length,1);
    assert.equal(data(await call('ten98_read_linked_activity',{projectId:project,visitorKey:visitor,query:calendar})).selection.status,'unavailable');
    const batch={projectId:project,requestId:randomUUID(),prompts:Array.from({length:100},(_,i)=>({text:'MCP authored '+i}))};
    const created=data(await call('ten98_create_prompts',batch,write.token));assert.equal(created.committed,true);assert.equal(created.items.length,100);assert.equal(created.replayed,false);assert.equal(created.items[0].text,undefined);
    const replay=data(await call('ten98_create_prompts',batch,write.token,false));assert.equal(replay.replayed,true);assert.deepEqual(replay.items,created.items);
    const promptId=created.items[0].id,list=data(await call('ten98_list_prompts',{projectId:project},read.token));assert.equal(list.items.length,50);assert.ok(list.nextCursor);
    assert.equal(data(await call('ten98_list_prompts',{projectId:project,query:{cursor:list.nextCursor}},read.token)).items.length,50);
    assert.equal(data(await call('ten98_read_prompt',{projectId:project,promptId},read.token)).prompt.text,'MCP authored 0');
    const update={projectId:project,promptId,requestId:randomUUID(),revision:1,text:'MCP edited'};
    assert.equal(data(await call('ten98_update_prompt',update,write.token)).items[0].revision,2);assert.equal(data(await call('ten98_update_prompt',update,write.token)).replayed,true);
    assert.deepEqual(data(await call('ten98_list_prompt_versions',{projectId:project,promptId},read.token)).versions.map((x:any)=>x.number),[2,1]);
    assert.ok(data(await call('ten98_archive_prompt',{projectId:project,promptId,requestId:randomUUID(),revision:2},write.token)).items[0].archivedAt);
    assert.equal(data(await call('ten98_restore_prompt',{projectId:project,promptId,requestId:randomUUID(),revision:3},write.token)).items[0].archivedAt,null);
    const counts=async()=> (await pool.query(`SELECT (SELECT count(*)::int FROM project_prompt WHERE project_id=$1) AS prompts,(SELECT count(*)::int FROM prompt_text_version WHERE project_id=$1) AS versions,(SELECT count(*)::int FROM project_content_request WHERE project_id=$1) AS receipts`,[project])).rows[0];
    assert.deepEqual(await counts(),{prompts:100,versions:101,receipts:4});
    const concurrent={projectId:project,requestId:randomUUID(),prompts:[{text:'MCP concurrent'}]},both=await Promise.all([call('ten98_create_prompts',concurrent),call('ten98_create_prompts',concurrent)]);assert.deepEqual(both.map(r=>data(r).replayed).sort(),[false,true]);
    const before=await counts();const conflict=await call('ten98_create_prompts',{projectId:project,requestId:randomUUID(),prompts:[{text:'Rollback me'},{text:'MCP authored 1'}]});assert.equal(conflict.wire.result.structuredContent.error.status,409);assert.deepEqual(await counts(),before);
    assert.equal((await call('ten98_create_prompts',{...batch,prompts:[{text:'Changed receipt'}]})).wire.result.structuredContent.error.status,409);
    console.log('PASS all 13 actual native tools, null/zero semantics, 100 atomic prompts, pagination, receipts and concurrent replay');

    for(const [token,count]of [[read.token,4],[write.token,5]]as const)assert.equal((await rpc('tools/list',{},token)).wire.result.tools.length,count);
    assert.ok((await call('ten98_read_prompt',{projectId:project,promptId},write.token)).wire.error);assert.ok((await call('ten98_create_prompts',concurrent,read.token)).wire.error);
    const foreignWorkspace=randomUUID(),foreignProject=randomUUID();await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Foreign')",[foreignWorkspace]);await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,'Foreign','https://foreign-mcp.test',gen_random_uuid())",[foreignProject,foreignWorkspace]);
    for(const name of ['ten98_read_analytics','ten98_list_prompts','ten98_create_prompts']){const denied=await call(name,{projectId:foreignProject,...name==='ten98_create_prompts'?{requestId:randomUUID(),prompts:[{text:'Never'}]}:{}});assert.equal(denied.wire.result.structuredContent.error.status,404);assert.equal(JSON.stringify(denied.wire).includes(foreignProject),false);}
    for(const headers of [{cookie:'session=fake'},{'x-api-key':'fake'},{authorization:'Basic nope'}]as Record<string,string>[])assert.ok([400,401].includes((await rpc('tools/list',{},all.token,true,headers)).status));
    for(const value of ['', 'null','http://127.0.0.1:3112','https://127.0.0.1:3111',origin+'/',origin+', '+origin])assert.equal((await rpc('tools/list',{},all.token,true,{origin:value})).status,403);
    assert.equal((await rpc('tools/list',{},all.token,true,{origin})).status,200);
    for(const headers of [{'mcp-protocol-version':'2025-11-25'},{'mcp-method':'ping'},{'mcp-protocol-version':''},{'mcp-method':''}]as Record<string,string>[])assert.equal((await rpc('tools/list',{},all.token,true,headers)).status,400);
    assert.equal((await rpc('tools/call',{name:'ten98_whoami',arguments:{}},all.token,true,{'mcp-name':'different'})).status,400);
    for(const payload of [[],null,42,{jsonrpc:'2.0',id:'x'.repeat(129),method:'tools/list'},{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'constructor',arguments:{}}}])assert.equal((await http('/api/mcp',{authorization:'Bearer '+all.token},payload)).status,400);
    assert.equal((await http('/api/mcp',{authorization:'Bearer '+all.token},undefined,'POST',Buffer.from([0xc3,0x28]))).status,400);
    assert.equal((await http('/api/mcp',{authorization:'Bearer '+all.token},undefined,'POST',Buffer.alloc(262145,0x20))).status,413);
    assert.equal((await http('/api/mcp',{authorization:'Bearer '+all.token,'content-type':'text/plain'},{})).status,415);
    for(const method of ['GET','PUT','PATCH','DELETE','OPTIONS'])assert.equal((await http('/api/mcp',{},undefined,method)).status,405);
    assert.equal((await http('/api/mcp?token=forbidden',{},{})).status,400);
    for(const [name,args]of [['ten98_read_realtime',{projectId:project,query:{}}],['ten98_read_analytics',{projectId:project,query:{from:'2025-02-30',to:'2025-03-01'}}],['ten98_list_sessions',{projectId:project,query:{...calendar,groupBy:'country'}}],['ten98_create_prompts',{projectId:project,requestId:randomUUID(),prompts:[{text:'x',execute:true}]}]]as const){const denied=await call(name,args);assert.ok(denied.status===400||denied.wire.result?.structuredContent?.error?.status===400);}
    console.log('PASS scoped discovery, tenant boundaries, Origin/auth rejection, protocol metadata and strict native input limits');

    async function actor(){const userId=randomUUID();await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'MCP actor\',$2)',[userId,userId+'@mcp.test']);await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')",[workspace,userId]);return {userId,...await createApiKey(workspace,userId,{name:'MCP delayed authority',scopes:[...apiKeyScopes]})};}
    async function waiting(lock:PoolClient,pattern:string){const end=Date.now()+4000;while(Date.now()<end){await lock.query('SELECT pg_stat_clear_snapshot()');if((await lock.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1",[pattern])).rowCount)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Real HTTP work did not reach the expected lock.');}
    for(const writeMode of [false,true])for(const action of ['expiry','revocation','demotion','removal']as const){
      const key=await actor(),lock=await pool.connect(),before=await counts();let pending:ReturnType<typeof call>|undefined,mutation:Promise<void>|undefined;
      try{await lock.query('BEGIN');await lock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);
        if(action!=='expiry'){mutation=action==='revocation'?revokeApiKey(workspace,ownerId,key.key.id):action==='demotion'?changeRole(workspace,ownerId,key.userId,{role:'viewer'}):removeMember(workspace,ownerId,key.userId);void mutation.catch(()=>{});await waiting(lock,action==='revocation'?'SELECT id FROM workspace WHERE id=$1 FOR UPDATE':'SELECT id,name FROM workspace WHERE id=$1 FOR UPDATE');}
        pending=call(writeMode?'ten98_create_prompts':'ten98_list_prompts',{projectId:project,...writeMode?{requestId:randomUUID(),prompts:[{text:'Denied '+randomUUID()}]}:{}},key.token);void pending.catch(()=>{});await waiting(lock,'SELECT w.id FROM workspace w JOIN project p ON p.workspace_id=w.id WHERE p.id=$1 FOR % OF w');
        if(action==='expiry')await pool.query("UPDATE api_key SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[key.key.id]);
        await lock.query('COMMIT');await mutation;const result=await pending;assert.equal(result.status,action==='demotion'?403:401);assert.ok(result.wire.error);assert.equal(result.wire.result,undefined);assert.deepEqual(await counts(),before);
      }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await mutation?.catch(()=>{});await pending?.catch(()=>{});}
    }
    console.log('PASS eight real admission waits deny expiry/revocation/demotion/removal without disclosure or new receipts');

    for(const writeMode of [false,true]){
      const key=await actor(),lock=await pool.connect(),before=await counts();let pending:ReturnType<typeof call>|undefined;
      try{await lock.query('BEGIN');await lock.query(writeMode?'LOCK TABLE project_content_request IN SHARE MODE':'LOCK TABLE project_prompt IN ACCESS EXCLUSIVE MODE');pending=call(writeMode?'ten98_create_prompts':'ten98_read_prompt',{projectId:project,...writeMode?{requestId:randomUUID(),prompts:[{text:'Late rollback '+randomUUID()}]}:{promptId}},key.token);void pending.catch(()=>{});await waiting(lock,writeMode?'INSERT INTO project_content_request%':'SELECT p.id,p.revision,%');
        await pool.query("UPDATE api_key SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[key.key.id]);await lock.query('SELECT pg_sleep(0.2)');await lock.query('COMMIT');const result=await pending;assert.equal(result.status,401);assert.deepEqual(await counts(),before);
      }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}
    }
    for(const method of ['tools/list','server/discover','tools/call']){
      const key=await actor(),lock=await pool.connect();let pending:ReturnType<typeof rpc>|undefined;
      try{await lock.query('BEGIN');await lock.query('LOCK TABLE request_limit IN ACCESS EXCLUSIVE MODE');pending=rpc(method,method==='tools/call'?{name:'ten98_whoami',arguments:{}}:{},key.token);void pending.catch(()=>{});await waiting(lock,'WITH expired AS%');await pool.query('UPDATE api_key SET revoked_at=clock_timestamp() WHERE id=$1',[key.key.id]);await lock.query('COMMIT');const result=await pending;assert.equal(result.status,401);assert.equal(result.wire.result,undefined);
      }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}
    }
    console.log('PASS late mutation rollback and fresh discovery/whoami publication authority after actual HTTP waits');
    // Additive report-tool acceptance; the six original groups remain unchanged.
    {
      const {createHash}=await import('node:crypto'),{writeFileSync}=await import('node:fs');
      const {projectJourneys}=await import('../src/server/journeys.ts');
      const {projectRetentionReport,retentionReportCsv}=await import('../src/server/retention-report.ts');
      const {projectAttribution}=await import('../src/server/attribution.ts');
      const {saveCohort}=await import('../src/server/cohorts.ts');
      const {readRetentionReport,retentionReportVersion}=await import('../src/lib/retention-report.ts');
      const {serializeGeographyKey}=await import('../src/lib/analytics-geography.ts');
      const {environmentVersion}=await import('../src/lib/analytics-environment.ts');
      const output=process.env.TEN98_MCP_REPORT_SNAPSHOTS;assert.ok(output);
      const reportEvidence:any={phase:'started',groups:[],reports:[],waits:[],cleanup:[],originalRows:null};
      const persist=()=>writeFileSync(output,JSON.stringify(reportEvidence,null,2)+'\n');persist();
      const originalRows:Record<string,string[]>={},keys:string[]=[],ownedProjects:string[]=[];
      const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'request_limit' ORDER BY tablename")).rows.map((r:any)=>r.tablename as string);
      const rows=async(table:string)=>{assert.match(table,/^[A-Za-z_][A-Za-z0-9_]*$/);return(await pool.query('SELECT to_jsonb(t)::text AS row FROM "'+table+'" t ORDER BY 1')).rows.map((r:any)=>r.row as string);};
      for(const table of tables)originalRows[table]=await rows(table);
      const originalHash=createHash('sha256').update(JSON.stringify(originalRows)).digest('hex');
      const rw=randomUUID(),ru=randomUUID();
      await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,\'Report MCP owner\',$2)',[ru,ru+'@mcp-report.test']);
      await pool.query("INSERT INTO workspace(id,name)VALUES($1,'Report MCP fixture')",[rw]);
      await pool.query("INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,'owner')",[rw,ru]);
      const makeKey=async(userId=ru,scopes:any=['analytics:read'])=>{const value=await createApiKey(rw,userId,{name:'Report gate',scopes});keys.push(value.key.id);return value;};
      const reportKey=await makeKey(),limitedKey=await makeKey(ru,['events:write']);
      const makeProject=async()=>{const id=randomUUID();ownedProjects.push(id);await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at)VALUES($1,$2,'Report gate',$3,gen_random_uuid(),'infinity')",[id,rw,'https://'+id+'.mcp-report.test']);return id;};
      const p=await makeProject(),empty=await makeProject(),unknown=await makeProject(),expired=await makeProject(),calendarProject=await makeProject(),wide=await makeProject();
      const a='c'.repeat(64),v='d'.repeat(64),geo={version:'dbip-city-lite-v1',databaseBuild:1790818881,databaseSha256:'a'.repeat(64),country:'AE',region:{code:null,name:'Dubai'},city:'Dubai'};
      const dims={origin:'https://fixture.mcp-report.test',referrerHost:'search.test',language:'en',browser:'chrome',os:'Windows 10',device:'desktop',environmentVersion,campaign:{source:'source-a',medium:'organic',campaign:'MCP'},geography:geo};
      const event=async(pid:string,name:string,path:string,at:string,key:string|null=a,visit:string|null=v)=>{
        if(key)await pool.query('INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at)VALUES($1,$2,$3,$3)ON CONFLICT DO NOTHING',[pid,key,at]);
        await pool.query('INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id,source,metric_version,collection_basis,properties,dimensions)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[randomUUID(),pid,name,path,at,key,visit,key?'browser':'api',key?'umami-3.4-hour-cache-v1':'observations-v2',key?'consent':null,JSON.stringify({plan:{type:'string',value:'team'}}),JSON.stringify(dims)]);
      };
      try{
        await event(p,'page_view','/entry','2024-03-10T07:00:00.000Z');await event(p,'signup','/entry','2024-03-10T07:00:01.000Z');await event(p,'page_view','/return','2024-03-11T07:00:00.000Z',a,'e'.repeat(64));
        await event(unknown,'signup','/entry','2024-03-10T07:00:00.000Z',null,null);
        await pool.query("UPDATE project SET analytics_retained_from='2024-04-01T00:00:00Z' WHERE id=$1",[expired]);
        for(const at of ['2024-03-10T04:59:59.999Z','2024-03-10T05:00:00.000Z','2024-03-11T03:59:59.999Z','2024-03-11T04:00:00.000Z'])await event(calendarProject,'page_view','/dst',at);
        const common={from:'2024-03-10',to:'2024-03-11',timeZone:'UTC'};
        const cases:{name:string;path:string;read:(id:string,authority:{kind:'api-key';token:string},params:URLSearchParams)=>Promise<any>;query:Record<string,string>}[]=[{name:'ten98_read_journeys',path:'journeys',read:projectJourneys,query:{...common,steps:'2',startKind:'pageview',startValue:'/entry',endKind:'custom',endValue:'signup'}},
          {name:'ten98_read_retention',path:'retention-report',read:projectRetentionReport,query:{month:'2024-03',timeZone:'UTC',path:'/entry'}},
          {name:'ten98_read_attribution',path:'attribution',read:projectAttribution,query:{...common,conversionKind:'custom',conversionValue:'signup',model:'last-click'}}];
        function stable(value:any){
          assert.match(value.asOf,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:\d{3})?Z$/);assert.ok(Number.isFinite(Date.parse(value.asOf)));
          const copy=structuredClone(value);delete copy.asOf;
          if(value.version===retentionReportVersion){
            assert.deepEqual(readRetentionReport(value,value.query,value.projectId),value);assert.equal(value.csv,retentionReportCsv(value));
            const line='"Report generated","'+value.asOf+'"';assert.equal(copy.csv.split(line).length,2);copy.csv=copy.csv.replace(line,'"Report generated","<per-call clock>"');
            assert.equal(value.range.observedEnd,value.range.end,'Only completed historical months are compared here.');
          }
          return copy;
        }
        async function equivalent(spec:typeof cases[number],pid:string,query:Record<string,string>,tag:string){
          const params=new URLSearchParams(query),direct=await spec.read(pid,{kind:'api-key',token:reportKey.token},params),native=await http('/api/projects/'+pid+'/'+spec.path+'?'+params,{authorization:'Bearer '+reportKey.token});
          assert.equal(native.status,200,JSON.stringify(native.wire));assert.equal(native.complete,true);assert.equal(native.headers['cache-control'],'no-store');assert.deepEqual(stable(native.wire),stable(direct));
          const results=[];for(const modern of [true,false]){const result=data(await call(spec.name,{projectId:pid,query},reportKey.token,modern));assert.deepEqual(stable(result),stable(direct));results.push(result);}
          reportEvidence.reports.push({tag,tool:spec.name,projectId:pid,query,direct,native:native.wire,modern:results[0],legacy:results[1]});persist();return results[0];
        }
        const base=[];for(const spec of cases)base.push(await equivalent(spec,p,{...spec.query},'base'));
        assert.deepEqual(base[0].paths[0].items,[{kind:'pageview',value:'/entry'},{kind:'custom',value:'signup'}]);assert.equal(base[0].ranking.matchingObservedVisits,1);
        assert.equal(base[1].identity.entryEvents,2);assert.equal(base[1].rows[9].cells.find((c:any)=>c.offset===1).returnedKeys,1);assert.equal(base[1].rows.length,31);
        assert.equal(base[2].measurement.conversionEvents,1);assert.equal(base[2].dimensions.referrer.rows[0].value,'search.test');
        const cohort=await saveCohort(p,ru,{requestId:randomUUID(),definition:{schemaVersion:1,name:'Report qualification',query:new URLSearchParams({...common,timeZone:'Asia/Dubai',path:'/entry'}).toString()}});assert.ok(cohort.item);
        const filters:Record<string,string>={kind:'all',origin:dims.origin,referrer:'search.test',language:'en',browser:'chrome',os:'Windows 10',device:'desktop',campaignSource:'source-a',campaignMedium:'organic',campaignName:'MCP',country:serializeGeographyKey('country',{state:'known',country:'AE'})!,region:serializeGeographyKey('region',{state:'known',country:'AE',region:{kind:'name',value:'Dubai'}})!,city:serializeGeographyKey('city',{state:'known',country:'AE',region:{kind:'name',value:'Dubai'},city:'Dubai'})!,propertyKey:'plan',propertyType:'string',propertyValue:'"team"',predicates:JSON.stringify({version:1,match:'all',fields:[{field:'path',operator:'neq',value:'/never'}],properties:[]}),cohortId:cohort.item.id,cohortRevision:String(cohort.item.revision)};
        for(const spec of cases){const result=await equivalent(spec,p,{...spec.query,...filters},'full-filter-cohort');assert.equal(result.cohort.item.id,cohort.item.id);assert.equal(result.geographyProvenance.databaseCount,1);assert.equal(result.query.filters.city,filters.city);}
        reportEvidence.groups.push('three-reader-modern-legacy-native-direct-equivalence');console.log('PASS additive three-report complete native/direct/modern/legacy equivalence with typed filters and saved cohort');

        for(const spec of cases){
          const none=await equivalent(spec,empty,{...spec.query},'empty'),noIdentity=await equivalent(spec,unknown,{...spec.query},'unkeyed'),gone=await equivalent(spec,expired,{...spec.query},'expired');
          assert.equal(none.selection.status,'available');assert.equal(noIdentity.selection.status,'unavailable');assert.equal(gone.selection.status,'unavailable');
          if(spec.path==='journeys'){assert.deepEqual(none.paths,[]);assert.equal(none.measurement.matchingEvents,0);assert.equal(noIdentity.measurement.matchingEvents,1);assert.equal(noIdentity.paths,null);assert.equal(gone.measurement.matchingEvents,null);}
          else if(spec.path==='retention-report'){assert.equal(none.identity.entryEvents,0);assert.equal(none.identity.observedKeys,0);assert.equal(noIdentity.identity.entryEvents,1);assert.equal(noIdentity.identity.observedKeys,null);assert.equal(gone.identity.entryEvents,null);}
          else{assert.equal(none.measurement.conversionEvents,0);assert.equal(noIdentity.measurement.conversionEvents,1);assert.equal(noIdentity.measurement.convertedObservedKeys,null);assert.equal(gone.measurement.conversionEvents,null);}
        }
        const dst=await equivalent(cases[0],calendarProject,{from:'2024-03-10',to:'2024-03-10',timeZone:'America/New_York',steps:'2'},'dst');assert.equal(dst.range.start,'2024-03-10T05:00:00.000Z');assert.equal(dst.range.end,'2024-03-11T04:00:00.000Z');assert.equal(dst.measurement.matchingEvents,2);
        const leap=await equivalent(cases[1],empty,{month:'2024-02',timeZone:'UTC'},'leap');assert.equal(leap.rows.length,29);
        const skip=await equivalent(cases[1],empty,{month:'2011-12',timeZone:'Pacific/Apia'},'skipped');assert.equal(skip.rows[29].skipped,true);assert.equal(skip.rows[29].cohortKeys,null);
        for(const spec of cases){const result=await call(spec.name,{projectId:p,query:{...spec.query,cohortId:cohort.item.id,cohortRevision:'2'}},reportKey.token);assert.equal(result.status,200);assert.equal(result.wire.result.structuredContent.error.status,409);}
        assert.equal((await call(cases[0].name,{projectId:p,query:{...common,startKind:'pageview'}},reportKey.token)).wire.result.structuredContent.error.status,400);
        assert.equal((await call(cases[2].name,{projectId:p,query:{...common,conversionKind:'custom',conversionValue:'bad name'}},reportKey.token)).wire.result.structuredContent.error.status,400);
        assert.equal((await call(cases[1].name,{projectId:p,query:{month:'1969-12',timeZone:'UTC'}},reportKey.token)).wire.result.structuredContent.error.status,400);
        for(const spec of cases)assert.equal((await call(spec.name,{projectId:p,query:{...spec.query,cursor:'forbidden'}},reportKey.token)).status,400);
        reportEvidence.groups.push('calendar-unknown-retention-strict-input');console.log('PASS additive calendar/DST/leap/skipped dates, empty versus unknown versus expired and closed native input');

        assert.equal((await rpc('tools/list',{},reportKey.token)).wire.result.tools.length,9);
        assert.deepEqual((await rpc('tools/list',{},limitedKey.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami']);
        const reportActor=async(role='admin')=>{const userId=randomUUID();await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,\'Report actor\',$2)',[userId,userId+'@mcp-report.test']);await pool.query("INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,'admin')",[rw,userId]);const value=await makeKey(userId);if(role!=='admin')await pool.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[rw,userId,role]);return{userId,...value};};
        for(const role of ['admin','editor','viewer']){const key=await reportActor(role);for(const spec of cases){const result=data(await call(spec.name,{projectId:p,query:spec.query},key.token));assert.equal(result.projectId,p);if(spec.path==='retention-report')assert.equal(result.role,role);}assert.equal((await rpc('tools/list',{},key.token)).wire.result.tools.length,9);}
        for(const spec of cases){const denied=await call(spec.name,{projectId:p,query:spec.query},limitedKey.token);assert.ok(denied.wire.error);assert.equal(denied.wire.result,undefined);const foreign=await call(spec.name,{projectId:foreignProject,query:spec.query},reportKey.token);assert.equal(foreign.status,200);assert.equal(foreign.wire.result.structuredContent.error.status,404);assert.equal(JSON.stringify(foreign.wire).includes(foreignProject),false);}
        // These direct fixture authority updates intentionally bypass workspace SHARE serialization;
        // they test the final publication gate, not an application member-mutation race.
        for(const spec of cases)for(const action of ['expiry','revocation','scope','removal']as const){
          const key=await reportActor(),lock=await pool.connect();let pending:ReturnType<typeof call>|undefined;
          try{
            await lock.query('BEGIN');await lock.query('LOCK TABLE event IN ACCESS EXCLUSIVE MODE');const blocker=(await lock.query('SELECT pg_backend_pid()AS pid')).rows[0].pid;
            pending=call(spec.name,{projectId:p,query:spec.query},key.token);void pending.catch(()=>{});
            const until=Date.now()+2000;let observed:any=null;
            while(Date.now()<until){await lock.query('SELECT pg_stat_clear_snapshot()');const candidate=(await lock.query("SELECT pid,wait_event_type,pg_blocking_pids(pid)AS blockers FROM pg_stat_activity WHERE datname=current_database()AND pid<>pg_backend_pid()AND query LIKE 'WITH RECURSIVE target AS MATERIALIZED%'AND wait_event_type='Lock'AND $1=ANY(pg_blocking_pids(pid))",[blocker])).rows[0];if(candidate){observed=candidate;break;}await new Promise(r=>setTimeout(r,2));}
            assert.ok(observed,'Actual report SQL must wait on this exact blocker; native 250ms Retention bound remains unchanged.');
            if(action==='expiry')await pool.query("UPDATE api_key SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[key.key.id]);
            if(action==='revocation')await pool.query('UPDATE api_key SET revoked_at=clock_timestamp()WHERE id=$1',[key.key.id]);
            if(action==='scope')await pool.query("UPDATE api_key SET scopes=ARRAY['events:write']::text[]WHERE id=$1",[key.key.id]);
            if(action==='removal')await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[rw,key.userId]);
            await lock.query('COMMIT');const result=await pending;assert.equal(result.status,action==='scope'?403:401);assert.ok(result.wire.error);assert.equal(result.wire.result,undefined);
            reportEvidence.waits.push({tool:spec.name,action,blocker,reader:observed.pid,waitEvent:observed.wait_event_type,blockers:observed.blockers,status:result.status});persist();
          }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}
        }
        reportEvidence.groups.push('discovery-roles-tenant-scopes-twelve-waits');console.log('PASS additive scoped discovery, all read roles, foreign tenancy and twelve observed report authority waits');

        await pool.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at)VALUES($1,$2,'2024-03-10','2024-03-10')",[wide,a]);
        await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id,source)SELECT gen_random_uuid(),$1,'page_view','/'||repeat(chr(1),2030)||lpad(v::text,4,'0')||lpad(s::text,2,'0'),'2024-03-10T12:00:00Z'::timestamptz+s*interval '1 second',$2,md5(v::text)||md5(v::text),'browser'FROM generate_series(1,100)v CROSS JOIN generate_series(1,7)s",[wide,a]);
        const largeQuery={from:'2024-03-10',to:'2024-03-10',timeZone:'UTC',steps:'7'},large=await projectJourneys(wide,{kind:'api-key',token:reportKey.token},new URLSearchParams(largeQuery));assert.equal(large.paths!.length,100);assert.ok(Buffer.byteLength(JSON.stringify(large))>8*1024*1024);assert.ok(Buffer.byteLength(JSON.stringify(large))<12*1024*1024);
        for(const modern of [true,false]){const result=await call(cases[0].name,{projectId:wide,query:largeQuery},reportKey.token,modern);assert.equal(result.status,200);assert.equal(result.wire.result.isError,true);assert.equal(result.wire.result.structuredContent.error.status,503);assert.equal(result.wire.result.structuredContent.paths,undefined);assert.ok(result.bytes<4096);}
        const rateKey=await reportActor();for(const spec of cases){const prefix=spec.path==='retention-report'?'retention-report':spec.path;await seedLimit(prefix+':'+rateKey.userId,30);const denied=await call(spec.name,{projectId:p,query:spec.query},rateKey.token);assert.equal(denied.wire.result.structuredContent.error.status,429);const native=await http('/api/projects/'+p+'/'+spec.path+'?'+new URLSearchParams(spec.query),{authorization:'Bearer '+rateKey.token});assert.equal(native.status,429);await clearLimit(prefix+':'+rateKey.userId);}
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM import_probe')).rows[0].n,0);
        reportEvidence.large={nativeBytes:Buffer.byteLength(JSON.stringify(large)),nativePaths:large.paths!.length,mcp:'whole-error-no-prefix'};
        reportEvidence.groups.push('whole-result-cap-shared-native-rates-zero-provider');console.log('PASS additive complete MCP envelope refuses large native report, shared native rate keys and zero provider work');

        // Additive context family: two read tools and the CAS write over the same seams as prompts; every key and project goes through makeKey/makeProject so the cleanup invariant holds.
        {
          const {getProjectContext,getContextResearch}=await import('../src/server/project-context.ts');
          const cp=await makeProject(),contextKey=await makeKey(ru,['context:read']),contextWriteKey=await makeKey(ru,['context:write']),contextPath='/api/projects/'+cp+'/context';
          const receipts=async()=>(await pool.query('SELECT count(*)::int AS n FROM project_content_request WHERE project_id=$1',[cp])).rows[0].n as number;
          const currentRevision=async()=>(await pool.query('SELECT revision FROM project_context WHERE project_id=$1',[cp])).rows[0]?.revision as number|undefined;
          assert.deepEqual((await rpc('tools/list',{},contextKey.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami','ten98_read_context','ten98_list_context_research']);
          assert.deepEqual((await rpc('tools/list',{},contextWriteKey.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami','ten98_update_context']);
          const initial=data(await call('ten98_read_context',{projectId:cp},contextKey.token));assert.equal(initial.revision,1);assert.deepEqual(initial.sections,[]);assert.equal(await currentRevision(),undefined);
          const sectionText='MCP authored overview '+randomUUID();
          const patch={projectId:cp,requestId:randomUUID(),revision:initial.revision,updates:[{kind:'section',key:'business_overview',content:sectionText},{kind:'competitor',primaryDomain:'rival.mcp-fixture.com',name:'Rival'},{kind:'key-page',url:'https://mcp-fixture.com/pricing',role:'money'},{kind:'research',summary:'MCP research note'}]};
          const committed=await call('ten98_update_context',patch,contextWriteKey.token);
          assert.deepEqual(data(committed),{committed:true,requestId:patch.requestId,replayed:false,revision:initial.revision+1});assert.equal(JSON.stringify(committed.wire).includes(sectionText),false);assert.equal(await receipts(),1);
          assert.deepEqual(data(await call('ten98_update_context',patch,contextWriteKey.token,false)),{committed:true,requestId:patch.requestId,replayed:true,revision:initial.revision+1});assert.equal(await receipts(),1);
          const nativeReplay=await http(contextPath+'/update',{authorization:'Bearer '+contextWriteKey.token},{requestId:patch.requestId,revision:patch.revision,updates:patch.updates});
          assert.equal(nativeReplay.status,200,JSON.stringify(nativeReplay.wire));assert.deepEqual(nativeReplay.wire,{revision:initial.revision+1,replayed:true});assert.equal(await receipts(),1);
          assert.equal((await call('ten98_update_context',{...patch,updates:[{kind:'research',summary:'Changed receipt'}]},contextWriteKey.token)).wire.result.structuredContent.error.status,409);
          assert.equal((await call('ten98_update_context',{...patch,requestId:randomUUID()},contextWriteKey.token)).wire.result.structuredContent.error.status,409);
          assert.equal(await receipts(),1);assert.equal(await currentRevision(),initial.revision+1);
          const concurrentPatch={projectId:cp,requestId:randomUUID(),revision:initial.revision+1,updates:[{kind:'research',summary:'MCP concurrent context'}]};
          const pair=await Promise.all([call('ten98_update_context',concurrentPatch,contextWriteKey.token),call('ten98_update_context',concurrentPatch,contextWriteKey.token)]);
          assert.deepEqual(pair.map(r=>data(r).replayed).sort(),[false,true]);assert.deepEqual(pair.map(r=>data(r).revision),[initial.revision+2,initial.revision+2]);assert.equal(await receipts(),2);
          const wire=(value:unknown)=>JSON.parse(JSON.stringify(value));
          for(const [name,suffix,direct] of [['ten98_read_context','',()=>getProjectContext(cp,ru,contextKey.token)],['ten98_list_context_research','/research-log',()=>getContextResearch(cp,ru,new URLSearchParams(),contextKey.token)]] as const){
            const expected=wire(await direct()),native=await http(contextPath+suffix,{authorization:'Bearer '+contextKey.token});
            assert.equal(native.status,200,JSON.stringify(native.wire));assert.equal(native.complete,true);assert.equal(native.headers['cache-control'],'no-store');assert.deepEqual(native.wire,expected);
            for(const modern of [true,false])assert.deepEqual(data(await call(name,{projectId:cp},contextKey.token,modern)),expected);
            if(suffix)assert.deepEqual(expected.entries.map((e:any)=>[e.summary,e.createdBy]),[['MCP concurrent context',ru],['MCP research note',ru]]);
            else{assert.equal(expected.revision,initial.revision+2);assert.deepEqual(expected.sections.map((s:any)=>[s.key,s.content,s.updatedBy]),[['business_overview',sectionText,ru]]);assert.equal(expected.competitors[0].primaryDomain,'rival.mcp-fixture.com');assert.equal(expected.keyPages[0].url,'https://mcp-fixture.com/pricing');assert.equal(expected.researchLog.length,2);}
          }
          const rawPatch={requestId:randomUUID(),revision:initial.revision+2,updates:[{kind:'research',summary:'Never saved'}]};
          for(const [name,token] of [['ten98_read_context',contextWriteKey.token],['ten98_list_context_research',contextWriteKey.token],['ten98_update_context',contextKey.token],['ten98_read_context',reportKey.token],['ten98_list_context_research',reportKey.token],['ten98_update_context',reportKey.token]] as const){const denied=await call(name,{projectId:cp,...name==='ten98_update_context'?rawPatch:{}},token);assert.ok(denied.wire.error);assert.equal(denied.wire.result,undefined);}
          assert.equal((await http(contextPath,{authorization:'Bearer '+contextWriteKey.token})).status,403);assert.equal((await http(contextPath+'/update',{authorization:'Bearer '+contextKey.token},rawPatch)).status,403);
          for(const [name,token] of [['ten98_read_context',contextKey.token],['ten98_list_context_research',contextKey.token],['ten98_update_context',contextWriteKey.token]] as const){const foreign=await call(name,{projectId:foreignProject,...name==='ten98_update_context'?rawPatch:{}},token);assert.equal(foreign.status,200);assert.equal(foreign.wire.result.structuredContent.error.status,404);assert.equal(JSON.stringify(foreign.wire).includes(foreignProject),false);}
          assert.equal((await http('/api/projects/'+foreignProject+'/context',{authorization:'Bearer '+contextKey.token})).status,404);
          assert.equal(await receipts(),2);assert.equal(await currentRevision(),initial.revision+2);
          for(const writeMode of [false,true]){
            const key=await makeKey(ru,[writeMode?'context:write':'context:read']),lock=await pool.connect(),before=await receipts(),revision=await currentRevision();let pending:ReturnType<typeof call>|undefined;
            try{await lock.query('BEGIN');await lock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[rw]);
              pending=call(writeMode?'ten98_update_context':'ten98_read_context',{projectId:cp,...writeMode?{...rawPatch,requestId:randomUUID()}:{}},key.token);void pending.catch(()=>{});await waiting(lock,'SELECT w.id FROM workspace w JOIN project p ON p.workspace_id=w.id WHERE p.id=$1 FOR % OF w');
              await pool.query('UPDATE api_key SET revoked_at=clock_timestamp()WHERE id=$1',[key.key.id]);await lock.query('COMMIT');const result=await pending;assert.equal(result.status,401);assert.ok(result.wire.error);assert.equal(result.wire.result,undefined);assert.equal(await receipts(),before);assert.equal(await currentRevision(),revision);
              reportEvidence.waits.push({tool:writeMode?'ten98_update_context':'ten98_read_context',action:'revocation',status:result.status});persist();
            }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}
          }
          await seedLimit('project-content:'+ru,120);
          assert.equal((await call('ten98_read_context',{projectId:cp},contextKey.token)).wire.result.structuredContent.error.status,429);
          assert.equal((await call('ten98_update_context',{projectId:cp,...rawPatch,requestId:randomUUID()},contextWriteKey.token)).wire.result.structuredContent.error.status,429);
          assert.equal((await http(contextPath,{authorization:'Bearer '+contextKey.token})).status,429);
          assert.equal((await http(contextPath+'/update',{authorization:'Bearer '+contextWriteKey.token},{...rawPatch,requestId:randomUUID()})).status,429);
          assert.equal(await receipts(),2);await clearLimit('project-content:'+ru);
          reportEvidence.groups.push('context-cas-receipts-scopes-tenancy-two-waits-shared-rate');console.log('PASS additive context read/CAS write equivalence, bounded receipts, write-not-read scopes, foreign tenancy, two observed authority waits and the shared native rate key');
        }

        // Additive saved-definition family (P35): three list tools over the same seam; segments:read covers filters and cohorts, annotations:read covers notes.
        const wire=(value:unknown)=>JSON.parse(JSON.stringify(value));
        {
          const {listSegments,saveSegment}=await import('../src/server/segments.ts');
          const {listCohorts}=await import('../src/server/cohorts.ts');
          const {listAnnotations,saveAnnotation}=await import('../src/server/annotations.ts');
          const sp=await makeProject(),segmentsKey=await makeKey(ru,['segments:read']),annotationsKey=await makeKey(ru,['annotations:read']);
          assert.deepEqual((await rpc('tools/list',{},segmentsKey.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami','ten98_list_segments','ten98_list_cohorts']);
          assert.deepEqual((await rpc('tools/list',{},annotationsKey.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami','ten98_list_annotations']);
          const segment=await saveSegment(sp,ru,{requestId:randomUUID(),definition:{schemaVersion:1,name:'MCP saved filter',query:'path=/entry'}});assert.ok(segment.item);
          const savedCohort=await saveCohort(sp,ru,{requestId:randomUUID(),definition:{schemaVersion:1,name:'MCP cohort',query:new URLSearchParams({...common,path:'/entry'}).toString()}});assert.ok(savedCohort.item);
          const note=await saveAnnotation(sp,ru,{requestId:randomUUID(),definition:{date:'2024-03-10T07:00:00.000Z',allDay:false,note:'MCP note '+randomUUID()}});assert.ok(note.item);
          const families=[
            {name:'ten98_list_segments',path:'segments',key:segmentsKey,query:{} as Record<string,string>,read:()=>listSegments(sp,ru,new URLSearchParams(),segmentsKey.token),item:segment.item!.id,limit:'segments:'},
            {name:'ten98_list_cohorts',path:'cohorts',key:segmentsKey,query:{} as Record<string,string>,read:()=>listCohorts(sp,ru,new URLSearchParams(),segmentsKey.token),item:savedCohort.item!.id,limit:'cohorts:'},
            {name:'ten98_list_annotations',path:'annotations',key:annotationsKey,query:{...common} as Record<string,string>,read:()=>listAnnotations(sp,ru,new URLSearchParams(common),annotationsKey.token),item:note.item!.id,limit:'annotations:'},
          ];
          for(const family of families){
            const expected=wire(await family.read()),native=await http('/api/projects/'+sp+'/'+family.path+'?'+new URLSearchParams(family.query),{authorization:'Bearer '+family.key.token});
            assert.equal(native.status,200,JSON.stringify(native.wire));assert.equal(native.complete,true);assert.equal(native.headers['cache-control'],'no-store');assert.deepEqual(native.wire,expected);
            for(const modern of [true,false])assert.deepEqual(data(await call(family.name,{projectId:sp,query:family.query},family.key.token,modern)),expected);
            assert.deepEqual(expected.items.map((item:any)=>item.id),[family.item]);assert.equal(expected.role,'owner');assert.equal(expected.nextCursor,null);
          }
          for(const [name,token] of [['ten98_list_segments',annotationsKey.token],['ten98_list_cohorts',annotationsKey.token],['ten98_list_annotations',segmentsKey.token],['ten98_list_segments',reportKey.token],['ten98_list_annotations',reportKey.token]] as const){const denied=await call(name,{projectId:sp},token);assert.ok(denied.wire.error);assert.equal(denied.wire.result,undefined);}
          assert.equal((await http('/api/projects/'+sp+'/annotations',{authorization:'Bearer '+segmentsKey.token})).status,403);assert.equal((await http('/api/projects/'+sp+'/segments',{authorization:'Bearer '+annotationsKey.token})).status,403);
          assert.equal((await http('/api/projects/'+sp+'/segments',{authorization:'Bearer '+segmentsKey.token},{requestId:randomUUID(),definition:{schemaVersion:1,name:'Never saved',query:''}})).status,403,'segments:read admits no write');
          assert.equal((await http('/api/projects/'+sp+'/segments/'+segment.item!.id+'/delete',{authorization:'Bearer '+segmentsKey.token},{requestId:randomUUID(),revision:1})).status,403);
          for(const [name,token] of [['ten98_list_segments',segmentsKey.token],['ten98_list_annotations',annotationsKey.token]] as const){const foreign=await call(name,{projectId:foreignProject},token);assert.equal(foreign.status,200);assert.equal(foreign.wire.result.structuredContent.error.status,404);assert.equal(JSON.stringify(foreign.wire).includes(foreignProject),false);}
          const rateActor=await reportActor(),rateSegments=await makeKey(rateActor.userId,['segments:read']),rateAnnotations=await makeKey(rateActor.userId,['annotations:read']);
          for(const family of families){
            const key=family.path==='annotations'?rateAnnotations:rateSegments;await seedLimit(family.limit+rateActor.userId+':read',60);
            assert.equal((await call(family.name,{projectId:sp,query:family.query},key.token)).wire.result.structuredContent.error.status,429);assert.equal((await http('/api/projects/'+sp+'/'+family.path+'?'+new URLSearchParams(family.query),{authorization:'Bearer '+key.token})).status,429);
            await clearLimit(family.limit+rateActor.userId+':read');
          }
          {
            const key=await makeKey(ru,['segments:read']),lock=await pool.connect();let pending:ReturnType<typeof call>|undefined;
            try{await lock.query('BEGIN');await lock.query('LOCK TABLE analytics_segment IN ACCESS EXCLUSIVE MODE');
              pending=call('ten98_list_segments',{projectId:sp},key.token);void pending.catch(()=>{});await waiting(lock,'SELECT id,project_id,name,schema_version,query,revision,created_at,updated_at FROM analytics_segment%');
              await pool.query('UPDATE api_key SET revoked_at=clock_timestamp()WHERE id=$1',[key.key.id]);await lock.query('COMMIT');const result=await pending;assert.equal(result.status,401);assert.ok(result.wire.error);assert.equal(result.wire.result,undefined);
              reportEvidence.waits.push({tool:'ten98_list_segments',action:'revocation',status:result.status});persist();
            }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}
          }
          reportEvidence.groups.push('saved-definitions-three-lists-scopes-tenancy-one-wait-rate-parity');console.log('PASS additive saved filters, cohorts and annotations list equivalence over direct, bearer HTTP and both MCP transports, per-family scopes without writes, foreign tenancy, one observed revocation wait and native rate parity');
        }

        // Additive SEO authored reads (P48, P50, P51): rank trackers/reports under rank:read and saved keywords under keywords:read, seeded by direct SQL with no provider_request row.
        {
          const {listRankTrackers,getRankTracker}=await import('../src/server/rank-tracking.ts');
          const {getRankDistribution}=await import('../src/server/rank-distribution.ts');
          const {getRankMatrix}=await import('../src/server/rank-matrix.ts');
          const {listRankRuns,getLatestRankResults,getRankKeywordHistory}=await import('../src/server/rank-history.ts');
          const {listSavedKeywords,listSavedKeywordTags}=await import('../src/server/saved-keywords.ts');
          const {saveProvider}=await import('../src/server/providers.ts');
          const {compileRankPlan,rankPlanTotal}=await import('../src/server/rank-execution-plan.ts');
          const {canonicalHash}=await import('../src/server/context-input.ts');
          const rp=await makeProject(),rankKey=await makeKey(ru,['rank:read']),keywordsKey=await makeKey(ru,['keywords:read']),trackerId=randomUUID(),runId=randomUUID(),tagId=randomUUID(),keywordId=randomUUID();
          assert.deepEqual((await rpc('tools/list',{},rankKey.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami','ten98_list_rank_trackers','ten98_read_rank_tracker','ten98_read_rank_distribution','ten98_read_rank_matrix','ten98_list_rank_runs','ten98_read_rank_results','ten98_read_rank_keyword_history']);
          assert.deepEqual((await rpc('tools/list',{},keywordsKey.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami','ten98_list_saved_keywords','ten98_list_saved_keyword_tags']);
          const connection=(await saveProvider(rw,ru,{provider:'dataforseo',name:'MCP synthetic rank account',credentials:{login:'rank@mcp-report.test',password:'synthetic-never-live'}})).connection.id;
          await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
            VALUES($1,$2,$3,'MCP tracker','example.com',2840,'United States','Country',2840,'US','en','English',clock_timestamp(),'desktop',100,1)`,[trackerId,rw,rp]);
          const keywords=[{id:randomUUID(),keyword:'mcp rank one',matchCase:false},{id:randomUUID(),keyword:'mcp rank two',matchCase:false}];
          await pool.query('INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword,match_case) SELECT k.id,$2,$3,$4,k.keyword,k."matchCase" FROM jsonb_to_recordset($1::jsonb) k(id uuid,keyword text,"matchCase" boolean)',[JSON.stringify(keywords),rw,rp,trackerId]);
          // One started run without dispatches or tasks: every captured pair reads as unavailable and no provider_request row exists.
          const plan=compileRankPlan({method:'queued',target:{domain:'example.com',locationCode:2840,languageCode:'en',depth:100,maxCrawlPages:1},devices:'desktop',keywords,baseMicros:1000n});
          await pool.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,connection_id,connection_revision,account_fingerprint,connection_name,request,request_hash,task_count,estimate_micros,price_as_of,expires_at,request_key,started_at,completed_at)
            VALUES($1,$2,$3,$4,$5,'manual','queued','completed',1,1,$6,1,$7,'MCP synthetic',$8,$9,$10,$11,clock_timestamp(),clock_timestamp()+interval '5 minutes',$12,clock_timestamp(),clock_timestamp())`,[runId,rw,rp,trackerId,ru,connection,'a'.repeat(64),JSON.stringify(plan),canonicalHash(plan),plan.tasks.length,rankPlanTotal(plan).toString(),randomUUID()]);
          await pool.query("INSERT INTO saved_keyword_tag(id,project_id,name,normalized_name) VALUES($1,$2,'MCP Tag','mcp tag')",[tagId,rp]);
          await pool.query("INSERT INTO saved_keyword(id,project_id,keyword,location_code,language_code) VALUES($1,$2,'mcp saved keyword',2840,'en')",[keywordId,rp]);
          await pool.query('INSERT INTO saved_keyword_tag_assignment(project_id,keyword_id,tag_id) VALUES($1,$2,$3)',[rp,keywordId,tagId]);
          // Latest-results baselines date their targets from the same per-call report time, so they are checked against it and then dropped with it.
          const strip=(value:unknown)=>{const copy=wire(value);if('asOf'in copy){assert.ok(Number.isFinite(Date.parse(copy.asOf)));for(const row of copy.rows??[])for(const b of row.baselines??[]){assert.equal(Date.parse(b.targetAt),Date.parse(copy.asOf)-b.days*86400000);delete b.targetAt;}delete copy.asOf;}return copy;};
          const matrixQuery={device:'desktop',runLimit:'5'},distributionPath='rank-trackers/'+trackerId+'/distribution',matrixPath='rank-trackers/'+trackerId+'/matrix?'+new URLSearchParams(matrixQuery);
          const runsPath='rank-trackers/'+trackerId+'/runs',resultsPath='rank-trackers/'+trackerId+'/results?device=desktop',historyPath='rank-trackers/'+trackerId+'/keywords/'+keywords[0].id+'/history';
          const seo:{name:string;path:string;key:{token:string};args:Record<string,unknown>;body?:unknown;read:()=>Promise<unknown>}[]=[
            {name:'ten98_list_rank_trackers',path:'rank-trackers',key:rankKey,args:{},read:()=>listRankTrackers(rp,ru,new URLSearchParams(),rankKey.token)},
            {name:'ten98_read_rank_tracker',path:'rank-trackers/'+trackerId,key:rankKey,args:{trackerId},read:()=>getRankTracker(rp,ru,trackerId,rankKey.token)},
            {name:'ten98_read_rank_distribution',path:distributionPath,key:rankKey,args:{trackerId},read:()=>getRankDistribution(rp,ru,trackerId,new URLSearchParams(),rankKey.token)},
            {name:'ten98_read_rank_distribution',path:distributionPath+'?runId='+runId,key:rankKey,args:{trackerId,query:{runId}},read:()=>getRankDistribution(rp,ru,trackerId,new URLSearchParams({runId}),rankKey.token)},
            {name:'ten98_read_rank_matrix',path:matrixPath,key:rankKey,args:{trackerId,query:matrixQuery},read:()=>getRankMatrix(rp,ru,trackerId,new URLSearchParams(matrixQuery),rankKey.token)},
            {name:'ten98_list_rank_runs',path:runsPath,key:rankKey,args:{trackerId},read:()=>listRankRuns(rp,ru,trackerId,new URLSearchParams(),rankKey.token)},
            {name:'ten98_read_rank_results',path:resultsPath,key:rankKey,args:{trackerId,query:{device:'desktop'}},read:()=>getLatestRankResults(rp,ru,trackerId,new URLSearchParams({device:'desktop'}),rankKey.token)},
            {name:'ten98_read_rank_keyword_history',path:historyPath,key:rankKey,args:{trackerId,keywordId:keywords[0].id},read:()=>getRankKeywordHistory(rp,ru,trackerId,keywords[0].id,new URLSearchParams(),rankKey.token)},
            {name:'ten98_list_saved_keywords',path:'saved-keywords/list',key:keywordsKey,args:{pageSize:50},body:{pageSize:50},read:()=>listSavedKeywords(rp,ru,{pageSize:50},keywordsKey.token)},
            {name:'ten98_list_saved_keyword_tags',path:'saved-keywords/tags/list',key:keywordsKey,args:{},body:{},read:()=>listSavedKeywordTags(rp,ru,{},keywordsKey.token)},
          ];
          const results:Record<string,any>={};
          for(const spec of seo){
            const expected=strip(await spec.read()),native=await http('/api/projects/'+rp+'/'+spec.path,{authorization:'Bearer '+spec.key.token},spec.body);
            assert.equal(native.status,200,JSON.stringify(native.wire));assert.equal(native.complete,true);assert.equal(native.headers['cache-control'],'no-store');assert.deepEqual(strip(native.wire),expected);
            for(const modern of [true,false])assert.deepEqual(strip(data(await call(spec.name,{projectId:rp,...spec.args},spec.key.token,modern))),expected);
            results[spec.path]=expected;
          }
          const trackers=results['rank-trackers'];assert.deepEqual(Object.keys(trackers).sort(),['nextCursor','role','trackers']);assert.equal(trackers.trackers.length,1);assert.equal(trackers.trackers[0].keywordCount,2);
          const cookieShaped=wire(await listRankTrackers(rp,ru));assert.equal(cookieShaped.vaultConfigured,true);assert.deepEqual(cookieShaped.connections.map((c:any)=>c.id),[connection]);assert.deepEqual(cookieShaped.trackers,trackers.trackers);
          assert.equal(JSON.stringify(results).includes(connection),false,'No provider-connection identifier reaches a key holder.');
          assert.equal(results['rank-trackers/'+trackerId].keywords.length,2);
          assert.equal(results[distributionPath].totals.counts.neverChecked,2);assert.equal(results[distributionPath].mode,'latest');
          assert.equal(results[distributionPath+'?runId='+runId].totals.counts.unavailable,2);assert.equal(results[distributionPath+'?runId='+runId].run.id,runId);
          assert.deepEqual(results[matrixPath].columns.map((c:any)=>c.runId),[runId]);assert.deepEqual(results[matrixPath].rows.map((r:any)=>r.cells[0].state),['unavailable','unavailable']);
          // Runs under a key omit the provider-ledger amounts and the cost-restating diagnostic the cookie reader keeps; every other run field is identical.
          const keyRuns=results[runsPath].runs,cookieRuns=wire(await listRankRuns(rp,ru,trackerId)).runs;assert.deepEqual(keyRuns.map((r:any)=>r.id),[runId]);
          for(const field of ['estimateUsd','knownChargeUsd','costStatus','diagnostic'])assert.equal(Object.hasOwn(keyRuns[0],field),false,field);
          const {estimateUsd,knownChargeUsd,costStatus,diagnostic,...cookieRest}=cookieRuns[0];assert.match(estimateUsd,/^\d+\.\d{6}$/);assert.equal(knownChargeUsd,'0.000000');assert.equal(costStatus,'not_started');assert.equal(diagnostic,null);assert.deepEqual(cookieRest,keyRuns[0]);
          assert.deepEqual(results[resultsPath].rows.map((r:any)=>r.observationStatus),['not_checked','not_checked']);assert.ok(results[resultsPath].rows.every((r:any)=>r.device==='desktop'&&r.latestAttempt===null));
          assert.deepEqual(results[historyPath].keyword,{id:keywords[0].id,keyword:keywords[0].keyword,matchCase:false,removed:false});assert.deepEqual(results[historyPath].observations,[]);
          assert.equal(results['saved-keywords/list'].total,1);assert.deepEqual(results['saved-keywords/list'].rows[0].tags.map((t:any)=>t.id),[tagId]);assert.equal(results['saved-keywords/list'].rows[0].metrics.status,'unavailable');
          assert.deepEqual(results['saved-keywords/tags/list'].tags.map((t:any)=>[t.id,t.assignmentCount]),[[tagId,1]]);
          for(const [name,token,args] of [['ten98_list_rank_trackers',keywordsKey.token,{}],['ten98_read_rank_matrix',reportKey.token,{trackerId,query:matrixQuery}],['ten98_list_rank_runs',keywordsKey.token,{trackerId}],['ten98_read_rank_keyword_history',reportKey.token,{trackerId,keywordId:keywords[0].id}],['ten98_list_saved_keywords',rankKey.token,{}],['ten98_list_saved_keyword_tags',reportKey.token,{}]] as const){const denied=await call(name,{projectId:rp,...args},token);assert.ok(denied.wire.error);assert.equal(denied.wire.result,undefined);}
          assert.equal((await http('/api/projects/'+rp+'/rank-trackers',{authorization:'Bearer '+keywordsKey.token})).status,403);assert.equal((await http('/api/projects/'+rp+'/saved-keywords/list',{authorization:'Bearer '+rankKey.token},{})).status,403);
          // Excluded neighbours stay cookie-only even for the family key: catalog/locations/schedule/checks, the collection GET, exports and writes.
          for(const suffix of ['rank-trackers/locations?connectionId='+connection+'&countryCode=2840','rank-trackers/'+trackerId+'/schedule','rank-checks/'+runId])assert.equal((await http('/api/projects/'+rp+'/'+suffix,{authorization:'Bearer '+rankKey.token})).status,403,suffix);
          for(const [suffix,body] of [['rank-trackers/catalog',{connectionId:connection}],['rank-trackers/'+trackerId+'/matrix/export',{device:'desktop'}],['rank-trackers/'+trackerId+'/keywords/add',{}],[runsPath,{}],[historyPath,{}]] as const)assert.equal((await http('/api/projects/'+rp+'/'+suffix,{authorization:'Bearer '+rankKey.token},body)).status,403,suffix);
          assert.equal((await http('/api/projects/'+rp+'/saved-keywords',{authorization:'Bearer '+keywordsKey.token})).status,403,'The saved-keyword collection GET stays cookie-only.');
          for(const [suffix,body] of [['saved-keywords',{requestId:randomUUID(),revision:0,source:{type:'manual',keywords:['never'],locationCode:2840,languageCode:'en'}}],['saved-keywords/export',{selection:{type:'filtered',filters:{}},format:'csv'}],['saved-keywords/refresh-quote',{}],['saved-keywords/LIST',{}],['saved-keywords/tags/LIST',{}]] as const)assert.equal((await http('/api/projects/'+rp+'/'+suffix,{authorization:'Bearer '+keywordsKey.token},body)).status,403,suffix);
          for(const [name,token,args] of [['ten98_read_rank_tracker',rankKey.token,{trackerId}],['ten98_list_rank_runs',rankKey.token,{trackerId}],['ten98_list_saved_keywords',keywordsKey.token,{}]] as const){const foreign=await call(name,{projectId:foreignProject,...args},token);assert.equal(foreign.status,200);assert.equal(foreign.wire.result.structuredContent.error.status,404);assert.equal(JSON.stringify(foreign.wire).includes(foreignProject),false);}
          assert.equal((await call('ten98_read_rank_tracker',{projectId:rp,trackerId:randomUUID()},rankKey.token)).wire.result.structuredContent.error.status,404);
          assert.equal((await call('ten98_read_rank_matrix',{projectId:rp,trackerId,query:{device:'mobile'}},rankKey.token)).wire.result.structuredContent.error.status,400,'mobile is not enabled on this tracker');
          // Rate parity: the saved-keyword readers carry both native limits. The read limit is proven first while the first limit is far from full; every seeded limit is cleared after its own proof, so the first limit is then proven on its own.
          const seoActor=await reportActor(),rateRank=await makeKey(seoActor.userId,['rank:read']),rateKeywords=await makeKey(seoActor.userId,['keywords:read']);
          for(const [prefix,maximum,name,path,key,args,body] of [['rank-read:',120,'ten98_list_rank_trackers','rank-trackers',rateRank,{},undefined],['rank-read:',120,'ten98_list_rank_runs',runsPath,rateRank,{trackerId},undefined],['rank-report:',30,'ten98_read_rank_distribution',distributionPath,rateRank,{trackerId},undefined],['saved-keyword-read:',60,'ten98_list_saved_keyword_tags','saved-keywords/tags/list',rateKeywords,{},{}],['saved-keyword:',120,'ten98_list_saved_keywords','saved-keywords/list',rateKeywords,{},{}]] as const){
            await seedLimit(prefix+seoActor.userId,maximum);
            assert.equal((await call(name,{projectId:rp,...args},key.token)).wire.result.structuredContent.error.status,429,name);assert.equal((await http('/api/projects/'+rp+'/'+path,{authorization:'Bearer '+key.token},body)).status,429,path);
            await clearLimit(prefix+seoActor.userId);
          }
          {
            const key=await makeKey(ru,['rank:read']),lock=await pool.connect();let pending:ReturnType<typeof call>|undefined;
            try{await lock.query('BEGIN');await lock.query('LOCK TABLE rank_config IN ACCESS EXCLUSIVE MODE');
              pending=call('ten98_list_rank_trackers',{projectId:rp},key.token);void pending.catch(()=>{});await waiting(lock,'SELECT r.*,%FROM rank_config r WHERE r.project_id=$1%');
              await pool.query('UPDATE api_key SET revoked_at=clock_timestamp()WHERE id=$1',[key.key.id]);await lock.query('COMMIT');const result=await pending;assert.equal(result.status,401);assert.ok(result.wire.error);assert.equal(result.wire.result,undefined);
              reportEvidence.waits.push({tool:'ten98_list_rank_trackers',action:'revocation',status:result.status});persist();
            }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}
          }
          {
            const key=await makeKey(ru,['rank:read']),lock=await pool.connect();let pending:ReturnType<typeof call>|undefined;
            try{await lock.query('BEGIN');await lock.query('LOCK TABLE rank_run IN ACCESS EXCLUSIVE MODE');
              pending=call('ten98_list_rank_runs',{projectId:rp,trackerId},key.token);void pending.catch(()=>{});await waiting(lock,'SELECT r.id,r.status,r.trigger,r.method,%FROM rank_run r LEFT JOIN LATERAL%');
              await pool.query('UPDATE api_key SET revoked_at=clock_timestamp()WHERE id=$1',[key.key.id]);await lock.query('COMMIT');const result=await pending;assert.equal(result.status,401);assert.ok(result.wire.error);assert.equal(result.wire.result,undefined);
              reportEvidence.waits.push({tool:'ten98_list_rank_runs',action:'revocation',status:result.status});persist();
            }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}
          }
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM import_probe')).rows[0].n,0);
          reportEvidence.groups.push('seo-authored-reads-nine-tools-projections-exclusions-two-waits-dual-rate-parity');console.log('PASS additive rank tracker/report/history and saved-keyword read equivalence over direct, bearer HTTP and both MCP transports with the bearer projections (no vault, connections or ledger amounts), excluded neighbours refused, foreign tenancy, two observed revocation waits, dual saved-keyword rate parity and zero provider work');
        }

        // Additive Google snapshot and domain registry reads (P57, P58, P79, P80): google:read for every role, domains:read for current owners/admins, seeded by direct SQL with no provider, DNS or HTTP work.
        {
          const {listGoogleConnections,readGoogleImport}=await import('../src/server/google-jobs.ts');
          const {getDomains}=await import('../src/server/domains.ts');
          const {getDomainRedirectChecks}=await import('../src/server/domain-redirects.ts');
          const gp=await makeProject(),googleKey=await makeKey(ru,['google:read']),domainsKey=await makeKey(ru,['domains:read']),connectionId=randomUUID(),importId=randomUUID(),domainId=randomUUID();
          assert.deepEqual((await rpc('tools/list',{},googleKey.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami','ten98_list_google_sources','ten98_read_google_snapshot']);
          assert.deepEqual((await rpc('tools/list',{},domainsKey.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami','ten98_list_domains','ten98_list_domain_redirect_checks']);
          await pool.query("INSERT INTO google_connection(id,workspace_id,project_id,name,provider,revision,app_revision,status) VALUES($1,$2,$3,'MCP synthetic source','gsc',1,1,'disconnected')",[connectionId,rw,gp]);
          await pool.query(`INSERT INTO google_import(id,connection_id,project_id,user_id,request_id,connection_revision,app_revision,report,date_from,date_to,status,pages,row_count,source,quality,completed_at)
            VALUES($1,$2,$3,$4,$5,1,1,'gsc_daily','2026-01-01','2026-01-01','completed',1,1,'{"provider":"gsc","propertyId":"sc-domain:mcp-fixture.com"}','{"warnings":[],"metadata":{}}',clock_timestamp())`,[importId,connectionId,gp,ru,randomUUID()]);
          await pool.query(`INSERT INTO google_import_page(import_id,page,rows) VALUES($1,0,'[{"dimensions":["2026-01-01"],"metrics":{"clicks":0,"impressions":1,"ctr":0,"position":null}}]')`,[importId]);
          await pool.query("INSERT INTO project_domain(id,project_id,hostname,role,expected_target_host,verified_at) VALUES($1,$2,'alias.mcp-fixture.com','redirect_alias','target.mcp-fixture.com',clock_timestamp())",[domainId,gp]);
          await pool.query(`INSERT INTO domain_redirect_check(id,workspace_id,project_id,domain_id,user_id,request_id,domain_revision,hostname,expected_target_host,verified_at,status,diagnostic,completed_at)
            SELECT $1,p.workspace_id,p.id,d.id,$3,$4,d.redirect_revision,d.hostname,d.expected_target_host,d.verified_at,'stale','Synthetic MCP receipt',clock_timestamp() FROM project p JOIN project_domain d ON d.project_id=p.id WHERE p.id=$5 AND d.id=$2`,[randomUUID(),domainId,ru,randomUUID(),gp]);
          const domainRows=async()=>(await pool.query('SELECT count(*)::int AS n FROM project_domain WHERE project_id=$1',[gp])).rows[0].n as number;
          const reads:{name:string;path:string;key:{token:string};args:Record<string,unknown>;read:()=>Promise<unknown>}[]=[
            {name:'ten98_list_google_sources',path:'google',key:googleKey,args:{},read:()=>listGoogleConnections(gp,ru,googleKey.token)},
            {name:'ten98_read_google_snapshot',path:'google/imports/'+importId,key:googleKey,args:{importId},read:()=>readGoogleImport(gp,ru,importId,0,googleKey.token)},
            {name:'ten98_read_google_snapshot',path:'google/imports/'+importId+'?offset=1',key:googleKey,args:{importId,query:{offset:'1'}},read:()=>readGoogleImport(gp,ru,importId,'1',googleKey.token)},
            {name:'ten98_list_domains',path:'domains',key:domainsKey,args:{},read:()=>getDomains(gp,ru,domainsKey.token)},
            {name:'ten98_list_domain_redirect_checks',path:'domains/'+domainId+'/redirect-checks',key:domainsKey,args:{domainId},read:()=>getDomainRedirectChecks(gp,ru,domainId,domainsKey.token)},
          ];
          const results:Record<string,any>={};
          for(const spec of reads){
            const expected=wire(await spec.read()),native=await http('/api/projects/'+gp+'/'+spec.path,{authorization:'Bearer '+spec.key.token});
            assert.equal(native.status,200,JSON.stringify(native.wire));assert.equal(native.complete,true);assert.equal(native.headers['cache-control'],'no-store');assert.deepEqual(native.wire,expected);
            for(const modern of [true,false])assert.deepEqual(data(await call(spec.name,{projectId:gp,...spec.args},spec.key.token,modern)),expected);
            results[spec.path]=expected;
          }
          assert.deepEqual(Object.keys(results.google).sort(),['connections','role']);assert.deepEqual(results.google.connections.map((c:any)=>[c.id,c.imports.map((i:any)=>i.id)]),[[connectionId,[importId]]]);
          assert.deepEqual(Object.keys(wire(await listGoogleConnections(gp,ru))).sort(),['app','connections','role'],'Only the cookie-shaped list carries the app configuration.');
          assert.equal(results['google/imports/'+importId].rows.length,1);assert.equal(results['google/imports/'+importId].import.dataStatus,'available');assert.deepEqual(results['google/imports/'+importId+'?offset=1'].rows,[]);
          assert.deepEqual(results.domains.domains.map((d:any)=>[d.id,d.status]),[[domainId,'verified']]);assert.equal(results.domains.project.canonicalVerifiable,false);assert.equal(await domainRows(),1,'No key read created a registry row.');
          assert.deepEqual(results['domains/'+domainId+'/redirect-checks'].checks.map((c:any)=>c.status),['stale']);
          for(const [name,token,args] of [['ten98_list_google_sources',domainsKey.token,{}],['ten98_read_google_snapshot',reportKey.token,{importId}],['ten98_list_domains',googleKey.token,{}],['ten98_list_domain_redirect_checks',reportKey.token,{domainId}]] as const){const denied=await call(name,{projectId:gp,...args},token);assert.ok(denied.wire.error);assert.equal(denied.wire.result,undefined);}
          assert.equal((await http('/api/projects/'+gp+'/google',{authorization:'Bearer '+domainsKey.token})).status,403);assert.equal((await http('/api/projects/'+gp+'/domains',{authorization:'Bearer '+googleKey.token})).status,403);
          // google:read survives demotion to viewer; domains:read lapses below admin.
          const demoted=await reportActor(),demotedGoogle=await makeKey(demoted.userId,['google:read']),demotedDomains=await makeKey(demoted.userId,['domains:read']);
          for(const role of ['editor','viewer']){
            await pool.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[rw,demoted.userId,role]);
            assert.deepEqual((await rpc('tools/list',{},demotedDomains.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami'],role);assert.equal((await http('/api/projects/'+gp+'/domains',{authorization:'Bearer '+demotedDomains.token})).status,403,role);
            assert.deepEqual((await rpc('tools/list',{},demotedGoogle.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami','ten98_list_google_sources','ten98_read_google_snapshot'],role);
            assert.deepEqual(data(await call('ten98_list_google_sources',{projectId:gp},demotedGoogle.token)),{...results.google,role},role);
          }
          for(const [name,token] of [['ten98_list_google_sources',googleKey.token],['ten98_list_domains',domainsKey.token]] as const){const foreign=await call(name,{projectId:foreignProject},token);assert.equal(foreign.status,200);assert.equal(foreign.wire.result.structuredContent.error.status,404);assert.equal(JSON.stringify(foreign.wire).includes(foreignProject),false);}
          assert.equal((await call('ten98_read_google_snapshot',{projectId:gp,importId:randomUUID()},googleKey.token)).wire.result.structuredContent.error.status,404);
          assert.equal((await call('ten98_list_domain_redirect_checks',{projectId:gp,domainId:randomUUID()},domainsKey.token)).wire.result.structuredContent.error.status,404);
          const rateActor=await reportActor(),rateGoogle=await makeKey(rateActor.userId,['google:read']),rateDomains=await makeKey(rateActor.userId,['domains:read']);
          for(const [limitKey,maximum,name,path,key,args] of [['google:read:'+rateActor.userId,120,'ten98_list_google_sources','google',rateGoogle,{}],['domain-settings:'+rateActor.userId,60,'ten98_list_domains','domains',rateDomains,{}],['domain-redirect:'+rateActor.userId+':read',60,'ten98_list_domain_redirect_checks','domains/'+domainId+'/redirect-checks',rateDomains,{domainId}]] as const){
            await seedLimit(limitKey,maximum);
            assert.equal((await call(name,{projectId:gp,...args},key.token)).wire.result.structuredContent.error.status,429,name);assert.equal((await http('/api/projects/'+gp+'/'+path,{authorization:'Bearer '+key.token})).status,429,path);
            await clearLimit(limitKey);
          }
          for(const [table,name,pattern,scope] of [['google_import','ten98_list_google_sources','SELECT i.*,i.date_from::text AS date_from%','google:read'],['project_domain','ten98_list_domains','SELECT * FROM project_domain WHERE project_id=$1 ORDER BY%','domains:read']] as const){
            const key=await makeKey(ru,[scope]),lock=await pool.connect();let pending:ReturnType<typeof call>|undefined;
            try{await lock.query('BEGIN');await lock.query('LOCK TABLE '+table+' IN ACCESS EXCLUSIVE MODE');
              pending=call(name,{projectId:gp},key.token);void pending.catch(()=>{});await waiting(lock,pattern);
              await pool.query('UPDATE api_key SET revoked_at=clock_timestamp()WHERE id=$1',[key.key.id]);await lock.query('COMMIT');const result=await pending;assert.equal(result.status,401);assert.ok(result.wire.error);assert.equal(result.wire.result,undefined);
              reportEvidence.waits.push({tool:name,action:'revocation',status:result.status});persist();
            }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}
          }
          assert.equal(await domainRows(),1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM import_probe')).rows[0].n,0);
          reportEvidence.groups.push('google-domains-four-tools-projection-owner-admin-tenancy-two-waits-rate-parity');console.log('PASS additive Google source/snapshot and domain registry/redirect-receipt read equivalence over direct, bearer HTTP and both MCP transports, no app configuration or canonical INSERT under a key, google:read for viewers and domains:read for owners/admins only, foreign tenancy, native rate parity, two observed revocation waits and zero provider work');
        }

        // Additive site audit reads (P53, P54, P56): audits:read for every role over the native audit gate, seeded by direct SQL with no crawl, queue or website work.
        {
          const {listSiteAudits,getSiteAudit,listSiteAuditIssues}=await import('../src/server/site-audits.ts');
          const ap=await makeProject(),auditsKey=await makeKey(ru,['audits:read']),runId=randomUUID(),issueId=randomUUID();
          assert.deepEqual((await rpc('tools/list',{},auditsKey.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami','ten98_list_site_audits','ten98_read_site_audit','ten98_list_site_audit_issues']);
          await pool.query(`WITH stamp AS (SELECT clock_timestamp() AS at) INSERT INTO site_audit_run(id,workspace_id,project_id,user_id,request_id,request_hash,origin,config,status,created_at,completed_at,deadline_at,queue_job_id)
            SELECT $1,$2,$3,$4,gen_random_uuid(),repeat('a',64),'https://audit.mcp-report.test','{"mode":"static","startPath":"/","maxPages":50}'::jsonb,'completed',at,at,at+interval '30 minutes',gen_random_uuid() FROM stamp`,[runId,rw,ap,ru]);
          await pool.query("INSERT INTO site_audit_issue(id,run_id,issue_key,rule_version,code,severity,details) VALUES($1,$2,repeat('b',64),'static-graph-v1','orphan-page','info','{}')",[issueId,runId]);
          const reads:{name:string;path:string;args:Record<string,unknown>;read:()=>Promise<unknown>}[]=[
            {name:'ten98_list_site_audits',path:'audits',args:{},read:()=>listSiteAudits(ap,ru,new URLSearchParams(),auditsKey.token)},
            {name:'ten98_list_site_audits',path:'audits?limit=1',args:{query:{limit:'1'}},read:()=>listSiteAudits(ap,ru,new URLSearchParams('limit=1'),auditsKey.token)},
            {name:'ten98_read_site_audit',path:'audits/'+runId,args:{runId},read:()=>getSiteAudit(ap,ru,runId,auditsKey.token)},
            {name:'ten98_list_site_audit_issues',path:'audits/'+runId+'/issues',args:{runId},read:()=>listSiteAuditIssues(ap,ru,runId,new URLSearchParams(),auditsKey.token)},
            {name:'ten98_list_site_audit_issues',path:'audits/'+runId+'/issues?severity=info&limit=1',args:{runId,query:{severity:'info',limit:'1'}},read:()=>listSiteAuditIssues(ap,ru,runId,new URLSearchParams('severity=info&limit=1'),auditsKey.token)},
          ];
          const results:Record<string,any>={};
          for(const spec of reads){
            const expected=wire(await spec.read()),native=await http('/api/projects/'+ap+'/'+spec.path,{authorization:'Bearer '+auditsKey.token});
            assert.equal(native.status,200,JSON.stringify(native.wire));assert.equal(native.complete,true);assert.equal(native.headers['cache-control'],'no-store');assert.deepEqual(native.wire,expected);
            for(const modern of [true,false])assert.deepEqual(data(await call(spec.name,{projectId:ap,...spec.args},auditsKey.token,modern)),expected);
            results[spec.path]=expected;
          }
          assert.deepEqual(wire(await getSiteAudit(ap,ru,runId)),results['audits/'+runId],'The key read equals the member read, canCancel and canDelete included.');
          assert.deepEqual(results.audits.runs.map((r:any)=>[r.id,r.status,r.dataStatus]),[[runId,'completed','available']]);
          assert.deepEqual(results['audits/'+runId+'/issues'].issues.map((i:any)=>[i.id,i.pageId,i.code]),[[issueId,null,'orphan-page']]);
          assert.deepEqual(results['audits/'+runId+'/issues'].groups,[{code:'orphan-page',severity:'info',retainedFindingCount:1,affectedUrlCount:0,unassignedFindingCount:1}]);assert.equal(results['audits/'+runId+'/issues'].matchingRetainedCount,1);
          for(const [name,args] of [['ten98_list_site_audits',{}],['ten98_read_site_audit',{runId}],['ten98_list_site_audit_issues',{runId}]] as const){const denied=await call(name,{projectId:ap,...args},reportKey.token);assert.ok(denied.wire.error);assert.equal(denied.wire.result,undefined);}
          for(const suffix of ['audits','audits/'+runId,'audits/'+runId+'/issues','audits/setup','audits/'+runId+'/pages'])assert.equal((await http('/api/projects/'+ap+'/'+suffix,{authorization:'Bearer '+(suffix.endsWith('setup')||suffix.endsWith('pages')?auditsKey.token:reportKey.token)})).status,403,suffix);
          // audits:read stays on the viewer allowlist; the run DTO reports the issuer's current role.
          const demoted=await reportActor(),demotedAudits=await makeKey(demoted.userId,['audits:read']);
          for(const role of ['editor','viewer']){
            await pool.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[rw,demoted.userId,role]);
            assert.deepEqual((await rpc('tools/list',{},demotedAudits.token)).wire.result.tools.map((t:any)=>t.name),['ten98_whoami','ten98_list_site_audits','ten98_read_site_audit','ten98_list_site_audit_issues'],role);
            const viewed=data(await call('ten98_read_site_audit',{projectId:ap,runId},demotedAudits.token));assert.equal(viewed.role,role);assert.equal(viewed.run.canDelete,false,role);
          }
          for(const [name,args] of [['ten98_list_site_audits',{}],['ten98_read_site_audit',{runId}]] as const){const foreign=await call(name,{projectId:foreignProject,...args},auditsKey.token);assert.equal(foreign.status,200);assert.equal(foreign.wire.result.structuredContent.error.status,404);assert.equal(JSON.stringify(foreign.wire).includes(foreignProject),false);}
          assert.equal((await call('ten98_read_site_audit',{projectId:ap,runId:randomUUID()},auditsKey.token)).wire.result.structuredContent.error.status,404);
          assert.equal((await call('ten98_list_site_audit_issues',{projectId:ap,runId:randomUUID()},auditsKey.token)).wire.result.structuredContent.error.status,404);
          const rateActor=await reportActor(),rateAudits=await makeKey(rateActor.userId,['audits:read']);
          await seedLimit('audits:'+rateActor.userId+':read',120);
          assert.equal((await call('ten98_list_site_audits',{projectId:ap},rateAudits.token)).wire.result.structuredContent.error.status,429);assert.equal((await http('/api/projects/'+ap+'/audits',{authorization:'Bearer '+rateAudits.token})).status,429);await clearLimit('audits:'+rateActor.userId+':read');
          {
            const key=await makeKey(ru,['audits:read']),lock=await pool.connect();let pending:ReturnType<typeof call>|undefined;
            try{await lock.query('BEGIN');await lock.query('LOCK TABLE site_audit_issue IN ACCESS EXCLUSIVE MODE');
              pending=call('ten98_list_site_audit_issues',{projectId:ap,runId},key.token);void pending.catch(()=>{});await waiting(lock,'SELECT i.id,i.page_id AS "pageId"%');
              await pool.query('UPDATE api_key SET revoked_at=clock_timestamp()WHERE id=$1',[key.key.id]);await lock.query('COMMIT');const result=await pending;assert.equal(result.status,401);assert.ok(result.wire.error);assert.equal(result.wire.result,undefined);
              reportEvidence.waits.push({tool:'ten98_list_site_audit_issues',action:'revocation',status:result.status});persist();
            }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();await pending?.catch(()=>{});}
          }
          assert.deepEqual((await pool.query('SELECT raw_expired_at,data_expired_at,status FROM site_audit_run WHERE id=$1',[runId])).rows,[{raw_expired_at:null,data_expired_at:null,status:'completed'}],'Reads of a current run latch nothing and change no lifecycle.');
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM import_probe')).rows[0].n,0);
          reportEvidence.groups.push('site-audits-three-tools-viewer-tenancy-one-wait-rate-parity');console.log('PASS additive site audit list/detail/issues read equivalence over direct, bearer HTTP and both MCP transports, equal to the member read, cookie-only setup and pages refused, audits:read for every role, foreign tenancy, native rate parity, one observed revocation wait and zero provider work');
        }
        reportEvidence.phase='passed';
      }catch(error){reportEvidence.phase='failed';reportEvidence.failure={name:error instanceof Error?error.name:'Error',message:error instanceof Error?error.message.slice(0,2000):'Unknown failure'};throw error;}
      finally{
        try{await pool.query('UPDATE api_key SET revoked_at=COALESCE(revoked_at,clock_timestamp())WHERE id=ANY($1::uuid[])',[keys]);assert.equal((await pool.query('SELECT count(*)::int AS n FROM api_key WHERE id=ANY($1::uuid[])AND revoked_at IS NULL',[keys])).rows[0].n,0);reportEvidence.cleanup.push('all additive keys revoked');
          for(const table of tables){const current=new Set(await rows(table));for(const row of originalRows[table])assert.ok(current.has(row),'Original '+table+' row changed.');}
          reportEvidence.originalRows={sha256:originalHash,count:Object.values(originalRows).reduce((n,r)=>n+r.length,0),unchanged:true};
        }catch(error){reportEvidence.phase='failed';reportEvidence.cleanup.push({failure:error instanceof Error?error.message:'Unknown cleanup failure'});throw error;}finally{persist();}
      }
    }

    await seedLimit('api-key:'+all.key.id,120);assert.equal((await rpc('tools/list')).status,429);await clearLimit('api-key:'+all.key.id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM import_probe')).rows[0].n,0);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);
    console.log('PASS shared rate budget and zero provider/probe work or idle transactions');
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
if(process.env.TEN98_MCP_TEST==='1')runMcpChecks().catch(error=>{console.error('FAIL MCP integration',error instanceof Error?{name:error.name,message:error.message}:{name:'UnknownError'});process.exitCode=1;}).finally(closeDatabase);
