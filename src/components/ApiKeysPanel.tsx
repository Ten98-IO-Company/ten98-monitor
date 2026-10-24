import { useEffect, useRef, useState } from 'react'
import { EmptyState, InlineCode, Text, useConfirmDialog } from '@ten98/ui'
import type { FormEvent } from 'react'
import { api, ApiError, errMsg } from '../lib/api'
import { formatRelativeInstant } from '../lib/report-time'

interface ApiKey {
  id: string
  workspaceId: string
  issuerUserId: string
  name: string
  scopes: string[]
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  displayPrefix: string | null
  lastUsedAt: string | null
}

interface CreatedKey {
  key: ApiKey
  token: string
}

const SCOPES: { value: string; label: string }[] = [
  { value: 'projects:read', label: 'Read projects' },
  { value: 'projects:write', label: 'Create and edit projects' },
  { value: 'analytics:read', label: 'Read analytics' },
  { value: 'events:write', label: 'Send events' },
  { value: 'team:read', label: 'Read team members' },
  { value: 'prompts:read', label: 'Read authored prompts' },
  { value: 'prompts:write', label: 'Create and edit authored prompts' },
  { value: 'context:read', label: 'Read project context' },
  { value: 'context:write', label: 'Edit project context' },
  { value: 'segments:read', label: 'Read saved filters and cohorts' },
  { value: 'annotations:read', label: 'Read annotations' },
  { value: 'rank:read', label: 'Read rank trackers and rank reports' },
  { value: 'keywords:read', label: 'Read saved keywords' },
  { value: 'google:read', label: 'Read Google sources and saved report snapshots' },
  { value: 'domains:read', label: 'Read domains and redirect checks' },
  { value: 'audits:read', label: 'Read site audit history and issues' },
]

export function ApiKeysPanel({ workspaceId, onUnauthorized }: { workspaceId: string; onUnauthorized: () => void }) {
  // key discards previous workspace state and one-time secrets synchronously on switch
  return <ApiKeysInner key={workspaceId} workspaceId={workspaceId} onUnauthorized={onUnauthorized} />
}

