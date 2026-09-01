import { useCallback, useEffect, useState } from 'react'
import type { ActivityResponse, ActivityRun, ItemListResponse, ScoredItem } from '../../../shared/protocol.js'
import { useEvents } from '../hooks.js'
import { store } from '../store.js'
import { Transcript } from './Transcript.js'

function relTime(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

function duration(a: number, b: number): string {
  const s = Math.max(0, Math.round((b - a) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const STATUS_LABEL: Record<string, string> = { ok: 'ok', failed: 'failed', skipped: 'skipped' }

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; runs: ActivityRun[] }
  | { phase: 'error'; message: string }

export function ActivityPage() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [openRun, setOpenRun] = useState<string | null>(null)

  const load = useCallback(async () => {
    setState({ phase: 'loading' })
    try {
      const res = await fetch('/api/activity')
      const body = (await res.json()) as ActivityResponse
      setState(body.ok ? { phase: 'ready', runs: body.runs } : { phase: 'error', message: body.error })
    } catch (err) {
      setState({ phase: 'error', message: String(err) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div id="activityPage">
      <div className="inner">
        <div className="pageHead">
          <div>
            <h2>Activity</h2>
            <p className="sub">Every watch run is a session — here is what each one looked at and filed.</p>
          </div>
          <button className="refresh" disabled={state.phase === 'loading'} onClick={() => void load()}>
            {state.phase === 'loading' ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {state.phase === 'loading' && (
          <div className="probing">
            <span className="pip" /> Loading runs…
          </div>
        )}
        {state.phase === 'error' && <div className="msg error">Failed: {state.message}</div>}
        {state.phase === 'ready' && state.runs.length === 0 && (
          <div className="inboxEmpty">No runs yet — watches run on their cadence, or use “Scan now” in the inbox.</div>
        )}
        {state.phase === 'ready' &&
          state.runs.map((run) => (
            <RunRow
              key={run.sessionId}
              run={run}
              open={openRun === run.sessionId}
              onToggle={() => setOpenRun((cur) => (cur === run.sessionId ? null : run.sessionId))}
            />
          ))}
      </div>
    </div>
  )
}

function RunRow({ run, open, onToggle }: { run: ActivityRun; open: boolean; onToggle: () => void }) {
  const status = run.status ?? 'running'
  return (
    <section className={`activityRun ${status}`}>
      <button className="activityRunHead" onClick={onToggle} aria-expanded={open}>
        <span className={`runStatus ${status}`}>{STATUS_LABEL[status] ?? status}</span>
        <span className="runTitle">{run.watchTitle}</span>
        <span className="runMeta">
          {relTime(run.startedAt)} · {duration(run.startedAt, run.finishedAt)}
          {run.status === 'ok' && ` · ${run.matches ?? 0} filed`}
          {run.tokens != null && run.tokens > 0 && ` · ${Math.round(run.tokens / 1000)}k tok`}
        </span>
      </button>
      {run.error && <div className="runError">{run.error}</div>}
      {open && <RunDetail run={run} />}
    </section>
  )
}

function RunDetail({ run }: { run: ActivityRun }) {
  const events = useEvents(run.sessionId)
  const [items, setItems] = useState<ScoredItem[] | null>(null)

  useEffect(() => {
    store.subscribeSession(run.sessionId)
    void fetch(`/api/activity/items?runId=${encodeURIComponent(run.sessionId)}`)
      .then((r) => r.json() as Promise<ItemListResponse>)
      .then((b) => setItems(b.ok ? b.items : []))
      .catch(() => setItems([]))
  }, [run.sessionId])

  return (
    <div className="runDetail">
      {items && items.length > 0 && (
        <div className="runItems">
          <div className="runItemsHead">Filed this run</div>
          {items.map((it) => (
            <a key={it.id} className="runItem" href={it.url || undefined} target="_blank" rel="noreferrer">
              <span className="runItemRepo">{it.repo}</span>
              {it.title}
              {it.why && <span className="itemWhy"> · “{it.why}”</span>}
            </a>
          ))}
        </div>
      )}
      <div className="runTranscript">
        <Transcript sessionId={run.sessionId} events={events} onRespond={() => {}} />
      </div>
    </div>
  )
}
