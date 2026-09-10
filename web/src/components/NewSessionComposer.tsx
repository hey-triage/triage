import { ArrowUp, ChevronDown, FolderGit2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EffortLevel, PermissionMode, Project, ProjectsResponse } from '../../../shared/protocol.js'
import type { Draft } from '../drafts.js'
import { isEffort } from '../models.js'
import { isPermissionMode, nextMode } from '../permissionModes.js'
import { FastModeToggle } from './FastModeToggle.js'
import { ModelPicker } from './ModelPicker.js'
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
  onChange: (patch: { text?: string; cwd?: string }) => void
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
            <label className="chip cwd pick" title={`Project folder: ${cwd}`}>
              <FolderGit2 size={12} aria-hidden="true" />
              <select
                aria-label="Project"
                value={projects.find((p) => p.path === cwd)?.id ?? ''}
                onChange={(e) => {
                  const p = projects.find((x) => x.id === e.target.value)
                  if (p) onChange({ cwd: p.path })
                }}
              >
                {!projects.some((p) => p.path === cwd) && <option value="">{homely(cwd)}</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.repo ? ` (${p.repo})` : ''}
                  </option>
                ))}
              </select>
              <ChevronDown size={11} aria-hidden="true" />
            </label>

            <ModelPicker
              model={model}
              effort={effort}
              onChange={(m, e) => {
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

            <FastModeToggle
              model={model}
              fastMode={fastMode}
              onChange={(on) => {
                setFastMode(on)
                remember(FAST_MODE_KEY, on ? '1' : undefined)
              }}
            />

            <span className="spacer" />
            <span className="hint">
              <kbd>Enter</kbd> starts · <kbd>Shift+Enter</kbd> newline
            </span>
            <button id="sendBtn" onClick={submit} disabled={!text.trim()} title="Start the session (Enter)">
              <ArrowUp size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
