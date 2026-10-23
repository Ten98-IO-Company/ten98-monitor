import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {openRouterModelId,openRouterProviderTag,openRouterRouteIdentity,openRouterSavedProvider,openRouterTextProfile,openRouterMetadataBytes} from '../src/lib/openrouter-models.ts';
import {boundedOpenRouterMetadata,cachedOpenRouterModels,modelCatalogRow,refreshOpenRouterCatalog,requireCatalogModels,openRouterCatalogLimits} from '../src/server/openrouter-models.ts';
import {executionBody,executionInput,parseOpenRouterJson} from '../src/server/openrouter-input.ts';
import {executionRequestBody,parseRoute,parseExecutionOutcome,readOpenRouterRoutes} from '../src/server/openrouter.ts';
import {suggestionModel,suggestionQuoteInput} from '../src/server/ai-suggestion-input.ts';
import {insightFilters} from '../src/server/prompt-insights.ts';
process.env.AUTH_SECRET='synthetic-models-unit-auth-'.repeat(4);process.env.DATABASE_URL='postgresql://synthetic:synthetic@localhost/unused_models_unit';
delete process.env.AUTH_SECRET_FILE;delete process.env.DATABASE_URL_FILE;
const model='vendor/text-standard',id=randomUUID(),actor='a'.repeat(64);
function catalogRow(value=model){return {id:value,canonical_slug:value,name:'Text standard',context_length:128000,top_provider:{max_completion_tokens:4096},architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['max_tokens','response_format','structured_outputs'],pricing:{prompt:'1e-7',completion:'4e-7',request:'0.0000001'}};}
function endpoint(tag='compute/region',provider='Compute One'){return {tag,provider_name:provider,model_id:model,status:0,context_length:128000,max_prompt_tokens:null,max_completion_tokens:4096,supported_parameters:['max_tokens','response_format','structured_outputs'],pricing:{prompt:'1e-7',completion:'4e-7',request:'0.0000001',input_cache_read:'5e-8',discount:0}};}
function endpointBody(){return {data:{id:model,architecture:{input_modalities:['text'],output_modalities:['text']},endpoints:[endpoint()]}};}
const candidate=()=>parseRoute(model,endpointBody(),2048,openRouterTextProfile);

