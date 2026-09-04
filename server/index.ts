#!/usr/bin/env node
/**
 * triage-dev POC server
 *
 * Serves the web UI on :5178 and drives the locally installed Claude Code
 * via @anthropic-ai/claude-agent-sdk.
 *
 * Sessions are persisted to SQLite (core/store): the row + an append-only
 * event log (the same events the UI renders; stream deltas excluded). The
 * Claude subprocess itself is ephemeral — a session with no live subprocess
 * is revived on the next user message via the SDK's `resume`, keyed by the
 * sdk_session_id captured from the init message. The agent's own memory of
 * the conversation lives in ~/.claude's transcript, not here; our event log
 * is for rendering, never for re-feeding the model.
 *
 * Workspaces (.docs/workspaces.md): one daemon, N isolated workspaces. Each
 * workspace has its own SQLite file, its own Claude auth backend (spawn env),
 * and its own runtime state — every map and cache that used to be a module
 * singleton lives on a WorkspaceRuntime. Every HTTP request and WS connection
 * is bound to exactly one workspace (?workspace= param, else the triage_ws
 * cookie, else the default), and broadcasts stay inside that boundary.
 *
 * The wire format lives in shared/protocol.ts and is shared with the frontend.
 */
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  query,
  createSdkMcpServer,
  tool,
  type Query,
  type SDKUserMessage,
  type PermissionResult,
  type PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type {
  ClientMessage,
  Connector,
  ConnectorsResponse,
  EffortLevel,
  ModelOption,
  ModelsResponse,
  PermissionBehavior,
  PermissionMode,
  QuestionAnswers,
  SdkMessage,
  ServerMessage,
  SessionEvent,
  SessionStatus,
  SessionSummary,
  ToolEffect,
  Workspace,
} from '../shared/protocol.js'
import type {
  ActivityResponse,
  CoverageResponse,
  InboxResponse,
  InboxSnapshot,
  ItemEventsResponse,
  ItemListResponse,
  ItemStateResponse,
  LogLevel,
  LogsResponse,
  ManualItemInput,
  SystemResponse,
  SystemStatus,
  ManualItemResponse,
  Project,
  ProjectsResponse,
  ReposResponse,
  UpsertResponse,
  WatchDraftResponse,
  WatchPreviewResponse,
  WatchesResponse,
  WorkItem,
  WorkspaceResponse,
  WorkspacesResponse,
  WorkspaceVerifyResponse,
} from '../shared/protocol.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store, StoredSession, UpsertOutcome } from '../core/store/types.js'
import { buildInbox } from '../core/work/inbox.js'
import { BASE, rank } from '../core/work/score.js'
import { canonicalizeRefs, linkByRefs } from '../core/work/link.js'
import type { ItemStatus } from '../core/work/state.js'
import type { Provenance, WorkItem as CoreWorkItem } from '../core/work/types.js'
import { fetchGitHub, fetchGitHubClosed, listAffiliatedRepos } from '../core/sources/github.js'
import {
  composeWatchRunPrompt,
  draftWatch,
  MAX_ROWS_PER_WATCH,
  permalinkId,
  previewWatch,
  READ_ONLY_SLACK_TOOLS,
  safeWhen,
} from '../core/sources/slack.js'
import { isDue } from '../core/watch/schedule.js'
import { cronFromCadence, isValidCron } from '../core/watch/cron.js'
import type { NewWatch, Watch, WatchCadence, WatchRunStatus } from '../core/watch/types.js'
import { clearState, pkgVersion, TRIAGE_DIR, writeState } from './state.js'
import { initLogFile, log, logFilePath, logSubsystems, recentLogs } from './log.js'
import {
  apiKeyHint,
  dbFileFor,
  ensureWorkspaceDirs,
  loadRegistry,
  loginCommandFor,
  saveRegistry,
  slugify,
  spawnEnvFor,
  toAuthBackend,
  workspaceClaudeDir,
  writeApiKey,
  type WorkspaceMeta,
} from './workspaces.js'

const PORT = Number(process.env.PORT || 5178)
const VERSION = pkgVersion()
const SERVER_STARTED = Date.now()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
/**
 * Vite build output — see vite.config.ts. Absent until `npm run build`.
 * Two layouts: from source this file is <repo>/server/index.ts and the build
 * is <repo>/dist/web; in the published package it is <pkg>/dist/server/index.js
 * sitting next to <pkg>/dist/web.
 */
const WEB_DIR =
  path.basename(path.dirname(__dirname)) === 'dist'
    ? path.join(__dirname, '..', 'web')
    : path.join(__dirname, '..', 'dist', 'web')

const pExecFile = promisify(execFile)

// ---------------------------------------------------------------------------
// Async queue: lets us push user messages into the SDK's streaming input.
// ---------------------------------------------------------------------------
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T) {
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  close() {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((res) => this.waiters.push(res))
      },
    }
  }
}

/**
 * A permission rule the SDK suggested, pinned to this session. Every variant
 * of PermissionUpdate carries a `destination`, so this is a blanket rewrite —
 * nothing an "Always allow" click produces may reach a settings file.
 */
const sessionScoped = (u: PermissionUpdate): PermissionUpdate => ({ ...u, destination: 'session' })

// ---------------------------------------------------------------------------
// Effect classifier — the heart of 'gated' mode.
//
// Before a tool runs, we place it on a blast-radius scale (read / local-write /
// external-write) so 'gated' can wave through reads and still stop on anything
// that writes. Two rules keep it safe:
//   1. Unknown ⇒ write. Only a call we can *prove* is a read runs unattended;
//      everything else prompts, so a newly connected tool is gated by default.
//   2. Any write verb wins over any read verb. A connector call is a read only
//      when its name signals a read and signals no write — so a mutating tool
//      can never sneak through on a "get"/"list" substring.
// Classification is by tool *name*, per tool, never per MCP server: Slack read
// and Slack send share one connector but must land on opposite sides.
// ---------------------------------------------------------------------------

/** Built-in tools whose only effect is reading. */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch'])

// Verb tokens that mark a connector call's intent. Written as word sets and
// matched against the tokens of a tool's leaf name, so both `slack_read_channel`
// (snake) and `getJiraIssue` (camel) classify the same way.
const READ_VERBS = new Set([
  'read', 'search', 'list', 'get', 'fetch', 'lookup', 'view', 'query', 'describe', 'find', 'count', 'show', 'history', 'info',
])
const WRITE_VERBS = new Set([
  'send', 'post', 'create', 'update', 'edit', 'delete', 'remove', 'add', 'schedule', 'transition', 'resolve',
  'comment', 'upsert', 'write', 'set', 'assign', 'merge', 'close', 'reopen', 'archive', 'move', 'upload',
  'publish', 'reply', 'draft', 'star', 'pin', 'react', 'approve', 'complete', 'cancel',
])

/** Lowercased word tokens of a tool's leaf name (splits camelCase and snake_case). */
const wordsOf = (leaf: string): string[] => (leaf.match(/[A-Za-z][a-z]*/g) ?? []).map((w) => w.toLowerCase())

function classifyEffect(toolName: string): ToolEffect {
  // Our own inbox: reading it is harmless; every other triage tool writes local
  // SQLite (create/edit/upsert/resolve).
  if (toolName === 'mcp__triage__list_work_items') return 'read'
  if (toolName.startsWith('mcp__triage__')) return 'local-write'

  if (READ_TOOLS.has(toolName)) return 'read'
  // TodoWrite is the session's own scratch list — no effect past this session.
  if (toolName === 'TodoWrite') return 'read'

  // Connector (MCP) tools reach outside this machine unless they are plainly a
  // read. `mcp__<server>__<leaf>` — classify by the leaf's verbs (rule 2).
  if (toolName.startsWith('mcp__')) {
    const words = wordsOf(toolName.slice(toolName.lastIndexOf('__') + 2))
    const isRead = words.some((w) => READ_VERBS.has(w)) && !words.some((w) => WRITE_VERBS.has(w))
    return isRead ? 'read' : 'external-write'
  }

  // Everything else built in — Write/Edit/MultiEdit/NotebookEdit and Bash —
  // touches this machine. Bash can be read-only, but its command cannot be
  // classified safely from here, so it is a write and asks.
  return 'local-write'
}

// The permission modes the SDK understands and can be handed straight through.
// 'gated' and 'default' are absent: 'default' is the SDK's own baseline (pinning
// it would say nothing), and 'gated' is enforced by us with the SDK left at that
// baseline so every call reaches canUseTool, where classifyEffect decides.
type SdkPermissionMode = Exclude<PermissionMode, 'default' | 'gated'>
const SDK_MODES: SdkPermissionMode[] = ['acceptEdits', 'auto', 'bypassPermissions']
const sdkMode = (m: PermissionMode | null | undefined): SdkPermissionMode | undefined =>
  m && (SDK_MODES as PermissionMode[]).includes(m) ? (m as SdkPermissionMode) : undefined

// ---------------------------------------------------------------------------
// Workspace runtimes — everything that used to be a module singleton, one per
// workspace. Physical isolation: each runtime owns its own store (its own
// SQLite file), its own live sessions and WS clients, and its own caches, so
// nothing can bleed across the boundary by construction.
// ---------------------------------------------------------------------------
type ConnectorProbe = { probedAt: number; connectors: Connector[] }
type ModelProbe = { probedAt: number; models: ModelOption[] }

const registry = loadRegistry()

class WorkspaceRuntime {
  readonly store: Store
  /** full spawn env for this workspace's auth backend; undefined = inherit */
  env: Record<string, string> | undefined

  // session registry: every session lives in the store; a subset is live
  readonly rows = new Map<string, StoredSession>()
  readonly live = new Map<string, LiveSession>()
  readonly branches = new Map<string, string>() // session id → git branch (derived)
  /** WS clients bound to THIS workspace — broadcasts never cross the boundary */
  readonly clients = new Set<WebSocket>()

  // inbox
  inboxCache: InboxSnapshot | null = null
  inboxInFlight: Promise<InboxSnapshot> | null = null
  /** last GitHub source error, surfaced as an inbox notice until the next clean sync */
  githubNotice: string | null = null
  githubReconcileAt = 0
  githubReconcileInFlight: Promise<void> | null = null

  // watch runs
  readonly runQueue: string[] = []
  readonly runningWatches = new Set<string>()
  activeRuns = 0

  // probes
  connectorCache: ConnectorProbe | null = null
  connectorInFlight: Promise<ConnectorProbe> | null = null
  modelCache: ModelProbe | null = null
  modelInFlight: Promise<ModelProbe> | null = null
  affiliatedCache: { at: number; repos: string[] } | null = null

  /** the in-process triage MCP server every chat session in this workspace gets */
  readonly triageMcp: ReturnType<typeof createSdkMcpServer>

  constructor(public meta: WorkspaceMeta) {
    this.store = openSqliteStore(dbFileFor(meta.id, registry.defaultId))
    this.env = spawnEnvFor(meta)
    this.triageMcp = makeTriageMcp(this)
  }

  /** Re-resolve the spawn env after an auth-backend or key change. */
  refreshEnv() {
    this.env = spawnEnvFor(this.meta)
  }
}

const runtimes = new Map<string, WorkspaceRuntime>()

const defaultRuntime = (): WorkspaceRuntime => runtimes.get(registry.defaultId)!

// Daemon-wide logs (one process, one log stream); workspace ids ride in fields.
initLogFile(path.join(TRIAGE_DIR, 'logs'))

// ---------------------------------------------------------------------------
// Live session: one running Claude subprocess bound to a stored session row.
// ---------------------------------------------------------------------------
class LiveSession {
  status: SessionStatus = 'starting'
  model?: string
  private seq: number
  private readonly input = new AsyncQueue<SDKUserMessage>()
  private readonly pendingPermissions = new Map<
    string,
    {
      input: Record<string, unknown>
      /** The SDK's own "don't ask again" rules, replayed on `allow_always`. */
      suggestions: PermissionUpdate[]
      resolve: (r: PermissionResult) => void
    }
  >()
  private readonly q: Query
  /** Whether this subprocess was spawned able to bypass permission checks. */
  private readonly bypassArmed: boolean

