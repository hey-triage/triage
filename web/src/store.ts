/**
 * The client's view of the server, as an external store.
 *
 * Everything the UI renders lives here; components read slices through the
 * hooks in hooks.ts. Two notification channels, on purpose:
 *
 *   structural — sessions, connection state, committed events. Fires at the
 *                rate the SDK emits messages (a handful per turn).
 *   live       — the partially-streamed assistant line. Fires at most once per
 *                animation frame, because token deltas arrive far faster than
 *                anything should re-render.
 */
import type { BriefJob,
  ClientMessage,
  ServerMessage,
  SessionEvent,
  SessionSummary,
  TerminalSummary,
  Workspace,
  WorkspacesResponse,
} from '../../shared/protocol.js'

export type ConnState = 'connecting' | 'connected' | 'disconnected'

const NO_EVENTS: readonly SessionEvent[] = []

export class Store {
  #structuralListeners = new Set<() => void>()
  #liveListeners = new Set<() => void>()

  #conn: ConnState = 'connecting'
  #sessions: readonly SessionSummary[] = []
  #events = new Map<string, readonly SessionEvent[]>()

  // Workspace picture, from `hello`. The socket (and every fetch, via the
  // triage_ws cookie) is bound to one workspace; switching = set the cookie
  // and reload, so every page remounts against the new scope.
  #workspaceId = ''
  #workspaces: readonly Workspace[] = []
  #onboarded = true

  #liveText = new Map<string, string>()
  /** Deltas received since the last animation frame. */
  #pendingDeltas = new Map<string, string>()
  #frame = 0

  /** Set by the app so a locally-created session can be selected on arrival. */
  #onSessionCreated?: (s: SessionSummary) => void

  // Terminals: the list is structural state; output bypasses React entirely and
  // goes straight to the xterm instance that asked for it.
  #terminals: readonly TerminalSummary[] = []
  #terminalListeners = new Map<string, Set<(data: string, replay: boolean) => void>>()
  #subscribedTerminals = new Set<string>()
  #onTerminalCreated?: (t: TerminalSummary) => void

  #ws: WebSocket | null = null
  #subscribedTo: string | null = null
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined

  // -- reads ----------------------------------------------------------------

  getConn = (): ConnState => this.#conn
  getSessions = (): readonly SessionSummary[] => this.#sessions
  getEvents = (sessionId: string): readonly SessionEvent[] => this.#events.get(sessionId) ?? NO_EVENTS
  getLive = (sessionId: string): string => this.#liveText.get(sessionId) ?? ''
  getWorkspaceId = (): string => this.#workspaceId
  getWorkspaces = (): readonly Workspace[] => this.#workspaces
  getOnboarded = (): boolean => this.#onboarded
  getTerminals = (): readonly TerminalSummary[] => this.#terminals

  subscribeStructural = (fn: () => void) => {
    this.#structuralListeners.add(fn)
    return () => this.#structuralListeners.delete(fn)
  }

  subscribeLive = (fn: () => void) => {
    this.#liveListeners.add(fn)
    return () => this.#liveListeners.delete(fn)
  }

  #notify() {
    for (const fn of this.#structuralListeners) fn()
  }

  #notifyLive() {
    for (const fn of this.#liveListeners) fn()
  }

  // -- connection -----------------------------------------------------------

  connect() {
    if (this.#ws) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.#ws = ws

    ws.onopen = () => {
      this.#conn = 'connected'
      // A reconnect leaves the UI holding a stale transcript; re-subscribing
      // replays the session log from the server.
      if (this.#subscribedTo) this.send({ type: 'subscribe', sessionId: this.#subscribedTo })
      for (const id of this.#subscribedTerminals) this.send({ type: 'terminal_subscribe', terminalId: id })
      this.#notify()
    }
    ws.onclose = () => {
      this.#ws = null
      this.#conn = 'disconnected'
      this.#notify()
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = setTimeout(() => this.connect(), 1500)
    }
    ws.onmessage = (e) => this.#handle(JSON.parse(String(e.data)) as ServerMessage)
  }

  send(msg: ClientMessage) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg))
  }

  /** Ask the server to replay a session's log, and remember it across reconnects. */
  subscribeSession(sessionId: string) {
    this.#subscribedTo = sessionId
    this.send({ type: 'subscribe', sessionId })
  }

  // -- terminals --------------------------------------------------------------

  /**
   * Stream one terminal's output to `fn`. `replay` is true for the scrollback
   * that arrives right after subscribing (and again after a reconnect), so the
   * listener can reset before writing it.
   */
  onTerminalData(terminalId: string, fn: (data: string, replay: boolean) => void) {
    let set = this.#terminalListeners.get(terminalId)
    if (!set) this.#terminalListeners.set(terminalId, (set = new Set()))
    set.add(fn)
    this.#subscribedTerminals.add(terminalId)
    this.send({ type: 'terminal_subscribe', terminalId })
    return () => {
      set!.delete(fn)
      if (set!.size === 0) {
        this.#terminalListeners.delete(terminalId)
        this.#subscribedTerminals.delete(terminalId)
      }
    }
  }

  onTerminalCreated(fn: (t: TerminalSummary) => void) {
    this.#onTerminalCreated = fn
  }