function ApiKeysInner({ workspaceId, onUnauthorized }: { workspaceId: string; onUnauthorized: () => void }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [confirm, confirmDialog] = useConfirmDialog({ danger: true })
  const [listError, setListError] = useState('')
  const [created, setCreated] = useState<CreatedKey | null>(null)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [days, setDays] = useState('90')
  const [formError, setFormError] = useState('')
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const alive = useRef(true)
  const reqSeq = useRef(0)
  const getAbort = useRef<AbortController | null>(null)
  const controllers = useRef<Set<AbortController>>(new Set())
  const mutLock = useRef(false) // synchronous lock: blocks duplicate mutations before React state lands
  const createdId = useRef<string | null>(null)
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized
  const busy = loading || creating || revokingId !== null

  function applyCreated(c: CreatedKey | null) {
    createdId.current = c ? c.key.id : null
    setCreated(c)
    if (!c) { setCopied(false); setCopyError('') }
  }

  function track(ac: AbortController) {
    controllers.current.add(ac)
    return () => controllers.current.delete(ac)
  }

  async function load() {
    const seq = ++reqSeq.current
    getAbort.current?.abort()
    const ac = new AbortController()
    getAbort.current = ac
    setLoading(true)
    const untrack = track(ac)
    try {
      const data = await api<{ keys: ApiKey[] }>(`/api/workspaces/${workspaceId}/api-keys`, { signal: ac.signal })
      if (!alive.current || ac.signal.aborted || seq !== reqSeq.current) return
      setKeys(data.keys)
      setListError('')
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
      if (!alive.current || ac.signal.aborted || seq !== reqSeq.current) return
      handleHttpError(e, 'load')
    } finally {
      untrack()
      if (alive.current && !ac.signal.aborted && seq === reqSeq.current) setLoading(false)
    }
  }

  // 401 hands off to the app; 403/404 wipes cached privileged data and one-time secrets
  function handleHttpError(e: unknown, context: 'load' | 'mutation') {
    if (e instanceof ApiError && e.status === 401) {
      applyCreated(null)
      setKeys(null)
      unauthorized.current()
      return
    }
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
      setKeys(null)
      applyCreated(null)
      ++reqSeq.current
      getAbort.current?.abort()
      setLoading(false)
      setListError('You no longer have permission to manage API keys for this workspace. Retry to check your access again.')
      return
    }
    const msg = errMsg(e)
    if (context === 'load') setListError(msg)
    else setFormError(msg)
  }

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
      reqSeq.current++
      getAbort.current?.abort()
      for (const ac of controllers.current) ac.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function createKey(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (mutLock.current || loading || !keys) return
    const trimmed = name.trim()
    const d = Number(days)
    if (trimmed.length < 1 || trimmed.length > 80) {
      setFormError('Give the key a name between 1 and 80 characters.')
      return
    }
    if (scopes.length === 0) {
      setFormError('Select at least one scope so the key can do something.')
      return
    }
    if (!Number.isInteger(d) || d < 1 || d > 365) {
      setFormError('Expiration must be a whole number of days between 1 and 365.')
      return
    }
    mutLock.current = true
    ++reqSeq.current
    getAbort.current?.abort()
    setCreating(true)
    setFormError('')
    applyCreated(null) // discard any previous one-time token before starting a new creation
    const ac = new AbortController()
    const untrack = track(ac)
    try {
      const data = await api<CreatedKey>(`/api/workspaces/${workspaceId}/api-keys`, {
        method: 'POST',
        body: { name: trimmed, scopes, expiresInDays: d },
        signal: ac.signal,
      })
      if (!alive.current || ac.signal.aborted) return
      applyCreated(data)
      setName('')
      setScopes([])
      setDays('90')
      await load()
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      if (!alive.current || ac.signal.aborted) return
      handleHttpError(err, 'mutation')
    } finally {
      untrack()
      mutLock.current = false
      if (alive.current && !ac.signal.aborted) setCreating(false)
    }
  }

  async function revokeKey(k: ApiKey) {
    if (mutLock.current || loading || !keys) return
    if (!await confirm({ title: `Revoke "${k.name}"?`, description: 'Anything using this key loses access immediately. This cannot be undone.', confirmLabel: 'Revoke key', confirmationText: k.name })) return
    if (mutLock.current) return
    mutLock.current = true
    ++reqSeq.current
    getAbort.current?.abort()
    setRevokingId(k.id)
    setFormError('')
    setListError('')
    const ac = new AbortController()
    const untrack = track(ac)
    try {
      await api<unknown>(`/api/workspaces/${workspaceId}/api-keys/${k.id}/revoke`, { method: 'POST', body: {}, signal: ac.signal })
      if (!alive.current || ac.signal.aborted) return
      if (createdId.current === k.id) applyCreated(null) // never keep a dead one-time secret on screen
      await load()
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      if (!alive.current || ac.signal.aborted) return
      handleHttpError(err, 'mutation')
    } finally {
      untrack()
      mutLock.current = false
      if (alive.current && !ac.signal.aborted) setRevokingId(null)
    }
  }

  async function copyToken() {
    if (!created) return
    const { token, key } = created
    setCopied(false)
    setCopyError('')
    try {
      await navigator.clipboard.writeText(token)
      // async guard: only report success if this exact token is still the one on screen
      if (!alive.current || createdId.current !== key.id) return
      setCopied(true)
    } catch {
      if (!alive.current || createdId.current !== key.id) return
      setCopyError('Automatic copy failed. Select the text in the box above and copy it yourself.')
    }
  }

  function toggleScope(value: string, checked: boolean) {
    setScopes((prev) => (checked ? [...prev, value] : prev.filter((s) => s !== value)))
  }

  function statusPill(k: ApiKey) {
    if (k.revokedAt) return <span className="pill bad">Revoked</span>
    if (new Date(k.expiresAt).getTime() <= Date.now()) return <span className="pill bad">Expired</span>
    return <span className="pill">Not revoked</span>
  }

  const fmt = (iso: string) => new Date(iso).toLocaleDateString()

  if (keys === null) return loading
    ? <p className="dim" role="status">Loading API keys…</p>
    : <div className="alert" role="alert"><p>{listError || 'API keys are unavailable. Try again.'}</p><button type="button" className="btn" disabled={busy} onClick={() => void load()}>Retry</button></div>

  return (
    <>
      <div className="banner">
        API keys grant access to <strong>this workspace only</strong>, limited to the scopes you select.
        Every request checks its expiry, scopes, current workspace access and two-factor requirement.
      </div>

      <p className="hint"><a href="/api/openapi.json" target="_blank" rel="noopener noreferrer">Open native API specification (JSON)</a></p>

      <div className="card">
        <h2>Create API key</h2>
        <form onSubmit={createKey}>
          <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="field">
            <label htmlFor="ak-name">Key name</label>
            <input
              id="ak-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              placeholder="e.g. CI deploy pipeline"
              autoComplete="off"
            />
            <p className="hint">A name so you remember what uses this key. 1–80 characters.</p>
          </div>
          <fieldset className="field" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend style={{ marginBottom: 5, fontSize: 13, fontWeight: 600, padding: 0 }}>Scopes</legend>
            {SCOPES.map((s) => (
              <label key={s.value} style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, marginBottom: 6 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto', margin: 0 }}
                  checked={scopes.includes(s.value)}
                  onChange={(e) => toggleScope(s.value, e.target.checked)}
                />
                <span>
                  {s.label} <span className="dim mono">{s.value}</span>
                </span>
              </label>
            ))}
            <p className="hint">The key can only do what you tick here. Prompt write access does not include reading prompts or running paid work.</p>
          </fieldset>
          <div className="field">
            <label htmlFor="ak-days">Expires after (days)</label>
            <input
              id="ak-days"
              type="number"
              min={1}
              max={365}
              step={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
            <p className="hint">Whole days, 1–365. Default is 90.</p>
          </div>
          {formError !== '' && (
            <div className="alert" role="alert">
              {formError}
            </div>
          )}
          <button className="btn primary" type="submit" disabled={busy} aria-busy={creating}>
            {creating ? 'Creating key…' : 'Create API key'}
          </button>
          </fieldset>
        </form>
      </div>

      {created !== null && (
        <div className="card">
          <h2>Save your new token now</h2>
          <div className="alert" style={{ background: 'var(--amber-tint)', borderColor: '#E9DDBB', borderLeftColor: 'var(--caution)' }}>
            This is the only time the token for <strong>{created.key.name}</strong> is shown. Store it somewhere safe now —
            after you dismiss this, it cannot be recovered.
          </div>
          <textarea
            className="snippet"
            style={{ width: '100%' }}
            readOnly
            rows={3}
            value={created.token}
            aria-label="New API token (shown once)"
            onFocus={(e) => e.target.select()}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="btn" onClick={copyToken}>
              Copy token
            </button>
            <button type="button" className="btn ghost" onClick={() => applyCreated(null)}>
              I saved it — dismiss
            </button>
            {copied && (
              <span className="pill good" role="status">
                Copied
              </span>
            )}
          </div>
          {copyError !== '' && (
            <p className="err-text" role="alert" style={{ margin: '8px 0 0' }}>
              {copyError}
            </p>
          )}
        </div>
      )}

      <div className="card">
        <h2>Keys for this workspace</h2>
        {listError !== '' && (
          <div className="alert" role="alert">
            {listError}{' '}
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}
        {keys === null && listError === '' && (
          <p className="dim" role="status">
            Loading keys…
          </p>
        )}
        {keys !== null && keys.length === 0 && (
          <EmptyState title="No API keys yet." description="Create one above to let scripts or CI talk to this workspace." />
        )}
        {keys !== null && keys.length > 0 && (
          <div className="table-wrap">
            <table style={{ minWidth: '60rem' }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Last used</th>
                  <th>Scopes</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td style={{ minWidth: '10rem', maxWidth: '18rem', overflowWrap: 'anywhere' }}>{k.name}</td>
                    <td>
                      {k.displayPrefix
                        ? <InlineCode>{k.displayPrefix}…</InlineCode>
                        : <Text as="span" size="sm" tone="muted">Created before prefixes were recorded</Text>}
                    </td>
                    <td>
                      {k.lastUsedAt
                        ? <Text as="time" dateTime={k.lastUsedAt} title={new Date(k.lastUsedAt).toLocaleString()}>{formatRelativeInstant(k.lastUsedAt)}</Text>
                        : <Text as="span" tone="muted">Never</Text>}
                    </td>
                    <td className="dim" style={{ minWidth: '12rem' }}>{k.scopes.join(', ')}</td>
                    <td className="dim">{fmt(k.createdAt)}</td>
                    <td className="dim">{fmt(k.expiresAt)}</td>
                    <td>
                      {statusPill(k)}
                      {k.revokedAt && (
                        <div className="dim" style={{ fontSize: 12, marginTop: 3 }}>
                          revoked {fmt(k.revokedAt)}
                        </div>
                      )}
                    </td>
                    <td>
                      {!k.revokedAt && (
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={busy}
                          aria-busy={revokingId === k.id}
                          onClick={() => void revokeKey(k)}
                        >
                          {revokingId === k.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="footnote dim">Revoked keys stay listed here as history. Existing keys can never be re-read — only created, revoked, or replaced.</p>
      </div>
      {confirmDialog}
    </>
  )
}
