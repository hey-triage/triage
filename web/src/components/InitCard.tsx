import { memo } from 'react'
import type { TranscriptItem } from '../transcript.js'

type Init = Extract<TranscriptItem, { kind: 'init' }>

export const InitCard = memo(function InitCard({ item }: { item: Init }) {
  return (
    <div className="init">
      <div>
        session ready · model <b>{item.model ?? '?'}</b> · {item.toolCount} tools
      </div>
      {item.servers.length > 0 && (
        <div className="mcp">
          {item.servers.map((s) => (
            <span key={s.name} className={s.status === 'connected' ? 'ok' : 'bad'} title={s.status}>
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
})