test('model identities distinguish historic known OpenAI from versioned dynamic routes',()=>{
 for(const v of ['vendor/text-2026:variant','vendor/model_1+2','openai/gpt-4o-mini'])assert.ok(openRouterModelId(v));
 for(const v of ['auto','https://host/model','vendor/../model','vendor/model?x','vendor/a/b','vendor/model\n','vendor/😀','vendor/'+'x'.repeat(256)])assert.equal(openRouterModelId(v),false);
 assert.ok(openRouterProviderTag('compute/region-fp8'));for(const v of ['compute/../region','Compute One','compute/region\n'])assert.equal(openRouterProviderTag(v),false);
 const r=candidate();assert.ok(openRouterRouteIdentity(r));assert.equal(openRouterSavedProvider(r),'Compute One');
 assert.equal(openRouterSavedProvider({model:'openai/gpt-4o-mini'}),'OpenAI');assert.equal(openRouterRouteIdentity({model:'openai/gpt-4o-mini'}),false);
 for(const v of [{model},{...r,profile:undefined},{...r,profile:'future'},{...r,contextLength:0},{...r,promptPrice:undefined},{...r,promptCapacity:128001},{...r,providerName:'bad\n'},{model:'openai/gpt-4o-mini',tag:'other'}])assert.equal(openRouterSavedProvider(v),null);
 assert.equal(insightFilters(new URLSearchParams({from:'2026-10-01',to:'2026-10-02',model})).model,model);
});
test('catalog prices retain exact values and explicit unsupported billing/capability reasons',()=>{
 const row=modelCatalogRow(catalogRow());assert.equal(row.admission,'candidate');assert.equal(row.promptPrice,'0.0000001');assert.equal(row.requestPrice,'0.0000001');assert.equal(row.structuredOutput,true);
 for(const mutate of [(v:any)=>v.pricing.prompt='NaN',(v:any)=>v.pricing.prompt='-1',(v:any)=>v.pricing.request=null,(v:any)=>v.pricing.overrides=[],(v:any)=>v.pricing.input_cache_write='0.01',(v:any)=>v.pricing.web_search='1',(v:any)=>v.pricing.internal_reasoning='1',(v:any)=>v.pricing.unknown='0',(v:any)=>v.pricing.discount=0.1,(v:any)=>v.pricing.input_cache_read='1',(v:any)=>v.top_provider.max_completion_tokens=null,(v:any)=>v.architecture.output_modalities.push('image'),(v:any)=>v.supported_parameters.push('reasoning'),(v:any)=>v.reasoning={mandatory:true,default_enabled:true},(v:any)=>v.expiration_date='2020-01-01',(v:any)=>v.id='openrouter/auto']){const raw:any=catalogRow();mutate(raw);const out=modelCatalogRow(raw);assert.equal(out.admission,'unsupported');assert.ok(out.reason);}
 const free=catalogRow();free.pricing={prompt:'0',completion:'0',request:'0'};assert.match(modelCatalogRow(free).reason!,/zero-reservation/);
 const missing=catalogRow();delete (missing.pricing as any).request;assert.equal(modelCatalogRow(missing).requestPrice,'0');
 assert.throws(()=>modelCatalogRow({...catalogRow(),id:'vendor/../escape'}));assert.throws(()=>modelCatalogRow({...catalogRow(),name:'bad\ud800'}));
});
test('free catalog pagination is fixed, credential-free, bounded and replaced atomically',async()=>{
 assert.equal(cachedOpenRouterModels().status,'unavailable');const rows=[catalogRow(),...Array.from({length:500},(_,i)=>catalogRow('vendor/model-'+i))];let calls=0;
 const send:typeof fetch=async(url,init)=>{calls++;const u=new URL(String(url));assert.equal(u.origin,'https://openrouter.ai');assert.equal(u.pathname,'/api/v1/models');assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');assert.deepEqual(init?.headers,{accept:'application/json'});assert.equal(init?.method,undefined);assert.equal(init?.body,undefined);const offset=Number(u.searchParams.get('offset'));return Response.json({data:rows.slice(offset,offset+500),total_count:501,links:{next:offset===0?'/api/v1/models?offset=500&limit=500':null}});};
 const [first,second]=await Promise.all([refreshOpenRouterCatalog(send),refreshOpenRouterCatalog(send)]);assert.equal(calls,2);assert.equal(first.revision,second.revision);assert.equal(first.models.length,501);assert.equal(first.complete,true);
 const snapshot=JSON.stringify(first.models),revision=first.revision;first.models[0].name='mutated';assert.equal(JSON.stringify(cachedOpenRouterModels().models),snapshot);
 const failures:[string,()=>Response][]=[['broken',()=>new Response('{broken',{headers:{'content-type':'application/json'}})],['UTF8',()=>new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}})],['type',()=>new Response('{}',{headers:{'content-type':'text/html'}})],['page bound',()=>new Response(' '.repeat(2_097_153),{headers:{'content-type':'application/json'}})],['duplicate',()=>Response.json({data:[rows[0],rows[0]],total_count:2,links:{next:null}})],['capacity',()=>Response.json({data:[],total_count:2001,links:{next:null}})],['foreign link',()=>Response.json({data:rows.slice(0,500),total_count:501,links:{next:'https://elsewhere.invalid/api/v1/models?offset=500&limit=500'}})],['truncated',()=>Response.json({data:[rows[0]],total_count:2,links:{next:null}})]];
 for(const [label,response]of failures){await assert.rejects(refreshOpenRouterCatalog(async()=>response()),{status:502},label);const old=cachedOpenRouterModels();assert.equal(old.status,'stale');assert.equal(old.revision,revision);assert.equal(JSON.stringify(old.models),snapshot);}
 await assert.rejects(refreshOpenRouterCatalog((()=>{throw Error('synchronous fake outage');}) as typeof fetch),{status:502});
 await refreshOpenRouterCatalog(async()=>Response.json({data:[catalogRow()],total_count:1,links:{next:null}}));assert.equal(cachedOpenRouterModels().status,'fresh');
 assert.equal(cachedOpenRouterModels(Date.now()+openRouterCatalogLimits.ttlMs+1).status,'stale');
 await requireCatalogModels([model],async()=>{throw Error('fresh catalog must not fetch');},true);await assert.rejects(requireCatalogModels(['vendor/absent'],async()=>{throw Error('must not fetch');}),{status:409});
});
test('official latest aliases and space-padded display names cannot poison a complete native catalog',async()=>{
 const aliases=[catalogRow('~openai/gpt-sol-latest'),...Array.from({length:499},(_,i)=>catalogRow('~fixture/model-'+i+'-latest'))];
 const gemma={...catalogRow('google/gemma-4-26b-a4b-it'),canonical_slug:'google/gemma-4-26b-a4b-it-20260403',name:'Google: Gemma 4 26B A4B '};
 const tars={...catalogRow('bytedance/ui-tars-1.5-7b'),name:'ByteDance: UI-TARS 7B '};
 const rows=[...aliases,gemma,tars];let calls=0;
 const current=await refreshOpenRouterCatalog(async(url)=>{const offset=Number(new URL(String(url)).searchParams.get('offset'));assert.equal(offset,calls++*500);return Response.json({data:rows.slice(offset,offset+500),total_count:502,links:{next:offset===0?'/api/v1/models?output_modalities=text&offset=500&limit=500':null}});});
 assert.equal(calls,2);assert.equal(current.complete,true);assert.equal(current.models.length,2);
 assert.deepEqual(current.models.map(m=>m.name),['ByteDance: UI-TARS 7B','Google: Gemma 4 26B A4B']);
 assert.ok(current.models.every(m=>openRouterModelId(m.id)&&m.admission==='candidate'));
 assert.equal(openRouterModelId('~openai/gpt-sol-latest'),false);assert.equal(executionInput.safeParse({connectionId:id,promptId:id,versionId:id,systemText:'',models:['~openai/gpt-sol-latest'],maxCompletionTokens:16,fundedCredits:true}).success,false);
 await assert.rejects(requireCatalogModels(['~openai/gpt-sol-latest'],async()=>{throw Error('fresh catalog must not fetch');}),{status:409});
 const original=JSON.stringify(current.models),revision=current.revision;
 for(const data of [[aliases[0],aliases[0]],[{...aliases[0],canonical_slug:'~other/model-latest'}],[{...aliases[0],id:'~openai/not-a-latest-alias',canonical_slug:'~openai/not-a-latest-alias'}],[{...aliases[0],name:'bad\ud800'}],[{...gemma,name:'bad\n'}],[{...gemma,name:'   '}],[{...gemma,id:'google/../escape'}],[gemma,{...tars,name:'bad\u0000'}]]){
  await assert.rejects(refreshOpenRouterCatalog(async()=>Response.json({data,total_count:data.length,links:{next:null}})),{status:502});
  assert.equal(cachedOpenRouterModels().revision,revision);assert.equal(JSON.stringify(cachedOpenRouterModels().models),original);
 }
 await assert.rejects(refreshOpenRouterCatalog(async()=>Response.json({data:[aliases[0]],total_count:2,links:{next:null}})),{status:502});
 assert.equal(cachedOpenRouterModels().revision,revision);
 await refreshOpenRouterCatalog(async()=>Response.json({data:[catalogRow()],total_count:1,links:{next:null}}));
});
test('v2 routes choose a supported leaf by exact reservation and pin provider without changing legacy shape',()=>{
 const body=endpointBody();body.data.endpoints.push({...endpoint('compute'),pricing:{...endpoint().pricing,prompt:'0'}});body.data.endpoints.push({...endpoint('other/leaf','Other'),pricing:{...endpoint().pricing,prompt:'0.0000002'}});
 const route=parseRoute(model,body,2048,openRouterTextProfile);assert.equal(route.tag,'compute/region');assert.equal(route.estimateMicros,'13620');
 assert.equal(parseRoute(model,body,2048,openRouterTextProfile,false,'other/leaf').providerName,'Other');
 for(const mutate of [(v:any)=>v.data.endpoints[0].pricing.overrides=[],(v:any)=>v.data.endpoints[0].pricing.input_cache_write='1',(v:any)=>v.data.endpoints[0].max_completion_tokens=16,(v:any)=>v.data.endpoints[0].context_length=2048,(v:any)=>v.data.reasoning={mandatory:true,default_enabled:true}]){const broken:any=endpointBody();mutate(broken);assert.throws(()=>parseRoute(model,broken,2048,openRouterTextProfile));}
 assert.throws(()=>parseRoute(model,endpointBody(),2048));assert.throws(()=>parseRoute(model,body,2048,openRouterTextProfile,false,'absent'));
 const missing=endpointBody();missing.data.endpoints[0].supported_parameters=['max_tokens'];assert.throws(()=>parseRoute(model,missing,2048,openRouterTextProfile,true));
});
test('v2 endpoint architecture drift cannot authorize an image or unknown-output request',()=>{
 for(const architecture of [undefined,null,{}, {input_modalities:['image'],output_modalities:['image']},{input_modalities:['text'],output_modalities:['image']},{input_modalities:['text'],output_modalities:['text','image']},{input_modalities:['text'],output_modalities:[]},{input_modalities:'text',output_modalities:['text']}]){
  const data:any=endpointBody();data.data.architecture=architecture;
  assert.throws(()=>parseRoute(model,data,2048,openRouterTextProfile),JSON.stringify(architecture)??'missing architecture');
 }
 assert.equal(parseRoute(model,endpointBody(),2048,openRouterTextProfile).model,model);
});
test('v2 endpoint reasoning metadata must explicitly rule out unsupported billing',()=>{
 for(const reasoning of [true,'mandatory',[],{}, {mandatory:false},{mandatory:false,default_enabled:true}]){
  const data:any=endpointBody();data.data.reasoning=reasoning;
  assert.throws(()=>parseRoute(model,data,2048,openRouterTextProfile),JSON.stringify(reasoning));
 }
 const ordinary:any=endpointBody();ordinary.data.reasoning={mandatory:false,default_enabled:false};assert.equal(parseRoute(model,ordinary,2048,openRouterTextProfile).model,model);
});
test('new request profile disables compression, bounds UTF8 payload/output, and keeps legacy body exact',()=>{
 const route=candidate(),messages=[{role:'user' as const,content:'Explicit user text'}];const body=executionRequestBody(messages,route,2048,id,actor);
 assert.deepEqual(body.plugins,[{id:'context-compression',enabled:false}]);assert.equal(body.model,model);assert.equal('tools'in body,false);assert.equal(body.provider.allow_fallbacks,false);assert.deepEqual(body.provider.only,['compute/region']);
 const structured=executionRequestBody(messages,route,2048,id,actor,true);assert.equal(structured.response_format?.json_schema.strict,true);
 for(const content of ['😀'.repeat(9000),'bad\ud800','bad\0'])assert.throws(()=>executionRequestBody([{role:'user',content}],route,2048,id,actor));
 assert.throws(()=>executionRequestBody(messages,{...route,contextLength:2048},2048,id,actor));
 assert.throws(()=>executionRequestBody([{role:'user',content:'text',cache_control:{type:'ephemeral'}} as any],route,16,id,actor));
 assert.throws(()=>executionRequestBody([{role:'user',content:'one'},{role:'user',content:'two'}],route,16,id,actor));
 const overhead=Buffer.byteLength(JSON.stringify([{role:'user',content:''}]));assert.doesNotThrow(()=>executionRequestBody([{role:'user',content:'a'.repeat(32768-overhead)}],route,16,id,actor));assert.throws(()=>executionRequestBody([{role:'user',content:'a'.repeat(32769-overhead)}],route,16,id,actor));
 const legacy={...route,model:'openai/gpt-4o-mini',tag:'openai',providerName:'OpenAI',profile:undefined,contextLength:undefined};assert.equal('plugins'in executionBody(messages,legacy,2048,id,actor),false);
});
test('dynamic suggestion profile is explicit, schema-bound and cannot override legacy profiles',()=>{
 const input={requestId:randomUUID(),connectionId:randomUUID(),contextRevision:1,profileId:'catalog-text-schema-v1',model,benchmark:true,fundedCredits:true,topic:'Grinders',country:'UAE',language:'English',sectionKeys:[],competitorIds:[],excludedPrompts:[]};
 const parsed=suggestionQuoteInput.parse(input);assert.equal(suggestionModel(parsed),model);
 for(const patch of [{model:undefined},{profileId:'benchmark-mini-v1'},{benchmark:false},{maxSpendUsd:'0'},{maxSpendUsd:'0.1'},{tools:[]},{model:'auto'}])assert.equal(suggestionQuoteInput.safeParse({...input,...patch}).success,false);
 const legacy={...input,profileId:'benchmark-mini-v1'};delete (legacy as any).model;assert.equal(suggestionModel(suggestionQuoteInput.parse(legacy)),'openai/gpt-4o-mini');
 assert.ok(executionInput.safeParse({connectionId:input.connectionId,promptId:id,versionId:randomUUID(),systemText:'',models:[model],maxCompletionTokens:2048,fundedCredits:true}).success);
});
test('dynamic readiness rechecks selected leaf and exact provider costs survive invalid charged text',async()=>{
 let calls=0;const routes=await readOpenRouterRoutes({apiKey:'synthetic-never-live'},[model],2048,async(url,init)=>{calls++;assert.equal(init?.redirect,'error');if(String(url).endsWith('/key'))return Response.json({data:{is_free_tier:false,is_management_key:false}});assert.equal(String(url),'https://openrouter.ai/api/v1/models/vendor/text-standard/endpoints');return Response.json(endpointBody());},openRouterTextProfile,['compute/region']);assert.equal(calls,2);
 const now=new Date();const response=parseOpenRouterJson(JSON.stringify({id:'gen-dynamic',model,provider:'Compute One',created:Math.floor(now.getTime()/1000),usage:{is_byok:false,cost:0.000012345},choices:[{finish_reason:'stop',message:{content:'Observed answer'}}]}));
 const result=parseExecutionOutcome(response,200,null,routes[0],now);assert.equal(result.cost,'0.000013');assert.equal(result.result?.provider,'Compute One');response.choices[0].message.content={bad:true};const invalid=parseExecutionOutcome(response,200,null,routes[0],now);assert.equal(invalid.cost,'0.000013');assert.equal(invalid.result,null);
});
test('complete2000-model admission budgets both wrappers and candidate IDs before publishing, retaining the prior complete snapshot on refusal',async()=>{
 assert.equal(openRouterMetadataBytes,2_097_152);
 const rows=Array.from({length:2000},(_,i)=>({...catalogRow('fixture/model-'+String(i).padStart(4,'0')),name:'X'}));let calls=0;
 const send:typeof fetch=async(url,init)=>{const u=new URL(String(url));assert.equal(u.origin,'https://openrouter.ai');assert.equal(u.pathname,'/api/v1/models');assert.equal(u.searchParams.get('output_modalities'),'text');assert.equal(u.searchParams.get('limit'),'500');const offset=Number(u.searchParams.get('offset'));assert.ok([0,500,1000,1500].includes(offset));assert.deepEqual(init?.headers,{accept:'application/json'});assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');const body={data:rows.slice(offset,offset+500),total_count:2000,links:{next:offset===1500?null:`/api/v1/models?output_modalities=text&offset=${offset+500}&limit=500`}},wire=JSON.stringify(body);assert.ok(Buffer.byteLength(wire)<=openRouterCatalogLimits.pageBytes);calls++;return new Response(wire,{headers:{'content-type':'application/json'}});};
 const first=await refreshOpenRouterCatalog(send);assert.equal(calls,4);assert.equal(first.models.length,2000);assert.ok(first.models.every(m=>m.admission==='candidate'));const original=JSON.stringify(first.models),revision=first.revision;
 const envelopeBytes=Buffer.byteLength(JSON.stringify({role:'editor',catalog:first}))-Buffer.byteLength(JSON.stringify(first.models));
 for(const target of [openRouterMetadataBytes,openRouterMetadataBytes-envelopeBytes]){
  for(const row of rows)row.name='X';let remaining=target-Buffer.byteLength(JSON.stringify(rows.map(row=>modelCatalogRow(row))));assert.ok(remaining>0);
  for(const row of rows)while(row.name.length<256&&remaining){const char=remaining>=3?'界':'a';row.name+=char;remaining-=Buffer.byteLength(char);}assert.equal(remaining,0);
  const models=rows.map(row=>modelCatalogRow(row)),catalog={...first,models},native={role:'editor',catalog};assert.equal(Buffer.byteLength(JSON.stringify(models)),target);assert.ok(Buffer.byteLength(JSON.stringify({...native,models:models.map(m=>m.id)}))>openRouterMetadataBytes);
  if(target<openRouterMetadataBytes){assert.equal(Buffer.byteLength(JSON.stringify(native)),openRouterMetadataBytes);assert.equal(boundedOpenRouterMetadata(native),native);}
  const before:number=calls;await assert.rejects(refreshOpenRouterCatalog(send),{status:502});assert.equal(calls,before+4);const old=cachedOpenRouterModels();assert.equal(old.status,'stale');assert.equal(old.complete,true);assert.equal(old.models.length,2000);assert.equal(old.revision,revision);assert.equal(JSON.stringify(old.models),original);
 }
});
test('the complete execution metadata guard refuses variable bounded connection rows at413 without truncation',()=>{
 const catalog=cachedOpenRouterModels(),models=catalog.models.filter(m=>m.admission==='candidate').map(m=>m.id),connections=[{id:randomUUID(),name:'Synthetic',checkStatus:'ok'}];
 const body={role:'owner',models,catalog,vaultConfigured:true,spendingPaused:false,connections,comparisons:[],cache:{available:false},scheduling:{available:false}};
 assert.equal(boundedOpenRouterMetadata(body),body);
 const large={...body,connections:Array.from({length:6000},()=>({id:randomUUID(),name:'界'.repeat(120),checkStatus:'ok'}))};assert.ok(Buffer.byteLength(JSON.stringify(large))>openRouterMetadataBytes);const count=large.connections.length;
 assert.throws(()=>boundedOpenRouterMetadata(large),{status:413,message:'The model metadata exceeds the complete response limit.'});assert.equal(large.connections.length,count);assert.equal(large.catalog.models.length,2000);assert.equal(boundedOpenRouterMetadata(body),body);
});
