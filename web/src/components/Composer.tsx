import { ArrowUp, Square } from 'lucide-react'
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
import { ModelPopover } from './ModelPopover.js'
import { PermissionModePicker } from './PermissionModePicker.js'

type Props = {
  status: SessionStatus
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

/**
 * The session composer: a card with the message on top and the session's
 * knobs as pills underneath — model, fast mode, how much it asks — and the one
 * bright control on the page, the send button.
 */
export function Composer({
  status,
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
      <div className="frame card">
        <textarea
          id="box"
          ref={box}
          autoFocus
          rows={1}
          value={text}
          placeholder={running ? 'Steer the session… (queued until this turn ends)' : 'Steer the session…'}
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

        <div className="statusline">
          <ModelPopover model={model} effort={effort} onModelChange={onModelChange} />
          <PermissionModePicker mode={permissionMode} onChange={onPermissionModeChange} />
          <span className="spacer" />
          <FastModeToggle
            model={model}
            fastMode={fastMode}
            state={fastModeState}
            reason={fastModeDisabledReason}
            onChange={onFastModeChange}
          />
          {running && (
            <button id="stopBtn" onClick={onInterrupt} title="Interrupt the current turn" aria-label="Stop">
              <Square size={11} aria-hidden="true" />
            </button>
          )}
          <button id="sendBtn" onClick={submit} disabled={!text.trim()} title="Send (Enter)">
            <ArrowUp size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
