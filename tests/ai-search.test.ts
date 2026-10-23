import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {aiSearchProfileId,aiSearchEndpoints,aiSearchPayload,aiSearchPriceEvidence,aiSearchRequestSchema,aiSearchQuoteInput,aiSearchSnapshotSchema} from '../src/lib/ai-search.ts';
import {parseAiSearchCountries,parseAiSearchLanguages,assertAiSearchMarket,parseAiSearchAccount,parseAiSearchOutcome,requestAiSearch,parseAiSearchReconciliation} from '../src/server/dataforseo-ai-search.ts';
import {dataforseoJson,dataforseoRefusalMessage} from '../src/server/dataforseo-transport.ts';
import {deriveSearchQueries,normalizeDfsChatgptSearchEvidence,readSearchEvidence} from '../src/server/ai-search-evidence.ts';
import {canonicalHash} from '../src/server/context-input.ts';
import {initializeProviderAccountIdentity} from '../src/server/provider-account-identity.ts';
import {providerTransaction} from '../src/server/providers.ts';
import {dispatchSpend} from '../src/server/spending.ts';
import {getDatabase,closeDatabase} from '../src/server/db.ts';
import type {PoolClient} from 'pg';

const id=randomUUID(),reference=randomUUID(),request={profileId:aiSearchProfileId,capturedPrompt:'Best C++ %20 shoes',locationCode:2840,languageCode:'en'},now=new Date('2026-10-15T09:00:00Z');
const credentials={login:'synthetic@example.invalid',password:'synthetic-only'};
const path=(url:string)=>new URL(url).pathname.slice(1).split('/');
function response(result:unknown={keyword:request.capturedPrompt,location_code:2840,language_code:'en',model:'reported-consumer-model',datetime:'2026-10-15 08:59:00 +00:00',markdown:'Acme makes shoes.',fan_out_queries:['red shoes','red shoes',' blue shoes ']}){return {httpStatus:200,body:{status_code:20000,cost:0.004,tasks_count:1,tasks_error:0,tasks:[{id:reference as string,status_code:20000,cost:0.004,path:path(aiSearchEndpoints.live),data:aiSearchPayload(request,id),result_count:1,result:[result]}]}};}
function free(url:string,rows:unknown[]){return {httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks_error:0,tasks:[{id:reference,status_code:20000,cost:0,path:path(url),result_count:rows.length,result:rows}]}};}
const copy=<T>(v:T):T=>structuredClone(v);
function body(value:unknown){return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});}

