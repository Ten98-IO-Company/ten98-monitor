import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {access,writeFile,readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashPassword} from 'better-auth/crypto';
import {fixtureGuard,evidenceDir} from './guard.mjs';
import {createSyntheticProviderFetch} from './provider.mjs';
import {assertSchema,getDatabase,closeDatabase} from '../../src/server/db.ts';
import {claimInstallation} from '../../src/server/auth.ts';
import {createWorkspace} from '../../src/server/teams.ts';
import {saveProvider,saveBudget} from '../../src/server/providers.ts';
import {createPrompts,updatePrompt,setPromptArchived} from '../../src/server/prompts.ts';
import {addDomain,issueDomainChallenge,verifyDomain} from '../../src/server/domains.ts';
import {refreshKeywordMarkets} from '../../src/server/keyword-research.ts';
import {stopJobs} from '../../src/server/jobs.ts';

export const fixturePath=resolve(evidenceDir,'fixtures.json');
export async function readFixture(){fixtureGuard();return JSON.parse(await readFile(fixturePath,'utf8'));}
// Separate actors keep independent UI phases below real production rate limits.
export async function createKeywordCase(label){
  fixtureGuard();assert.match(label,/^[a-z-]{1,40}$/);const fixture=await readFixture(),key='keyword-'+label;
  assert.equal(fixture.groups[key],undefined,'Use a new named phase; preserve failed fixture evidence.');
  const pool=getDatabase().pool,owner={id:randomUUID(),name:'Keyword '+label,email:randomUUID()+'@research-ui.integration.test',password:randomBytes(24).toString('base64url')};
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[owner.id,owner.name,owner.email]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner.id,await hashPassword(owner.password)]);
  const workspace=(await createWorkspace(owner.id,{name:'Keyword '+label+' workspace'})).workspace;
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace.id,fixture.bootstrap.id]);
  const projects=[];
  for(const suffix of ['main','other']){
    const project={id:randomUUID(),name:'Keyword '+label+' '+suffix,origin:'https://'+label+'-'+suffix+'.example.com'};
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,$3,$4,$5,'infinity')",[project.id,workspace.id,project.name,project.origin,randomUUID()]);projects.push(project);
  }
  const dataforseo=(await saveProvider(workspace.id,owner.id,{provider:'dataforseo',name:'Synthetic DataForSEO',credentials:{login:'synthetic-provider@keywords.integration.test',password:'synthetic-never-live'}})).connection.id;
  await pool.query("UPDATE provider_connection SET check_status='ok' WHERE id=$1",[dataforseo]);await saveBudget(workspace.id,owner.id,{paused:false});
  await refreshKeywordMarkets(projects[0].id,owner.id,{connectionId:dataforseo},createSyntheticProviderFetch());
  const group={workspace,owner,main:projects[0],other:projects[1],connections:{dataforseo}};fixture.groups[key]=group;
  await writeFile(fixturePath,JSON.stringify(fixture,null,2)+'\n',{mode:0o600});return group;
}
export async function createPromptCase(label){
  const group=await createKeywordCase('prompt-'+label),pool=getDatabase().pool;
  group.connections.openrouter=(await saveProvider(group.workspace.id,group.owner.id,{provider:'openrouter',name:'Synthetic OpenRouter',credentials:{apiKey:'synthetic-never-live'}})).connection.id;
  await pool.query("UPDATE provider_connection SET check_status='ok' WHERE id=$1",[group.connections.openrouter]);
  const prompt=(await createPrompts(group.main.id,group.owner.id,{requestId:randomUUID(),prompts:[{text:'Synthetic '+label+' authored prompt',enabled:false}]})).items[0];group.prompts={disabled:prompt};
  const fixture=await readFixture();fixture.groups['keyword-prompt-'+label]=group;await writeFile(fixturePath,JSON.stringify(fixture,null,2)+'\n',{mode:0o600});return group;
}
async function verifiedDomains(main,owner,label){
  const domains={};
  for(const role of ['serving','redirect_alias']){
    const hostname=role.replace('_','-')+'-'+label+'.example.com';
    const state=await addDomain(main.id,owner.id,{hostname,role});const item=state.domains.find(row=>row.hostname===hostname);assert.ok(item);
    const proof=await issueDomainChallenge(main.id,owner.id,item.id,{});
    await verifyDomain(main.id,owner.id,item.id,{},async name=>{assert.equal(name,proof.challenge.name);return [[proof.challenge.value]];});
    domains[role]={id:item.id,hostname};
  }
  return domains;
}
export async function createAuditCase(label){
  assert.match(label,/^[a-z][a-z-]{0,19}$/);
  const group=await createKeywordCase('audit-'+label);group.domains=await verifiedDomains(group.main,group.owner,'audit-'+label);
  const fixture=await readFixture();fixture.groups['keyword-audit-'+label]=group;
  await writeFile(fixturePath,JSON.stringify(fixture,null,2)+'\n',{mode:0o600});return group;
}
export async function seedFixture(){
  const guard=fixtureGuard({manifest:false});await assertSchema();
  try{await access(fixturePath);throw new Error('Fixture already seeded.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const pool=getDatabase().pool;
  assert.equal((await pool.query('SELECT count(*) AS n FROM "user"')).rows[0].n,'0','Use the freshly migrated empty research UI database.');
  assert.equal((await pool.query('SELECT count(*) AS n FROM project')).rows[0].n,'0');
  await mkdir(evidenceDir,{recursive:true});
  await writeFile(resolve(evidenceDir,'manifest.json'),JSON.stringify({...guard,synthetic:true,createdAt:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});
  const send=createSyntheticProviderFetch();
  globalThis.fetch=send;
  const credentials=()=>({email:randomUUID()+'@research-ui.integration.test',password:randomBytes(24).toString('base64url')});
  const bootstrap=credentials();
  await claimInstallation({name:'Synthetic fixture operator',workspaceName:'Fixture administration',...bootstrap});
  bootstrap.id=(await pool.query('SELECT id FROM "user" WHERE email=$1',[bootstrap.email])).rows[0].id;
  async function user(name){
    const data={id:randomUUID(),name,...credentials()},hash=await hashPassword(data.password),client=await pool.connect();
    try{await client.query('BEGIN');await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[data.id,name,data.email]);
      await client.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),data.id,hash]);await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}return data;
  }
  async function project(workspaceId,name,host){
    const id=randomUUID();await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,$3,$4,$5,'infinity')",[id,workspaceId,name,'https://'+host,randomUUID()]);
    return {id,name,origin:'https://'+host};
  }
  const groups={};
  for(const key of ['keyword','prompt','audit']){
    const owner=await user(key+' browser owner'),editor=await user(key+' browser editor'),viewer=await user(key+' browser viewer');
    const workspace=(await createWorkspace(owner.id,{name:'Synthetic '+key+' workspace'})).workspace;
    for(const [id,role] of [[bootstrap.id,'owner'],[editor.id,'editor'],[viewer.id,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace.id,id,role]);
    const main=await project(workspace.id,key+' primary site',key+'.example.com'),other=await project(workspace.id,key+' other site','other-'+key+'.example.com');
    const emptyWorkspace=(await createWorkspace(owner.id,{name:'Synthetic '+key+' empty workspace'})).workspace;
    const empty=await project(emptyWorkspace.id,key+' empty site','empty-'+key+'.example.com');
    const connections={};
    for(const provider of ['dataforseo','openrouter']){
      const credentials=provider==='openrouter'?{apiKey:'synthetic-never-live'}:{login:'synthetic-provider@keywords.integration.test',password:'synthetic-never-live'};
      connections[provider]=(await saveProvider(workspace.id,owner.id,{provider,name:'Synthetic '+provider,credentials})).connection.id;
      await pool.query("UPDATE provider_connection SET check_status='ok' WHERE id=$1",[connections[provider]]);
    }
    await saveBudget(workspace.id,owner.id,{paused:false});
    await refreshKeywordMarkets(main.id,owner.id,{connectionId:connections.dataforseo},send);
    const initial=(await createPrompts(main.id,owner.id,{requestId:randomUUID(),prompts:[
      {text:'Synthetic disabled prompt original version',enabled:false},
      {text:'Synthetic enabled prompt',enabled:true},
      {text:'Synthetic archived prompt',enabled:false}]})).items;
    const changed=(await updatePrompt(main.id,owner.id,initial[0].id,{requestId:randomUUID(),revision:1,text:'Synthetic disabled prompt current version'})).prompt;
    await setPromptArchived(main.id,owner.id,initial[2].id,true,{requestId:randomUUID(),revision:1});
    if(key==='prompt')await createPrompts(main.id,owner.id,{requestId:randomUUID(),prompts:Array.from({length:52},(_,i)=>({text:'Pagination fixture prompt '+String(i+1).padStart(2,'0'),enabled:false,tags:['pagination']}))});
    const domains=await verifiedDomains(main,owner,key);
    groups[key]={workspace,owner,editor,viewer,main,other,emptyWorkspace,empty,connections,domains,
      prompts:{disabled:changed,original:initial[0],enabled:initial[1],archived:initial[2]}};
  }
  const result={synthetic:true,createdAt:new Date().toISOString(),bootstrap,groups};
  await writeFile(fixturePath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('Seeded three isolated UI groups with synthetic local accounts, provider settings, prompt versions and DNS proofs.');
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['seed']);
  try{await seedFixture();}finally{await stopJobs();await closeDatabase();}
}
