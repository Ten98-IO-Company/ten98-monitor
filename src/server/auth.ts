import { randomUUID } from 'node:crypto'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { hashPassword } from 'better-auth/crypto'
import { twoFactor } from 'better-auth/plugins/two-factor'
import { APIError, createAuthEndpoint, isAPIError } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { getConfig } from './config.ts'
import { getDatabase } from './db.ts'
import * as schema from './schema.ts'

export type ResetPasswordMessage = { userId: string; email: string; token: string }

function createAuth(client?: PoolClient, captureReset?: (message: ResetPasswordMessage) => void) {
  const config = getConfig()
  const factors = twoFactor({
    issuer: 'ten98 Discover',
    // Browser routes still require either a local password or a one-use, fresh OIDC proof.
    allowPasswordless: true,
    backupCodeOptions: { amount: 10, length: 20 },
    accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 900 },
  })
  // Reuse the plugin's complete challenge lifecycle for verified OIDC logins.
  // The extra endpoint is server-only, so no browser can submit an arbitrary user ID.
  for (const hook of factors.hooks.after) {
    const original = hook.matcher
    hook.matcher = (context) => original(context) || (context.path === undefined && typeof context.body?.oidcUserId === 'string')
  }
  const oidcSessions = {
    id: 'ten98-oidc-session',
    endpoints: {
      rotateVerifiedSession: createAuthEndpoint.serverOnly({ method: 'POST', body: z.object({ verifiedUserId: z.uuid() }).strict() }, async (context) => {
        const user = await context.context.internalAdapter.findUserById(context.body.verifiedUserId)
        if (!user) throw APIError.fromStatus('UNAUTHORIZED')
        const session = await context.context.internalAdapter.createSession(user.id, false)
        if (!session) throw APIError.fromStatus('INTERNAL_SERVER_ERROR')
        await setSessionCookie(context, { user, session })
        return context.json({ ok: true })
      }),
      completeOidcSession: createAuthEndpoint.serverOnly({ method: 'POST', body: z.object({ oidcUserId: z.uuid() }).strict() }, async (context) => {
        const user = await context.context.internalAdapter.findUserById(context.body.oidcUserId)
        if (!user) throw APIError.fromStatus('UNAUTHORIZED')
        const session = await context.context.internalAdapter.createSession(user.id, false)
        if (!session) throw APIError.fromStatus('INTERNAL_SERVER_ERROR')
        await setSessionCookie(context, { user, session })
        return context.json({ ok: true })
      }),
    },
  }
  return betterAuth({
    database: drizzleAdapter(client ? drizzle(client, { schema }) : getDatabase().db, { provider: 'pg', schema }),
    baseURL: config.appUrl,
    secret: config.authSecret,
    // Self-hosted installs send no data to Ten98 or third parties; getConfig also refuses BETTER_AUTH_TELEMETRY.
    telemetry: { enabled: false },
    trustedOrigins: [config.appUrl],
    appName: 'ten98 Discover',
    // Database adapter failures can contain query parameters. Report safe errors at our API boundary.
    logger: { disabled: true },
    // better-call logs non-API exceptions even when the Better Auth logger is off.
    // Convert them before its fallback logger can expose SQL, hashes or session tokens.
    onAPIError: { onError(error) {
      if (isAPIError(error)) throw error
      throw APIError.fromStatus('INTERNAL_SERVER_ERROR')
    } },
    session: { cookieCache: { enabled: false } },
    plugins: [factors, oidcSessions],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      // Capture only; the security boundary sends after the outer transaction commits.
      sendResetPassword: captureReset ? async ({ user, token }) => { captureReset({ userId: user.id, email: user.email, token }) } : undefined,
    },
    // api.ts enforces shared and per-email database limits. No proxy IP is trusted yet.
    rateLimit: { enabled: false },
  })
}

let auth: ReturnType<typeof createAuth> | undefined

export function getAuth(client?: PoolClient, captureReset?: (message: ResetPasswordMessage) => void) {
  // Security routes bind every library query to one PostgreSQL transaction.
  if (client) return createAuth(client, captureReset)
  if (captureReset) throw new Error('Password recovery requires a transaction.')
  return (auth ??= createAuth())
}

export class FoundationError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'FoundationError'
    this.status = status
  }
}

// The first sign-up claims an unclaimed installation; there is no setup token (owner decision, 2026-10-23).
// A page cached across the upgrade, or @ten98/ui 0.23.0's form, may still send `token`: accept it and discard it unread.
const claimInput = z.object({
  token: z.string().max(512).optional(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().max(254).email(),
  password: z.string().min(12).max(128),
  workspaceName: z.string().trim().max(120)
    .transform((value) => value || 'My workspace')
    .default('My workspace'),
}).strict()

export async function claimInstallation(input: z.input<typeof claimInput>): Promise<void> {
  const result = claimInput.safeParse(input)
  if (!result.success) {
    throw new FoundationError(400, 'Check your setup details. Use a valid email and a password between 12 and 128 characters.')
  }

  const { token: _ignoredToken, ...details } = result.data
  const client = await getDatabase().pool.connect()
  try {
    await client.query('BEGIN')
    const installation = await client.query<{ claimed: boolean }>(
      'SELECT claimed FROM installation WHERE id = $1 FOR UPDATE', ['instance'],
    )
    if (!installation.rows[0]) {
      throw new FoundationError(503, 'Setup is unavailable. Apply database migrations and try again.')
    }
    if (installation.rows[0].claimed) {
      throw new FoundationError(409, 'Setup is complete. Sign in with the owner account.')
    }

    // Use Better Auth's own hash format and credential identity conventions.
    const password = await hashPassword(details.password)
    const userId = randomUUID()
    const workspaceId = randomUUID()
    await client.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, false, now(), now())`,
      [userId, details.name, details.email],
    )
    await client.query(
      `INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       VALUES ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomUUID(), userId, password],
    )
    await client.query(
      'INSERT INTO workspace (id, name, created_at) VALUES ($1, $2, now())',
      [workspaceId, details.workspaceName],
    )
    await client.query(
      "INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workspaceId, userId],
    )
    await client.query("INSERT INTO instance_operator(user_id,source) VALUES($1,'bootstrap')", [userId])
    await client.query("INSERT INTO instance_operator_audit(user_id,action) VALUES($1,'bootstrap')", [userId])
    await client.query('UPDATE installation SET claimed = true WHERE id = $1', ['instance'])
    await client.query('COMMIT')
  } catch (error) {
    // The caller returns a generic failure for unexpected database errors.
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
