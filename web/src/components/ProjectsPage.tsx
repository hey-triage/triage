import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { PickFolderResponse, Project, ProjectsResponse } from '../../../shared/protocol.js'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; projects: Project[] }
  | { phase: 'error'; message: string }

const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

export function ProjectsPage() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/projects')
      const body = (await res.json()) as ProjectsResponse
      if (body.ok) setState({ phase: 'ready', projects: body.projects })
      else setState({ phase: 'error', message: body.error })
    } catch (err) {
      setState({ phase: 'error', message: String(err) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function remove(id: string) {
    const res = await fetch(`/api/projects?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    const body = (await res.json()) as ProjectsResponse
    if (body.ok) setState({ phase: 'ready', projects: body.projects })
  }

  return (
    <div id="projectsPage">
      <div className="inner">
        <div className="pageHead">
          <div>
            <h2>Projects</h2>
            <p className="sub">
              A project names a local folder, optionally tied to a repo. Sessions run in the
              folder; dispatch matches a work item's repo to land there automatically.
            </p>
          </div>
          {state.phase === 'ready' && (
            <button className="refresh add" onClick={() => setAdding(true)}>
              Add a project
            </button>
          )}
        </div>

        {state.phase === 'loading' && <div className="pickerLoading">Loading…</div>}
        {state.phase === 'error' && <div className="msg error">{state.message}</div>}

        {state.phase === 'ready' && (
          <>
            {state.projects.length > 0 ? (
              <div className="projList">
                {state.projects.map((p) => (
                  <div key={p.id} className="projRow">
                    <span className="projName">{p.name}</span>
                    <span className="projRepo">{p.repo || '—'}</span>
                    <span className="projPath" title={p.path}>
                      {tilde(p.path)}
                    </span>
                    <button className="projDelete" title="Remove project" onClick={() => void remove(p.id)}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="inboxEmpty">No projects yet — add the folders you work in.</div>
            )}
          </>
        )}
      </div>

      <AddProjectModal
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(projects) => setState({ phase: 'ready', projects })}
      />
    </div>
  )
}

function AddProjectModal({
  open,
  onClose,
  onAdded,
}: {
  open: boolean
  onClose: () => void
  onAdded: (projects: Project[]) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState('')
  const [repo, setRepo] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)

  // Reseed each time the modal opens.
  useEffect(() => {
    if (!open) return
    setName('')
    setRepo('')
    setPath('')
    setError(null)
    setSaving(false)
    setPicking(false)
  }, [open])

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  async function pickFolder() {
    setPicking(true)
    setError(null)
    try {
      const res = await fetch('/api/pick-folder', { method: 'POST' })
      const body = (await res.json()) as PickFolderResponse
      if (!body.ok) setError(body.error)
      else if (!('cancelled' in body)) {
        setPath(body.path)
        // A folder with no name yet? Suggest the folder's basename.
        setName((n) => n || body.path.replace(/\/+$/, '').split('/').pop() || '')
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setPicking(false)
    }
  }

  async function add() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), repo: repo.trim(), path: path.trim() }),
      })
      const body = (await res.json()) as ProjectsResponse
      if (body.ok) {
        onAdded(body.projects)
        onClose()
      } else {
        setError(body.error)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="projModal"
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && onClose()}
    >
      <h3>Add a project</h3>

      <label>Name</label>
      <input
        autoFocus
        placeholder="e.g. triage"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <label>Repo (optional)</label>
      <input
        placeholder="owner/name"
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
      />

      <label>Folder</label>
      <div className="projPickRow">
        <button type="button" className="projPick" disabled={picking} onClick={() => void pickFolder()}>
          <FolderOpen size={14} aria-hidden="true" />
          {picking ? 'Choosing…' : path ? 'Change folder…' : 'Select folder…'}
        </button>
        <span className={`projPickPath${path ? '' : ' empty'}`} title={path}>
          {path ? tilde(path) : 'No folder selected'}
        </span>
      </div>

      {error && <div className="projError">{error}</div>}

      <div className="row">
        <button type="button" className="cancel" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="go"
          disabled={saving || !name.trim() || !path.trim()}
          onClick={() => void add()}
        >
          {saving ? 'Adding…' : 'Add project'}
        </button>
      </div>
    </dialog>
  )
}
