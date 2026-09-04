import { Folder, GitBranch } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import type {
  EffortLevel,
  FastModeDisabledReason,
  FastModeState,
  PermissionMode,
  SessionStatus,
} from '../../../shared/protocol.js'
import { nextMode } from '../permissionModes.js'
import { FastModeToggle } from './FastModeToggle.js'
import { ModelPicker } from './ModelPicker.js'
import { PermissionModePicker } from './PermissionModePicker.js'

type Props = {
  status: SessionStatus
  cwd: string
  branch?: string
  model?: string
  effort?: EffortLevel
  fastMode?: boolean
  fastModeState?: FastModeState
  fastModeDisabledReason?: FastModeDisabledReason
  permissionMode?: PermissionMode
  onSend: (text: string) => void
  onInterrupt: () => void
  onModelChange: (model: string | undefined, effort: EffortLevel | undefined) => void
  onFastModeChange: (fastMode: boolean) => void
  onPermissionModeChange: (mode: PermissionMode) => void
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

export function Composer({
  status,
  cwd,
  branch,
  model,
  effort,
  fastMode,
  fastModeState,
  fastModeDisabledReason,
  permissionMode,
  onSend,
  onInterrupt,
  onModelChange,
  onFastModeChange,
  onPermissionModeChange,
}: Props) {
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
          <ModelPicker model={model} effort={effort} onChange={onModelChange} />
          <FastModeToggle
            model={model}
            fastMode={fastMode}
            state={fastModeState}
            reason={fastModeDisabledReason}
            onChange={onFastModeChange}
          />
          <PermissionModePicker mode={permissionMode} onChange={onPermissionModeChange} />
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
              } else if (e.key === 'Tab' && e.shiftKey) {
                // Claude Code's own gesture, and the composer is where the
                // hands already are — so it lives here rather than in the
                // global map, which ignores keys typed into a text field.
                e.preventDefault()
                onPermissionModeChange(nextMode(permissionMode))
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
          <kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for a new line · <kbd>Shift+Tab</kbd> to
          change what gets asked
        </div>
      </div>
    </div>
  )
}
