/**
 * One work item, in full: what it is, why it ranked, what has happened to it,
 * and the sessions working on it. The actions live in the right column so the
 * brief on the left reads as a page, not a form.
 */
import { AlarmClock, Archive, Check, ChevronRight, ExternalLink, Hash } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  ItemEvent,
  ItemEventsResponse,
  ItemListResponse,
  ItemStatus,
  Project,
  ProjectsResponse,
  ScoredItem,
  WatchesResponse,
} from '../../../shared/protocol.js'
import { useSessions } from '../hooks.js'
import { inboxStore, useInbox } from '../inboxStore.js'
import { KIND_LABEL, PRIORITY_LABEL, PRIORITY_VALUES, ago, kindIcon, relTime } from '../itemUi.js'

type Props = {
  id: string
  onDispatch: (item: ScoredItem) => void
  onNavigate: (hash: string) => void
}

const EVENT_LABEL: Record<string, string> = {
  created: 'surfaced',
  updated: 'new activity',
  reopened: 'reopened',
  done: 'marked done',
  archived: 'archived',
  snoozed: 'snoozed',
  woken: 'snooze ended',
}

function actorLabel(actor: string): string {
  if (actor === 'user') return 'you'
  if (actor === 'system') return 'system'
  if (actor === 'agent' || actor.startsWith('agent:')) return 'an agent'
  if (actor.startsWith('watch:')) return 'a watch run'
  return actor
}

const OTHER_STATUSES: ItemStatus[] = ['snoozed', 'done', 'archived']

