import type { SessionSummary } from '../../../shared/protocol.js'
import { MOD_LABEL } from '../keys.js'
import type { ConnState } from '../store.js'

type Props = {
  sessions: readonly SessionSummary[]
  currentId: string | null
  inboxActive: boolean
  projectsActive: boolean
  connectorsActive: boolean
  conn: ConnState
  onSelect: (id: string) => void
  onNew: () => void
  onInbox: () => void
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
  projectsActive,
  connectorsActive,
  conn,
  onSelect,
  onNew,
  onInbox,
  onProjects,
  onConnectors,
}: Props) {
  return (
    <div id="sidebar">
      <header>
        triage <small>local sessions · claude code harness</small>
      </header>
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
      <nav id="sideNav">
        <button className={`navItem${inboxActive ? ' active' : ''}`} onClick={onInbox}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9Zm1.5 0v5h2.6l.9 1.8c.17.34.52.55.9.55h.2c.38 0 .73-.21.9-.55l.9-1.8h2.6v-5h-9Z"/>
          </svg>
          Inbox
        </button>
        <button className={`navItem${projectsActive ? ' active' : ''}`} onClick={onProjects}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2c.4 0 .8.16 1.06.44l1.3 1.31c.1.1.23.16.35.16H13a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 13.9H3a1.5 1.5 0 0 1-1.5-1.5v-8.9Z" />
          </svg>
          Projects
        </button>
        <button className={`navItem${connectorsActive ? ' active' : ''}`} onClick={onConnectors}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6.3 2.3a1 1 0 0 1 1.4 0l.9.9-2.1 2.1 1.2 1.2 2.1-2.1.9.9a1 1 0 0 1 0 1.4L8.6 8.8a2.5 2.5 0 0 1-3.4.1L3.1 11 2 9.9l2.1-2.1a2.5 2.5 0 0 1 .1-3.4l2.1-2.1Zm4.4 6.6 1.2 1.2 2.1-2.1 1.1 1.1-2.1 2.1a2.5 2.5 0 0 1-.1 3.4l-2.1 2.1a1 1 0 0 1-1.4 0l-.9-.9 2.1-2.1-1.2-1.2-2.1 2.1-.9-.9a1 1 0 0 1 0-1.4l2.1-2.1a2.5 2.5 0 0 1 3.4-.1l.8-1.2Z"/>
          </svg>
          Connectors
        </button>
      </nav>
      <div className={conn === 'connected' ? '' : 'down'} id="connState">
        {CONN_LABEL[conn]}
        <kbd title="Command center">{MOD_LABEL}K</kbd>
      </div>
    </div>
  )
}
