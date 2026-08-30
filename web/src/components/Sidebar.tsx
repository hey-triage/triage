import {
  Eye,
  ExternalLink,
  Folder,
  Inbox,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '../../../shared/protocol.js'
import { MOD_LABEL } from '../keys.js'
import type { ConnState } from '../store.js'

type Props = {
  sessions: readonly SessionSummary[]
  currentId: string | null
  inboxActive: boolean
  watchesActive: boolean
  projectsActive: boolean
  connectorsActive: boolean
  conn: ConnState
  onSelect: (id: string) => void
  onNew: () => void
  onInbox: () => void
  onWatches: () => void
  onProjects: () => void
  onConnectors: () => void
  onRename: (id: string, title: string) => void
  onSetPinned: (id: string, pinned: boolean) => void
  onDelete: (id: string) => void
}

const CONN_LABEL: Record<ConnState, string> = {
  connecting: 'connecting…',
  connected: 'connected',
  disconnected: 'disconnected — retrying…',
}

export function Sidebar({
  sessions,
  currentId,
  inboxActive,
  watchesActive,
  projectsActive,
  connectorsActive,
  conn,
  onSelect,
  onNew,
  onInbox,
  onWatches,
  onProjects,
  onConnectors,
  onRename,
  onSetPinned,
  onDelete,
}: Props) {
  // At most one row is in a menu or a rename at a time — the sidebar is a list,
  // not a form.
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  // Deleting is irreversible, so it is confirmed in a modal rather than on the
  // row — the session it would destroy is named in the question.
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)

  return (
    <div id="sidebar">
      <header>
        triage <small>local sessions · claude code harness</small>
      </header>
      <nav id="sideNav">
        <button className={`navItem${inboxActive ? ' active' : ''}`} onClick={onInbox}>
          <Inbox size={16} aria-hidden="true" />
          Inbox
        </button>
        <button className={`navItem${watchesActive ? ' active' : ''}`} onClick={onWatches}>
          <Eye size={16} aria-hidden="true" />
          Watches
        </button>
        <button className={`navItem${projectsActive ? ' active' : ''}`} onClick={onProjects}>
          <Folder size={16} aria-hidden="true" />
          Projects
        </button>
        <button className={`navItem${connectorsActive ? ' active' : ''}`} onClick={onConnectors}>
          <Plug size={16} aria-hidden="true" />
          Connectors
        </button>
      </nav>
      <button id="newBtn" onClick={onNew}>
        + New session
      </button>
      <div id="sessionList">
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === currentId}
            menuOpen={menuFor === s.id}
            renaming={renaming === s.id}
            onSelect={() => onSelect(s.id)}
            onOpenMenu={(open) => setMenuFor(open ? s.id : null)}
            onStartRename={() => {
              setMenuFor(null)
              setRenaming(s.id)
            }}
            onEndRename={(title) => {
              setRenaming(null)
              if (title !== undefined && title !== s.title) onRename(s.id, title)
            }}
            onSetPinned={(pinned) => {
              setMenuFor(null)
              onSetPinned(s.id, pinned)
            }}
            onDelete={() => {
              setMenuFor(null)
              setDeleting(s)
            }}
          />
        ))}
      </div>
      <div className={conn === 'connected' ? '' : 'down'} id="connState">
        {CONN_LABEL[conn]}
        <kbd title="Command center">{MOD_LABEL}K</kbd>
      </div>

      <DeleteSessionDialog
        session={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) onDelete(deleting.id)
          setDeleting(null)
        }}
      />
    </div>
  )
}

/**
 * The confirmation for a delete. A native <dialog>, like the other modals, so
 * Escape and the backdrop close it and `anyDialogOpen` sees it.
 */
function DeleteSessionDialog({
  session,
  onCancel,
  onConfirm,
}: {
  session: SessionSummary | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (session && !el.open) el.showModal()
    if (!session && el.open) el.close()
  }, [session])

  return (
    <dialog
      ref={dialog}
      id="deleteSession"
      onClose={onCancel}
      onClick={(e) => e.target === dialog.current && onCancel()}
    >
      <h3>Delete session?</h3>
      <p>
        <strong>{session?.title}</strong> and its whole transcript will be deleted. This cannot be
        undone.
      </p>
      <div className="row">
        <button type="button" className="cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          Delete session
        </button>
      </div>
    </dialog>
  )
}

type RowProps = {
  session: SessionSummary
  active: boolean
  menuOpen: boolean
  renaming: boolean
  onSelect: () => void
  onOpenMenu: (open: boolean) => void
  onStartRename: () => void
  /** `undefined` = cancelled; a string = the committed title. */
  onEndRename: (title?: string) => void
  onSetPinned: (pinned: boolean) => void
  onDelete: () => void
}

function SessionRow({
  session: s,
  active,
  menuOpen,
  renaming,
  onSelect,
  onOpenMenu,
  onStartRename,
  onEndRename,
  onSetPinned,
  onDelete,
}: RowProps) {
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  // Same dismissal rules as the composer's pickers: click outside, or Escape.
  useEffect(() => {
    if (!menuOpen) return
    function onDown(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) onOpenMenu(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onOpenMenu(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [menuOpen, onOpenMenu])

  useEffect(() => {
    if (renaming) input.current?.select()
  }, [renaming])

  if (renaming) {
    return (
      <div className={`sess ${s.status}${active ? ' active' : ''} renaming`}>
        <span className="dot" />
        <input
          ref={input}
          className="renameInput"
          defaultValue={s.title}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEndRename(e.currentTarget.value.trim() || undefined)
            else if (e.key === 'Escape') {
              e.stopPropagation()
              onEndRename()
            }
          }}
          onBlur={(e) => onEndRename(e.currentTarget.value.trim() || undefined)}
        />
      </div>
    )
  }

  return (
    <div
      ref={root}
      className={`sess ${s.status}${active ? ' active' : ''}`}
      data-menu-open={menuOpen || undefined}
      onClick={onSelect}
    >
      <span className="dot" />
      <span className="name">{s.title}</span>
      {s.pinned && <Pin className="pinMark" size={11} aria-label="Pinned" />}
      <button
        type="button"
        className="sessMenuBtn"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Session options for ${s.title}`}
        title="Session options"
        onClick={(e) => {
          e.stopPropagation()
          onOpenMenu(!menuOpen)
        }}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>

      {menuOpen && (
        <div className="sessMenu" role="menu" onClick={(e) => e.stopPropagation()}>
          <a className="row" href={`#${s.id}`} target="_blank" rel="noreferrer" role="menuitem">
            <ExternalLink size={14} aria-hidden="true" />
            Open in new tab
          </a>
          <button type="button" className="row" role="menuitem" onClick={() => onSetPinned(!s.pinned)}>
            {s.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
            {s.pinned ? 'Unpin' : 'Pin to top'}
          </button>
          <button type="button" className="row" role="menuitem" onClick={onStartRename}>
            <Pencil size={14} aria-hidden="true" />
            Rename
          </button>
          <button type="button" className="row danger" role="menuitem" onClick={onDelete}>
            <Trash2 size={14} aria-hidden="true" />
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
