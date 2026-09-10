import { useCallback, useEffect, useState } from 'react'
import type { Connector, ConnectorsResponse } from '../../../shared/protocol.js'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; probedAt: number; connectors: Connector[] }
  | { phase: 'error'; message: string }

/** Usable first, then broken, then not-yet-authorized, then intentional states. */
const STATUS_ORDER = ['connected', 'failed', 'needs-auth', 'pending', 'disabled']

const STATUS_LABEL: Record<string, string> = {
  connected: 'connected',
  'needs-auth': 'needs auth',
  pending: 'pending',
  failed: 'failed',
  disabled: 'disabled',
}

export function ConnectorsPage() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })

  const load = useCallback(async (refresh: boolean) => {
    setState({ phase: 'loading' })
    try {
      const res = await fetch(`/api/connectors${refresh ? '?refresh=1' : ''}`)
      const body = (await res.json()) as ConnectorsResponse
      if (body.ok) setState({ phase: 'ready', probedAt: body.probedAt, connectors: body.connectors })
      else setState({ phase: 'error', message: body.error })
    } catch (err) {
      setState({ phase: 'error', message: String(err) })
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  return (
    <div id="connectorsPage" className="page">
      <div className="glow green" aria-hidden="true" />
      <div className="inner">
        <div className="pageHead">
          <div>
            <h1 className="display md">Connectors</h1>
            <p className="sub">
              What a dispatched session can reach — your claude.ai connectors and local MCP
              servers, exactly as a session loads them.
            </p>
          </div>
          <button
            className="btn"
            disabled={state.phase === 'loading'}
            onClick={() => void load(true)}
          >
            {state.phase === 'loading' ? 'Probing…' : 'Refresh'}
          </button>
        </div>

        {state.phase === 'loading' && (
          <div className="probing">
            <span className="pip" /> Starting a probe session and connecting servers — this
            takes a few seconds…
          </div>
        )}

        {state.phase === 'error' && (
          <div className="msg error">Probe failed: {state.message}</div>
        )}

        {state.phase === 'ready' && (
          <>
            <Group
              title="claude.ai connectors"
              hint="Managed at claude.ai → Settings → Connectors."
              connectors={state.connectors.filter((c) => c.source === 'claude.ai')}
            />
            <Group
              title="Local MCP servers"
              hint="From ~/.claude settings and installed plugins."
              connectors={state.connectors.filter((c) => c.source === 'local')}
            />
            {state.connectors.some((c) => c.status === 'needs-auth') && (
              <div className="authNote">
                <b>needs auth</b> — authorize once in an interactive <code>claude</code> session
                (<code>/mcp</code>); sessions started here then pick the token up.
              </div>
            )}
            <div className="probedAt">probed {new Date(state.probedAt).toLocaleTimeString()}</div>
          </>
        )}
      </div>
    </div>
  )
}

function Group({ title, hint, connectors }: { title: string; hint: string; connectors: Connector[] }) {
  if (connectors.length === 0) return null
  const connected = connectors.filter((c) => c.status === 'connected').length
  const sorted = [...connectors].sort((a, b) => {
    const d = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
    return d !== 0 ? d : a.name.localeCompare(b.name)
  })
  return (
    <section className="connGroup">
      <header>
        <h3>{title}</h3>
        <span className="count">
          {connected}/{connectors.length} connected
        </span>
      </header>
      <p className="hint">{hint}</p>
      <div className="connList">
        {sorted.map((c) => (
          <div key={`${c.source}:${c.name}`} className="connRow">
            <span className={`connDot ${c.status}`} />
            <span className="connName">{c.name}</span>
            <span className={`connStatus ${c.status}`}>{STATUS_LABEL[c.status] ?? c.status}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
