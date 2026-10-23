import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtureGuard,evidenceDir} from './guard.mjs';
import {assertSchema,getDatabase,closeDatabase} from '../../src/server/db.ts';
import {claimInstallation} from '../../src/server/auth.ts';
import {createWorkspace} from '../../src/server/teams.ts';
import {normalizeProperties} from '../../src/server/analytics-input.ts';

export const fixturePath=resolve(evidenceDir,'fixtures.json');
export async function readFixture(){fixtureGuard();const result=JSON.parse(await readFile(fixturePath,'utf8'));assert.equal(result.synthetic,true);return result;}
export async function seedFixture(){
  const identity=fixtureGuard({manifest:false});await assertSchema();
  try{await access(fixturePath);throw new Error('Fixture exists; use a fresh database and preserve prior evidence.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const pool=getDatabase().pool;
  assert.equal((await pool.query('SELECT count(*) AS n FROM "user"')).rows[0].n,'0');
  assert.equal((await pool.query('SELECT count(*) AS n FROM project')).rows[0].n,'0');
  await mkdir(evidenceDir,{recursive:true});
  await writeFile(resolve(evidenceDir,'manifest.json'),JSON.stringify({...identity,synthetic:true},null,2)+'\n',{flag:'wx',mode:0o600});
  const owner={email:randomUUID()+'@conversions.integration.test',password:randomBytes(24).toString('base64url')};
  await claimInstallation({name:'Synthetic conversion owner',workspaceName:'Conversion browser workspace',...owner});
  owner.id=(await pool.query('SELECT id FROM "user" WHERE email=$1',[owner.email])).rows[0].id;
  const workspace=(await pool.query('SELECT w.id,w.name FROM workspace w JOIN membership m ON m.workspace_id=w.id WHERE m.user_id=$1',[owner.id])).rows[0];
  const otherWorkspace=(await createWorkspace(owner.id,{name:'Other conversion workspace'})).workspace;
  await pool.query('UPDATE workspace SET raw_analytics_days=3650 WHERE id=ANY($1::text[])',[[workspace.id,otherWorkspace.id]]);
  async function project(wid,name,host){
    const value={id:randomUUID(),name,origin:'https://'+host};
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,$3,$4,$5,'infinity')",[value.id,wid,name,value.origin,randomUUID()]);return value;
  }
  const chains=await project(workspace.id,'Synthetic ordered activity','chains.example.com');
  const goals=await project(workspace.id,'Synthetic goal population','goals.example.com');
  const empty=await project(otherWorkspace.id,'Other empty project','empty.example.com');
  const events=[],digest=value=>createHash('sha256').update(value).digest('hex');
  async function add(project,visitor,eventName,path,minute,{properties={},visit=visitor}={}){
    const id=randomUUID(),receivedAt=new Date(Date.parse('2026-01-31T12:00:00Z')+minute*60_000).toISOString();
    const visitorId=visitor===null?null:digest(project.id+visitor),visitId=visitor===null?null:digest(project.id+visit);
    if(visitorId)await pool.query('INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',[project.id,visitorId,receivedAt]);
    await pool.query('INSERT INTO event(id,project_id,event_name,path,received_at,properties,dimensions,visitor_id,visit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,project.id,eventName,path,receivedAt,JSON.stringify(normalizeProperties(properties)),JSON.stringify({origin:project.origin,language:'en'}),visitorId,visitId]);
    events.push({id,projectId:project.id,visitor:visitorId,eventName,path,receivedAt});
  }
  // Three starts, two second steps, one completion. The completed visitor spans visits.
  for(const [visitor,names]of [['complete',['A','B','C']],['drop',['A','B']],['start',['A']]])for(const [index,name]of names.entries())await add(chains,visitor,name,'/'+name,index,{visit:visitor+'-'+index,properties:{plan:visitor==='complete'?'pro':'free'}});
  for(const [index,name]of ['A','B','C'].entries())await add(chains,null,name,'/'+name,index);
  await add(goals,'repeat','page_view','/thank-you',0);await add(goals,'repeat','page_view','/thank-you',1);
  await add(goals,'other','page_view','/elsewhere',0);await add(goals,'custom','purchase','/thank-you',0);
  await add(goals,null,'page_view','/thank-you',0);await add(goals,null,'page_view','/thank-you',1);
  const fixture={synthetic:true,owner,workspace,otherWorkspace,chains,goals,empty,events};
  await writeFile(fixturePath,JSON.stringify(fixture,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('PASS seeded one synthetic owner, two workspaces, three projects and 15 event observations.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['seed']);globalThis.fetch=async()=>{throw new Error('No outbound fixture requests.');};
  try{await seedFixture();}finally{await closeDatabase();}
}