  constructor(
    readonly rt: WorkspaceRuntime,
    readonly row: StoredSession,
    lastSeq: number,
    resumeSdkSessionId: string | null,
  ) {
    this.seq = lastSeq
    this.bypassArmed = row.permissionMode === 'bypassPermissions'
    this.q = query({
      prompt: this.input,
      options: {
        cwd: row.cwd,
        // Full Claude Code behavior: its system prompt + tools, and the
        // user's own settings/plugins/MCP connectors from ~/.claude.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        // The triage inbox as in-process tools, so a chat can list/create/edit
        // work items directly — same tool surface as the stdio shim external
        // Claude Code sessions get (server/mcp.ts). Scoped to this workspace.
        mcpServers: { triage: rt.triageMcp },
        // Workspace auth backend: api-key / config-dir spawn with overrides;
        // inherit passes nothing, exactly the pre-workspaces behavior.
        ...(rt.env ? { env: rt.env } : {}),
        // Omitted when the user never picked: Claude Code's own default is a
        // real choice (an org can move it), not a model we should pin here.
        ...(row.model ? { model: row.model } : {}),
        ...(row.effort ? { effort: row.effort } : {}),
        // How much this session asks. Only the SDK's own modes are passed; for
        // 'default' (its baseline) and 'gated' (ours, enforced in canUseTool)
        // the SDK is left at that baseline so every call reaches the gate.
        ...(sdkMode(row.permissionMode) ? { permissionMode: sdkMode(row.permissionMode) } : {}),
        // The SDK refuses 'bypassPermissions' without this explicit opt-in.
        ...(row.permissionMode === 'bypassPermissions'
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        // Revival: replay the agent's own transcript into the new subprocess.
        ...(resumeSdkSessionId ? { resume: resumeSdkSessionId } : {}),
        // Still set under every mode: the permissive modes short-circuit the
        // calls they cover before this runs, and whatever still reaches here
        // is a call that mode decided a human should see.
        canUseTool: (toolName, toolInput, opts) =>
          this.requestPermission(toolName, toolInput, opts),
      },
    })
    void this.pump()
  }

  private async pump() {
    try {
      for await (const msg of this.q) {
        const m = msg as unknown as SdkMessage
        if (m.type === 'system' && m.subtype === 'init') {
          this.model = m.model
          // The key for `resume` — without it a stored session can't continue.
          if (m.session_id && m.session_id !== this.row.sdkSessionId) {
            this.row.sdkSessionId = m.session_id
            void this.rt.store.sessions.setSdkSessionId(this.row.id, m.session_id)
          }
          this.setStatus('idle')
        }
        if (m.type === 'assistant' || m.type === 'user') this.setStatus('running')
        // stream deltas are broadcast live but not persisted (recoverable
        // from the committed assistant message, and the only high-volume thing)
        this.emit({ kind: 'sdk', message: m }, m.type !== 'stream_event')
        if (m.type === 'result') {
          this.setStatus('idle')
          void this.rt.store.sessions.touch(this.row.id)
          void refreshBranch(this.rt, this.row)
        }
      }
      this.setStatus('idle')
    } catch (err) {
      this.emit({ kind: 'error', message: String(err) }, true)
      this.setStatus('error')
    } finally {
      // The subprocess is gone; any unanswered prompt can never be answered.
      this.expirePendingPermissions()
      this.rt.live.delete(this.row.id)
      broadcastSessionList(this.rt)
    }
  }

  /**
   * Switch model/effort for every turn from here on. `setModel` and the flag
   * settings layer both apply live, so an in-flight session doesn't restart.
   */
  async setModel(model: string | null, effort: EffortLevel | null) {
    await this.q.setModel(model ?? undefined)
    await this.q.applyFlagSettings({ effortLevel: effort })
  }

  sendUserMessage(text: string) {
    this.emit({ kind: 'local_user', text }, true)
    this.setStatus('running')
    void this.rt.store.sessions.touch(this.row.id)
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    } as SDKUserMessage
    this.input.push(msg)
  }

  private requestPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    opts: { title?: string; description?: string; suggestions?: PermissionUpdate[] },
  ): Promise<PermissionResult> {
    const effect = classifyEffect(toolName)
    // Reading our own inbox is harmless in any mode — never prompt for it. Every
    // triage write (create/edit/upsert/resolve) still goes through the prompt.
    if (toolName === 'mcp__triage__list_work_items') {
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
    }
    // 'gated': reads and lookups run unattended; anything that writes — a file,
    // the shell, or an outward connector call — still surfaces a prompt. The
    // subprocess runs at the SDK default, so this is the one gate it can't skip.
    if (this.row.permissionMode === 'gated' && effect === 'read') {
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
    }
    const id = randomUUID()
    const suggestions = opts.suggestions ?? []
    return new Promise<PermissionResult>((resolve) => {
      this.pendingPermissions.set(id, { input: toolInput, suggestions, resolve })
      this.emit(
        {
          kind: 'permission_request',
          id,
          toolName,
          input: toolInput,
          title: opts.title,
          description: opts.description,
          canAlwaysAllow: suggestions.length > 0,
          effect,
        },
        true,
      )
    })
  }

  resolvePermission(id: string, behavior: PermissionBehavior, answers?: QuestionAnswers) {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return
    this.pendingPermissions.delete(id)
    if (behavior === 'deny') {
      pending.resolve({ behavior: 'deny', message: 'Denied by the user in the triage web UI.' })
    } else if (answers) {
      // AskUserQuestion: the picked labels ride back in on the tool's input,
      // which is where the tool reads the user's answer from.
      pending.resolve({
        behavior: 'allow',
        updatedInput: { ...pending.input, answers },
      })
    } else {
      // 'allow_always' is 'allow' plus the SDK's suggested rules — re-homed to
      // 'session' first. The SDK suggests 'localSettings', which would write
      // the rule into the project's .claude on disk and outlive the session; a
      // button in a transcript is consent for this session, not a settings
      // edit. Widening the scope beyond that stays a deliberate act in
      // ~/.claude, where the user can see the whole list at once.
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        ...(behavior === 'allow_always' && pending.suggestions.length > 0
          ? { updatedPermissions: pending.suggestions.map(sessionScoped) }
          : {}),
      })
    }
    this.emit({ kind: 'permission_resolved', id, behavior, ...(answers ? { answers } : {}) }, true)
  }

  /**
   * Switch how much this session asks, for every turn from here on.
   *
   * Returns false when the running subprocess cannot take the switch — the
   * caller has already persisted it, so the fix is to end this subprocess and
   * let the next turn revive one built for the new mode. That is the case for
   * 'bypassPermissions': its opt-in is a spawn-time CLI flag, so a subprocess
   * started without it can never be talked into bypassing.
   */
  async setPermissionMode(mode: PermissionMode): Promise<boolean> {
    if (mode === 'bypassPermissions' && !this.bypassArmed) return false
    try {
      // 'gated' (and 'default') run the subprocess at the SDK's baseline; the
      // gate lives in requestPermission, which reads the live row's mode. The
      // row is already updated by the caller, so this switch takes effect at
      // once without a restart.
      await this.q.setPermissionMode(sdkMode(mode) ?? 'default')
      return true
    } catch {
      return false
    }
  }

  /**
   * End the subprocess without killing the session: closing the prompt stream
   * ends the SDK's iteration, and `pump`'s `finally` does the bookkeeping.
   * The next message revives it from the row, picking up whatever changed.
   */
  stop() {
    this.input.close()
  }

  private expirePendingPermissions() {
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve({ behavior: 'deny', message: 'The session ended before this request was answered.' })
      this.emit({ kind: 'permission_resolved', id, behavior: 'expired' }, true)
    }
    this.pendingPermissions.clear()
  }

  async interrupt() {
    try {
      await this.q.interrupt()
    } catch (err) {
      this.emit({ kind: 'error', message: `interrupt failed: ${String(err)}` }, true)
    }
  }

  private setStatus(status: SessionStatus) {
    if (this.status === status) return
    this.status = status
    broadcastSessionList(this.rt)
  }

  private emit(event: SessionEvent, persist: boolean) {
    if (persist) {
      this.seq += 1
      this.rt.store.events.append(this.row.id, this.seq, event).catch((err) => {
        log('error', 'session', `failed to persist event for ${this.row.id}: ${err}`)
      })
    }
    broadcast(this.rt, { type: 'session_event', sessionId: this.row.id, event })
  }
}

// ---------------------------------------------------------------------------
// Session registry helpers — all per-workspace.
// ---------------------------------------------------------------------------
function summarize(rt: WorkspaceRuntime, row: StoredSession): SessionSummary {
  const l = rt.live.get(row.id)
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    status: l?.status ?? 'idle',
    // The user's pick wins: it is what the next turn runs on, and it is set
    // before the subprocess has reported anything.
    model: row.model ?? l?.model,
    effort: row.effort ?? undefined,
    permissionMode: row.permissionMode ?? undefined,
    pinned: row.pinned || undefined,
    branch: rt.branches.get(row.id),
    ...(row.kind === 'watch-run' ? { kind: 'watch-run' as const } : {}),
    ...(row.watchId ? { watchId: row.watchId } : {}),
  }
}

/**
 * The chat session list: pinned first, then most recently active. Watch-run
 * sessions are real sessions but not chats — they are excluded here and reached
 * through the watch that owns them (.docs/watches-v2.md).
 */
function summaries(rt: WorkspaceRuntime): SessionSummary[] {
  return [...rt.rows.values()]
    .filter((r) => r.kind !== 'watch-run')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    .map((r) => summarize(rt, r))
}

/**
 * Delete a session for good: its subprocess, its in-memory state, and its
 * whole log. The subprocess is stopped first so nothing is still writing to a
 * row that is about to go.
 */
async function deleteSession(rt: WorkspaceRuntime, sessionId: string): Promise<void> {
  rt.live.get(sessionId)?.stop()
  rt.live.delete(sessionId)
  rt.rows.delete(sessionId)
  rt.branches.delete(sessionId)
  await rt.store.sessions.remove(sessionId)
  broadcast(rt, { type: 'session_deleted', sessionId })
  broadcastSessionList(rt)
}

