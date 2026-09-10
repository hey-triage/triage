import { ArrowUp, ChevronDown, GitBranch } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BranchResponse,
  EffortLevel,
  PermissionMode,
  Project,
  ProjectsResponse,
} from '../../../shared/protocol.js'
import type { Draft } from '../drafts.js'
import { isEffort } from '../models.js'
import { isPermissionMode, nextMode } from '../permissionModes.js'
import { projectColor } from '../tabs.js'
import { FastModeToggle } from './FastModeToggle.js'
import { ModelPopover } from './ModelPopover.js'
import { PermissionModePicker } from './PermissionModePicker.js'

export type NewSession = {
  title: string
  cwd: string
  firstMessage: string
  model?: string
  effort?: EffortLevel
  fastMode?: boolean
  permissionMode?: PermissionMode
}

type Props = {
  /** The draft this tab edits; text and folder round-trip through it so they survive a tab switch. */
  draft: Draft
  onChange: (patch: { text?: string; cwd?: string; label?: string }) => void
  onCreate: (s: NewSession) => void
}

const DEFAULT_CWD = '~/Code/prnl/hey-triage'

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

/** `/Users/you/Code/x` → `~/Code/x` — display only. */
function homely(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, '~')
}

function titleFrom(text: string): string {
  return text.trim().split('\n')[0].slice(0, 80)
}


/** A draft tab: the composer that becomes a session on first send. */
export function NewSessionComposer({ draft, onChange, onCreate }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [branch, setBranch] = useState<string | null>(null)
  const cwd = draft.cwd ?? DEFAULT_CWD
  const text = draft.text
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
  const box = useRef<HTMLTextAreaElement>(null)

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

  useEffect(() => {
    const el = box.current
    if (!el) return
    el.focus()
    // Land the caret at the end — a dispatched draft arrives prefilled.
    el.setSelectionRange(el.value.length, el.value.length)
  }, [draft.id])

  const autosize = useCallback(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 320) + 'px'
  }, [])

  useEffect(autosize, [text, autosize])

  const project = projects.find((p) => p.path === cwd)

  function submit() {
    const trimmed = text.trim()
    if (!trimmed) return
    onCreate({
      title: draft.label ?? titleFrom(trimmed),
      cwd,
      firstMessage: trimmed,
      model,
      effort,
      fastMode,
      permissionMode,
    })
  }

  return (
    <div id="newSessionHome">
      <div className="glow blue" aria-hidden="true" />
      <h2>{draft.label ? 'Dispatching.' : 'What are we working on?'}</h2>
      <div id="composer">
        <div className="frame card">
          <div className="cardHead">
            <label className="chip ink pick" title={`Project folder: ${cwd}`}>
              <span className="pdot" style={{ background: projectColor(cwd) }} aria-hidden="true" />
              <span className="name">{project?.name ?? homely(cwd).split('/').pop() ?? cwd}</span>
              <ChevronDown size={11} aria-hidden="true" />
              <select
                id="draftProject"
                aria-label="Project"
                value={project?.id ?? ''}
                onChange={(e) => {
                  const p = projects.find((x) => x.id === e.target.value)
                  if (p) onChange({ cwd: p.path })
                }}
              >
                {!project && <option value="">{homely(cwd)}</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.repo ? ` (${p.repo})` : ''}
                  </option>
                ))}
              </select>
            </label>
            {branch && (
              <span className="branch" title="Current branch">
                <GitBranch size={12} aria-hidden="true" />
                {branch}
              </span>
            )}
            <span className="path" title={cwd}>
              {homely(cwd)}
            </span>
          </div>

          <textarea
            id="box"
            ref={box}
            autoFocus
            rows={1}
            value={text}
            placeholder="Describe what you want to work on — a bug, a feature, a question…"
            onChange={(e) => onChange({ text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              } else if (e.key === 'Tab' && e.shiftKey) {
                e.preventDefault()
                const m = nextMode(permissionMode)
                setPermissionMode(m)
                remember(PERMISSION_KEY, m)
              }
            }}
          />

          <div className="statusline">
            <ModelPopover
              model={model}
              effort={effort}
              onModelChange={(m, e) => {
                setModel(m)
                setEffort(e)
                remember(MODEL_KEY, m)
                remember(EFFORT_KEY, e)
              }}
            />
            <PermissionModePicker
              mode={permissionMode}
              onChange={(m) => {
                setPermissionMode(m)
                remember(PERMISSION_KEY, m)
              }}
            />
            <span className="spacer" />
            <FastModeToggle
              model={model}
              fastMode={fastMode}
              onChange={(on) => {
                setFastMode(on)
                remember(FAST_MODE_KEY, on ? '1' : undefined)
              }}
            />
            <button id="sendBtn" onClick={submit} disabled={!text.trim()} title="Start the session (Enter)">
              <ArrowUp size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      <div className="keysHint">
        <kbd>Enter</kbd> starts · <kbd>Shift+Enter</kbd> newline · <kbd>Shift+Tab</kbd> changes what gets asked
      </div>

    </div>
  )
}
