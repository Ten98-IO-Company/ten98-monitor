import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {hashPassword} from 'better-auth/crypto';
import {claimInstallation} from '../src/server/auth.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {getConfig} from '../src/server/config.ts';
import {decryptCredentials} from '../src/server/credential-vault.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {listProviders,providerTransaction,revokeProvider,saveBudget,saveProvider} from '../src/server/providers.ts';
import {cancelReservation,dispatchSpend,requestHash,reserveSpend,reserveSpendInTransaction,settleSpend} from '../src/server/spending.ts';
import {createWorkspace} from '../src/server/teams.ts';

const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status' in error&&error.status===status;
const gate=(error:unknown)=>fail(409)(error)&&(error as {code?:unknown}).code==='SPENDING_BUDGET';
export async function runProviderSpendingControlsChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_PROVIDER_SPENDING_TEST,'1');
  const config=getConfig(),db=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_spending_ci';
  assert.ok(local.includes(db.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(db.port,ci?'5432':'55501');assert.ok(ci||/^\/ten98_spending_[a-f0-9]{12}$/.test(db.pathname));assert.equal(db.search,'');assert.equal(db.hash,'');
  for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
  await assertSchema();const {pool}=getDatabase();assert.equal((await pool.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n,0,'Use a fresh empty owned fixture.');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0);
  const originalFetch=globalThis.fetch;let outgoing=0;
  globalThis.fetch=async()=>{outgoing++;throw new Error('External requests forbidden in spending-controls acceptance.');};
  try{
    const email=randomUUID()+'@spending.test',password=randomBytes(24).toString('base64url');
    await claimInstallation({name:'Spending fixture',email,password,workspaceName:'Spending fixture'});
    const owner=(await pool.query('SELECT id FROM "user" WHERE email=$1',[email])).rows[0].id as string;
    const login=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email,password})}));
    assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.ok(cookie);
    const workspace=async()=>(await createWorkspace(owner,{name:'Spending controls fixture'})).workspace.id;
    const credentials={apiKey:'synthetic-'+randomUUID()};
    const connect=async(wid:string)=>(await saveProvider(wid,owner,{name:'Synthetic connection',provider:'openrouter',credentials})).connection;
    const row=async(id:string)=>(await pool.query('SELECT * FROM provider_connection WHERE id=$1',[id])).rows[0];
    const ledger=async(wid:string)=>(await pool.query('SELECT count(*)::int AS n FROM provider_request WHERE workspace_id=$1',[wid])).rows[0].n;
    const request=(connectionId:string,estimateUsd='6')=>({connectionId,estimateUsd,requestKey:randomUUID(),operation:'fixture.spending',inputHash:requestHash('synthetic input')});
    async function settle(wid:string,id:string,amount:string|null){const client=await pool.connect();try{await client.query('BEGIN');const result=await settleSpend(client,wid,id,amount);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
    async function http(path:string,status:number,body:unknown,options:{cookie?:string;origin?:string;token?:string;method?:string;raw?:string}={}){
      const headers:Record<string,string>={origin:options.origin??config.appUrl,'content-type':'application/json'};
      if(options.token)headers.authorization='Bearer '+options.token;else if(options.cookie!==null)headers.cookie=options.cookie??cookie;
      const response=await handleApi(new Request(config.appUrl+path,{method:options.method??'POST',headers,...(options.method==='GET'?{}:{body:options.raw??JSON.stringify(body)})}));
      assert.equal(response.status,status,path);const text=await response.text();assert.ok(!text.includes(credentials.apiKey)&&!text.includes('encrypted_credentials')&&!text.includes('ciphertext'));return text?JSON.parse(text):{};
    }
    // Owner decision D3: the per-connection cap and its route are gone; the guard battery now covers the manual pause route.
    const wid=await workspace(),a=await connect(wid),b=await connect(wid),route=`/api/workspaces/${wid}/budget`,edit={paused:true};
    await http(`/api/workspaces/${wid}/providers/${a.id}/limit`,404,{revision:a.revision,expectedMonthlyLimitUsd:'10',monthlyLimitUsd:'12.000001'});
    await http(route,401,edit,{cookie:''});await http(route,403,edit,{origin:'https://foreign.spending.test'});await http(route,404,{}, {method:'GET'});
    for(const bad of [{paused:'no'},{paused:false,monthlyLimitUsd:'1'},{...edit,credentials:{}}])await http(route,400,bad);
    await http(route,413,{}, {raw:JSON.stringify({padding:'x'.repeat(40_000)})});
    const token=(await createApiKey(wid,owner,{name:'Read-only fixture',scopes:['analytics:read']})).token;await http(route,403,edit,{token});
    const passwordHash=await hashPassword(password);
    for(const role of ['admin','editor','viewer']){
      const id=randomUUID(),memberEmail=id+'@spending.test';await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[id,role,memberEmail]);
      await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),id,passwordHash]);
      await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[wid,id,role]);
      const signed=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:memberEmail,password})}));assert.equal(signed.status,200);
      await http(route,404,edit,{cookie:signed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')});
    }
    const foreign=randomUUID();await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Foreign spending fixture')",[foreign]);
    await http(`/api/workspaces/${foreign}/budget`,404,edit);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace_budget WHERE workspace_id=ANY($1::text[])',[[wid,foreign]])).rows[0].n,0,'Refused pause requests write no budget row.');
    await http(`/api/workspaces/${wid}/providers`,400,{name:'Synthetic connection',provider:'openrouter',credentials,monthlyLimitUsd:'10'});
    await http(`/api/workspaces/${wid}/providers/${a.id}/update`,400,{name:'Synthetic connection',credentials,monthlyLimitUsd:'10'});
    await pool.query("UPDATE provider_connection SET check_status='ok',diagnostic='Synthetic check evidence',last_checked_at=clock_timestamp() WHERE id=$1",[a.id]);
    const before=await row(a.id);assert.equal(Object.hasOwn(before,'monthly_limit_micros'),false);
    assert.deepEqual(await http(route,200,{paused:true}),{ok:true});assert.equal((await listProviders(wid,owner)).budget.paused,true);
    assert.deepEqual(await http(route,200,{paused:false}),{ok:true});assert.equal((await listProviders(wid,owner)).budget.paused,false);
    assert.deepEqual(await row(a.id),before,'A pause toggle changes no connection column or encrypted byte.');
    assert.deepEqual(decryptCredentials(before.encrypted_credentials,{id:a.id,workspaceId:wid,provider:'openrouter',revision:a.revision}),credentials);
    console.log('PASS actual API owner/session/origin/key/body guards on the pause route, removed cap route and fields (D3), encrypted bytes and check evidence preserved');

    const keys=process.env.CREDENTIAL_KEYS,active=process.env.CREDENTIAL_ACTIVE_KEY;
    try{delete process.env.CREDENTIAL_KEYS;delete process.env.CREDENTIAL_ACTIVE_KEY;
      await saveBudget(wid,owner,{paused:true});await assert.rejects(saveBudget(wid,owner,{paused:false}),fail(503));
    }finally{process.env.CREDENTIAL_KEYS=keys;process.env.CREDENTIAL_ACTIVE_KEY=active;}
    await saveBudget(wid,owner,{paused:false});
    // Owner decision D3: a workspace without a budget row is unpaused, so its first reservation needs no owner action.
    const fresh=await workspace(),freshConnection=await connect(fresh);
    assert.equal((await pool.query('SELECT 1 FROM workspace_budget WHERE workspace_id=$1',[fresh])).rowCount,0);
    const freshBudget=(await listProviders(fresh,owner)).budget;assert.deepEqual(Object.keys(freshBudget),['paused','month','spentUsd','reservedUsd','uncertainUsd']);assert.equal(freshBudget.paused,false);
    assert.equal((await reserveSpend(fresh,owner,request(freshConnection.id))).created,true,'A new workspace starts unpaused.');
    assert.equal((await pool.query('SELECT 1 FROM workspace_budget WHERE workspace_id=$1',[fresh])).rowCount,0,'Reserving writes no implicit budget row.');
    // Owner decision D3: no connection cap, so concurrent and further reservations on one connection all commit.
    const uncapped=[...await Promise.all([reserveSpend(wid,owner,request(a.id)),reserveSpend(wid,owner,request(a.id))]),await reserveSpend(wid,owner,request(a.id,'5'))];
    assert.ok(uncapped.every(saved=>saved.created));assert.equal((await listProviders(wid,owner)).budget.reservedUsd,'17.000000');
    for(const saved of uncapped)await cancelReservation(wid,owner,saved.id);
    const same=request(a.id);let enqueued=0;
    const twins=await Promise.all([reserveSpend(wid,owner,same,async()=>{enqueued++;}),reserveSpend(wid,owner,same,async()=>{enqueued++;})]);
    assert.deepEqual(twins.map(saved=>saved.created).sort(),[false,true]);assert.equal(twins[0].id,twins[1].id);assert.equal(enqueued,1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request WHERE workspace_id=$1 AND request_key=$2',[wid,same.requestKey])).rows[0].n,1);
    await cancelReservation(wid,owner,twins[0].id);
    // One of two still wins a race: each racer records its own charge as uncertain, so the gate read after the lock refuses the other.
    const lost=()=>providerTransaction(wid,owner,['owner'],async client=>{const saved=await reserveSpendInTransaction(client,wid,owner,request(a.id));await client.query("UPDATE provider_request SET status='uncertain' WHERE id=$1",[saved.id]);return saved;});
    const race=await Promise.allSettled([lost(),lost()]);assert.equal(race.filter(v=>v.status==='fulfilled').length,1);assert.ok(race.some(v=>v.status==='rejected'&&gate(v.reason)));
    await settle(wid,(race.find(v=>v.status==='fulfilled') as PromiseFulfilledResult<{id:string}>).value.id,'6');
    console.log('PASS no-vault pause rule, unpaused new workspace, no connection cap (D3) and serialized idempotent reservations');

    const beforeRotation=await row(a.id);
    await http(`/api/workspaces/${wid}/providers/${a.id}/update`,400,{name:'Stale rotation',credentials:{apiKey:'different-synthetic'},monthlyLimitUsd:'10'});assert.deepEqual(await row(a.id),beforeRotation);
    const rotated=(await saveProvider(wid,owner,{name:'New credential',credentials},a.id)).connection;assert.equal(rotated.revision,2);assert.equal(rotated.name,'New credential');assert.equal(rotated.checkStatus,'untested');assert.equal(Object.hasOwn(rotated,'monthlyLimitUsd'),false);
    assert.deepEqual(decryptCredentials((await row(a.id)).encrypted_credentials,{id:a.id,workspaceId:wid,provider:'openrouter',revision:2}),credentials);
    const concurrent=await connect(wid),stale=await reserveSpend(wid,owner,request(concurrent.id,'1'));
    const rotations=await Promise.all(['First rotation','Second rotation'].map(name=>saveProvider(wid,owner,{name,credentials},concurrent.id)));
    assert.deepEqual(rotations.map(saved=>saved.connection.revision).sort(),[2,3]);const rotatedRow=await row(concurrent.id);assert.equal(rotatedRow.revision,3);
    assert.deepEqual(decryptCredentials(rotatedRow.encrypted_credentials,{id:concurrent.id,workspaceId:wid,provider:'openrouter',revision:3}),credentials);
    assert.throws(()=>decryptCredentials(rotatedRow.encrypted_credentials,{id:concurrent.id,workspaceId:wid,provider:'openrouter',revision:2}),fail(503));
    await assert.rejects(dispatchSpend(wid,owner,stale.id),(error:unknown)=>fail(409)(error)&&/Provider credentials changed/.test((error as Error).message));
    await revokeProvider(wid,owner,concurrent.id);await assert.rejects(reserveSpend(wid,owner,request(concurrent.id)),fail(404));await assert.rejects(saveProvider(wid,owner,{name:'Revoked rotation',credentials},concurrent.id),fail(404));
    console.log('PASS concurrent rotation preserves credential revision, authenticated encryption and revoked boundaries; removed cap field refused (D3)');

    const fixed=request(a.id,'3');let enqueues=0;const reserved=await reserveSpend(wid,owner,fixed,async()=>{enqueues++;});
    await saveBudget(wid,owner,{paused:true});assert.equal((await reserveSpend(wid,owner,fixed,async()=>{enqueues++;})).created,false);assert.equal(enqueues,1);
    await assert.rejects(reserveSpend(wid,owner,{...fixed,estimateUsd:'2'}),fail(409));await assert.rejects(reserveSpend(wid,owner,request(a.id,'1')),gate,'The manual pause refuses new work.');
    // Owner decision D3: the live manual pause, not a lowered cap, refuses dispatch before execution-specific preparation.
    let prepared=0;await assert.rejects(dispatchSpend(wid,owner,reserved.id,async()=>{prepared++;}),gate);assert.equal(prepared,0);
    await saveBudget(wid,owner,{paused:false});await dispatchSpend(wid,owner,reserved.id,async()=>{prepared++;});assert.equal(prepared,1);
    await assert.rejects(dispatchSpend(wid,owner,reserved.id,async()=>{prepared++;}),fail(409));assert.equal(prepared,1,'A reservation dispatches once.');
    await saveBudget(wid,owner,{paused:true});
    await settle(wid,reserved.id,'2.5');await settle(wid,reserved.id,'2.5');await assert.rejects(settle(wid,reserved.id,'2.4'),fail(409));assert.equal((await pool.query('SELECT actual_micros FROM provider_request WHERE id=$1',[reserved.id])).rows[0].actual_micros,'2500000');
    await saveBudget(wid,owner,{paused:false});
    // Owner decision D3: an unknown charge blocks the whole workspace through the ledger, and pauses nothing.
    const unknown=await reserveSpend(wid,owner,request(b.id,'1'));await dispatchSpend(wid,owner,unknown.id);await settle(wid,unknown.id,null);
    assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[unknown.id])).rows[0].status,'uncertain');assert.equal((await listProviders(wid,owner)).budget.paused,false);
    await assert.rejects(reserveSpend(wid,owner,request(a.id,'1')),gate,'Other connection uncertainty blocks workspace.');await assert.rejects(cancelReservation(wid,owner,unknown.id),fail(409));
    await settle(wid,unknown.id,'0.5');const overrun=await reserveSpend(wid,owner,request(b.id,'1'));await dispatchSpend(wid,owner,overrun.id);await settle(wid,overrun.id,'1.1');
    assert.equal((await pool.query('SELECT actual_micros FROM provider_request WHERE id=$1',[overrun.id])).rows[0].actual_micros,'1100000');assert.equal((await listProviders(wid,owner)).budget.paused,false);
    const next=await reserveSpend(wid,owner,request(b.id,'1'));assert.equal(next.created,true,'A recorded overrun does not block the next reservation.');await cancelReservation(wid,owner,next.id);
    console.log('PASS exact replay, manual pause at reserve and dispatch, immutable receipts, global uncertainty block without automatic pause and recorded overrun (D3)');

    const atomic=await workspace(),child=await connect(atomic);assert.match(atomic,/^[0-9a-f-]{36}$/);
    // Owner decision D3: no cap fails the second child, so a test-only uncertain sentinel lets the real gate refuse it.
    await pool.query(`CREATE FUNCTION spending_fixture_sentinel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id=TG_ARGV[0] AND NEW.operation<>'test.sentinel' AND (SELECT count(*) FROM provider_request WHERE workspace_id=NEW.workspace_id AND operation<>'test.sentinel')=TG_ARGV[1]::int THEN
        INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,status,budget_month)
          VALUES(gen_random_uuid(),NEW.workspace_id,NEW.connection_id,NEW.connection_revision,NEW.user_id,gen_random_uuid(),'test.sentinel',repeat('0',64),1,'uncertain',NEW.budget_month);
      END IF; RETURN NULL; END $$`);
    try{
      await pool.query(`CREATE TRIGGER spending_fixture_sentinel AFTER INSERT ON provider_request FOR EACH ROW EXECUTE FUNCTION spending_fixture_sentinel('${atomic}','1')`);
      await assert.rejects(providerTransaction(atomic,owner,['owner'],async client=>{await reserveSpendInTransaction(client,atomic,owner,request(child.id,'3'));await reserveSpendInTransaction(client,atomic,owner,request(child.id,'3'));}),gate);
    }finally{await pool.query('DROP TRIGGER IF EXISTS spending_fixture_sentinel ON provider_request');await pool.query('DROP FUNCTION spending_fixture_sentinel()');}
    assert.equal(await ledger(atomic),0,'The rollback removes both children and the sentinel.');
    const reused=request(child.id,'3');
    await assert.rejects(providerTransaction(atomic,owner,['owner'],async client=>{await reserveSpendInTransaction(client,atomic,owner,reused);await reserveSpendInTransaction(client,atomic,owner,{...request(child.id,'3'),requestKey:reused.requestKey,inputHash:requestHash('different work')});}),(error:unknown)=>fail(409)(error)&&/already used for different work/.test((error as Error).message));
    assert.equal(await ledger(atomic),0);
    const outstanding=await reserveSpend(atomic,owner,request(child.id,'4'));await pool.query("UPDATE provider_request SET budget_month=(date_trunc('month',clock_timestamp())-interval '1 month')::date WHERE id=$1",[outstanding.id]);
    assert.equal((await listProviders(atomic,owner)).budget.reservedUsd,'4.000000','Prior-month outstanding work stays in current usage.');
    await reserveSpend(atomic,owner,request(child.id,'2'));assert.equal((await listProviders(atomic,owner)).budget.reservedUsd,'6.000000');
    await dispatchSpend(atomic,owner,outstanding.id);
    assert.equal((await pool.query("SELECT budget_month=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date AS current FROM provider_request WHERE id=$1",[outstanding.id])).rows[0].current,true,'Dispatch re-stamps the usage month.');
    const budgetRows=async()=>(await pool.query('SELECT * FROM workspace_budget WHERE workspace_id=$1',[atomic])).rows,budgetBefore=await budgetRows();
    const holder=await pool.connect();let waiting:Promise<unknown>|undefined;
    try{await holder.query('BEGIN');await holder.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[atomic]);const blocker=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await holder.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[atomic,owner]);
      waiting=saveBudget(atomic,owner,{paused:true});void waiting.catch(()=>undefined);
      const deadline=Date.now()+3000;let observed=false;while(Date.now()<deadline){observed=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))",[blocker])).rowCount;if(observed)break;await delay(10);}assert.equal(observed,true,'Observe actual workspace gate contention.');
      await holder.query('COMMIT');await assert.rejects(waiting,fail(404));
    }finally{await holder.query('ROLLBACK').catch(()=>undefined);holder.release();await waiting?.catch(()=>undefined);}
    assert.deepEqual(await budgetRows(),budgetBefore,'The refused pause leaves the budget state unchanged.');
    assert.equal(outgoing,0);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);
    console.log('PASS atomic multi-child rollback through the real uncertain-charge gate, outstanding month reporting and observed gate wait with fresh role denial (D3)');
  }finally{globalThis.fetch=originalFetch;await closeDatabase();}
}

if(process.env.TEN98_PROVIDER_SPENDING_TEST==='1')await runProviderSpendingControlsChecks();
