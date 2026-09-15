import { useEffect, useState } from 'react'
import type {
  EffortLevel,
  ImageAttachment,
  Mention,
  FastModeDisabledReason,
  FastModeState,
  PermissionMode,
  Project,
  ProjectsResponse,
  SessionStatus,
} from '../../../shared/protocol.js'
import { PromptBox } from './PromptBox.js'
import { PromptHead } from './PromptHead.js'

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
  /**
   * Text pushed in from outside — a quoted diff selection. The nonce is what
   * makes a second quote of the same lines still land.
   */
  quote?: { text: string; nonce: number }
  onSend: (text: string, images?: ImageAttachment[], mentions?: Mention[]) => void
  onInterrupt: () => void
  onModelChange: (model: string | undefined, effort: EffortLevel | undefined) => void
  onFastModeChange: (fastMode: boolean) => void
  onPermissionModeChange: (mode: PermissionMode) => void
}

/**
 * The session composer — the same prompt box the draft tab uses, headed by the
 * folder the session runs in, plus the interrupt button while a turn is live.
 */
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
  quote,
  onSend,
  onInterrupt,
  onModelChange,
  onFastModeChange,
  onPermissionModeChange,
}: Props) {
  const [text, setText] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const running = status === 'running' || status === 'starting'

  // A quote from the changes drawer appends to whatever is already typed, so
  // picking two hunks before writing the instruction works.
  const nonce = quote?.nonce ?? 0
  useEffect(() => {
    if (!quote || !nonce) return
    setText((prev) => (prev && !prev.endsWith('\n') ? `${prev}\n${quote.text}` : `${prev}${quote.text}`))
    // `quote.text` is intentionally not a dependency: the nonce is the signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce])

  // Only to name the project in the header — the folder itself is already fixed.
  useEffect(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [])

  return (
    <PromptBox
      head={<PromptHead projects={projects} cwd={cwd} branch={branch} />}
      cwd={cwd}
      text={text}
      onTextChange={setText}
      focusKey={nonce ? `quote-${nonce}` : undefined}
      placeholder={running ? 'Steer the session… (queued until this turn ends)' : 'Steer the session…'}
      sendTitle="Send (Enter)"
      onSubmit={(trimmed, images, mentions) => {
        onSend(trimmed, images, mentions)
        setText('')
      }}
      model={model}
      effort={effort}
      fastMode={fastMode}
      fastModeState={fastModeState}
      fastModeDisabledReason={fastModeDisabledReason}
      permissionMode={permissionMode}
      onModelChange={onModelChange}
      onFastModeChange={onFastModeChange}
      onPermissionModeChange={onPermissionModeChange}
      running={running}
      onInterrupt={onInterrupt}
    />
  )
}
