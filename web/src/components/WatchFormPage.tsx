/**
 * The watch form, as a page (#/watches/new, #/watches/<id>/edit). Five things:
 * a name, the instructions (where to look and what counts), the connectors the
 * run may use, an optional project, and a schedule. No place field — the
 * connector allowlist is the fence, the instructions say where to look.
 */
import { Check, Clock } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Project, ProjectsResponse, Watch, WatchConnector, WatchOutput, WatchesResponse } from '../../../shared/protocol.js'
import { describeCron, isValidCron } from '../../../core/watch/cron.js'
import { useModels } from '../models.js'
import { CONNECTORS, OUTPUTS, PRESETS, cronToPreset, presetToCron, type SchedulePreset } from '../watchUi.js'

// Inbox thumbs-down → refine: the correction is appended to the instructions
// so the rule stays human-readable. sessionStorage survives the hash change.
export const REFINE_WATCH_KEY = 'triage.watch.refine'

type Form = {
  title: string
  instruction: string
  connectors: WatchConnector[]
  projectId: string
  /** '' = Claude Code's default */
  model: string
  output: WatchOutput
  preset: SchedulePreset
  time: string
  cron: string
}

const EMPTY: Form = {
  title: '',
  instruction: '',
  connectors: ['web'],
  projectId: '',
  model: '',
  output: 'items',
  preset: 'daily',
  time: '09:00',
  cron: '0 9 * * *',
}

function formFrom(w: Watch): Form {
  const { preset, time } = cronToPreset(w.schedule)
  return {
    title: w.title,
    instruction: w.instruction,
    connectors: w.connectors,
    projectId: w.projectId ?? '',
    model: w.model ?? '', output: w.output,
    preset,
    time,
    cron: w.schedule,
  }
}

