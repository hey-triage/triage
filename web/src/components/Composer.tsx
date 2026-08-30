import { useCallback, useRef, useState } from 'react'
import type { SessionStatus } from '../../../shared/protocol.js'

type Props = {
  status: SessionStatus
  cwd: string
  branch?: string
  onSend: (text: string) => void
  onInterrupt: () => void
}

/** `/Users/you/Code/x` → `~/Code/x` — display only. */
function homely(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, '~')
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'starting…',
  running: 'working…',
  idle: 'ready',
  error: 'error',
}

export function Composer({ status, cwd, branch, onSend, onInterrupt }: Props) {
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const running = status === 'running' || status === 'starting'

  const autosize = useCallback(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [])

  function submit() {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
    requestAnimationFrame(autosize)
  }

  return (
    <div id="composer">
      <div className="frame">
        <div className="statusline">
          <span className="chip cwd" title={cwd}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2c.4 0 .8.16 1.06.44l1.3 1.31c.1.1.23.16.35.16H13a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 13.9H3a1.5 1.5 0 0 1-1.5-1.5v-8.9Z" />
            </svg>
            {homely(cwd)}
          </span>
          {branch && (
            <span className="chip branch" title={`git branch: ${branch}`}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4.75 2a1.75 1.75 0 0 0-.7 3.35v5.3a1.75 1.75 0 1 0 1.5 0V8.9c.34.28.78.45 1.25.45h2.5a3.25 3.25 0 0 0 3.2-2.7 1.75 1.75 0 1 0-1.52-.05 1.75 1.75 0 0 1-1.68 1.25H6.8c-.47 0-.9-.2-1.2-.52A1.75 1.75 0 0 0 4.75 2Z" />
              </svg>
              {branch}
            </span>
          )}
          <span className={`state ${status}`}>
            <span className="pip" />
            {STATUS_LABEL[status]}
          </span>
        </div>

        <div className="inputRow">
          <textarea
            id="box"
            ref={box}
            autoFocus
            rows={1}
            value={text}
            placeholder="Message Claude…"
            onChange={(e) => {
              setText(e.target.value)
              autosize()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          {running && (
            <button id="stopBtn" onClick={onInterrupt} title="Interrupt the current turn">
              Stop
            </button>
          )}
          <button id="sendBtn" onClick={submit} disabled={!text.trim()}>
            Send
          </button>
        </div>

        <div className="hint">
          <kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for a new line
        </div>
      </div>
    </div>
  )
}
