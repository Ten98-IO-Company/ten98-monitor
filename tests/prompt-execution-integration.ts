import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,stopJobs,startWorker} from '../src/server/jobs.ts';
import {saveProvider,saveBudget,revokeProvider} from '../src/server/providers.ts';
import {createPrompts,updatePrompt,setPromptArchived,listPrompts} from '../src/server/prompts.ts';
import {getPromptExecutions,getPromptComparison,getPromptComparisonSummary,getPromptExecutionResult,getPromptExecutionCitations,quotePromptExecution,startPromptExecution,cancelPromptComparison,executePromptComparison,executePromptExecution,promptExecutionQueue,reconcilePromptExecution,reconcilePromptExecutionJobs} from '../src/server/prompt-execution.ts';
import {refreshOpenRouterCatalog} from '../src/server/openrouter-models.ts';
import {openRouterRefusal} from '../src/server/openrouter.ts';
import {runRetentionBatch,previewRetention,getRetention} from '../src/server/retention.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {getPromptInsights} from '../src/server/prompt-insights.ts';

export async function runPromptExecutionChecks(){
 assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
 const config=getConfig();assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(config.databaseUrl).hostname));
 const pool=getDatabase().pool,owner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),foreign=randomUUID(),password=randomBytes(32).toString('base64url');
 for(const user of [owner,editor,viewer,foreign])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Prompt fixture\',$2)',[user,`${user}@execution.integration.test`]);
 await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner,await hashPassword(password)]);
 const mini='openai/gpt-4o-mini' as const,models=[mini,'openai/gpt-4o'] as const;
 let paid=0,free=0,mode:'ok'|'unknown'|'truncated'|'over'|'answer_unknown'|'byok'|'invalid'|'empty'|'pending'|'refused'|'refused_receipt'='ok',priceChanged=false,priceModel:string|null=null,receiptChange:Record<string,unknown>={};
 const receipts=new Map<string,any>(),sent:string[]=[];
 const send:typeof fetch=async(url,init)=>{
  assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);const address=String(url);
  if(address==='https://openrouter.ai/api/v1/models?output_modalities=text&offset=0&limit=500'){free++;const data=['openai/gpt-4o-mini','openai/gpt-4o'].map(model=>({id:model,canonical_slug:model,name:model,architecture:{input_modalities:['text'],output_modalities:['text']},context_length:128000,top_provider:{max_completion_tokens:16384},supported_parameters:['max_tokens'],pricing:{prompt:'0.00000015',completion:'0.0000006',request:'0'}}));return Response.json({data,total_count:data.length,links:{next:null}});}
  if(address==='https://openrouter.ai/api/v1/key'){free++;return Response.json({data:{is_free_tier:false,is_management_key:false}});}
  if(address.endsWith('/endpoints')){free++;const model=address.includes('gpt-4o-mini')?mini:models[1];return Response.json({data:{id:model,architecture:{input_modalities:['text'],output_modalities:['text']},endpoints:[{tag:'openai',provider_name:'OpenAI',model_id:model,status:0,context_length:128000,max_prompt_tokens:null,max_completion_tokens:16384,supported_parameters:['max_tokens'],pricing:{prompt:priceChanged||model===priceModel?'0.00000016':'0.00000015',completion:'0.0000006',input_cache_read:'0.000000075',discount:0}}]}});}
  if(address.startsWith('https://openrouter.ai/api/v1/generation?id=')){free++;return Response.json({data:{...receipts.get(new URL(address).searchParams.get('id')!),...receiptChange}});}
  assert.equal(address,'https://openrouter.ai/api/v1/chat/completions');assert.equal(init?.method,'POST');paid++;const input=JSON.parse(String(init?.body));sent.push(input.session_id);assert.deepEqual(input.provider.only,['openai']);assert.equal(input.provider.allow_fallbacks,false);
  if(mode==='unknown')throw new Error('Synthetic unavailable response, never live.');
  // OpenRouter's documented credit refusal for the first model only; the receipt-carrying variant also sends a generation header.
  if((mode==='refused'||mode==='refused_receipt')&&input.model===mini)return Response.json({error:{code:402,message:'Synthetic insufficient credits',metadata:{limit_source:'openrouter_credits'}}},{status:402,headers:mode==='refused_receipt'?{'x-generation-id':'gen-'+randomUUID()}:{}});
  const id='gen-'+randomUUID(),created=Math.floor(Date.now()/1000),cost=mode==='over'?0.04:mode==='answer_unknown'?1000001:0.000012345;
  receipts.set(id,{id,model:input.model,provider_name:'OpenAI',session_id:input.session_id,external_user:input.user,created_at:new Date(created*1000).toISOString(),finish_reason:'stop',is_byok:mode==='byok',total_cost:cost,upstream_inference_cost:mode==='byok'?0.01:0});
  if(mode==='truncated')return new Response('{broken',{headers:{'x-generation-id':id}});
  return Response.json({id,model:input.model,provider:'OpenAI',created,choices:[{finish_reason:mode==='pending'?null:'stop',message:{content:mode==='invalid'?'bad\0':mode==='empty'?'':'Synthetic untrusted answer'}}],usage:{cost,is_byok:mode==='byok',prompt_tokens:12,completion_tokens:20}},{headers:{'x-generation-id':id}});
 };
 const blocked:typeof fetch=async()=>{throw new Error('Real provider traffic is forbidden in execution tests.');};
 const originalFetch=globalThis.fetch;globalThis.fetch=blocked;
 async function fixture(){
  const workspace=randomUUID(),project=randomUUID();await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Prompt execution integration')",[workspace]);
  for(const [user,role] of [[owner,'owner'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,user,role]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Prompts','https://'||$1||'.integration.test',$3,'infinity')",[project,workspace,randomUUID()]);
  const connection=(await saveProvider(workspace,owner,{provider:'openrouter',name:'Synthetic only',credentials:{apiKey:'synthetic-never-live'}})).connection;
  await pool.query("UPDATE provider_connection SET check_status='ok' WHERE id=$1",[connection.id]);await saveBudget(workspace,owner,{paused:false});
  const prompt=(await createPrompts(project,owner,{requestId:randomUUID(),prompts:[{text:'Exact original prompt',enabled:false}]})).items[0];
  return {workspace,project,connectionId:connection.id,prompt,request:{connectionId:connection.id,promptId:prompt.id,versionId:prompt.currentVersionId,systemText:'Explicit system text',models:[...models],maxCompletionTokens:2048,fundedCredits:true as const}};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 const quote=async(f:Fixture,user=owner)=>(await quotePromptExecution(f.project,user,f.request,send)).quote;
 const start=async(f:Fixture,user=owner)=>(await startPromptExecution(f.project,user,{quoteId:(await quote(f,user)).id,requestKey:randomUUID()})).comparison;
 const detail=async(f:Fixture,id:string)=>(await getPromptComparison(f.project,owner,id)).comparison;
 const ledger=async(id:string)=>(await pool.query('SELECT status,actual_micros,provider_reference FROM provider_request WHERE id=$1',[id])).rows[0];
 // Owner decision D3 removed the cap that used to refuse a later child. This uncertain sentinel is the real
 // replacement trigger: once the workspace holds n reservations, one uncertain row makes the next child meet
 // spendingGate's 409 inside the same transaction, so the rollback must also remove the sentinel.
 async function withUncertainSentinel<T>(workspace:string,n:number,action:()=>Promise<T>){
  await pool.query(`CREATE FUNCTION prompt_execution_sentinel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.operation<>'test.sentinel' AND NEW.workspace_id=TG_ARGV[0] AND (SELECT count(*) FROM provider_request WHERE workspace_id=NEW.workspace_id AND operation<>'test.sentinel')=TG_ARGV[1]::int THEN
    INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,status,budget_month)
    VALUES(gen_random_uuid(),NEW.workspace_id,NEW.connection_id,NEW.connection_revision,NEW.user_id,gen_random_uuid(),'test.sentinel',repeat('0',64),1,'uncertain',NEW.budget_month);
   END IF; RETURN NULL; END $$`);
  await pool.query(`CREATE TRIGGER prompt_execution_sentinel AFTER INSERT ON provider_request FOR EACH ROW EXECUTE FUNCTION prompt_execution_sentinel('${workspace}','${n}')`);
  try{return await action();}finally{await pool.query('DROP TRIGGER prompt_execution_sentinel ON provider_request');await pool.query('DROP FUNCTION prompt_execution_sentinel()');}
 }
 try{
  const f=await fixture(),freeBefore=free;assert.equal((await getPromptExecutions(f.project,viewer)).role,'viewer');assert.equal(free,freeBefore);assert.equal(paid,0);
  assert.deepEqual((await listPrompts(f.project,viewer,new URLSearchParams())).execution,{available:true,schedulingAvailable:false,nextRunAt:null});assert.equal(free,freeBefore);
  await assert.rejects(quote(f,viewer),{status:404});await assert.rejects(getPromptExecutions(f.project,foreign),{status:404});
  const q=await quote(f),key=randomUUID();assert.equal(q.estimateUsd,'0.040858');assert.deepEqual(q.messages,[{role:'system',content:'Explicit system text'},{role:'user',content:'Exact original prompt'}]);
  const [first,retry]=await Promise.all([startPromptExecution(f.project,owner,{quoteId:q.id,requestKey:key}),startPromptExecution(f.project,owner,{quoteId:q.id,requestKey:key})]);assert.equal(first.comparison.id,retry.comparison.id);assert.equal(first.comparison.runs.length,2);
  const q2=await quote(f);await assert.rejects(startPromptExecution(f.project,owner,{quoteId:q2.id,requestKey:key}),{status:409});await assert.rejects(startPromptExecution(f.project,editor,{quoteId:q.id,requestKey:randomUUID()}),{status:404});
  await updatePrompt(f.project,owner,f.prompt.id,{requestId:randomUUID(),revision:1,text:'Later prompt text'});
  await Promise.all([executePromptComparison(first.comparison.id,send),executePromptComparison(first.comparison.id,send)]);assert.equal(paid,2);const done=await detail(f,first.comparison.id);assert.equal(done.messages[1].content,'Exact original prompt');assert.deepEqual(done.runs.map((r:any)=>r.status),['completed','completed']);assert.equal(done.runs[0].actualUsd,'0.000013');
  await executePromptComparison(done.id,send);assert.equal(paid,2);assert.equal((await startPromptExecution(f.project,owner,{quoteId:q.id,requestKey:key})).comparison.id,done.id);
  assert.deepEqual(done.prompt,{id:f.prompt.id,versionId:f.request.versionId,textPreview:'Exact original prompt'});assert.equal(done.canCancel,false);
  const other=await fixture();await assert.rejects(getPromptComparison(other.project,owner,done.id),{status:404});
  console.log('PASS actor/project/immutable-version binding, exact quote, atomic retry and one dispatch per comparison child');

  const permissions=await fixture(),authored='a'.repeat(159)+'😀'+'later text';
  const longPrompt=(await createPrompts(permissions.project,owner,{requestId:randomUUID(),prompts:[{text:authored,enabled:false}]})).items[0];
  permissions.request.promptId=longPrompt.id;permissions.request.versionId=longPrompt.currentVersionId;
  const permissionQuote=await quotePromptExecution(permissions.project,editor,permissions.request,send);assert.equal(permissionQuote.role,'editor');
  const permissionKey=randomUUID(),permissionStart=await startPromptExecution(permissions.project,editor,{quoteId:permissionQuote.quote.id,requestKey:permissionKey});
  assert.equal(permissionStart.role,'editor');assert.equal(permissionStart.comparison.canCancel,true);
  assert.deepEqual(permissionStart.comparison.prompt,{id:longPrompt.id,versionId:longPrompt.currentVersionId,textPreview:'a'.repeat(159)+'😀'});
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')",[permissions.workspace,foreign]);
  for(const [user,role,canCancel] of [[owner,'owner',true],[editor,'editor',true],[viewer,'viewer',false],[foreign,'admin',false]] as const){
   const response=await getPromptComparison(permissions.project,user,permissionStart.comparison.id);
   assert.equal(response.role,role);assert.equal(response.comparison.canCancel,canCancel);
   const listed=await getPromptExecutions(permissions.project,user);assert.equal(listed.comparisons[0].canCancel,canCancel);assert.deepEqual(listed.comparisons[0].prompt,response.comparison.prompt);
  }
  await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[permissions.workspace,editor]);
  const demoted=await getPromptComparison(permissions.project,editor,permissionStart.comparison.id);assert.equal(demoted.role,'viewer');assert.equal(demoted.comparison.canCancel,false);
  await assert.rejects(cancelPromptComparison(permissions.project,editor,permissionStart.comparison.id,{}),{status:404});
  const cancelledByOwner=await cancelPromptComparison(permissions.project,owner,permissionStart.comparison.id,{});assert.equal(cancelledByOwner.role,'owner');assert.equal(cancelledByOwner.comparison.canCancel,false);
  await pool.query("UPDATE membership SET role='editor' WHERE workspace_id=$1 AND user_id=$2",[permissions.workspace,editor]);
  await pool.query("UPDATE prompt_execution_quote SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[permissionQuote.quote.id]);
  const recoveredStart=await startPromptExecution(permissions.project,editor,{quoteId:permissionQuote.quote.id,requestKey:permissionKey});assert.equal(recoveredStart.role,'editor');assert.equal(recoveredStart.comparison.id,permissionStart.comparison.id);assert.equal(recoveredStart.comparison.canCancel,false);assert.equal(paid,2);
  console.log('PASS current-role cancellation metadata, immutable bounded authored preview and accepted-start recovery after quote expiry');

  const budget=await fixture();await withUncertainSentinel(budget.workspace,1,()=>assert.rejects(start(budget),{status:409,code:'SPENDING_BUDGET'}));assert.equal((await pool.query('SELECT id FROM provider_request WHERE workspace_id=$1',[budget.workspace])).rowCount,0);assert.equal((await pool.query('SELECT id FROM prompt_comparison WHERE workspace_id=$1',[budget.workspace])).rowCount,0);
  const rollback=await fixture(),rq=await quote(rollback),boss=await getBoss(),originalSend=boss.send.bind(boss);let insertedQueueId:string|undefined;boss.send=(async(...args:any[])=>{insertedQueueId=await (originalSend as any)(...args);throw new Error('Synthetic failure after queue insertion');}) as typeof boss.send;
  try{await assert.rejects(startPromptExecution(rollback.project,owner,{quoteId:rq.id,requestKey:randomUUID()}));}finally{boss.send=originalSend;}
  assert.equal((await pool.query('SELECT id FROM provider_request WHERE workspace_id=$1',[rollback.workspace])).rowCount,0);assert.ok(insertedQueueId);assert.equal((await pool.query('SELECT id FROM pgboss.job WHERE id=$1',[insertedQueueId])).rowCount,0);
  const second=await fixture(),sq=await quote(second),secondIds:string[]=[];boss.send=(async(...args:any[])=>{const inserted=await (originalSend as any)(...args);secondIds.push(inserted);if(secondIds.length===2)throw new Error('Synthetic failure after the second child job insertion');return inserted;}) as typeof boss.send;
  try{await assert.rejects(startPromptExecution(second.project,owner,{quoteId:sq.id,requestKey:randomUUID()}));}finally{boss.send=originalSend;}
  const nulled=await fixture(),nq=await quote(nulled);boss.send=(async()=>null) as typeof boss.send;
  try{await assert.rejects(startPromptExecution(nulled.project,owner,{quoteId:nq.id,requestKey:randomUUID()}),/Request could not be queued/);}finally{boss.send=originalSend;}
  assert.equal((await pool.query('SELECT id FROM provider_request WHERE workspace_id=$1',[nulled.workspace])).rowCount,0);assert.equal((await pool.query('SELECT id FROM prompt_comparison WHERE workspace_id=$1',[nulled.workspace])).rowCount,0);
  assert.equal(secondIds.length,2);assert.ok(secondIds.every(Boolean));assert.equal((await pool.query('SELECT id FROM provider_request WHERE workspace_id=$1',[second.workspace])).rowCount,0);assert.equal((await pool.query('SELECT id FROM prompt_comparison WHERE workspace_id=$1',[second.workspace])).rowCount,0);assert.equal((await pool.query('SELECT id FROM pgboss.job WHERE id=ANY($1::uuid[])',[secondIds])).rowCount,0);
  const expired=await fixture(),eq=await quote(expired);await pool.query("UPDATE prompt_execution_quote SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[eq.id]);await assert.rejects(startPromptExecution(expired.project,owner,{quoteId:eq.id,requestKey:randomUUID()}),{status:409});
  // Owner decision D3: no cap decides between concurrent starts; different quotes both start and one quote starts once.
  const competition=await fixture(),cq1=await quote(competition),cq2=await quote(competition);const concurrent=await Promise.allSettled([startPromptExecution(competition.project,owner,{quoteId:cq1.id,requestKey:randomUUID()}),startPromptExecution(competition.project,owner,{quoteId:cq2.id,requestKey:randomUUID()})]);assert.equal(concurrent.filter(v=>v.status==='fulfilled').length,2);
  const cq3=await quote(competition),sameQuote=await Promise.allSettled([startPromptExecution(competition.project,owner,{quoteId:cq3.id,requestKey:randomUUID()}),startPromptExecution(competition.project,owner,{quoteId:cq3.id,requestKey:randomUUID()})]);assert.equal(sameQuote.filter(v=>v.status==='fulfilled').length,1);
  const refusedStart=sameQuote.find(v=>v.status==='rejected') as PromiseRejectedResult;assert.equal(refusedStart.reason.status,409);assert.equal(refusedStart.reason.message,'This quote already started a comparison.');assert.equal((await pool.query('SELECT count(*)::int AS n FROM prompt_comparison WHERE quote_id=$1',[cq3.id])).rows[0].n,1);
  console.log('PASS second-child reservation failure and enqueue failure roll back every reservation; starts of one quote serialize (D3)');

  let before=paid;
  for(const changed of ['role','archive','credentials','price','cancel'] as const){
   const g=await fixture(),run=await start(g,editor);
   if(changed==='role')await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[g.workspace,editor]);
   if(changed==='archive')await setPromptArchived(g.project,owner,g.prompt.id,true,{requestId:randomUUID(),revision:1});
   if(changed==='credentials')await revokeProvider(g.workspace,owner,g.connectionId);
   if(changed==='price')priceChanged=true;
   if(changed==='cancel')await cancelPromptComparison(g.project,owner,run.id,{});
   await executePromptComparison(run.id,send);priceChanged=false;assert.equal(paid,before);assert.ok((await detail(g,run.id)).runs.every((r:any)=>r.status==='cancelled'));
  }
  const inFlight=await fixture(),inFlightRun=await start(inFlight,editor);let ready!:()=>void,release!:()=>void;
  const preflightReady=new Promise<void>(r=>ready=r),preflightGate=new Promise<void>(r=>release=r);
  const waiting=executePromptComparison(inFlightRun.id,async(...args)=>{if(String(args[0]).endsWith('/endpoints')){ready();await preflightGate;}return send(...args);});
  await preflightReady;await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[inFlight.workspace,editor]);release();await waiting;assert.equal(paid,before);assert.ok((await detail(inFlight,inFlightRun.id)).runs.every((r:any)=>r.status==='cancelled'));
  for(const kind of ['invalid','empty','over','byok'] as const){
   mode='ok';const g=await fixture(),run=await start(g),sentBefore:number=paid;mode=kind;await executePromptComparison(run.id,send);const result=await detail(g,run.id);assert.equal(result.runs[0].chargeStatus,'settled');
   if(kind==='invalid'){assert.equal(result.runs[0].status,'failed');assert.ok(result.runs[0].diagnostic);}
   if(kind==='empty')assert.equal(result.runs[0].result.text,'');
   // Owner decision D3: a known overrun or BYOK charge is recorded; nothing pauses, so the sibling still runs.
   if(kind==='over'||kind==='byok'){assert.equal(result.runs[1].status,'completed');assert.equal(paid,sentBefore+2);assert.equal((await getPromptExecutions(g.project,owner)).spendingPaused,false);}
   if(kind==='over')assert.ok(Number(result.runs[0].actualUsd)>Number(result.runs[0].estimateUsd));
  }
  console.log('PASS live role/archive/key/price/cancel gates, charged malformed or empty answers, overrun/BYOK recorded without stopping remaining children (D3)');

  // Owner decision D3: a credit refusal without generation evidence fails its child with a $0 receipt; the sibling and the next Start proceed.
  mode='refused';const wallet=await fixture(),walletRun=await start(wallet);const walletPaid=paid;await executePromptComparison(walletRun.id,send);const walletRuns=(await detail(wallet,walletRun.id)).runs;
  assert.equal(paid,walletPaid+2);assert.deepEqual(walletRuns.map((r:any)=>[r.status,r.chargeStatus]),[['failed','settled'],['completed','settled']]);
  assert.equal(walletRuns[0].actualUsd,'0.000000');assert.equal(walletRuns[0].diagnostic,openRouterRefusal({error:{code:402}},402,null)!.diagnostic);assert.match(walletRuns[0].diagnostic!,/no credit left/);assert.equal(walletRuns[0].result,null);assert.equal(walletRuns[0].generationId,null);
  assert.deepEqual(await ledger(walletRuns[0].id),{status:'settled',actual_micros:'0',provider_reference:null});assert.equal((await getPromptExecutions(wallet.project,owner)).spendingPaused,false);
  await executePromptComparison(walletRun.id,send);assert.equal(paid,walletPaid+2);
  mode='ok';const nextRun=await start(wallet);await executePromptComparison(nextRun.id,send);assert.deepEqual((await detail(wallet,nextRun.id)).runs.map((r:any)=>[r.status,r.chargeStatus]),[['completed','settled'],['completed','settled']]);assert.equal(paid,walletPaid+4);
  mode='refused_receipt';const receipted=await fixture(),receiptedRun=await start(receipted);const receiptedPaid=paid;await executePromptComparison(receiptedRun.id,send);const receiptedRuns=(await detail(receipted,receiptedRun.id)).runs;
  assert.equal(paid,receiptedPaid+1);assert.deepEqual(receiptedRuns.map((r:any)=>r.status),['uncertain','cancelled']);assert.ok(receiptedRuns[0].generationId);assert.equal((await ledger(receiptedRuns[0].id)).status,'uncertain');
  mode='ok';await assert.rejects(start(receipted),{status:409,code:'SPENDING_BUDGET'});assert.equal(paid,receiptedPaid+1);
  console.log('PASS OpenRouter credit refusal settles its child at $0 while the sibling and the next start proceed; a refusal carrying a generation header stays uncertain (D3)');
  // Owner decision D3(6): Start authorizes every child and keys one zero-retry job to each child; quote age
  // after Start, sibling order and one child's refusal stop no sibling, and the sweeper decides per child.
  mode='ok';const aged=await fixture(),agedRun=await start(aged);
  await pool.query("UPDATE prompt_execution_quote SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[agedRun.quoteId]);
  await reconcilePromptExecutionJobs();assert.deepEqual((await detail(aged,agedRun.id)).runs.map((r:any)=>[r.status,r.chargeStatus]),[['queued','reserved'],['queued','reserved']],'Live child-keyed jobs cover their children after the quote ages.');
  before=paid;await executePromptComparison(agedRun.id,send);assert.deepEqual((await detail(aged,agedRun.id)).runs.map((r:any)=>[r.status,r.chargeStatus]),[['completed','settled'],['completed','settled']]);assert.equal(paid,before+2);
  const ordered=await fixture(),orderedRun=await start(ordered);before=paid;await executePromptExecution(orderedRun.runs[1].id,send);
  const halfway=await detail(ordered,orderedRun.id);assert.deepEqual(halfway.runs.map((r:any)=>r.status),['queued','completed']);assert.equal(halfway.canCancel,true);assert.equal(paid,before+1);
  await executePromptExecution(orderedRun.runs[0].id,send);await executePromptExecution(orderedRun.runs[1].id,send);const orderedDone=await detail(ordered,orderedRun.id);
  assert.deepEqual(orderedDone.runs.map((r:any)=>r.status),['completed','completed']);assert.equal(orderedDone.canCancel,false);assert.equal(paid,before+2);for(const r of orderedRun.runs)assert.equal(sent.filter(v=>v===r.id).length,1);
  const drifted=await fixture(),driftRun=await start(drifted);before=paid;priceModel=mini;try{await executePromptComparison(driftRun.id,send);}finally{priceModel=null;}
  const driftDone=await detail(drifted,driftRun.id);assert.deepEqual(driftDone.runs.map((r:any)=>[r.model,r.status,r.chargeStatus]),[[mini,'cancelled','cancelled'],[models[1],'completed','settled']]);
  assert.equal(driftDone.runs[0].diagnostic,'Not dispatched because the endpoint, permissions, credentials, the paid-work pause or an uncertain charge changed.');assert.equal(paid,before+1);assert.ok(!sent.includes(driftRun.runs[0].id));
  // Start sent exactly one job per child: id and executionId equal the child, zero retries, 180 seconds, no comparison-keyed job.
  // Deleting the first child's job leaves that child jobless; the worker group below runs the second child's job.
  const swept=await fixture(),sweptRun=await start(swept),sweptChild=sweptRun.runs[1].id;before=paid;
  const sweptJobs=(await pool.query("SELECT id,retry_limit,expire_seconds,data FROM pgboss.job WHERE name='prompt-execution' AND (id=$1::uuid OR data->>'comparisonId'=$2) ORDER BY id",[sweptRun.id,sweptRun.id])).rows;
  assert.deepEqual(sweptJobs,sweptRun.runs.map((r:any)=>r.id).sort().map((id:string)=>({id,retry_limit:0,expire_seconds:180,data:{executionId:id,comparisonId:sweptRun.id}})));
  await pool.query('DELETE FROM pgboss.job WHERE id=$1',[sweptRun.runs[0].id]);
  await reconcilePromptExecutionJobs();const sweptDetail=await detail(swept,sweptRun.id);assert.deepEqual(sweptDetail.runs.map((r:any)=>[r.status,r.chargeStatus]),[['cancelled','cancelled'],['queued','reserved']]);
  assert.equal(sweptDetail.runs[0].diagnostic,'The queued request did not run. Prepare a new quote to try again.');assert.equal(paid,before);
  console.log('PASS Start authorizes every child (D3): quote age after Start, sibling order and a price change on one model stop no sibling; the sweeper cancels only a jobless queued child');

  mode='ok';const uncertain=await fixture(),uncertainRun=await start(uncertain);mode='truncated';await executePromptComparison(uncertainRun.id,send);const unresolved=await detail(uncertain,uncertainRun.id),child=unresolved.runs[0];assert.equal(child.status,'uncertain');assert.ok(child.generationId);assert.equal(unresolved.runs[1].status,'cancelled');before=paid;await executePromptComparison(uncertainRun.id,send);assert.equal(paid,before);
  // Owner decision D3: the uncertain child cancels its sibling and blocks new work through the ledger, without pausing.
  assert.equal((await getPromptExecutions(uncertain.project,owner)).spendingPaused,false);await saveBudget(uncertain.workspace,owner,{paused:false});await assert.rejects(start(uncertain),{status:409,code:'SPENDING_BUDGET'});
  await assert.rejects(reconcilePromptExecution(uncertain.project,editor,child.id,{},send),{status:404});
  for(const change of [{id:'gen-other'},{session_id:'foreign'},{external_user:'foreign'},{finish_reason:null},{total_cost:'0.01'}]){receiptChange=change;assert.equal((await reconcilePromptExecution(uncertain.project,owner,child.id,{},send)).reconciliation.status,'inconclusive');assert.equal((await ledger(child.id)).status,'uncertain');}
  // Expiring copied input must not orphan an unresolved charge or restore payload on recovery.
  await pool.query("UPDATE prompt_execution SET completed_at=clock_timestamp()-interval '91 days' WHERE comparison_id=$1",[uncertainRun.id]);
  const preservedSql=`SELECT row_to_json(p) AS ledger,r.generation_id,r.evidence,r.route,r.dispatched_at,
    q.request_actor,q.key_fingerprint,q.input_hash,q.routes,c.request_key,c.quote_id
    FROM prompt_execution r JOIN provider_request p ON p.id=r.id JOIN prompt_comparison c ON c.id=r.comparison_id
    JOIN prompt_execution_quote q ON q.id=c.quote_id WHERE r.id=$1`;
  const preserved=(await pool.query(preservedSql,[child.id])).rows[0],originalReceipt={...receipts.get(child.generationId)},readsBeforePurge=free;
  const expiredUncertain=await runRetentionBatch(uncertain.project);
  assert.equal(expiredUncertain?.expiredPromptInputs,1);assert.equal(expiredUncertain?.expiredPromptResults,0);
  const purgedUncertain=await detail(uncertain,uncertainRun.id);
  assert.equal(purgedUncertain.inputExpired,true);assert.equal(purgedUncertain.input,null);assert.equal(purgedUncertain.messages,null);
  assert.deepEqual(purgedUncertain.prompt,{id:uncertain.prompt.id,versionId:uncertain.request.versionId,textPreview:'Exact original prompt'});assert.equal(purgedUncertain.canCancel,false);
  assert.deepEqual(purgedUncertain.runs.map((r:any)=>r.status),['uncertain','cancelled']);assert.equal(purgedUncertain.runs[0].result,null);
  assert.deepEqual((await pool.query(preservedSql,[child.id])).rows[0],preserved);assert.equal(free,readsBeforePurge);assert.equal(paid,before);
  receiptChange={};assert.equal((await reconcilePromptExecution(uncertain.project,owner,child.id,{},send)).reconciliation.status,'matched');const recovered=(await detail(uncertain,uncertainRun.id)).runs[0];assert.equal(recovered.status,'reconciled');assert.equal(recovered.result,null);assert.equal((await getPromptExecutions(uncertain.project,owner)).spendingPaused,false);assert.equal(paid,before);
  const recoveredComparison=await detail(uncertain,uncertainRun.id);
  assert.equal(recoveredComparison.inputExpired,true);assert.equal(recoveredComparison.input,null);assert.equal(recoveredComparison.messages,null);
  assert.equal(recovered.generationId,child.generationId);assert.equal(recovered.chargeStatus,'settled');assert.equal(recovered.actualUsd,'0.000013');
  assert.deepEqual(receipts.get(child.generationId),originalReceipt);assert.equal(free,readsBeforePurge+1);
  await executePromptComparison(uncertainRun.id,send);assert.equal(paid,before);
  // Owner decision D3: once the charge is reconciled, a new Start is admitted with no unpause step.
  const resumedStart=await start(uncertain);assert.equal(resumedStart.runs.length,2);await cancelPromptComparison(uncertain.project,owner,resumedStart.id,{});assert.equal(paid,before);
  mode='ok';const missing=await fixture(),missingRun=await start(missing);mode='unknown';await executePromptComparison(missingRun.id,send);const noId=(await detail(missing,missingRun.id)).runs[0];const freeCount=free;assert.equal((await reconcilePromptExecution(missing.project,owner,noId.id,{},send)).reconciliation.status,'inconclusive');assert.equal(free,freeCount);
  const rotated=await fixture(),rotatedRun=await start(rotated),authBefore=process.env.AUTH_SECRET;
  const storedActor=(await pool.query('SELECT q.request_actor FROM prompt_comparison c JOIN prompt_execution_quote q ON q.id=c.quote_id WHERE c.id=$1',[rotatedRun.id])).rows[0].request_actor;
  try{process.env.AUTH_SECRET=randomBytes(32).toString('hex');mode='truncated';await executePromptComparison(rotatedRun.id,send);const item=(await detail(rotated,rotatedRun.id)).runs[0];assert.equal(receipts.get(item.generationId).external_user,storedActor);assert.equal((await reconcilePromptExecution(rotated.project,owner,item.id,{},send)).reconciliation.status,'matched');}finally{process.env.AUTH_SECRET=authBefore;}
  console.log('PASS captured generation recovery after input expiry, exact owner/account/context evidence, no replay and no inferred missing charge');

  // A validated answer can coexist with an unresolved charge. Settling that
  // charge is not a new observation and cannot restart the raw evidence clock.
  mode='ok';const retainedAnswer=await fixture(),retainedRun=await start(retainedAnswer);mode='answer_unknown';await executePromptComparison(retainedRun.id,send);
  const retainedChild=(await detail(retainedAnswer,retainedRun.id)).runs[0];assert.equal(retainedChild.status,'uncertain');assert.equal(retainedChild.result.text,'Synthetic untrusted answer');
  const agedAt=(await pool.query("SELECT (clock_timestamp()-interval '91 days')::text AS at")).rows[0].at as string,agedIso=new Date(agedAt).toISOString(),agedDay=agedIso.slice(0,10);
  await pool.query(`UPDATE prompt_execution SET completed_at=$2,dispatched_at=CASE WHEN dispatched_at IS NOT NULL THEN $2::timestamptz END,
    result=CASE WHEN result IS NOT NULL THEN jsonb_set(result,'{receivedAt}',to_jsonb($3::text)) END WHERE comparison_id=$1`,[retainedRun.id,agedAt,agedIso]);
  await pool.query('UPDATE prompt_comparison SET created_at=$2 WHERE id=$1',[retainedRun.id,agedAt]);
  await pool.query("UPDATE prompt_execution_quote SET created_at=$2,expires_at=$2::timestamptz+interval '5 minutes' WHERE id=$1",[retainedRun.quoteId,agedAt]);
  receipts.get(retainedChild.generationId).created_at=agedIso;
  const evidenceBeforeRecovery=(await pool.query('SELECT completed_at::text AS completed,result FROM prompt_execution WHERE id=$1',[retainedChild.id])).rows[0];
  const insightParams=new URLSearchParams({from:agedDay,to:agedDay}),insightsBefore=await getPromptInsights(retainedAnswer.project,viewer,insightParams);
  assert.equal(insightsBefore.coverage.expired,1);assert.equal(insightsBefore.coverage.eligible,0);
  const beforeCleanup=await detail(retainedAnswer,retainedRun.id);
  assert.equal(beforeCleanup.runs[0].resultExpired,true,'Receipt reads must mask policy-expired answers before cleanup.');
  assert.equal(beforeCleanup.runs[0].result,null);assert.equal(beforeCleanup.inputExpired,true);assert.equal(beforeCleanup.input,null);assert.equal(beforeCleanup.messages,null);
  assert.equal((await getPromptExecutions(retainedAnswer.project,viewer)).comparisons.find(c=>c.id===retainedRun.id)!.runs[0].resultExpired,true);
  const sibling=(await pool.query('SELECT id,status,completed_at::text AS completed FROM prompt_execution WHERE comparison_id=$1 AND id<>$2',[retainedRun.id,retainedChild.id])).rows[0];
  await pool.query("UPDATE prompt_execution SET status='queued',completed_at=NULL WHERE id=$1",[sibling.id]);
  try{const pendingInput=await detail(retainedAnswer,retainedRun.id);assert.equal(pendingInput.inputExpired,false);assert.notEqual(pendingInput.messages,null);assert.equal(pendingInput.runs[0].result,null);}
  finally{await pool.query('UPDATE prompt_execution SET status=$2,completed_at=$3 WHERE id=$1',[sibling.id,sibling.status,sibling.completed]);}
  const retainedPolicy=await getRetention(retainedAnswer.workspace,owner),previewBeforeRecovery=await previewRetention(retainedAnswer.workspace,owner,{revision:retainedPolicy.revision,settings:retainedPolicy.settings});assert.equal(previewBeforeRecovery.promptEstimate.results,1);
  const paidBeforeRecovery=paid;receiptChange={total_cost:0.000012345};const recoveredAnswer=await reconcilePromptExecution(retainedAnswer.project,owner,retainedChild.id,{},send);receiptChange={};
  assert.equal(recoveredAnswer.reconciliation.status,'matched');assert.equal((await ledger(retainedChild.id)).status,'settled');assert.equal((await ledger(retainedChild.id)).actual_micros,'13');assert.equal(paid,paidBeforeRecovery);
  assert.equal(recoveredAnswer.comparison.runs[0].resultExpired,true);assert.ok(!('result'in recoveredAnswer.comparison.runs[0]));assert.equal(recoveredAnswer.comparison.answerMode,'individual');assert.ok(Buffer.byteLength(JSON.stringify(recoveredAnswer),'utf8')<=2_097_152);assert.equal(recoveredAnswer.comparison.messages,null);
  assert.deepEqual((await pool.query('SELECT completed_at::text AS completed,result FROM prompt_execution WHERE id=$1',[retainedChild.id])).rows[0],evidenceBeforeRecovery,'Charge-only reconciliation must preserve the exact original completion timestamp and answer.');
  const insightsAfter=await getPromptInsights(retainedAnswer.project,viewer,insightParams);assert.equal(insightsAfter.coverage.expired,1);assert.equal(insightsAfter.coverage.eligible,0);assert.equal(insightsAfter.metrics[0].eligibleAnswers,null);
  assert.equal((await previewRetention(retainedAnswer.workspace,owner,{revision:retainedPolicy.revision,settings:retainedPolicy.settings})).promptEstimate.results,1);
  const erasedAnswer=await runRetentionBatch(retainedAnswer.project);assert.equal(erasedAnswer?.expiredPromptResults,1);assert.equal(erasedAnswer?.expiredPromptInputs,1);
  assert.equal((await detail(retainedAnswer,retainedRun.id)).runs[0].result,null);assert.equal((await detail(retainedAnswer,retainedRun.id)).runs[0].resultExpired,true);assert.equal((await getPromptExecutions(retainedAnswer.project,owner)).spendingPaused,false);
  assert.equal((await getPromptInsights(retainedAnswer.project,viewer,insightParams)).coverage.expired,1);assert.equal(paid,paidBeforeRecovery);
  // Owner decision D3: the matched reconcile leaves no block, so a new Start is admitted without an unpause.
  const retainedResume=await start(retainedAnswer);assert.equal(retainedResume.runs.length,2);await cancelPromptComparison(retainedAnswer.project,owner,retainedResume.id,{});assert.equal(paid,paidBeforeRecovery);
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650 WHERE id=$1',[retainedAnswer.workspace]);
  const erasedReceipt=await detail(retainedAnswer,retainedRun.id);assert.equal(erasedReceipt.runs[0].resultExpired,true);assert.equal(erasedReceipt.runs[0].result,null);assert.equal(erasedReceipt.inputExpired,true);assert.equal(erasedReceipt.messages,null);
  console.log('PASS charge-only reconciliation preserves the original raw-retention clock, expired insight eligibility and cleanup while settling its exact ledger');

  // Read cutoff comparisons must keep PostgreSQL microseconds and elapsed days,
  // even when the database/session timezone crosses daylight-saving changes.
  mode='ok';const dst=await fixture(),dstRun=await start(dst);await executePromptComparison(dstRun.id,send);
  const dstConnect=pool.connect.bind(pool);let offset=2_000_000;
  pool.connect=(async(...args:any[])=>{if(args.length)return (dstConnect as any)(...args);const client=await dstConnect(),query=client.query.bind(client),release=client.release.bind(client);
    client.query=(async(...values:any[])=>{const result=await (query as any)(...values);if(String(values[0])==='BEGIN'){
      await query("SET LOCAL TimeZone='America/New_York'");
      const sample=(await query(`SELECT d FROM generate_series(1,366) d WHERE transaction_timestamp()-make_interval(days=>d)
        <>transaction_timestamp()-d*interval '24 hours' ORDER BY d LIMIT 1`)).rows[0];assert.ok(sample);
      await query('UPDATE workspace SET raw_provider_evidence_days=$2 WHERE id=$1',[dst.workspace,sample.d]);
      await query("UPDATE prompt_execution SET completed_at=transaction_timestamp()-$2*interval '24 hours'+$3*interval '1 microsecond' WHERE comparison_id=$1",[dstRun.id,sample.d,offset]);
    }return result;}) as typeof client.query;
    client.release=((...args:any[])=>{client.query=query;return (release as any)(...args);}) as typeof client.release;return client;
  }) as typeof pool.connect;
  try{const exact=await detail(dst,dstRun.id);assert.ok(exact.runs.every(r=>!r.resultExpired&&r.result!==null));assert.equal(exact.inputExpired,false);
    offset=-2_000_000;const earlier=await detail(dst,dstRun.id);assert.ok(earlier.runs.every(r=>r.resultExpired&&r.result===null));assert.equal(earlier.inputExpired,true);assert.equal(earlier.messages,null);
  }finally{pool.connect=dstConnect;}
  assert.deepEqual((await pool.query(`WITH cutoff AS MATERIALIZED(SELECT clock_timestamp() AS at)
    SELECT at-interval '1 microsecond'<at AS earlier,at<at AS exact,at+interval '1 microsecond'<at AS later FROM cutoff`)).rows[0],{earlier:true,exact:false,later:false});

  mode='ok';const crashed=await fixture(),cr=await start(crashed);await pool.query("UPDATE provider_request SET status='dispatched' WHERE id=$1",[cr.runs[0].id]);await pool.query("UPDATE prompt_execution SET status='running',dispatched_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[cr.runs[0].id]);before=paid;await reconcilePromptExecutionJobs();const stopped=await detail(crashed,cr.id);assert.equal(stopped.runs[0].status,'uncertain');assert.equal(stopped.runs[1].status,'cancelled');assert.equal(paid,before);
  const evidence=(await pool.query('SELECT row_to_json(p) AS ledger,r.evidence FROM provider_request p JOIN prompt_execution r ON r.id=p.id WHERE p.id=$1',[done.runs[0].id])).rows[0];await pool.query("UPDATE prompt_execution SET completed_at=clock_timestamp()-interval '91 days' WHERE comparison_id=$1",[done.id]);const policy=await getRetention(f.workspace,owner);const preview=await previewRetention(f.workspace,owner,{revision:policy.revision,settings:policy.settings});assert.equal(preview.promptEstimate.results,2);
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=100 WHERE id=$1',[f.workspace]);await runRetentionBatch(f.project);assert.notEqual((await detail(f,done.id)).runs[0].result,null);await pool.query('UPDATE workspace SET raw_provider_evidence_days=90 WHERE id=$1',[f.workspace]);assert.equal((await runRetentionBatch(f.project))?.expiredPromptResults,2);assert.equal((await detail(f,done.id)).runs[0].resultExpired,true);assert.equal((await detail(f,done.id)).inputExpired,true);assert.equal((await detail(f,done.id)).messages,null);assert.deepEqual((await pool.query('SELECT row_to_json(p) AS ledger,r.evidence FROM provider_request p JOIN prompt_execution r ON r.id=p.id WHERE p.id=$1',[done.runs[0].id])).rows[0],evidence);
  console.log('PASS crash uncertainty, scoped retention preview and expiry preserve charge/quote/authored-version evidence');

  // A stale sweeper snapshot cannot overwrite a real result or its exact reported charge.
  const racing=await fixture(),race=await start(racing);let networkReady!:()=>void,releaseNetwork!:()=>void;
  const observed=new Promise<void>(r=>networkReady=r),networkGate=new Promise<void>(r=>releaseNetwork=r);
  const executing=executePromptComparison(race.id,async(...args)=>{if(String(args[0]).endsWith('/chat/completions')){networkReady();await networkGate;}return send(...args);});await observed;
  await pool.query("UPDATE prompt_execution SET dispatched_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[race.runs[0].id]);
  let sweepReady!:()=>void,releaseSweep!:()=>void;const snapshot=new Promise<void>(r=>sweepReady=r),sweepGate=new Promise<void>(r=>releaseSweep=r),originalQuery=pool.query;
  pool.query=(async(...args:any[])=>{const result=await (originalQuery as any).apply(pool,args);if(typeof args[0]==='string'&&args[0].startsWith('SELECT r.*,c.quote_id')&&args[0].includes("r.status='running' AND r.dispatched_at<")){sweepReady();await sweepGate;}return result;}) as typeof pool.query;
  try{const sweeping=reconcilePromptExecutionJobs();await snapshot;releaseNetwork();await executing;const prior=(await (originalQuery as any).call(pool,'SELECT result,evidence,status FROM prompt_execution WHERE id=$1',[race.runs[0].id])).rows[0];releaseSweep();await sweeping;assert.deepEqual((await (originalQuery as any).call(pool,'SELECT result,evidence,status FROM prompt_execution WHERE id=$1',[race.runs[0].id])).rows[0],prior);assert.equal(prior.status,'completed');}finally{releaseNetwork();releaseSweep();pool.query=originalQuery;}

  // Quote payloads with no answer still require bounded cleanup and cannot make a batch falsely complete.
  const raw=await fixture(),rawRun=await start(raw);await cancelPromptComparison(raw.project,owner,rawRun.id,{});await pool.query("UPDATE prompt_execution SET completed_at=clock_timestamp()-interval '91 days' WHERE comparison_id=$1",[rawRun.id]);
  const source=(await pool.query('SELECT * FROM prompt_comparison WHERE id=$1',[rawRun.id])).rows[0];
  const seed=await pool.connect();try{await seed.query('BEGIN');for(let n=0;n<101;n++){
   const qid=randomUUID(),cid=randomUUID(),rid=randomUUID();
   await seed.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,key_fingerprint,input,messages,routes,input_hash,request_actor,expires_at)
    SELECT $1,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,key_fingerprint,input,messages,routes,input_hash,request_actor,clock_timestamp()+interval '5 minutes' FROM prompt_execution_quote WHERE id=$2`,[qid,source.quote_id]);
   await seed.query('INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key,cancel_requested) VALUES($1,$2,$3,$4,$5,$6,true)',[cid,qid,raw.workspace,raw.project,owner,randomUUID()]);
   await seed.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,status,budget_month)
    VALUES($1,$2,$3,1,$4,$5,'prompt.execute',$6,20429,'cancelled','2026-01-01')`,[rid,raw.workspace,raw.connectionId,owner,randomUUID(),'a'.repeat(64)]);
   await seed.query(`INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,completed_at)
    SELECT $1,$2,workspace_id,project_id,0,route,'cancelled',clock_timestamp()-interval '91 days' FROM prompt_execution WHERE id=$3`,[rid,cid,rawRun.runs[0].id]);
  }await seed.query('COMMIT');}finally{await seed.query('ROLLBACK').catch(()=>{});seed.release();}
  const rawPolicy=await getRetention(raw.workspace,owner);assert.equal((await previewRetention(raw.workspace,owner,{revision:rawPolicy.revision,settings:rawPolicy.settings})).promptEstimate.inputs,102);
  await pool.query(`CREATE FUNCTION fail_prompt_payload_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.input_purged_at IS NOT NULL AND OLD.input_purged_at IS NULL THEN RAISE EXCEPTION 'synthetic retention failure'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER fail_prompt_payload_test BEFORE UPDATE ON prompt_execution_quote FOR EACH ROW EXECUTE FUNCTION fail_prompt_payload_test()');
  try{await assert.rejects(runRetentionBatch(raw.project));assert.equal((await pool.query('SELECT count(*)::int AS n FROM prompt_execution_quote WHERE project_id=$1 AND input_purged_at IS NULL',[raw.project])).rows[0].n,102);}finally{await pool.query('DROP TRIGGER fail_prompt_payload_test ON prompt_execution_quote');await pool.query('DROP FUNCTION fail_prompt_payload_test()');}
  const batch=await runRetentionBatch(raw.project);assert.equal(batch?.expiredPromptInputs,100);assert.equal(batch?.expiredPromptResults,0);assert.equal(batch?.complete,false);const last=await runRetentionBatch(raw.project);assert.equal(last?.expiredPromptInputs,2);assert.equal(last?.complete,true);
  assert.equal((await detail(raw,rawRun.id)).inputExpired,true);assert.equal((await pool.query('SELECT text FROM prompt_text_version WHERE id=$1',[raw.prompt.currentVersionId])).rows[0].text,'Exact original prompt');
  console.log('PASS stale crash snapshot, payload-only bounded retention, rollback and preserved authored prompts');

  // The production worker drains a legacy comparison-keyed job (the shape Start sent before per-child Start; the handler
  // keeps it for one release) and runs the child-keyed {executionId} job Start sent for the swept second child (D3).
  const worker=await fixture(),wr=await start(worker);assert.deepEqual((await pool.query('SELECT retry_limit FROM pgboss.job WHERE id=ANY($1::uuid[])',[wr.runs.map((r:any)=>r.id)])).rows.map((r:any)=>r.retry_limit),[0,0]);await pool.query('DELETE FROM pgboss.job WHERE id=ANY($1::uuid[])',[wr.runs.map((r:any)=>r.id)]);
  assert.ok(await boss.send(promptExecutionQueue,{comparisonId:wr.id},{id:wr.id,retryLimit:0,expireInSeconds:180}));await pool.query('UPDATE pgboss.job SET priority=100 WHERE id=ANY($1::uuid[])',[[wr.id,sweptChild]]);globalThis.fetch=send;await startWorker();const deadline=Date.now()+15_000;
  const workerActive=async()=>[...(await detail(worker,wr.id)).runs,...(await detail(swept,sweptRun.id)).runs].some((r:any)=>['queued','running'].includes(r.status));
  while(await workerActive()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));await stopJobs();globalThis.fetch=blocked;assert.deepEqual((await detail(worker,wr.id)).runs.map((r:any)=>r.status),['completed','completed']);for(const r of wr.runs)assert.equal(sent.filter(v=>v===r.id).length,1);
  assert.deepEqual((await detail(swept,sweptRun.id)).runs.map((r:any)=>r.status),['cancelled','completed']);assert.equal(sent.filter(v=>v===sweptChild).length,1);assert.ok(!sent.includes(sweptRun.runs[0].id));
  const login=await handleApi(new Request(`${config.appUrl}/api/auth/sign-in/email`,{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:`${owner}@execution.integration.test`,password})}));assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),endpoint=`${config.appUrl}/api/projects/${f.project}/prompt-executions`;
  assert.equal((await handleApi(new Request(endpoint))).status,401);const read=await handleApi(new Request(endpoint,{headers:{cookie}}));assert.equal(read.status,200);const text=await read.text();for(const secret of ['synthetic-never-live','key_fingerprint','encrypted_credentials'])assert.ok(!text.includes(secret));assert.equal((await handleApi(new Request(endpoint+'?unexpected=1',{headers:{cookie}}))).status,400);
  assert.equal((await handleApi(new Request(endpoint+'/quote',{method:'POST',headers:{cookie,origin:'https://foreign.test','content-type':'application/json'},body:'{}'}))).status,403);const keyToken=await createApiKey(f.workspace,owner,{name:'No execution permission',scopes:['analytics:read']});assert.equal((await handleApi(new Request(endpoint,{headers:{authorization:'Bearer '+keyToken.token}}))).status,403);
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[f.workspace,owner]);assert.equal((await handleApi(new Request(endpoint,{headers:{cookie}}))).status,404);
  console.log('PASS actual queue worker for legacy comparison and child-keyed jobs (D3), cookie/Origin/API-key/current-membership enforcement and secret-free execution metadata');

  // Separate additive fixture: all answers are genuine outputs of the production
  // parser/worker using this fake transport, never rewritten success DTOs.
  const four=await fixture(),selected=[...models,'mistralai/fixture-a','google/fixture-b'],largeText='漢'.repeat(250000);
  let fourPaid=0,loseFour=false,failModel:string|null=null,nearWireBytes:number|null=null;
  const sendFour:typeof fetch=async(url,init)=>{
   const path=String(url);assert.ok(init?.signal);assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');
   const pricing={prompt:'0.00000015',completion:'0.0000006',request:'0'};
   if(path.includes('/models?'))return Response.json({data:selected.map(id=>({id,canonical_slug:id,name:id,architecture:{input_modalities:['text'],output_modalities:['text']},context_length:128000,top_provider:{max_completion_tokens:16384},supported_parameters:['max_tokens'],pricing})),total_count:4,links:{next:null}});
   if(path.endsWith('/key'))return Response.json({data:{is_free_tier:false,is_management_key:false}});
   if(path.endsWith('/endpoints')){const id=selected.find(model=>path.endsWith('/'+model+'/endpoints'));assert.ok(id);return Response.json({data:{id,architecture:{input_modalities:['text'],output_modalities:['text']},endpoints:[{model_id:id,tag:'fixture',provider_name:'Fixture',status:0,context_length:128000,max_completion_tokens:16384,supported_parameters:['max_tokens'],pricing}]}});}
   assert.equal(path,'https://openrouter.ai/api/v1/chat/completions');assert.equal(init?.method,'POST');const body=JSON.parse(String(init?.body));assert.deepEqual(body.provider.only,['fixture']);assert.equal(body.provider.allow_fallbacks,false);fourPaid++;
   assert.ok(Buffer.byteLength(String(init?.body),'utf8')<=163840);if(body.messages[0]?.content==='\u0001'.repeat(4000))nearWireBytes=Buffer.byteLength(JSON.stringify(body.messages),'utf8');
   if(loseFour)throw Error('Synthetic lost outcome; never live.');
   const id='gen-'+randomUUID();return Response.json({id,model:body.model,provider:'Fixture',created:Math.floor(Date.now()/1000),choices:[{finish_reason:'stop',message:{content:body.model===failModel?'invalid\0':largeText}}],usage:{cost:0.000012345,is_byok:false,prompt_tokens:12,completion_tokens:20}},{headers:{'x-generation-id':id}});
  };
  await refreshOpenRouterCatalog(sendFour);
  const fourInput={...four.request,models:selected},three=await quotePromptExecution(four.project,owner,{...fourInput,models:selected.slice(0,3)},sendFour);
  assert.deepEqual(three.quote.routes.map(r=>r.model),selected.slice(0,3));
  for(const invalid of [[...selected,'other/fifth'],[...selected.slice(0,3),selected[0]]])await assert.rejects(quotePromptExecution(four.project,owner,{...fourInput,models:invalid},sendFour),{status:400});
  const fourQuote=(await quotePromptExecution(four.project,owner,fourInput,sendFour)).quote;assert.equal(fourQuote.estimateUsd,'0.081716');
  // Owner decision D3: the uncertain sentinel after three reservations, not a cap, refuses the fourth child.
  await withUncertainSentinel(four.workspace,3,()=>assert.rejects(startPromptExecution(four.project,owner,{quoteId:fourQuote.id,requestKey:randomUUID()}),{status:409,code:'SPENDING_BUDGET'}));
  for(const table of ['provider_request','prompt_comparison','prompt_execution'])assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`,[four.workspace])).rows[0].n,0,'The fourth reservation rolls back all preceding children.');
  const fourKey=randomUUID(),fourStart=await startPromptExecution(four.project,owner,{quoteId:fourQuote.id,requestKey:fourKey});
  assert.equal(fourStart.comparison.runs.length,4);assert.equal(fourStart.comparison.answerMode,'individual');
  assert.ok(fourStart.comparison.runs.every(r=>!('result'in r)));assert.equal(fourPaid,0);
  await executePromptComparison(fourStart.comparison.id,sendFour);assert.equal(fourPaid,4);
  const fourSummary=await getPromptComparisonSummary(four.project,viewer,fourStart.comparison.id);
  assert.deepEqual(fourSummary.comparison.runs.map(r=>r.status),['completed','completed','completed','completed']);assert.ok(fourSummary.comparison.runs.every(r=>!('result'in r)));
  assert.equal((await startPromptExecution(four.project,owner,{quoteId:fourQuote.id,requestKey:fourKey})).comparison.id,fourStart.comparison.id);assert.equal(fourPaid,4);
  assert.ok(Number((await pool.query('SELECT sum(octet_length(result::text))::text AS bytes FROM prompt_execution WHERE comparison_id=$1',[fourStart.comparison.id])).rows[0].bytes)>2_097_152);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')",[four.workspace,foreign]);
  for(const [user,role] of [[owner,'owner'],[foreign,'admin'],[editor,'editor'],[viewer,'viewer']])for(const run of fourSummary.comparison.runs){const answer=await getPromptExecutionResult(four.project,user,run.id);assert.equal(answer.role,role);assert.equal(answer.comparisonId,fourStart.comparison.id);assert.equal(answer.run.result.text,largeText);assert.equal(answer.run.actualUsd,'0.000013');assert.ok(Buffer.byteLength(JSON.stringify(answer))<=2_097_152);assert.ok(!('messages'in answer)&&!('input'in answer));}
  await assert.rejects(getPromptExecutionResult(other.project,owner,fourStart.comparison.runs[0].id),{status:404});
  const fourEndpoint=`${config.appUrl}/api/projects/${four.project}/prompt-executions`;
  for(const path of ['/comparisons/'+fourStart.comparison.id+'/summary','/runs/'+fourStart.comparison.runs[0].id]){const response=await handleApi(new Request(fourEndpoint+path,{headers:{cookie}}));assert.equal(response.status,200);const bytes=new Uint8Array(await response.arrayBuffer());assert.ok(bytes.byteLength<=2_097_152);const body=new TextDecoder('utf-8',{fatal:true}).decode(bytes),value=JSON.parse(body);if(path.startsWith('/runs/'))assert.equal(value.run.result.text,largeText);else{assert.equal(value.comparison.answerMode,'individual');assert.equal(value.comparison.runs.length,4);assert.ok(value.comparison.runs.every((run:object)=>!('result'in run)));}for(const secret of ['synthetic-never-live','key_fingerprint','encrypted_credentials','request_actor'])assert.ok(!body.includes(secret));assert.equal((await handleApi(new Request(fourEndpoint+path+'?unexpected=1',{headers:{cookie}}))).status,400);}
  const fourToken=await createApiKey(four.workspace,owner,{name:'No answer scope',scopes:['analytics:read']});assert.equal((await handleApi(new Request(fourEndpoint+'/runs/'+fourStart.comparison.runs[0].id,{headers:{authorization:'Bearer '+fourToken.token}}))).status,403);
  console.log('PASS three/four-model quote, fourth-reservation atomic rollback, four genuine large answers, bounded native summary/individual reads and all current roles');

  // Both waits observe PostgreSQL lock evidence; neither advances a synthetic clock.
  async function heldRead<T>(workspaceId:string,action:()=>Promise<T>,whileHeld:(client:import('pg').PoolClient)=>Promise<void>){
   const gate=await pool.connect();let pending:Promise<T>|undefined;
   try{await gate.query('BEGIN');await gate.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspaceId]);const pid=(await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending=action();pending.catch(()=>{});const until=Date.now()+3000;let observed=false;
    while(Date.now()<until){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'",[pid])).rowCount){observed=true;break;}await new Promise(r=>setTimeout(r,10));}assert.equal(observed,true);
    await whileHeld(gate);await gate.query('COMMIT');return await pending;
   }finally{await gate.query('ROLLBACK').catch(()=>{});gate.release();await pending?.catch(()=>{});}
  }
  const retainedId=fourStart.comparison.runs[0].id;
  await pool.query(`WITH stamp AS MATERIALIZED(SELECT clock_timestamp()-interval '90 days'+interval '1 second' AS at)
    UPDATE prompt_execution SET completed_at=stamp.at,dispatched_at=stamp.at,
      result=jsonb_set(result,'{receivedAt}',to_jsonb(to_char(stamp.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    FROM stamp WHERE id=$1`,[retainedId]);
  const expiredAnswer=await heldRead(four.workspace,()=>getPromptExecutionResult(four.project,viewer,retainedId),async gate=>{
   assert.equal((await gate.query("SELECT completed_at>clock_timestamp()-interval '90 days' AS fresh FROM prompt_execution WHERE id=$1",[retainedId])).rows[0].fresh,true);
   const until=Date.now()+2500;while((await gate.query("SELECT completed_at>=clock_timestamp()-interval '90 days' AS fresh FROM prompt_execution WHERE id=$1",[retainedId])).rows[0].fresh&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
   assert.equal((await gate.query("SELECT completed_at<clock_timestamp()-interval '90 days' AS expired FROM prompt_execution WHERE id=$1",[retainedId])).rows[0].expired,true);
  });assert.equal(expiredAnswer.run.resultExpired,true);assert.equal(expiredAnswer.run.result,null);
  await assert.rejects(heldRead(four.workspace,()=>getPromptExecutionResult(four.project,viewer,retainedId),async gate=>{await gate.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[four.workspace,viewer]);}),{status:404});
  const one=await fixture(),system='\u0001'.repeat(4000),nearMessages=[{role:'system',content:system},{role:'user',content:'a'.repeat(2000)}];
  const extra=32768-Buffer.byteLength(JSON.stringify(nearMessages),'utf8'),controls=Math.floor(extra/5),accent=extra%5;
  const nearText='\u0001'.repeat(controls)+'é'.repeat(accent)+'a'.repeat(2000-controls-accent);
  const nearPrompt=(await createPrompts(one.project,owner,{requestId:randomUUID(),prompts:[{text:nearText,enabled:false}]})).items[0];
  const nearInput={...one.request,promptId:nearPrompt.id,versionId:nearPrompt.currentVersionId,systemText:system,models:[mini]},nearQuote=(await quotePromptExecution(one.project,owner,nearInput,sendFour)).quote;
  assert.equal(Buffer.byteLength(JSON.stringify(nearQuote.messages),'utf8'),32768);assert.ok(Buffer.byteLength(JSON.stringify(nearInput),'utf8')<=32768);
  const overPrompt=(await createPrompts(one.project,owner,{requestId:randomUUID(),prompts:[{text:nearText.slice(0,-1)+'é',enabled:false}]})).items[0];
  await assert.rejects(quotePromptExecution(one.project,owner,{...nearInput,promptId:overPrompt.id,versionId:overPrompt.currentVersionId},sendFour),{status:413});
  const oneStart=await startPromptExecution(one.project,owner,{quoteId:nearQuote.id,requestKey:randomUUID()});await executePromptComparison(oneStart.comparison.id,sendFour);assert.equal(fourPaid,5);assert.equal(nearWireBytes,32768);
  for(const legacy of [{workspace:one.workspace,project:one.project,id:oneStart.comparison.id,count:1},{workspace:worker.workspace,project:worker.project,id:wr.id,count:2}]){
   await pool.query(`WITH stamp AS MATERIALIZED(SELECT clock_timestamp()-interval '90 days'+interval '1 second' AS at)
     UPDATE prompt_execution SET completed_at=stamp.at,dispatched_at=stamp.at FROM stamp WHERE comparison_id=$1`,[legacy.id]);
   const after=await heldRead(legacy.workspace,()=>getPromptComparison(legacy.project,viewer,legacy.id),async gate=>{
    assert.equal((await gate.query("SELECT bool_and(completed_at>clock_timestamp()-interval '90 days') AS fresh FROM prompt_execution WHERE comparison_id=$1",[legacy.id])).rows[0].fresh,true);
    const until=Date.now()+2500;while((await gate.query("SELECT bool_or(completed_at>=clock_timestamp()-interval '90 days') AS fresh FROM prompt_execution WHERE comparison_id=$1",[legacy.id])).rows[0].fresh&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
    assert.equal((await gate.query("SELECT bool_and(completed_at<clock_timestamp()-interval '90 days') AS expired FROM prompt_execution WHERE comparison_id=$1",[legacy.id])).rows[0].expired,true);
   });assert.equal(after.comparison.runs.length,legacy.count);assert.ok(after.comparison.runs.every(r=>r.resultExpired&&r.result===null));assert.equal(after.comparison.inputExpired,true);assert.equal(after.comparison.messages,null);assert.ok(!('answerMode'in after.comparison));
  }
  const failedFour=await fixture(),failedQuote=(await quotePromptExecution(failedFour.project,owner,{...failedFour.request,models:selected},sendFour)).quote,failedStart=await startPromptExecution(failedFour.project,owner,{quoteId:failedQuote.id,requestKey:randomUUID()});
  failModel=selected[1];await executePromptComparison(failedStart.comparison.id,sendFour);failModel=null;assert.equal(fourPaid,9);
  const failedSummary=await getPromptComparisonSummary(failedFour.project,viewer,failedStart.comparison.id);
  assert.deepEqual(failedSummary.comparison.runs.map(r=>r.status),['completed','failed','completed','completed']);assert.ok(failedSummary.comparison.runs.every(r=>r.chargeStatus==='settled'));
  for(const [index,run] of failedSummary.comparison.runs.entries())assert.equal((await getPromptExecutionResult(failedFour.project,viewer,run.id)).run.result?.text??null,index===1?null:largeText);
  const uncertainFour=await fixture(),uncertainQuote=(await quotePromptExecution(uncertainFour.project,owner,{...uncertainFour.request,models:selected},sendFour)).quote,uncertainStart=await startPromptExecution(uncertainFour.project,owner,{quoteId:uncertainQuote.id,requestKey:randomUUID()});
  loseFour=true;await executePromptComparison(uncertainStart.comparison.id,sendFour);assert.equal(fourPaid,10);const unresolvedFour=await getPromptComparisonSummary(uncertainFour.project,owner,uncertainStart.comparison.id);
  assert.deepEqual(unresolvedFour.comparison.runs.map(r=>r.status),['uncertain','cancelled','cancelled','cancelled']);assert.equal((await getPromptExecutions(uncertainFour.project,owner)).spendingPaused,false);await executePromptComparison(uncertainStart.comparison.id,sendFour);assert.equal(fourPaid,10);
  assert.deepEqual((await pool.query(`SELECT status,count(*)::int AS count,sum(actual_micros)::text AS actual FROM provider_request
    WHERE workspace_id=ANY($1::text[]) GROUP BY status ORDER BY status`,[[four.workspace,one.workspace,failedFour.workspace,uncertainFour.workspace]])).rows,
    [{status:'cancelled',count:3,actual:null},{status:'settled',count:9,actual:'117'},{status:'uncertain',count:1,actual:null}]);
  console.log('PASS actual held-answer expiry/current-membership denial and four-model unknown charge stops its siblings without a pause or replay (D3)');

  // Two additional genuine parser/worker outputs. Raw legal Unicode URLs grow
  // only through the unchanged URL.href canonicalization, never a stored-body rewrite.
  const cited=await fixture(),sourceText='漢'.repeat(250000),rawCitations=Array.from({length:100},(_,index)=>({url:'https://sources.test/'+'漢'.repeat(2000)+'/'+index,title:'Source '+index}));
  assert.ok(rawCitations.every(item=>item.url.length<=2048));
  const expectedCitations=rawCitations.map(item=>({...item,url:new URL(item.url).href}));let citationPaid=0;
  const sendCitations:typeof fetch=async(url,init)=>{
    if(String(url)!=='https://openrouter.ai/api/v1/chat/completions')return sendFour(url,init);
    assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);
    const input=JSON.parse(String(init?.body));assert.deepEqual(input.provider.only,['fixture']);assert.equal(input.provider.allow_fallbacks,false);assert.ok(models.includes(input.model));citationPaid++;
    const id='gen-'+randomUUID(),body=JSON.stringify({id,model:input.model,provider:'Fixture',created:Math.floor(Date.now()/1000),choices:[{finish_reason:'stop',message:{content:sourceText,annotations:rawCitations.map(url_citation=>({type:'url_citation',url_citation}))}}],usage:{cost:0.000012345,is_byok:false,prompt_tokens:12,completion_tokens:20}});
    assert.ok(Buffer.byteLength(body,'utf8')<2_097_152,'The actual provider response is within its unchanged raw2MiB bound.');
    return new Response(body,{headers:{'content-type':'application/json','x-generation-id':id}});
  };
  const citedQuote=(await quotePromptExecution(cited.project,owner,cited.request,sendCitations)).quote,citedKey=randomUUID(),citedStart=await startPromptExecution(cited.project,owner,{quoteId:citedQuote.id,requestKey:citedKey});
  await executePromptComparison(citedStart.comparison.id,sendCitations);assert.equal(citationPaid,2);assert.equal(fourPaid,10);
  assert.ok((await pool.query('SELECT bool_and(octet_length(result::text)>2097152) AS expanded FROM prompt_execution WHERE comparison_id=$1',[citedStart.comparison.id])).rows[0].expanded,'Each genuinely normalized retained answer exceeds2MiB.');
  await assert.rejects(getPromptComparison(cited.project,owner,citedStart.comparison.id),{status:413});
  const citedSummary=await getPromptComparisonSummary(cited.project,owner,citedStart.comparison.id);assert.equal(citedSummary.comparison.runs.length,2);assert.ok(citedSummary.comparison.runs.every(run=>run.status==='completed'&&!('result'in run)));
  await assert.rejects(getPromptExecutionCitations(cited.project,foreign,citedStart.comparison.runs[0].id,new URLSearchParams({offset:'0'})),{status:404});
  await pool.query("INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,'admin')",[cited.workspace,foreign]);
  for(const [actor,role]of [[owner,'owner'],[foreign,'admin'],[editor,'editor'],[viewer,'viewer']])for(const run of citedSummary.comparison.runs){
    const answer=await getPromptExecutionResult(cited.project,actor,run.id);assert.equal(answer.role,role);assert.equal(answer.comparisonId,citedStart.comparison.id);assert.equal(answer.run.result.text,sourceText);assert.ok(!('citations'in answer.run.result));assert.deepEqual(answer.citations,{count:100,pageSize:20});assert.ok(Buffer.byteLength(JSON.stringify(answer),'utf8')<=2_097_152);
    const sources=[];for(const offset of [0,20,40,60,80,100]){const page=await getPromptExecutionCitations(cited.project,actor,run.id,new URLSearchParams({offset:String(offset)}));assert.equal(page.role,role);assert.equal(page.runId,run.id);assert.equal(page.comparisonId,citedStart.comparison.id);assert.equal(page.resultExpired,false);assert.equal(page.total,100);assert.equal(page.offset,offset);assert.equal(page.nextOffset,offset<80?offset+20:null);assert.equal(page.items.length,offset===100?0:20);assert.ok(Buffer.byteLength(JSON.stringify(page),'utf8')<=2_097_152);sources.push(...page.items);}assert.deepEqual(sources,expectedCitations);
  }
  const citedId=citedStart.comparison.runs[0].id,citedEndpoint=`${config.appUrl}/api/projects/${cited.project}/prompt-executions`,citedPath='/runs/'+citedId+'/citations';
  const native=(path:string)=>handleApi(new Request(citedEndpoint+path,{headers:{cookie}}));
  const ackRows=async()=>({ledger:(await pool.query('SELECT id,md5(to_jsonb(p)::text) AS digest FROM provider_request p WHERE workspace_id=$1 ORDER BY id',[cited.workspace])).rows,jobs:(await pool.query("SELECT id,md5(to_jsonb(j)::text) AS digest FROM pgboss.job j WHERE name='prompt-execution' AND (id=$1::uuid OR data->>'comparisonId'=$2) ORDER BY id",[citedStart.comparison.id,citedStart.comparison.id])).rows});
  const beforeAcks=await ackRows();assert.equal(beforeAcks.jobs.length,citedStart.comparison.runs.length);
  for(const [path,input,status]of [['/comparisons',{quoteId:citedQuote.id,requestKey:citedKey},202],['/comparisons/'+citedStart.comparison.id+'/cancel',{},200]]as const){const response=await handleApi(new Request(citedEndpoint+path,{method:'POST',headers:{cookie,origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify(input)}));assert.equal(response.status,status);const bytes=new Uint8Array(await response.arrayBuffer());assert.ok(bytes.byteLength<=2_097_152);const ack=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));assert.equal(ack.comparison.id,citedStart.comparison.id);assert.equal(ack.comparison.answerMode,'individual');assert.deepEqual(ack.comparison.runs.map((run:any)=>run.id),citedStart.comparison.runs.map(run=>run.id));assert.ok(ack.comparison.runs.every((run:any)=>run.status==='completed'&&!('result'in run)&&!('generationId'in run)&&!('reportedCost'in run)));if(status===200)assert.equal(ack.comparison.cancelRequested,true);}
  assert.deepEqual(await ackRows(),beforeAcks);assert.equal(citationPaid,2);assert.equal((await pool.query('SELECT count(*)::int AS n FROM prompt_comparison WHERE workspace_id=$1',[cited.workspace])).rows[0].n,1);
  let reconcileReads=0;const inconclusiveAck=await reconcilePromptExecution(uncertainFour.project,owner,unresolvedFour.comparison.runs[0].id,{},async(url,init)=>{reconcileReads++;return sendFour(url,init);});assert.equal(inconclusiveAck.reconciliation.status,'inconclusive');assert.equal(inconclusiveAck.comparison.id,uncertainStart.comparison.id);assert.equal(inconclusiveAck.comparison.answerMode,'individual');assert.ok(inconclusiveAck.comparison.runs.every(run=>!('result'in run)));assert.ok(Buffer.byteLength(JSON.stringify(inconclusiveAck),'utf8')<=2_097_152);assert.equal(reconcileReads,0);assert.equal(fourPaid,10);
  assert.equal((await native('/comparisons/'+citedStart.comparison.id)).status,413);assert.equal((await native('/comparisons/'+citedStart.comparison.id+'/summary')).status,200);
  const textResponse=await native('/runs/'+citedId);assert.equal(textResponse.status,200);const textDto=await textResponse.json();assert.equal(textDto.run.result.text,sourceText);assert.deepEqual(textDto.citations,{count:100,pageSize:20});assert.ok(!('citations'in textDto.run.result));
  const nativeSources=[];for(const offset of [0,20,40,60,80,100]){const response=await native(citedPath+'?offset='+offset);assert.equal(response.status,200);assert.match(response.headers.get('cache-control')??'',/no-store/);const bytes=new Uint8Array(await response.arrayBuffer());assert.ok(bytes.byteLength<=2_097_152);const page=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));assert.equal(page.runId,citedId);assert.equal(page.comparisonId,citedStart.comparison.id);assert.equal(page.total,100);assert.equal(page.offset,offset);assert.equal(page.nextOffset,offset<80?offset+20:null);nativeSources.push(...page.items);}assert.deepEqual(nativeSources,expectedCitations);
  for(const query of ['', '?offset=', '?offset=-20', '?offset=1', '?offset=120', '?offset=20.0', '?offset=0%0A', '?offset=+20', '?offset=00', '?offset=0&offset=20', '?offset=0&other=1'])assert.equal((await native(citedPath+query)).status,400);
  for(const path of ['/runs/'+citedId,'/comparisons/'+citedStart.comparison.id,'/comparisons/'+citedStart.comparison.id+'/summary'])assert.equal((await native(path+'?offset=0')).status,400);
  assert.equal((await handleApi(new Request(citedEndpoint+citedPath+'?offset=0',{headers:{authorization:'Bearer '+fourToken.token}}))).status,403);
  await assert.rejects(getPromptExecutionCitations(other.project,owner,citedId,new URLSearchParams({offset:'0'})),{status:404});
  const emptySources=await getPromptExecutionCitations(four.project,owner,fourSummary.comparison.runs[1].id,new URLSearchParams({offset:'0'}));assert.equal(emptySources.total,0);assert.deepEqual(emptySources.items,[]);assert.equal(emptySources.nextOffset,null);
  const noAnswer=await getPromptExecutionResult(failedFour.project,owner,failedSummary.comparison.runs[1].id);assert.equal(noAnswer.run.result,null);assert.equal(noAnswer.citations.count,null);const unavailable=await getPromptExecutionCitations(failedFour.project,owner,failedSummary.comparison.runs[1].id,new URLSearchParams({offset:'0'}));assert.equal(unavailable.total,null);assert.deepEqual(unavailable.items,[]);assert.equal(unavailable.nextOffset,null);
  await pool.query("UPDATE prompt_execution SET completed_at=clock_timestamp()-interval '90 days'+interval '1 second' WHERE id=$1",[citedId]);
  const expiredSources=await heldRead(cited.workspace,()=>getPromptExecutionCitations(cited.project,viewer,citedId,new URLSearchParams({offset:'20'})),async gate=>{
    assert.equal((await gate.query("SELECT completed_at>clock_timestamp()-interval '90 days' AS fresh FROM prompt_execution WHERE id=$1",[citedId])).rows[0].fresh,true);
    const until=Date.now()+2500;while((await gate.query("SELECT completed_at>=clock_timestamp()-interval '90 days' AS fresh FROM prompt_execution WHERE id=$1",[citedId])).rows[0].fresh&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));assert.equal((await gate.query("SELECT completed_at<clock_timestamp()-interval '90 days' AS expired FROM prompt_execution WHERE id=$1",[citedId])).rows[0].expired,true);
  });assert.equal(expiredSources.resultExpired,true);assert.equal(expiredSources.total,null);assert.equal(expiredSources.nextOffset,null);assert.deepEqual(expiredSources.items,[]);
  const expiredText=await getPromptExecutionResult(cited.project,owner,citedId);assert.equal(expiredText.run.result,null);assert.equal(expiredText.run.resultExpired,true);assert.equal(expiredText.citations.count,null);
  await assert.rejects(heldRead(cited.workspace,()=>getPromptExecutionCitations(cited.project,viewer,citedId,new URLSearchParams({offset:'0'})),async gate=>{await gate.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[cited.workspace,viewer]);}),{status:404});
  assert.equal(citationPaid,2);assert.equal(fourPaid,10);assert.deepEqual((await pool.query('SELECT status,count(*)::int AS count,sum(actual_micros)::text AS actual FROM provider_request WHERE workspace_id=$1 GROUP BY status',[cited.workspace])).rows,[{status:'settled',count:2,actual:'26'}]);
  assert.deepEqual((await pool.query('SELECT status,count(*)::int AS count,sum(actual_micros)::text AS actual FROM provider_request WHERE workspace_id=ANY($1::text[]) GROUP BY status ORDER BY status',[[four.workspace,one.workspace,failedFour.workspace,uncertainFour.workspace,cited.workspace]])).rows,[{status:'cancelled',count:3,actual:null},{status:'settled',count:11,actual:'143'},{status:'uncertain',count:1,actual:null}]);
  const fiveComparisons=[fourStart.comparison.id,oneStart.comparison.id,failedStart.comparison.id,uncertainStart.comparison.id,citedStart.comparison.id];
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pgboss.job j JOIN prompt_execution r ON r.id=j.id WHERE j.name='prompt-execution' AND r.comparison_id=ANY($1::uuid[]) AND j.data->>'executionId'=r.id::text",[fiveComparisons])).rows[0].n,15,'One job per reserved child: the 15 ledger rows above.');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgboss.job WHERE id=ANY($1::uuid[])',[fiveComparisons])).rows[0].n,0);
  console.log('PASS expanded legal citations preserve bounded answer text and all ordered sources, native aggregate413, fresh page retention/access and exact additional charges');

  // Separate cache fixture: all original twelve groups/financial assertions above remain exact.
  loseFour=false; // New independent cache fixture; no counter or rate bucket is reset.
  const cached=await fixture(),cacheOwner=randomUUID();await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Cache owner\',$2)',[cacheOwner,cacheOwner+'@execution.integration.test']);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[cached.workspace,cacheOwner]);
  const cachePaidBefore=fourPaid,cacheQuote=async(ids:string[],reuseCached=true)=>quotePromptExecution(cached.project,cacheOwner,{...cached.request,models:ids,reuseCached},sendFour);
  const cacheStart=async(q:Awaited<ReturnType<typeof cacheQuote>>)=>startPromptExecution(cached.project,cacheOwner,{quoteId:q.quote.id,requestKey:randomUUID()});
  const firstCache=await cacheStart(await cacheQuote(selected.slice(0,2)));await executePromptComparison(firstCache.comparison.id,sendFour);assert.equal(fourPaid-cachePaidBefore,2);
  // Replay only the actual cache candidate query's clock bind at fixed DST anchors;
  // real locks, candidate rows, predicates and all original three binds still execute.
  const cacheDstId=firstCache.comparison.runs[0].id,cacheDstBefore=(await pool.query("SELECT completed_at::text AS at,w.raw_provider_evidence_days AS days FROM prompt_execution r JOIN workspace w ON w.id=r.workspace_id WHERE r.id=$1",[cacheDstId])).rows[0];
  const cacheDstConnect=pool.connect.bind(pool);let cacheDstAt='2026-03-12T16:30:00Z',cacheDstSql:string|undefined,cacheDstQueries=0;
  pool.connect=(async(...args:any[])=>{if(args.length)return (cacheDstConnect as any)(...args);const client=await cacheDstConnect(),query=client.query.bind(client),release=client.release.bind(client);
    client.query=(async(...values:any[])=>{const sql=String(values[0]);if(sql==='BEGIN'){const result=await (query as any)(...values);await query("SET LOCAL TimeZone='America/New_York'");return result;}
      if(sql.startsWith('WITH read_clock AS MATERIALIZED(SELECT clock_timestamp() AS at)')&&sql.includes('SELECT DISTINCT ON(r.cache_key)')){
        assert.equal(values.length,2);assert.equal(values[1].length,3);assert.equal(values[1][0],cached.project);assert.ok(values[1][2]===null);assert.equal(sql.split('clock_timestamp()').length,2);
        if(cacheDstSql===undefined)cacheDstSql=sql;else assert.equal(sql,cacheDstSql);cacheDstQueries++;assert.equal(sql.split("interval '168 hours'").length,3);
        const replay=sql.replace('clock_timestamp() AS at','$4::timestamptz AS at'),binds=[...values[1],cacheDstAt],oldDays=await query(replay.replaceAll("interval '168 hours'","interval '7 days'"),binds);
        if(cacheDstAt==='2026-03-12T16:30:00Z')assert.equal(oldDays.rows.length,0,'The old calendar-day cutoff incorrectly rejects this167.5-hour spring source.');
        else{assert.equal(oldDays.rows.length,1,'The old fall cutoff still accepts the168.5-hour expired source.');assert.equal(new Date(oldDays.rows[0].eligibleUntil).toISOString(),'2026-11-05T17:00:00.000Z','The old calendar-day expiry is169 elapsed hours across fall DST.');}
        values=[replay,binds];
      }return (query as any)(...values);}) as typeof client.query;
    client.release=((...args:any[])=>{client.query=query;return (release as any)(...args);}) as typeof client.release;return client;
  }) as typeof pool.connect;
  try{
    await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650 WHERE id=$1',[cached.workspace]);
    await pool.query("UPDATE prompt_execution SET completed_at='2026-03-05T17:00:00Z' WHERE id=$1",[cacheDstId]);
    const spring=await cacheQuote([selected[0]]);assert.equal(spring.quote.cacheReused,true);assert.equal(new Date(spring.quote.cache!.items[0].eligibleUntil!).toISOString(),'2026-03-12T17:00:00.000Z');
    await pool.query("UPDATE prompt_execution SET completed_at='2026-10-29T16:00:00Z' WHERE id=$1",[cacheDstId]);cacheDstAt='2026-11-05T15:30:00Z';
    const fallFresh=await cacheQuote([selected[0]]);assert.equal(fallFresh.quote.cacheReused,true);assert.equal(new Date(fallFresh.quote.cache!.items[0].eligibleUntil!).toISOString(),'2026-11-05T16:00:00.000Z');
    cacheDstAt='2026-11-05T16:30:00Z';assert.equal((await cacheQuote([selected[0]])).quote.cacheReused,false);assert.equal(cacheDstQueries,3);assert.ok(cacheDstSql);
  }finally{pool.connect=cacheDstConnect;await pool.query('UPDATE prompt_execution SET completed_at=$2::timestamptz WHERE id=$1',[cacheDstId,cacheDstBefore.at]);await pool.query('UPDATE workspace SET raw_provider_evidence_days=$2 WHERE id=$1',[cached.workspace,cacheDstBefore.days]);}
  const sourceLedger=(await pool.query('SELECT id,md5(to_jsonb(p)::text) AS hash FROM provider_request p WHERE workspace_id=$1 ORDER BY id',[cached.workspace])).rows;
  await saveBudget(cached.workspace,cacheOwner,{paused:true});
  const reversedQuote=await cacheQuote([selected[1],selected[0]]);assert.equal(reversedQuote.quote.estimateUsd,'0.000000');assert.equal(reversedQuote.quote.cacheReused,true);
  const reverseKey=randomUUID(),reversed=await startPromptExecution(cached.project,cacheOwner,{quoteId:reversedQuote.quote.id,requestKey:reverseKey});
  assert.deepEqual(reversed.comparison.runs.map(r=>r.model),[selected[1],selected[0]]);assert.equal(reversed.comparison.runs.every(r=>r.reuse&&r.chargeStatus===null&&r.actualUsd===null),true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE id=$1::uuid OR data->>'comparisonId'=$2",[reversed.comparison.id,reversed.comparison.id])).rows[0].n,0);
  assert.deepEqual((await pool.query('SELECT id,md5(to_jsonb(p)::text) AS hash FROM provider_request p WHERE workspace_id=$1 ORDER BY id',[cached.workspace])).rows,sourceLedger);
  assert.equal((await startPromptExecution(cached.project,cacheOwner,{quoteId:reversedQuote.quote.id,requestKey:reverseKey})).comparison.id,reversed.comparison.id);
  const missQuote=await cacheQuote([selected[1],selected[2],selected[0]]);await assert.rejects(cacheStart(missQuote),{status:409});assert.equal(fourPaid-cachePaidBefore,2);
  assert.equal((await pool.query('SELECT id FROM prompt_comparison WHERE quote_id=$1',[missQuote.quote.id])).rowCount,0,'A mixed miss refusal rolls back cached links and the comparison too.');
  await saveBudget(cached.workspace,cacheOwner,{paused:false});
  const overlap=await cacheStart(missQuote);await executePromptComparison(overlap.comparison.id,sendFour);assert.equal(fourPaid-cachePaidBefore,3);
  const fourCache=await cacheStart(await cacheQuote([selected[3],selected[0],selected[2],selected[1]]));await executePromptComparison(fourCache.comparison.id,sendFour);assert.equal(fourPaid-cachePaidBefore,4);
  const cacheSummary=(await getPromptComparisonSummary(cached.project,viewer,fourCache.comparison.id)).comparison;
  assert.deepEqual(cacheSummary.runs.map(r=>r.model),[selected[3],selected[0],selected[2],selected[1]]);assert.equal(cacheSummary.runs.filter(r=>r.reuse).length,3);
  const retained=await getPromptExecutionResult(cached.project,viewer,reversed.comparison.runs[0].id);assert.equal(retained.comparisonId,reversed.comparison.id);assert.equal(retained.run.result.text,largeText);assert.ok(retained.run.reuse);assert.equal(retained.run.reuse.sourceRunId,firstCache.comparison.runs[1].id);
  assert.ok(Buffer.byteLength(JSON.stringify(retained))<=2097152);assert.equal((await getPromptExecutionCitations(cached.project,viewer,retained.run.id,new URLSearchParams({offset:'0'}))).total,0);
  const cachedApi=`${config.appUrl}/api/projects/${cached.project}/prompt-executions`;
  for(const path of ['/comparisons/'+reversed.comparison.id+'/summary','/runs/'+retained.run.id,'/runs/'+retained.run.id+'/citations?offset=0']){const response=await handleApi(new Request(cachedApi+path,{headers:{cookie}}));assert.equal(response.status,200);const bytes=new Uint8Array(await response.arrayBuffer());assert.ok(bytes.byteLength<=2097152);const wire=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));assert.equal(wire.role,'owner');assert.equal(wire.comparison?.id??wire.comparisonId,reversed.comparison.id);}
  console.log('PASS per-model cache reorders and overlaps one through four models without new cached charges/jobs, including paused all-hit reuse');

  const sourceA=firstCache.comparison.runs[0].id;await pool.query("UPDATE prompt_execution SET completed_at=clock_timestamp()-interval '168 hours'+interval '1 second' WHERE id=$1",[sourceA]);
  const nearExpiry=await cacheQuote([selected[0]]);assert.equal(nearExpiry.quote.cacheReused,true);
  await assert.rejects(heldRead(cached.workspace,()=>cacheStart(nearExpiry),async gate=>{const until=Date.now()+2500;while((await gate.query("SELECT completed_at+interval '168 hours'>clock_timestamp() AS fresh FROM prompt_execution WHERE id=$1",[sourceA])).rows[0].fresh){assert.ok(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,10));}}),{status:409});
  assert.equal(fourPaid-cachePaidBefore,4);assert.equal((await getPromptExecutionResult(cached.project,viewer,firstCache.comparison.runs[0].id)).run.resultExpired,false,'Cache TTL does not shorten retained history.');
  const freshQuote=await cacheQuote([selected[0]],false);assert.equal(freshQuote.quote.cacheReused,false);const freshCache=await cacheStart(freshQuote);await executePromptComparison(freshCache.comparison.id,sendFour);assert.equal(fourPaid-cachePaidBefore,5);
  const purgedQuote=await cacheQuote([selected[1]]);await pool.query('UPDATE prompt_execution SET result=NULL,result_purged_at=clock_timestamp() WHERE id=$1',[firstCache.comparison.runs[1].id]);await assert.rejects(cacheStart(purgedQuote),{status:409});
  const purged=await getPromptExecutionResult(cached.project,viewer,reversed.comparison.runs[0].id);assert.equal(purged.run.result,null);assert.equal(purged.run.resultExpired,true);assert.equal(purged.citations.count,null);
  await assert.rejects(heldRead(cached.workspace,()=>getPromptExecutionResult(cached.project,viewer,reversed.comparison.runs[0].id),async gate=>{await gate.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[cached.workspace,viewer]);}),{status:404});
  assert.deepEqual((await pool.query('SELECT status,count(*)::int AS n,sum(actual_micros)::text AS micros FROM provider_request WHERE workspace_id=$1 GROUP BY status',[cached.workspace])).rows,[{status:'settled',n:5,micros:'65'}]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name='prompt-execution' AND id IN(SELECT id FROM prompt_execution WHERE workspace_id=$1)",[cached.workspace])).rows[0].n,5,'One job per paid child: the five settled rows above.');assert.equal((await pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name='prompt-execution' AND id IN(SELECT id FROM prompt_comparison WHERE workspace_id=$1)",[cached.workspace])).rows[0].n,0);
  const revokedHit=await cacheQuote([selected[3]]);assert.equal(revokedHit.quote.cacheReused,true);await revokeProvider(cached.workspace,cacheOwner,cached.connectionId);await assert.rejects(cacheStart(revokedHit),{status:404});
  const cacheUnknown=await fixture(),unknownQuote=(await quotePromptExecution(cacheUnknown.project,owner,{...cacheUnknown.request,reuseCached:true},sendFour)).quote;
  const unknownCacheStart=await startPromptExecution(cacheUnknown.project,owner,{quoteId:unknownQuote.id,requestKey:randomUUID()});loseFour=true;await executePromptComparison(unknownCacheStart.comparison.id,sendFour);loseFour=false;
  const noUnknownHit=await quotePromptExecution(cacheUnknown.project,owner,{...cacheUnknown.request,reuseCached:true},sendFour);assert.equal(noUnknownHit.quote.cacheReused,false);await assert.rejects(startPromptExecution(cacheUnknown.project,owner,{quoteId:noUnknownHit.quote.id,requestKey:randomUUID()}),{status:409});
  assert.equal(fourPaid-cachePaidBefore,6);assert.deepEqual((await pool.query('SELECT status,count(*)::int AS n,sum(actual_micros)::text AS micros FROM provider_request WHERE workspace_id=$1 GROUP BY status ORDER BY status',[cacheUnknown.workspace])).rows,[{status:'cancelled',n:1,micros:null},{status:'uncertain',n:1,micros:null}]);
  console.log('PASS pinned cache expiry after actual workspace wait refuses paid fallback, explicit fresh work, purge/current-role enforcement and separate source accounting');
 }finally{try{await stopJobs();}finally{globalThis.fetch=originalFetch;}}
}
if(import.meta.main){try{await runPromptExecutionChecks();}finally{await closeDatabase();}}