  #emitTerminal(terminalId: string, data: string, replay: boolean) {
    const set = this.#terminalListeners.get(terminalId)
    if (set) for (const fn of set) fn(data, replay)
  }

  // -- workspaces -------------------------------------------------------------

  /**
   * Bind this browser to a workspace and reload. The cookie rides on every
   * fetch and on the WS upgrade, so one write scopes the whole app; the reload
   * remounts every page against the new scope (they all fetch on mount).
   */
  switchWorkspace(id: string) {
    document.cookie = `triage_ws=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`
    location.reload()
  }

  /** Re-pull the workspace list after a create/edit/delete. */
  async refreshWorkspaces(): Promise<void> {
    try {
      const body = (await (await fetch('/api/workspaces')).json()) as WorkspacesResponse
      if (body.ok) {
        this.#workspaces = body.workspaces
        this.#onboarded = body.onboarded
        this.#notify()
      }
    } catch {
      // transient — the next hello refreshes it anyway
    }
  }

  /** Local echo for completing/skipping onboarding (the server is told separately). */
  markOnboarded() {
    this.#onboarded = true
    this.#notify()
  }

  // -- incoming -------------------------------------------------------------

  /** Who wants to know when the artifacts index changed (the artifacts store, an open artifact page). */
  readonly #artifactsListeners = new Set<() => void>()
  /** Who follows brief jobs (the brief store) — one frame per transition. */
  readonly #briefListeners = new Set<(job: BriefJob) => void>()

  #handle(msg: ServerMessage) {
    switch (msg.type) {
      case 'hello':
        this.#sessions = msg.sessions
        this.#workspaceId = msg.workspaceId
        this.#workspaces = msg.workspaces
        this.#onboarded = msg.onboarded
        this.#terminals = msg.terminals
        this.#notify()
        break
      case 'sessions':
        this.#sessions = msg.sessions
        this.#notify()
        break
      case 'session_created':
        // The list broadcast follows; this only needs to make the new session
        // selectable immediately.
        if (!this.#sessions.some((s) => s.id === msg.session.id)) {
          this.#sessions = [...this.#sessions, msg.session]
        }
        this.#onSessionCreated?.(msg.session)
        this.#notify()
        break
      case 'session_deleted':
        this.#sessions = this.#sessions.filter((s) => s.id !== msg.sessionId)
        this.#events.delete(msg.sessionId)
        this.#clearLive(msg.sessionId)
        if (this.#subscribedTo === msg.sessionId) this.#subscribedTo = null
        this.#notify()
        break
      case 'history':
        this.#events.set(msg.sessionId, msg.events)
        this.#clearLive(msg.sessionId)
        this.#notify()
        this.#notifyLive()
        break
      case 'session_event':
        this.#applyEvent(msg.sessionId, msg.event)
        break
      case 'terminals':
        this.#terminals = msg.terminals
        this.#notify()
        break
      case 'terminal_created':
        if (!this.#terminals.some((t) => t.id === msg.terminal.id)) {
          this.#terminals = [...this.#terminals, msg.terminal]
        }
        this.#onTerminalCreated?.(msg.terminal)
        this.#notify()
        break
      case 'terminal_history':
        this.#emitTerminal(msg.terminalId, msg.data, true)
        break
      case 'terminal_output':
        this.#emitTerminal(msg.terminalId, msg.data, false)
        break
      case 'terminal_exit':
        this.#terminals = this.#terminals.map((t) =>
          t.id === msg.terminalId ? { ...t, status: 'exited', exitCode: msg.exitCode } : t,
        )
        this.#notify()
        break
      case 'terminal_closed':
        this.#terminals = this.#terminals.filter((t) => t.id !== msg.terminalId)
        this.#terminalListeners.delete(msg.terminalId)
        this.#subscribedTerminals.delete(msg.terminalId)
        this.#notify()
        break
      case 'artifacts_changed':
        for (const fn of this.#artifactsListeners) fn()
        break
      case 'brief_status':
        for (const fn of this.#briefListeners) fn(msg.job)
        break
      case 'error':
        // Server-level failure, not scoped to a session.
        console.error('[triage] server error:', msg.message)
        break
    }
  }

  onSessionCreated(fn: (s: SessionSummary) => void) {
    this.#onSessionCreated = fn
  }

  /** Fires on every `brief_status` frame with the job that moved; returns the unsubscribe. */
  onBriefStatus(fn: (job: BriefJob) => void): () => void {
    this.#briefListeners.add(fn)
    return () => {
      this.#briefListeners.delete(fn)
    }
  }

  /** Fires on every `artifacts_changed` frame; returns the unsubscribe. */
  onArtifactsChanged(fn: () => void): () => void {
    this.#artifactsListeners.add(fn)
    return () => {
      this.#artifactsListeners.delete(fn)
    }
  }

  #applyEvent(sessionId: string, ev: SessionEvent) {
    if (ev.kind === 'sdk' && ev.message.type === 'stream_event') {
      const e = ev.message.event
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
        this.#pushDelta(sessionId, e.delta.text)
      }
      return
    }
    // The committed assistant message supersedes whatever was streaming.
    if (ev.kind === 'sdk' && ev.message.type === 'assistant') {
      this.#clearLive(sessionId)
      this.#notifyLive()
    }
    this.#append(sessionId, ev)
  }

  #append(sessionId: string, ev: SessionEvent) {
    this.#events.set(sessionId, [...this.getEvents(sessionId), ev])
    this.#notify()
  }

  #pushDelta(sessionId: string, text: string) {
    this.#pendingDeltas.set(sessionId, (this.#pendingDeltas.get(sessionId) ?? '') + text)
    if (!this.#frame) this.#frame = requestAnimationFrame(this.#flushDeltas)
  }

  #flushDeltas = () => {
    this.#frame = 0
    for (const [id, chunk] of this.#pendingDeltas) {
      this.#liveText.set(id, (this.#liveText.get(id) ?? '') + chunk)
    }
    this.#pendingDeltas.clear()
    this.#notifyLive()
  }

  #clearLive(sessionId: string) {
    this.#liveText.delete(sessionId)
    this.#pendingDeltas.delete(sessionId)
  }
}

export const store = new Store()