export function WatchFormPage({ id, onNavigate }: { id: string | null; onNavigate: (hash: string) => void }) {
  const [form, setForm] = useState<Form>(EMPTY)
  const [loaded, setLoaded] = useState(id === null)
  const [projects, setProjects] = useState<Project[]>([])
  const models = useModels()
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => setProjects(b.ok ? b.projects : []))
      .catch(() => setProjects([]))
  }, [])

  useEffect(() => {
    if (id === null) return
    void fetch('/api/watches')
      .then((r) => r.json() as Promise<WatchesResponse>)
      .then((b) => {
        const w = b.ok ? b.watches.find((x) => x.id === id) : undefined
        if (!w) {
          setError('unknown watch')
          setLoaded(true)
          return
        }
        const f = formFrom(w)
        const raw = sessionStorage.getItem(REFINE_WATCH_KEY)
        if (raw) {
          sessionStorage.removeItem(REFINE_WATCH_KEY)
          try {
            const { watchId, note } = JSON.parse(raw) as {
              watchId: string
              note: string
            }
            if (watchId === id) f.instruction = `${f.instruction}\nNot: things like “${note}”.`
          } catch {
            // stale handoff — ignore
          }
        }
        setForm(f)
        setLoaded(true)
      })
      .catch((err) => {
        setError(String(err))
        setLoaded(true)
      })
  }, [id])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))

  // The schedule the form will save: presets render to cron; custom is typed.
  const cron = useMemo(() => (form.preset === 'custom' ? form.cron.trim() : presetToCron(form.preset, form.time)), [form.preset, form.time, form.cron])
  const cronOk = isValidCron(cron)

  const toggleConnector = (c: WatchConnector) =>
    setForm((f) => ({
      ...f,
      connectors: f.connectors.includes(c) ? f.connectors.filter((x) => x !== c) : [...f.connectors, c],
    }))

  const complete = form.title.trim() && form.instruction.trim() && form.connectors.length > 0 && cronOk
  // The instructions talk about the web but the run would have no web tools.
  const wantsWeb = /\b(news|web|google|internet|online|website|blog|article|search the)\b/i.test(form.instruction) && !form.connectors.includes('web')

  async function save() {
    setSaving(true)
    setError('')
    try {
      const payload = {
        title: form.title.trim(),
        instruction: form.instruction.trim(),
        connectors: form.connectors,
        projectId: form.projectId || null,
        model: form.model || null,
        output: form.output,
        schedule: cron,
      }
      const res = await fetch(id ? `/api/watches?id=${encodeURIComponent(id)}` : '/api/watches', {
        method: id ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await res.json()) as WatchesResponse
      if (!body.ok) throw new Error(body.error)
      onNavigate('/watches')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const project = projects.find((p) => p.id === form.projectId)

  return (
    <div className="page">
      <div className="glow blue" aria-hidden="true" />
      <div className="inner wform">
        <div className="crumbs">
          <button type="button" className="crumb link" onClick={() => onNavigate('/watches')}>
            Watches
          </button>
          <span className="crumbSep">›</span>
          <span className="crumb now">{id ? 'Edit watch' : 'New watch'}</span>
        </div>

        {!loaded ? (
          <div className="probing">
            <span className="pip" /> Loading…
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="wf-title">Name</label>
              <input id="wf-title" autoFocus value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Quick wins for PX" />
            </div>

            <div className="field">
              <label htmlFor="wf-instr">
                Instructions <span className="hint">· where to look and what counts. The run finds teams, channels and labels itself.</span>
              </label>
              <textarea
                id="wf-instr"
                value={form.instruction}
                onChange={(e) => set('instruction', e.target.value)}
                placeholder="Look through the PX team’s open Linear issues. I want small bugs or feature requests I could turn into one short PR. Skip epics and anything already assigned."
              />
            </div>

            <div className="field">
              <label>
                Integrations <span className="hint">· the run only has these tools, read-only</span>
              </label>
              <div className="chipRow">
                {CONNECTORS.map((c) => {
                  const on = form.connectors.includes(c.id)
                  const Icon = on ? Check : c.icon
                  return (
                    <button key={c.id} type="button" className={`cchip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggleConnector(c.id)}>
                      <Icon size={13} aria-hidden="true" className={on ? 'tick' : undefined} />
                      {c.label}
                    </button>
                  )
                })}
              </div>
              {wantsWeb && <span className="hint">This sounds like a web search. Tick Web, or the run can only look in the integrations above.</span>}
            </div>

            <div className="field">
              <label>
                Output <span className="hint">· what a run produces</span>
              </label>
              <div className="seg" role="radiogroup" aria-label="Output">
                {OUTPUTS.map((o) => (
                  <button key={o.id} type="button" role="radio" aria-checked={form.output === o.id} className={`segBtn${form.output === o.id ? ' active' : ''}`} onClick={() => set('output', o.id)}>
                    {o.label}
                  </button>
                ))}
              </div>
              <span className="hint">{OUTPUTS.find((o) => o.id === form.output)?.hint}</span>
            </div>

            <div className="field">
              <label htmlFor="wf-project">
                Project <span className="hint">· optional. Lets the run read code.</span>
              </label>
              <select id="wf-project" value={form.projectId} onChange={(e) => set('projectId', e.target.value)}>
                <option value="">None</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {project && <span className="hint mono">{project.path}</span>}
            </div>

            <div className="field">
              <label htmlFor="wf-model">
                Model <span className="hint">· the model each run uses</span>
              </label>
              <select id="wf-model" value={form.model} onChange={(e) => set('model', e.target.value)}>
                <option value="">Default (Claude Code’s choice)</option>
                {models
                  .filter((m) => m.id !== 'default')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.description ? ` — ${m.description}` : ''}
                    </option>
                  ))}
                {form.model && !models.some((m) => m.id === form.model) && <option value={form.model}>{form.model}</option>}
              </select>
            </div>

            <div className="field">
              <label>Schedule</label>
              <div className="card schedCard">
                <div className="line">
                  <Clock size={13} aria-hidden="true" />
                  <span>{cronOk ? describeCron(cron) : 'Not a valid schedule'}</span>
                  <span className="cron">{cron}</span>
                </div>
                <div className="ctl">
                  <div className="seg" role="radiogroup" aria-label="Frequency">
                    {PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={form.preset === p.id}
                        className={`segBtn${form.preset === p.id ? ' active' : ''}`}
                        onClick={() => set('preset', p.id)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  {form.preset === 'custom' ? (
                    <input
                      className="cronIn"
                      value={form.cron}
                      onChange={(e) => set('cron', e.target.value)}
                      placeholder="*/30 * * * *"
                      aria-label="Cron expression"
                    />
                  ) : form.preset === 'hourly' ? null : (
                    <>
                      <span className="hint">at</span>
                      <input className="time" type="time" value={form.time} onChange={(e) => set('time', e.target.value)} aria-label="Time" />
                    </>
                  )}
                </div>
                <span className="hint">Missed slots run once on wake. Runs are staggered a few minutes apart.</span>
              </div>
            </div>

            {error && <div className="formError">{error}</div>}

            <div className="foot">
              <span className="hint">Nothing is filed until the first run. The first run sets the cursor.</span>
              <button type="button" className="btn outline" onClick={() => onNavigate('/watches')}>
                Cancel
              </button>
              <button type="button" className="btn primary" disabled={!complete || saving} onClick={() => void save()}>
                {saving ? 'Saving…' : id ? 'Save changes' : 'Create watch'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