async function refreshBranch(rt: WorkspaceRuntime, row: StoredSession) {
  try {
    const { stdout } = await pExecFile('git', ['-C', row.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = stdout.trim()
    if (branch && rt.branches.get(row.id) !== branch) {
      rt.branches.set(row.id, branch)
      broadcastSessionList(rt)
    }
  } catch {
    // not a git repo — no chip
  }
}

async function createSession(
  rt: WorkspaceRuntime,
  title: string,
  cwd: string,
  model: string | null,
  effort: EffortLevel | null,
  permissionMode: PermissionMode | null,
): Promise<StoredSession> {
  const row = await rt.store.sessions.create({
    id: randomUUID(),
    title,
    cwd,
    model,
    effort,
    permissionMode,
  })
  rt.rows.set(row.id, row)
  rt.live.set(row.id, new LiveSession(rt, row, 0, null))
  void refreshBranch(rt, row)
  return row
}

/** The live subprocess for a session, starting one (with `resume`) if needed. */
async function getOrRevive(rt: WorkspaceRuntime, sessionId: string): Promise<LiveSession | null> {
  const existing = rt.live.get(sessionId)
  if (existing) return existing
  const row = rt.rows.get(sessionId)
  if (!row) return null
  const lastSeq = await rt.store.events.lastSeq(row.id)
  const revived = new LiveSession(rt, row, lastSeq, row.sdkSessionId)
  rt.live.set(row.id, revived)
  broadcastSessionList(rt)
  return revived
}

/**
 * Boot: load stored sessions, and expire permission prompts orphaned by the
 * previous process (their subprocess died with it — Allow can never apply).
 */
async function loadSessions(rt: WorkspaceRuntime) {
  for (const row of await rt.store.sessions.list()) {
    rt.rows.set(row.id, row)
    void refreshBranch(rt, row)

    const events = await rt.store.events.read(row.id)
    const unresolved = new Map<string, true>()
    for (const e of events) {
      if (e.event.kind === 'permission_request') unresolved.set(e.event.id, true)
      if (e.event.kind === 'permission_resolved') unresolved.delete(e.event.id)
    }
    let seq = events.length ? events[events.length - 1].seq : 0
    for (const id of unresolved.keys()) {
      seq += 1
      await rt.store.events.append(row.id, seq, { kind: 'permission_resolved', id, behavior: 'expired' })
    }
  }
}

// ---------------------------------------------------------------------------
// Inbox: ranked work items from deterministic sources (core/work). No cron —
// the server IS the long-running process. Sync happens when the page is
// viewed and the cache is stale (stale-while-revalidate, the cache living in
// SQLite so a fresh server start still renders instantly), on explicit
// Refresh, and on a keep-warm interval while the server runs. A laptop that
// slept through the interval simply syncs on the next view.
// ---------------------------------------------------------------------------
const INBOX_TTL_MS = 5 * 60_000
const INBOX_KEEP_WARM_MS = 15 * 60_000
const SCHEDULER_TICK_MS = 60_000
const GITHUB_TTL_MS = 5 * 60_000
const GITHUB_LOOKBACK_MS = 14 * 86_400_000
/** how many watch runs may execute at once (avoid the top-of-hour stampede) */
const WATCH_CONCURRENCY = 2
const WATCH_TIMEOUT_MS = 240_000

const REPOS_KEY = 'github.repos'
const WATCHES_SEEDED_KEY = 'watches.seeded'

/** when the scheduler last ticked — daemon-wide, surfaced in the System status. */
let lastSchedulerTickAt: number | null = null

async function connectedRepos(rt: WorkspaceRuntime): Promise<string[]> {
  return (await rt.store.config.get<string[]>(REPOS_KEY)) ?? []
}

/** Is the claude.ai Slack connector connected, per the last connector probe? */
function slackConnected(rt: WorkspaceRuntime): boolean | null {
  if (!rt.connectorCache) return null // no probe yet
  return rt.connectorCache.connectors.some(
    (c) => c.source === 'claude.ai' && c.name === 'Slack' && c.status === 'connected',
  )
}

/**
 * GitHub reconciliation (.docs/watches-v2.md). GitHub is a deterministic source,
 * not an LLM scan, so it stays plain code — but it now writes into the SAME
 * durable store as everything else instead of being refetched-and-discarded
 * every view. Open PRs/issues are upserted (idempotent, newer-wins); a tracked
 * open item whose PR has since merged or closed is auto-done with actor:system
 * and evidence — recorded and reversible, never a silent vanish. Throttled; a
 * failure degrades to a notice and keeps whatever is already stored.
 */
async function reconcileGitHub(rt: WorkspaceRuntime, force = false): Promise<void> {
  if (rt.githubReconcileInFlight) return rt.githubReconcileInFlight
  if (!force && Date.now() - rt.githubReconcileAt < GITHUB_TTL_MS) return
  rt.githubReconcileInFlight = (async () => {
    try {
      const repos = await connectedRepos(rt)
      // Workspace isolation (.docs/workspaces.md): repo scope is per-workspace,
      // and an empty scope means NO GitHub items — not the whole account. An
      // account-wide search would mirror the same PRs into every workspace's
      // inbox, which is exactly the cross-workspace bleed workspaces exist to
      // prevent. You opt each workspace into the repos it should track.
      if (repos.length === 0) {
        rt.githubNotice = null
        rt.githubReconcileAt = Date.now()
        return
      }
      const now = Date.now()
      const open = await fetchGitHub(repos, now)
      for (const item of open) await rt.store.items.upsert(item)

      // Source-side completion: any tracked open/snoozed github item whose PR is
      // now merged/closed → done(system) with evidence.
      const closed = await fetchGitHubClosed(repos, new Date(now - GITHUB_LOOKBACK_MS).toISOString())
      if (closed.length > 0) {
        const byId = new Map(closed.map((c) => [c.id, c]))
        for (const it of await rt.store.items.listAll()) {
          if (it.source !== 'github') continue
          if (it.status !== 'open' && it.status !== 'snoozed') continue
          const c = byId.get(it.id)
          if (c) {
            const reason = c.state === 'merged' ? 'PR merged' : 'PR closed'
            await rt.store.items.transition(it.id, {
              status: 'done',
              actor: 'system',
              detail: { reason, evidence: c.url },
            })
            log('info', 'github', `auto-done: ${it.id} (${reason})`, { id: it.id, state: c.state, workspace: rt.meta.id })
          }
        }
      }
      rt.githubNotice = null
      rt.githubReconcileAt = Date.now()
      log('info', 'github', `reconciled: ${open.length} open, ${closed.length} closed/merged`, { workspace: rt.meta.id })
    } catch (err) {
      rt.githubNotice = `github: ${err instanceof Error ? err.message : String(err)}`
      log('error', 'github', err instanceof Error ? err.message : String(err), { workspace: rt.meta.id })
    } finally {
      rt.githubReconcileInFlight = null
    }
  })()
  return rt.githubReconcileInFlight
}

/**
 * Rebuild the open-inbox snapshot from the durable store: wake elapsed snoozes,
 * reconcile GitHub (throttled), then rank + link the open items. There is no
 * user-state overlay any more — status lives on each row, so this is a pure
 * fold over what the store already holds.
 */
function syncInbox(rt: WorkspaceRuntime): Promise<InboxSnapshot> {
  if (rt.inboxInFlight) return rt.inboxInFlight
  rt.inboxInFlight = (async () => {
    try {
      const now = Date.now()
      await rt.store.items.wakeSnoozed(now)
      await reconcileGitHub(rt)
      const scoped = new Set(await connectedRepos(rt))
      const items = scopeGitHub(await rt.store.items.list('open'), scoped)
      const notices: string[] = []
      if (rt.githubNotice) notices.push(rt.githubNotice)
      // Honest empty state: a workspace with no repos scoped pulls no GitHub —
      // say so, so "nothing here" is never mistaken for "the source is broken".
      if (scoped.size === 0) {
        notices.push('github: no repos scoped to this workspace — pick repos in the inbox’s repo filter to pull PRs and issues here')
      }
      if (slackConnected(rt) === false) {
        notices.push('slack: the claude.ai Slack connector is disconnected — reconnect it for Slack items to appear')
      } else if (slackConnected(rt) === true) {
        // Honest empty state: surface any watch that failed or has gone overdue,
        // so "nothing here" is never confused with "the scan never looked".
        for (const w of await rt.store.watches.list()) {
          if (!w.enabled) continue
          if (w.lastRunStatus === 'failed') {
            notices.push(`watch “${w.title}” last run failed${w.lastRunError ? `: ${w.lastRunError}` : ''}`)
          } else if (overdueWatch(w, now)) {
            notices.push(`watch “${w.title}” hasn’t completed a run recently — items from it may be missing`)
          }
        }
      }
      const { items: ranked } = buildInbox({ items, notices, now })
      rt.inboxCache = { syncedAt: now, items: ranked, notices }
      void rt.store.inbox.save(rt.inboxCache)
      return rt.inboxCache
    } finally {
      rt.inboxInFlight = null
    }
  })()
  return rt.inboxInFlight
}

/**
 * Drop GitHub items outside this workspace's repo scope (.docs/workspaces.md).
 * Repo scope is per-workspace and empty = none, so a workspace only ever shows
 * PRs/issues from the repos it opted into — even for rows ingested earlier under
 * a wider (or account-wide) scope. Non-destructive: nothing is mutated, so
 * re-scoping a repo makes its items reappear at once. Other sources pass through.
 */
function scopeGitHub<T extends { source: string; repo: string }>(items: T[], scoped: Set<string>): T[] {
  return items.filter((i) => i.source !== 'github' || scoped.has(i.repo))
}

/** Ranked items for a status tab other than the open inbox (read-only, no scan). */
async function listItemsByStatus(rt: WorkspaceRuntime, status: ItemStatus, now = Date.now()): Promise<InboxSnapshot['items']> {
  const scoped = new Set(await connectedRepos(rt))
  const items = scopeGitHub(await rt.store.items.list(status), scoped)
  return linkByRefs(rank(items, now))
}

// ---------------------------------------------------------------------------
// Watch runs (.docs/watches-v2.md): one run per watch, each a real session so
// its transcript is the run's receipt. A small queue caps concurrency and
// jitters starts so the top of the hour doesn't stampede; a per-watch in-flight
// guard turns "already running" into a recorded 'skipped', never a silent no-op.
// The output contract is TOOL CALLS: the run gets a permalink-shaped
// upsert_work_item that stamps identity, kind, and provenance, so a work item
// exists because a tool call created it — no JSON parsing, no cursor-advance-on-
// garbled-output bug. Cursors advance only on a successful run.
// ---------------------------------------------------------------------------
function sumTokens(usage: Record<string, unknown> | undefined): number {
  let tokens = 0
  const u = usage ?? {}
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    const v = u[k]
    if (typeof v === 'number') tokens += v
  }
  return tokens
}

/** A watch is overdue if no run has completed within a grace window past its cadence. */
function overdueWatch(w: Watch, now: number): boolean {
  const grace = w.cadence === 'hourly' ? 2 * 3_600_000 : w.cadence === 'daily' ? 26 * 3_600_000 : 8 * 86_400_000
  return now - (w.lastRunAt ?? w.createdAt) > grace
}

/** The daemon's live status for one workspace, for the System modal. */
async function systemStatus(rt: WorkspaceRuntime): Promise<SystemStatus> {
  const now = Date.now()
  const watches = await rt.store.watches.list()
  const enabled = watches.filter((w) => w.enabled)
  return {
    version: VERSION,
    startedAt: SERVER_STARTED,
    uptimeMs: now - SERVER_STARTED,
    port: PORT,
    workspace: rt.meta.name,
    db: dbFileFor(rt.meta.id, registry.defaultId),
    liveSessions: rt.live.size,
    slackConnected: slackConnected(rt),
    connectorsProbedAt: rt.connectorCache?.probedAt ?? null,
    connectorCount: rt.connectorCache?.connectors.length ?? null,
    schedulerLastTickAt: lastSchedulerTickAt,
    runningWatches: rt.runningWatches.size,
    inboxSyncedAt: rt.inboxCache?.syncedAt ?? null,
    githubReconcileAt: rt.githubReconcileAt || null,
    githubNotice: rt.githubNotice,
    watches: {
      total: watches.length,
      enabled: enabled.length,
      overdue: enabled.filter((w) => overdueWatch(w, now)).length,
      failing: enabled.filter((w) => w.lastRunStatus === 'failed').length,
    },
    logDir: logFilePath(),
  }
}

async function runDueWatches(rt: WorkspaceRuntime, opts: { force?: boolean } = {}): Promise<void> {
  if (slackConnected(rt) !== true) return
  const now = new Date()
  for (const w of await rt.store.watches.list()) {
    if (!w.enabled) continue
    if (!opts.force && !isDue(w, now)) continue
    if (rt.runningWatches.has(w.id)) {
      // a previous run is still going — record the skip rather than swallow it
      await rt.store.watches.recordRun(w.id, {
        lastRunAt: Date.now(),
        lastRunTokens: 0,
        lastRunMatches: 0,
        status: 'skipped',
        error: 'previous run still in progress',
      })
      log('warn', 'scheduler', `skipped ${w.title}: previous run still in progress`, { watchId: w.id, workspace: rt.meta.id })
      continue
    }
    if (!rt.runQueue.includes(w.id)) rt.runQueue.push(w.id)
  }
  pumpRunQueue(rt)
}

/**
 * Queue a single watch to run now (the per-watch "Run" button — a force run,
 * independent of cadence). Respects the in-flight guard so a double-click can't
 * start two runs of the same watch. Returns whether it queued or was already
 * running. Scheduled cadence runs continue independently via runDueWatches.
 */
function enqueueWatch(rt: WorkspaceRuntime, id: string): 'queued' | 'running' {
  if (rt.runningWatches.has(id)) return 'running'
  if (!rt.runQueue.includes(id)) rt.runQueue.push(id)
  pumpRunQueue(rt)
  return 'queued'
}

function pumpRunQueue(rt: WorkspaceRuntime): void {
  while (rt.activeRuns < WATCH_CONCURRENCY && rt.runQueue.length > 0) {
    const id = rt.runQueue.shift()!
    if (rt.runningWatches.has(id)) continue
    rt.runningWatches.add(id)
    rt.activeRuns += 1
    const jitter = Math.floor(Math.random() * 3_000)
    setTimeout(() => {
      runWatch(rt, id)
        .catch((err) => log('error', 'watch', `run crashed: ${err}`, { workspace: rt.meta.id }))
        .finally(() => {
          rt.activeRuns -= 1
          rt.runningWatches.delete(id)
          pumpRunQueue(rt)
        })
    }, jitter)
  }
}

/**
 * The per-run ingestion tool. Upsert-only, permalink-shaped: the scanner passes
 * what it can see (permalink, title, why, timestamp, refs); the server stamps
 * identity (slack:<tail>), kind, channel, and provenance (this watch + run). So
 * the model only ADDS candidates and annotates why — lifecycle stays in code.
 */
function makeScanMcp(rt: WorkspaceRuntime, watch: Watch, runId: string, onUpsert: () => void) {
  let count = 0
  return createSdkMcpServer({
    name: 'triage',
    version: VERSION,
    tools: [
      tool(
        'upsert_work_item',
        'Record ONE matching Slack thread as a work item. Call once per matching thread; the server assigns its id, kind, and channel.',
        {
          permalink: z.string().describe('the Slack message permalink'),
          title: z.string().describe('a one-line summary of the thread'),
          from: z.string().optional().describe('display name of the author/asker'),
          lastActivity: z.string().describe('ISO 8601 timestamp of the newest message in the thread'),
          why: z.string().describe('one line: exactly what matched the instruction'),
          refs: z.array(z.string()).optional().describe('GitHub PR/issue URLs or Linear keys in the content'),
        },
        async (args) => {
          try {
            // Cost guard, enforced here not just in the prompt.
            if (count >= MAX_ROWS_PER_WATCH) {
              return errResult(`row cap reached (${MAX_ROWS_PER_WATCH}) — stop calling this tool`)
            }
            count += 1
            const now = Date.now()
            const when = safeWhen(args.lastActivity, now)
            const refs = canonicalizeRefs(args.refs)
            const item: CoreWorkItem = {
              id: permalinkId(args.permalink),
              source: 'slack',
              kind: watch.createsItems ? 'watch-hit' : 'fyi',
              title: args.title,
              url: args.permalink,
              repo: watch.scope,
              author: args.from ?? '',
              peopleWaiting: 0,
              createdAt: when,
              updatedAt: when,
              ...(refs ? { refs } : {}),
            }
            const prov: Provenance = { watchId: watch.id, runId, at: now, why: args.why }
            const { outcome } = await rt.store.items.upsert(item, prov)
            onUpsert()
            rt.inboxCache = null
            log('info', 'watch', `filed (${outcome}): ${item.title}`, {
              id: item.id,
              watchId: watch.id,
              runId,
              channel: watch.scope,
              outcome,
              workspace: rt.meta.id,
            })
            return okResult('ok: recorded')
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
    ],
  })
}

/**
 * Run one watch to completion as a headless session. Persists the transcript to
 * the event log (so it is observable like any session), advances the cursor only
 * on success, and records the run's status/tokens/matches on the watch row.
 */
async function runWatch(rt: WorkspaceRuntime, watchId: string): Promise<void> {
  const watch = await rt.store.watches.get(watchId)
  if (!watch) return
  const startedMs = Date.now()
  const startedIso = new Date(startedMs).toISOString()
  const session = await rt.store.sessions.create({
    id: randomUUID(),
    title: `Watch · ${watch.title}`,
    cwd: os.homedir(),
    kind: 'watch-run',
    watchId: watch.id,
  })
  rt.rows.set(session.id, session)
  log('info', 'watch', `run started: ${watch.title}`, { watchId: watch.id, runId: session.id, scope: watch.scope, cursor: watch.cursor, workspace: rt.meta.id })

  let seq = 0
  const emit = (event: SessionEvent, persist = true) => {
    if (persist) {
      seq += 1
      rt.store.events.append(session.id, seq, event).catch(() => {})
    }
    broadcast(rt, { type: 'session_event', sessionId: session.id, event })
  }

  let matches = 0
  let tokens = 0
  let status: WatchRunStatus = 'failed'
  let error: string | undefined
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), WATCH_TIMEOUT_MS)
  const scanMcp = makeScanMcp(rt, watch, session.id, () => {
    matches += 1
  })

  try {
    const q = query({
      prompt: composeWatchRunPrompt({ scope: watch.scope, instruction: watch.instruction, cursor: watch.cursor }),
      options: {
        cwd: os.homedir(),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user'],
        allowedTools: [...READ_ONLY_SLACK_TOOLS, 'mcp__triage__upsert_work_item'],
        mcpServers: { triage: scanMcp },
        abortController: abort,
        ...(rt.env ? { env: rt.env } : {}),
      },
    })
    let sawResult = false
    let resultText = ''
    for await (const msg of q) {
      const m = msg as unknown as SdkMessage & { result?: string; usage?: Record<string, unknown> }
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
        session.sdkSessionId = m.session_id
        rt.store.sessions.setSdkSessionId(session.id, m.session_id).catch(() => {})
      }
      emit({ kind: 'sdk', message: m as SdkMessage }, m.type !== 'stream_event')
      if (m.type === 'result') {
        sawResult = true
        resultText = typeof m.result === 'string' ? m.result : ''
        tokens = sumTokens(m.usage)
      }
    }
    if (resultText.includes('no-slack-tools')) {
      throw new Error('no Slack tools — enable Slack for Claude at claude.ai/settings/connectors')
    }
    if (!sawResult) throw new Error('scan ended without a result')
    status = 'ok'
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    emit({ kind: 'error', message: error })
  } finally {
    clearTimeout(timer)
    await rt.store.watches.recordRun(watch.id, {
      // cursor advances ONLY on success — a failed/timed-out run must not skip its window
      ...(status === 'ok' ? { cursor: startedIso } : {}),
      lastRunAt: Date.now(),
      lastRunTokens: tokens,
      lastRunMatches: matches,
      status,
      sessionId: session.id,
      error,
    })
    // the run's own receipt, on its session row — powers the Activity view
    session.runStatus = status
    session.runMatches = matches
    session.runTokens = tokens
    session.runError = error
    await rt.store.sessions.recordWatchRun(session.id, { status, matches, tokens, error })
    log(
      status === 'ok' ? 'info' : 'error',
      'watch',
      `run ${status}: ${watch.title}${status === 'ok' ? ` — ${matches} filed, ${Math.round(tokens / 1000)}k tok` : ''}${error ? ` — ${error}` : ''}`,
      { watchId: watch.id, runId: session.id, status, matches, tokens, durationMs: Date.now() - startedMs, workspace: rt.meta.id, ...(error ? { error } : {}) },
    )
    if (status === 'ok') {
      rt.inboxCache = null
      void syncInbox(rt)
    }
    broadcastSessionList(rt)
  }
}

/**
 * Pre-installed watch templates (.docs/watches-v2.md): the old built-in Slack
 * rules, shipped as data and seeded as editable copies on first run. A user can
 * disable, edit, or duplicate them; a `templateId` marks the origin.
 */
const WATCH_TEMPLATES: Array<
  Pick<Watch, 'title' | 'scope' | 'instruction' | 'schedule' | 'cadence' | 'createsItems'> & { templateId: string }
> = [
  {
    templateId: 'unread-dms',
    title: 'Unread DMs',
    scope: '@dm',
    instruction: 'Find my unread Slack direct messages and triage each unanswered one into a work item.',
    schedule: '0 * * * *',
    cadence: 'hourly',
    createsItems: true,
  },
  {
    templateId: 'mentions',
    title: 'Mentions',
    scope: '@mentions',
    instruction: 'Find Slack messages where I am mentioned or tagged and my reply is still awaited, and triage each into a work item.',
    schedule: '0 * * * *',
    cadence: 'hourly',
    createsItems: true,
  },
]

/**
 * Install any built-in template the user has never been offered — tracked per
 * template id, not by a single "seeded" flag. So the built-ins appear even when
 * the user already has custom watches (the old "seed only if empty" rule left
 * DBs that predated seeding with no built-ins at all), a template already
 * present is never duplicated, and one the user deleted is never re-added.
 * Per-workspace: each workspace's config table tracks its own seeding.
 */
async function seedWatchTemplates(rt: WorkspaceRuntime): Promise<void> {
  // The key used to hold a boolean; it now holds the list of seeded template ids.
  // A legacy boolean coerces to "none seeded yet" so the built-ins get installed.
  const raw = await rt.store.config.get<unknown>(WATCHES_SEEDED_KEY)
  const seeded = new Set<string>(Array.isArray(raw) ? (raw as string[]) : [])
  const watches = await rt.store.watches.list()
  const now = Date.now()
  for (const t of WATCH_TEMPLATES) {
    if (seeded.has(t.templateId)) continue
    // Already present (e.g. seeded by the older flag-based path)? Record, don't duplicate.
    if (!watches.some((w) => w.templateId === t.templateId)) {
      await rt.store.watches.create({
        id: randomUUID(),
        source: 'slack',
        title: t.title,
        scope: t.scope,
        instruction: t.instruction,
        schedule: t.schedule,
        cadence: t.cadence,
        createsItems: t.createsItems,
        enabled: true,
        templateId: t.templateId,
        createdAt: now,
        updatedAt: now,
      })
    }
    seeded.add(t.templateId)
  }
  await rt.store.config.set(WATCHES_SEEDED_KEY, [...seeded])
}

// The minute tick (.docs/watches.md): due watches run, elapsed snoozes wake — in
// every workspace. No cron — the server is the long-running process; missed
// runs are simply due on the first tick after wake.
setInterval(() => {
  lastSchedulerTickAt = Date.now()
  for (const rt of runtimes.values()) {
    runDueWatches(rt).catch((err) => log('error', 'scheduler', `tick failed: ${err}`, { workspace: rt.meta.id }))
    rt.store.items
      .wakeSnoozed(Date.now())
      .then((woken) => {
        if (woken.length > 0) {
          rt.inboxCache = null
          log('info', 'scheduler', `woke ${woken.length} snoozed item(s)`, { ids: woken, workspace: rt.meta.id })
        }
      })
      .catch((err) => log('error', 'scheduler', `snooze wake failed: ${err}`, { workspace: rt.meta.id }))
  }
}, SCHEDULER_TICK_MS).unref()

// The repo picker's "available" list; slow-ish (paginated), so cached.
async function affiliatedRepos(rt: WorkspaceRuntime): Promise<string[]> {
  if (rt.affiliatedCache && Date.now() - rt.affiliatedCache.at < 10 * 60_000) return rt.affiliatedCache.repos
  const repos = await listAffiliatedRepos()
  rt.affiliatedCache = { at: Date.now(), repos }
  return repos
}

async function getInbox(rt: WorkspaceRuntime, force: boolean): Promise<InboxSnapshot> {
  if (!force && rt.inboxCache && Date.now() - rt.inboxCache.syncedAt < INBOX_TTL_MS) return rt.inboxCache
  return syncInbox(rt)
}

// Keep the caches warm while the server runs, so page loads are instant. A
// failed background sync keeps the previous snapshot; the next view retries.
setInterval(() => {
  for (const rt of runtimes.values()) {
    syncInbox(rt).catch((err) => log('error', 'inbox', `background sync failed: ${err}`, { workspace: rt.meta.id }))
  }
}, INBOX_KEEP_WARM_MS).unref()

// ---------------------------------------------------------------------------
// Connectors: what a session will actually load, learned the honest way — by
// spawning a throwaway query with the SAME options real sessions use and
// asking it via the mcpServerStatus() control request (no user message, no
// API turn). `claude mcp list` has no machine output, and the config files
// under ~/.claude are private formats; this is the SDK's own structured
// answer to "which servers connected". Per-workspace: two auth backends
// genuinely have different connectors, so each runtime probes with its own env.
// ---------------------------------------------------------------------------
const CLAUDE_AI_PREFIX = 'claude.ai '

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

function probeConnectors(rt: WorkspaceRuntime): Promise<ConnectorProbe> {
  // Concurrent requests share one probe — a probe is a whole subprocess.
  if (rt.connectorInFlight) return rt.connectorInFlight
  rt.connectorInFlight = (async () => {
    const input = new AsyncQueue<SDKUserMessage>()
    const q = query({
      prompt: input,
      options: {
        cwd: os.homedir(), // user-level view; no project .mcp.json in the way
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        ...(rt.env ? { env: rt.env } : {}),
      },
    })
    try {
      // Servers connect asynchronously; poll until none are pending (or the
      // budget runs out and we report the stragglers as they are).
      const deadline = Date.now() + 45_000
      let statuses = await q.mcpServerStatus()
      while (statuses.some((srv) => srv.status === 'pending') && Date.now() < deadline) {
        await sleep(1_000)
        statuses = await q.mcpServerStatus()
      }
      const connectors = statuses
        .map((srv): Connector =>
          srv.name.startsWith(CLAUDE_AI_PREFIX)
            ? { name: srv.name.slice(CLAUDE_AI_PREFIX.length), status: srv.status, source: 'claude.ai' }
            : { name: srv.name, status: srv.status, source: 'local' },
        )
        .sort((a, b) => a.name.localeCompare(b.name))
      rt.connectorCache = { probedAt: Date.now(), connectors }
      log('info', 'connectors', `probed: ${connectors.length} server(s), ${connectors.filter((c) => c.status === 'connected').length} connected`, { workspace: rt.meta.id })
      return rt.connectorCache
    } finally {
      input.close()
      void q.return(undefined).catch(() => {}) // dispose the subprocess
      rt.connectorInFlight = null
    }
  })()
  return rt.connectorInFlight
}

// ---------------------------------------------------------------------------
// Models: which models this workspace's Claude Code will actually run. Asked of
// the SDK (supportedModels()) rather than hardcoded — the catalog moves, an
// org policy can shrink it, and an api-key workspace may see a different list
// than a subscription one. Same throwaway-subprocess shape as the connector
// probe, and the answer is stable enough to cache for the process.
// ---------------------------------------------------------------------------
function probeModels(rt: WorkspaceRuntime): Promise<ModelProbe> {
  if (rt.modelInFlight) return rt.modelInFlight
  rt.modelInFlight = (async () => {
    const input = new AsyncQueue<SDKUserMessage>()
    const q = query({
      prompt: input,
      options: {
        cwd: os.homedir(),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        ...(rt.env ? { env: rt.env } : {}),
      },
    })
    try {
      const models = (await q.supportedModels()).map(
        (m): ModelOption => ({
          id: m.value,
          resolvedModel: m.resolvedModel,
          name: m.displayName,
          description: m.description,
          efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
        }),
      )
      rt.modelCache = { probedAt: Date.now(), models }
      log('info', 'models', `probed: ${models.length} model(s) available`, { workspace: rt.meta.id })
      return rt.modelCache
    } finally {
      input.close()
      void q.return(undefined).catch(() => {}) // dispose the subprocess
      rt.modelInFlight = null
    }
  })()
  return rt.modelInFlight
}

/**
 * A REAL auth check: one trivial headless turn with the workspace's env. The
 * model catalog (supportedModels) is static and "succeeds" on a bogus key, so
 * the verify step must actually reach the API to prove a key or login works.
 * Costs one minimal turn; only run for api-key / config-dir on explicit verify.
 */
async function probeAuth(rt: WorkspaceRuntime): Promise<{ ok: boolean; error?: string }> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 90_000)
  try {
    const q = query({
      prompt: 'Reply with exactly: OK',
      options: {
        cwd: os.homedir(),
        maxTurns: 1,
        settingSources: [],
        allowedTools: [],
        abortController: abort,
        ...(rt.env ? { env: rt.env } : {}),
      },
    })
    for await (const msg of q) {
      const m = msg as unknown as SdkMessage & { subtype?: string; result?: string }
      if (m.type === 'result') {
        if (m.subtype === 'success') return { ok: true }
        return { ok: false, error: typeof m.result === 'string' && m.result ? m.result : `auth check failed (${m.subtype})` }
      }
    }
    return { ok: false, error: 'auth check ended without a result' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Workspace management — registry CRUD + the live runtime bookkeeping. Auth is
// spawn-time: changing a workspace's backend stops its live subprocesses (the
// next message revives them with the new env) and re-probes.
// ---------------------------------------------------------------------------
function wireWorkspace(meta: WorkspaceMeta): Workspace {
  return {
    id: meta.id,
    name: meta.name,
    color: meta.color,
    ...(meta.description ? { description: meta.description } : {}),
    authBackend: meta.authBackend,
    isDefault: meta.id === registry.defaultId,
    createdAt: meta.createdAt,
    ...(meta.authBackend === 'api-key' ? { apiKeyHint: apiKeyHint(meta.id) } : {}),
    ...(meta.authBackend === 'config-dir'
      ? { configDir: workspaceClaudeDir(meta.id), loginCommand: loginCommandFor(meta.id) }
      : {}),
  }
}

const wireWorkspaces = (): Workspace[] => registry.workspaces.map(wireWorkspace)

/** Bring a runtime up: sessions, seeds, cached snapshot, background probes. */
async function initRuntime(rt: WorkspaceRuntime): Promise<void> {
  await loadSessions(rt)
  await seedWatchTemplates(rt)
  rt.inboxCache = await rt.store.inbox.load()
  probeConnectors(rt).catch((err) => log('error', 'connectors', `probe failed: ${err}`, { workspace: rt.meta.id }))
  probeModels(rt).catch((err) => log('error', 'models', `probe failed: ${err}`, { workspace: rt.meta.id }))
}

/** After an auth change: new env, fresh probes, and no subprocess on the old auth. */
function applyAuthChange(rt: WorkspaceRuntime): void {
  rt.refreshEnv()
  for (const s of rt.live.values()) s.stop() // next message revives with the new env
  rt.connectorCache = null
  rt.modelCache = null
  probeConnectors(rt).catch(() => {})
  probeModels(rt).catch(() => {})
  log('info', 'workspaces', `auth backend now ${rt.meta.authBackend}`, { workspace: rt.meta.id })
}

type WorkspacePatch = {
  name?: string
  color?: string
  description?: string
  authBackend?: 'inherit' | 'api-key' | 'config-dir'
  apiKey?: string
}

function workspacePatchFrom(raw: unknown): { patch: WorkspacePatch } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  const patch: WorkspacePatch = {}
  if (r.name !== undefined) {
    if (typeof r.name !== 'string' || !r.name.trim()) return { error: 'name must be a non-empty string' }
    patch.name = r.name.trim()
  }
  if (r.color !== undefined) {
    if (typeof r.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(r.color)) return { error: 'color must be a hex color like "#7aa2f7"' }
    patch.color = r.color
  }
  if (r.description !== undefined) {
    if (typeof r.description !== 'string') return { error: 'description must be a string' }
    patch.description = r.description.trim()
  }
  if (r.authBackend !== undefined) {
    const backend = toAuthBackend(r.authBackend)
    if (!backend) return { error: 'authBackend must be inherit | api-key | config-dir' }
    patch.authBackend = backend
  }
  if (r.apiKey !== undefined) {
    if (typeof r.apiKey !== 'string' || !r.apiKey.trim()) return { error: 'apiKey must be a non-empty string' }
    patch.apiKey = r.apiKey.trim()
  }
  return { patch }
}

// ---------------------------------------------------------------------------
// HTTP: JSON API + the built SPA
// ---------------------------------------------------------------------------
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : null)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Which workspace a request belongs to: the ?workspace= param wins (explicit —
 * the MCP shim and scripts use it), then the triage_ws cookie (how the SPA
 * rides: cookies travel on every fetch and on the WS upgrade with zero
 * call-site churn), then the default. A stale id falls back to the default
 * rather than erroring — a deleted workspace must not brick the UI.
 */
