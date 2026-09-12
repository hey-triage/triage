/**
 * One work item, in full: what it is (title + your description), the brief
 * about it (a markdown document a playbook run wrote — .docs/next-version.md),
 * why it ranked, what has happened to it, and the sessions working on it.
 * The actions live in the right column so the left reads as a page, not a form.
 */
import { AlarmClock, Archive, Check, ChevronRight, ExternalLink, FileText, Hash, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  BriefJobsResponse,
  BriefResponse,
  BriefView,
  ItemEvent,
  ItemEventsResponse,
  ItemListResponse,
  ItemStatus,
  Link,
  LinksResponse,
  Project,
  ProjectsResponse,
  ScoredItem,
  WatchesResponse,
} from '../../../shared/protocol.js'
import { useSessions } from '../hooks.js'
import { inboxStore, useInbox } from '../inboxStore.js'
import { briefPill, useBriefs } from '../briefStore.js'
import { store } from '../store.js'
import { KIND_LABEL, PRIORITY_LABEL, PRIORITY_VALUES, ago, kindIcon, relTime } from '../itemUi.js'
import { CreateBriefDialog } from './CreateBriefDialog.js'
import { Markdown } from './Markdown.js'

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
  const briefs = useBriefs()
  const open = snap.items.find((i) => i.id === id)
  // Not in the open inbox → it may be snoozed, done or archived.
  const [other, setOther] = useState<{ id: string; item: ScoredItem | null } | null>(null)
  const [events, setEvents] = useState<ItemEvent[] | null>(null)
  const [watchTitles, setWatchTitles] = useState<Map<string, string>>(new Map())
  const [projects, setProjects] = useState<Project[]>([])
  const [links, setLinks] = useState<Link[]>([])
  // A digest item's report: the artifact a watch run wrote, linked with role `report`.
  const [report, setReport] = useState<{ id: string; title: string; body: string; updated: number } | null>(null)
  const [brief, setBrief] = useState<BriefView | null>(null)
  const [briefOpen, setBriefOpen] = useState(false)
  const [descDraft, setDescDraft] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

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

  // The brief and the links follow the item's newest job: every transition
  // (queued → running → ready) arrives as a frame and refetches both.
  const job = briefs.byItem.get(id)
  const jobKey = job ? `${job.id}:${job.status}` : ''
  const loadBrief = useCallback(() => {
    void fetch(`/api/briefs?itemId=${encodeURIComponent(id)}`)
      .then((r) => r.json() as Promise<BriefResponse>)
      .then((b) => {
        if (b.ok) setBrief(b.brief)
      })
      .catch(() => {})
    void fetch(`/api/links?kind=item&id=${encodeURIComponent(id)}`)
      .then((r) => r.json() as Promise<LinksResponse>)
      .then((b) => {
        if (b.ok) setLinks(b.links)
      })
      .catch(() => {})
  }, [id])
  useEffect(loadBrief, [loadBrief, jobKey, sessions.length])
  // A hand edit of the brief file lands as an index change.
  useEffect(() => store.onArtifactsChanged(loadBrief), [loadBrief])

  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 2500)
    return () => window.clearTimeout(t)
  }, [notice])

  const item = open ?? (other?.id === id ? other.item : undefined)

  // Sessions from the links table (dispatch / brief); the pre-0.7 title match stays as a fallback.
  const linkedSessions = useMemo(() => {
    if (!item) return []
    const byId = new Map(sessions.map((s) => [s.id, s]))
    const seen = new Set<string>()
    const out: { s: (typeof sessions)[number]; role: string }[] = []
    for (const l of links) {
      if (l.fromKind !== 'session') continue
      const s = byId.get(l.fromId)
      if (!s || seen.has(s.id)) continue
      seen.add(s.id)
      out.push({ s, role: l.role })
    }
    for (const s of sessions) {
      if (!seen.has(s.id) && s.kind !== 'brief' && s.title === item.title.slice(0, 80)) out.push({ s, role: 'dispatch' })
    }
    return out
  }, [sessions, links, item])

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

  async function saveDescription() {
    if (!item || descDraft === null) return
    const description = descDraft.trim()
    setBusy('desc')
    try {
      const res = await fetch('/api/items/description', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id, description: description || null }),
      })
      const b = (await res.json()) as { ok: boolean; error?: string }
      if (!b.ok) {
        setNotice(b.error ?? 'could not save')
        return
      }
      const patch = (i: ScoredItem) => (i.id === item.id ? { ...i, description: description || undefined } : i)
      inboxStore.patch((items) => items.map(patch))
      setOther((o) => (o?.item ? { ...o, item: patch(o.item) } : o))
      setDescDraft(null)
    } finally {
      setBusy(null)
    }
  }

  async function iterate() {
    if (!item || !feedback.trim()) return
    setBusy('iterate')
    try {
      const res = await fetch('/api/briefs/iterate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, text: feedback.trim() }),
      })
      const b = (await res.json()) as BriefJobsResponse
      if (b.ok) setFeedback('')
      else setNotice(b.error)
    } finally {
      setBusy(null)
    }
  }

  async function cancelBrief() {
    if (!job || job.status !== 'queued') return
    await fetch('/api/briefs/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
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
              <>
                This item is not in the inbox any more. <a href="#/inbox">Back to the inbox</a>
              </>
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
  const settled = !job || job.status === 'ready' || job.status === 'failed'
  const pill = briefPill(job, brief?.stale ?? false)

  return (
    <div className="itemPage">
      <div className="glow orange" aria-hidden="true" />

      <div className="itemMain">
        <div className="itemMeta">
          <Icon size={13} aria-hidden="true" />
          {item.repo && <span className="mono">{item.repo}</span>}
          {item.repo && <span className="sep">·</span>}
          <span>{KIND_LABEL[item.kind] ?? item.kind}</span>
          <span className="sep">·</span>
          <span>
            {item.source === 'manual' ? 'added' : 'opened'} {ago(item.createdAt)}
            {item.source !== 'manual' && item.author && ` by ${item.author}`}
          </span>
        </div>

        <h1 className="display md">{item.title}</h1>

        <div className="chipRow">
          <span className="pill mono">↑ {Math.round(item.score)}</span>
          {item.ciFailing && <span className="pill red">CI red</span>}
          {item.kind === 'own-pr-conflicting' && <span className="pill red">conflicts</span>}
          {item.peopleWaiting > 0 && <span className="pill">{item.peopleWaiting} waiting</span>}
          {pri > 0 && <span className={`pill ${pri <= 2 ? 'yellow' : ''}`}>{PRIORITY_LABEL[pri]}</span>}
          {item.isDraft && <span className="pill mute">draft</span>}
          {item.returned && <span className="pill green">returned</span>}
          {project && <span className="pill">{project.name}</span>}
          {watchId && watchTitles.has(watchId) && <span className="pill blue">{watchTitles.get(watchId)}</span>}
          {!isOpen && <span className="pill mute">{status}</span>}
          {pill && (
            <span className={`pill ${pill.tone}`}>
              {job?.status === 'running' && <span className="dot live sm" aria-hidden="true" />}
              {pill.label}
            </span>
          )}
        </div>

        {/* Description — the human's intent, in their words. Never written by a run. */}
        <div className="descBlock">
          <div className="secLabel mute">Description</div>
          {descDraft !== null ? (
            <>
              <textarea
                autoFocus
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                placeholder="Your intent, in your words. The brief and any dispatched session read this."
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void saveDescription()
                  if (e.key === 'Escape') setDescDraft(null)
                }}
              />
              <div className="row">
                <button type="button" className="btn xs ghost" onClick={() => setDescDraft(null)}>
                  Cancel
                </button>
                <button type="button" className="btn xs primary" disabled={busy === 'desc'} onClick={() => void saveDescription()}>
                  Save
                </button>
              </div>
            </>
          ) : (
            <div
              className={`descText${item.description ? '' : ' empty'}`}
              role="button"
              tabIndex={0}
              title="Click to edit"
              onClick={() => setDescDraft(item.description ?? '')}
              onKeyDown={(e) => e.key === 'Enter' && setDescDraft(item.description ?? '')}
            >
              {item.description ?? 'Add a description — your intent, in your words. The brief and dispatched sessions read it.'}
            </div>
          )}
        </div>

        {report && (
          <div className="card briefCard">
            <div className="briefHead">
              <FileText size={14} aria-hidden="true" />
              <span className="title">Report</span>
              <span className="pill mute">{report.title}</span>
              <span className="right">
                <span className="when">rewritten {ago(report.updated)}</span>
                <button type="button" className="btn xs" onClick={() => onNavigate(`/artifact/${report.id}`)}>
                  Open artifact
                </button>
              </span>
            </div>
            <div className="briefBody">
              <Markdown text={report.body} />
            </div>
          </div>
        )}

        {item.kind !== 'digest' && (
          <>
        {/* The brief: a document a playbook run wrote, rewritten in place on iteration. */}
        <div className="card briefCard">
          <div className="briefHead">
            <FileText size={14} aria-hidden="true" />
            <span className="title">Brief</span>
            {pill && (
              <span className={`pill ${pill.tone}`}>
                {job?.status === 'running' && <span className="dot live sm" aria-hidden="true" />}
                {pill.label}
              </span>
            )}
            {job?.status === 'queued' && brief?.queuePosition != null && (
              <span className="when">#{brief.queuePosition + 1} in the queue</span>
            )}
            {brief?.artifact && <span className="when">updated {ago(brief.artifact.updated)}</span>}
            <span className="right">
              {job?.sessionId && (
                <button type="button" className="btn xs" onClick={() => onNavigate(job.sessionId!)} title="The run's transcript">
                  Open session
                </button>
              )}
              {brief?.artifact && (
                <button type="button" className="btn xs" onClick={() => onNavigate(`/artifact/${brief.artifact!.id}`)} title="The brief as an artifact">
                  Open artifact
                </button>
              )}
              {job?.status === 'queued' && (
                <button type="button" className="btn xs ghost" onClick={() => void cancelBrief()}>
                  <X size={11} aria-hidden="true" /> Cancel
                </button>
              )}
              {settled && (
                <button type="button" className="btn xs primary" onClick={() => setBriefOpen(true)}>
                  <Sparkles size={11} aria-hidden="true" /> {brief?.artifact ? 'Re-brief' : 'Create brief'}
                </button>
              )}
            </span>
          </div>

          {job?.status === 'failed' && job.error && <div className="msg error">{job.error}</div>}
          {brief?.stale && settled && (
            <div className="notice">The source moved after this brief was written — re-brief to catch up.</div>
          )}

          {brief?.body ? (
            <div className="briefBody">
              <Markdown text={brief.body} />
            </div>
          ) : (
            <div className="briefEmpty">
              {job?.status === 'running' ? (
                <>The playbook is reading the item now. The brief lands here when it calls <b>write_brief</b>.</>
              ) : job?.status === 'queued' ? (
                <>Queued. Briefs run one at a time, in order.</>
              ) : (
                <>
                  No brief yet. <b>Create brief</b> runs the <b>{KIND_LABEL[item.kind] ?? item.kind}</b> playbook against this item
                  — it reads, never writes — and the result lands here as a document you can iterate on. Or skip it and{' '}
                  <b>Dispatch</b> if you already know what to do.
                </>
              )}
            </div>
          )}

          {brief?.body && settled && (
            <div className="briefIterate">
              <textarea
                placeholder="You missed X… — the same session rewrites the brief"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void iterate()
                }}
              />
              <button type="button" className="btn sm" disabled={!feedback.trim() || busy === 'iterate'} onClick={() => void iterate()}>
                Send
              </button>
            </div>
          )}
        </div>
          </>
        )}

        {notice && <div className="notice">{notice}</div>}

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

          {item.why && item.source !== 'manual' && (
            <>
              <div className="secLabel mute">Match reason</div>
              <div className="quote">{item.why}</div>
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
                    <span className="k">{p.watchId ? watchTitles.get(p.watchId) ?? 'a watch' : 'source scan'}</span> · {ago(p.at)}
                    {p.why ? ` · ${p.why}` : ''}
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
          <button type="button" className="btn primary wide" onClick={() => onDispatch(item)} title="Start a session on this item — the brief rides along if there is one">
            {linkedSessions.some((x) => x.role === 'dispatch') ? 'Dispatch another session' : 'Dispatch to a session'}
          </button>
          {isOpen && settled && (
            <button type="button" className="btn wide" onClick={() => setBriefOpen(true)}>
              <Sparkles size={12} aria-hidden="true" /> {brief?.artifact ? 'Re-brief' : 'Create brief'}
            </button>
          )}
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
            <select className={`prioSelect prio${pri}`} title="Set priority" value={pri} onChange={(e) => setPriority(Number(e.target.value))}>
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
          <div className="asideEmpty">None yet — Dispatch opens one in the matching project; a brief run is one too.</div>
        ) : (
          linkedSessions.map(({ s, role }) => (
            <div key={s.id} className="card sessCard">
              <div className="head">
                <span className={`dot ${s.status === 'running' || s.status === 'starting' ? 'live' : s.status === 'error' ? 'red' : 'green'}`} />
                <span>{s.title}</span>
                <span className="when">
                  {role} · {s.status}
                </span>
              </div>
              <div className="row mono">
                {s.cwd.split('/').pop()}
                {s.branch ? ` · ${s.branch}` : ''}
                {s.model ? ` · ${s.model}` : ''}
              </div>
              <a
                href={`#${s.id}`}
                onClick={(e) => {
                  e.preventDefault()
                  onNavigate(s.id)
                }}
              >
                {role === 'brief' ? 'Open the run' : 'Re-enter session'} <ChevronRight size={12} aria-hidden="true" />
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
                <span className="src">
                  {l.source} · {l.repo}
                </span>
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

      <CreateBriefDialog open={briefOpen} items={[item]} onClose={() => setBriefOpen(false)} onQueued={() => {}} />
    </div>
  )
}
