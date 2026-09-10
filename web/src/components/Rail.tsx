import { Eye, Folder, Inbox, MessagesSquare, Plug, Terminal, type LucideProps } from 'lucide-react'
import type { ComponentType } from 'react'
import type { ConnState } from '../store.js'

export type RailSection = 'inbox' | 'sessions' | 'terminals' | 'watches' | 'projects' | 'connectors'

type Props = {
  active: RailSection | null
  inboxCount: number
  runningCount: number
  terminalCount: number
  workspaceColor?: string
  conn: ConnState
  onGo: (section: RailSection) => void
}

const ITEMS: Array<{ id: RailSection; label: string; icon: ComponentType<LucideProps> }> = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'sessions', label: 'Sessions', icon: MessagesSquare },
  { id: 'terminals', label: 'Terminals', icon: Terminal },
  { id: 'watches', label: 'Watches', icon: Eye },
  { id: 'projects', label: 'Projects', icon: Folder },
  { id: 'connectors', label: 'Connectors', icon: Plug },
]

/** The labelled 64px rail — one button per destination, counts as small badges. */
export function Rail({ active, inboxCount, runningCount, terminalCount, workspaceColor, conn, onGo }: Props) {
  return (
    <nav className="rail" aria-label="Sections">
      {ITEMS.map(({ id, label, icon: Icon }) => {
        const badge = id === 'inbox' ? inboxCount : id === 'sessions' ? runningCount : id === 'terminals' ? terminalCount : 0
        return (
          <button
            key={id}
            type="button"
            className={`railBtn${active === id ? ' active' : ''}`}
            title={label}
            aria-current={active === id ? 'page' : undefined}
            onClick={() => onGo(id)}
          >
            <Icon size={18} aria-hidden="true" />
            <span className="label">{label}</span>
            {badge > 0 && <span className="railBadge">{badge > 99 ? '99+' : badge}</span>}
          </button>
        )
      })}
      <span className="spacer" />
      <span className="railFoot" aria-hidden="true">
        <span className="dot" style={{ width: 7, height: 7, background: workspaceColor ?? 'var(--stone)' }} />
        <span className={`dot sm ${conn === 'connected' ? 'green' : conn === 'connecting' ? 'yellow' : 'red'}`} />
      </span>
    </nav>
  )
}