function cookieWorkspace(req: http.IncomingMessage): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === 'triage_ws') return decodeURIComponent(v.join('='))
  }
  return undefined
}

function resolveRuntime(req: http.IncomingMessage, url: URL): WorkspaceRuntime {
  const qid = url.searchParams.get('workspace')
  if (qid) {
    const rt = runtimes.get(qid)
    if (rt) return rt
  }
  const cid = cookieWorkspace(req)
  if (cid) {
    const rt = runtimes.get(cid)
    if (rt) return rt
  }
  return defaultRuntime()
}

// ---------------------------------------------------------------------------
// Input validation — the HTTP surface is untrusted (vision principle 6):
// bodies are validated into domain shapes, and rejected rather than repaired.
// ---------------------------------------------------------------------------

const CADENCES = new Set<WatchCadence>(['hourly', 'daily', 'weekly'])
const ITEM_STATUSES = new Set<ItemStatus>(['open', 'done', 'snoozed', 'archived'])
const VALID_KINDS = new Set(Object.keys(BASE))
const VALID_SOURCES = new Set(['github', 'slack', 'linear'])
// upsert accepts only scanner sources; state/resolve accept manual items too.
const ITEM_ID_RE = /^(github|slack|linear):\S+$/
const ANY_ITEM_ID_RE = /^(github|slack|linear|manual):\S+$/

