import { memo } from 'react'
import type { TranscriptItem } from '../transcript.js'

type Init = Extract<TranscriptItem, { kind: 'init' }>

/**
 * The session's opening line: model, tool count, and every MCP server it
 * loaded. Status is a dot, not a colour wash — connected green, anything else
 * dim — so a long connector list reads as inventory, not as a wall of alarms.
 */
export const InitCard = memo(function InitCard({ item }: { item: Init }) {
  const connected = item.servers.filter((s) => s.status === 'connected').length
  return (
    <details className="init">
      <summary>
        session ready · model <b>{item.model ?? '?'}</b> · {item.toolCount} tools
        {item.servers.length > 0 && (
          <>
            {' '}
            · {connected}/{item.servers.length} servers connected
          </>
        )}
      </summary>
      {item.servers.length > 0 && (
        <div className="mcp">
          {[...item.servers]
            .sort((a, b) => Number(b.status === 'connected') - Number(a.status === 'connected'))
            .map((s) => (
              <span key={s.name} className="pill mute" title={s.status}>
                <span className={`dot sm ${s.status === 'connected' ? 'green' : s.status === 'failed' ? 'red' : 'stone'}`} />
                {s.name}
              </span>
            ))}
        </div>
      )}
    </details>
  )
})