export function ItemPage({ id, onDispatch, onNavigate }: Props) {
  const snap = useInbox()
  const sessions = useSessions()
  const open = snap.items.find((i) => i.id === id)
  // Not in the open inbox → it may be snoozed, done or archived.
  const [other, setOther] = useState<{ id: string; item: ScoredItem | null } | null>(null)
  const [events, setEvents] = useState<ItemEvent[] | null>(null)
  const [watchTitles, setWatchTitles] = useState<Map<string, string>>(new Map())
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    if (!snap.loaded && !snap.loading) void inboxStore.refresh()
  }, [snap.loaded, snap.loading])

  useEffect(() => {
    if (open || !snap.loaded) return
    let cancelled = false
    void Promise.all(
      OTHER_STATUSES.map((s) =>
        fetch(`/api/items?status=${s}`)
          .then((r) => r.json() as Promise<ItemListResponse>)
          .then((b) => (b.ok ? b.items : []))
          .catch(() => [] as ScoredItem[]),
      ),
    ).then((lists) => {
      if (cancelled) return
      setOther({ id, item: lists.flat().find((i) => i.id === id) ?? null })
    })
    return () => {
      cancelled = true
    }
  }, [id, open, snap.loaded])

  useEffect(() => {
    setEvents(null)
    void fetch(`/api/items/events?id=${encodeURIComponent(id)}`)
      .then((r) => r.json() as Promise<ItemEventsResponse>)
      .then((b) => setEvents(b.ok ? b.events : []))
      .catch(() => setEvents([]))
  }, [id])

  useEffect(() => {
    void fetch('/api/watches')
      .then((r) => r.json() as Promise<WatchesResponse>)
      .then((b) => {
        if (b.ok) setWatchTitles(new Map(b.watches.map((w) => [w.id, w.title])))
      })
      .catch(() => {})
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [])

  const item = open ?? (other?.id === id ? other.item : undefined)

  // Dispatch titles a session with the item's title — that is the link back.
  const linkedSessions = useMemo(
    () => (item ? sessions.filter((s) => s.title === item.title.slice(0, 80)) : []),
    [sessions, item],
  )

  async function setState(status: ItemStatus, snoozeUntil?: number) {
    if (!item) return
    inboxStore.patch((items) => items.filter((i) => i.id !== item.id))
    await fetch('/api/items/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, status, snoozeUntil }),
    }).catch(() => {})
    onNavigate('/inbox')
  }

  function snooze1d() {
    const t = new Date()
    t.setDate(t.getDate() + 1)
    t.setHours(9, 0, 0, 0)
    void setState('snoozed', t.getTime())
  }

  function setPriority(priority: number) {
    if (!item) return
    inboxStore.patch((items) => items.map((i) => (i.id === item.id ? { ...i, priority: priority || undefined } : i)))
    void fetch('/api/items/priority', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, priority: priority || null }),
    }).catch(() => {})
  }

  if (!item) {
    const stillLooking = !snap.loaded || (other?.id !== id && !open)
    return (
      <div className="page">
        <div className="glow orange" aria-hidden="true" />
        <div className="inner">
          <div className="probing">
            {stillLooking ? (
              <>
                <span className="pip" /> Loading item…
              </>
            ) : (
              <>This item is not in the inbox any more. <a href="#/inbox">Back to the inbox</a></>
            )}
          </div>
        </div>
      </div>
    )
  }

  const Icon = kindIcon(item)
  const status = item.status ?? 'open'
  const isOpen = status === 'open'
  const pri = item.priority ?? 0
  const watchId = item.watchId ?? item.foundBy?.[item.foundBy.length - 1]?.watchId
  const project = item.projectId ? projects.find((p) => p.id === item.projectId) : undefined
  const note = item.note ?? item.why

  return (
    <div className="itemPage">
      <div className="glow orange" aria-hidden="true" />

      <div className="itemMain">
        <div className="itemMeta">
          <Icon size={13} aria-hidden="true" />
          <span className="mono">{item.repo}</span>
          <span className="sep">·</span>
          <span>{KIND_LABEL[item.kind] ?? item.kind}</span>
          {item.author && (
            <>
              <span className="sep">·</span>
              <span>
                {item.source === 'manual' ? 'added' : 'opened'} {ago(item.createdAt)}
                {item.source !== 'manual' && ` by ${item.author}`}
              </span>
            </>
          )}
        </div>

        <h1 className="display md">{item.title}</h1>

        <div className="chipRow">
          <span className="pill mono">↑ {Math.round(item.score)}</span>
          {item.ciFailing && <span className="pill red">CI red</span>}
          {item.kind === 'own-pr-conflicting' && <span className="pill red">conflicts</span>}
          {item.peopleWaiting > 0 && (
            <span className="pill">
              {item.peopleWaiting} waiting
            </span>
          )}
          {pri > 0 && <span className={`pill ${pri <= 2 ? 'yellow' : ''}`}>{PRIORITY_LABEL[pri]}</span>}
          {item.isDraft && <span className="pill mute">draft</span>}
          {item.returned && <span className="pill green">returned</span>}
          {project && <span className="pill">{project.name}</span>}
          {watchId && watchTitles.has(watchId) && <span className="pill blue">{watchTitles.get(watchId)}</span>}
          {!isOpen && <span className="pill mute">{status}</span>}
        </div>

        <div className="card brief">
          <div className="briefHead">
            <span className="title">Details</span>
            <span className="when">updated {ago(item.updatedAt)}</span>
            <span className="right">
              {item.url && (
                <a className="btn xs" href={item.url} target="_blank" rel="noreferrer">
                  Open <ExternalLink size={11} aria-hidden="true" />
                </a>
              )}
            </span>
          </div>

          <div className="secLabel mute">Ranked because</div>
          <div className="line">
            <span className="dash">—</span>
            <span>{item.reason}</span>
          </div>

          {note && (
            <>
              <div className="secLabel mute">{item.source === 'manual' ? 'Note' : 'Match reason'}</div>
              <div className="quote">{note}</div>
            </>
          )}

          {item.foundBy && item.foundBy.length > 0 && (
            <>
              <div className="secLabel mute">
                Found by <span className="n">{item.foundBy.length}</span>
              </div>
              {item.foundBy.map((p, i) => (
                <div className="line" key={`${p.at}-${i}`}>
                  <span className="dash">—</span>
                  <span>
                    <span className="k">{p.watchId ? watchTitles.get(p.watchId) ?? 'a watch' : 'source scan'}</span>{' '}
                    · {ago(p.at)}{p.why ? ` · ${p.why}` : ''}
                  </span>
                </div>
              ))}
            </>
          )}

          <div className="secLabel mute">Source</div>
          <div className="line">
            <span className="dash">—</span>
            <span>
              <span className="k">{item.source}</span> · <span className="mono">{item.id}</span>
            </span>
          </div>
        </div>
      </div>

      <div className="itemAside">
        <div className="asideActions">
          <button type="button" className="btn primary wide" onClick={() => onDispatch(item)}>
            {linkedSessions.length > 0 ? 'Dispatch another session' : 'Dispatch to a session'}
          </button>
          {isOpen ? (
            <div className="btnGrid">
              <button type="button" className="btn" title="Mark done (e)" onClick={() => void setState('done')}>
                <Check size={12} aria-hidden="true" /> Done
              </button>
              <button type="button" className="btn" title="Snooze until tomorrow 9am (z)" onClick={snooze1d}>
                <AlarmClock size={12} aria-hidden="true" /> Snooze
              </button>
              <button type="button" className="btn" title="Archive (x)" onClick={() => void setState('archived')}>
                <Archive size={12} aria-hidden="true" /> Archive
              </button>
            </div>
          ) : (
            <div className="btnGrid">
              <button type="button" className="btn" onClick={() => void setState('open')}>
                Reopen
              </button>
              {status !== 'archived' && (
                <button type="button" className="btn" onClick={() => void setState('archived')}>
                  Archive
                </button>
              )}
            </div>
          )}
          {isOpen && (
            <select
              className={`prioSelect prio${pri}`}
              title="Set priority"
              value={pri}
              onChange={(e) => setPriority(Number(e.target.value))}
            >
              {PRIORITY_VALUES.map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? 'priority — none' : `priority — ${PRIORITY_LABEL[v]}`}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="secLabel mute">
          Sessions <span className="n">{linkedSessions.length}</span>
        </div>
        {linkedSessions.length === 0 ? (
          <div className="asideEmpty">None yet — Dispatch opens one in the matching project.</div>
        ) : (
          linkedSessions.map((s) => (
            <div key={s.id} className="card sessCard">
              <div className="head">
                <span className={`dot ${s.status === 'running' || s.status === 'starting' ? 'live' : s.status === 'error' ? 'red' : 'green'}`} />
                <span>{s.title}</span>
                <span className="when">{s.status}</span>
              </div>
              <div className="row mono">
                {s.cwd.split('/').pop()}
                {s.branch ? ` · ${s.branch}` : ''}
                {s.model ? ` · ${s.model}` : ''}
              </div>
              <a href={`#${s.id}`} onClick={(e) => { e.preventDefault(); onNavigate(s.id) }}>
                Re-enter session <ChevronRight size={12} aria-hidden="true" />
              </a>
            </div>
          ))
        )}

        <div className="secLabel mute">Linked</div>
        {item.linked && item.linked.length > 0 ? (
          item.linked.map((l) => (
            <div key={l.url} className="linkedRow">
              <Hash size={13} aria-hidden="true" />
              <span>
                <span className="src">{l.source} · {l.repo}</span>
                <br />
                <a href={l.url} target="_blank" rel="noreferrer">
                  {l.url.replace(/^https?:\/\//, '')}
                </a>
              </span>
            </div>
          ))
        ) : (
          <div className="asideEmpty">Nothing else refers to this item yet.</div>
        )}

        <div className="secLabel mute">Timeline</div>
        {events === null ? (
          <div className="asideEmpty">Loading…</div>
        ) : events.length === 0 ? (
          <div className="asideEmpty">No history recorded.</div>
        ) : (
          <div className="tl">
            {[...events].reverse().map((ev) => {
              const why = typeof ev.detail?.why === 'string' ? ev.detail.why : undefined
              const reason = typeof ev.detail?.reason === 'string' ? ev.detail.reason : undefined
              return (
                <div key={ev.seq} className="tlRow" title={new Date(ev.at).toLocaleString()}>
                  <span className="when">{relTime(ev.at)}</span>
                  <span>
                    {EVENT_LABEL[ev.event] ?? ev.event} <span className="who">· {actorLabel(ev.actor)}</span>
                    {(why || reason) && <span className="why">{why ?? reason}</span>}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
