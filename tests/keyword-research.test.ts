import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {parseKeywordRequest,providerMicros,microUsd,keywordPayload,keywordEndpoints,keywordAccountEndpoint,keywordCatalogEndpoint} from '../src/server/keyword-research-input.ts';
import {parseKeywordAccount,parseKeywordMarkets,parseKeywordOutcome,parseKeywordReconciliation,requestKeywordResearch,keywordProviderJson} from '../src/server/dataforseo-keywords.ts';
import {dataforseoRefusal,dataforseoRefusalMessage,dataforseoWalletCodes} from '../src/server/dataforseo-transport.ts';

process.env.AUTH_SECRET='keyword-test-only-auth-secret-'.repeat(2);
process.env.DATABASE_URL='postgresql://synthetic:synthetic@localhost/unused_keyword_unit';
delete process.env.AUTH_SECRET_FILE;delete process.env.DATABASE_URL_FILE;
const request=parseKeywordRequest({connectionId:randomUUID(),mode:'overview',keywords:['Example',' Missing '],locationCode:2840,languageCode:'en',limit:100});
const id=randomUUID();
const free=(result:unknown[])=>({httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks:[{status_code:20000,cost:0,result}]}});
function response(){return {httpStatus:200,body:{status_code:20000,cost:0.01212,tasks_count:1,tasks:[{id:'provider-task',status_code:20000,cost:0.01212,path:['v3','dataforseo_labs','google','keyword_overview','live'],data:keywordPayload(request,id),result:[{se_type:'google',location_code:2840,language_code:'en',items_count:1,items:[{keyword:'example',keyword_info:{search_volume:0,cpc:0,competition:0,competition_level:null,monthly_searches:[{year:2026,month:1,search_volume:null}],last_updated_time:'2026-01-31 12:00:00 +00:00'},keyword_properties:{keyword_difficulty:0},search_intent_info:{main_intent:'informational',last_updated_time:null}}]}]}]}};}

test('keyword request normalization keeps bounded exact inputs and rejects unsafe/inapplicable fields',()=>{
 assert.deepEqual(request.keywords,['example','missing']);
 assert.deepEqual(parseKeywordRequest({...request,keywords:[' Same  Word ','same word']}).keywords,['same word']);
 for(const raw of [{...request,endpoint:'https://evil.test'},{...request,limit:25},{...request,mode:'ideas'},{...request,keywords:['x'.repeat(81)]},{...request,keywords:['x '.repeat(11)]},{...request,keywords:['bad\0']},{...request,keywords:['bad\ud800']},{...request,keywords:[' ']},{...request,locationCode:'2840'},{...request,languageCode:'../../en'}])assert.throws(()=>parseKeywordRequest(raw));
 assert.equal(parseKeywordRequest({...request,mode:'ideas',keywords:['one'],limit:25}).limit,25);
});
test('provider monetary parsing uses exact integer micro-units and fails closed on unsupported evidence',()=>{
 for(const [raw,micros] of [[0,0n],[0.000001,1n],[0.00012,120n],[0.012,12000n],[0.1,100000n],[1_000_000,1_000_000_000_000n]] as const)assert.equal(providerMicros(raw),micros);
 for(const raw of ['0.012',-1,Infinity,NaN,0.0000001,0.1+0.2,1_000_001,null])assert.throws(()=>providerMicros(raw));
 assert.equal(microUsd(12001n),'0.012001');
 const account={login:'synthetic@example.test',price:{dataforseo_labs:{keyword_overview:{live:{priority_normal:[{cost_type:'per_request',cost:0.012},{cost_type:'per_result',cost:0.00012}]}}}}};
 const parsed=parseKeywordAccount(free([account]),'overview');assert.equal(parsed.perTask,12000n);assert.equal(parsed.perItem,120n);assert.equal(parsed.fingerprint.length,64);assert.ok(!JSON.stringify({...parsed,perTask:String(parsed.perTask),perItem:String(parsed.perItem)}).includes(account.login));
 for(const prices of [[{cost_type:'per_request',cost:0.012}],[{cost_type:'per_request',cost:0.012},{cost_type:'per_request',cost:0.01}],[{cost_type:'per_request',cost:0.012},{cost_type:'unknown',cost:0.00012}]])assert.throws(()=>parseKeywordAccount(free([{...account,price:{dataforseo_labs:{keyword_overview:{live:{priority_normal:prices}}}}}]),'overview'));
});
test('market catalog retains only supported Google country/language pairs',()=>{
 const rows=[{location_code:2840,location_name:'United States',location_type:'Country',available_languages:[{language_code:'en',language_name:'English',available_sources:['google','bing']},{language_code:'es',language_name:'Spanish',available_sources:['bing']}]}];
 assert.deepEqual(parseKeywordMarkets(free(rows)),[{locationCode:2840,locationName:'United States',languageCode:'en',languageName:'English'}]);
 assert.throws(()=>parseKeywordMarkets(free([{...rows[0],location_type:'City'}])));
});