test('closed fixed profile and published tariff are estimates with no account-price claim',()=>{
 const price=aiSearchPriceEvidence();assert.deepEqual(price,{version:'dfs-chatgpt-live-published-2026-10-15-v1',profileId:aiSearchProfileId,mode:'published-tariff',sourceUrl:'https://dataforseo.com/pricing/ai-optimization/llm-scraper',checkedOn:'2026-10-15',billingUnit:'result',maximumResults:1,unitMicros:'4000',estimateMicros:'4000',estimateUsd:'0.004000',limitation:'Published-price estimate; not an account-enforced maximum.'});
 price.estimateUsd='9';assert.equal(aiSearchPriceEvidence().estimateUsd,'0.004000');
 for(const changed of [{...request,model:'gpt-4o'},{...request,profileId:'llm-responses'},{...request,capturedPrompt:''},{...request,capturedPrompt:' \t'},{...request,capturedPrompt:'bad\ud800'},{...request,capturedPrompt:'bad\ntext'},{...request,languageCode:'en\n'},{...request,locationCode:0}])assert.equal(aiSearchRequestSchema.safeParse(changed).success,false);
 assert.equal(aiSearchRequestSchema.safeParse({...request,capturedPrompt:'😀'.repeat(1000)}).success,true);
 assert.equal(aiSearchRequestSchema.safeParse({...request,capturedPrompt:'a'.repeat(2000)}).success,true);
 assert.equal(aiSearchRequestSchema.safeParse({...request,capturedPrompt:'a'.repeat(2001)}).success,false);
 assert.equal(aiSearchRequestSchema.safeParse({...request,capturedPrompt:'%'.repeat(666)+'ab'}).success,true);
 assert.equal(aiSearchRequestSchema.safeParse({...request,capturedPrompt:'%'.repeat(667)}).success,false);
});
test('quotes carry no estimate-admission ceiling (D3) while stored legacy snapshots keep theirs and their hash',()=>{
 const quote={requestId:randomUUID(),connectionId:randomUUID(),promptId:randomUUID(),versionId:randomUUID(),locationCode:2840,languageCode:'en',expectedCatalogRevision:'a'.repeat(64),acceptPublishedEstimate:true};
 assert.equal(aiSearchQuoteInput.safeParse(quote).success,true);for(const maxSpendUsd of ['0.004000','1','0'])assert.equal(aiSearchQuoteInput.safeParse({...quote,maxSpendUsd}).success,false);
 const current={version:1,request,promptId:randomUUID(),versionId:randomUUID(),country:{code:2840,name:'United States',countryCode:'US'},language:{code:'en',name:'English'},catalogRevision:'a'.repeat(64),countriesHash:'b'.repeat(64),languagesHash:'c'.repeat(64),preparedAt:now.toISOString(),price:aiSearchPriceEvidence()},legacy={...current,maxSpendUsd:'0.004000'};
 for(const stored of [current,legacy]){const parsed=aiSearchSnapshotSchema.parse(copy(stored));assert.deepEqual(parsed,stored);assert.equal(canonicalHash(parsed),canonicalHash(stored));}
 assert.equal(Object.hasOwn(aiSearchSnapshotSchema.parse(copy(current)),'maxSpendUsd'),false);assert.notEqual(canonicalHash(current),canonicalHash(legacy));
 for(const maxSpendUsd of ['1\n','-1','0.0000001'])assert.equal(aiSearchSnapshotSchema.safeParse({...legacy,maxSpendUsd}).success,false);assert.equal(aiSearchSnapshotSchema.safeParse({...current,extra:true}).success,false);
});
test('one exact immutable payload escapes literal percent/plus once, with own run tag',()=>{
 assert.deepEqual(aiSearchPayload(request,id),{keyword:'Best C%2B%2B %2520 shoes',location_code:2840,language_code:'en',force_web_search:true,tag:'ten98:ai-search:'+id});
 assert.equal(aiSearchPayload({...request,capturedPrompt:'%2B + %25'},id).keyword,'%252B %2B %2525');
 assert.throws(()=>aiSearchPayload(request,id+'\n'));assert.throws(()=>aiSearchPayload({...request,extra:true},id));assert.equal(request.capturedPrompt,'Best C++ %20 shoes');
});
test('product-specific free catalogs are typed, complete before country projection, and market bound',()=>{
 const countries=free(aiSearchEndpoints.locations,[{location_code:2840,location_name:'United States',location_type:'Country',country_iso_code:'US'},{location_code:100,location_name:'A city',location_type:'City',country_iso_code:'US'}]);
 const languages=free(aiSearchEndpoints.languages,[{language_code:'en',language_name:'English'}]);
 assert.deepEqual(parseAiSearchCountries(countries),[{code:2840,name:'United States',countryCode:'US'}]);assert.deepEqual(parseAiSearchLanguages(languages),[{code:'en',name:'English'}]);
 assert.deepEqual(assertAiSearchMarket(request,parseAiSearchCountries(countries),parseAiSearchLanguages(languages)),request);
 assert.throws(()=>assertAiSearchMarket({...request,locationCode:1},parseAiSearchCountries(countries),parseAiSearchLanguages(languages)));
 for(const bad of [free(aiSearchEndpoints.locations,[]),free(aiSearchEndpoints.languages,countries.body.tasks[0].result),free(aiSearchEndpoints.locations,[...countries.body.tasks[0].result,countries.body.tasks[0].result[0]]),free(aiSearchEndpoints.locations,[{location_code:2840,location_name:'US',location_type:'Country',country_iso_code:'us'}])])assert.throws(()=>parseAiSearchCountries(bad));
 assert.throws(()=>parseAiSearchLanguages(free(aiSearchEndpoints.languages,[{language_code:'en',language_name:'English'},{language_code:'en',language_name:'Other'}])));
 const inherited=free(aiSearchEndpoints.languages,[Object.create({language_code:'en',language_name:'English'})]);assert.throws(()=>parseAiSearchLanguages(inherited));
 const malformed=copy(countries);malformed.body.tasks[0].result_count=1;assert.throws(()=>parseAiSearchCountries(malformed));
});
test('authentic AI language region and script codes stay exact across catalog, quote, snapshot and payload',()=>{
 // Literal public language rows observed 2026-10-19; neither code may poison the complete catalog.
 const rows=[{language_name:'English',language_code:'en'},{language_name:'Espanol (Latinoamerica)',language_code:'es-419'},{language_name:'Serbian (Latin)',language_code:'sr-Latn'}];
 const languages=parseAiSearchLanguages(free(aiSearchEndpoints.languages,rows));assert.deepEqual(languages.map(r=>r.code),['en','es-419','sr-Latn']);
 for(const language of languages){
  const selected=assertAiSearchMarket({...request,languageCode:language.code},[{code:2840,name:'United States',countryCode:'US'}],languages);
  assert.equal(aiSearchPayload(selected,id).language_code,language.code);
  assert.equal(aiSearchQuoteInput.parse({requestId:id,connectionId:id,promptId:id,versionId:id,locationCode:2840,languageCode:language.code,expectedCatalogRevision:'a'.repeat(64),acceptPublishedEstimate:true}).languageCode,language.code);
  const snapshot=aiSearchSnapshotSchema.parse({version:1,request:selected,promptId:id,versionId:id,country:{code:2840,name:'United States',countryCode:'US'},language,catalogRevision:'a'.repeat(64),countriesHash:'b'.repeat(64),languagesHash:'c'.repeat(64),preparedAt:now.toISOString(),price:aiSearchPriceEvidence()});assert.equal(snapshot.language.code,language.code);
 }
 for(const language_code of ['es-419\n','sr-latn','es-41','es-419-extra','en_US','EN',3,null])assert.throws(()=>parseAiSearchLanguages(free(aiSearchEndpoints.languages,[...rows,{language_name:'Invalid',language_code}])));
 assert.throws(()=>parseAiSearchLanguages(free(aiSearchEndpoints.languages,[...rows,rows[2]])));
});
test('reuses project-independent keyed v2 account identity, never interprets a price tree',()=>{
 const account=free('https://api.dataforseo.com/v3/appendix/user_data',[{login:'Test@Example.invalid',price:{unexpected:{value:'untrusted'}}}]);
 const a=parseAiSearchAccount(account,{key:'a'.repeat(32),version:2}),b=parseAiSearchAccount(account,{key:'b'.repeat(32),version:2});
 assert.match(a.fingerprint,/^[a-f0-9]{64}$/);assert.notEqual(a.fingerprint,b.fingerprint);assert.deepEqual(Object.keys(a),['fingerprint']);assert.equal(JSON.stringify(a).includes('Test@'),false);
 assert.throws(()=>parseAiSearchAccount(account,{key:'short',version:2}));const paid=copy(account);paid.body.cost=1;assert.throws(()=>parseAiSearchAccount(paid,{key:'a'.repeat(32),version:2}));
 assert.throws(()=>parseAiSearchAccount(free('https://api.dataforseo.com/v3/appendix/user_data',[Object.create({login:'inherited@example.invalid'})]),{key:'a'.repeat(32),version:2}));
});
test('admitted exact envelope wires the existing leaf and immutable prompt derivation without new citations',()=>{
 const raw=response(),outcome=parseAiSearchOutcome(raw,request,id,now);assert.deepEqual(outcome.charge,{state:'known',costUsd:'0.004000',providerTaskId:reference});assert.equal(outcome.content.state,'available');
 if(outcome.content.state!=='available')throw Error();const result=outcome.content.value;
 assert.equal(result.source,'DataForSEO / ChatGPT consumer interface');assert.equal(result.reportedModel,'reported-consumer-model');assert.equal(result.providerObservedAt,'2026-10-15T08:59:00.000Z');
 assert.deepEqual(result.evidence,normalizeDfsChatgptSearchEvidence(raw.body.tasks[0].result[0]));
 const derived=deriveSearchQueries({evidence:result.evidence,capturedPrompt:result.capturedPrompt,subjects:[{id:'brand',name:'Acme',aliases:[],domains:[]}],method:'unicode-boundary-v1'});
 assert.equal(derived.queries?.length,2);assert.deepEqual(derived.queries?.[0].indexes,[0,1]);assert.equal(derived.answerMentions?.[0].mentioned,true);assert.equal(derived.websiteContentCoverage.state,'unavailable');
 assert.equal(Object.hasOwn(result,'citations'),false);assert.equal(Object.hasOwn(result,'search_results'),false);assert.deepEqual(raw,response());
});
test('missing, empty and malformed query/answer fields remain independent after real envelope admission',()=>{
 const metadata={keyword:request.capturedPrompt,location_code:2840,language_code:'en'};
 for(const [fields,state,answerState] of [[{markdown:'Acme',fan_out_queries:[]},'reported_empty','available'],[{markdown:'Acme'},'not_recorded','available'],[{markdown:'Acme',fan_out_queries:[3]},'invalid','available'],[{markdown:4,fan_out_queries:['Acme']},'reported','invalid'],[{markdown:' ',fan_out_queries:['Acme']},'reported','empty'],[{fan_out_queries:['query']},'reported','not_recorded']] as const){
  const out=parseAiSearchOutcome(response({...metadata,...fields}),request,id,now);assert.equal(out.content.state,'available');if(out.content.state==='available'){assert.equal(out.content.value.evidence.queries.state,state);assert.equal(out.content.value.evidence.answer.state,answerState);}
 }
 const out=parseAiSearchOutcome(response({...metadata,markdown:'Different company',fan_out_queries:['Acme'],sources:[{url:'https://example.invalid/?q=fake'}],search_results:[{query:'invented'}],followups:['invented']}),request,id,now);
 if(out.content.state!=='available')throw Error();const d=deriveSearchQueries({evidence:out.content.value.evidence,capturedPrompt:request.capturedPrompt,subjects:[{id:'brand',name:'Acme',aliases:[],domains:[]}],method:'unicode-boundary-v1'});assert.equal(d.answerMentions?.[0].mentioned,false);assert.deepEqual(d.queries?.map(q=>q.key),['acme']);
});
test('dedicated leaf capacity and markdown fallback positives survive admitted provider projection',()=>{
 const metadata={keyword:request.capturedPrompt,location_code:2840,language_code:'en'};
 const cases=[{...metadata,markdown:'x'.repeat(250000),fan_out_queries:Array(100).fill('😀'.repeat(2000))},{...metadata,markdown:' ',items:Array.from({length:1000},()=>({markdown:' block '})),fan_out_queries:['']},{...metadata,markdown:null,items:[{markdown:' first '},{markdown:' second '}],fan_out_queries:null}];
 for(const input of cases){const out=parseAiSearchOutcome(response(input),request,id,now);assert.equal(out.charge.state,'known');assert.equal(out.content.state,'available');if(out.content.state==='available')assert.deepEqual(out.content.value.evidence,normalizeDfsChatgptSearchEvidence(input));}
 const fallback=parseAiSearchOutcome(response(cases[2]),request,id,now);if(fallback.content.state!=='available')throw Error();assert.deepEqual(fallback.content.value.evidence.answer,{state:'available',text:'first\n\nsecond',basis:'items'});
});
test('financial admission requires own identity/path/task/payload/final status and equal exact costs',()=>{
 for(const mutate of [(r:ReturnType<typeof response>)=>r.httpStatus=500,(r:ReturnType<typeof response>)=>r.body.tasks_count=2,(r:ReturnType<typeof response>)=>r.body.tasks_error=1,(r:ReturnType<typeof response>)=>r.body.tasks[0].id='not-an-id',(r:ReturnType<typeof response>)=>r.body.tasks[0].path[2]='gemini',(r:ReturnType<typeof response>)=>r.body.tasks[0].data.tag+='foreign',(r:ReturnType<typeof response>)=>r.body.tasks[0].data.keyword='changed',(r:ReturnType<typeof response>)=>r.body.tasks[0].status_code=20100,(r:ReturnType<typeof response>)=>r.body.cost=0.005,(r:ReturnType<typeof response>)=>r.body.cost=0.0000001]){
  const raw=response();mutate(raw);const result=parseAiSearchOutcome(raw,request,id,now);assert.equal(result.charge.state,'unknown');assert.equal(result.content.state,'unavailable');
 }
 const inherited=response();inherited.body.tasks[0].data=Object.create(aiSearchPayload(request,id));assert.equal(parseAiSearchOutcome(inherited,request,id,now).charge.state,'unknown');
 const missing=copy(response()) as any;delete missing.body.cost;assert.equal(parseAiSearchOutcome(missing,request,id,now).charge.state,'unknown');
 const sparse=response() as any;sparse.body.tasks=new Array(1);assert.equal(parseAiSearchOutcome(sparse,request,id,now).charge.state,'unknown');
});
test('echoed request admits only exact requested fields and documented harmless consumer defaults',()=>{
 const accepted=response() as any;Object.assign(accepted.body.tasks[0].data,{api:'ai_optimization',function:'llm_scraper',se:'chat_gpt',postback_data:'advanced',device:'desktop',os:'windows'});
 assert.equal(parseAiSearchOutcome(accepted,request,id,now).charge.state,'known');
 for(const extra of [{api:'serp'},{function:'llm_responses'},{device:'mobile'},{postback_data:'html'},{postback_data:'advanced\n'},{postback_data:null},{postback_url:'https://example.invalid/callback'},{model_name:'other-model'},{max_output_tokens:100000},{priority:2},{web_search:true}]){const raw=response() as any;Object.assign(raw.body.tasks[0].data,extra);assert.equal(parseAiSearchOutcome(raw,request,id,now).charge.state,'unknown');}
});
test('authentic advanced receipt format echo is admitted by exact request and retained receipt recovery',()=>{
 // Observed free ID-list wire fields 2026-10-19; synthetic prompt and UUIDs. The original paid body was not retained.
 const runId='00000000-0000-4000-8000-000000000001',taskId='00000000-0000-4000-8000-000000000002',prompt='What services does Example Ltd offer in Dubai?';
 const selected={profileId:aiSearchProfileId,capturedPrompt:prompt,locationCode:2784,languageCode:'en'};
 const captured={httpStatus:200,body:{status_code:20000,tasks_count:1,tasks_error:0,cost:0,tasks:[{id:'00000000-0000-4000-8000-000000000003',status_code:20000,path:['v3','ai_optimization','id_list'],cost:0,result_count:1,data:{api:'ai_optimization',function:'id_list',datetime_from:'2026-10-19 12:00:37 +00:00',datetime_to:'2026-10-19 12:04:07 +00:00',limit:1000,offset:0,sort:'asc',include_metadata:true},result:[{id:taskId,url:'v3/ai_optimization/chat_gpt/llm_scraper/live/advanced',datetime_posted:'2026-10-19 12:01:37 +00:00',datetime_done:'2026-10-19 12:02:02 +00:00',status:20000,cost:0.004,metadata:{api:'ai_optimization',function:'llm_scraper',se:'chat_gpt',keyword:prompt,location_code:2784,language_code:'en',force_web_search:true,tag:'ten98:ai-search:00000000-0000-4000-8000-000000000001',postback_data:'advanced',device:'desktop',os:'windows'}}]}]}};
 const binding={profileId:aiSearchProfileId,runId,payloadHash:canonicalHash({keyword:prompt,location_code:2784,language_code:'en',force_web_search:true,tag:'ten98:ai-search:00000000-0000-4000-8000-000000000001'}),dispatchedAt:'2026-10-19T12:01:37.135Z',asOf:'2026-10-19T12:04:07.203Z',providerTaskId:null};
 const expected={providerTaskId:taskId,costUsd:'0.004000',statusCode:20000};
 assert.deepEqual(parseAiSearchReconciliation(captured,selected,runId),expected);assert.deepEqual(parseAiSearchReconciliation(captured,binding),expected);
 for(const patch of [{postback_data:'html'},{postback_data:'advanced\n'},{postback_data:null},{postback_url:'https://example.invalid/callback'},{priority:2},{force_web_search:false},{language_code:'fr'},{location_code:2840},{tag:'foreign'}]){const bad=copy(captured);Object.assign(bad.body.tasks[0].result[0].metadata,patch);assert.throws(()=>parseAiSearchReconciliation(bad,selected,runId));assert.throws(()=>parseAiSearchReconciliation(bad,binding));}
 const duplicated=copy(captured);duplicated.body.tasks[0].result.push(copy(duplicated.body.tasks[0].result[0]));duplicated.body.tasks[0].result_count=2;assert.throws(()=>parseAiSearchReconciliation(duplicated,binding));
 const charged=copy(captured);charged.body.cost=0.004;assert.throws(()=>parseAiSearchReconciliation(charged,binding));
});

