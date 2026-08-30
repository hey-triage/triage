import { memo } from 'react'
import { toolHint, truncate, type TranscriptItem } from '../transcript.js'

type Tool = Extract<TranscriptItem, { kind: 'tool' }>

export const ToolCard = memo(function ToolCard({ item }: { item: Tool }) {
  const state = item.result ? (item.result.isError ? 'fail' : 'ok') : 'busy'
  return (
    <details className="card">
      <summary>
        <span className={`glyph ${state}`}>{state === 'busy' ? '●' : state === 'ok' ? '✓' : '✕'}</span>
        <span className="toolName">{item.name}</span>
        <span className="toolHint">{toolHint(item.input)}</span>
      </summary>
      <pre>{truncate(JSON.stringify(item.input, null, 2), 2000)}</pre>
      {item.result && (
        <pre className="result" style={item.result.isError ? { color: 'var(--red)' } : undefined}>
          {truncate(item.result.text || '(no output)', 2000)}
        </pre>
      )}
    </details>
  )
})
