// Dependency-free Node 24 ESM setup helper for the application image.
// Runs natively or in the container with cwd = operator-owned setup directory.
// APP_PORT is the private loopback upstream port; it never depends on the public URL port.
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const ENV_NAME = '.env';
const MAX_ENV_BYTES = 16384;
const MODES = new Set(['local', 'proxy', 'caddy']);
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SECRET_RE = /^[0-9a-f]{64}$/;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const BLOCKED_TLDS = new Set(['localhost', 'local', 'internal']);

class SafeError extends Error {}
function fail(message) {
  throw new SafeError(message);
}

// Accept only the exact canonical origin (one harmless trailing slash allowed).
// The strict equality check rejects query, hash, userinfo, paths, default-port
// noise, and any whitespace/control-character tricks the URL parser rewrites.
function parseCanonicalUrl(raw) {
  if (typeof raw !== 'string' || /[\s\x00-\x1f\x7f]/.test(raw)) fail('invalid url');
  let u;
  try {
    u = new URL(raw);
  } catch {
    fail('invalid url');
  }
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  if (u.origin === 'null' || trimmed !== u.origin) fail('invalid url');
  return u;
}

function requirePublicDns(host) {
  if (!host || host.startsWith('[') || /^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    fail('url host must be a public dns name, not an ip');
  }
  const labels = host.split('.');
  if (labels.length < 2) fail('url host must be a public dns name');
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) fail('url host must be a public dns name');
  }
  if (BLOCKED_TLDS.has(labels[labels.length - 1])) fail('url host must not be internal');
}

export function validateOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) fail('invalid options');
  if (Object.keys(options).sort().join(',') !== 'mode,port,project,url') fail('invalid options');
  const { mode, url, port, project } = options;
  if (!MODES.has(mode)) fail('invalid mode');
  if (typeof project !== 'string' || !PROJECT_RE.test(project)) fail('invalid project name');
  if (typeof port !== 'string' || !/^\d+$/.test(port) || String(Number(port)) !== port) fail('invalid port');
  const portNum = Number(port);
  if (portNum < 1024 || portNum > 65535) fail('invalid port');
  const u = parseCanonicalUrl(url);
  if (mode === 'local') {
    if (u.protocol !== 'http:' || (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1')) {
      fail('local url must be http://localhost:PORT or http://127.0.0.1:PORT');
    }
    if (u.port !== port) fail('local url port must match port');
  } else {
    if (u.protocol !== 'https:') fail('public url must be https');
    requirePublicDns(u.hostname);
    if (mode === 'caddy' && u.port !== '') fail('caddy url must not set a custom port');
  }
  return { mode, url: u.origin, port, project };
}

export function createSetup(directory, options) {
  const v = validateOptions(options);
  const hex = () => randomBytes(32).toString('hex');
  const [postgres, auth] = [hex(), hex()];
  const keyring = JSON.stringify({ v1: randomBytes(32).toString('base64') });
  const content = [
    `DEPLOYMENT_MODE=${v.mode}`,
    `COMPOSE_PROJECT_NAME=${v.project}`,
    `TEN98_IMAGE=ten98-monitor:${v.project}`,
    `APP_URL=${v.url}`,
    `APP_PORT=${v.port}`,
    `POSTGRES_PASSWORD=${postgres}`,
    `AUTH_SECRET=${auth}`,
    `DATABASE_URL=postgresql://ten98:${postgres}@postgres:5432/ten98`,
    'ARTIFACT_DIR=./data/artifacts',
    `CREDENTIAL_KEYS='${keyring}'`,
    'CREDENTIAL_ACTIVE_KEY=v1',
    '',
  ].join('\n');
  const path = join(directory, ENV_NAME);
  try {
    // Exclusive create with 0600: an existing path (even a symlink) fails,
    // so a previous .env is never adopted, rewritten, or forced.
    writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch {
    fail('setup file could not be created (it may already exist)');
  }
  return path;
}

function isCanonicalKey(value) {
  if (typeof value !== 'string' || value.length !== 44) return false;
  const buf = Buffer.from(value, 'base64');
  return buf.length === 32 && buf.toString('base64') === value;
}

export function readSetup(directory) {
  try {
    const path = join(directory, ENV_NAME);
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_ENV_BYTES) fail('bad file');
    const env = parseEnv(readFileSync(path, 'utf8'));
    const v = validateOptions({
      mode: env.DEPLOYMENT_MODE,
      url: env.APP_URL,
      port: env.APP_PORT,
      project: env.COMPOSE_PROJECT_NAME,
    });
    if (env.TEN98_IMAGE !== `ten98-monitor:${v.project}`) fail('bad image selection');
    // An older file's BOOTSTRAP_TOKEN is ignored: the first account created in the app becomes the owner.
    const secrets = [env.POSTGRES_PASSWORD, env.AUTH_SECRET];
    if (secrets.some((s) => typeof s !== 'string' || !SECRET_RE.test(s)) || new Set(secrets).size !== 2) {
      fail('bad secrets');
    }
    const keys = JSON.parse(env.CREDENTIAL_KEYS ?? '');
    if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) fail('bad keyring');
    const ids = Object.keys(keys);
    if (ids.length < 1 || ids.length > 8) fail('bad keyring');
    for (const id of ids) {
      if (!KEY_ID_RE.test(id) || !isCanonicalKey(keys[id])) fail('bad keyring');
    }
    if (!Object.hasOwn(keys, env.CREDENTIAL_ACTIVE_KEY ?? '')) fail('bad keyring');
    return v;
  } catch {
    // One fixed message: never leaks file content, secrets, or raw errors.
    fail('setup file is missing or invalid');
  }
}

export function checkStorage(directory) {
  const probe = join(directory, `.probe-${randomBytes(8).toString('hex')}`);
  try {
    writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
  } catch {
    fail('storage directory is not writable');
  }
  try {
    const st = statfsSync(directory);
    return Number(BigInt(st.bavail) * BigInt(st.bsize));
  } catch {
    fail('storage capacity is unavailable');
  } finally {
    try {
      unlinkSync(probe); // only the probe we just created is ever removed
    } catch {
      // ignore cleanup races
    }
  }
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const directory = process.cwd();
  try {
    if (cmd === 'setup' && rest.length === 4) {
      const [mode, url, port, project] = rest;
      const path = createSetup(directory, { mode, url, port, project });
      console.log(`Created ${path}; POSIX mode 0600 requested. Check host access permissions.`);
      console.log('the first account created in the app becomes the owner; create it before sharing the URL');
    } else if (cmd === 'inspect' && rest.length === 0) {
      const v = readSetup(directory);
      console.log(`${v.mode} ${v.url} ${v.port} ${v.project}`);
    } else if (cmd === 'storage' && rest.length === 0) {
      const bytes = checkStorage(directory);
      console.log('writable: yes');
      console.log(`available-bytes: ${bytes}`);
      console.log('note: named-volume capacity may differ from this directory');
    } else {
      console.error('usage: docker-setup.mjs setup MODE URL PORT PROJECT | inspect | storage');
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(`error: ${e instanceof SafeError ? e.message : 'operation failed'}`);
    process.exitCode = 1;
  }
}
