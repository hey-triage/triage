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
import type {
  ClientMessage,
  ServerMessage,
  SessionEvent,
  SessionSummary,
} from '../../shared/protocol.js'

export type ConnState = 'connecting' | 'connected' | 'disconnected'

const NO_EVENTS: readonly SessionEvent[] = []

export class Store {
  #structuralListeners = new Set<() => void>()
  #liveListeners = new Set<() => void>()

  #conn: ConnState = 'connecting'
  #sessions: readonly SessionSummary[] = []
  #events = new Map<string, readonly SessionEvent[]>()

  #liveText = new Map<string, string>()
  /** Deltas received since the last animation frame. */
  #pendingDeltas = new Map<string, string>()
  #frame = 0

  /** Set by the app so a locally-created session can be selected on arrival. */
  #onSessionCreated?: (s: SessionSummary) => void

  #ws: WebSocket | null = null
  #subscribedTo: string | null = null
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined

  // -- reads ----------------------------------------------------------------

  getConn = (): ConnState => this.#conn
  getSessions = (): readonly SessionSummary[] => this.#sessions
  getEvents = (sessionId: string): readonly SessionEvent[] => this.#events.get(sessionId) ?? NO_EVENTS
  getLive = (sessionId: string): string => this.#liveText.get(sessionId) ?? ''

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

  // -- incoming -------------------------------------------------------------

  #handle(msg: ServerMessage) {
    switch (msg.type) {
      case 'hello':
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
      case 'history':
        this.#events.set(msg.sessionId, msg.events)
        this.#clearLive(msg.sessionId)
        this.#notify()
        this.#notifyLive()
        break
      case 'session_event':
        this.#applyEvent(msg.sessionId, msg.event)
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
