import { memo } from 'react'
import type { PermissionBehavior } from '../../../shared/protocol.js'
import { truncate, type TranscriptItem } from '../transcript.js'

type Permission = Extract<TranscriptItem, { kind: 'permission' }>

type Props = {
  item: Permission
  onRespond: (requestId: string, behavior: PermissionBehavior) => void
}

export const PermissionCard = memo(function PermissionCard({ item, onRespond }: Props) {
  return (
    <div className="perm">
      <div className="q">
        Claude wants to use <b>{item.toolName}</b>
        {item.title && (
          <>
            <br />
            {item.title}
          </>
        )}
      </div>
      <pre>{truncate(JSON.stringify(item.input, null, 2), 1200)}</pre>
      {item.resolved ? (
        <span className={`verdict ${item.resolved}`}>
          {item.resolved === 'allow' ? '✓ allowed' : item.resolved === 'deny' ? '✕ denied' : '— expired (session ended before it was answered)'}
        </span>
      ) : (
        <>
          <button className="allow" onClick={() => onRespond(item.id, 'allow')}>
            Allow
          </button>
          <button className="deny" onClick={() => onRespond(item.id, 'deny')}>
            Deny
          </button>
        </>
      )}
    </div>
  )
})
