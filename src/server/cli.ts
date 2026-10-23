import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from './config.ts';
import { FoundationError } from './auth.ts';
import { assertSchema, closeDatabase, getDatabase } from './db.ts';
import { migrateDatabase, StartupError, startWhenDatabaseReady } from './startup-migrate.ts';
import { startWorker, stopJobs } from './jobs.ts';
import { assertCredentialKeys, rotateCredentialEncryption } from './providers.ts';
import { assertOidcCredentialsReadable, rotateOidcCredentials } from './oidc.ts';
import { assertGoogleCredentialsReadable, rotateGoogleCredentials } from './google.ts';
import {assertProviderAccountIdentityReadable,rotateProviderAccountIdentityEncryption} from './provider-account-identity.ts';
import { setInstanceOperator } from './instance-operators.ts';
import { closeAccountFromHost } from './account-security.ts';
import { quarantineRestoredSpending } from './restore-quarantine.ts';

class CliError extends Error {}

async function setup() {
  const password = randomBytes(32).toString('hex');
  const contents = [
    '# Keep this file private. Never commit it or paste it into support requests.',
    'APP_URL=http://localhost:3000', 'APP_PORT=3000',
    `POSTGRES_PASSWORD=${password}`,
    `DATABASE_URL=postgres://ten98:${password}@postgres:5432/ten98`,
    `AUTH_SECRET=${randomBytes(32).toString('hex')}`,
    `CREDENTIAL_KEYS=${JSON.stringify({ v1: randomBytes(32).toString('base64') })}`,
    'CREDENTIAL_ACTIVE_KEY=v1',
    'ARTIFACT_DIR=./data/artifacts', '',
  ].join('\n');
  try {
    await writeFile(join(process.cwd(), '.env'), contents, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('Setup stopped: .env already exists and was not changed.');
    throw new CliError('Setup could not create .env. Check directory permissions.');
  }
  console.log('Created .env with fresh credentials. No database was changed. Open the app and create the first account; it becomes the owner.');
}

async function migrate() {
  const applied = await migrateDatabase();
  console.log(applied.length ? `Database migrations applied: ${applied.join(', ')}.` : 'Database migrations already applied; all checksums verified.');
}

async function diagnose(checkWorker: boolean) {
  const config = getConfig();
  console.log('Configuration: valid (credentials redacted).');
  const checks: [string, () => Promise<unknown>][] = [
    ['Database connection', () => getDatabase().pool.query('SELECT 1')],
    ['Database schema', assertSchema],
    ['Provider credential keyring', assertCredentialKeys],
    ['Identity credential keyring', assertOidcCredentialsReadable],
    ['Google reporting credential keyring', assertGoogleCredentialsReadable],
    ['Provider account recovery keyring', assertProviderAccountIdentityReadable],
    ['Artifact directory', async () => {
      await mkdir(config.artifactDir, { recursive: true, mode: 0o700 });
      const path = join(config.artifactDir, `.write-check-${randomUUID()}`);
      await writeFile(path, '', { flag: 'wx', mode: 0o600 });
      await unlink(path);
    }],
  ];
  if (checkWorker) checks.push(['Worker heartbeat', async () => {
    const result = await getDatabase().pool.query(
      `SELECT 1 FROM worker_heartbeat WHERE id = 'foundation-worker'
       AND last_seen_at > now() - interval '30 seconds' AND last_seen_at <= now()`,
    );
    if (result.rows.length !== 1) throw new CliError('Worker has no recent heartbeat.');
  }]);
  for (const [label, check] of checks) {
    try {
      await check();
      console.log(`${label}: ready.`);
    } catch {
      console.error(`${label}: unavailable. Check configuration, permissions and service health.`);
      process.exitCode = 1;
    }
  }
}

/** The operator's step-up secret is JSON on standard input, never an argument or environment variable. */
async function readOperatorSecret(): Promise<unknown> {
  if (process.stdin.isTTY) throw new CliError('Pipe {"password":"…","code":"123456"} (or "backupCode") for the operator on standard input.');
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 4096) throw new CliError('The operator secret input is too large.'); }
  try { return JSON.parse(text); } catch { throw new CliError('The operator secret must be one JSON object.'); }
}

