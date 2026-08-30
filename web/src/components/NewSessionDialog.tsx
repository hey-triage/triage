import { useEffect, useRef, useState } from 'react'
import type { Project, ProjectsResponse } from '../../../shared/protocol.js'

export type NewSession = { title: string; cwd: string; firstMessage: string }

export type SessionPreset = { title: string; firstMessage: string; cwd?: string }

type Props = {
  open: boolean
  /** Prefill (e.g. dispatching a work item). Applied each time the dialog opens. */
  preset?: SessionPreset | null
  onClose: () => void
  onCreate: (s: NewSession) => void
}

const DEFAULT_CWD = '~/Code/prnl/hey-triage'

export function NewSessionDialog({ open, preset, onClose, onCreate }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState('')
  const [cwd, setCwd] = useState(DEFAULT_CWD)
  const [firstMessage, setFirstMessage] = useState('')

  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) {
      if (preset) {
        setTitle(preset.title)
        setFirstMessage(preset.firstMessage)
        if (preset.cwd) setCwd(preset.cwd)
      }
      el.showModal()
      void fetch('/api/projects')
        .then((r) => r.json() as Promise<ProjectsResponse>)
        .then((b) => {
          if (b.ok) setProjects(b.projects)
        })
        .catch(() => {})
    }
    if (!open && el.open) el.close()
  }, [open, preset])

  function create() {
    onCreate({ title, cwd, firstMessage })
    setTitle('')
    setFirstMessage('')
    onClose()
  }

  return (
    <dialog ref={dialog} onClose={onClose}>
      <h3>New session</h3>
      <label htmlFor="fTitle">Title</label>
      <input
        id="fTitle"
        autoFocus
        value={title}
        placeholder="e.g. Fix flaky repl test"
        onChange={(e) => setTitle(e.target.value)}
      />
      {projects.length > 0 && (
        <>
          <label htmlFor="fProject">Project</label>
          <select
            id="fProject"
            value={projects.find((p) => p.path === cwd)?.id ?? ''}
            onChange={(e) => {
              const p = projects.find((x) => x.id === e.target.value)
              if (p) setCwd(p.path)
            }}
          >
            <option value="">— pick a project —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.repo ? ` (${p.repo})` : ''}
              </option>
            ))}
          </select>
        </>
      )}
      <label htmlFor="fCwd">Working directory</label>
      <input id="fCwd" value={cwd} onChange={(e) => setCwd(e.target.value)} />
      <label htmlFor="fMsg">First message (optional)</label>
      <textarea
        id="fMsg"
        rows={3}
        value={firstMessage}
        placeholder="What should Claude do?"
        onChange={(e) => setFirstMessage(e.target.value)}
      />
      <div className="row">
        <button className="cancel" onClick={onClose}>
          Cancel
        </button>
        <button className="go" onClick={create}>
          Start session
        </button>
      </div>
    </dialog>
  )
}
