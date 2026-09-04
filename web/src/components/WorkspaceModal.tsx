/**
 * The workspace modal (.docs/workspaces.md) — one component, three entrances:
 *
 *   create      — "New workspace…" from the sidebar switcher
 *   onboarding  — first run: the same flow, introducing the concept and
 *                 configuring the default workspace
 *   settings    — edit the active workspace (identity, auth, delete)
 *
 * Three steps: identity → Claude auth (three cards, the tradeoffs spelled out
 * on each) → verify (a live probe with the workspace's own env, so a workspace
 * is never left silently broken — watches fail in the background, auth must be
 * proven in the foreground).
 */
import { Check, KeyRound, Laptop, RefreshCw, UserRound } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  Workspace,
  WorkspaceAuthBackend,
  WorkspaceResponse,
  WorkspaceVerifyResponse,
} from '../../../shared/protocol.js'
import { store } from '../store.js'

export type WorkspaceModalMode =
  | { kind: 'create' }
  | { kind: 'onboarding'; workspace: Workspace }
  | { kind: 'settings'; workspace: Workspace }

type Props = {
  mode: WorkspaceModalMode | null
  onClose: () => void
}

const COLORS = ['#7aa2f7', '#9ece6a', '#bb9af7', '#e0af68', '#f7768e', '#2ac3de', '#ff9e64', '#c0caf5']

type Step = 'identity' | 'auth' | 'verify'

const AUTH_CARDS: Array<{
  backend: WorkspaceAuthBackend
  icon: typeof Laptop
  title: string
  body: string
}> = [
  {
    backend: 'inherit',
    icon: Laptop,
    title: 'Use my existing Claude login',
    body: 'The same claude.ai subscription and connectors this machine already uses. Nothing else to set up.',
  },
  {
    backend: 'api-key',
    icon: KeyRound,
    title: 'Claude API key',
    body: 'Billed to this key. No claude.ai connectors in this workspace — Slack watches won’t run here; GitHub via gh still works.',
  },
  {
    backend: 'config-dir',
    icon: UserRound,
    title: 'Separate claude.ai login',
    body: 'Its own subscription and its own connectors (e.g. a personal Slack). Needs a one-time login in your terminal.',
  },
]

