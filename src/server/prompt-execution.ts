import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {credentialKeys,decryptCredentials} from './credential-vault.ts';
import {providerTransaction,usd} from './providers.ts';
import {reserveSpendInTransaction,dispatchSpend,settleSpend,requestHash} from './spending.ts';
import {executionInput,executionParse,promptCacheKey,type RenderedInput,type RouteSnapshot} from './openrouter-input.ts';
import {readOpenRouterRoutes,keyFingerprint,executionActor,executionRequestBody,requestPromptExecution,reconcileOpenRouter,unknownExecution,type ExecutionOutcome} from './openrouter.ts';
import {openRouterTextProfile,openRouterMetadataBytes} from '../lib/openrouter-models.ts';
import {boundedOpenRouterMetadata,cachedOpenRouterModels} from './openrouter-models.ts';
import {assertPromptRecurringAuthority} from './prompt-recurring.ts';

export const promptExecutionQueue='prompt-execution';
const writers=['owner','admin','editor'],readers=[...writers,'viewer'];
type CacheItem={key:string;model:string;sourceRunId:string|null;sourceComparisonId:string|null;observedAt:string|null;eligibleUntil:string|null};
async function cacheCandidates(client:PoolClient,projectId:string,keys:string[],ids:string[]|null=null){
 if(!keys.length)return [];
 return (await client.query(`WITH read_clock AS MATERIALIZED(SELECT clock_timestamp() AS at)
  SELECT DISTINCT ON(r.cache_key) r.cache_key AS key,r.id AS "sourceRunId",r.comparison_id AS "sourceComparisonId",
   r.completed_at AS "observedAt",LEAST(r.completed_at+interval '168 hours',r.completed_at+w.raw_provider_evidence_days*interval '24 hours') AS "eligibleUntil"
  FROM prompt_execution r JOIN provider_request p ON p.id=r.id JOIN workspace w ON w.id=r.workspace_id CROSS JOIN read_clock
  WHERE r.project_id=$1 AND r.cache_key=ANY($2::text[]) AND ($3::uuid[] IS NULL OR r.id=ANY($3))
   AND r.status='completed' AND p.status='settled' AND p.actual_micros IS NOT NULL AND r.evidence->>'isByok'='false'
   AND r.result IS NOT NULL AND r.result_purged_at IS NULL AND r.completed_at<=read_clock.at AND r.completed_at>read_clock.at-interval '168 hours'
   AND r.completed_at>=read_clock.at-w.raw_provider_evidence_days*interval '24 hours'
  ORDER BY r.cache_key,r.completed_at DESC,r.id DESC`,[projectId,keys,ids])).rows;
}
const runSelect=`SELECT r.*,c.quote_id,c.user_id,c.cancel_requested,q.prompt_id,q.version_id,q.connection_id,q.connection_revision,q.key_fingerprint,q.request_actor,
 q.input,q.messages,q.input_purged_at,q.input_hash,q.expires_at,p.status AS charge_status,p.estimate_micros,p.actual_micros,p.provider_reference
 FROM prompt_execution r JOIN prompt_comparison c ON c.id=r.comparison_id JOIN prompt_execution_quote q ON q.id=c.quote_id JOIN provider_request p ON p.id=r.id`;
