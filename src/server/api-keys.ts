import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';
import {workspaceRoles,type WorkspaceRole} from '@ten98/runtime';

export const apiKeyScopes = ['projects:read', 'projects:write', 'analytics:read', 'events:write', 'team:read', 'prompts:read', 'prompts:write', 'context:read', 'context:write', 'segments:read', 'annotations:read', 'rank:read', 'keywords:read', 'google:read', 'domains:read', 'audits:read'] as const;
export type ApiKeyScope = typeof apiKeyScopes[number];
type Role = WorkspaceRole;
export type ApiKeyDto = {
  id: string; workspaceId: string; issuerUserId: string; name: string; scopes: ApiKeyScope[];
  createdAt: Date; expiresAt: Date; revokedAt: Date | null;
  /** Scheme plus the first 8 token characters; null for keys created before prefixes were recorded. */
  displayPrefix: string | null; lastUsedAt: Date | null;
};
export type ApiKeyPrincipal = { id: string; userId: string; workspaceId: string; role: Role; scopes: ApiKeyScope[] };
const idInput = z.uuid();
const createInput = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(apiKeyScopes)).min(1).max(apiKeyScopes.length).refine((scopes) => new Set(scopes).size === scopes.length),
  expiresInDays: z.number().int().min(1).max(365).default(90),
}).strict();
const fields = 'id,workspace_id AS "workspaceId",issuer_user_id AS "issuerUserId",name,scopes,created_at AS "createdAt",expires_at AS "expiresAt",revoked_at AS "revokedAt",display_prefix AS "displayPrefix",last_used_at AS "lastUsedAt"';

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new FoundationError(400, 'Check the submitted API key fields and try again.');
  return result.data;
}

