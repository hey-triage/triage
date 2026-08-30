import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { PermissionBehavior, SessionEvent } from '../../../shared/protocol.js'
import { useLiveText } from '../hooks.js'
import { buildTranscript, type TranscriptItem } from '../transcript.js'
import { InitCard } from './InitCard.js'
import { Markdown } from './Markdown.js'
import { PermissionCard } from './PermissionCard.js'
import { ToolCard } from './ToolCard.js'

type Props = {
  sessionId: string
  events: readonly SessionEvent[]
  onRespond: (requestId: string, behavior: PermissionBehavior) => void
}

export function Transcript({ sessionId, events, onRespond }: Props) {
  const items = useMemo(() => buildTranscript(events), [events])
  const { ref, scrollToBottom } = useStickToBottom()

  // Committed events grow the transcript; the streaming line grows it too, but
  // re-renders separately (see LiveLine), so it calls back in here to scroll.
  useLayoutEffect(scrollToBottom, [items, scrollToBottom])

  return (
    <div id="transcript" ref={ref}>
      <div className="inner">
        {items.map((item) => (
          <Item key={item.key} item={item} onRespond={onRespond} />
        ))}
        <LiveLine sessionId={sessionId} onGrow={scrollToBottom} />
      </div>
    </div>
  )
}

const Item = memo(function Item({
  item,
  onRespond,
}: {
  item: TranscriptItem
  onRespond: Props['onRespond']
}) {
  switch (item.kind) {
    case 'user':
      return <div className="msg user">{item.text}</div>
    case 'assistant':
      return (
        <div className="msg assistant">
          <Markdown text={item.text} />
        </div>
      )
    case 'thinking':
      return <div className="msg thinking">{item.text}</div>
    case 'error':
      return <div className="msg error">{item.text}</div>
    case 'meta':
      return <div className="meta">{item.text}</div>
    case 'init':
      return <InitCard item={item} />
    case 'tool':
      return <ToolCard item={item} />
    case 'permission':
      return <PermissionCard item={item} onRespond={onRespond} />
  }
})

/**
 * The partially-streamed assistant message. Isolated in its own component so a
 * burst of token deltas re-renders this node alone — the rest of the transcript
 * is untouched between committed messages.
 */
function LiveLine({ sessionId, onGrow }: { sessionId: string; onGrow: () => void }) {
  const text = useLiveText(sessionId)
  useLayoutEffect(() => {
    if (text) onGrow()
  }, [text, onGrow])
  if (!text) return null
  return (
    <div className="msg assistant live">
      <Markdown text={text} />
    </div>
  )
}

/** Follows new output, unless the reader has scrolled up to look at something. */
function useStickToBottom() {
  const ref = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [])

  return { ref, scrollToBottom }
}
