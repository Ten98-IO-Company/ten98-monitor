import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {PoolClient} from 'pg';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase,migrationSources} from '../src/server/db.ts';
import {initializeProviderAccountIdentity} from '../src/server/provider-account-identity.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey,revokeApiKey} from '../src/server/api-keys.ts';
import {projectAnalytics} from '../src/server/analytics.ts';
import {collectNative,trackingConsentEpoch} from '../src/server/native-analytics.ts';
import {runRetentionBatch} from '../src/server/retention.ts';
import {getAnalyticsReset,resetAnalytics} from '../src/server/analytics-reset.ts';
import {deleteProject,getProjectDeletion} from '../src/server/project-delete.ts';
import {removeMember} from '../src/server/teams.ts';
import {quarantineRestoredSpending} from '../src/server/restore-quarantine.ts';
import {normalizeProperties} from '../src/server/analytics-input.ts';
import {saveBoard,createBoardShare} from '../src/server/boards.ts';
import {listWebsiteShares,createWebsiteShare,revokeWebsiteShare,readWebsiteShare} from '../src/server/website-shares.ts';
import {decodePublicWebsiteShare,projectWebsiteShare,websiteShareSections,type WebsiteShareSection} from '../src/lib/website-shares.ts';

const status=(n:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===n;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export async function runWebsiteShareChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_WEBSITE_SHARE_TEST,'1');assert.equal(process.env.ANALYTICS_NETWORK_MODE,'off');
 const config=getConfig(),db=new URL(config.databaseUrl);assert.equal(config.appUrl,'http://127.0.0.1:3111');assert.equal(db.hostname,'127.0.0.1');assert.doesNotMatch(config.databaseUrl,/[?#]/);assert.equal(db.search,'');assert.equal(db.hash,'');
 if(process.env.GITHUB_ACTIONS==='true'){assert.equal(process.env.TEN98_ISOLATED_CI_DATABASE,'1');assert.equal(db.port,'5432');assert.equal(db.pathname,'/ten98_website_share_ci');}else{assert.equal(db.port,'55502');assert.match(db.pathname,/^\/ten98_website_share_[a-f0-9]{12}$/);}
 for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
 const {pool}=getDatabase();assert.equal((await pool.query("SELECT to_regclass('schema_version')AS name")).rows[0].name,null,'Fresh externally owned database only.');
 const sources=await migrationSources();assert.equal(sources.length,74);assert.equal(sources.at(-1)?.filename,'0074_api_key_prefix_last_used.sql','Register the actual69 prefix first; never replace migrationSources.');const migration=await pool.connect();
 try{await migration.query('BEGIN');await migration.query('CREATE TABLE schema_version(version text PRIMARY KEY,checksum text NOT NULL)');for(const source of sources){await migration.query(source.sql);await migration.query('INSERT INTO schema_version VALUES($1,$2)',[source.version,source.checksum]);}await initializeProviderAccountIdentity(migration);await migration.query('COMMIT');}catch(error){await migration.query('ROLLBACK');throw error;}finally{migration.release();}await assertSchema();
 const users=Array.from({length:6},()=>randomUUID()),[owner,admin,editor,viewer,stranger,admin2]=users,workspace=randomUUID(),otherWorkspace=randomUUID(),factorWorkspace=randomUUID(),project=randomUUID(),project2=randomUUID(),otherProject=randomUUID(),factorProject=randomUUID();
 const marker='canary'+randomBytes(8).toString('hex'),markerHost=marker+'.example.com',origin='https://'+markerHost,range={from:'2026-01-01',to:'2026-01-02'};
 const password=randomBytes(24).toString('base64url'),passwordHash=await hashPassword(password),groups:string[]=[],cleanup:unknown[]=[],keys:{workspace:string;id:string}[]=[];let primary:unknown,external=0;const fetchBefore=globalThis.fetch;globalThis.fetch=async()=>{external++;throw Error('No external transport in the website share fixture.');};
 async function stable(){assert.equal(external,0);for(const table of ['provider_request','prompt_execution'])assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);assert.equal((await pool.query("SELECT to_regnamespace('pgboss') AS schema")).rows[0].schema,null);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()AND state='idle in transaction'")).rows[0].n,0);}
 const pass=async(name:string)=>{await stable();groups.push(name);console.log('PASS '+name);};
 async function waitBlocked(gate:PoolClient,pattern:string,blocker:'gate'|'any'='gate'){for(let n=0;n<300;n++){await gate.query('SELECT pg_stat_clear_snapshot()');if((await gate.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()AND query LIKE $1 AND ${blocker==='gate'?'pg_backend_pid()=ANY(pg_blocking_pids(pid))':'cardinality(pg_blocking_pids(pid))>0'}`,[pattern])).rowCount)return;await delay(10);}assert.fail('Expected an actual PostgreSQL lock wait: '+pattern);}
 const token=()=>randomBytes(32).toString('base64url'),later=(days=7)=>new Date(Date.now()+days*864e5).toISOString();
 const input=(sections:WebsiteShareSection[]=['overview','events'],extra:Record<string,unknown>={})=>({requestId:randomUUID(),label:'Shared website',sections,expiresAt:later(),token:token(),...extra});
 try{
  for(const uid of users){await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,\'Share fixture\',$2)',[uid,uid+'@website-shares.integration.test']);await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password)VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),uid,passwordHash]);}
  for(const wid of [workspace,otherWorkspace,factorWorkspace])await pool.query("INSERT INTO workspace(id,name,raw_analytics_days)VALUES($1,'Share fixture',3650)",[wid]);
  for(const[uid,role]of [[owner,'owner'],[admin,'admin'],[editor,'editor'],[viewer,'viewer'],[admin2,'admin']])await pool.query('INSERT INTO membership VALUES($1,$2,$3)',[workspace,uid,role]);
  await pool.query("INSERT INTO membership VALUES($1,$2,'owner')",[otherWorkspace,stranger]);await pool.query("INSERT INTO membership VALUES($1,$2,'owner')",[factorWorkspace,owner]);await pool.query('INSERT INTO workspace_two_factor_requirement VALUES($1)',[factorWorkspace]);
  for(const[pid,wid,name,site]of [[project,workspace,'Website '+marker,origin],[project2,workspace,'Second website','https://second.website-shares.test'],[otherProject,otherWorkspace,'Other website','https://other.website-shares.test'],[factorProject,factorWorkspace,'Factor website','https://factor.website-shares.test']])
   await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at)VALUES($1,$2,$3,$4,$5,'infinity')",[pid,wid,name,site,randomUUID()]);
  // Synthetic events: two visitors, a self-referral, a custom event, geography, environment, and unique markers in every private column.
  const geography=(country:string,code:string,regionName:string,city:string)=>({version:'dbip-city-lite-v1',databaseBuild:1790818881,databaseSha256:'a'.repeat(64),country,region:{code,name:regionName},city});
  const environment={browser:'chrome',os:'Linux',device:'desktop',environmentVersion:'server-ua-environment-v1'},visitors:string[]=[];
  async function event(pid:string,name:string,path:string,at:string,person:string|null,dimensions:Record<string,unknown>){
   const visitor=person===null?null:sha(marker+person),visit=person===null?null:sha(marker+person+' visit');if(visitor){visitors.push(visitor,visit!);await pool.query('INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at)VALUES($1,$2,$3,$3)ON CONFLICT DO NOTHING',[pid,visitor,at]);}
   await pool.query('INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id,properties,dimensions,gclid,fbclid,msclkid,ttclid,li_fat_id,twclid)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10,$10,$10,$10)',[randomUUID(),pid,name,path,at,visitor,visit,JSON.stringify(normalizeProperties({canary:marker})),JSON.stringify({origin,...dimensions}),marker]);
  }
  for(const pid of [project,project2]){
   await event(pid,'page_view','/pricing','2026-01-01T10:00:00Z','a',{...environment,referrerHost:'search.example',campaign:{utm_source:marker,utm_campaign:marker},language:marker,geography:geography('US','US-CA','California','Springfield')});
   await event(pid,'page_view','/docs','2026-01-01T10:05:00Z','a',{...environment,referrerHost:markerHost,geography:geography('US','US-CA','California','Springfield')});
   await event(pid,'signup','/docs','2026-01-01T10:06:00Z','a',{...environment});
   await event(pid,'page_view','/pricing','2026-01-02T09:00:00Z','b',{browser:'firefox',os:'Mac OS',device:'mobile',environmentVersion:'server-ua-environment-v1',geography:geography('CA','CA-ON','Ontario','Toronto')});
   await event(pid,'page_view','/','2026-01-02T11:00:00Z',null,{});
  }
  const login=async(uid:string)=>{const res=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:uid+'@website-shares.integration.test',password})}));assert.equal(res.status,200);return res.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');},cookies=Object.fromEntries(await Promise.all(users.map(async uid=>[uid,await login(uid)] as const)));
  const manage=(uid:string,pid:string,body?:unknown,suffix='',extra:HeadersInit={})=>handleApi(new Request(config.appUrl+'/api/projects/'+pid+'/website-shares'+suffix,{method:body===undefined?'GET':'POST',headers:{cookie:cookies[uid],origin:config.appUrl,...body===undefined?{}:{'content-type':'application/json'},...extra},...body===undefined?{}:{body:JSON.stringify(body)}}));

  // Group 1: management authority, receipts and bounds.
  const ownerInput=input(),created=await manage(owner,project,ownerInput);assert.equal(created.status,200);const createdText=await created.text(),createdBody=JSON.parse(createdText);
  assert.equal(createdBody.replayed,false);assert.equal(createdBody.ack.operation,'create');assert.equal(createdBody.item.state,'active');assert.deepEqual(createdBody.item.creator,{name:'Share fixture',email:owner+'@website-shares.integration.test',member:true});assert.deepEqual(createdBody.item.sections,['events','overview']);
  for(const secret of [ownerInput.token,sha(ownerInput.token)])assert.equal(createdText.includes(secret),false,'No acknowledgment carries the secret or its hash.');
  const replay=await createWebsiteShare(project,owner,ownerInput);assert.equal(replay.replayed,true);assert.deepEqual(replay.ack,createdBody.ack);
  await assert.rejects(createWebsiteShare(project,owner,{...ownerInput,label:'Changed'}),status(409));await assert.rejects(createWebsiteShare(project,admin,ownerInput),status(409),'Another actor cannot reuse a request ID.');
  await assert.rejects(createWebsiteShare(project,owner,{...ownerInput,requestId:randomUUID()}),status(409),'A reused token is refused.');
  const adminShare=await createWebsiteShare(project,admin,input(['overview']));assert.equal(adminShare.item?.creator?.member,true);
  for(const uid of [owner,admin]){const listed=await manage(uid,project);assert.equal(listed.status,200);const text=await listed.text(),body=JSON.parse(text);assert.equal(body.role,uid===owner?'owner':'admin');assert.equal(body.items.length,2);assert.equal(body.nextCursor,null);for(const secret of [ownerInput.token,sha(ownerInput.token)])assert.equal(text.includes(secret),false);}
  for(const uid of [editor,viewer,stranger]){assert.equal((await manage(uid,project)).status,404);assert.equal((await manage(uid,project,input())).status,404);assert.equal((await manage(uid,project,{requestId:randomUUID()},'/'+createdBody.ack.shareId+'/revoke')).status,404);}
  assert.equal((await manage(owner,otherProject)).status,404,'A website in another workspace is not found.');await assert.rejects(listWebsiteShares(otherProject,owner,''),status(404));
  assert.equal((await manage(owner,factorProject)).status,403,'The workspace two-factor requirement gates management.');
  const key=await createApiKey(workspace,owner,{name:'No share bearer',scopes:['analytics:read']});keys.push({workspace,id:key.key.id});
  for(const[method,suffix,body]of [['GET','',undefined],['POST','',input()],['POST','/'+createdBody.ack.shareId+'/revoke',{requestId:randomUUID()}]] as const)assert.equal((await handleApi(new Request(config.appUrl+'/api/projects/'+project+'/website-shares'+suffix,{method,headers:{authorization:'Bearer '+key.token,origin:config.appUrl,...body?{'content-type':'application/json'}:{}},...body?{body:JSON.stringify(body)}:{}}))).status,403);
  for(const change of [{expiresAt:new Date(Date.now()+30*60000).toISOString()},{expiresAt:later(366)},{sections:[]},{sections:['overview','overview']},{sections:['sessions']},{token:'A'.repeat(42)+'B'},{extra:true}])assert.equal((await manage(owner,project,input(['overview'],change))).status,400,JSON.stringify(change));
  assert.equal((await manage(owner,project,undefined,'?cursor=a&cursor=b')).status,400);assert.equal((await manage(owner,project,undefined,'?other=1')).status,400);assert.equal((await manage(owner,project,input(),'?x=1')).status,400);
  assert.equal((await manage(owner,project,undefined,'',{'content-length':'2'})).status,400);assert.equal((await handleApi(new Request(config.appUrl+'/api/projects/'+project+'/website-shares',{method:'PUT',headers:{cookie:cookies[owner],origin:config.appUrl}}))).status,405);
  assert.equal((await manage(owner,project,input(),'',{origin:'https://foreign.example.org'})).status,403);
  const revokedHttp=await manage(admin,project,{requestId:randomUUID()},'/'+adminShare.ack.shareId+'/revoke');assert.equal(revokedHttp.status,200);assert.equal((await revokedHttp.json()).item.state,'revoked');
  await pass('owner/admin cookie-only management with actor-bound receipts, token reuse refusal, bounded lifetime and sections, role/workspace/factor/bearer refusals and no secret in any reply');

  // Group 2: public HTTP admission through the real dispatcher.
  const readInput=input(['overview','events','locations']),shared=await createWebsiteShare(project,owner,readInput),sid=shared.ack.shareId,publicUrl=config.appUrl+'/api/website-shares/'+sid+'/read';
  const wire=(headers:Record<string,string>,init:{method?:string;body?:string;url?:string}={})=>handleApi(new Request(init.url??publicUrl,{method:init.method??'POST',headers,...['GET','HEAD'].includes(init.method??'POST')?{}:{body:init.body??JSON.stringify(range)}}));
  const good={'x-ten98-website-share':readInput.token,origin:config.appUrl,'content-type':'application/json'};
  const ok=await wire(good);assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'no-store');assert.equal(ok.headers.get('x-content-type-options'),'nosniff');assert.equal(ok.headers.get('referrer-policy'),'no-referrer');assert.equal(ok.headers.get('x-robots-tag'),'noindex, nofollow');assert.equal(ok.headers.getSetCookie().length,0);for(const name of ok.headers.keys())assert.equal(name.startsWith('access-control-'),false,name);
  const okBody=await ok.json();assert.ok(decodePublicWebsiteShare(okBody,sid,range));
  const withCookie=await wire({...good,cookie:cookies[owner]});assert.equal(withCookie.status,200);assert.deepEqual(await withCookie.json(),okBody,'An ambient session changes nothing.');
  const {['x-ten98-website-share']:_omit,...noToken}=good;assert.equal((await wire({...noToken,cookie:cookies[owner]})).status,404,'A dashboard session never replaces the capability.');
  for(const value of ['A'.repeat(42)+'B',readInput.token+'=','short'])assert.equal((await wire({...good,'x-ten98-website-share':value})).status,404);
  const wrong=await wire({...good,'x-ten98-website-share':token()}),unknown=await wire(good,{url:config.appUrl+'/api/website-shares/'+randomUUID()+'/read'});assert.equal(wrong.status,404);assert.equal(unknown.status,404);assert.deepEqual(await wrong.json(),await unknown.json(),'A wrong token and an unknown share answer identically.');
  for(const[name,value]of [['authorization','Bearer invalid'],['x-api-key','invalid']])assert.equal((await wire({...good,[name]:value})).status,403);
  for(const suffix of ['?','?x=1','#fragment'])assert.equal((await wire(good,{url:publicUrl+suffix})).status,400,suffix);
  for(const method of ['GET','HEAD','PUT']){const refused=await wire(good,{method});assert.equal(refused.status,405);assert.equal(refused.headers.get('allow'),'POST');}
  const {origin:_origin,...noOrigin}=good;for(const headers of [{...good,origin:'https://foreign.example.org'},noOrigin,{...good,'sec-fetch-site':'cross-site'}])assert.equal((await wire(headers)).status,403);
  assert.equal((await wire(good,{body:JSON.stringify(range)+' '.repeat(1100)})).status,413);
  for(const extra of [{compare:'prev'},{dimension:'path'},{browser:'chrome'},{path:'/'}])assert.equal((await wire(good,{body:JSON.stringify({...range,...extra})})).status,400,JSON.stringify(extra));
  assert.equal((await wire(good,{body:JSON.stringify({from:'2025-01-01',to:'2026-01-02'})})).status,400,'A 367-day range is refused.');
  const scope='from=2026-01-01&to=2026-01-02&timeZone=UTC',cardId=randomUUID(),board=(await saveBoard(workspace,owner,{requestId:randomUUID(),definition:{schemaVersion:1,name:'Cross kind board',description:'',defaultEntity:null,scope,rows:[{id:randomUUID(),minHeight:150,cards:[{id:cardId,type:'TextBlock',text:'Shared'}]}]}})).item!;
  const boardToken=token(),boardShare=await createBoardShare(workspace,owner,board.id,{requestId:randomUUID(),boardRevision:board.revision,label:'Cross kind link',theme:'light',selectedCardIds:[cardId],scope,allowFilter:false,ongoingLive:false,expiresAt:later(),token:boardToken});
  const manifest=(id:string,value:string)=>handleApi(new Request(config.appUrl+'/api/board-shares/'+id+'/manifest',{headers:{'x-ten98-board-share':value}}));assert.equal((await manifest(boardShare.ack.shareId,boardToken)).status,200);
  assert.equal((await wire({...good,'x-ten98-website-share':boardToken})).status,404);assert.equal((await wire({...good,'x-ten98-website-share':boardToken},{url:config.appUrl+'/api/website-shares/'+boardShare.ack.shareId+'/read'})).status,404);
  assert.equal((await manifest(boardShare.ack.shareId,readInput.token)).status,404);assert.equal((await manifest(sid,readInput.token)).status,404,'A website capability is never a board capability.');
  const minute=async(key:string,count:number)=>{await pool.query("INSERT INTO request_limit(key,minute,count) SELECT $1,floor(extract(epoch FROM now())/60)+m,$2 FROM generate_series(0,1) m ON CONFLICT(key,minute) DO UPDATE SET count=EXCLUDED.count",[key,count]);};
  await minute('website-share:global',300);assert.equal((await wire(good)).status,429,'The global limiter answers before the share key.');await pool.query("DELETE FROM request_limit WHERE key='website-share:global'");
  await minute('website-share:'+sid+':read',120);assert.equal((await wire(good)).status,429);await pool.query('DELETE FROM request_limit WHERE key=$1',['website-share:'+sid+':read']);assert.equal((await wire(good)).status,200);
  await pass('public capability admission precedes keys and sessions: exact header, Origin, method, query, body and range bounds, cross-kind refusal, uniform 404, global then per-share limits and no cookie or CORS headers');

  // Group 3: the public read is the private overview, projected per section.
  const grantOf=async(id:string)=>{const row=(await pool.query('SELECT id,label,sections,expires_at FROM project_share WHERE id=$1',[id])).rows[0];return{id:row.id,label:row.label,sections:row.sections as WebsiteShareSection[],expiresAt:(row.expires_at as Date).toISOString()};};
  const member=await projectAnalytics(project,owner,new URLSearchParams(range)),full=await readWebsiteShare(sid,readInput.token,range);assert.deepEqual(full,projectWebsiteShare(await grantOf(sid),member));
  assert.deepEqual(full.overview!.referrers.map(row=>row.host),['search.example'],'Self-referrals are excluded exactly as in the private overview.');assert.equal(full.overview!.pageViews,4);assert.equal(full.events!.customEvents,1);assert.ok(full.locations!.cities.length>0);
  const sectionShares=new Map<string,{id:string;token:string;sections:WebsiteShareSection[]}>();
  for(let mask=1;mask<8;mask++){const sections=websiteShareSections.filter((_,bit)=>(mask>>bit)&1),body=input([...sections]),made=await createWebsiteShare(project,owner,body);sectionShares.set(sections.join(','),{id:made.ack.shareId,token:body.token,sections});}
  const only=(sections:string)=>sectionShares.get(sections)!;
  const overviewOnly=await readWebsiteShare(only('overview').id,only('overview').token,range);assert.equal('events'in overviewOnly,false);assert.equal('locations'in overviewOnly,false);assert.equal(JSON.stringify(overviewOnly).includes('Springfield'),false,'Cities appear only with the locations section.');
  const eventsOnly=await readWebsiteShare(only('events').id,only('events').token,range);assert.equal('overview'in eventsOnly,false);assert.deepEqual(eventsOnly.events!.names,[{name:'signup',count:1}]);
  const locationsOnly=await readWebsiteShare(only('locations').id,only('locations').token,range);assert.deepEqual(Object.keys(locationsOnly).filter(k=>websiteShareSections.includes(k as WebsiteShareSection)),['locations']);
  await pass('every section subset equals the projection of the member overview, with self-referrals excluded and regions/cities only behind the locations grant');

  // Group 4: the SQL repeats the grant binding; a structural share context is never authority.
  const second=await createWebsiteShare(project,owner,input(['overview'])),secondHash=(await pool.query('SELECT token_hash FROM project_share WHERE id=$1',[second.ack.shareId])).rows[0].token_hash as string,readHash=sha(readInput.token),params=new URLSearchParams(range);
  const forged=[{pid:project,shareId:sid,tokenHash:secondHash},{pid:project,shareId:sid,tokenHash:'0'.repeat(64)},{pid:otherProject,shareId:sid,tokenHash:readHash},{pid:project2,shareId:sid,tokenHash:readHash},{pid:project,shareId:second.ack.shareId,tokenHash:readHash},{pid:project,shareId:randomUUID(),tokenHash:readHash}];
  const messages=new Set<string>();for(const{pid,...share}of forged){await assert.rejects(projectAnalytics(pid,'',params,undefined,share),(error:unknown)=>{assert.ok(status(404)(error));messages.add((error as Error).message);return true;});}
  assert.equal(messages.size,1,'Every forged binding answers the same 404.');assert.ok(await projectAnalytics(project,'',params,undefined,{shareId:sid,tokenHash:readHash}));
  await pass('forged share contexts (foreign hash, zero hash, foreign website, swapped share, random id) all answer one identical 404 from the aggregate itself');

  // Group 5: data closure. Nothing private, no identifiers, no project name or origin.
  for(const{id,token:secret,sections}of sectionShares.values()){
   const response=await wire({...good,'x-ten98-website-share':secret},{url:config.appUrl+'/api/website-shares/'+id+'/read'});assert.equal(response.status,200);const text=await response.text(),value=decodePublicWebsiteShare(JSON.parse(text),id,range);assert.ok(value,sections.join());
   assert.deepEqual(websiteShareSections.filter(section=>value[section]!==undefined),sections);
   for(const forbidden of [marker,markerHost,'Website '+marker,workspace,project,owner,...visitors,secret,sha(secret)])assert.equal(text.includes(forbidden),false,'Leaked '+forbidden.slice(0,12)+' in '+sections.join());
  }
  await pass('data-closure canary: markers in properties, campaign values, language, all six click IDs, visitor and visit keys, project name and origin never reach any section subset, nor workspace, project or user ids');

  // Group 6: lock contract. A public reader holds no workspace gate, grant row or project row lock, so no writer waits for it; a reset that commits during a read makes that read refuse.
  const side=await pool.connect();
  try{
   const blockedInput=input(['overview']),blockedShare=await createWebsiteShare(project,owner,blockedInput),departingInput=input(['overview']),departing=await createWebsiteShare(project,admin2,departingInput);
   await side.query('BEGIN');await side.query('LOCK TABLE event IN ACCESS EXCLUSIVE MODE');
   const pending=readWebsiteShare(blockedShare.ack.shareId,blockedInput.token,range).then(()=>null,(error:unknown)=>error);
   await waitBlocked(side,'%WITH clock AS MATERIALIZED%');const started=Date.now();
   const revoked=await revokeWebsiteShare(project,owner,blockedShare.ack.shareId,{requestId:randomUUID()});assert.ok(revoked.item?.revokedAt);
   await removeMember(workspace,owner,admin2);assert.equal((await pool.query('SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace,admin2])).rowCount,0);
   assert.ok(Date.now()-started<4000,'Both writes completed while the public read was still waiting.');await waitBlocked(side,'%WITH clock AS MATERIALIZED%');
   await side.query('ROLLBACK');assert.ok(status(404)(await pending),'The read that was in flight during the revoke answers 404.');
   // D6: a removed creator's link stays live and listed with a former-member marker; the removed member loses management.
   assert.ok(await readWebsiteShare(departing.ack.shareId,departingInput.token,range));await assert.rejects(listWebsiteShares(project,admin2,''),status(404));
   assert.deepEqual((await listWebsiteShares(project,owner,'')).items.find(row=>row.id===departing.ack.shareId)?.creator,{name:'Share fixture',email:admin2+'@website-shares.integration.test',member:false});
   // The web process admits two public aggregates at once; a third answers 503 at once instead of queueing on the shared pool.
   const capInput=input(['overview']),cap=await createWebsiteShare(project,owner,capInput),capUrl=config.appUrl+'/api/website-shares/'+cap.ack.shareId+'/read',capHeaders={...good,'x-ten98-website-share':capInput.token};
   await side.query('BEGIN');await side.query('LOCK TABLE event IN ACCESS EXCLUSIVE MODE');
   const held=[wire(capHeaders,{url:capUrl}),wire(capHeaders,{url:capUrl})];
   const twoBlocked=async()=>{for(let n=0;n<300;n++){await side.query('SELECT pg_stat_clear_snapshot()');if((await side.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%WITH clock AS MATERIALIZED%' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))")).rows[0].n>=2)return;await delay(10);}assert.fail('Expected two public reads waiting on the event lock.');};
   await twoBlocked();const asked=Date.now(),third=await wire(capHeaders,{url:capUrl});assert.equal(third.status,503,'A third concurrent public read is refused.');
   assert.equal((await third.json()).error,'Shared website reads are busy. Try again shortly.','The refusal is the in-flight cap, not a statement timeout.');assert.ok(Date.now()-asked<1000,'The third read is refused at once instead of queueing.');
   await side.query('ROLLBACK');for(const response of await Promise.all(held))assert.equal(response.status,200,'The two admitted reads answer once the lock is released.');
   assert.equal((await wire(capHeaders,{url:capUrl})).status,200,'Both slots are released after the reads.');
   // Project FOR UPDATE writers never wait for a public read, which holds no project row lock. A held project_share lock stalls the
   // share-mode aggregate at its grant join after the epoch read (the lock-free locator is skipped, as in group 4); none of these writers
   // touches project_share, while the event lock above would also stall collection, retention and the reset's own state read.
   // The stall happens before the aggregate takes its snapshot, so the reset round below proves that a reset committing after the
   // epoch read refuses the read; the window inside the aggregate scan rests on the same final comparison.
   const liveInput=input(['overview']),live=await createWebsiteShare(project,owner,liveInput),liveShare={shareId:live.ack.shareId,tokenHash:sha(liveInput.token)};
   const stalled=async()=>{await side.query('BEGIN');await side.query('LOCK TABLE project_share IN ACCESS EXCLUSIVE MODE');const read=projectAnalytics(project,'',new URLSearchParams(range),undefined,liveShare).then(value=>({value}),(error:unknown)=>({error}));await waitBlocked(side,'%WITH clock AS MATERIALIZED%');return{read};};
   const site=(await pool.query('SELECT public_key,analytics_epoch FROM project WHERE id=$1',[project])).rows[0],concurrent=await stalled();
   const observed=await collectNative(new Request(origin,{headers:{origin,'user-agent':'Website share fixture browser'}}),site.public_key,{eventId:randomUUID(),name:'page_view',url:origin+'/during-share-read',dimensions:{distinctId:'share-reader'},consent:{analytics:true,epoch:trackingConsentEpoch(site.analytics_epoch,null)}});
   assert.equal(observed.accepted,true,'Identified collection (project FOR UPDATE, 250 ms lock timeout) is accepted while a public read is in flight.');
   const retained=await runRetentionBatch(project);assert.equal(retained?.projectId,project,'A retention batch (project FOR UPDATE, 250 ms lock timeout) completes while a public read is in flight.');assert.equal(retained?.deletedEvents,0);
   await waitBlocked(side,'%WITH clock AS MATERIALIZED%');await side.query('ROLLBACK');
   const unchanged=await concurrent.read;assert.ok('value'in unchanged,'The concurrent read answers.');assert.equal(unchanged.value.coverage.status,'complete');assert.equal(unchanged.value.totals.pageViews,4,'Concurrent collection and retention leave the epoch, so the read still answers.');
   const revision=(await getAnalyticsReset(project,owner)).revision,interrupted=await stalled();
   const ack=await resetAnalytics(project,owner,{requestId:randomUUID(),revision,confirmation:'RESET'});assert.equal(ack.replayed,false,'The reset commits without waiting for the public read.');
   await waitBlocked(side,'%WITH clock AS MATERIALIZED%');await side.query('ROLLBACK');
   const refused=await interrupted.read;assert.ok('error'in refused&&status(503)(refused.error),'A read whose epoch changed under a committed reset refuses publication.');
   const after=await readWebsiteShare(live.ack.shareId,liveInput.token,range);assert.equal(after.coverage.status,'unavailable');assert.equal(after.overview!.pageViews,null);assert.ok(after.overview!.daily.every(day=>day.pageViews===null&&day.coverage==='unavailable'));
  }finally{await side.query('ROLLBACK').catch(()=>{});side.release();}
  await pass('a public read holds no workspace gate, grant row or project row lock: revoke and member removal finish while it waits and it then answers 404; identified collection and a retention batch finish while it waits and it still answers; a reset commits while it waits and it then refuses with 503, and later reads hide pre-cutoff data');

  // Group 7: lifecycle.
  const lifeInput=input(['overview']),life=await createWebsiteShare(project,owner,lifeInput),first=await revokeWebsiteShare(project,owner,life.ack.shareId,{requestId:randomUUID()}),again=await revokeWebsiteShare(project,admin,life.ack.shareId,{requestId:randomUUID()});
  assert.equal(again.item?.revokedAt,first.item?.revokedAt,'Revocation is idempotent and keeps its first instant.');assert.equal(again.item?.state,'revoked');await assert.rejects(readWebsiteShare(life.ack.shareId,lifeInput.token,range),status(404));
  assert.equal((await createWebsiteShare(project,owner,lifeInput)).item?.state,'revoked','An exact create replay never revives a revoked grant.');
  const expiringInput=input(['overview']),expiring=await createWebsiteShare(project,owner,expiringInput);await pool.query("UPDATE project_share SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[expiring.ack.shareId]);
  await assert.rejects(readWebsiteShare(expiring.ack.shareId,expiringInput.token,range),status(404));
  const pages:{id:string;state:string}[]=[];let next='';for(;;){const page=await listWebsiteShares(project,owner,next?'cursor='+next:'');pages.push(...page.items);if(!page.nextCursor)break;next=page.nextCursor;}assert.equal(pages.find(row=>row.id===expiring.ack.shareId)?.state,'expired');assert.equal(new Set(pages.map(row=>row.id)).size,pages.length);
  const today=new Date().toISOString().slice(0,10),yesterday=new Date(Date.now()-864e5).toISOString().slice(0,10),straddleInput=input(['overview','events']),straddle=await createWebsiteShare(project,owner,straddleInput);
  const old=await readWebsiteShare(straddle.ack.shareId,straddleInput.token,range);assert.equal(old.coverage.status,'unavailable');assert.equal(old.events!.customEvents,null);
  assert.equal((await readWebsiteShare(straddle.ack.shareId,straddleInput.token,{from:yesterday,to:today})).coverage.status,'partial','A range across the reset cutoff is partial.');
  const deletion=await getProjectDeletion(workspace,project,owner);await deleteProject(workspace,project,owner,{requestId:randomUUID(),revision:deletion.item!.revision,confirmation:'DELETE'});
  await assert.rejects(readWebsiteShare(sid,readInput.token,range),status(404));for(const table of ['project_share','project_content_request'])assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE project_id=$1`,[project])).rows[0].n,0,table+' cascades with the website.');
  const survivorInput=input(['overview']),survivor=await createWebsiteShare(project2,owner,survivorInput);assert.ok(await readWebsiteShare(survivor.ack.shareId,survivorInput.token,range));
  await quarantineRestoredSpending();assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_share WHERE revoked_at IS NULL')).rows[0].n,0,'Restore quarantine revokes every live website share.');await assert.rejects(readWebsiteShare(survivor.ack.shareId,survivorInput.token,range),status(404));
  await pass('revocation is idempotent and irreversible, expiry and reset coverage apply on the next read, deletion cascades grants and receipts, and restore quarantine revokes the rest');
  assert.equal(groups.length,7);
 }catch(error){primary=error;}
 finally{for(const key of keys){try{await revokeApiKey(key.workspace,owner,key.id);}catch(error){cleanup.push(error);}}try{await stable();}catch(error){cleanup.push(error);}globalThis.fetch=fetchBefore;}
 if(primary||cleanup.length)throw new AggregateError([primary,...cleanup].filter(Boolean),'Website share acceptance failed; retain original and cleanup evidence.');
 return{groups,external};
}
if(process.env.TEN98_INTEGRATION_TEST==='1'&&process.env.TEN98_WEBSITE_SHARE_TEST==='1'&&pathToFileURL(resolve(process.argv[1]??'')).href===import.meta.url)try{await runWebsiteShareChecks();}finally{await closeDatabase();}