function invalidKey(): never { throw new FoundationError(401, 'The API key is invalid, expired or unavailable.'); }
function validToken(token: string): boolean {
  if (!/^t98k_[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const bytes = Buffer.from(token.slice(5), 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === token.slice(5);
}
function digest(token: string) { return createHash('sha256').update(token).digest('hex'); }
// 8 of the 43 base64url characters disclose 48 of the token's 256 random bits and leave 208 secret, far above the 128-bit
// floor, while still telling keys apart at a glance. Recorded only at creation; never derived from the stored hash.
const displayPrefixLength = 't98k_'.length + 8;

export function parseApiKeyHeaders(headers: Headers): string | null {
  const authorization = headers.get('authorization');
  if (headers.has('x-api-key') || (authorization !== null && headers.has('cookie'))) {
    throw new FoundationError(400, 'Use one Authorization Bearer header without cookies or additional API key headers.');
  }
  if (authorization === null) return null;
  const match = /^Bearer (t98k_[A-Za-z0-9_-]{43})$/i.exec(authorization);
  if (!match || !validToken(match[1])) invalidKey();
  return match[1];
}

// Explicit allowlist: a future scope is denied to viewers until it is named here.
const viewerScopes = new Set<ApiKeyScope>(['projects:read', 'analytics:read', 'prompts:read', 'context:read', 'segments:read', 'annotations:read', 'rank:read', 'keywords:read', 'google:read', 'audits:read']);
function allows(role: Role, scope: ApiKeyScope): boolean {
  if (role === 'owner' || role === 'admin') return true;
  if (scope === 'team:read' || scope === 'domains:read') return false;
  if (role === 'editor') return true;
  return role === 'viewer' && viewerScopes.has(scope);
}

async function managed<T>(workspaceId: string, userId: string, run: (client: PoolClient, role: 'owner' | 'admin') => Promise<T>): Promise<T> {
  parse(idInput, workspaceId); parse(idInput, userId);
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    // Team mutations and protected writes use this same lock before checking current authority.
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [workspaceId]);
    const member = await client.query<{ role: Role }>('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
    const role = member.rows[0]?.role;
    if (role !== 'owner' && role !== 'admin') throw new FoundationError(404, 'Workspace not found or unavailable.');
    const result = await run(client, role);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function createApiKey(workspaceId: string, userId: string, input: unknown): Promise<{ key: ApiKeyDto; token: string }> {
  const details = parse(createInput, input);
  return managed(workspaceId, userId, async (client, role) => {
    if (details.scopes.some((scope) => !allows(role, scope))) throw new FoundationError(403, 'These scopes exceed your current workspace role.');
    const token = `t98k_${randomBytes(32).toString('base64url')}`;
    const result = await client.query<ApiKeyDto>(
      `INSERT INTO api_key(id,workspace_id,issuer_user_id,name,token_hash,scopes,expires_at,display_prefix)
       VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7::integer*interval '1 day',$8) RETURNING ${fields}`,
      [randomUUID(), workspaceId, userId, details.name, digest(token), details.scopes, details.expiresInDays, token.slice(0, displayPrefixLength)],
    );
    return { key: result.rows[0], token };
  });
}

export async function listApiKeys(workspaceId: string, userId: string): Promise<{ keys: ApiKeyDto[] }> {
  return managed(workspaceId, userId, async (client) => ({
    keys: (await client.query<ApiKeyDto>(`SELECT ${fields} FROM api_key WHERE workspace_id=$1 ORDER BY created_at DESC,id`, [workspaceId])).rows,
  }));
}

export async function revokeApiKey(workspaceId: string, userId: string, keyId: string): Promise<void> {
  parse(idInput, keyId);
  await managed(workspaceId, userId, async (client) => {
    const result = await client.query('UPDATE api_key SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE workspace_id=$1 AND id=$2 RETURNING id', [workspaceId, keyId]);
    if (!result.rowCount) throw new FoundationError(404, 'API key not found or unavailable.');
  });
}

// Records a successful use at most once a minute per key. It runs on its own pooled connection and is not awaited, so a
// request neither waits for it nor holds its row lock; SKIP LOCKED leaves a row another transaction holds to a later use.
// A request may authenticate more than once, so one write per key is in flight per process; others are dropped, not queued.
const recordingUse = new Set<string>();
function recordApiKeyUse(id: string): void {
  if (recordingUse.has(id)) return;
  recordingUse.add(id);
  void getDatabase().pool.query(
    `UPDATE api_key SET last_used_at=clock_timestamp() WHERE id=(SELECT id FROM api_key WHERE id=$1
       AND (last_used_at IS NULL OR last_used_at<clock_timestamp()-interval '1 minute') FOR NO KEY UPDATE SKIP LOCKED)`, [id],
  ).catch(() => console.error('API key last-used update failed; check database availability.'))
    .finally(() => recordingUse.delete(id));
}

export async function authenticateApiKey(token: string, client?: Pick<PoolClient, 'query'>): Promise<ApiKeyPrincipal> {
  if (typeof token !== 'string' || !validToken(token)) invalidKey();
  const result = await (client ?? getDatabase().pool).query<ApiKeyPrincipal & { useDue: boolean }>(
    `SELECT k.id,k.issuer_user_id AS "userId",k.workspace_id AS "workspaceId",m.role,k.scopes,
       (k.last_used_at IS NULL OR k.last_used_at<clock_timestamp()-interval '1 minute') AS "useDue"
     FROM api_key k JOIN membership m ON m.workspace_id=k.workspace_id AND m.user_id=k.issuer_user_id JOIN "user" u ON u.id=k.issuer_user_id
     WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp() AND u.closed_at IS NULL
       AND (u."twoFactorEnabled" OR NOT EXISTS (SELECT 1 FROM workspace_two_factor_requirement r WHERE r.workspace_id=k.workspace_id))`, [digest(token)],
  );
  const row = result.rows[0];
  if (!row || !workspaceRoles.includes(row.role as WorkspaceRole)) invalidKey();
  const { useDue, ...principal } = row;
  if (useDue) recordApiKeyUse(principal.id);
  return { ...principal, scopes: principal.scopes.filter((scope) => apiKeyScopes.includes(scope) && allows(principal.role, scope)) };
}

// For mutations, call after reading the request body, inside the transaction holding the workspace lock.
export async function authorizeApiKey(token: string, workspaceId: string, scope: ApiKeyScope, client?: Pick<PoolClient, 'query'>): Promise<ApiKeyPrincipal> {
  const principal = await authenticateApiKey(token, client);
  if (principal.workspaceId !== workspaceId) throw new FoundationError(404, 'Workspace not found or unavailable.');
  if (!principal.scopes.includes(scope)) throw new FoundationError(403, 'The API key does not permit this action.');
  return principal;
}