test('public Labs Region markets retain exact identity through request, payload and result binding',()=>{
 // Public metadata: https://cdn.dataforseo.com/v3/locations/locations_and_languages_dataforseo_labs_2026_09_01.csv
 const regions=[{location_code:2158,location_name:'Taiwan',location_type:'Region',available_languages:[{language_code:'zh-TW',language_name:'Chinese (Traditional)',available_sources:['google']}]},
  {location_code:2344,location_name:'Hong Kong',location_type:'Region',available_languages:[{language_code:'en',language_name:'English',available_sources:['google']},{language_code:'zh-TW',language_name:'Chinese (Traditional)',available_sources:['google']}]}];
 const markets=parseKeywordMarkets(free(regions));
 assert.deepEqual(markets,[{locationCode:2344,locationName:'Hong Kong',languageCode:'zh-TW',languageName:'Chinese (Traditional)'},{locationCode:2344,locationName:'Hong Kong',languageCode:'en',languageName:'English'},{locationCode:2158,locationName:'Taiwan',languageCode:'zh-TW',languageName:'Chinese (Traditional)'}]);
 for(const market of markets){
  const scoped=parseKeywordRequest({...request,keywords:['Example'],locationCode:market.locationCode,languageCode:market.languageCode});
  const payload=keywordPayload(scoped,id);assert.equal(payload.location_code,market.locationCode);assert.equal(payload.language_code,market.languageCode);
  const reply=response();reply.body.tasks[0].data=payload;reply.body.tasks[0].result[0].location_code=market.locationCode;reply.body.tasks[0].result[0].language_code=market.languageCode;
  assert.equal(parseKeywordOutcome(reply,scoped,id).result?.rows[0].keyword,'example');
  reply.body.tasks[0].result[0].language_code='un';assert.equal(parseKeywordOutcome(reply,scoped,id).result,null);
  reply.body.tasks[0].result[0].language_code=market.languageCode;reply.body.tasks[0].result[0].location_code=2840;assert.equal(parseKeywordOutcome(reply,scoped,id).result,null);
 }
 for(const type of ['City','Unknown','region',null])assert.throws(()=>parseKeywordMarkets(free([{...regions[0],location_type:type}])));
 assert.throws(()=>parseKeywordMarkets(free([regions[0],regions[0]])));
 const language=regions[0].available_languages[0];
 assert.equal(parseKeywordMarkets(free([{...regions[0],available_languages:[{...language,available_sources:['google','amazon']},{language_code:'en',language_name:'English',available_sources:['amazon','bing']}]}])).length,1);
 for(const available_sources of [null,'google',{}])assert.throws(()=>parseKeywordMarkets(free([{...regions[0],available_languages:[{...language,available_sources}]}])));
 assert.throws(()=>parseKeywordMarkets(free([{...regions[0],location_name:'bad\0'}])));
 assert.throws(()=>parseKeywordMarkets(free(Array.from({length:501},(_,i)=>({...regions[0],location_code:i+1})))));
 const languages=Array.from({length:101},(_,i)=>({...language,language_code:String.fromCharCode(97+Math.floor(i/26),97+i%26)}));
 assert.throws(()=>parseKeywordMarkets(free([{...regions[0],available_languages:languages}])));
 assert.throws(()=>parseKeywordMarkets(free(Array.from({length:51},(_,i)=>({...regions[0],location_code:i+1,available_languages:languages.slice(0,100)})))));
 const charged=free(regions);charged.body.cost=1;assert.throws(()=>parseKeywordMarkets(charged));
});
test('provider response preserves unavailable versus zero and distinguishes charge from usable data',()=>{
 const parsed=parseKeywordOutcome(response(),request,id,new Date('2026-02-01T00:00:00Z'));
 assert.equal(parsed.cost,'0.012120');assert.deepEqual(parsed.result?.missingKeywords,['missing']);assert.equal(parsed.result?.rows[0].searchVolume,0);assert.equal(parsed.result?.rows[0].cpcUsd,'0.000000');assert.equal(parsed.result?.rows[0].monthlySearches[0].searchVolume,null);assert.equal(parsed.result?.rows[0].metricsUpdatedAt,'2026-01-31T12:00:00.000Z');
 const badData=response();badData.body.tasks[0].result[0].items[0].keyword_info.search_volume=-1;const failed=parseKeywordOutcome(badData,request,id);assert.equal(failed.cost,'0.012120');assert.equal(failed.result,null);assert.match(failed.diagnostic!,/charge was recorded/i);
 const wrongTag=response();wrongTag.body.tasks[0].data.tag='other';assert.equal(parseKeywordOutcome(wrongTag,request,id).cost,null);
 const conflict=response();conflict.body.cost=0;assert.equal(parseKeywordOutcome(conflict,request,id).cost,null);
 for(const status of [20100,40601,40602,50000,50303,59999]){const pending=response();pending.body.cost=0;pending.body.tasks[0].cost=0;pending.body.tasks[0].status_code=status;assert.equal(parseKeywordOutcome(pending,request,id).cost,null);}
 const apiError=response();apiError.body.tasks[0].status_code=40501;const error=parseKeywordOutcome(apiError,request,id);assert.equal(error.cost,'0.012120');assert.equal(error.result,null);
});
test('reconciliation requires one exact request and never treats absent metadata as zero cost',()=>{
 const match={id:'provider-task',url:'v3/dataforseo_labs/google/keyword_overview/live',metadata:keywordPayload(request,id),status:'20000',cost:0.01212};
 assert.equal(parseKeywordReconciliation(free([match]),request,id).cost,'0.012120');
 // Authentic Labs ID-list metadata returns numeric 20000 (observed 2026-10-19), despite the documented string sample.
 assert.deepEqual(parseKeywordReconciliation(free([{...match,status:20000}]),request,id),{reference:'provider-task',cost:'0.012120',statusCode:20000});
 for(const status of ['20100','40601','40602','50000','50303','59999','20000\n',' 20000','2e4',['20000'],20000.1,20100,50000,NaN,Infinity,true,null])assert.throws(()=>parseKeywordReconciliation(free([{...match,status,cost:0}]),request,id));
 for(const rows of [[],[match,match],[{...match,metadata:{...match.metadata,location_code:2826}}],Array(1000).fill(match),[{...match,cost:null}]])assert.throws(()=>parseKeywordReconciliation(free(rows),request,id));
});
test('provider transport has fixed hosts, bounded bodies and one send without automatic paid retries',async()=>{
 let calls=0;const secret={login:'synthetic@example.test',password:'synthetic-never-live'};
 const send:typeof fetch=async(url,init)=>{calls++;assert.equal(url,keywordEndpoints.overview);assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.ok(init?.signal);assert.deepEqual(JSON.parse(init?.body as string),[keywordPayload(request,id)]);return Response.json(response().body);};
 assert.equal((await requestKeywordResearch(secret,request,id,send)).cost,'0.012120');assert.equal(calls,1);
 calls=0;const failure=await requestKeywordResearch(secret,request,id,async()=>{calls++;throw new Error('private synthetic credential should never be returned');});assert.equal(calls,1);assert.equal(failure.cost,null);assert.ok(!JSON.stringify(failure).includes('private synthetic'));
 await assert.rejects(keywordProviderJson('https://example.test',secret,undefined,send));assert.equal(calls,1);
 const oversized=await requestKeywordResearch(secret,request,id,async()=>new Response('x'.repeat(4_194_305)));assert.equal(oversized.cost,null);
 let freeCalls=0;await keywordProviderJson(keywordAccountEndpoint,secret,undefined,async(url,init)=>{freeCalls++;assert.equal(init?.method,'GET');assert.equal(url,keywordAccountEndpoint);return Response.json({});});await keywordProviderJson(keywordCatalogEndpoint,secret,undefined,async()=>{freeCalls++;return Response.json({});});assert.equal(freeCalls,2);
});
// Owner decision D3: DataForSEO appendix/errors wallet refusals (checked 2026-10-18) with an explicit zero cost everywhere are a known $0 outcome.
test('DataForSEO refusal matrix recognises only explicit zero-cost wallet shapes',()=>{
 const r=(body:unknown,httpStatus=200)=>dataforseoRefusal({httpStatus,body});
 assert.deepEqual([...dataforseoWalletCodes],[[40200,'payment'],[40210,'payment'],[40203,'cost_limit']]);
 assert.deepEqual(dataforseoRefusalMessage,{payment:'DataForSEO refused this request because the account balance is too low (payment required or insufficient funds). No charge was recorded. Add funds in DataForSEO, then prepare a new quote.',
  cost_limit:'DataForSEO refused this request because the daily cost limit set in your DataForSEO account was reached. No charge was recorded. Raise the limit in DataForSEO or wait for it to reset, then prepare a new quote.'});
 for(const [body,status,kind] of [
  [{status_code:40210,status_message:'x',cost:0,tasks_count:0,tasks:null},200,'payment'],[{status_code:40200,cost:0,tasks:null},200,'payment'],[{status_code:40200,cost:0},200,'payment'],[{status_code:40203,cost:0,tasks:[]},200,'cost_limit'],
  [{status_code:20000,cost:0,tasks_count:1,tasks:[{id:'t',status_code:40210,cost:0}]},200,'payment'],[{status_code:20000,cost:0,tasks:[{status_code:40203,cost:0},{status_code:40203,cost:0}]},200,'cost_limit'],
  [{status_code:20000,cost:0,tasks:[{status_code:40200,cost:0},{status_code:40210,cost:0}]},200,'payment'],[{status_code:40200,cost:0,tasks:[{status_code:40210,cost:0}]},200,'payment'],
  [{status_code:40200,cost:0,tasks:null},402,'payment'],[{status_code:40203,cost:0,tasks:null},402,'cost_limit'],[{cost:0},402,'payment'],[{status_code:null,cost:0,tasks:null},402,'payment'],[{status_code:402,cost:0,tasks:[]},402,'payment'],
 ] as [unknown,number,string][])assert.equal(r(body,status),kind,JSON.stringify([body,status]));
 for(const [body,status] of [
  [{status_code:40210,cost:0.01,tasks:null},200],[{status_code:40210,tasks:null},200],[{status_code:40210,cost:'0',tasks:null},200],[{status_code:40210,cost:null},200],[{status_code:40210,cost:-0.01},200],
  [{status_code:40201,cost:0,tasks:null},200],[{status_code:40202,cost:0,tasks:null},200],[{status_code:40204,cost:0,tasks:null},200],[{status_code:40209,cost:0,tasks:null},200],
  [{status_code:40201,cost:0,tasks:null},402],[{status_code:40202,cost:0},402],[{status_code:40204,cost:0},402],[{status_code:40209,cost:0},402],[{status_code:50000,cost:0},402],[{status_code:20000,cost:0,tasks:[]},402],[{status_code:402,cost:0,tasks:[{status_code:40210,cost:0}]},402],
  [{status_code:20000,cost:0,tasks:[{status_code:40210,cost:0},{status_code:20000,cost:0}]},200],[{status_code:20000,cost:0,tasks:[{status_code:40210,cost:0},{status_code:40203,cost:0}]},200],
  [{status_code:20000,cost:0,tasks:[{status_code:40210}]},200],[{status_code:20000,cost:0,tasks:[{status_code:40210,cost:0.01}]},200],[{status_code:20000,cost:0.01,tasks:[{status_code:40210,cost:0}]},200],
  [{status_code:20000,cost:0,tasks:[]},200],[{status_code:20000,cost:0,tasks:null},200],[{status_code:40203,cost:0,tasks:[{status_code:40210,cost:0}]},200],[{status_code:40210,cost:0,tasks:[{status_code:20000,cost:0}]},200],
  [{status_code:40210,cost:0,tasks:{}},200],[{status_code:40210,cost:0,tasks:[null]},200],[{status_code:'40210',cost:0},200],[{cost:0},200],
  [{status_code:40210,cost:0,tasks:null},500],[{status_code:40210,cost:0,tasks:null},401],[{status_code:40210,cost:0,tasks:null},403],[[{status_code:40210,cost:0}],200],[null,402],['payment',402],
 ] as [unknown,number][])assert.equal(r(body,status),null,JSON.stringify([body,status]));
});
test('keyword refusals settle a known $0 with the fixed text; a positive cost, other codes or a non-JSON 402 stay unknown',async()=>{
 const top=parseKeywordOutcome({httpStatus:200,body:{status_code:40210,cost:0,tasks_count:0,tasks:null}},request,id);
 assert.deepEqual(top,{cost:'0.000000',reference:null,result:null,diagnostic:dataforseoRefusalMessage.payment,evidence:{httpStatus:200,statusCode:40210,taskStatus:null,reportedCost:0,taskCost:null}});
 const task=parseKeywordOutcome({httpStatus:200,body:{status_code:20000,cost:0,tasks_count:1,tasks:[{id:'t',status_code:40203,cost:0}]}},request,id);
 assert.equal(task.cost,'0.000000');assert.equal(task.diagnostic,dataforseoRefusalMessage.cost_limit);assert.deepEqual(task.evidence,{httpStatus:200,statusCode:20000,taskStatus:40203,reportedCost:0,taskCost:0});
 const http=parseKeywordOutcome({httpStatus:402,body:{status_code:40200,cost:0,tasks:null}},request,id);assert.equal(http.cost,'0.000000');assert.equal(http.evidence.httpStatus,402);assert.equal(http.diagnostic,dataforseoRefusalMessage.payment);
 for(const body of [{status_code:40210,cost:0.01,tasks:null},{status_code:40210,tasks:null},{status_code:40201,cost:0,tasks:null},{status_code:20000,cost:0,tasks:[{status_code:40210,cost:0},{status_code:20000,cost:0}]}])assert.equal(parseKeywordOutcome({httpStatus:200,body},request,id).cost,null,JSON.stringify(body));
 let calls=0;const secret={login:'synthetic@example.test',password:'synthetic-never-live'},reply=(value:unknown,status:number):typeof fetch=>async()=>{calls++;return Response.json(value,{status});};
 assert.equal((await requestKeywordResearch(secret,request,id,reply({status_code:40200,cost:0,tasks:null},402))).cost,'0.000000');
 assert.equal((await requestKeywordResearch(secret,request,id,reply({status_code:20000,cost:0,tasks_count:1,tasks:[{id:'t',status_code:40210,cost:0}]},200))).cost,'0.000000');
 assert.equal((await requestKeywordResearch(secret,request,id,reply({status_code:40210,cost:0.01,tasks:null},200))).cost,null);
 assert.equal((await requestKeywordResearch(secret,request,id,async()=>{calls++;return new Response('Payment Required',{status:402});})).cost,null);assert.equal(calls,4);
});
