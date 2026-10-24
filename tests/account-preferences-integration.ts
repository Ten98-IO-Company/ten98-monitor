import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {accountPreferencesDtoSchema,type AccountPreferencesDto} from '../src/lib/account-preferences.ts';
import {handleApi} from '../src/server/api.ts';
import {getAuth} from '../src/server/auth.ts';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase,migrationSources,assertSchema} from '../src/server/db.ts';
import {initializeProviderAccountIdentity} from '../src/server/provider-account-identity.ts';
import {inviteMember,acceptInvitation,acceptVerifiedOidcInvitation} from '../src/server/teams.ts';
import {createApiKey,revokeApiKey} from '../src/server/api-keys.ts';
import {authenticatorCode} from './account-security-integration.ts';

// PREPARATION ONLY: a separately approved PG-only outer must own a fresh database.
// Migration45 intentionally remains private until accepted44 is integrated/registered.
// Calls use the native API and Better Auth, without a listener, provider or worker.
export async function runAccountPreferencesChecks(verifyOriginalRows:()=>Promise<void>=async()=>{}) {
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_ACCOUNT_PREFERENCES_TEST,'1');
  assert.equal(process.env.ANALYTICS_NETWORK_MODE,'off');
  const config=getConfig(),database=new URL(config.databaseUrl),origin='http://127.0.0.1:3111';
  assert.equal(config.appUrl,origin);
  if(process.env.GITHUB_ACTIONS==='true'){
    assert.equal(process.env.TEN98_ISOLATED_CI_DATABASE,'1');assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'5432');assert.equal(database.pathname,'/ten98_account_preferences_ci');assert.doesNotMatch(config.databaseUrl,/[?#]/);
  }else{
  assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'55501');
  assert.match(database.pathname,/^\/ten98_account_preferences_[a-f0-9]{12}$/);assert.equal(database.search,'');assert.equal(database.hash,'');
  }
  for(const name of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[name],undefined);
  const {pool}=getDatabase();assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
  const originalFetch=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw Error('Account preferences permit no outbound request.');};
  type Actor={id:string;cookie:string;email:string;password?:string};
  const actors:Actor[]=[],groups:string[]=[],cleanupErrors:unknown[]=[];
  let workspace='',key:{id:string;token:string}|undefined,primaryFailure:unknown;
  const constraint='test_preferences_'+randomUUID().replaceAll('-','');let constraintAdded=false;
  const cookies=(response:Response)=>response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  function api(path:string,actor?:Actor,input?:unknown,extra:HeadersInit={},method=input===undefined?'GET':'POST') {
    const headers=new Headers(extra);if(actor?.cookie)headers.set('cookie',actor.cookie);
    if(input!==undefined){if(!headers.has('origin'))headers.set('origin',origin);headers.set('content-type','application/json');}
    return handleApi(new Request(origin+path,{method,headers,...input===undefined?{}:{body:JSON.stringify(input)}}));
  }
  async function checked(response:Promise<Response>,status=200) {const result=await response;assert.equal(result.status,status);assert.match(result.headers.get('cache-control')??'',/no-store/);return result;}
  async function read(actor:Actor) {return accountPreferencesDtoSchema.parse(await(await checked(api('/api/account/preferences',actor))).json());}
  const body=(dto:AccountPreferencesDto,patch:Record<string,unknown>={})=>({expectedRevision:dto.preferences.revision,name:dto.user.name,timeZone:dto.preferences.timeZone,locale:dto.preferences.locale,theme:dto.preferences.theme,...patch});
  async function save(actor:Actor,input:unknown,status=200) {const response=await checked(api('/api/account/preferences',actor,input),status);return status===200?accountPreferencesDtoSchema.parse(await response.json()):response;}
  const protectedTables=['provider_connection','provider_request','workspace_budget','project','project_domain','project_content_request','ai_content_support_quote','ai_content_support_run'];
  async function protectedRows() {const result:Record<string,unknown>={};for(const table of protectedTables)result[table]=(await pool.query(`SELECT md5(to_jsonb(t)::text) AS digest,count(*)::int AS n FROM "${table}" t GROUP BY md5(to_jsonb(t)::text) ORDER BY digest`)).rows;return result;}
  async function ownRows(id:string) {return (await pool.query(`SELECT to_jsonb(u) AS account,(SELECT to_jsonb(p) FROM user_preference p WHERE p.user_id=u.id) AS preferences FROM "user" u WHERE u.id=$1`,[id])).rows;}
  let protectedBaseline:Record<string,unknown>|undefined;
  async function pass(name:string) {if(protectedBaseline)assert.deepEqual(await protectedRows(),protectedBaseline);assert.equal(outbound,0);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);await verifyOriginalRows();groups.push(name);console.log('PASS '+name);}
  async function invite(role:'admin'|'editor'|'viewer') {
    const email=randomUUID()+'@preferences.test',password=randomBytes(24).toString('hex'),invitation=await inviteMember(workspace,actors[0].id,{email,role});
    await acceptInvitation({token:invitation.token,name:'Preferences '+role,password});
    const actor:Actor={id:(await pool.query('SELECT id FROM "user" WHERE email=$1',[email])).rows[0].id,email,password,cookie:''};
    const response=await checked(api('/api/auth/sign-in/email',undefined,{email,password}));actor.cookie=cookies(response);assert.ok(actor.cookie);actors.push(actor);return actor;
  }
  try {
    const sources=await migrationSources();assert.equal(sources.at(-1)?.filename,'0074_api_key_prefix_last_used.sql','Register actual69 after accepted44–68 before this native gate; do not privately bypass the registry.');
    assert.equal(sources.at(51)?.filename,'0052_prompt_tracker_library.sql');assert.equal(sources.at(50)?.filename,'0051_prompt_recurring.sql');assert.equal(sources.at(49)?.filename,'0050_prompt_explorer_cache.sql');assert.equal(sources.at(48)?.filename,'0049_google_organic_reports.sql');assert.equal(sources.at(47)?.filename,'0048_domain_research.sql');assert.equal(sources.at(46)?.filename,'0047_prompt_explorer_models.sql');assert.equal(sources.at(45)?.filename,'0046_ga4_report_inventory.sql');assert.equal(sources.at(44)?.filename,'0045_account_preferences.sql');assert.equal(sources.at(43)?.version,'0044');
    const migration=await pool.connect();try{await migration.query('BEGIN');await migration.query('CREATE TABLE schema_version(version text PRIMARY KEY,checksum text NOT NULL)');for(const source of sources){await migration.query(source.sql);await migration.query('INSERT INTO schema_version VALUES($1,$2)',[source.version,source.checksum]);}await initializeProviderAccountIdentity(migration);await migration.query('COMMIT');}catch(error){await migration.query('ROLLBACK');throw error;}finally{migration.release();}await assertSchema();
    const email=randomUUID()+'@preferences.test',password=randomBytes(24).toString('hex');
    const setup=await checked(api('/api/setup',undefined,{token:config.bootstrapToken,name:'Preferences owner',email,password,workspaceName:'Preferences owned fixture'}));
    const owner:Actor={id:(await pool.query('SELECT id FROM "user" WHERE email=$1',[email])).rows[0].id,email,password,cookie:cookies(setup)};assert.ok(owner.cookie);actors.push(owner);
    workspace=(await pool.query("SELECT workspace_id FROM membership WHERE user_id=$1 AND role='owner'",[owner.id])).rows[0].workspace_id;
    protectedBaseline=await protectedRows();
    await checked(api('/api/account/preferences'),401);
    const initial=await read(owner);assert.equal(initial.preferences.revision,0);assert.equal(initial.preferences.updatedAt,null);assert.equal(initial.preferences.theme,'light');assert.equal(initial.preferences.timeZone,'UTC');assert.equal(initial.preferences.locale,'en-US');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_preference')).rows[0].n,0,'Reading defaults must not write a preference row.');
    for(const actor of [owner,await invite('admin'),await invite('editor'),await invite('viewer')]){
      const before=await read(actor),otherRows=await Promise.all(actors.filter(other=>other.id!==actor.id).map(other=>ownRows(other.id)));
      const after=await save(actor,body(before,{name:'Saved '+actor.email,timeZone:'Asia/Dubai',locale:'ar-SA',theme:'dark'})) as AccountPreferencesDto;
      assert.equal(after.user.id,actor.id);assert.equal(after.user.name,'Saved '+actor.email);assert.deepEqual(after.preferences,{revision:1,timeZone:'Asia/Dubai',locale:'ar-SA',theme:'dark',updatedAt:after.preferences.updatedAt});assert.ok(after.preferences.updatedAt);
      assert.deepEqual(await Promise.all(actors.filter(other=>other.id!==actor.id).map(other=>ownRows(other.id))),otherRows);
    }
    await pass('all four workspace roles save only their own name and persisted preferences');

    const viewer=actors[3],second:Actor={...viewer,cookie:''};
    second.cookie=cookies(await checked(api('/api/auth/sign-in/email',undefined,{email:viewer.email,password:viewer.password})));assert.ok(second.cookie);
    const before=await read(viewer);assert.deepEqual(await read(second),before);
    const contenders=await Promise.all([api('/api/account/preferences',viewer,body(before,{name:'CAS first',theme:'system'})),api('/api/account/preferences',second,body(before,{name:'CAS second',theme:'light'}))]);
    assert.deepEqual(contenders.map(response=>response.status).sort(),[200,409]);
    for(const response of contenders)await response.json();
    const winner=await read(viewer);assert.equal(winner.preferences.revision,2);assert.ok(['CAS first','CAS second'].includes(winner.user.name));assert.deepEqual(await read(second),winner);
    const noop=await save(second,body(winner)) as AccountPreferencesDto;assert.deepEqual(noop,winner);
    await save(viewer,body(before,{name:'Stale overwrite'}),409);assert.deepEqual(await read(viewer),winner);
    await pass('cross-device persistence, compare-and-swap and unchanged-save idempotence');

    const fingerprint=await ownRows(owner.id),current=await read(owner);
    for(const [input,status] of [[{...body(current),userId:viewer.id},400],[{...body(current),email:viewer.email},400],[{...body(current),theme:'automatic'},400],[{...body(current),timeZone:'+04:00'},400],[{...body(current),locale:'xx-XX'},400]] as const)await save(owner,input,status);
    await checked(api('/api/account/preferences',owner,body(current),{origin:'https://other.example.test'}),403);
    await checked(api('/api/account/preferences?userId='+viewer.id,owner),400);await checked(api('/api/account/preferences',owner,undefined,{},'PUT'),405);
    await checked(api('/api/account/preferences',owner,{...body(current),name:'x'.repeat(9000)}),413);
    const invalidUtf8=new Request(origin+'/api/account/preferences',{method:'POST',headers:{origin,cookie:owner.cookie,'content-type':'application/json'},body:new Uint8Array([0xff])});await checked(handleApi(invalidUtf8),400);
    const createdKey=await createApiKey(workspace,owner.id,{name:'Owned preferences boundary',scopes:['projects:read']});key={id:createdKey.key.id,token:createdKey.token};
    await checked(api('/api/account/preferences',undefined,undefined,{authorization:'Bearer '+key.token}),403);
    await checked(api('/api/account/preferences',owner,undefined,{authorization:'Bearer '+key.token}),400);
    await checked(api('/api/auth/update-user',owner,{name:'Bypass'}),404);assert.deepEqual(await ownRows(owner.id),fingerprint);
    await pass('cookie/origin/body/API-key boundary and existing raw auth restriction');

    // Force the second half to fail after Better Auth has updated the name.
    assert.match(viewer.id,/^[a-f0-9-]{36}$/);const rollbackBefore=await ownRows(viewer.id),rollbackDto=await read(viewer);
    await pool.query(`ALTER TABLE user_preference ADD CONSTRAINT ${constraint} CHECK(user_id <> '${viewer.id}') NOT VALID`);constraintAdded=true;
    const failure=await checked(api('/api/account/preferences',viewer,body(rollbackDto,{name:'Must roll back',locale:'de-DE'})),500);
    assert.equal(failure.headers.getSetCookie().length,0);const publicError=await failure.text();assert.ok(!publicError.includes(viewer.id)&&!publicError.includes(constraint)&&!publicError.includes('INSERT'));
    assert.deepEqual(await ownRows(viewer.id),rollbackBefore);assert.deepEqual(await read(viewer),rollbackDto);
    await pool.query(`ALTER TABLE user_preference DROP CONSTRAINT ${constraint}`);constraintAdded=false;
    const recovered=await save(viewer,body(rollbackDto,{name:'Recovered atomically',locale:'de-DE'})) as AccountPreferencesDto;assert.equal(recovered.user.name,'Recovered atomically');assert.equal(recovered.preferences.locale,'de-DE');assert.equal(recovered.preferences.revision,rollbackDto.preferences.revision+1);
    await pass('late database failure rolls back Better Auth name, preference revision and cookies');

    // Genuine server-only verified-claims handoff; this does not test an external OIDC exchange.
    const oidcEmail=randomUUID()+'@preferences.test',invitation=await inviteMember(workspace,owner.id,{email:oidcEmail,role:'viewer'}),provider=randomUUID();
    const tx=await pool.connect();let oidc:Actor;try{await tx.query('BEGIN');const accepted=await acceptVerifiedOidcInvitation(tx,invitation.token,{email:oidcEmail,name:'OIDC preferences'});await tx.query(`INSERT INTO oidc_provider(id,draft,credential,active_revision,active,active_credential,enabled)VALUES($1,'{}','{}',1,'{}','{}',true)`,[provider]);const response=await getAuth(tx).api.completeOidcSession({body:{oidcUserId:accepted.userId},asResponse:true});assert.equal(response.status,200);oidc={id:accepted.userId,email:oidcEmail,cookie:cookies(response)};const session=await getAuth(tx).api.getSession({headers:{cookie:oidc.cookie},query:{disableRefresh:true}});assert.ok(session);await tx.query('UPDATE session SET "oidcProviderId"=$2 WHERE id=$1',[session.session.id,provider]);await tx.query('COMMIT');actors.push(oidc);}catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM account WHERE "userId"=$1',[oidc!.id])).rows[0].n,0);
    const oidcInitial=await read(oidc!);await save(oidc!,body(oidcInitial,{name:'OIDC saved',theme:'system'}));
    const oidcBefore=await ownRows(oidc!.id);await pool.query('UPDATE oidc_provider SET enabled=false WHERE id=$1',[provider]);
    await checked(api('/api/account/preferences',oidc!),401);await save(oidc!,body(oidcInitial,{name:'Disabled provider overwrite'}),401);assert.deepEqual(await ownRows(oidc!.id),oidcBefore);
    await pass('OIDC-only account preferences and disabled-provider current authority');

    // Membership is not account ownership: a signed-in user without workspaces keeps preferences.
    await pool.query('DELETE FROM membership WHERE user_id=$1',[viewer.id]);const noWorkspace=await read(viewer);await save(viewer,body(noWorkspace,{theme:'light'}));
    // Hold the actual serialization lock; require an observed blocked native read before revocation.
    const fresh=await read(second),stable=await ownRows(second.id),session=await getAuth().api.getSession({headers:{cookie:second.cookie},query:{disableRefresh:true}});assert.ok(session);
    const blocker=await pool.connect();let pending:Promise<Response>|undefined;
    try{await blocker.query('BEGIN');await blocker.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE',[second.id]);const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;pending=api('/api/account/preferences',second,body(fresh,{name:'Revoked during wait'}));const until=Date.now()+5000;let observed=false;while(Date.now()<until){if((await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))',[pid])).rowCount){observed=true;break;}await setTimeout(10);}assert.ok(observed,'The native preference request must actually wait on its user lock.');await blocker.query('DELETE FROM session WHERE id=$1 AND "userId"=$2',[session.session.id,second.id]);await blocker.query('COMMIT');await checked(pending,401);pending=undefined;}finally{await blocker.query('ROLLBACK').catch(()=>undefined);blocker.release();if(pending)await pending;}
    assert.deepEqual(await ownRows(second.id),stable);await checked(api('/api/account/preferences',second),401);
    await pass('workspace-independent settings and session revocation while the save waits');

    const factorActor=actors[2],enrollment=await(await checked(api('/api/account/two-factor/enable',factorActor,{password:factorActor.password}))).json();
    const secret=new URL(enrollment.totpURI).searchParams.get('secret');assert.ok(secret);
    const verification=await checked(api('/api/account/two-factor/verify',factorActor,{code:authenticatorCode(secret)}));factorActor.cookie=cookies(verification)||factorActor.cookie;
    const challenge=await checked(api('/api/auth/sign-in/email',undefined,{email:factorActor.email,password:factorActor.password}));assert.equal((await challenge.json()).twoFactorRedirect,true);
    const pendingActor={...factorActor,cookie:cookies(challenge)},factorBefore=await ownRows(factorActor.id);
    await checked(api('/api/account/preferences',pendingActor),401);await save(pendingActor,body(await read(factorActor),{name:'Incomplete factor overwrite'}),401);assert.deepEqual(await ownRows(factorActor.id),factorBefore);
    await pass('an incomplete two-factor sign-in cannot read or change account preferences');
    assert.equal(groups.length,7);assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_preference')).rows[0].n,5);
    const discovery=await checked(api('/api/auth/oidc/providers'));assert.deepEqual(await discovery.json(),{providers:[]});
  } catch(error){primaryFailure=error;} finally {
    async function cleanup(run:()=>Promise<unknown>){try{await run();}catch(error){cleanupErrors.push(error);}}
    if(constraintAdded)await cleanup(()=>pool.query(`ALTER TABLE user_preference DROP CONSTRAINT ${constraint}`));
    if(key&&actors[0])await cleanup(()=>revokeApiKey(workspace,actors[0].id,key!.id));
    await cleanup(async()=>{if(protectedBaseline)assert.deepEqual(await protectedRows(),protectedBaseline);});
    await cleanup(async()=>{assert.equal(outbound,0);await verifyOriginalRows();assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);});
    globalThis.fetch=originalFetch;
  }
  if(primaryFailure||cleanupErrors.length)throw new AggregateError([primaryFailure,...cleanupErrors].filter(Boolean),'Account preference acceptance failed; preserve the original cause and cleanup evidence.');
  return {groups,outbound,cleanupErrors:[]};
}

if(process.env.TEN98_INTEGRATION_TEST==='1'&&process.env.TEN98_ACCOUNT_PREFERENCES_TEST==='1'&&pathToFileURL(resolve(process.argv[1]??'')).href===import.meta.url)try{await runAccountPreferencesChecks();}finally{await closeDatabase();}