type WatchPatch = Partial<NewWatch> & { enabled?: boolean }

function watchPatchFrom(raw: unknown): { patch: WatchPatch } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  const patch: WatchPatch = {}
  if (r.title !== undefined) {
    if (typeof r.title !== 'string' || !r.title.trim()) return { error: 'title must be a non-empty string' }
    patch.title = r.title.trim()
  }
  if (r.scope !== undefined) {
    if (typeof r.scope !== 'string' || !/^[#@]\S+$/.test(r.scope.trim())) return { error: 'scope must be "#channel" or "@dm"' }
    patch.scope = r.scope.trim()
  }
  if (r.instruction !== undefined) {
    if (typeof r.instruction !== 'string' || !r.instruction.trim()) return { error: 'instruction must be a non-empty string' }
    patch.instruction = r.instruction.trim()
  }
  if (r.cadence !== undefined) {
    if (!CADENCES.has(r.cadence as WatchCadence)) return { error: 'cadence must be hourly | daily | weekly' }
    patch.cadence = r.cadence as WatchCadence
  }
  if (r.schedule !== undefined) {
    if (typeof r.schedule !== 'string' || !isValidCron(r.schedule)) {
      return { error: 'schedule must be a valid 5-field cron expression, e.g. "0 9 * * *"' }
    }
    patch.schedule = r.schedule.trim()
  }
  if (r.windowStart !== undefined && r.windowStart !== null) {
    if (typeof r.windowStart !== 'string' || !/^\d{1,2}:\d{2}$/.test(r.windowStart)) return { error: 'windowStart must be "HH:MM"' }
    patch.windowStart = r.windowStart
  }
  if (r.windowDay !== undefined && r.windowDay !== null) {
    if (typeof r.windowDay !== 'number' || !Number.isInteger(r.windowDay) || r.windowDay < 0 || r.windowDay > 6) return { error: 'windowDay must be 0-6' }
    patch.windowDay = r.windowDay
  }
  if (r.createsItems !== undefined) {
    if (typeof r.createsItems !== 'boolean') return { error: 'createsItems must be a boolean' }
    patch.createsItems = r.createsItems
  }
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== 'boolean') return { error: 'enabled must be a boolean' }
    patch.enabled = r.enabled
  }
  return { patch }
}

/** A full ingested WorkItem, validated field by field. Rejects, never repairs. */
function workItemFrom(raw: unknown): { item: WorkItem } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'body must be a JSON object' }
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !ITEM_ID_RE.test(r.id)) return { error: 'id must look like "slack:...", "github:owner/repo#123", or "linear:KEY-123"' }
  const source = r.id.slice(0, r.id.indexOf(':'))
  if (r.source !== undefined && r.source !== source) return { error: `source must match the id prefix ("${source}")` }
  if (!VALID_SOURCES.has(source)) return { error: 'unknown source' }
  if (typeof r.kind !== 'string' || !VALID_KINDS.has(r.kind)) return { error: `kind must be one of: ${[...VALID_KINDS].join(', ')}` }
  if (typeof r.title !== 'string' || !r.title.trim()) return { error: 'title must be a non-empty string' }
  if (typeof r.url !== 'string' || !r.url.startsWith('http')) return { error: 'url must be an http(s) URL' }
  if (typeof r.updatedAt !== 'string' || !Number.isFinite(Date.parse(r.updatedAt))) return { error: 'updatedAt must be an ISO 8601 timestamp' }
  const createdAt = typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt)) ? r.createdAt : r.updatedAt
  return {
    item: {
      id: r.id,
      source: source as WorkItem['source'],
      kind: r.kind as WorkItem['kind'],
      title: r.title.trim(),
      url: r.url,
      repo: typeof r.repo === 'string' ? r.repo : '',
      author: typeof r.author === 'string' ? r.author : '',
      peopleWaiting: typeof r.peopleWaiting === 'number' && r.peopleWaiting >= 0 ? Math.floor(r.peopleWaiting) : 0,
      createdAt,
      updatedAt: r.updatedAt,
      ...(typeof r.watchId === 'string' ? { watchId: r.watchId } : {}),
      ...(typeof r.why === 'string' && r.why ? { why: r.why } : {}),
      ...(canonicalizeRefs(r.refs) ? { refs: canonicalizeRefs(r.refs) } : {}),
    },
  }
}

