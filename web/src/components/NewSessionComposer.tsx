import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project, ProjectsResponse } from '../../../shared/protocol.js'

export type NewSession = { title: string; cwd: string; firstMessage: string }

export type SessionPreset = { title: string; firstMessage: string; cwd?: string }

type Props = {
  /** Prefill (e.g. dispatching a work item). Applied each time it changes. */
  preset?: SessionPreset | null
  onCreate: (s: NewSession) => void
}

const DEFAULT_CWD = '~/Code/prnl/hey-triage'

/** `/Users/you/Code/x` → `~/Code/x` — display only. */
function homely(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, '~')
}

function titleFrom(text: string): string {
  return text.trim().split('\n')[0].slice(0, 80)
}

/** The home screen: a blank composer that spins up a session on first send. */
export function NewSessionComposer({ preset, onCreate }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [cwd, setCwd] = useState(DEFAULT_CWD)
  const [text, setText] = useState('')
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
    if (preset) {
      setText(preset.firstMessage)
      if (preset.cwd) setCwd(preset.cwd)
    } else {
      setText('')
      setCwd(DEFAULT_CWD)
    }
    box.current?.focus()
  }, [preset])

  const autosize = useCallback(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }, [])

  function submit() {
    const trimmed = text.trim()
    if (!trimmed) return
    onCreate({ title: titleFrom(trimmed), cwd, firstMessage: trimmed })
    setText('')
    requestAnimationFrame(autosize)
  }

  return (
    <div id="newSessionHome">
      <h2>What are we working on?</h2>
      <div id="composer">
        <div className="frame">
          <div className="statusline">
            <select
              className="chip cwd"
              title={cwd}
              value={projects.find((p) => p.path === cwd)?.id ?? ''}
              onChange={(e) => {
                const p = projects.find((x) => x.id === e.target.value)
                if (p) setCwd(p.path)
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
            <button id="sendBtn" onClick={submit} disabled={!text.trim()}>
              Start
            </button>
          </div>

          <div className="hint">
            <kbd>Enter</kbd> to start · <kbd>Shift+Enter</kbd> for a new line
          </div>
        </div>
      </div>
    </div>
  )
}
