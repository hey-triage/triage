import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CoverageResponse,
  CoverageWatch,
  Watch,
  WatchCadence,
  WatchDraftResponse,
  WatchPreviewResponse,
  WatchPreviewRow,
  WatchesResponse,
} from '../../../shared/protocol.js'

// Cross-page handoffs (palette "Add watch", inbox thumbs-down → refine),
// read once on mount. sessionStorage because it must survive the hash change.
export const ADD_WATCH_KEY = 'triage.watch.add'
export const REFINE_WATCH_KEY = 'triage.watch.refine'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const TEMPLATES: Array<{ label: string; text: string }> = [
  { label: 'Channel topic', text: 'watch #channel for threads about <topic> — not release-note chatter' },
  { label: 'Questions in my area', text: 'watch #team-channel for questions about <my area> that nobody has answered yet' },
  { label: 'Customer escalations', text: 'watch #support for threads where a customer issue sounds urgent or blocking' },
  { label: 'Decisions being made', text: 'watch #channel for threads where a decision about <topic> is being discussed or made' },
]

function relTime(ms?: number): string {
  if (!ms) return 'never'
  const mins = Math.round((Date.now() - ms) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

function cadenceLabel(w: Watch): string {
  if (w.cadence === 'hourly') return 'hourly'
  if (w.cadence === 'daily') return `daily ${w.windowStart ?? '09:00'}`
  return `${DAY_NAMES[w.windowDay ?? 1].slice(0, 3)} ${w.windowStart ?? '09:00'}`
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; watches: Watch[] }
  | { phase: 'error'; message: string }

export function WatchesPage() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [modal, setModal] = useState<{ editing: Watch | null; refineNote?: string } | null>(null)
  const [running, setRunning] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/watches')
      const body = (await res.json()) as WatchesResponse
      if (body.ok) setState({ phase: 'ready', watches: body.watches })
      else setState({ phase: 'error', message: body.error })
    } catch (err) {
      setState({ phase: 'error', message: String(err) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Handoffs from the palette ("Add watch") and the inbox (thumbs-down → refine).
  useEffect(() => {
    if (state.phase !== 'ready') return
    if (sessionStorage.getItem(ADD_WATCH_KEY)) {
      sessionStorage.removeItem(ADD_WATCH_KEY)
      setModal({ editing: null })
      return
    }
    const raw = sessionStorage.getItem(REFINE_WATCH_KEY)
    if (raw) {
      sessionStorage.removeItem(REFINE_WATCH_KEY)
      try {
        const { watchId, note } = JSON.parse(raw) as { watchId: string; note: string }
        const w = state.watches.find((x) => x.id === watchId)
        if (w) setModal({ editing: w, refineNote: note })
      } catch {
        // stale handoff — ignore
      }
    }
  }, [state])

  async function toggle(w: Watch) {
    await fetch(`/api/watches?id=${encodeURIComponent(w.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !w.enabled }),
    })
    void load()
  }

  async function remove(w: Watch) {
    if (!confirm(`Delete watch "${w.title}"? Its open items move to Archived (nothing is deleted).`)) return
    await fetch(`/api/watches?id=${encodeURIComponent(w.id)}`, { method: 'DELETE' })
    void load()
  }

  // Force-run one watch now (independent of its cadence). The run shows up under
  // Activity; we refresh the list a few times to reflect its outcome when done.
  async function run(w: Watch) {
    setRunning((prev) => new Set(prev).add(w.id))
    try {
      const res = await fetch(`/api/watches/run?id=${encodeURIComponent(w.id)}`, { method: 'POST' })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!body.ok) alert(body.error ?? 'could not start the run')
    } catch (err) {
      alert(String(err))
    }
    for (const ms of [5000, 12000, 30000]) setTimeout(() => void load(), ms)
    setTimeout(() => setRunning((prev) => {
      const next = new Set(prev)
      next.delete(w.id)
      return next
    }), 12000)
  }

  return (
    <div id="watchesPage">
      <div className="inner">
        <div className="pageHead">
          <div>
            <h2>Watches</h2>
            <p className="sub">
              One plain-English sentence, scoped to a place, that tells the scanner what you care
              about. Matches land in the inbox, scored like everything else.
            </p>
          </div>
          <button className="refresh add" onClick={() => setModal({ editing: null })}>
            + Add watch
          </button>
        </div>

        <CoverageProbe />

        {state.phase === 'loading' && (
          <div className="probing">
            <span className="pip" /> Loading watches…
          </div>
        )}
        {state.phase === 'error' && <div className="msg error">{state.message}</div>}

        {state.phase === 'ready' &&
          (state.watches.length === 0 ? (
            <div className="inboxEmpty">
              No watches yet. Add one — e.g. “watch #novus-px for product experience threads”.
            </div>
          ) : (
            <div className="watchList">
              {state.watches.map((w) => (
                <div key={w.id} className={`watchRow${w.enabled ? '' : ' off'}`}>
                  <label className="watchToggle" title={w.enabled ? 'Pause' : 'Resume'}>
                    <input type="checkbox" checked={w.enabled} onChange={() => void toggle(w)} />
                  </label>
                  <div className="watchBody">
                    <div className="watchTitle">
                      {w.title}
                      <span className="watchScope">{w.scope}</span>
                      {!w.createsItems && <span className="watchFyi">fyi-only</span>}
                    </div>
                    <div className="watchMeta">
                      {cadenceLabel(w)} · last run {relTime(w.lastRunAt)}
                      {w.lastRunStatus === 'failed' && (
                        <span className="watchFailed" title={w.lastRunError ?? 'the last run failed'}>
                          {' '}· failed
                        </span>
                      )}
                      {w.lastRunStatus === 'skipped' && <span className="watchSkipped">{' '}· skipped</span>}
                      {w.lastRunAt != null && w.lastRunStatus !== 'failed' && (
                        <>
                          {' '}· {w.lastRunMatches ?? 0} match{(w.lastRunMatches ?? 0) === 1 ? '' : 'es'}
                          {w.lastRunTokens != null && ` · ${Math.round(w.lastRunTokens / 1000)}k tok`}
                        </>
                      )}
                    </div>
                    <div className="watchInstruction">{w.instruction}</div>
                  </div>
                  <button
                    className="watchEdit"
                    title="Run this watch now"
                    disabled={running.has(w.id)}
                    onClick={() => void run(w)}
                  >
                    {running.has(w.id) ? 'Running…' : 'Run'}
                  </button>
                  <button className="watchEdit" onClick={() => setModal({ editing: w })}>
                    Edit
                  </button>
                  <button className="projDelete" title="Delete watch" onClick={() => void remove(w)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ))}
      </div>

      <WatchDialog
        open={modal !== null}
        editing={modal?.editing ?? null}
        refineNote={modal?.refineNote}
        onClose={() => setModal(null)}
        onSaved={() => {
          setModal(null)
          void load()
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add/edit modal: describe (plain text → draft) → form (every field editable)
// → preview (required for create — the trust-maker) → save.
// ---------------------------------------------------------------------------

type Step = 'describe' | 'form'

type Form = {
  title: string
  scope: string
  instruction: string
  cadence: WatchCadence
  windowStart: string
  windowDay: number
  createsItems: boolean
}

const EMPTY_FORM: Form = {
  title: '',
  scope: '',
  instruction: '',
  cadence: 'daily',
  windowStart: '09:00',
  windowDay: 1,
  createsItems: true,
}

function formFrom(w: Watch): Form {
  return {
    title: w.title,
    scope: w.scope,
    instruction: w.instruction,
    cadence: w.cadence,
    windowStart: w.windowStart ?? '09:00',
    windowDay: w.windowDay ?? 1,
    createsItems: w.createsItems,
  }
}

function WatchDialog({
  open,
  editing,
  refineNote,
  onClose,
  onSaved,
}: {
  open: boolean
  editing: Watch | null
  refineNote?: string
  onClose: () => void
  onSaved: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [step, setStep] = useState<Step>('describe')
  const [describe, setDescribe] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // preview state: `previewedFor` records which scope+instruction the rows
  // belong to, so an edit after previewing re-requires a preview.
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<{ rows: WatchPreviewRow[]; tokens: number } | null>(null)
  const [previewedFor, setPreviewedFor] = useState('')

  const sig = form.scope + ' ' + form.instruction
  const previewed = preview !== null && previewedFor === sig

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) {
      el.showModal()
      setError('')
      setDescribe('')
      setPreview(null)
      setPreviewedFor('')
      if (editing) {
        const f = formFrom(editing)
        // a thumbs-down correction is appended to the instruction text —
        // the rule stays human-readable, never opaque weights
        if (refineNote) f.instruction = `${f.instruction}; not: threads like "${refineNote}"`
        setForm(f)
        setStep('form')
      } else {
        setForm(EMPTY_FORM)
        setStep('describe')
      }
    }
    if (!open && el.open) el.close()
  }, [open, editing, refineNote])

  async function runDraft() {
    setDrafting(true)
    setError('')
    try {
      const res = await fetch('/api/watches/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: describe }),
      })
      const body = (await res.json()) as WatchDraftResponse
      if (!body.ok) throw new Error(body.error)
      setForm({
        ...EMPTY_FORM,
        title: body.draft.title,
        scope: body.draft.scope,
        instruction: body.draft.instruction,
        cadence: body.draft.cadence,
        createsItems: body.draft.createsItems,
      })
      setStep('form')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDrafting(false)
    }
  }

  async function runPreview() {
    setPreviewing(true)
    setError('')
    const forSig = sig
    try {
      const res = await fetch('/api/watches/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: form.scope, instruction: form.instruction }),
      })
      const body = (await res.json()) as WatchPreviewResponse
      if (!body.ok) throw new Error(body.error)
      setPreview({ rows: body.rows, tokens: body.tokens })
      setPreviewedFor(forSig)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPreviewing(false)
    }
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      const payload = {
        title: form.title,
        scope: form.scope,
        instruction: form.instruction,
        cadence: form.cadence,
        windowStart: form.cadence === 'hourly' ? null : form.windowStart,
        windowDay: form.cadence === 'weekly' ? form.windowDay : null,
        createsItems: form.createsItems,
      }
      const res = await fetch(
        editing ? `/api/watches?id=${encodeURIComponent(editing.id)}` : '/api/watches',
        {
          method: editing ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      const body = (await res.json()) as WatchesResponse
      if (!body.ok) throw new Error(body.error)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const formComplete = form.title.trim() && form.scope.trim() && form.instruction.trim()
  // Create requires a preview of exactly what will be saved; editing only
  // re-requires one when scope/instruction changed.
  const editUnchanged =
    editing !== null && editing.scope === form.scope && editing.instruction === form.instruction
  const canSave = Boolean(formComplete) && !saving && !previewing && (previewed || editUnchanged)

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <dialog ref={dialog} className="watchDialog" onClose={onClose}>
      <h3>{editing ? 'Edit watch' : 'Add watch'}</h3>

      {step === 'describe' && (
        <>
          <p className="pickerSub">
            Say what to watch, in plain English. It becomes an editable draft — nothing runs yet.
          </p>
          <div className="watchTemplates">
            {TEMPLATES.map((t) => (
              <button key={t.label} className="watchTemplate" onClick={() => setDescribe(t.text)}>
                {t.label}
              </button>
            ))}
          </div>
          <textarea
            autoFocus
            rows={3}
            placeholder="watch #novus-px for product experience related messages"
            value={describe}
            onChange={(e) => setDescribe(e.target.value)}
          />
          {error && <div className="projError">{error}</div>}
          <div className="row">
            <button className="cancel" onClick={onClose}>
              Cancel
            </button>
            <button className="cancel" onClick={() => setStep('form')}>
              Skip — fill the form
            </button>
            <button className="go" disabled={!describe.trim() || drafting} onClick={() => void runDraft()}>
              {drafting ? 'Drafting…' : 'Draft watch'}
            </button>
          </div>
        </>
      )}

      {step === 'form' && (
        <>
          <label>Title</label>
          <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="PX topics in #novus-px" />
          <label>Scope — one #channel or @dm; the scan never leaves it</label>
          <input value={form.scope} onChange={(e) => set('scope', e.target.value)} placeholder="#novus-px" />
          <label>Instruction — the sentence the scanner judges against</label>
          <textarea
            rows={3}
            value={form.instruction}
            onChange={(e) => set('instruction', e.target.value)}
            placeholder="threads discussing product experience — user friction, UX decisions, PX metrics; not release-note chatter"
          />
          <div className="watchFormRow">
            <div>
              <label>Cadence</label>
              <select value={form.cadence} onChange={(e) => set('cadence', e.target.value as WatchCadence)}>
                <option value="hourly">hourly</option>
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
              </select>
            </div>
            {form.cadence !== 'hourly' && (
              <div>
                <label>At</label>
                <input type="time" value={form.windowStart} onChange={(e) => set('windowStart', e.target.value)} />
              </div>
            )}
            {form.cadence === 'weekly' && (
              <div>
                <label>On</label>
                <select value={form.windowDay} onChange={(e) => set('windowDay', Number(e.target.value))}>
                  {DAY_NAMES.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <label className="watchCheck">
            <input
              type="checkbox"
              checked={form.createsItems}
              onChange={(e) => set('createsItems', e.target.checked)}
            />
            Create inbox items (unchecked = FYI-only rows)
          </label>

          {previewing && (
            <div className="probing">
              <span className="pip" /> Scanning {form.scope}’s recent history — a real scan, takes a
              minute or two…
            </div>
          )}
          {!previewing && preview && previewed && (
            <div className="watchPreview">
              <div className="watchPreviewHead">
                Would have matched {preview.rows.length} thread{preview.rows.length === 1 ? '' : 's'} in
                the last week · {Math.round(preview.tokens / 1000)}k tok
              </div>
              {preview.rows.length === 0 && (
                <div className="watchPreviewEmpty">
                  Nothing matched. If that seems wrong, loosen the instruction and re-preview.
                </div>
              )}
              {preview.rows.map((r) => (
                <div key={r.permalink} className="watchPreviewRow">
                  <a href={r.permalink} target="_blank" rel="noreferrer">
                    {r.title}
                  </a>
                  <div className="watchPreviewWhy">
                    {r.from} · {r.why}
                  </div>
                </div>
              ))}
            </div>
          )}
          {!previewing && preview && !previewed && (
            <div className="watchPreviewEmpty">The rule changed since the last preview — re-preview to see what it matches now.</div>
          )}

          {error && <div className="projError">{error}</div>}
          <div className="row">
            <button className="cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              className="cancel"
              disabled={!formComplete || previewing}
              onClick={() => void runPreview()}
            >
              {previewing ? 'Previewing…' : previewed ? 'Re-preview' : 'Preview'}
            </button>
            <button
              className="go"
              disabled={!canSave}
              title={canSave || !formComplete ? undefined : 'Preview first — see what this rule actually matches'}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : editing ? 'Save' : 'Create watch'}
            </button>
          </div>
        </>
      )}
    </dialog>
  )
}

// ---------------------------------------------------------------------------
// Coverage probe (.docs/watches-v2.md): the trust ritual — "is this channel
// watched?" Type a scope and see which watches cover it and whether they are
// healthy, so "will triage catch it?" becomes checkable in seconds.
// ---------------------------------------------------------------------------
function CoverageProbe() {
  const [scope, setScope] = useState('')
  const [result, setResult] = useState<{ scope: string; watches: CoverageWatch[] } | null>(null)
  const [checking, setChecking] = useState(false)

  async function check() {
    const s = scope.trim()
    if (!s) return
    setChecking(true)
    try {
      const res = await fetch(`/api/coverage?scope=${encodeURIComponent(s)}`)
      const body = (await res.json()) as CoverageResponse
      setResult(body.ok ? { scope: body.scope, watches: body.watches } : { scope: s, watches: [] })
    } catch {
      setResult({ scope: s, watches: [] })
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="coverageProbe">
      <form
        className="coverageForm"
        onSubmit={(e) => {
          e.preventDefault()
          void check()
        }}
      >
        <input
          className="coverageInput"
          placeholder="Is a channel covered? e.g. #novus-px or @dm"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        />
        <button className="refresh" type="submit" disabled={checking || !scope.trim()}>
          {checking ? 'Checking…' : 'Check coverage'}
        </button>
      </form>
      {result && (
        <div className={`coverageResult${result.watches.some((w) => w.enabled) ? ' covered' : ' uncovered'}`}>
          {result.watches.filter((w) => w.enabled).length === 0 ? (
            <>
              <b>{result.scope}</b> is not covered — no enabled watch scans it.{' '}
              {result.watches.length > 0 && `(${result.watches.length} disabled watch here.)`}
            </>
          ) : (
            <>
              <b>{result.scope}</b> is covered by{' '}
              {result.watches
                .filter((w) => w.enabled)
                .map((w) => {
                  const health =
                    w.lastRunStatus === 'failed'
                      ? ' (last run failed)'
                      : w.lastRunStatus === 'ok'
                        ? ` (caught up${w.cursor ? ` to ${new Date(w.cursor).toLocaleString()}` : ''})`
                        : ' (not run yet)'
                  return `“${w.title}”${health}`
                })
                .join(', ')}
              .
            </>
          )}
        </div>
      )}
    </div>
  )
}
