import { useEffect, useState } from 'react'
import type {
  BranchResponse,
  EffortLevel,
  ImageAttachment,
  PermissionMode,
  Project,
  ProjectsResponse,
} from '../../../shared/protocol.js'
import type { Draft } from '../drafts.js'
import { isEffort } from '../models.js'
import { isPermissionMode } from '../permissionModes.js'
import { PromptBox } from './PromptBox.js'
import { PromptHead } from './PromptHead.js'

export type NewSession = {
  title: string
  cwd: string
  firstMessage: string
  model?: string
  effort?: EffortLevel
  fastMode?: boolean
  permissionMode?: PermissionMode
  images?: ImageAttachment[]
}

type Props = {
  /** The draft this tab edits; text and folder round-trip through it so they survive a tab switch. */
  draft: Draft
  onChange: (patch: { text?: string; cwd?: string; label?: string }) => void
  onCreate: (s: NewSession) => void
}


// The last model picked here is the default for the next new session — a
// per-browser preference, so it does not belong in the session store.
const MODEL_KEY = 'triage.newSession.model'
const EFFORT_KEY = 'triage.newSession.effort'
// Fast mode is remembered too, but as an explicit '1' — anything else is off,
// so a stale or garbled value can never quietly start billing at premium rates.
const FAST_MODE_KEY = 'triage.newSession.fastMode'
// Permission mode is remembered the same way — someone who works in auto mode
// wants the next session in auto mode too, not a fresh round of prompts.
const PERMISSION_KEY = 'triage.newSession.permissionMode'

const remembered = (key: string): string | undefined => localStorage.getItem(key) ?? undefined

function remember(key: string, value: string | undefined) {
  if (value) localStorage.setItem(key, value)
  else localStorage.removeItem(key)
}

function titleFrom(text: string): string {
  return text.trim().split('\n')[0].slice(0, 80)
}


/** A draft tab: the composer that becomes a session on first send. */
export function NewSessionComposer({ draft, onChange, onCreate }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [branch, setBranch] = useState<string | null>(null)
  // No folder chosen yet → the first saved project, else home.
  const cwd = draft.cwd ?? projects[0]?.path ?? '~'
  const [model, setModel] = useState<string | undefined>(() => remembered(MODEL_KEY))
  const [effort, setEffort] = useState<EffortLevel | undefined>(() => {
    const stored = remembered(EFFORT_KEY)
    return isEffort(stored) ? stored : undefined
  })
  const [fastMode, setFastMode] = useState(() => remembered(FAST_MODE_KEY) === '1')
  const [permissionMode, setPermissionMode] = useState<PermissionMode | undefined>(() => {
    const stored = remembered(PERMISSION_KEY)
    return isPermissionMode(stored) ? stored : undefined
  })

  useEffect(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [])

  // The header names the branch the session will start on.
  useEffect(() => {
    let live = true
    setBranch(null)
    void fetch(`/api/git/branch?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json() as Promise<BranchResponse>)
      .then((b) => {
        if (live && b.ok) setBranch(b.branch)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [cwd])

  return (
    <div id="newSessionHome">
      <div className="glow blue" aria-hidden="true" />
      <h2>{draft.label ? 'Dispatching.' : 'What are we working on?'}</h2>
      <PromptBox
        head={
          <PromptHead
            projects={projects}
            cwd={cwd}
            branch={branch}
            onPick={(path) => onChange({ cwd: path })}
          />
        }
        text={draft.text}
        onTextChange={(text) => onChange({ text })}
        placeholder="Describe what you want to work on — a bug, a feature, a question…"
        focusKey={draft.id}
        sendTitle="Start the session (Enter)"
        onSubmit={(text, images) =>
          onCreate({
            title: draft.label ?? titleFrom(text),
            cwd,
            firstMessage: text,
            model,
            effort,
            fastMode,
            permissionMode,
            images,
          })
        }
        model={model}
        effort={effort}
        fastMode={fastMode}
        permissionMode={permissionMode}
        onModelChange={(m, e) => {
          setModel(m)
          setEffort(e)
          remember(MODEL_KEY, m)
          remember(EFFORT_KEY, e)
        }}
        onFastModeChange={(on) => {
          setFastMode(on)
          remember(FAST_MODE_KEY, on ? '1' : undefined)
        }}
        onPermissionModeChange={(m) => {
          setPermissionMode(m)
          remember(PERMISSION_KEY, m)
        }}
      />
      <div className="keysHint">
        <kbd>Enter</kbd> starts · <kbd>Shift+Enter</kbd> newline · <kbd>Shift+Tab</kbd> changes what gets asked
      </div>

    </div>
  )
}
