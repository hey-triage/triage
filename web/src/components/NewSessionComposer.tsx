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
import { readSessionDefaults, writeSessionDefaults } from '../sessionDefaults.js'
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


// The last pick here is the default for the next new session — a per-browser
// preference (see sessionDefaults.ts), which the Sessions settings tab edits too.
const defaults = readSessionDefaults()

function titleFrom(text: string): string {
  return text.trim().split('\n')[0].slice(0, 80)
}


/** A draft tab: the composer that becomes a session on first send. */
export function NewSessionComposer({ draft, onChange, onCreate }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [branch, setBranch] = useState<string | null>(null)
  // No folder chosen yet → the first saved project, else home.
  const cwd = draft.cwd ?? projects[0]?.path ?? '~'
  const [model, setModel] = useState<string | undefined>(defaults.model)
  const [effort, setEffort] = useState<EffortLevel | undefined>(defaults.effort)
  const [fastMode, setFastMode] = useState(defaults.fastMode)
  const [permissionMode, setPermissionMode] = useState<PermissionMode | undefined>(defaults.permissionMode)

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
          writeSessionDefaults({ model: m, effort: e })
        }}
        onFastModeChange={(on) => {
          setFastMode(on)
          writeSessionDefaults({ fastMode: on })
        }}
        onPermissionModeChange={(m) => {
          setPermissionMode(m)
          writeSessionDefaults({ permissionMode: m })
        }}
      />
      <div className="keysHint">
        <kbd>Enter</kbd> starts · <kbd>Shift+Enter</kbd> newline · <kbd>Shift+Tab</kbd> changes what gets asked
      </div>

    </div>
  )
}
