import { afterEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
// Load the standalone JavaScript CLI without coupling it to application typings.
const { checkStorage, createSetup, readSetup, validateOptions } = await import(new URL('../scripts/docker-setup.mjs', import.meta.url).href);

const GOOD = Object.freeze({ mode: 'proxy', url: 'https://app.example.com', port: '8080', project: 'demo' });

const owned: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dkr-setup-'));
  owned.push(d);
  return d;
}
afterEach(() => {
  for (const d of owned.splice(0)) {
    assert.ok(dirname(resolve(d)) === resolve(tmpdir()) && basename(d).startsWith('dkr-setup-'));
    rmSync(d, { recursive: true, force: true });
  }
});

test('validateOptions accepts canonical valid input', () => {
  const localIp = validateOptions({ mode: 'local', url: 'http://127.0.0.1:8080/', port: '8080', project: 'demo' });
  assert.ok(localIp.url === 'http://127.0.0.1:8080' && localIp.port === '8080' && localIp.mode === 'local');
  const localHost = validateOptions({ mode: 'local', url: 'http://localhost:8080', port: '8080', project: 'demo' });
  assert.ok(localHost.url === 'http://localhost:8080');
  const proxySlash = validateOptions({ ...GOOD, url: 'https://app.example.com/' });
  assert.ok(proxySlash.url === 'https://app.example.com');
  const proxyPort = validateOptions({ ...GOOD, url: 'https://app.example.com:8443' });
  assert.ok(proxyPort.url === 'https://app.example.com:8443');
  const caddy = validateOptions({ mode: 'caddy', url: 'https://app.example.com', port: '8080', project: 'demo' });
  assert.ok(caddy.url === 'https://app.example.com');
});

test('validateOptions rejects bad input', () => {
  const bad = [
    { ...GOOD, mode: 'k8s' },
    { ...GOOD, url: 'http://app.example.com' }, // non-https public
    { ...GOOD, url: 'https://localhost' },
    { ...GOOD, url: 'https://foo.localhost' },
    { ...GOOD, url: 'https://127.0.0.1' },
    { ...GOOD, url: 'https://10.1.2.3' },
    { ...GOOD, url: 'https://app.internal' },
    { ...GOOD, url: 'https://*.example.com' },
    { mode: 'caddy', url: 'https://app.example.com:8443', port: '8080', project: 'demo' },
    { ...GOOD, url: 'https://app.example.com/?q=1' },
    { ...GOOD, url: 'https://app.example.com/#frag' },
    { ...GOOD, url: 'https://app.example.com/path' },
    { ...GOOD, url: 'https://user:pw@app.example.com' },
    { ...GOOD, url: 'https://app.exa\nmple.com' },
    { ...GOOD, url: 'https://app.example.com:99999' },
    { ...GOOD, port: '80' },
    { ...GOOD, port: '65536' },
    { ...GOOD, port: '08080' },
    { ...GOOD, port: '8080.0' },
    { ...GOOD, port: '8080 ' },
    { ...GOOD, project: 'Demo' },
    { ...GOOD, project: '-demo' },
    { ...GOOD, project: 'a'.repeat(64) },
    { ...GOOD, project: 'bad project' },
    { ...GOOD, sneaky: 'x' },
    { mode: 'proxy', url: 'https://app.example.com', port: '8080' },
    { mode: 'local', url: 'http://localhost:8080', port: '8081', project: 'demo' },
    { mode: 'local', url: 'https://localhost:8080', port: '8080', project: 'demo' },
    { mode: 'local', url: 'http://example.com:8080', port: '8080', project: 'demo' },
  ];
  for (const b of bad) assert.throws(() => validateOptions(b), Error);
});

test('createSetup writes a private env with well-formed secrets', () => {
  const d = tmp();
  createSetup(d, GOOD);
  const env = parseEnv(readFileSync(join(d, '.env'), 'utf8'));
  const secrets = [env.POSTGRES_PASSWORD, env.AUTH_SECRET];
  assert.ok(secrets.every((s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)));
  assert.ok(new Set(secrets).size === 2);
  // The first account created in the app becomes the owner; no setup token is generated.
  assert.ok(!Object.hasOwn(env, 'BOOTSTRAP_TOKEN'));
  const keys = JSON.parse(env.CREDENTIAL_KEYS ?? '') as Record<string, string>;
  const values = Object.values(keys);
  assert.ok(values.length === 1 && Buffer.from(values[0], 'base64').length === 32);
  assert.ok(env.CREDENTIAL_ACTIVE_KEY === 'v1' && Object.hasOwn(keys, 'v1'));
  assert.ok(env.DATABASE_URL === `postgresql://ten98:${env.POSTGRES_PASSWORD}@postgres:5432/ten98`);
  assert.ok(env.DEPLOYMENT_MODE === GOOD.mode && env.APP_URL === GOOD.url);
  assert.ok(env.APP_PORT === GOOD.port && env.COMPOSE_PROJECT_NAME === GOOD.project);
  assert.ok(env.TEN98_IMAGE === `ten98-monitor:${GOOD.project}`);
  if (process.platform !== 'win32') {
    assert.ok((lstatSync(join(d, '.env')).mode & 0o777) === 0o600);
  }
});

test('second setup refuses and leaves the file unchanged', () => {
  const d = tmp();
  const p = join(d, '.env');
  createSetup(d, GOOD);
  const before = readFileSync(p, 'utf8');
  assert.throws(() => createSetup(d, GOOD), /could not be created/);
  assert.ok(readFileSync(p, 'utf8') === before);
});