async function worker() {
  await startWhenDatabaseReady('worker', async () => {
    await assertSchema();
    await assertCredentialKeys();
    await assertOidcCredentialsReadable();
    await assertGoogleCredentialsReadable();
    await assertProviderAccountIdentityReadable();
    await startWorker();
  });
  console.log('Foundation worker ready. Explicit imports and owner-approved rank schedules are enabled.');
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
}

/** The container's web command: the schema is current before the built server is loaded, so it never serves an older one. */
async function startWeb() {
  await startWhenDatabaseReady('web', async () => {
    // The built server opens its own pool; this one is only for migration.
    await closeDatabase();
    await import(new URL('../../.output/server/index.mjs', import.meta.url).href);
  });
}

try {
  const [command, option, ...extra] = process.argv.slice(2);
  const usage = 'Usage: cli.ts setup | migrate | rekey | restore-quarantine | start-web | worker | diagnose [worker] | operator grant|revoke <existing-account-email> | account close <account-email> --operator <operator-email> --reason <text> (reason: 1-500 characters, no personal data; operator secret JSON on standard input)';
  const closing = command === 'account' && option === 'close' && extra.length === 5 && extra[1] === '--operator' && extra[3] === '--reason';
  if (command === 'operator' ? !['grant', 'revoke'].includes(option) || extra.length !== 1 : command === 'account' ? !closing : extra.length || (option && !(command === 'diagnose' && option === 'worker'))) {
    throw new CliError(usage);
  }
  switch (command) {
    case 'setup': await setup(); break;
    case 'migrate': await migrate(); break;
    case 'restore-quarantine': {
      await assertSchema();
      const result = await quarantineRestoredSpending();
      console.log(`Restore spending quarantine applied: ${result.pausedBudgets} budgets paused, ${result.cancelledReservations} reservations cancelled, ${result.disabledSchedules} schedules disabled.`);
      console.log('Keep workers stopped until restored imports, crawls and provider receipts are reviewed. No provider requests were made.');
      break;
    }
    case 'rekey': {
      await assertSchema();
      const providers = await rotateCredentialEncryption();
      const identities = await rotateOidcCredentials();
      await rotateGoogleCredentials();
      await rotateProviderAccountIdentityEncryption();
      console.log(`Re-encrypted ${providers} provider connections and ${identities} identity records with the active key. Keep old keys for backups.`);
      console.log('Google reporting credentials re-encrypted with the active key.');
      console.log('Provider account recovery keys re-encrypted with the active key.');
      break;
    }
    case 'operator': await assertSchema(); await setInstanceOperator(extra[0], option === 'grant'); console.log('Instance operator role updated and audited.'); break;
    case 'account': {
      await assertSchema();
      const secret = await readOperatorSecret();
      // Closure refusals (last owner, last operator, step-up) are user-safe messages; other failures stay generic.
      try { await closeAccountFromHost(extra[0], extra[2], extra[4], secret); }
      catch (error) { if (error instanceof FoundationError) throw new CliError(error.message); throw error; }
      console.log('Account closed and audited. Its sessions, credentials, API keys and memberships were removed.');
      break;
    }
    case 'start-web': await startWeb(); break;
    case 'worker': await worker(); break;
    case 'diagnose': await diagnose(option === 'worker'); break;
    default: throw new CliError(usage);
  }
} catch (error) {
  console.error(error instanceof CliError || error instanceof StartupError ? error.message
    : (error as { code?: string })?.code === 'SCHEMA_MISMATCH' ? 'Database schema is incompatible with this application. Use the matching image and migrations.'
    : 'Command failed. Check configuration, database availability, schema and filesystem permissions; credentials have been redacted.');
  process.exitCode = 1;
} finally {
  await stopJobs().catch(() => { console.error('Job shutdown failed.'); process.exitCode = 1; });
  await closeDatabase().catch(() => { console.error('Database shutdown failed.'); process.exitCode = 1; });
}
