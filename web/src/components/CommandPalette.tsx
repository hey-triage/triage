import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  InboxResponse,
  Project,
  ProjectsResponse,
  ScoredItem,
  SessionSummary,
} from '../../../shared/protocol.js'

export type Command = {
  id: string
  section: 'Actions' | 'Pages' | 'Projects' | 'Sessions' | 'Work items'
  label: string
  hint?: string
  run: () => void
}

type Props = {
  open: boolean
  sessions: readonly SessionSummary[]
  onClose: () => void
  onNavigate: (hash: string) => void
  onNewSession: () => void
  onDispatch: (item: ScoredItem) => void
  onNewSessionIn: (project: Project) => void
  onSyncInbox: () => void
  onHelp: () => void
}

const SECTION_ORDER: Command['section'][] = ['Actions', 'Pages', 'Projects', 'Sessions', 'Work items']

export function CommandPalette({
  open,
  sessions,
  onClose,
  onNavigate,
  onNewSession,
  onDispatch,
  onNewSessionIn,
  onSyncInbox,
  onHelp,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [items, setItems] = useState<ScoredItem[]>([])
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) {
      setQuery('')
      setSel(0)
      el.showModal()
      // Work items come from the server's snapshot cache — ~30ms, no sync.
      void fetch('/api/inbox')
        .then((r) => r.json() as Promise<InboxResponse>)
        .then((b) => {
          if (b.ok) setItems(b.items)
        })
        .catch(() => {})
      void fetch('/api/projects')
        .then((r) => r.json() as Promise<ProjectsResponse>)
        .then((b) => {
          if (b.ok) setProjects(b.projects)
        })
        .catch(() => {})
    }
    if (!open && el.open) el.close()
  }, [open])

  const commands = useMemo<Command[]>(
    () => [
      { id: 'new', section: 'Actions', label: 'New session', hint: 'n', run: onNewSession },
      { id: 'sync', section: 'Actions', label: 'Sync inbox now', run: onSyncInbox },
      { id: 'help', section: 'Actions', label: 'Keyboard shortcuts', hint: '?', run: onHelp },
      { id: 'inbox', section: 'Pages', label: 'Inbox', hint: 'g i', run: () => onNavigate('/inbox') },
      { id: 'projects', section: 'Pages', label: 'Projects', hint: 'g p', run: () => onNavigate('/projects') },
      { id: 'connectors', section: 'Pages', label: 'Connectors', hint: 'g c', run: () => onNavigate('/connectors') },
      ...projects.map((pr): Command => ({
        id: `p:${pr.id}`,
        section: 'Projects',
        label: `New session in ${pr.name}`,
        hint: pr.repo || pr.path.split('/').pop(),
        run: () => onNewSessionIn(pr),
      })),
      ...sessions.map((s): Command => ({
        id: `s:${s.id}`,
        section: 'Sessions',
        label: s.title,
        hint: `${s.status} · ${s.cwd.split('/').pop() ?? ''}`,
        run: () => onNavigate(s.id),
      })),
      ...items.map((i): Command => ({
        id: `w:${i.id}`,
        section: 'Work items',
        label: `Dispatch: ${i.title}`,
        hint: `${i.repo} · ${i.reason}`,
        run: () => onDispatch(i),
      })),
    ],
    [sessions, items, projects, onNavigate, onNewSession, onDispatch, onNewSessionIn, onSyncInbox, onHelp],
  )

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = q
      ? commands.filter((c) => (c.label + ' ' + (c.hint ?? '')).toLowerCase().includes(q))
      : commands
    return [...matched].sort(
      (a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section),
    )
  }, [commands, query])

  const clamped = Math.min(sel, Math.max(0, shown.length - 1))

  function runSelected() {
    const cmd = shown[clamped]
    if (!cmd) return
    onClose()
    cmd.run()
  }

  return (
    <dialog ref={dialog} id="palette" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <input
        autoFocus
        placeholder="Type a command, session, or work item…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setSel(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSel((s) => Math.min(s + 1, shown.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSel((s) => Math.max(s - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            runSelected()
          }
        }}
      />
      <div className="palList">
        {shown.map((cmd, i) => (
          <div key={cmd.id}>
            {(i === 0 || shown[i - 1].section !== cmd.section) && (
              <div className="palSection">{cmd.section}</div>
            )}
            <div
              className={`palRow${i === clamped ? ' sel' : ''}`}
              ref={i === clamped ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              onMouseMove={() => i !== clamped && setSel(i)}
              onClick={runSelected}
            >
              <span className="palLabel">{cmd.label}</span>
              {cmd.hint && <span className="palHint">{cmd.hint}</span>}
            </div>
          </div>
        ))}
        {shown.length === 0 && <div className="palEmpty">Nothing matches.</div>}
      </div>
    </dialog>
  )
}
