import { Folder, GitBranch } from 'lucide-react'
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
            <Folder size={14} aria-hidden="true" />
            {homely(cwd)}
          </span>
          {branch && (
            <span className="chip branch" title={`git branch: ${branch}`}>
              <GitBranch size={14} aria-hidden="true" />
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
