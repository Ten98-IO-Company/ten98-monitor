import {accountPreferencesDtoSchema,accountPreferencesWireInputSchema,type AccountPreferencesDto} from '../../src/lib/account-preferences.ts';

/**
 * Deterministic synthetic HTTP exchanges for tests/account-preferences-browser.mjs.
 * Every preference body is parsed through the production DTO schema and every save
 * request is serialised through the production input schema, so the fixture cannot
 * drift from the app's wire contract. No customer, provider or captured data.
 */
export type Wire={ordinal:number;path:string;method:'GET'|'POST';status:number;headers:Record<string,string>;requestBody?:string;responseBody:string;actorId:string|null};
export type Role='owner'|'admin'|'editor'|'viewer';
type User={id:string;name:string;email:string};

const id=(n:number)=>'20000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const stamp='2026-10-15T12:00:00.000Z',headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
const prefPath='/api/account/preferences';

export function buildAccountPreferencesCapture(){
 const wires:Wire[]=[];
 const add=(path:string,method:'GET'|'POST',status:number,body:unknown,actorId:string|null,request?:unknown):number=>{
  const ordinal=wires.length+1;
  wires.push({ordinal,path,method,status,headers:{...headers},responseBody:JSON.stringify(body),actorId,...request===undefined?{}:{requestBody:JSON.stringify(request)}});
  return ordinal;
 };
 const dto=(user:User,revision:number,p:{timeZone:string;locale:AccountPreferencesDto['preferences']['locale'];theme:AccountPreferencesDto['preferences']['theme']}):AccountPreferencesDto=>
  accountPreferencesDtoSchema.parse({version:'account-preferences-v1',user,preferences:{revision,...p,updatedAt:revision===0?null:new Date(Date.parse(stamp)+revision*60_000).toISOString()}});
 const status=add('/api/status','GET',200,{configured:true,appUrl:'http://127.0.0.1'},null);
 const oidcProviders=add('/api/auth/oidc/providers','GET',200,{providers:[]},null);
 const workspaceId=id(100),workspaceName='Synthetic workspace',renamed='Synthetic workspace renamed';
 const actor=(role:Role,n:number,withWorkspace=true)=>{
  const user:User={id:id(n),name:`Synthetic ${role}`,email:`${role}@preferences.example.test`};
  const workspaces=withWorkspace?[{id:workspaceId,name:workspaceName,role}]:[];
  const me=add('/api/me','GET',200,{user,instanceOperator:false,workspaces},user.id);
  const preferences=add(prefPath,'GET',200,dto(user,0,{timeZone:'UTC',locale:'en-US',theme:'light'}),user.id);
  const projects=withWorkspace?{[workspaceId]:add(`/api/workspaces/${workspaceId}/projects`,'GET',200,{projects:[]},user.id)}:undefined;
  const signOut=add('/api/auth/sign-out','POST',200,{},user.id,{});
  return {id:user.id,role,me,preferences,projects,signOut,user};
 };
 const roles=[actor('owner',1),actor('admin',2),actor('editor',3),actor('viewer',4,false)];
 const ownerUser=roles[0].user;
 // Owner flow: three saves, each followed by its ordinary GET (the identical DTO).
 const themes=[{name:'Synthetic owner dark',timeZone:'America/New_York',locale:'de-DE',theme:'dark'},{name:'Synthetic owner system',timeZone:'Europe/Berlin',locale:'fr-FR',theme:'system'},{name:'Synthetic owner light',timeZone:'Asia/Tokyo',locale:'en-GB',theme:'light'}] as const;
 const initial=add(prefPath,'GET',200,dto(ownerUser,0,{timeZone:'UTC',locale:'en-US',theme:'light'}),ownerUser.id);
 const steps=themes.map((t,i)=>{
  const saved=dto({...ownerUser,name:t.name},i+1,{timeZone:t.timeZone,locale:t.locale,theme:t.theme});
  const request=accountPreferencesWireInputSchema.parse({expectedRevision:i,name:t.name,timeZone:t.timeZone,locale:t.locale,theme:t.theme});
  const save=add(prefPath,'POST',200,saved,ownerUser.id,request),reload=add(prefPath,'GET',200,saved,ownerUser.id);
  return {save,reload};
 });
 const sessions=[{id:id(300),createdAt:'2026-10-14T09:30:00.000Z',expiresAt:'2026-11-14T09:30:00.000Z',userAgent:'Synthetic browser',current:true}];
 const security=add('/api/account/security','GET',200,{user:{...ownerUser,twoFactorEnabled:false},sessions,hasPassword:true},ownerUser.id);
 // The Security view also reads the account closure blockers (AccountClosurePanel); none apply to this owner.
 const closure=add('/api/account/closure','GET',200,{blockers:{workspaces:[],lastOperator:false},hasPassword:true,twoFactorEnabled:false},ownerUser.id);
 const teamBody=(name:string)=>({workspace:{id:workspaceId,name,twoFactorRequired:false},role:'owner',members:[{userId:ownerUser.id,name:ownerUser.name,email:ownerUser.email,role:'owner'}],invitations:[]});
 const teamPath=`/api/workspaces/${workspaceId}/team`;
 const teamBefore=add(teamPath,'GET',200,teamBody(workspaceName),ownerUser.id);
 const rename=add(`/api/workspaces/${workspaceId}/rename`,'POST',200,{ok:true},ownerUser.id,{name:renamed});
 const teamAfter=add(teamPath,'GET',200,teamBody(renamed),ownerUser.id);
 // A /api/me read that began after the rename but before the second save: renamed workspace, first-save user name.
 const staleMe=add('/api/me','GET',200,{user:{...ownerUser,name:themes[0].name},instanceOperator:false,workspaces:[{id:workspaceId,name:renamed,role:'owner'}]},ownerUser.id);
 const ownerActor={id:ownerUser.id,me:roles[0].me,projects:roles[0].projects,signOut:roles[0].signOut,security,closure};
 // Concurrent-save conflict: the stored revision moved on another device.
 const conflictUser:User={id:id(5),name:'Synthetic conflict user',email:'conflict@preferences.example.test'};
 const conflictMe=add('/api/me','GET',200,{user:conflictUser,instanceOperator:false,workspaces:[]},conflictUser.id);
 const conflictInitial=add(prefPath,'GET',200,dto(conflictUser,4,{timeZone:'UTC',locale:'en-US',theme:'light'}),conflictUser.id);
 const conflictSave=add(prefPath,'POST',409,{error:'Preferences changed on another device.'},conflictUser.id,accountPreferencesWireInputSchema.parse({expectedRevision:4,name:'Synthetic conflict edit',timeZone:'UTC',locale:'en-US',theme:'dark'}));
 const conflictReload=add(prefPath,'GET',200,dto({...conflictUser,name:'Synthetic conflict winner'},5,{timeZone:'UTC',locale:'en-US',theme:'light'}),conflictUser.id);
 const conflictSignOut=add('/api/auth/sign-out','POST',200,{},conflictUser.id,{});
 return {
  kind:'account-preferences-synthetic-v1' as const,wires,status,oidcProviders,
  roles:roles.map(({id,role,me,preferences,projects,signOut})=>({id,role,me,preferences,projects,signOut})),
  ownerFlow:{actor:ownerActor,initial,steps,refreshRace:{saveStep:1,workspaceId,rename,staleMe,teamBefore,teamAfter}},
  conflict:{actor:{id:conflictUser.id,me:conflictMe,signOut:conflictSignOut},initial:conflictInitial,save:conflictSave,reload:conflictReload},
 };
}