test('readSetup returns only the four public fields', () => {
  const d = tmp();
  createSetup(d, GOOD);
  const v = readSetup(d) as Record<string, unknown>;
  assert.deepEqual(Object.keys(v).sort(), ['mode', 'port', 'project', 'url']);
  assert.ok(v.mode === GOOD.mode && v.url === GOOD.url && v.port === GOOD.port && v.project === GOOD.project);
});

test('an older env file that still defines BOOTSTRAP_TOKEN keeps working', () => {
  const d = tmp();
  createSetup(d, GOOD);
  writeFileSync(join(d, '.env'), readFileSync(join(d, '.env'), 'utf8') + `BOOTSTRAP_TOKEN=${'c'.repeat(64)}\n`);
  const v = readSetup(d) as Record<string, unknown>;
  assert.ok(v.mode === GOOD.mode && v.url === GOOD.url && v.port === GOOD.port && v.project === GOOD.project);
});

test('symlink env file is refused', (t: TestContext) => {
  const d = tmp();
  const target = join(d, 'real.env');
  writeFileSync(target, 'DEPLOYMENT_MODE=proxy\n');
  try {
    symlinkSync(target, join(d, '.env'));
  } catch {
    t.skip('symlinks not permitted on this platform');
    return;
  }
  assert.throws(() => readSetup(d), /missing or invalid/);
  assert.throws(() => createSetup(d, GOOD), /could not be created/);
});

test('tampered secrets or keyring reject without leaking values', () => {
  const d = tmp();
  const p = join(d, '.env');
  createSetup(d, GOOD);
  const original = readFileSync(p, 'utf8');

  const badSecret = 'z'.repeat(64);
  writeFileSync(p, original.replace(/^POSTGRES_PASSWORD=[0-9a-f]{64}$/m, `POSTGRES_PASSWORD=${badSecret}`));
  assert.throws(() => readSetup(d), (error: unknown) => error instanceof Error && !error.message.includes(badSecret));

  writeFileSync(p, original.replace(/^CREDENTIAL_KEYS=.*$/m, "CREDENTIAL_KEYS='not-json'"));
  assert.throws(() => readSetup(d), /missing or invalid/);

  writeFileSync(p, original.replace(/^CREDENTIAL_ACTIVE_KEY=.*$/m, 'CREDENTIAL_ACTIVE_KEY=v2'));
  assert.throws(() => readSetup(d), /missing or invalid/);
});

test('checkStorage removes its probe and reports available bytes', () => {
  const d = tmp();
  const n = checkStorage(d);
  assert.ok(typeof n === 'number' && Number.isFinite(n) && n >= 0);
  assert.ok(readdirSync(d).every((f) => !f.startsWith('.probe-')));
});

test('host helper preserves existing Docker state and stops after failed migration', { skip: process.platform === 'win32' }, () => {
  const directory = tmp();
  mkdirSync(join(directory, 'scripts'));
  mkdirSync(join(directory, 'bin'));
  copyFileSync(new URL('../scripts/deploy.sh', import.meta.url), join(directory, 'scripts/deploy.sh'));
  writeFileSync(join(directory, 'bin/docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$CHECK_LOG"
case "$*" in
  'context inspect '*) printf '%s\\n' unix:///var/run/docker.sock ;;
  'version '*) printf '%s\\n' '29.0.0 linux' ;;
  'compose up --help') printf '%s\\n' --wait-timeout ;;
  'info '*) printf '%s\\n' 'test resource information' ;;
  'volume ls '*) [ "$CHECK_MODE" != existing ] || printf '%s\\n' saved-pgdata ;;
  'ps -aq '*) : ;;
  'volume inspect '*) exit 1 ;;
  'build '*) : ;;
  'tag '*) : ;;
  'run '*'/app/scripts/docker-setup.mjs storage') : ;;
  'run '*'/app/scripts/docker-setup.mjs inspect') printf '%s\\n' 'local http://localhost:33333 33333 safe-test' ;;
  'run '*'-p '*) : ;;
  'compose '*'config --quiet') : ;;
  'compose '*'ps --status running -q web') : ;;
  'compose '*'stop web worker') : ;;
  'compose '*'run --rm migrate') exit 23 ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
  const log = join(directory, 'commands.log');
  const env = { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, CHECK_LOG: log, CHECK_MODE: 'existing', DOCKER_HOST: 'unix:///var/run/docker.sock' };
  const existing = spawnSync('sh', ['scripts/deploy.sh', 'local', 'http://localhost:33333', '33333', 'safe-test'], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(existing.status, 1);
  assert.match(existing.stderr, /already has Docker state/);
  assert.ok(!readFileSync(log, 'utf8').includes('build '));
  writeFileSync(log, '');
  writeFileSync(join(directory, '.env'), 'existing private configuration');
  const failedMigration = spawnSync('sh', ['scripts/deploy.sh'], { cwd: directory, env: { ...env, CHECK_MODE: 'migration' }, encoding: 'utf8' });
  assert.equal(failedMigration.status, 1);
  assert.match(failedMigration.stderr, /Migration failed/);
  assert.ok(!readFileSync(log, 'utf8').includes('up -d'));
  assert.equal(readFileSync(join(directory, '.env'), 'utf8'), 'existing private configuration');
});