export function WorkspaceModal({ mode, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [step, setStep] = useState<Step>('identity')

  // identity
  const [name, setName] = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [description, setDescription] = useState('')
  // auth
  const [authBackend, setAuthBackend] = useState<WorkspaceAuthBackend>('inherit')
  const [apiKey, setApiKey] = useState('')
  // the workspace being verified: the created one, or the edited one
  const [target, setTarget] = useState<Workspace | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // verify
  const [verify, setVerify] = useState<WorkspaceVerifyResponse | 'probing' | null>(null)

  // (Re)seed the form each time the modal opens.
  useEffect(() => {
    if (!mode) return
    const ws = mode.kind === 'create' ? null : mode.workspace
    setStep('identity')
    setName(ws && mode.kind !== 'onboarding' ? ws.name : ws?.name === 'Default' ? '' : (ws?.name ?? ''))
    setColor(ws?.color ?? COLORS[0])
    setDescription(ws?.description ?? '')
    setAuthBackend(ws?.authBackend ?? 'inherit')
    setApiKey('')
    setTarget(ws)
    setSaving(false)
    setError('')
    setVerify(null)
  }, [mode])

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (mode && !el.open) el.showModal()
    if (!mode && el.open) el.close()
  }, [mode])

  const finishOnboarding = useCallback(() => {
    void fetch('/api/workspaces/onboarded', { method: 'POST' }).finally(() => {
      store.markOnboarded()
      void store.refreshWorkspaces()
      onClose()
    })
  }, [onClose])

  const close = useCallback(() => {
    // Onboarding is once-per-install: closing it (Escape, backdrop, Skip)
    // counts as "skip" — it must not reappear on every load.
    if (mode?.kind === 'onboarding') finishOnboarding()
    else {
      void store.refreshWorkspaces()
      onClose()
    }
  }, [mode, onClose, finishOnboarding])

  const runVerify = useCallback((id: string) => {
    setVerify('probing')
    void fetch(`/api/workspaces/verify?id=${encodeURIComponent(id)}`, { method: 'POST' })
      .then((r) => r.json() as Promise<WorkspaceVerifyResponse>)
      .then(setVerify)
      .catch((e) => setVerify({ ok: false, error: String(e) }))
  }, [])

  /** Persist identity + auth, then move to the verify step. */
  const save = useCallback(async () => {
    if (!mode) return
    setSaving(true)
    setError('')
    try {
      const payload = {
        name: name.trim(),
        color,
        description: description.trim(),
        authBackend,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      }
      const url =
        mode.kind === 'create'
          ? '/api/workspaces'
          : `/api/workspaces?id=${encodeURIComponent(mode.workspace.id)}`
      const res = await fetch(url, {
        method: mode.kind === 'create' ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await res.json()) as WorkspaceResponse
      if (!body.ok) throw new Error(body.error)
      setTarget(body.workspace)
      setStep('verify')
      runVerify(body.workspace.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [mode, name, color, description, authBackend, apiKey, runVerify])

  if (!mode) {
    return <dialog ref={dialog} className="wsModal" onClose={onClose} />
  }

  const heading =
    mode.kind === 'onboarding'
      ? 'Welcome to triage — set up your workspace'
      : mode.kind === 'create'
        ? 'New workspace'
        : 'Workspace settings'
  const needsKey = authBackend === 'api-key' && !apiKey.trim() && !(target?.apiKeyHint && mode.kind !== 'create')

  return (
    <dialog
      ref={dialog}
      className="wsModal"
      onClose={close}
      onClick={(e) => e.target === dialog.current && close()}
    >
      <h3>{heading}</h3>
      {mode.kind === 'onboarding' && step === 'identity' && (
        <p className="wsIntro">
          A workspace keeps its projects, inbox, watches, and Claude account separate — work and
          personal never share a pile. This sets up your first one; more can be added any time from
          the sidebar.
        </p>
      )}

      <div className="wsSteps" aria-hidden="true">
        {(['identity', 'auth', 'verify'] as Step[]).map((s, i) => (
          <span key={s} className={`wsStep${step === s ? ' active' : ''}`}>
            {i + 1}. {s === 'identity' ? 'Name' : s === 'auth' ? 'Claude auth' : 'Verify'}
          </span>
        ))}
      </div>

      {step === 'identity' && (
        <>
          <label>Name</label>
          <input
            autoFocus
            value={name}
            placeholder="e.g. Work, Personal"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) setStep('auth')
            }}
          />
          <label>Color</label>
          <div className="wsColors">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`wsColor${color === c ? ' active' : ''}`}
                style={{ background: c }}
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
              >
                {color === c && <Check size={12} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <label>Description (optional)</label>
          <input
            value={description}
            placeholder="What lives in this workspace"
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="row">
            {mode.kind === 'onboarding' && (
              <button type="button" className="cancel" onClick={finishOnboarding}>
                Skip for now
              </button>
            )}
            {mode.kind !== 'onboarding' && (
              <button type="button" className="cancel" onClick={close}>
                Cancel
              </button>
            )}
            {mode.kind === 'settings' && !mode.workspace.isDefault && (
              <DeleteWorkspaceButton workspace={mode.workspace} onDeleted={onClose} />
            )}
            <button type="button" className="go" disabled={!name.trim()} onClick={() => setStep('auth')}>
              Next
            </button>
          </div>
        </>
      )}

      {step === 'auth' && (
        <>
          <div className="wsAuthCards" role="radiogroup" aria-label="Claude auth method">
            {AUTH_CARDS.map((card) => {
              const Icon = card.icon
              const active = authBackend === card.backend
              return (
                <button
                  key={card.backend}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`wsAuthCard${active ? ' active' : ''}`}
                  onClick={() => setAuthBackend(card.backend)}
                >
                  <span className="wsAuthTitle">
                    <Icon size={15} aria-hidden="true" />
                    {card.title}
                    {card.backend === 'inherit' && <em className="wsDefaultTag">default</em>}
                  </span>
                  <span className="wsAuthBody">{card.body}</span>
                  {card.backend === 'api-key' && active && (
                    <span className="wsKeyRow" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="password"
                        value={apiKey}
                        placeholder={
                          target?.apiKeyHint ? `key set (${target.apiKeyHint}) — paste to replace` : 'sk-ant-…'
                        }
                        onChange={(e) => setApiKey(e.target.value)}
                      />
                      <small>
                        Stored in this workspace's own <code>.env</code> (0600), never in the database.
                      </small>
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {error && <div className="msg error">{error}</div>}
          <div className="row">
            <button type="button" className="cancel" onClick={() => setStep('identity')}>
              Back
            </button>
            <button type="button" className="go" disabled={saving || needsKey} onClick={() => void save()}>
              {saving
                ? 'Saving…'
                : mode.kind === 'create'
                  ? 'Create & verify'
                  : 'Save & verify'}
            </button>
          </div>
        </>
      )}

      {step === 'verify' && target && (
        <VerifyPanel
          workspace={target}
          state={verify}
          onRecheck={() => runVerify(target.id)}
          footer={
            <div className="row">
              {mode.kind === 'create' && (
                <button type="button" className="cancel" onClick={() => store.switchWorkspace(target.id)}>
                  Switch to it
                </button>
              )}
              <button
                type="button"
                className="go"
                onClick={mode.kind === 'onboarding' ? finishOnboarding : close}
              >
                {mode.kind === 'onboarding' ? 'Finish' : 'Done'}
              </button>
            </div>
          }
        />
      )}
    </dialog>
  )
}

function VerifyPanel({
  workspace,
  state,
  onRecheck,
  footer,
}: {
  workspace: Workspace
  state: WorkspaceVerifyResponse | 'probing' | null
  onRecheck: () => void
  footer: ReactNode
}) {
  return (
    <div className="wsVerify">
      {workspace.authBackend === 'config-dir' && (
        <div className="wsLogin">
          <p>One-time login for this workspace's own claude.ai account — run in a terminal:</p>
          <code className="wsLoginCmd">{workspace.loginCommand}</code>
        </div>
      )}
      {state === 'probing' || state === null ? (
        <div className="probing">
          <span className="pip" /> Probing with this workspace's auth — starts a Claude subprocess,
          takes a few seconds…
        </div>
      ) : state.ok ? (
        <div className="wsVerifyResults">
          {state.authOk ? (
            <div className="wsVerifyRow ok">
              ✓ Auth working — {state.models.length} model{state.models.length === 1 ? '' : 's'}
              {state.models.length > 0 && (
                <span className="wsVerifyDetail">
                  {state.models
                    .slice(0, 3)
                    .map((m) => m.name)
                    .join(' · ')}
                </span>
              )}
            </div>
          ) : (
            <div className="wsVerifyRow bad">✗ Auth failed{state.authError ? ` — ${state.authError}` : ''}</div>
          )}
          {(() => {
            // Report what the probe actually saw — never assert from the backend
            // choice alone. api-key workspaces normally have zero claude.ai
            // connectors (those ride a claude.ai login), and the probe proves it.
            const claudeAi = state.connectors.filter((c) => c.source === 'claude.ai' && c.status === 'connected')
            if (state.slackConnected) return <div className="wsVerifyRow ok">✓ Slack connected</div>
            if (claudeAi.length > 0)
              return <div className="wsVerifyRow dim">— Slack not connected ({claudeAi.length} claude.ai connector{claudeAi.length === 1 ? '' : 's'} live)</div>
            return (
              <div className="wsVerifyRow dim">
                — No claude.ai connectors{workspace.authBackend === 'api-key' ? ' (they ride a claude.ai login — expected for an API-key workspace; Slack watches won’t run here)' : ''}
              </div>
            )
          })()}
        </div>
      ) : (
        <div className="wsVerifyRow bad">✗ {state.error}</div>
      )}
      <button
        type="button"
        className="wsRecheck"
        disabled={state === 'probing'}
        onClick={onRecheck}
      >
        <RefreshCw size={13} aria-hidden="true" /> Check again
      </button>
      {footer}
    </div>
  )
}

/** Delete = unregister; the workspace's files stay on disk. Confirmed inline. */
function DeleteWorkspaceButton({ workspace, onDeleted }: { workspace: Workspace; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!confirming) {
    return (
      <button type="button" className="danger" onClick={() => setConfirming(true)}>
        Delete workspace
      </button>
    )
  }
  return (
    <button
      type="button"
      className="danger"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void fetch(`/api/workspaces?id=${encodeURIComponent(workspace.id)}`, { method: 'DELETE' })
          .then((r) => r.json() as Promise<{ ok: boolean; defaultId?: string }>)
          .then((b) => {
            if (b.ok && b.defaultId) store.switchWorkspace(b.defaultId)
            else onDeleted()
          })
          .catch(() => onDeleted())
      }}
    >
      {busy ? 'Removing…' : 'Really delete? (files kept on disk)'}
    </button>
  )
}