test('known charge survives invalid content, final paid error, capacity and decoded-echo mismatch',()=>{
 for(const result of [{keyword:'changed',location_code:2840,language_code:'en'},{keyword:request.capturedPrompt,location_code:1,language_code:'en'},{keyword:request.capturedPrompt,location_code:2840,language_code:'en',markdown:'x'.repeat(250001)},{keyword:request.capturedPrompt,location_code:2840,language_code:'en',fan_out_queries:Array(101).fill('query')}]){
  const out=parseAiSearchOutcome(response(result),request,id,now);assert.equal(out.charge.state,'known');assert.deepEqual(out.content,{state:'unavailable',reason:'content_invalid'});
 }
 const bad=response();bad.body.tasks[0].result_count=2;assert.equal(parseAiSearchOutcome(bad,request,id,now).content.state,'unavailable');
 const failed=response() as any;failed.body.tasks_error=1;failed.body.tasks[0].status_code=40501;failed.body.tasks[0].result=null;failed.body.tasks[0].result_count=0;
 assert.deepEqual(parseAiSearchOutcome(failed,request,id,now).content,{state:'unavailable',reason:'provider_error'});assert.equal(parseAiSearchOutcome(failed,request,id,now).charge.state,'known');
 const overrun=response();overrun.body.cost=overrun.body.tasks[0].cost=0.008;const out=parseAiSearchOutcome(overrun,request,id,now);assert.deepEqual(out.charge,{state:'known',costUsd:'0.008000',providerTaskId:reference});
});
test('a zero-cost wallet refusal is a known $0 charge with no provider task and the fixed text; a charged or other refusal stays unknown (D3)',async()=>{
 const out=parseAiSearchOutcome({httpStatus:200,body:{status_code:40200,status_message:'Payment Required.',cost:0,tasks_count:0,tasks_error:0,tasks:null}},request,id,now);
 assert.deepEqual(out,{charge:{state:'known',costUsd:'0.000000',providerTaskId:null},content:{state:'unavailable',reason:'provider_error'},diagnostic:dataforseoRefusalMessage.payment,
  evidence:{httpStatus:200,statusCode:40200,taskStatus:null,totalCostUsd:'0.000000',taskCostUsd:null}});
 const task=parseAiSearchOutcome({httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks_error:1,tasks:[{id:reference,status_code:40203,cost:0,result:null}]}},request,id,now);
 assert.deepEqual(task.charge,{state:'known',costUsd:'0.000000',providerTaskId:null});assert.equal(task.diagnostic,dataforseoRefusalMessage.cost_limit);assert.deepEqual(task.evidence,{httpStatus:200,statusCode:20000,taskStatus:40203,totalCostUsd:'0.000000',taskCostUsd:'0.000000'});
 for(const body of [{status_code:40200,cost:0.004,tasks:null},{status_code:40200,tasks:null},{status_code:40204,cost:0,tasks:null},{status_code:40201,cost:0,tasks:null}]){
  const unknown=parseAiSearchOutcome({httpStatus:200,body},request,id,now);assert.equal(unknown.charge.state,'unknown',JSON.stringify(body));assert.equal(unknown.diagnostic,undefined);
 }
 let sends=0;const sent=await requestAiSearch(credentials,request,id,(async()=>{sends++;return new Response(JSON.stringify({status_code:40210,cost:0,tasks:null}),{status:402,headers:{'content-type':'application/json'}});}) as typeof fetch);
 assert.deepEqual(sent.charge,{state:'known',costUsd:'0.000000',providerTaskId:null});assert.equal(sent.diagnostic,dataforseoRefusalMessage.payment);assert.equal(sent.evidence.httpStatus,402);assert.equal(sends,1);
});
test('untrusted provider timestamps/models stay unknown, not current defaults or invalid calendar dates',()=>{
 const input={keyword:request.capturedPrompt,location_code:2840,language_code:'en',model:{name:'fake'},datetime:'2026-02-30 10:00:00 +00:00',markdown:'Answer'};
 const out=parseAiSearchOutcome(response(input),request,id,now);assert.equal(out.content.state,'available');if(out.content.state==='available'){assert.equal(out.content.value.providerObservedAt,null);assert.equal(out.content.value.reportedModel,null);assert.equal(out.content.value.receivedAt,now.toISOString());}
});
test('reconciliation uniquely binds own tag/payload/endpoint and never repairs answer evidence',()=>{
 const row={id:reference,status:'20000',cost:0.004,url:path(aiSearchEndpoints.live).join('/'),metadata:aiSearchPayload(request,id)};
 assert.deepEqual(parseAiSearchReconciliation(free(aiSearchEndpoints.reconciliation,[row]),request,id),{providerTaskId:reference,costUsd:'0.004000',statusCode:20000});
 assert.deepEqual(parseAiSearchReconciliation(free(aiSearchEndpoints.reconciliation,[{...row,status:20000}]),request,id),{providerTaskId:reference,costUsd:'0.004000',statusCode:20000});
 for(const status of [20000.1,20100,50000,NaN,Infinity,null,true,['20000'],'20000\n',' 20000','2e4'])assert.throws(()=>parseAiSearchReconciliation(free(aiSearchEndpoints.reconciliation,[{...row,status}]),request,id));
 for(const rows of [[],[row,row],[{...row,metadata:{...row.metadata,tag:'foreign'}}],[{...row,status:'20100'}],[{...row,cost:-1}],[{...row,url:'v3/serp/google/organic/live/advanced'}]])assert.throws(()=>parseAiSearchReconciliation(free(aiSearchEndpoints.reconciliation,rows),request,id));
 assert.throws(()=>parseAiSearchReconciliation(free(aiSearchEndpoints.reconciliation,Array.from({length:1000},(_,i)=>({...row,id:i===0?reference:randomUUID()}))),request,id));
});
test('fake send is explicit, exactly once, fixed route/body and no automatic retry on unknown transport',async()=>{
 const seen:{url:string;options:RequestInit}[]=[];
 const send=(async(url,options)=>{seen.push({url:String(url),options:options!});return body(response().body);}) as typeof fetch;
 const out=await requestAiSearch(credentials,request,id,send);assert.equal(out.charge.state,'known');assert.equal(seen.length,1);assert.equal(seen[0].url,aiSearchEndpoints.live);assert.deepEqual(JSON.parse(seen[0].options.body as string),[aiSearchPayload(request,id)]);assert.equal(seen[0].options.redirect,'error');assert.equal(seen[0].options.credentials,'omit');assert.equal(new Headers(seen[0].options.headers).get('accept-encoding'),'identity');
 let failed=0;const failure=(async()=>{failed++;throw new Error('synthetic transport failure');}) as typeof fetch;assert.deepEqual((await requestAiSearch(credentials,request,id,failure)).content,{state:'unavailable',reason:'transport_unverified'});assert.equal(failed,1);
 await assert.rejects(requestAiSearch(credentials,request,id,undefined as unknown as typeof fetch));
});
test('fixed transport rejects unknown AI products/paths/queries/methods before send; original routes work',async()=>{
 let calls=0;const send=(async()=>{calls++;return body({ok:true});}) as typeof fetch;
 for(const url of [aiSearchEndpoints.live+'?x=1',aiSearchEndpoints.live+'/',aiSearchEndpoints.live.replace('api.dataforseo.com','example.invalid'),aiSearchEndpoints.live.replace('chat_gpt','gemini'),aiSearchEndpoints.live.replace('llm_scraper','llm_responses'),aiSearchEndpoints.locations+'/us'])await assert.rejects(dataforseoJson(url,credentials,'POST',[{}],send));
 await assert.rejects(dataforseoJson(aiSearchEndpoints.live,credentials,'GET',undefined,send));assert.equal(calls,0);
 for(const url of [aiSearchEndpoints.locations,aiSearchEndpoints.languages])assert.deepEqual((await dataforseoJson(url,credentials,'GET',undefined,send)).body,{ok:true});
 await dataforseoJson('https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live',credentials,'POST',{value:'a'.repeat(40000)},send);assert.equal(calls,3);
 await assert.rejects(dataforseoJson(aiSearchEndpoints.live,credentials,'POST',{value:'a'.repeat(32768)},send));assert.equal(calls,3);
 await dataforseoJson(aiSearchEndpoints.live,credentials,'POST',{x:'a'.repeat(32760)},send);assert.equal(calls,4);
 await assert.rejects(dataforseoJson(aiSearchEndpoints.live,credentials,'POST',{x:'a'.repeat(32761)},send));assert.equal(calls,4);
});
test('new transport validates complete UTF8, exact identity length, stream errors, redirects and byte ceilings',async()=>{
 const invoke=(send:typeof fetch)=>dataforseoJson(aiSearchEndpoints.live,credentials,'POST',[aiSearchPayload(request,id)],send);
 const broken=[()=>new Response(new Uint8Array([0xc3,0x28])),()=>new Response('{"ok":true}',{headers:{'content-length':'12'}}),()=>new Response('{}',{headers:{'content-encoding':'gzip'}}),()=>new Response('{}',{status:302}),()=>new Response('{"open":'),()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{}'));c.error(new Error('synthetic stream failure'));}})),()=>new Response('"'+'a'.repeat(4_194_304)+'"'),()=>new Response('{}',{headers:{'content-length':'4194305'}})];
 for(const make of broken)await assert.rejects(invoke((async()=>make()) as typeof fetch));
 const valid=new TextEncoder().encode(JSON.stringify({text:'😀'}));assert.deepEqual((await invoke((async()=>new Response(new ReadableStream({start(c){c.enqueue(valid.subarray(0,10));c.enqueue(valid.subarray(10));c.close();}}),{headers:{'content-length':String(valid.length),'content-encoding':'identity'}})) as typeof fetch)).body,{text:'😀'});
 let cancelled=false;await assert.rejects(invoke((async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(4_194_305));},cancel(){cancelled=true;}}))) as typeof fetch));assert.equal(cancelled,true);
 assert.equal(((await invoke((async()=>new Response('"'+'a'.repeat(4_194_302)+'"')) as typeof fetch)).body as string).length,4_194_302);
});
test('catalog limits and free-envelope failures are closed rather than silently truncating',()=>{
 const languages=Array.from({length:1000},(_,i)=>({language_code:String.fromCharCode(97+Math.floor(i/676),97+Math.floor(i/26)%26,97+i%26),language_name:'Language '+i}));
 assert.equal(parseAiSearchLanguages(free(aiSearchEndpoints.languages,languages)).length,1000);assert.throws(()=>parseAiSearchLanguages(free(aiSearchEndpoints.languages,[...languages,{language_code:'zzz',language_name:'Extra'}])));
 const countries=Array.from({length:301},(_,i)=>({location_code:i+1,location_name:'Country '+i,location_type:'Country',country_iso_code:String.fromCharCode(65+Math.floor(i/26),65+i%26)}));assert.throws(()=>parseAiSearchCountries(free(aiSearchEndpoints.locations,countries)));
 const sparse=new Array(250001);assert.throws(()=>parseAiSearchCountries(free(aiSearchEndpoints.locations,sparse)));
 for(const change of ['tasks','cost','path','count']){const raw=free(aiSearchEndpoints.languages,[languages[0]]) as any;if(change==='tasks')raw.body.tasks_count=2;if(change==='cost')raw.body.tasks[0].cost=0.004;if(change==='path')raw.body.tasks[0].path.push('unexpected');if(change==='count')raw.body.tasks[0].result_count=2;assert.throws(()=>parseAiSearchLanguages(raw));}
});
test('retained receipt proves charge after raw prompt purge only with complete exact dispatch-window evidence',()=>{
 const binding={profileId:aiSearchProfileId,runId:id,payloadHash:canonicalHash(aiSearchPayload(request,id)),dispatchedAt:'2026-10-15T08:57:00.000Z',asOf:'2026-10-15T09:00:00.000Z',providerTaskId:reference};
 const row={id:reference,status:'20000',cost:0.004,url:path(aiSearchEndpoints.live).join('/'),metadata:aiSearchPayload(request,id),datetime_posted:'2026-10-15 08:57:00 +00:00'};
 function page(rows:unknown[]=[row]){const raw=free(aiSearchEndpoints.reconciliation,rows) as any;raw.body.tasks[0].data={api:'ai_optimization',function:'id_list',datetime_from:'2026-10-15 08:56:00 +00:00',datetime_to:'2026-10-15 08:59:30 +00:00',limit:1000,offset:0,sort:'asc',include_metadata:true};return raw;}
 const parse=parseAiSearchReconciliation as unknown as (response:unknown,binding:unknown)=>unknown;
 assert.deepEqual(parse(page(),binding),{providerTaskId:reference,costUsd:'0.004000',statusCode:20000});
 assert.deepEqual(parse(page([{...row,status:20000}]),binding),{providerTaskId:reference,costUsd:'0.004000',statusCode:20000});
 for(const patch of [{profileId:'other'},{payloadHash:'0'.repeat(64)},{providerTaskId:randomUUID()},{asOf:'2026-10-15T08:59:29.999Z'},{dispatchedAt:'2026-09-01T08:57:00.000Z'},{rawPrompt:request.capturedPrompt}])assert.throws(()=>parse(page(),{...binding,...patch}));
 for(const rows of [[row,row],[{...row,metadata:{...row.metadata,max_output_tokens:100000}}],[row,{...row,metadata:{...row.metadata,keyword:'different'}}],[{...row,datetime_posted:'2026-10-15 08:55:59 +00:00'}],[{...row,datetime_posted:'2026-10-15 08:59:31 +00:00'}],[{...row,datetime_posted:'2026-02-30 08:57:00 +00:00'}]])assert.throws(()=>parse(page(rows),binding));
 for(const patch of [{offset:1000},{limit:1},{include_metadata:false},{datetime_to:'2026-10-15 08:59:00 +00:00'},{priority:2}]){const raw=page();Object.assign(raw.body.tasks[0].data,patch);assert.throws(()=>parse(raw,binding));}
 const defaults=page();Object.assign(defaults.body.tasks[0].result[0].metadata,{api:'ai_optimization',function:'llm_scraper',se:'chat_gpt',device:'desktop',os:'windows'});assert.deepEqual(parse(defaults,binding),{providerTaskId:reference,costUsd:'0.004000',statusCode:20000});
 assert.equal(Object.hasOwn(parse(page(),binding) as object,'metadata'),false);assert.equal(Object.hasOwn(binding,'capturedPrompt'),false);
});
test('AI-only account recovery fails closed and historical pre42 checks never query an absent relation',async()=>{
 async function check(relation:{present:boolean;applied:boolean},aiOnly:boolean){
  const statements:string[]=[];
  const client={query:async(sql:string)=>{statements.push(sql);if(sql.includes('FROM installation'))return {rows:[{provider_account_identity:null}]};if(sql.includes('to_regclass'))return {rows:[relation]};if(sql.startsWith('SELECT\n'))return {rows:[{present:aiOnly?sql.includes('FROM ai_search_quote'):true,modern:aiOnly?sql.includes('FROM ai_search_quote'):true}]};throw Error('Unexpected write or statement');}} as unknown as PoolClient;
  await assert.rejects(initializeProviderAccountIdentity(client),e=>!!e&&typeof e==='object'&&'status'in e&&e.status===503);
  assert.equal(statements.some(s=>s.startsWith('UPDATE')),false);return statements;
 }
 const modern=await check({present:true,applied:true},true);assert.equal(modern.some(s=>s.includes('OR EXISTS(SELECT 1 FROM ai_search_quote)')),true);
 const historical=await check({present:false,applied:false},false);assert.equal(historical.some(s=>s.includes('FROM ai_search_quote')),false);
 const corrupt=await check({present:false,applied:true},true);assert.equal(corrupt.length,2);assert.equal(corrupt.some(s=>s.includes('FROM ai_search_quote')),false);
});
test('provider deadlines are explicit only and precede the first workspace lock without changing defaults',async()=>{
 const names=['APP_URL','DATABASE_URL','AUTH_SECRET','ANALYTICS_NETWORK_MODE'] as const,saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{APP_URL:'http://localhost:3099',DATABASE_URL:'postgres://127.0.0.1:55501/ten98_ai_search_unit',AUTH_SECRET:'a'.repeat(64),ANALYTICS_NETWORK_MODE:'off'});
 const pool=getDatabase().pool,connect=pool.connect,workspace=randomUUID(),user=randomUUID(),request=randomUUID();let statements:string[]=[];
 const client={release(){},query:async(sql:string)=>{statements.push(sql);if(sql.includes('SELECT role FROM membership'))return{rows:[{role:'editor'}]};if(sql.includes('SELECT * FROM provider_request'))return{rows:[{id:request,workspace_id:workspace,user_id:user,status:'reserved',connection_id:randomUUID(),connection_revision:1,estimate_micros:'4000'}]};if(sql.includes('FROM provider_connection'))return{rows:[{revoked_at:null,revision:1}]};if(sql.includes('AS uncertain'))return{rows:[{month:'2026-10-01',paused:false,uncertain:false}]};return{rows:[]};}};// Owner decision D3: the gate reads the connection, then month/pause/uncertainty; there is no cap read.
 pool.connect=(async()=>client) as unknown as typeof pool.connect;
 try{
  await providerTransaction(workspace,user,['editor'],async()=>{});assert.deepEqual(statements,['BEGIN','SELECT id FROM workspace WHERE id=$1 FOR UPDATE','SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2','COMMIT']);
  statements=[];await dispatchSpend(workspace,user,request,async()=>{statements.push('PREPARE');},'5s');assert.equal(statements[0],'BEGIN');assert.equal(statements[1],"SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s'");assert.equal(statements[2],'SELECT id FROM workspace WHERE id=$1 FOR UPDATE');assert.ok(statements.indexOf('PREPARE')>2);assert.equal(statements.at(-1),'COMMIT');
  statements=[];await dispatchSpend(workspace,user,request);assert.equal(statements.some(s=>s.startsWith('SET LOCAL')),false);
 }finally{pool.connect=connect;await closeDatabase();for(const name of names)if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}
});
test('closed retained evidence reads independently of the separate word derivation ceiling',()=>{
 const word=(n:number)=>'a'+Array.from({length:4},(_,i)=>String.fromCharCode(97+Math.floor(n/26**i)%26)).join(''),words=Array.from({length:30000},(_,i)=>word(i));
 const evidence=normalizeDfsChatgptSearchEvidence({markdown:'Synthetic answer',fan_out_queries:Array.from({length:100},(_,i)=>words.slice(i*300,(i+1)*300).join(' '))});
 assert.deepEqual(readSearchEvidence(evidence),evidence);assert.throws(()=>deriveSearchQueries({evidence,capturedPrompt:'Synthetic immutable prompt',subjects:[],method:'unicode-boundary-v1'}));
 assert.throws(()=>readSearchEvidence({...evidence,extra:true}));assert.throws(()=>readSearchEvidence({...evidence,queries:{state:'reported',values:[4]}}));
});
