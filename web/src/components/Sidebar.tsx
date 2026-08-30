import { Eye, Folder, Inbox, Plug } from 'lucide-react'
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
}: Props) {
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
          <div
            key={s.id}
            className={`sess ${s.status}${s.id === currentId ? ' active' : ''}`}
            onClick={() => onSelect(s.id)}
          >
            <span className="dot" />
            <span className="name">{s.title}</span>
            <a
              href={`#${s.id}`}
              target="_blank"
              rel="noreferrer"
              title="Open in new tab"
              onClick={(e) => e.stopPropagation()}
            >
              ↗
            </a>
          </div>
        ))}
      </div>
      <div className={conn === 'connected' ? '' : 'down'} id="connState">
        {CONN_LABEL[conn]}
        <kbd title="Command center">{MOD_LABEL}K</kbd>
      </div>
    </div>
  )
}
