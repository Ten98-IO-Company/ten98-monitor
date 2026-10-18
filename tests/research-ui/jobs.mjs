import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {EventEmitter} from 'node:events';
import {Resolver} from 'node:dns/promises';
import {Readable} from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import {fixtureGuard} from './guard.mjs';
import {readFixture} from './fixtures.mjs';
import {createSyntheticProviderFetch} from './provider.mjs';
import {getDatabase} from '../../src/server/db.ts';
import {getBoss} from '../../src/server/jobs.ts';
import {executeKeywordResearch,keywordQueue} from '../../src/server/keyword-research.ts';
import {executePromptComparison,promptExecutionQueue} from '../../src/server/prompt-execution.ts';
import {executeSiteAudit} from '../../src/server/site-audit-worker.ts';

async function ownedRun(table,id){
  fixtureGuard();assert.ok(['keyword_research_run','prompt_comparison','site_audit_run'].includes(table));assert.match(id,/^[a-f0-9-]{36}$/);
  const fixtures=await readFixture();const row=(await getDatabase().pool.query('SELECT * FROM '+table+' WHERE id=$1',[id])).rows[0];assert.ok(row);
  assert.ok(Object.values(fixtures.groups).some(group=>group.main.id===row.project_id||group.other.id===row.project_id));return row;
}
export async function runKeyword(id,mode='ok'){
  await ownedRun('keyword_research_run',id);await executeKeywordResearch(id,createSyntheticProviderFetch({allowDispatch:true,keywordMode:mode}));
  await (await getBoss()).complete(keywordQueue,id,null,{includeQueued:true});
}
export async function runPrompt(id,mode='ok'){
  await ownedRun('prompt_comparison',id);await executePromptComparison(id,createSyntheticProviderFetch({allowDispatch:true,promptMode:mode}));
  const children=(await getDatabase().pool.query('SELECT id FROM prompt_execution WHERE comparison_id=$1',[id])).rows.map(row=>row.id);
  if(children.length)await (await getBoss()).complete(promptExecutionQueue,children,null,{includeQueued:true});
}
const html=links=>`<!doctype html><html><head><title>Synthetic technical page</title><meta name="description" content="${'Useful description '.repeat(8)}"></head><body><h1>Observed fixture page</h1><p>${'word '.repeat(170)}</p>${links}</body></html>`;
export async function runAudit(id,{route:customRoute}={}){
  const row=await ownedRun('site_audit_run',id),origin=new URL(row.origin),responses=new Set(),requests=[];
  const route=customRoute??(url=>url.pathname==='/robots.txt'?{body:'User-agent: *\nDisallow: /private',headers:['Content-Type','text/plain']}:
    url.pathname==='/sitemap.xml'?{body:`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin.origin}/</loc></url><url><loc>${origin.origin}/two</loc></url></urlset>`,headers:['Content-Type','application/xml']}:
    url.pathname==='/missing'?{status:404,body:'Synthetic unavailable page'}:
    {body:html('<a href="/two">Second page</a><a href="/private">Excluded</a><a href="/missing">Observed missing target</a>')});
  const validHost=host=>assert.equal(host,origin.hostname,'Crawl fixture never resolves other hosts.');
  const mocks=[mock.method(Resolver.prototype,'resolve4',async host=>{validHost(host);return ['1.1.1.1'];}),
    mock.method(Resolver.prototype,'resolve6',async host=>{validHost(host);return [];})];
  const request=(url,options,callback)=>{
    assert.equal(url.origin,origin.origin);assert.equal(options.method,'GET');assert.equal(options.headers['user-agent'],'TenMonitorBot/1.0');assert.deepEqual(options.agent.options.proxyEnv,{});
    const req=new EventEmitter();let destroyed=false;req.destroy=()=>{destroyed=true;};requests.push(url.pathname);
    req.end=()=>queueMicrotask(()=>void(async()=>{
      if(destroyed)return;const socket=new EventEmitter();socket.remoteAddress='1.1.1.1';req.emit('socket',socket);socket.emit(url.protocol==='https:'?'secureConnect':'connect');
      const spec=await route(url);await spec.hold;if(destroyed)return;
      let supplied=false;const response=new Readable({read(){if(supplied)return;supplied=true;if(spec.body)this.push(Buffer.from(spec.body));this.push(null);}});
      response.statusCode=spec.status??200;response.rawHeaders=spec.headers??['Content-Type','text/html; charset=utf-8'];response.complete=true;
      responses.add(response);response.once('close',()=>responses.delete(response));callback(response);
    })().catch(error=>req.emit('error',error)));return req;
  };
  mocks.push(mock.method(http,'request',request),mock.method(https,'request',request),mock.method(globalThis,'fetch',async()=>{throw new Error('Audit fixture outbound fetch blocked.');}));
  try{await executeSiteAudit({runId:id,jobId:row.queue_job_id});await (await getBoss()).complete('site-audit',row.queue_job_id,null,{includeQueued:true});return {requests};}
  finally{for(const item of mocks)item.mock.restore();for(const response of responses)response.destroy();}
}