/**
 * A manual to-do's fields, validated. Project (if given) must exist; url (if
 * given) must be http(s); priority (if given) is 1–4. Title is required on
 * create; with `{ partial: true }` (an edit) only the fields present are
 * validated and returned, so a caller can patch one field without resending
 * the rest.
 */
async function manualItemFrom(rt: WorkspaceRuntime, raw: unknown): Promise<ManualItemInput>
async function manualItemFrom(rt: WorkspaceRuntime, raw: unknown, opts: { partial: true }): Promise<Partial<ManualItemInput>>
async function manualItemFrom(rt: WorkspaceRuntime, raw: unknown, opts: { partial?: boolean } = {}): Promise<Partial<ManualItemInput>> {
  if (typeof raw !== 'object' || raw === null) throw new Error('body must be a JSON object')
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  if (!title && !opts.partial) throw new Error('a work item needs a title')
  const input: Partial<ManualItemInput> = {}
  if (title) input.title = title
  if (typeof r.projectId === 'string' && r.projectId) {
    const projects = await rt.store.projects.list()
    if (!projects.some((p) => p.id === r.projectId)) throw new Error('unknown project')
    input.projectId = r.projectId
  }
  if (typeof r.note === 'string' && r.note.trim()) input.note = r.note.trim()
  if (typeof r.url === 'string' && r.url.trim()) {
    if (!/^https?:\/\//.test(r.url.trim())) throw new Error('link must be an http(s) URL')
    input.url = r.url.trim()
  }
  // When the key is present, 0/null means "none" (0) so an edit can clear it;
  // when absent, priority is left untouched on update.
  if ('priority' in r) {
    const p = r.priority
    if (p === null || p === 0) input.priority = 0
    else if (typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 4) input.priority = p
    else throw new Error('priority must be 1–4')
  }
  return input
}

// ---------------------------------------------------------------------------
// Work-item operations — one core, three callers: the HTTP routes below, the
// in-process MCP server that web chats get (per-workspace triageMcp), and the
// stdio shim (server/mcp.ts) which reaches them over HTTP. Every transport
// funnels through these functions, so list/create/edit/upsert/resolve behave
// identically no matter who calls them. Validation stays in workItemFrom/
// manualItemFrom — the single source of truth, never duplicated per transport.
// ---------------------------------------------------------------------------
async function listItemsOp(rt: WorkspaceRuntime, filter: { source?: string; kind?: string } = {}): Promise<InboxSnapshot['items']> {
  const snap = await getInbox(rt, false)
  let items = snap.items
  if (filter.source) items = items.filter((i) => i.source === filter.source)
  if (filter.kind) items = items.filter((i) => i.kind === filter.kind)
  return items
}

async function upsertItemOp(rt: WorkspaceRuntime, raw: unknown): Promise<UpsertOutcome> {
  const parsed = workItemFrom(raw)
  if ('error' in parsed) throw new Error(parsed.error)
  const { outcome } = await rt.store.items.upsert(parsed.item)
  if (outcome !== 'unchanged') rt.inboxCache = null
  return outcome
}

async function resolveItemOp(rt: WorkspaceRuntime, rawId: unknown): Promise<void> {
  const id = typeof rawId === 'string' ? rawId : ''
  if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need a work-item id')
  await rt.store.items.transition(id, { status: 'done', actor: 'agent' })
  rt.inboxCache = null
  log('info', 'inbox', `done: ${id} (by agent)`, { id, actor: 'agent', workspace: rt.meta.id })
}

async function createManualOp(rt: WorkspaceRuntime, raw: unknown): Promise<string> {
  const input = await manualItemFrom(rt, raw)
  const id = `manual:${randomUUID()}`
  await rt.store.items.createManual({ id, ...input })
  rt.inboxCache = null
  log('info', 'inbox', `manual item created: ${input.title ?? id}`, { id, workspace: rt.meta.id })
  return id
}

// Edits target manual (user-authored) items only. Scanned items are
// upsert-newer-wins, so a free-form edit would be clobbered by the next scan —
// reject those with a clear message rather than silently no-op'ing.
async function editManualOp(rt: WorkspaceRuntime, id: string, raw: unknown): Promise<void> {
  if (!id || !id.startsWith('manual:'))
    throw new Error('edit_work_item only edits manual items (id must start with "manual:")')
  const patch = await manualItemFrom(rt, raw, { partial: true })
  await rt.store.items.updateManual(id, patch)
  rt.inboxCache = null
}

// The same tool surface every session gets in-process, matching the stdio
// shim's names/schemas one-for-one (server/mcp.ts) so a web chat and a local
// Claude Code session drive the inbox identically. Handlers call the ops above
// directly — no HTTP round-trip — against THIS workspace's store. Reads are
// auto-allowed in requestPermission; writes surface a permission prompt.
const okResult = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const errResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

function makeTriageMcp(rt: WorkspaceRuntime) {
  return createSdkMcpServer({
    name: 'triage',
    version: VERSION,
    tools: [
      tool(
        'list_work_items',
        'Read the ranked triage queue: every open work item with its score, group, and reason. Optional filters narrow by source or kind.',
        {
          source: z.enum(['github', 'slack', 'linear', 'manual']).optional().describe('only items from this source'),
          kind: z.string().optional().describe('only items of this kind, e.g. "watch-hit"'),
        },
        async (args) => {
          try {
            const items = await listItemsOp(rt, { source: args.source, kind: args.kind })
            return okResult(JSON.stringify(items, null, 2))
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'create_work_item',
        'Add a manual to-do to the inbox (a user-authored item). Title is required; note, url, priority (1–4), and projectId are optional.',
        {
          title: z.string().describe('what the to-do is'),
          note: z.string().optional(),
          url: z.string().optional().describe('an http(s) link'),
          priority: z.number().int().min(1).max(4).optional(),
          projectId: z.string().optional().describe('an existing project id'),
        },
        async (args) => {
          try {
            const id = await createManualOp(rt, args)
            return okResult(`ok: created ${id}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'edit_work_item',
        'Edit a manual to-do by id (id must start with "manual:"). Only the fields you pass change; priority 0/null clears it.',
        {
          id: z.string().describe('the manual item id, e.g. "manual:<uuid>"'),
          title: z.string().optional(),
          note: z.string().optional(),
          url: z.string().optional(),
          priority: z.number().int().min(0).max(4).nullable().optional(),
          projectId: z.string().optional(),
        },
        async (args) => {
          try {
            const { id, ...patch } = args
            await editManualOp(rt, id, patch)
            return okResult(`ok: edited ${id}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'upsert_work_item',
        'Idempotently upsert one ingested work item (for scanners). Id-keyed, update-only-if-newer by updatedAt, user-state-preserving: repeated calls never create duplicates or clobber done/snoozed/dismissed state. Invalid items are rejected, never repaired.',
        {
          id: z.string().describe('stable id: "slack:...", "github:owner/repo#123", or "linear:KEY-123"'),
          kind: z.string().describe('item kind, e.g. "watch-hit", "mention", "fyi"'),
          title: z.string(),
          url: z.string(),
          updatedAt: z.string().describe('ISO 8601 — the upsert applies only if newer than what is stored'),
          repo: z.string().optional(),
          author: z.string().optional(),
          peopleWaiting: z.number().optional(),
          createdAt: z.string().optional(),
          watchId: z.string().optional(),
          why: z.string().optional(),
          refs: z.array(z.string()).optional(),
        },
        async (args) => {
          try {
            const outcome = await upsertItemOp(rt, args)
            return okResult(`ok: ${outcome}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'resolve_work_item',
        'Mark one work item done (by id). Subject to the re-arm rule: if the source updates afterwards, the item returns to the inbox.',
        { id: z.string() },
        async (args) => {
          try {
            await resolveItemOp(rt, args.id)
            return okResult('ok: done')
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
    ],
  })
}

const NO_BUILD_HTML = `<!doctype html><meta charset="utf-8">
<title>triage — no build</title>
<body style="font:14px/1.6 system-ui;max-width:34em;margin:12vh auto;color:#dce3f0;background:#0d1017">
<h2 style="color:#e8b04b">No web build found</h2>
<p>This server is serving the production bundle from <code>dist/web</code>, which does not exist yet.</p>
<p>For development, run <code>npm run dev</code> and open the Vite URL it prints — it proxies
<code>/ws</code> and <code>/api</code> back here.</p>
<p>For a production-style run: <code>npm run build &amp;&amp; npm start</code>.</p>
</body>`

async function serveWeb(pathname: string, res: http.ServerResponse) {
  // Any path that is not a real asset falls back to index.html (SPA routing).
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const resolved = path.resolve(WEB_DIR, rel)
  const candidate = resolved.startsWith(WEB_DIR + path.sep) ? resolved : path.join(WEB_DIR, 'index.html')

  for (const file of [candidate, path.join(WEB_DIR, 'index.html')]) {
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' })
      res.end(body)
      return
    } catch {
      // try the SPA fallback next
    }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(NO_BUILD_HTML)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/health') {
    // The CLI's "is triage running" probe — see server/state.ts. Daemon-wide.
    json(200, {
      app: 'triage',
      version: VERSION,
      pid: process.pid,
      port: PORT,
      db: dbFileFor(registry.defaultId, registry.defaultId),
      liveSessions: [...runtimes.values()].reduce((n, rt) => n + rt.live.size, 0),
      workspaces: runtimes.size,
    })
    return
  }

  // --- workspace management (daemon-wide, not workspace-scoped) --------------
  if (url.pathname === '/api/workspaces' && req.method === 'GET') {
    const body: WorkspacesResponse = {
      ok: true,
      workspaces: wireWorkspaces(),
      defaultId: registry.defaultId,
      onboarded: registry.onboarded,
    }
    json(200, body)
    return
  }
  if (url.pathname === '/api/workspaces' && req.method === 'POST') {
    let body: WorkspaceResponse
    try {
      const parsed = workspacePatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const p = parsed.patch
      if (!p.name) throw new Error('a workspace needs a name')
      let id = slugify(p.name)
      for (let n = 2; runtimes.has(id); n++) id = `${slugify(p.name)}-${n}`
      const meta: WorkspaceMeta = {
        id,
        name: p.name,
        color: p.color ?? '#7aa2f7',
        ...(p.description ? { description: p.description } : {}),
        authBackend: p.authBackend ?? 'inherit',
        createdAt: Date.now(),
      }
      ensureWorkspaceDirs(id)
      if (p.apiKey) writeApiKey(id, p.apiKey)
      registry.workspaces.push(meta)
      saveRegistry(registry)
      const rt = new WorkspaceRuntime(meta)
      runtimes.set(id, rt)
      await initRuntime(rt)
      log('info', 'workspaces', `created: ${meta.name}`, { workspace: id, authBackend: meta.authBackend })
      body = { ok: true, workspace: wireWorkspace(meta) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/workspaces' && req.method === 'PUT') {
    let body: WorkspaceResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const rt = runtimes.get(id)
      if (!rt) throw new Error('unknown workspace id')
      const parsed = workspacePatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const p = parsed.patch
      if (p.name) rt.meta.name = p.name
      if (p.color) rt.meta.color = p.color
      if (p.description !== undefined) rt.meta.description = p.description || undefined
      const authChanged = (p.authBackend && p.authBackend !== rt.meta.authBackend) || p.apiKey !== undefined
      if (p.authBackend) rt.meta.authBackend = p.authBackend
      if (p.apiKey) writeApiKey(id, p.apiKey)
      saveRegistry(registry)
      if (authChanged) applyAuthChange(rt)
      body = { ok: true, workspace: wireWorkspace(rt.meta) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/workspaces' && req.method === 'DELETE') {
    let body: WorkspacesResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const rt = runtimes.get(id)
      if (!rt) throw new Error('unknown workspace id')
      if (id === registry.defaultId) throw new Error('the default workspace cannot be deleted — make another workspace the default first')
      // Remove from the registry and stop the runtime. The directory (DB,
      // .env, claude/) stays on disk — never delete data, only unregister.
      for (const s of rt.live.values()) s.stop()
      for (const ws of rt.clients) ws.close()
      runtimes.delete(id)
      registry.workspaces = registry.workspaces.filter((w) => w.id !== id)
      saveRegistry(registry)
      await rt.store.close()
      log('info', 'workspaces', `removed: ${rt.meta.name} (files kept on disk)`, { workspace: id })
      body = { ok: true, workspaces: wireWorkspaces(), defaultId: registry.defaultId, onboarded: registry.onboarded }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/workspaces/default' && req.method === 'POST') {
    let body: WorkspacesResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!runtimes.has(id)) throw new Error('unknown workspace id')
      registry.defaultId = id
      saveRegistry(registry)
      body = { ok: true, workspaces: wireWorkspaces(), defaultId: registry.defaultId, onboarded: registry.onboarded }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/workspaces/onboarded' && req.method === 'POST') {
    registry.onboarded = true
    saveRegistry(registry)
    json(200, { ok: true })
    return
  }
  // A live probe with the workspace's own env — the creation modal's verify
  // step, and the settings dialog's "Check again". Clears the caches first so
  // the answer reflects the auth as configured right now.
  if (url.pathname === '/api/workspaces/verify' && req.method === 'POST') {
    let body: WorkspaceVerifyResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const rt = runtimes.get(id)
      if (!rt) throw new Error('unknown workspace id')
      rt.refreshEnv()
      rt.connectorCache = null
      rt.modelCache = null
      const [models, connectors, auth] = await Promise.all([
        probeModels(rt),
        probeConnectors(rt),
        // inherit is the machine's own login — already proven by daily use.
        rt.meta.authBackend === 'inherit' ? Promise.resolve({ ok: true as const }) : probeAuth(rt),
      ])
      body = {
        ok: true,
        models: models.models,
        connectors: connectors.connectors,
        slackConnected: slackConnected(rt) === true,
        authOk: auth.ok,
        ...('error' in auth && auth.error ? { authError: auth.error } : {}),
      }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }

  // --- everything below is scoped to one workspace ---------------------------
  const rt = resolveRuntime(req, url)

  if (url.pathname === '/api/sessions') {
    json(200, summaries(rt))
    return
  }
  if (url.pathname === '/api/inbox') {
    let body: InboxResponse
    try {
      const snap = await getInbox(rt, url.searchParams.get('refresh') === '1')
      body = { ok: true, ...snap }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/repos') {
    let body: ReposResponse
    try {
      if (req.method === 'PUT') {
        const parsed = (await readJsonBody(req)) as { repos?: unknown } | null
        const repos = Array.isArray(parsed?.repos)
          ? parsed.repos.filter((r): r is string => typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r))
          : []
        await rt.store.config.set(REPOS_KEY, repos)
        rt.inboxCache = null // scope changed — force a resync on the next view
      }
      body = { ok: true, connected: await connectedRepos(rt), available: await affiliatedRepos(rt) }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/projects') {
    let body: ProjectsResponse
    let status = 200
    try {
      if (req.method === 'POST') {
        const parsed = (await readJsonBody(req)) as Partial<Project> | null
        const name = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
        const repo = typeof parsed?.repo === 'string' ? parsed.repo.trim() : ''
        const rawPath = typeof parsed?.path === 'string' ? parsed.path.trim() : ''
        if (!name || !rawPath) throw new Error('a project needs a name and a folder')
        if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" is not owner/name`)
        const resolved = expandHome(rawPath)
        const st = await stat(resolved).catch(() => null)
        if (!st?.isDirectory()) throw new Error(`folder not found: ${resolved}`)
        await rt.store.projects.create({ id: randomUUID(), name, repo, path: resolved })
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (id) await rt.store.projects.remove(id)
      }
      body = { ok: true, projects: await rt.store.projects.list() }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : status, body)
    return
  }
  if (url.pathname === '/api/watches') {
    let body: WatchesResponse
    let status = 200
    try {
      if (req.method === 'POST') {
        const parsed = watchPatchFrom(await readJsonBody(req))
        if ('error' in parsed) throw new Error(parsed.error)
        const p = parsed.patch
        if (!p.title || !p.scope || !p.instruction) {
          throw new Error('a watch needs title, scope, and instruction')
        }
        // Schedule is the source of truth; accept a legacy cadence as a fallback.
        const schedule = p.schedule ?? (p.cadence ? cronFromCadence(p.cadence, p.windowStart, p.windowDay) : '0 9 * * *')
        const now = Date.now()
        await rt.store.watches.create({
          id: randomUUID(),
          source: 'slack',
          title: p.title,
          scope: p.scope,
          instruction: p.instruction,
          schedule,
          cadence: p.cadence ?? 'daily',
          windowStart: p.windowStart,
          windowDay: p.windowDay,
          enabled: p.enabled ?? true,
          createsItems: p.createsItems ?? true,
          createdAt: now,
          updatedAt: now,
        })
        log('info', 'watch', `created: ${p.title}`, { scope: p.scope, schedule, workspace: rt.meta.id })
        // active on the next scheduler tick (never run → due immediately)
      } else if (req.method === 'PUT') {
        const id = url.searchParams.get('id')
        const existing = id ? await rt.store.watches.get(id) : null
        if (!id || !existing) throw new Error('unknown watch id')
        const parsed = watchPatchFrom(await readJsonBody(req))
        if ('error' in parsed) throw new Error(parsed.error)
        await rt.store.watches.update(id, parsed.patch)
        log('info', 'watch', `updated: ${parsed.patch.title ?? existing.title}`, { watchId: id, workspace: rt.meta.id })
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (id) {
          // Never hard-delete the items: archive this watch's open/snoozed items
          // with a recorded reason, then drop the watch row (.docs/watches-v2.md).
          let archived = 0
          for (const it of await rt.store.items.listAll()) {
            const fromWatch = it.watchId === id || (it.foundBy ?? []).some((p) => p.watchId === id)
            if (fromWatch && (it.status === 'open' || it.status === 'snoozed')) {
              await rt.store.items.transition(it.id, { status: 'archived', actor: 'system', detail: { reason: 'watch deleted' } })
              archived += 1
            }
          }
          await rt.store.watches.remove(id)
          rt.inboxCache = null
          log('info', 'watch', `deleted watch ${id}; archived ${archived} item(s)`, { watchId: id, archived, workspace: rt.meta.id })
        }
      }
      body = { ok: true, watches: await rt.store.watches.list() }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : status, body)
    return
  }
  if (url.pathname === '/api/watches/draft' && req.method === 'POST') {
    let body: WatchDraftResponse
    try {
      const parsed = (await readJsonBody(req)) as { text?: unknown } | null
      const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
      if (!text) throw new Error('describe the watch in plain text first')
      const draft = await draftWatch(text, undefined, rt.env)
      if (!draft) throw new Error('could not parse that into a watch — fill the form manually')
      body = { ok: true, draft }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/watches/preview' && req.method === 'POST') {
    let body: WatchPreviewResponse
    try {
      const parsed = watchPatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const { scope, instruction } = parsed.patch
      if (!scope || !instruction) throw new Error('a preview needs scope and instruction')
      if (slackConnected(rt) === false) throw new Error('the claude.ai Slack connector is not connected')
      const { rows, tokens } = await previewWatch(scope, instruction, undefined, rt.env)
      body = { ok: true, rows, tokens }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/items/state' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; status?: unknown; snoozeUntil?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      const statusV = parsed?.status as ItemStatus
      if (!ANY_ITEM_ID_RE.test(id) || !ITEM_STATUSES.has(statusV)) {
        throw new Error('need an item id and a status (open|done|snoozed|archived)')
      }
      const snoozeUntil = typeof parsed?.snoozeUntil === 'number' ? parsed.snoozeUntil : undefined
      if (statusV === 'snoozed' && !snoozeUntil) throw new Error('snoozed needs snoozeUntil (epoch ms)')
      // A recorded transition on the durable item — never a delete (.docs/watches-v2.md).
      await rt.store.items.transition(id, { status: statusV, actor: 'user', snoozeUntil })
      rt.inboxCache = null
      log('info', 'inbox', `${statusV}: ${id} (by user)`, { id, status: statusV, actor: 'user', workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Ranked items in a status tab other than the open inbox (done/snoozed/archived).
  if (url.pathname === '/api/items' && req.method === 'GET') {
    let body: ItemListResponse
    try {
      const s = url.searchParams.get('status')
      const status: ItemStatus = ITEM_STATUSES.has(s as ItemStatus) ? (s as ItemStatus) : 'open'
      body = { ok: true, items: await listItemsByStatus(rt, status) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // The append-only transition log for one item (its timeline).
  if (url.pathname === '/api/items/events' && req.method === 'GET') {
    let body: ItemEventsResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      if (!ANY_ITEM_ID_RE.test(id)) throw new Error('need an item id')
      body = { ok: true, events: await rt.store.items.events(id) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Activity: watch runs (each a session) as a browsable history, newest first.
  if (url.pathname === '/api/activity' && req.method === 'GET') {
    let body: ActivityResponse
    try {
      const watchId = url.searchParams.get('watchId')
      const titles = new Map((await rt.store.watches.list()).map((w) => [w.id, w.title]))
      const runs = [...rt.rows.values()]
        .filter((r) => r.kind === 'watch-run' && (!watchId || r.watchId === watchId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 200)
        .map((r) => ({
          sessionId: r.id,
          ...(r.watchId ? { watchId: r.watchId } : {}),
          watchTitle: (r.watchId && titles.get(r.watchId)) || r.title.replace(/^Watch · /, ''),
          status: r.runStatus,
          matches: r.runMatches,
          tokens: r.runTokens,
          startedAt: r.createdAt,
          finishedAt: r.updatedAt,
          ...(r.runError ? { error: r.runError } : {}),
        }))
      body = { ok: true, runs }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // The items one run produced (provenance runId === sessionId).
  if (url.pathname === '/api/activity/items' && req.method === 'GET') {
    let body: ItemListResponse
    try {
      const runId = url.searchParams.get('runId') ?? ''
      const all = await rt.store.items.listAll()
      const mine = all.filter((it) => (it.foundBy ?? []).some((p) => p.runId === runId))
      body = { ok: true, items: linkByRefs(rank(mine)) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // Coverage probe: which watches cover a given scope, and are they healthy?
  if (url.pathname === '/api/coverage' && req.method === 'GET') {
    let body: CoverageResponse
    try {
      const scope = (url.searchParams.get('scope') ?? '').trim()
      if (!scope) throw new Error('need a scope, e.g. "#novus-px"')
      const norm = scope.toLowerCase()
      const watches = (await rt.store.watches.list())
        .filter((w) => w.scope.toLowerCase() === norm)
        .map((w) => ({
          id: w.id,
          title: w.title,
          scope: w.scope,
          enabled: w.enabled,
          lastRunStatus: w.lastRunStatus,
          lastRunAt: w.lastRunAt,
          cursor: w.cursor,
        }))
      body = { ok: true, scope, watches }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Force-run one watch now (the per-watch Run button). The run appears under
  // Activity; scheduled cadence runs continue on their own.
  if (url.pathname === '/api/watches/run' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const id = url.searchParams.get('id') ?? ''
      const w = await rt.store.watches.get(id)
      if (!w) throw new Error('unknown watch id')
      if (slackConnected(rt) !== true) throw new Error('the claude.ai Slack connector is not connected')
      enqueueWatch(rt, id)
      log('info', 'watch', `run requested: ${w.title}`, { watchId: id, workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Daemon status for the System modal (is it up, ticking, connected?).
  if (url.pathname === '/api/system' && req.method === 'GET') {
    let body: SystemResponse
    try {
      body = { ok: true, status: await systemStatus(rt) }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // The daemon's recent activity log (filterable by level / subsystem / text).
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    const level = url.searchParams.get('level')
    const body: LogsResponse = {
      ok: true,
      entries: recentLogs({
        level: (level as LogLevel) || undefined,
        subsystem: url.searchParams.get('subsystem') || undefined,
        q: url.searchParams.get('q') || undefined,
      }),
      subsystems: logSubsystems(),
    }
    json(200, body)
    return
  }
  // Manual "scan now": force every due (and overdue) watch to run and refresh GitHub.
  if (url.pathname === '/api/scan' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      void reconcileGitHub(rt, true).then(() => {
        rt.inboxCache = null
        void syncInbox(rt)
      })
      void runDueWatches(rt, { force: true })
      log('info', 'scheduler', 'manual scan requested (all watches + GitHub)', { workspace: rt.meta.id })
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  // The ingestion contract (.docs/watches.md): idempotent upsert + resolve,
  // shared by external scanners over HTTP and the MCP shim (server/mcp.ts).
  // User state is never written by upsert; resolve is a normal 'done'.
  if (url.pathname === '/api/items/upsert' && req.method === 'POST') {
    let body: UpsertResponse
    try {
      const outcome = await upsertItemOp(rt, await readJsonBody(req))
      body = { ok: true, outcome }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/items/resolve' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown } | null
      await resolveItemOp(rt, parsed?.id)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  // Manual items — to-dos the user adds by hand. Create/edit/delete; they merge
  // into the inbox like any other source and share the done/snooze overlay.
  if (url.pathname === '/api/items/manual') {
    let body: ManualItemResponse
    let status = 200
    try {
      if (req.method === 'POST') {
        await createManualOp(rt, await readJsonBody(req))
      } else if (req.method === 'PUT') {
        const id = url.searchParams.get('id')
        if (!id) throw new Error('need a manual item id')
        await editManualOp(rt, id, await readJsonBody(req))
      } else if (req.method === 'DELETE') {
        // Never hard-delete (.docs/watches-v2.md): "delete" archives the item,
        // recorded, so it survives in the Archived tab.
        const id = url.searchParams.get('id')
        if (id) {
          await rt.store.items.transition(id, { status: 'archived', actor: 'user', detail: { reason: 'deleted by user' } })
          rt.inboxCache = null
        }
      } else {
        throw new Error('unsupported method')
      }
      body = { ok: true }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : status, body)
    return
  }
  // A user priority override for any item (source or manual). null clears it.
  if (url.pathname === '/api/items/priority' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; priority?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      if (!id) throw new Error('need an item id')
      const raw = parsed?.priority
      let priority: number | null
      if (raw === null || raw === 0 || raw === undefined) priority = null
      else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 4) priority = raw
      else throw new Error('priority must be 1–4, or null/0 to clear')
      await rt.store.items.setPriority(id, priority)
      rt.inboxCache = null
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    json(body.ok ? 200 : 400, body)
    return
  }
  if (url.pathname === '/api/models') {
    let body: ModelsResponse
    try {
      const probe =
        rt.modelCache && url.searchParams.get('refresh') !== '1' ? rt.modelCache : await probeModels(rt)
      body = { ok: true, probedAt: probe.probedAt, models: probe.models }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  if (url.pathname === '/api/connectors') {
    let body: ConnectorsResponse
    try {
      const probe =
        rt.connectorCache && url.searchParams.get('refresh') !== '1'
          ? rt.connectorCache
          : await probeConnectors(rt)
      body = { ok: true, probedAt: probe.probedAt, connectors: probe.connectors }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    json(body.ok ? 200 : 502, body)
    return
  }
  await serveWeb(url.pathname, res)
})

// ---------------------------------------------------------------------------
// WebSocket — each connection binds to one workspace at upgrade time
// (?workspace= param, else the triage_ws cookie, else the default), and only
// ever sees that workspace's sessions and events.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' })

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(rt: WorkspaceRuntime, msg: ServerMessage) {
  const data = JSON.stringify(msg)
  for (const ws of rt.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data)
}

function broadcastSessionList(rt: WorkspaceRuntime) {
  broadcast(rt, { type: 'sessions', sessions: summaries(rt) })
}

function expandHome(p: string): string {
  if (!p) return process.cwd()
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return path.resolve(p)
}

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

const effort = (v: unknown): EffortLevel | undefined =>
  EFFORT_LEVELS.includes(v as EffortLevel) ? (v as EffortLevel) : undefined

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'gated']

/**
 * Unrecognized modes fall through to `undefined`, i.e. ask — a frame the
 * server does not understand must never widen what a session may do.
 */
const permissionMode = (v: unknown): PermissionMode | undefined =>
  PERMISSION_MODES.includes(v as PermissionMode) ? (v as PermissionMode) : undefined

/**
 * AskUserQuestion answers off the socket: a flat string→string map, or nothing.
 * Non-string values are dropped rather than passed through — this object is
 * merged into a tool's input.
 */
const questionAnswers = (v: unknown): QuestionAnswers | undefined => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: QuestionAnswers = {}
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The socket is untrusted input (vision principle 6), so incoming frames are
 * validated into the ClientMessage union rather than cast into it.
 */
function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const model = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  switch (m.type) {
    case 'create_session':
      return {
        type: 'create_session',
        title: str(m.title),
        cwd: str(m.cwd),
        firstMessage: typeof m.firstMessage === 'string' ? m.firstMessage : undefined,
        model: model(m.model),
        effort: effort(m.effort),
        permissionMode: permissionMode(m.permissionMode),
      }
    case 'set_model':
      return typeof m.sessionId === 'string'
        ? { type: 'set_model', sessionId: m.sessionId, model: model(m.model), effort: effort(m.effort) }
        : null
    case 'set_permission_mode': {
      const mode = permissionMode(m.mode)
      return typeof m.sessionId === 'string' && mode
        ? { type: 'set_permission_mode', sessionId: m.sessionId, mode }
        : null
    }
    case 'rename_session':
      return typeof m.sessionId === 'string'
        ? { type: 'rename_session', sessionId: m.sessionId, title: str(m.title) }
        : null
    case 'set_pinned':
      return typeof m.sessionId === 'string'
        ? { type: 'set_pinned', sessionId: m.sessionId, pinned: m.pinned === true }
        : null
    case 'delete_session':
      return typeof m.sessionId === 'string' ? { type: 'delete_session', sessionId: m.sessionId } : null
    case 'subscribe':
      return typeof m.sessionId === 'string' ? { type: 'subscribe', sessionId: m.sessionId } : null
    case 'user_message':
      return typeof m.sessionId === 'string'
        ? { type: 'user_message', sessionId: m.sessionId, text: str(m.text) }
        : null
    case 'permission_response':
      return typeof m.sessionId === 'string' && typeof m.requestId === 'string'
        ? {
            type: 'permission_response',
            sessionId: m.sessionId,
            requestId: m.requestId,
            // Anything unrecognized is a denial: the permissive readings are
            // the ones that have to be spelled out exactly.
            behavior:
              m.behavior === 'allow' ? 'allow' : m.behavior === 'allow_always' ? 'allow_always' : 'deny',
            answers: questionAnswers(m.answers),
          }
        : null
    case 'interrupt':
      return typeof m.sessionId === 'string' ? { type: 'interrupt', sessionId: m.sessionId } : null
    default:
      return null
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/ws', `http://localhost:${PORT}`)
  const rt = resolveRuntime(req, url)
  rt.clients.add(ws)
  send(ws, {
    type: 'hello',
    sessions: summaries(rt),
    workspaceId: rt.meta.id,
    workspaces: wireWorkspaces(),
    onboarded: registry.onboarded,
  })

  ws.on('message', async (raw) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(raw))
    } catch {
      return
    }
    const msg = parseClientMessage(parsed)
    if (!msg) return

    try {
      switch (msg.type) {
        case 'create_session': {
          const cwd = expandHome(msg.cwd)
          const title = msg.title.trim() || `Session ${rt.rows.size + 1}`
          const row = await createSession(
            rt,
            title,
            cwd,
            msg.model ?? null,
            msg.effort ?? null,
            msg.permissionMode ?? null,
          )
          send(ws, { type: 'session_created', session: summarize(rt, row) })
          broadcastSessionList(rt)
          if (msg.firstMessage?.trim()) rt.live.get(row.id)?.sendUserMessage(msg.firstMessage.trim())
          break
        }
        case 'set_model': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          row.model = msg.model ?? null
          row.effort = msg.effort ?? null
          await rt.store.sessions.setModel(row.id, row.model, row.effort)
          // A session with no subprocess picks the choice up from its row when
          // it is revived; a live one is switched in place.
          await rt.live.get(row.id)?.setModel(row.model, row.effort)
          broadcastSessionList(rt)
          break
        }
        case 'set_permission_mode': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          row.permissionMode = msg.mode
          await rt.store.sessions.setPermissionMode(row.id, msg.mode)
          // Same shape as set_model: the row is the source of truth for a
          // revival, and a live subprocess is switched in place where it can
          // be. Where it cannot (arming a bypass needs a spawn-time flag), the
          // subprocess is retired so the next turn brings up one that can.
          const session = rt.live.get(row.id)
          if (session && !(await session.setPermissionMode(msg.mode))) session.stop()
          broadcastSessionList(rt)
          break
        }
        case 'rename_session': {
          const row = rt.rows.get(msg.sessionId)
          const title = msg.title.trim()
          // An empty title would leave a nameless row in the sidebar; the old
          // one stays instead.
          if (!row || !title) break
          row.title = title
          await rt.store.sessions.rename(row.id, title)
          broadcastSessionList(rt)
          break
        }
        case 'set_pinned': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          row.pinned = msg.pinned
          await rt.store.sessions.setPinned(row.id, msg.pinned)
          broadcastSessionList(rt)
          break
        }
        case 'delete_session': {
          if (!rt.rows.has(msg.sessionId)) break
          await deleteSession(rt, msg.sessionId)
          break
        }
        case 'subscribe': {
          if (!rt.rows.has(msg.sessionId)) break
          const events = await rt.store.events.read(msg.sessionId)
          send(ws, { type: 'history', sessionId: msg.sessionId, events: events.map((e) => e.event) })
          break
        }
        case 'user_message': {
          if (!msg.text.trim()) break
          const session = await getOrRevive(rt, msg.sessionId)
          session?.sendUserMessage(msg.text.trim())
          break
        }
        case 'permission_response': {
          rt.live.get(msg.sessionId)?.resolvePermission(msg.requestId, msg.behavior, msg.answers)
          break
        }
        case 'interrupt': {
          void rt.live.get(msg.sessionId)?.interrupt()
          break
        }
      }
    } catch (err) {
      send(ws, { type: 'error', message: String(err) })
    }
  })

  ws.on('close', () => rt.clients.delete(ws))
})

// Boot: one runtime per registered workspace, each with its own store, seeds,
// cached snapshot, and background probes.
for (const meta of registry.workspaces) runtimes.set(meta.id, new WorkspaceRuntime(meta))
for (const rt of runtimes.values()) await initRuntime(rt)

// The wss wraps the http server and re-emits its errors, so the handler has
// to sit on both — an unhandled 'error' on either one crashes with a raw stack.
for (const emitter of [server, wss]) emitter.on('error', onListenError)
function onListenError(err: NodeJS.ErrnoException) {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `triage: port ${PORT} is already in use — \`triage status\` shows whether it's another triage; ` +
        `otherwise pick a port with \`triage --port ${PORT + 1}\``,
    )
    process.exit(1)
  }
  throw err
}
server.listen(PORT, () => {
  log('info', 'server', `triage v${VERSION} started on :${PORT} (${runtimes.size} workspace${runtimes.size === 1 ? '' : 's'}, default: ${registry.defaultId})`)
  // Record where we are so `triage stop/status` can find a --port server.
  writeState({ pid: process.pid, port: PORT, version: VERSION, startedAt: new Date().toISOString() }).catch(
    (err) => console.error('[state] could not write server.json:', err),
  )
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('info', 'server', `received ${sig} — shutting down`)
    clearState(process.pid).finally(() => process.exit(0))
  })
}