async function scoped<T>(projectId:string,userId:string,roles:string[],run:(client:PoolClient,wid:string,role:string)=>Promise<T>){
  z.uuid().parse(projectId);z.uuid().parse(userId);
  const project=(await getDatabase().pool.query('SELECT p.workspace_id FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId])).rows[0];
  if(!project)throw new FoundationError(404,'Project not found or unavailable.');
  return providerTransaction(project.workspace_id,userId,roles,async(client,role)=>{
    if(!(await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[projectId,project.workspace_id])).rowCount)throw new FoundationError(404,'Project not found or unavailable.');
    return run(client,project.workspace_id,role);
  });
}
async function connection(client:PoolClient,wid:string,id:string,revision?:number){
  const row=(await client.query("SELECT * FROM provider_connection WHERE id=$1 AND workspace_id=$2 AND provider='openrouter' AND revoked_at IS NULL",[id,wid])).rows[0];
  if(!row)throw new FoundationError(404,'OpenRouter connection not found or unavailable.');
  if(row.check_status!=='ok'||revision!==undefined&&row.revision!==revision)throw new FoundationError(409,'Check the current OpenRouter connection and prepare a new quote.');return row;
}
function credentials(row:any){return decryptCredentials(row.encrypted_credentials,{id:row.id,workspaceId:row.workspace_id,provider:row.provider,revision:row.revision});}
async function promptVersion(client:PoolClient,projectId:string,promptId:string,versionId:string){
  const row=(await client.query(`SELECT v.text FROM prompt_text_version v JOIN project_prompt p ON p.id=v.prompt_id AND p.project_id=v.project_id
    WHERE v.project_id=$1 AND v.prompt_id=$2 AND v.id=$3 AND p.archived_at IS NULL`,[projectId,promptId,versionId])).rows[0];
  if(!row)throw new FoundationError(409,'The chosen prompt version is unavailable or archived. Review the prompt before running it.');return row.text as string;
}
function summary(row:any,details=false){return {id:row.id,model:row.route.model,provider:row.route.providerName,status:row.status,chargeStatus:row.charge_status,
  estimateUsd:usd(row.estimate_micros),actualUsd:row.actual_micros===null?null:usd(row.actual_micros),dispatchedAt:row.dispatched_at,completedAt:row.completed_at,
  diagnostic:row.diagnostic,resultExpired:row.read_expired,...(details?{result:row.read_expired?null:row.result,reportedCost:row.evidence?.reportedCost??null,
    isByok:row.evidence?.isByok??null,upstreamReportedCost:row.evidence?.upstreamReportedCost??null,generationId:row.generation_id}:{} ),
  ...(row.reused?{chargeStatus:null,estimateUsd:null,actualUsd:null,dispatchedAt:null,reuse:{sourceRunId:row.source_execution_id,sourceComparisonId:row.source_comparison_id,
    observedAt:row.completed_at,originalCharge:{status:row.charge_status,estimateUsd:usd(row.estimate_micros),actualUsd:row.actual_micros===null?null:usd(row.actual_micros)}}}:{})};}
function boundedPromptRead<T>(value:T,answer=false){
  if(Buffer.byteLength(JSON.stringify(value),'utf8')>openRouterMetadataBytes)throw new FoundationError(413,answer?
    'The retained answer exceeds the complete 2MiB response limit. Its charge receipt remains available in the comparison summary.':
    'The complete prompt response exceeds the 2MiB limit. Read its comparison summary and individual answers.');
  return value;
}
async function comparisonDto(client:PoolClient,projectId:string,id:string,userId:string,role:string,details=false,individual=false){
  // Reads enforce the same strict raw cutoff as cleanup, including pending-input
  // protection. Cleanup lag must not expose expired payloads through a receipt.
  const c=(await client.query(`WITH read_clock AS MATERIALIZED(SELECT clock_timestamp() AS at)
    SELECT c.*,q.prompt_id,q.version_id,q.input,q.messages,q.cache_plan,jsonb_array_length(q.routes) AS model_count,v.text,read_clock.at::text AS read_at,
    (q.input_purged_at IS NOT NULL OR (
      EXISTS(SELECT 1 FROM prompt_comparison_item i WHERE i.comparison_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM prompt_comparison_item i JOIN prompt_execution r ON r.id=i.execution_id WHERE i.comparison_id=c.id
        AND (r.status IN('queued','running') OR r.completed_at IS NULL
          OR r.completed_at>=read_clock.at-w.raw_provider_evidence_days*interval '24 hours')))) AS input_expired
    FROM prompt_comparison c
    JOIN prompt_execution_quote q ON q.id=c.quote_id
    JOIN workspace w ON w.id=c.workspace_id
    JOIN prompt_text_version v ON v.id=q.version_id AND v.project_id=q.project_id AND v.prompt_id=q.prompt_id
    CROSS JOIN read_clock WHERE c.id=$1 AND c.project_id=$2`,[id,projectId])).rows[0];
  if(!c)throw new FoundationError(404,'Comparison not found or unavailable.');
  const includeAnswers=details&&!individual&&c.model_count<=2;
  // Summaries never retrieve answer blobs or copied provider evidence from PostgreSQL.
  const projection=`SELECT i.id,i.workspace_id,i.position,i.reused,r.id AS source_execution_id,r.comparison_id AS source_comparison_id,r.route,r.status,r.diagnostic,r.dispatched_at,r.completed_at,
    r.result_purged_at,(r.result IS NOT NULL) AS has_result,p.status AS charge_status,p.estimate_micros,p.actual_micros
    ${includeAnswers?',r.result,r.evidence,r.generation_id':''}
    FROM prompt_comparison_item i JOIN prompt_execution r ON r.id=i.execution_id JOIN provider_request p ON p.id=r.id`;
  const rows=(await client.query(`SELECT saved.*,
    (saved.result_purged_at IS NOT NULL OR (${includeAnswers?'saved.result IS NOT NULL':'saved.has_result'} AND saved.completed_at IS NOT NULL
      AND saved.completed_at<$3::timestamptz-w.raw_provider_evidence_days*interval '24 hours')) AS read_expired
    FROM (${projection} WHERE i.comparison_id=$1 AND i.project_id=$2) saved
    JOIN workspace w ON w.id=saved.workspace_id ORDER BY saved.position`,[id,projectId,c.read_at])).rows;
  return {id:c.id,quoteId:c.quote_id,createdAt:c.created_at,cancelRequested:c.cancel_requested,
    prompt:{id:c.prompt_id,versionId:c.version_id,textPreview:Array.from(c.text as string).slice(0,160).join('')},
    canCancel:writers.includes(role)&&(role==='owner'||c.user_id===userId)&&rows.some(r=>r.status==='queued'&&r.charge_status==='reserved'),
    runs:rows.map(r=>summary(r,includeAnswers)),
    ...(details?{input:c.input_expired?null:c.input,messages:c.input_expired?null:c.messages,inputExpired:c.input_expired,cache:{reused:rows.some(r=>r.reused),available:c.cache_plan!==null},...(!includeAnswers?{answerMode:'individual' as const}:{})}:{})};
}
export async function getPromptExecutions(projectId:string,userId:string){return scoped(projectId,userId,readers,async(client,wid,role)=>{
  const connections=await client.query("SELECT id,name,check_status AS \"checkStatus\" FROM provider_connection WHERE workspace_id=$1 AND provider='openrouter' AND revoked_at IS NULL ORDER BY created_at,id",[wid]);
  const budget=(await client.query('SELECT paused FROM workspace_budget WHERE workspace_id=$1',[wid])).rows[0];
  const comparisons=[];for(const row of (await client.query('SELECT id FROM prompt_comparison WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20',[projectId])).rows)comparisons.push(await comparisonDto(client,projectId,row.id,userId,role));
  const catalog=cachedOpenRouterModels();
  return boundedOpenRouterMetadata({role,models:catalog.models.filter(m=>m.admission==='candidate').map(m=>m.id),catalog,vaultConfigured:credentialKeys()!==null,spendingPaused:budget?.paused??false,connections:connections.rows,comparisons,cache:{available:true},scheduling:{available:true,kind:'owner-approved-text-v1'}});
});}
export async function getPromptComparison(projectId:string,userId:string,id:string){z.uuid().parse(id);return scoped(projectId,userId,readers,async(client,_wid,role)=>boundedPromptRead({role,comparison:await comparisonDto(client,projectId,id,userId,role,true)}));}
export async function getPromptComparisonSummary(projectId:string,userId:string,id:string){z.uuid().parse(id);return scoped(projectId,userId,readers,async(client,_wid,role)=>boundedPromptRead({role,comparison:await comparisonDto(client,projectId,id,userId,role,true,true)}));}
export async function getPromptExecutionResult(projectId:string,userId:string,id:string){
  z.uuid().parse(id);return scoped(projectId,userId,readers,async(client,_wid,role)=>{
    // Capture the raw-evidence cutoff after the workspace/project wait. Cleanup lag
    // cannot expose an expired answer, and no copied input or full evidence is exported.
    const row=(await client.query(`WITH read_clock AS MATERIALIZED(SELECT clock_timestamp() AS at),saved AS (
      SELECT i.id,i.comparison_id,i.reused,r.id AS source_execution_id,r.comparison_id AS source_comparison_id,r.route,r.status,r.diagnostic,r.dispatched_at,r.completed_at,r.result,r.evidence,r.generation_id,
        p.status AS charge_status,p.estimate_micros,p.actual_micros,
        (r.result_purged_at IS NOT NULL OR (r.result IS NOT NULL AND r.completed_at IS NOT NULL
          AND r.completed_at<read_clock.at-w.raw_provider_evidence_days*interval '24 hours')) AS read_expired
      FROM prompt_comparison_item i JOIN prompt_execution r ON r.id=i.execution_id JOIN provider_request p ON p.id=r.id JOIN workspace w ON w.id=r.workspace_id CROSS JOIN read_clock
      WHERE i.id=$1 AND i.project_id=$2)
      SELECT id,comparison_id,reused,source_execution_id,source_comparison_id,route,status,charge_status,estimate_micros,actual_micros,dispatched_at,completed_at,diagnostic,read_expired,
        CASE WHEN read_expired THEN NULL ELSE result-'citations' END AS result,generation_id,
        CASE WHEN read_expired OR result IS NULL THEN NULL ELSE jsonb_array_length(result->'citations') END AS citation_count,
        jsonb_build_object('reportedCost',evidence->'reportedCost','isByok',evidence->'isByok','upstreamReportedCost',evidence->'upstreamReportedCost') AS evidence
      FROM saved`,[id,projectId])).rows[0];
    if(!row)throw new FoundationError(404,'Prompt request not found or unavailable.');
    return boundedPromptRead({role,comparisonId:row.comparison_id,run:summary(row,true),citations:{count:row.citation_count,pageSize:20}},true);
  });
}
export async function getPromptExecutionCitations(projectId:string,userId:string,id:string,query:URLSearchParams){
  z.uuid().parse(id);
  if(query.size!==1||!['0','20','40','60','80','100'].includes(query.get('offset')??''))throw new FoundationError(400,'Use exactly one citation offset: 0, 20, 40, 60, 80 or 100.');
  const offset=Number(query.get('offset'));
  return scoped(projectId,userId,readers,async(client,_wid,role)=>{
    const row=(await client.query(`WITH read_clock AS MATERIALIZED(SELECT clock_timestamp() AS at),saved AS (
      SELECT i.id,i.comparison_id,r.result,
        (r.result_purged_at IS NOT NULL OR (r.result IS NOT NULL AND r.completed_at IS NOT NULL
          AND r.completed_at<read_clock.at-w.raw_provider_evidence_days*interval '24 hours')) AS read_expired
      FROM prompt_comparison_item i JOIN prompt_execution r ON r.id=i.execution_id JOIN workspace w ON w.id=r.workspace_id CROSS JOIN read_clock WHERE i.id=$1 AND i.project_id=$2),
      retained AS (SELECT id,comparison_id,read_expired,CASE WHEN read_expired OR result IS NULL THEN NULL ELSE result->'citations' END AS citations FROM saved)
      SELECT id,comparison_id,read_expired,jsonb_array_length(citations) AS total,
        COALESCE((SELECT jsonb_agg(item.value ORDER BY item.ordinality)
          FROM jsonb_array_elements(citations) WITH ORDINALITY AS item(value,ordinality)
          WHERE item.ordinality>$3 AND item.ordinality<=$3+20),'[]'::jsonb) AS items FROM retained`,[id,projectId,offset])).rows[0];
    if(!row)throw new FoundationError(404,'Prompt request not found or unavailable.');
    return boundedPromptRead({role,runId:row.id,comparisonId:row.comparison_id,resultExpired:row.read_expired,total:row.total,offset,
      nextOffset:row.total!==null&&offset+20<row.total?offset+20:null,items:row.items});
  });
}
export async function quotePromptExecution(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch,internal?:{checkpoint:(client:PoolClient,quoteId:string)=>Promise<void>}){
  const input=executionParse(executionInput,raw);
  const saved=await scoped(projectId,userId,writers,async(client,wid)=>{
    const text=await promptVersion(client,projectId,input.promptId,input.versionId),row=await connection(client,wid,input.connectionId);
    const messages:RenderedInput=[...(input.systemText?[{role:'system' as const,content:input.systemText}]:[]),{role:'user',content:text}];
    return {messages,revision:row.revision,credentials:credentials(row),name:row.name};
  });
  const routes=await readOpenRouterRoutes(saved.credentials,input.models,input.maxCompletionTokens,send,openRouterTextProfile),fingerprint=keyFingerprint(saved.credentials);
  for(const route of routes)executionRequestBody(saved.messages,route,input.maxCompletionTokens,'00000000-0000-4000-8000-000000000000',executionActor(userId));
  return scoped(projectId,userId,writers,async(client,wid,role)=>{
    await connection(client,wid,input.connectionId,saved.revision);await promptVersion(client,projectId,input.promptId,input.versionId);
    let plan:CacheItem[]|null=null;
    if(input.reuseCached!==undefined){
      const catalog=cachedOpenRouterModels();if(catalog.status!=='fresh')throw new FoundationError(409,'Refresh models before preparing a cache-aware quote.');
      plan=routes.map(route=>{const model=catalog.models.find(m=>m.id===route.model&&m.admission==='candidate');if(!model)throw new FoundationError(409,'The observed model identity changed. Prepare a new quote.');return {key:promptCacheKey(wid,projectId,input,saved.messages,route,model.canonicalSlug,saved.revision,fingerprint),model:route.model,sourceRunId:null,sourceComparisonId:null,observedAt:null,eligibleUntil:null};});
      if(input.reuseCached)for(const hit of await cacheCandidates(client,projectId,plan.map(i=>i.key))){const item=plan.find(i=>i.key===hit.key)!;Object.assign(item,hit);}
    }
    const hash=requestHash(JSON.stringify({input,messages:saved.messages,routes,...(plan?{cachePlan:plan}:{})}));
    const row=(await client.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,key_fingerprint,input,messages,routes,input_hash,request_actor,expires_at,cache_plan)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp()+interval '5 minutes',$15) RETURNING id,created_at,expires_at`,
      [randomUUID(),wid,projectId,userId,input.promptId,input.versionId,input.connectionId,saved.revision,fingerprint,JSON.stringify(input),JSON.stringify(saved.messages),JSON.stringify(routes),hash,executionActor(userId),plan===null?null:JSON.stringify(plan)])).rows[0];
    // Trusted server-only hook: recurrence and its quote either both commit or neither does.
    // It is never read from HTTP input and runs under this existing W -> P gate.
    if(internal)await internal.checkpoint(client,row.id);
    return {role,quote:{id:row.id,createdAt:row.created_at,expiresAt:row.expires_at,input,messages:saved.messages,connectionName:saved.name,
      routes:routes.map(r=>({...r,estimateMicros:undefined,estimateUsd:usd(r.estimateMicros)})),estimateUsd:usd(routes.reduce((sum,r,index)=>sum+(plan?.[index].sourceRunId?0n:BigInt(r.estimateMicros)),0n)),
      explanation:plan===null?'Conservative reservation under the selected endpoint’s published limits. Actual credit charges are recorded after completion; external invoices, credit-purchase fees and taxes are excluded.':'Conservative reservation for new requests only. Reused answers retain their original observation and charge. Provider updates in place may not be detected; saved answers can be up to seven days old. External invoices, credit-purchase fees and taxes are excluded.',cacheReused:plan?.some(i=>i.sourceRunId!==null)??false,
      ...(plan?{cache:{version:'seven-day-v1',items:plan.map(({key,...item})=>item)}}:{})}};
  });
}
export async function startPromptExecution(projectId:string,userId:string,raw:unknown){
  const {quoteId,requestKey}=executionParse(z.object({quoteId:z.uuid(),requestKey:z.uuid()}).strict(),raw);
  return scoped(projectId,userId,writers,async(client,wid,role)=>{
    const prior=(await client.query('SELECT * FROM prompt_comparison WHERE workspace_id=$1 AND request_key=$2',[wid,requestKey])).rows[0];
    if(prior){if(prior.project_id!==projectId||prior.user_id!==userId||prior.quote_id!==quoteId)throw new FoundationError(409,'This request key already identifies different work.');return boundedPromptRead({role,comparison:await comparisonDto(client,projectId,prior.id,userId,role,true,true)});}
    const q=(await client.query('SELECT * FROM prompt_execution_quote WHERE id=$1 AND project_id=$2 AND user_id=$3 AND workspace_id=$4 FOR UPDATE',[quoteId,projectId,userId,wid])).rows[0];
    if(!q)throw new FoundationError(404,'Quote not found or unavailable.');
    await assertPromptRecurringAuthority(client,q.id);
    if(q.expires_at.getTime()<=Date.now())throw new FoundationError(409,'The quote expired. Prepare a new quote.');
    await connection(client,wid,q.connection_id,q.connection_revision);await promptVersion(client,projectId,q.prompt_id,q.version_id);
    if((await client.query('SELECT id FROM prompt_comparison WHERE quote_id=$1',[quoteId])).rowCount)throw new FoundationError(409,'This quote already started a comparison.');
    const plan=q.cache_plan as CacheItem[]|null,hits=plan?.filter(i=>i.sourceRunId!==null)??[];
    const current=await cacheCandidates(client,projectId,hits.map(i=>i.key),hits.map(i=>i.sourceRunId!));
    if(hits.some(i=>!current.some(r=>r.key===i.key&&r.sourceRunId===i.sourceRunId)))throw new FoundationError(409,'A saved answer is no longer eligible. Prepare a new quote; no paid replacement was started.');
    const hasMiss=(q.routes as RouteSnapshot[]).some((_r,index)=>!plan?.[index].sourceRunId),boss=hasMiss?await getBoss():null;
    const id=q.recurring_occurrence_id??randomUUID();await client.query('INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key) VALUES($1,$2,$3,$4,$5,$6)',[id,quoteId,wid,projectId,userId,requestKey]);
    for(const [position,route] of (q.routes as RouteSnapshot[]).entries()){
      const item=plan?.[position];
      if(item?.sourceRunId){await client.query('INSERT INTO prompt_comparison_item(id,comparison_id,workspace_id,project_id,position,execution_id,reused) VALUES($1,$2,$3,$4,$5,$6,true)',[randomUUID(),id,wid,projectId,position,item.sourceRunId]);continue;}
      await reserveSpendInTransaction(client,wid,userId,{connectionId:q.connection_id,requestKey:randomUUID(),operation:'prompt.execute',inputHash:requestHash(`${q.input_hash}:${position}:${route.model}`),estimateUsd:usd(route.estimateMicros)},async(tx,child)=>{
        await tx.query("INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,cache_key) VALUES($1,$2,$3,$4,$5,$6,'queued',$7)",[child,id,wid,projectId,position,JSON.stringify(route),item?.key??null]);
        // D3: one zero-retry job per child, enqueued with its reservation; Start authorizes every child.
        if(!await boss!.send(promptExecutionQueue,{executionId:child,comparisonId:id},{id:child,retryLimit:0,expireInSeconds:180,db:{executeSql:(text,values)=>tx.query(text,values)}}))throw new Error('Request could not be queued.');
      });
    }
    if(q.recurring_occurrence_id){const linked=await client.query("UPDATE prompt_occurrence SET comparison_id=$2,status='started',reason=NULL WHERE id=$1 AND quote_id=$3 AND request_key=$4 AND status='quoted' AND comparison_id IS NULL",[q.recurring_occurrence_id,id,q.id,requestKey]);if(linked.rowCount!==1)throw new FoundationError(409,'This recurring occurrence changed. Reload its saved status.');}
    return boundedPromptRead({role,comparison:await comparisonDto(client,projectId,id,userId,role,true,true)});
  });
}
async function cancelChildren(client:PoolClient,id:string,diagnostic:string,childId:string|null=null){
  await client.query(`UPDATE provider_request p SET status='cancelled',updated_at=clock_timestamp() FROM prompt_execution r
    WHERE r.comparison_id=$1 AND p.id=r.id AND p.status='reserved' AND ($2::uuid IS NULL OR r.id=$2)`,[id,childId]);
  await client.query(`UPDATE prompt_execution r SET status='cancelled',diagnostic=$2,completed_at=clock_timestamp() FROM provider_request p
    WHERE r.comparison_id=$1 AND p.id=r.id AND p.status='cancelled' AND r.status='queued' AND ($3::uuid IS NULL OR r.id=$3)`,[id,diagnostic,childId]);
}
export async function cancelPromptComparison(projectId:string,userId:string,id:string,raw:unknown){
  z.uuid().parse(id);executionParse(z.object({}).strict(),raw);
  return scoped(projectId,userId,writers,async(client,_wid,role)=>{
    const row=(await client.query('SELECT * FROM prompt_comparison WHERE id=$1 AND project_id=$2',[id,projectId])).rows[0];
    if(!row)throw new FoundationError(404,'Comparison not found or unavailable.');
    if(row.user_id!==userId&&role!=='owner')throw new FoundationError(403,'Only the initiating user or owner can stop this comparison.');
    await client.query('UPDATE prompt_comparison SET cancel_requested=true WHERE id=$1',[id]);await cancelChildren(client,id,'Stopped before dispatch. Already dispatched work may still incur a charge.');
    return boundedPromptRead({role,comparison:await comparisonDto(client,projectId,id,userId,role,true,true)});
  });
}
async function workerTransaction<T>(comparisonId:string,work:(client:PoolClient)=>Promise<T>){
  const client=await getDatabase().pool.connect();try{await client.query('BEGIN');const c=(await client.query('SELECT workspace_id FROM prompt_comparison WHERE id=$1',[comparisonId])).rows[0];if(!c)throw new Error('Comparison no longer exists.');await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[c.workspace_id]);const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
async function finish(row:any,outcome:ExecutionOutcome,crashOnly=false){return workerTransaction(row.comparison_id,async client=>{
  const current=(await client.query(runSelect+' WHERE r.id=$1',[row.id])).rows[0];
  if(!current||crashOnly&&(current.status!=='running'||current.charge_status!=='dispatched'||current.dispatched_at.getTime()>Date.now()-90_000))return;
  if(!['dispatched','uncertain'].includes(current.charge_status))return;
  if(current.generation_id&&outcome.reference&&current.generation_id!==outcome.reference)outcome=unknownExecution(current.generation_id,'Conflicting provider generation receipts require investigation.');
  const reference=outcome.reference??current.generation_id;
  const settled=await settleSpend(client,current.workspace_id,current.id,outcome.cost,reference);
  await client.query(`UPDATE prompt_execution SET status=$2,diagnostic=$3,result=$4,evidence=$5,generation_id=$6,completed_at=clock_timestamp() WHERE id=$1`,
    [row.id,settled.reconciliationRequired?'uncertain':outcome.result?'completed':'failed',outcome.diagnostic,outcome.result===null?null:JSON.stringify(outcome.result),JSON.stringify(outcome.evidence),reference]);
  // Owner decision D3: nothing pauses automatically; a manual pause stops each sibling at its own dispatch gate.
  if(settled.reconciliationRequired)await cancelChildren(client,current.comparison_id,'Remaining requests were not sent because an earlier charge in this comparison is uncertain. Reconcile it first.');
});}
/** Owner decision D3: Start authorized this child; no quote clock or sibling order applies after Start. */
export async function executePromptExecution(executionId:string,send:typeof fetch=fetch){
  if(!z.uuid().safeParse(executionId).success)throw new Error('Invalid prompt execution job.');
  const row=(await getDatabase().pool.query(runSelect+' WHERE r.id=$1',[executionId])).rows[0];if(row?.status!=='queued')return;
  let secret:unknown,dispatchedAt:Date|undefined;
  try{
    const saved=await scoped(row.project_id,row.user_id,writers,async(client,wid)=>{await assertPromptRecurringAuthority(client,row.quote_id);return {credentials:credentials(await connection(client,wid,row.connection_id,row.connection_revision))};});
    if(keyFingerprint(saved.credentials)!==row.key_fingerprint)throw new FoundationError(409,'The key identity changed.');
    executionRequestBody(row.messages,row.route,row.input.maxCompletionTokens,row.id,row.request_actor);
    const [fresh]=await readOpenRouterRoutes(saved.credentials,[row.route.model],row.input.maxCompletionTokens,send,row.route.profile,row.route.profile?[row.route.tag]:undefined);
    if(Object.entries(fresh).some(([key,value])=>row.route[key]!==value))throw new FoundationError(409,'Endpoint prices or capacity changed.');
    await dispatchSpend(row.workspace_id,row.user_id,row.id,async(client)=>{
      const live=(await client.query(runSelect+' WHERE r.id=$1',[row.id])).rows[0];
      if(live.status!=='queued'||live.cancel_requested)throw new FoundationError(409,'Execution authorization changed.');
      await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[row.project_id]);await promptVersion(client,row.project_id,row.prompt_id,row.version_id);
      await assertPromptRecurringAuthority(client,row.quote_id,true);
      secret=credentials(await connection(client,row.workspace_id,row.connection_id,row.connection_revision));if(keyFingerprint(secret)!==row.key_fingerprint)throw new FoundationError(409,'The key identity changed.');
      dispatchedAt=(await client.query("UPDATE prompt_execution SET status='running',dispatched_at=clock_timestamp() WHERE id=$1 RETURNING dispatched_at",[row.id])).rows[0].dispatched_at;
    });
  }catch(error){
    if(error instanceof FoundationError){await workerTransaction(row.comparison_id,async client=>{
      // A duplicate worker must not cancel this child after another worker advances it.
      const current=(await client.query('SELECT status FROM prompt_execution WHERE id=$1',[row.id])).rows[0];
      if(current?.status!=='queued')return;
      await cancelChildren(client,row.comparison_id,'Not dispatched because the endpoint, permissions, credentials, the paid-work pause or an uncertain charge changed.',row.id);
    });return;}throw error;
  }
  const outcome=await requestPromptExecution(secret,row.messages,row.route,row.input.maxCompletionTokens,row.id,row.request_actor,dispatchedAt!,async generation=>{
    await workerTransaction(row.comparison_id,async client=>{const live=(await client.query('SELECT generation_id FROM prompt_execution WHERE id=$1',[row.id])).rows[0];if(live.generation_id&&live.generation_id!==generation)throw new Error('Generation receipt conflict.');await client.query('UPDATE prompt_execution SET generation_id=$2 WHERE id=$1',[row.id,generation]);});
  },send);
  await finish(row,outcome);
}
/** Legacy comparison-keyed jobs (queued before per-child Start) and direct callers run each child in position order. */
export async function executePromptComparison(id:string,send:typeof fetch=fetch){
  if(!z.uuid().safeParse(id).success)throw new Error('Invalid comparison job.');
  for(const child of (await getDatabase().pool.query('SELECT id FROM prompt_execution WHERE comparison_id=$1 ORDER BY position',[id])).rows)await executePromptExecution(child.id,send);
}
// Same-client leaves, reused by recurring authorization without nesting transactions.
export {scoped as withPromptProject,connection as promptConnection,cancelChildren as cancelPromptChildren};
export async function reconcilePromptExecution(projectId:string,userId:string,id:string,raw:unknown,send:typeof fetch=fetch){
  z.uuid().parse(id);executionParse(z.object({}).strict(),raw);
  const saved=await scoped(projectId,userId,['owner'],async(client,wid)=>{
    const row=(await client.query(runSelect+' WHERE r.id=$1 AND r.project_id=$2',[id,projectId])).rows[0];
    if(!row)throw new FoundationError(404,'Execution not found or unavailable.');
    if(row.status!=='uncertain'||row.charge_status!=='uncertain'||!row.dispatched_at)throw new FoundationError(409,'This charge does not require reconciliation.');
    const conn=await connection(client,wid,row.connection_id),secret=credentials(conn);
    if(keyFingerprint(secret)!==row.key_fingerprint)throw new FoundationError(409,'Reconciliation requires the original OpenRouter key identity.');
    return {row,credentials:secret,revision:conn.revision};
  });
  let outcome:ExecutionOutcome;
  try{outcome=await reconcileOpenRouter(saved.credentials,saved.row.generation_id,saved.row.route,saved.row.dispatched_at,id,saved.row.request_actor,send);}
  catch(error){if(error instanceof FoundationError)return boundedPromptRead({...await getPromptComparisonSummary(projectId,userId,saved.row.comparison_id),reconciliation:{status:'inconclusive',message:error.message}});throw error;}
  return scoped(projectId,userId,['owner'],async(client,wid,role)=>{
    const conn=await connection(client,wid,saved.row.connection_id,saved.revision);if(keyFingerprint(credentials(conn))!==saved.row.key_fingerprint)throw new FoundationError(409,'The key changed during reconciliation.');
    const current=(await client.query(runSelect+' WHERE r.id=$1 AND r.project_id=$2',[id,projectId])).rows[0];
    if(current.charge_status!=='uncertain'||current.generation_id!==outcome.reference)throw new FoundationError(409,'The receipt changed. Reload this comparison.');
    const settled=await settleSpend(client,wid,id,outcome.cost,outcome.reference);
    // Charge recovery is not a new answer or a new raw-evidence retention period.
    await client.query('UPDATE prompt_execution SET status=$2,evidence=$3,diagnostic=$4,completed_at=COALESCE(completed_at,clock_timestamp()) WHERE id=$1',[id,settled.reconciliationRequired?'uncertain':current.result?'completed':'reconciled',JSON.stringify(outcome.evidence),outcome.diagnostic??'The credit charge was recovered. The original answer is unavailable; a new answer requires a new paid quote.']);
    return boundedPromptRead({role,comparison:await comparisonDto(client,projectId,current.comparison_id,userId,role,true,true),reconciliation:{status:settled.reconciliationRequired?'inconclusive':'matched',message:settled.reconciliationRequired?'The charge remains unresolved; new paid work stays blocked until it is reconciled.':'Charge recorded.'}});
  });
}
// Per child: quote age never cancels a started child (D3). A live job keyed by the child or, for legacy
// comparison-keyed jobs, by its comparison covers a queued child.
const jobless=`NOT EXISTS(SELECT 1 FROM pgboss.job j WHERE j.name=$1 AND j.id IN(r.id,r.comparison_id) AND j.state NOT IN('failed','cancelled','completed'))`;
export async function reconcilePromptExecutionJobs(){
  const pending=(await getDatabase().pool.query(runSelect+` WHERE (r.status='running' AND r.dispatched_at<clock_timestamp()-interval '90 seconds')
    OR (r.status='queued' AND ${jobless}) ORDER BY c.created_at,r.position LIMIT 50`,[promptExecutionQueue])).rows;
  for(const row of pending){
    if(row.status==='running'){await finish(row,unknownExecution(row.generation_id,'The worker stopped after dispatch. Reconcile the captured generation receipt; no request will be replayed.'),true);continue;}
    await workerTransaction(row.comparison_id,async client=>{
      // Recheck the queue after the gate; a stale sweep must not cancel freshly active work.
      if((await client.query(`SELECT 1 FROM prompt_execution r WHERE r.id=$2 AND ${jobless}`,[promptExecutionQueue,row.id])).rowCount)await cancelChildren(client,row.comparison_id,'The queued request did not run. Prepare a new quote to try again.',row.id);
    });
  }
}
