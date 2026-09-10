import { Check, Loader, X } from 'lucide-react'
import { memo } from 'react'
import { toolHint, truncate, type TranscriptItem } from '../transcript.js'

type Tool = Extract<TranscriptItem, { kind: 'tool' }>

export const ToolCard = memo(function ToolCard({ item }: { item: Tool }) {
  const state = item.result ? (item.result.isError ? 'fail' : 'ok') : 'busy'
  return (
    <details className="tool">
      <summary>
        <span className={`glyph ${state}`} aria-label={state}>
          {state === 'busy' ? (
            <Loader size={13} aria-hidden="true" />
          ) : state === 'ok' ? (
            <Check size={13} aria-hidden="true" />
          ) : (
            <X size={13} aria-hidden="true" />
          )}
        </span>
        <span className="toolName">{item.name}</span>
        <span className="toolHint">{toolHint(item.input)}</span>
      </summary>
      <pre className="well">{truncate(JSON.stringify(item.input, null, 2), 2000)}</pre>
      {item.result && (
        <pre className={`well result${item.result.isError ? ' fail' : ''}`}>
          {truncate(item.result.text || '(no output)', 2000)}
        </pre>
      )}
    </details>
  )
})
