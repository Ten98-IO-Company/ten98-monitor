// Runs one native/production browser suite against its own fresh synthetic installation, e.g. in the Linux Playwright container:
//   node tests/helpers/native-browser.mjs [--unclaimed] [--no-worker] [--self-hosted] [--database=<prefix>] [--database-port=<port>] tests/<suite> [FLAG ...]
// Suites never share an installation: prerequisite data must be seeded by the suite or this runner, not left by another suite.
// Needs a built .output, PLAYWRIGHT_MODULE and a local PostgreSQL (NATIVE_BROWSER_POSTGRES, default postgres://ten98@127.0.0.1:5432).
// Each run creates, migrates and finally drops its own database; it never touches a saved installation. Every FLAG is set to 1.
// The installation is claimed through /api/auth/setup unless --unclaimed is given (suites that claim it themselves). Suites that
// pin their database name prefix or port get --database (name = prefix + 12 hex) and --database-port (a local TCP proxy).
// --no-worker skips the queue worker for suites that start their own worker with a synthetic provider transport;
// --self-hosted starts neither server nor worker and leaves the installation unclaimed, for suites that host the app themselves.
import {spawn} from 'node:child_process';
import {createServer,connect} from 'node:net';
import {randomBytes} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {basename} from 'node:path';
import pg from 'pg';

const args=process.argv.slice(2),options=new Map();while(args[0]?.startsWith('--')){const [key,value='']=args.shift().slice(2).split('=');options.set(key,value);}
const [suite,...flags]=args,selfHosted=options.has('self-hosted'),unclaimed=selfHosted||options.has('unclaimed'),prefix=options.get('database')||'ten98_native',proxyPort=options.has('database-port')?Number(options.get('database-port')):null;
if([...options.keys()].some(key=>!['unclaimed','no-worker','self-hosted','database','database-port'].includes(key))||!/^ten98_[a-z_]+$/.test(prefix)||proxyPort!==null&&!(proxyPort>1024&&proxyPort<65536))throw new Error('Unknown or invalid option.');
if(!suite||!/^tests\/[\w./-]+\.(mjs|ts)$/.test(suite)||flags.some(flag=>!/^TEN98_[A-Z0-9_]+$/.test(flag)))throw new Error('Usage: node tests/helpers/native-browser.mjs [--unclaimed] [--no-worker] [--self-hosted] [--database=<prefix>] [--database-port=<port>] tests/<suite>.mjs|.ts [TEN98_FLAG ...]');
const postgres=new URL(process.env.NATIVE_BROWSER_POSTGRES??'postgres://ten98@127.0.0.1:5432');
if(!['localhost','127.0.0.1','[::1]'].includes(postgres.hostname))throw new Error('NATIVE_BROWSER_POSTGRES must be a local throwaway server.');
const port=Number(process.env.NATIVE_BROWSER_PORT??3197),origin=`http://127.0.0.1:${port}`,hex=bytes=>randomBytes(bytes).toString('hex');
const database=`${prefix}_${hex(6)}`,databaseUrl=new URL(postgres);databaseUrl.pathname='/'+database;if(proxyPort!==null){databaseUrl.hostname='127.0.0.1';databaseUrl.port=String(proxyPort);}
const out=`private/native-browser/${basename(suite).replace(/\.(mjs|ts)$/,'')}-${hex(4)}`;
const env={...process.env,NODE_ENV:'production',AUTH_SECRET:hex(32),CREDENTIAL_KEYS:JSON.stringify({v1:randomBytes(32).toString('base64')}),CREDENTIAL_ACTIVE_KEY:'v1',
  APP_URL:origin,BASE_URL:origin,HOST:'127.0.0.1',PORT:String(port),DATABASE_URL:databaseUrl.href,ANALYTICS_NETWORK_MODE:'direct',TEN98_INTEGRATION_TEST:'1',OUT_DIR:out,BROWSER_ARTIFACT_DIR:out,
  ...Object.fromEntries(flags.map(flag=>[flag,'1']))};

let adminBase=postgres;
const admin=async query=>{const client=new pg.Client({connectionString:new URL('/postgres',adminBase).href});await client.connect();try{await client.query(query);}finally{await client.end();}};
const run=(command,argv)=>new Promise(resolve=>spawn(command,argv,{env,stdio:'inherit'}).on('exit',code=>resolve(code??1)));
const children=[];
const start=(argv,name)=>{const child=spawn(process.execPath,argv,{env,stdio:['ignore','ignore','pipe']});child.stderr.on('data',chunk=>process.stderr.write(`[${name}] ${chunk}`));children.push(child);};

let code=1;
// The pinned port may already serve PostgreSQL (a shared test proxy); then the database is created through it instead.
let proxy=proxyPort===null?null:createServer(socket=>{const upstream=connect(Number(postgres.port||5432),postgres.hostname);socket.pipe(upstream).pipe(socket);socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());});
if(proxy)await new Promise((resolve,reject)=>proxy.once('error',error=>{if(error.code!=='EADDRINUSE')return reject(error);proxy=null;adminBase=new URL(databaseUrl.href);resolve();}).listen(proxyPort,'127.0.0.1',resolve));
await mkdir(out,{recursive:true});
await admin(`CREATE DATABASE ${database}`);
try{
  if(await run(process.execPath,['src/server/cli.ts','migrate']))throw new Error('Migration failed.');
  if(!selfHosted){start(['.output/server/index.mjs'],'server');if(!options.has('no-worker'))start(['src/server/cli.ts','worker'],'worker');}
  let ready=selfHosted;
  for(let attempt=0;attempt<80&&!ready;attempt++){ready=await fetch(origin+'/api/session').then(response=>response.ok,()=>false);if(!ready)await new Promise(resolve=>setTimeout(resolve,500));}
  if(!ready)throw new Error('The server did not become ready.');
  if(!unclaimed){
    const response=await fetch(origin+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({name:'Native browser owner',email:`owner-${hex(4)}@native-browser.test`,password:hex(16),workspaceName:'Native browser workspace'})});
    if(!response.ok)throw new Error(`Owner setup failed with ${response.status}.`);
  }
  code=await run(process.execPath,[suite]);
}catch(error){console.error(String(error instanceof Error?error.message:error));}
finally{
  for(const child of children)child.kill();
  await new Promise(resolve=>setTimeout(resolve,1000));
  await admin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(error=>console.error('Database cleanup failed:',error.message));
  proxy?.close();
}
console.log(`${suite} exit=${code}`);
process.exitCode=code;
