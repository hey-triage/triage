import { useCallback, useEffect, useState } from 'react'
import type { Project, ProjectsResponse } from '../../../shared/protocol.js'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; projects: Project[] }
  | { phase: 'error'; message: string }

export function ProjectsPage() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [name, setName] = useState('')
  const [repo, setRepo] = useState('')
  const [path, setPath] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

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

  async function add() {
    setSaving(true)
    setFormError(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, repo, path }),
      })
      const body = (await res.json()) as ProjectsResponse
      if (body.ok) {
        setState({ phase: 'ready', projects: body.projects })
        setName('')
        setRepo('')
        setPath('')
      } else {
        setFormError(body.error)
      }
    } finally {
      setSaving(false)
    }
  }

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
        </div>

        {state.phase === 'loading' && <div className="pickerLoading">Loading…</div>}
        {state.phase === 'error' && <div className="msg error">{state.message}</div>}

        {state.phase === 'ready' && (
          <>
            {state.projects.length > 0 && (
              <div className="projList">
                {state.projects.map((p) => (
                  <div key={p.id} className="projRow">
                    <span className="projName">{p.name}</span>
                    <span className="projRepo">{p.repo || '—'}</span>
                    <span className="projPath" title={p.path}>
                      {p.path.replace(/^\/(?:Users|home)\/[^/]+/, '~')}
                    </span>
                    <button className="projDelete" title="Remove project" onClick={() => void remove(p.id)}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            {state.projects.length === 0 && (
              <div className="inboxEmpty">No projects yet — add the folders you work in.</div>
            )}

            <form
              className="projForm"
              onSubmit={(e) => {
                e.preventDefault()
                void add()
              }}
            >
              <h3>Add a project</h3>
              <div className="projFields">
                <input placeholder="Name (e.g. triage)" value={name} onChange={(e) => setName(e.target.value)} />
                <input placeholder="Repo (owner/name, optional)" value={repo} onChange={(e) => setRepo(e.target.value)} />
                <input placeholder="Folder (e.g. ~/Code/prnl/triage-dev)" value={path} onChange={(e) => setPath(e.target.value)} />
                <button className="go" type="submit" disabled={saving || !name.trim() || !path.trim()}>
                  {saving ? 'Adding…' : 'Add'}
                </button>
              </div>
              {formError && <div className="projError">{formError}</div>}
            </form>
          </>
        )}
      </div>
    </div>
  )
}
