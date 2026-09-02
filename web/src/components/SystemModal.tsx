import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActivityResponse,
  ActivityRun,
  LogEntry,
  LogLevel,
  LogsResponse,
  SystemResponse,
  SystemStatus,
} from '../../../shared/protocol.js'
import type { ConnState } from '../store.js'

function rel(ms: number | null | undefined): string {
  if (!ms) return 'never'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function uptime(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

type Tab = 'status' | 'activity' | 'logs'

export function SystemModal({ open, conn, onClose }: { open: boolean; conn: ConnState; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<Tab>('status')

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) {
      el.showModal()
      setTab('status')
    }
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog
      ref={dialog}
      className="systemModal"
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && onClose()}
    >
      <div className="systemTabs" role="tablist">
        {(['status', 'activity', 'logs'] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`systemTab${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {open && tab === 'status' && <StatusTab conn={conn} />}
      {open && tab === 'activity' && <ActivityTab />}
      {open && tab === 'logs' && <LogsTab />}
    </dialog>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' | 'dim' }) {
  return (
    <div className="sysRow">
      <span className="sysLabel">{label}</span>
      <span className={`sysValue${tone ? ' ' + tone : ''}`}>{value}</span>
    </div>
  )
}

function StatusTab({ conn }: { conn: ConnState }) {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    void fetch('/api/system')
      .then((r) => r.json() as Promise<SystemResponse>)
      .then((b) => (b.ok ? setStatus(b.status) : setError(b.error)))
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])

  if (error) return <div className="msg error">{error}</div>
  if (!status) return <div className="pickerLoading">Loading…</div>

  const slack =
    status.slackConnected === true ? ['connected', 'ok'] : status.slackConnected === false ? ['disconnected', 'bad'] : ['probing…', 'dim']
  return (
    <div className="sysBody">
      <div className="sysHead">
        <span className={`sysDot ${conn === 'connected' ? 'ok' : 'bad'}`} />
        <b>{conn === 'connected' ? 'Daemon running' : 'Reconnecting…'}</b>
        <span className="sysSub">
          v{status.version} · up {uptime(status.uptimeMs)}
        </span>
      </div>
      <Row label="Port" value={String(status.port)} tone="dim" />
      <Row label="Database" value={status.db} tone="dim" />
      <Row label="Live sessions" value={String(status.liveSessions)} />
      <Row label="Slack connector" value={slack[0]} tone={slack[1] as 'ok' | 'bad' | 'dim'} />
      <Row
        label="Connectors"
        value={status.connectorCount == null ? 'probing…' : `${status.connectorCount} · ${rel(status.connectorsProbedAt)}`}
        tone="dim"
      />
      <Row label="Scheduler last tick" value={rel(status.schedulerLastTickAt)} tone={status.schedulerLastTickAt ? 'ok' : 'warn'} />
      <Row label="Watch runs in flight" value={String(status.runningWatches)} />
      <Row label="Inbox last synced" value={rel(status.inboxSyncedAt)} />
      <Row
        label="GitHub last reconcile"
        value={status.githubNotice ? status.githubNotice : rel(status.githubReconcileAt)}
        tone={status.githubNotice ? 'bad' : 'dim'}
      />
      <Row
        label="Watches"
        value={`${status.watches.enabled}/${status.watches.total} enabled${status.watches.failing ? ` · ${status.watches.failing} failing` : ''}${status.watches.overdue ? ` · ${status.watches.overdue} overdue` : ''}`}
        tone={status.watches.failing ? 'bad' : status.watches.overdue ? 'warn' : 'ok'}
      />
      <Row label="Logs" value={status.logDir ?? 'in-memory only'} tone="dim" />
    </div>
  )
}

function ActivityTab() {
  const [runs, setRuns] = useState<ActivityRun[] | null>(null)
  useEffect(() => {
    void fetch('/api/activity')
      .then((r) => r.json() as Promise<ActivityResponse>)
      .then((b) => setRuns(b.ok ? b.runs.slice(0, 30) : []))
      .catch(() => setRuns([]))
  }, [])
  if (!runs) return <div className="pickerLoading">Loading…</div>
  if (runs.length === 0) return <div className="pickerLoading">No runs yet.</div>
  return (
    <div className="sysBody">
      {runs.map((r) => {
        const st = r.status ?? 'running'
        return (
          <div key={r.sessionId} className="sysRunRow">
            <span className={`runStatus ${st}`}>{st}</span>
            <span className="sysRunTitle">{r.watchTitle}</span>
            <span className="sysRunMeta">
              {rel(r.startedAt)}
              {r.status === 'ok' && ` · ${r.matches ?? 0} filed`}
              {r.error && ` · ${r.error}`}
            </span>
          </div>
        )
      })}
    </div>
  )
}

const LEVELS: (LogLevel | 'all')[] = ['all', 'info', 'warn', 'error']

function LogsTab() {
  const [entries, setEntries] = useState<LogEntry[] | null>(null)
  const [subsystems, setSubsystems] = useState<string[]>([])
  const [level, setLevel] = useState<LogLevel | 'all'>('all')
  const [subsystem, setSubsystem] = useState('all')
  const [q, setQ] = useState('')

  const load = useCallback(() => {
    const p = new URLSearchParams()
    if (level !== 'all') p.set('level', level)
    if (subsystem !== 'all') p.set('subsystem', subsystem)
    if (q.trim()) p.set('q', q.trim())
    void fetch(`/api/logs?${p.toString()}`)
      .then((r) => r.json() as Promise<LogsResponse>)
      .then((b) => {
        if (b.ok) {
          setEntries(b.entries)
          setSubsystems(b.subsystems)
        }
      })
      .catch(() => setEntries([]))
  }, [level, subsystem, q])

  useEffect(() => {
    load()
    const t = setInterval(load, 5_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div className="sysBody logs">
      <div className="logFilters">
        <div className="logTabs">
          {LEVELS.map((l) => (
            <button key={l} className={`logTab${level === l ? ' active' : ''}`} onClick={() => setLevel(l)}>
              {l}
            </button>
          ))}
        </div>
        <select value={subsystem} onChange={(e) => setSubsystem(e.target.value)}>
          <option value="all">all subsystems</option>
          {subsystems.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input className="logFilterInput" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="logLines">
        {entries === null ? (
          <div className="pickerLoading">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="pickerLoading">No log lines.</div>
        ) : (
          entries.map((e) => (
            <div key={e.seq} className={`logLine ${e.level}`} title={e.fields ? JSON.stringify(e.fields, null, 2) : undefined}>
              <span className="logTime">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className={`logLevel ${e.level}`}>{e.level}</span>
              <span className="logSub">{e.subsystem}</span>
              <span className="logMsg">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
