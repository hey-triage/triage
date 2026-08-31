#!/usr/bin/env node
/**
 * triage-dev POC server
 *
 * Serves the web UI on :5178 and drives the locally installed Claude Code
 * via @anthropic-ai/claude-agent-sdk (subscription auth — no API key).
 *
 * Sessions are persisted to SQLite (core/store): the row + an append-only
 * event log (the same events the UI renders; stream deltas excluded). The
 * Claude subprocess itself is ephemeral — a session with no live subprocess
 * is revived on the next user message via the SDK's `resume`, keyed by the
 * sdk_session_id captured from the init message. The agent's own memory of
 * the conversation lives in ~/.claude's transcript, not here; our event log
 * is for rendering, never for re-feeding the model.
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
} from '../shared/protocol.js'
import type {
  InboxResponse,
  InboxSnapshot,
  ItemStateResponse,
  ManualItemInput,
  ManualItemResponse,
  Project,
  ProjectsResponse,
  ReposResponse,
  UpsertResponse,
  WatchDraftResponse,
  WatchPreviewResponse,
  WatchesResponse,
  WorkItem,
} from '../shared/protocol.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store, StoredSession, UpsertOutcome } from '../core/store/types.js'
import { refreshInbox } from '../core/work/inbox.js'
import { BASE } from '../core/work/score.js'
import { canonicalizeRefs } from '../core/work/link.js'
import type { ItemStatus } from '../core/work/state.js'
import { listAffiliatedRepos } from '../core/sources/github.js'
import { draftWatch, previewWatch, runSlackScan, type WatchScanSpec } from '../core/sources/slack.js'
import { isDue } from '../core/watch/schedule.js'
import type { NewWatch, Watch, WatchCadence } from '../core/watch/types.js'
import { clearState, pkgVersion, writeState } from './state.js'

const PORT = Number(process.env.PORT || 5178)
const VERSION = pkgVersion()
const DB_FILE = process.env.TRIAGE_DB || path.join(os.homedir(), '.triage', 'triage-dev.db')
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
        // Claude Code sessions get (server/mcp.ts).
        mcpServers: { triage: triageMcp },
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
            void store.sessions.setSdkSessionId(this.row.id, m.session_id)
          }
          this.setStatus('idle')
        }
        if (m.type === 'assistant' || m.type === 'user') this.setStatus('running')
        // stream deltas are broadcast live but not persisted (recoverable
        // from the committed assistant message, and the only high-volume thing)
        this.emit({ kind: 'sdk', message: m }, m.type !== 'stream_event')
        if (m.type === 'result') {
          this.setStatus('idle')
          void store.sessions.touch(this.row.id)
          void refreshBranch(this.row)
        }
      }
      this.setStatus('idle')
    } catch (err) {
      this.emit({ kind: 'error', message: String(err) }, true)
      this.setStatus('error')
    } finally {
      // The subprocess is gone; any unanswered prompt can never be answered.
      this.expirePendingPermissions()
      live.delete(this.row.id)
      broadcastSessionList()
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
    void store.sessions.touch(this.row.id)
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
    broadcastSessionList()
  }

  private emit(event: SessionEvent, persist: boolean) {
    if (persist) {
      this.seq += 1
      store.events.append(this.row.id, this.seq, event).catch((err) => {
        console.error(`[store] failed to persist event for ${this.row.id}:`, err)
      })
    }
    broadcast({ type: 'session_event', sessionId: this.row.id, event })
  }
}

// ---------------------------------------------------------------------------
// Session registry: every session lives in the store; a subset is live.
// ---------------------------------------------------------------------------
const store: Store = openSqliteStore(DB_FILE)
const rows = new Map<string, StoredSession>()
const live = new Map<string, LiveSession>()
const branches = new Map<string, string>() // session id → git branch (derived)

function summarize(row: StoredSession): SessionSummary {
  const l = live.get(row.id)
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
    branch: branches.get(row.id),
  }
}

/** Sorted like the store: pinned first, then most recently active. */
function summaries(): SessionSummary[] {
  return [...rows.values()]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    .map(summarize)
}

/**
 * Delete a session for good: its subprocess, its in-memory state, and its
 * whole log. The subprocess is stopped first so nothing is still writing to a
 * row that is about to go.
 */
async function deleteSession(sessionId: string): Promise<void> {
  live.get(sessionId)?.stop()
  live.delete(sessionId)
  rows.delete(sessionId)
  branches.delete(sessionId)
  await store.sessions.remove(sessionId)
  broadcast({ type: 'session_deleted', sessionId })
  broadcastSessionList()
}

async function refreshBranch(row: StoredSession) {
  try {
    const { stdout } = await pExecFile('git', ['-C', row.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = stdout.trim()
    if (branch && branches.get(row.id) !== branch) {
      branches.set(row.id, branch)
      broadcastSessionList()
    }
  } catch {
    // not a git repo — no chip
  }
}

async function createSession(
  title: string,
  cwd: string,
  model: string | null,
  effort: EffortLevel | null,
  permissionMode: PermissionMode | null,
): Promise<StoredSession> {
  const row = await store.sessions.create({
    id: randomUUID(),
    title,
    cwd,
    model,
    effort,
    permissionMode,
  })
  rows.set(row.id, row)
  live.set(row.id, new LiveSession(row, 0, null))
  void refreshBranch(row)
  return row
}

/** The live subprocess for a session, starting one (with `resume`) if needed. */
async function getOrRevive(sessionId: string): Promise<LiveSession | null> {
  const existing = live.get(sessionId)
  if (existing) return existing
  const row = rows.get(sessionId)
  if (!row) return null
  const lastSeq = await store.events.lastSeq(row.id)
  const revived = new LiveSession(row, lastSeq, row.sdkSessionId)
  live.set(row.id, revived)
  broadcastSessionList()
  return revived
}

/**
 * Boot: load stored sessions, and expire permission prompts orphaned by the
 * previous process (their subprocess died with it — Allow can never apply).
 */
async function loadSessions() {
  for (const row of await store.sessions.list()) {
    rows.set(row.id, row)
    void refreshBranch(row)

    const events = await store.events.read(row.id)
    const unresolved = new Map<string, true>()
    for (const e of events) {
      if (e.event.kind === 'permission_request') unresolved.set(e.event.id, true)
      if (e.event.kind === 'permission_resolved') unresolved.delete(e.event.id)
    }
    let seq = events.length ? events[events.length - 1].seq : 0
    for (const id of unresolved.keys()) {
      seq += 1
      await store.events.append(row.id, seq, { kind: 'permission_resolved', id, behavior: 'expired' })
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
const SLACK_TTL_MS = 30 * 60_000
const SCHEDULER_TICK_MS = 60_000
const INGESTED_RETENTION_MS = 30 * 86_400_000

const REPOS_KEY = 'github.repos'
const SLACK_CACHE_KEY = 'slack.cache'

type SlackCache = { scannedAt: number; items: WorkItem[] }

let inboxCache: InboxSnapshot | null = null
let inboxInFlight: Promise<InboxSnapshot> | null = null
let slackScanInFlight: Promise<void> | null = null

async function connectedRepos(): Promise<string[]> {
  return (await store.config.get<string[]>(REPOS_KEY)) ?? []
}

/** Is the claude.ai Slack connector connected, per the last connector probe? */
function slackConnected(): boolean | null {
  if (!connectorCache) return null // no probe yet
  return connectorCache.connectors.some(
    (c) => c.source === 'claude.ai' && c.name === 'Slack' && c.status === 'connected',
  )
}

/**
 * Slack items for a sync: the cached scan, always (stale beats blocking — a
 * scan is a whole Claude session). Scanning itself is the scheduler's job;
 * this only reports how stale the cache is.
 */
async function getSlackForSync(): Promise<{ items: WorkItem[]; notice?: string }> {
  const connected = slackConnected()
  if (connected === false) return { items: [] }
  if (connected === null) return { items: [], notice: 'slack: waiting for connector probe — refresh shortly' }

  const cache = await store.config.get<SlackCache>(SLACK_CACHE_KEY)
  if (cache && Date.now() - cache.scannedAt < SLACK_TTL_MS) return { items: cache.items }
  void runDueScans()
  if (cache) {
    const mins = Math.round((Date.now() - cache.scannedAt) / 60_000)
    return { items: cache.items, notice: `slack: showing scan from ${mins}m ago — rescanning in background` }
  }
  return { items: [], notice: 'slack: scanning in background (takes a minute) — refresh shortly' }
}

/**
 * The due-checker (.docs/watches.md): no cron, no fire-time queue. Each tick
 * asks "what is due?" — built-in Slack rules (cache older than its TTL) and
 * enabled watches per their cadence — and runs ONE composed scan for the lot.
 * Missed runs are simply due on the first tick after wake, once; scans are
 * cursor-based, so the coalesced run covers the whole gap losslessly.
 */
async function runDueScans(): Promise<void> {
  if (slackScanInFlight) return slackScanInFlight
  if (slackConnected() !== true) return
  const now = new Date()
  const watches = await store.watches.list()
  const due = watches.filter((w) => isDue(w, now))
  const cache = await store.config.get<SlackCache>(SLACK_CACHE_KEY)
  const builtins = !cache || Date.now() - cache.scannedAt >= SLACK_TTL_MS
  if (!builtins && due.length === 0) return

  slackScanInFlight = (async () => {
    try {
      const specs: WatchScanSpec[] = due.map((w) => ({
        id: w.id,
        scope: w.scope,
        instruction: w.instruction,
        cursor: w.cursor,
        createsItems: w.createsItems,
      }))
      const outcome = await runSlackScan({ builtins, watches: specs })
      if (builtins) {
        await store.config.set(SLACK_CACHE_KEY, {
          scannedAt: Date.now(),
          items: outcome.builtinItems,
        } satisfies SlackCache)
      }
      // Idempotent upsert: id-keyed, update-only-if-newer, state-preserving.
      for (const item of outcome.watchItems) await store.items.upsert(item)
      for (const w of due) {
        await store.watches.recordRun(w.id, {
          cursor: outcome.startedAt, // the scan covered everything before it started
          lastRunAt: Date.now(),
          lastRunTokens: outcome.tokens,
          lastRunMatches: outcome.matchesByWatch.get(w.id) ?? 0,
        })
      }
      await store.items.prune(Date.now() - INGESTED_RETENTION_MS)
      inboxCache = null // next view rebuilds the snapshot with the fresh scan
      await syncInbox()
    } catch (err) {
      console.error('[slack] scan failed:', err)
    } finally {
      slackScanInFlight = null
    }
  })()
  return slackScanInFlight
}

setInterval(() => {
  runDueScans().catch((err) => console.error('[watches] tick failed:', err))
}, SCHEDULER_TICK_MS).unref()

function syncInbox(): Promise<InboxSnapshot> {
  if (inboxInFlight) return inboxInFlight
  inboxInFlight = (async () => {
    try {
      const [repos, slack, ingested, manual, states] = await Promise.all([
        connectedRepos(),
        getSlackForSync(),
        store.items.list(),
        store.manual.list(),
        store.itemState.all(),
      ])
      const { items, notices, rearmed } = await refreshInbox({ repos, slack, ingested, manual, states })
      if (rearmed.length > 0) await store.itemState.reopen(rearmed, Date.now())
      inboxCache = { syncedAt: Date.now(), items, notices }
      void store.inbox.save(inboxCache)
      return inboxCache
    } finally {
      inboxInFlight = null
    }
  })()
  return inboxInFlight
}

// The repo picker's "available" list; slow-ish (paginated), so cached.
let affiliatedCache: { at: number; repos: string[] } | null = null
async function affiliatedRepos(): Promise<string[]> {
  if (affiliatedCache && Date.now() - affiliatedCache.at < 10 * 60_000) return affiliatedCache.repos
  const repos = await listAffiliatedRepos()
  affiliatedCache = { at: Date.now(), repos }
  return repos
}

async function getInbox(force: boolean): Promise<InboxSnapshot> {
  if (!force && inboxCache && Date.now() - inboxCache.syncedAt < INBOX_TTL_MS) return inboxCache
  return syncInbox()
}

// Keep the cache warm while the server runs, so page loads are instant. A
// failed background sync keeps the previous snapshot; the next view retries.
setInterval(() => {
  syncInbox().catch((err) => console.error('[inbox] background sync failed:', err))
}, INBOX_KEEP_WARM_MS).unref()

// ---------------------------------------------------------------------------
// Connectors: what a session will actually load, learned the honest way — by
// spawning a throwaway query with the SAME options real sessions use and
// asking it via the mcpServerStatus() control request (no user message, no
// API turn). `claude mcp list` has no machine output, and the config files
// under ~/.claude are private formats; this is the SDK's own structured
// answer to "which servers connected".
// ---------------------------------------------------------------------------
type ConnectorProbe = { probedAt: number; connectors: Connector[] }

let connectorCache: ConnectorProbe | null = null
let connectorInFlight: Promise<ConnectorProbe> | null = null

const CLAUDE_AI_PREFIX = 'claude.ai '

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

function probeConnectors(): Promise<ConnectorProbe> {
  // Concurrent requests share one probe — a probe is a whole subprocess.
  if (connectorInFlight) return connectorInFlight
  connectorInFlight = (async () => {
    const input = new AsyncQueue<SDKUserMessage>()
    const q = query({
      prompt: input,
      options: {
        cwd: os.homedir(), // user-level view; no project .mcp.json in the way
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
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
      connectorCache = { probedAt: Date.now(), connectors }
      return connectorCache
    } finally {
      input.close()
      void q.return(undefined).catch(() => {}) // dispose the subprocess
      connectorInFlight = null
    }
  })()
  return connectorInFlight
}

// ---------------------------------------------------------------------------
// Models: which models this machine's Claude Code will actually run. Asked of
// the SDK (supportedModels()) rather than hardcoded — the catalog moves, and
// an org policy can shrink it. Same throwaway-subprocess shape as the
// connector probe, and the answer is stable enough to cache for the process.
// ---------------------------------------------------------------------------
type ModelProbe = { probedAt: number; models: ModelOption[] }

let modelCache: ModelProbe | null = null
let modelInFlight: Promise<ModelProbe> | null = null

function probeModels(): Promise<ModelProbe> {
  if (modelInFlight) return modelInFlight
  modelInFlight = (async () => {
    const input = new AsyncQueue<SDKUserMessage>()
    const q = query({
      prompt: input,
      options: {
        cwd: os.homedir(),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
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
      modelCache = { probedAt: Date.now(), models }
      return modelCache
    } finally {
      input.close()
      void q.return(undefined).catch(() => {}) // dispose the subprocess
      modelInFlight = null
    }
  })()
  return modelInFlight
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

// ---------------------------------------------------------------------------
// Input validation — the HTTP surface is untrusted (vision principle 6):
// bodies are validated into domain shapes, and rejected rather than repaired.
// ---------------------------------------------------------------------------

const CADENCES = new Set<WatchCadence>(['hourly', 'daily', 'weekly'])
const ITEM_STATUSES = new Set<ItemStatus>(['open', 'done', 'snoozed', 'dismissed'])
const VALID_KINDS = new Set(Object.keys(BASE))
const VALID_SOURCES = new Set(['github', 'slack', 'linear'])
const ITEM_ID_RE = /^(github|slack|linear):\S+$/

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
async function manualItemFrom(raw: unknown): Promise<ManualItemInput>
async function manualItemFrom(raw: unknown, opts: { partial: true }): Promise<Partial<ManualItemInput>>
async function manualItemFrom(raw: unknown, opts: { partial?: boolean } = {}): Promise<Partial<ManualItemInput>> {
  if (typeof raw !== 'object' || raw === null) throw new Error('body must be a JSON object')
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  if (!title && !opts.partial) throw new Error('a work item needs a title')
  const input: Partial<ManualItemInput> = {}
  if (title) input.title = title
  if (typeof r.projectId === 'string' && r.projectId) {
    const projects = await store.projects.list()
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
// in-process MCP server that web chats get (triageMcp), and the stdio shim
// (server/mcp.ts) which reaches them over HTTP. Every transport funnels through
// these functions, so list/create/edit/upsert/resolve behave identically no
// matter who calls them. Validation stays in workItemFrom/manualItemFrom — the
// single source of truth, never duplicated per transport.
// ---------------------------------------------------------------------------
async function listItemsOp(filter: { source?: string; kind?: string } = {}): Promise<InboxSnapshot['items']> {
  const snap = await getInbox(false)
  let items = snap.items
  if (filter.source) items = items.filter((i) => i.source === filter.source)
  if (filter.kind) items = items.filter((i) => i.kind === filter.kind)
  return items
}

async function upsertItemOp(raw: unknown): Promise<UpsertOutcome> {
  const parsed = workItemFrom(raw)
  if ('error' in parsed) throw new Error(parsed.error)
  const outcome = await store.items.upsert(parsed.item)
  if (outcome !== 'unchanged') inboxCache = null
  return outcome
}

async function resolveItemOp(rawId: unknown): Promise<void> {
  const id = typeof rawId === 'string' ? rawId : ''
  if (!ITEM_ID_RE.test(id)) throw new Error('need a work-item id')
  await store.itemState.set({ itemId: id, status: 'done', statusAt: Date.now(), pinned: false })
  inboxCache = null
}

async function createManualOp(raw: unknown): Promise<string> {
  const input = await manualItemFrom(raw)
  const id = `manual:${randomUUID()}`
  await store.manual.create({ id, ...input })
  inboxCache = null
  return id
}

// Edits target manual (user-authored) items only. Ingested items are
// upsert-newer-wins, so a free-form edit would be clobbered by the next scan —
// reject those with a clear message rather than silently no-op'ing.
async function editManualOp(id: string, raw: unknown): Promise<void> {
  if (!id || !id.startsWith('manual:'))
    throw new Error('edit_work_item only edits manual items (id must start with "manual:")')
  const patch = await manualItemFrom(raw, { partial: true })
  await store.manual.update(id, patch)
  inboxCache = null
}

// The same tool surface every session gets in-process, matching the stdio
// shim's names/schemas one-for-one (server/mcp.ts) so a web chat and a local
// Claude Code session drive the inbox identically. Handlers call the ops above
// directly — no HTTP round-trip. Reads are auto-allowed in requestPermission;
// writes surface a permission prompt in the web UI.
const okResult = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const errResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

const triageMcp = createSdkMcpServer({
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
          const items = await listItemsOp({ source: args.source, kind: args.kind })
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
          const id = await createManualOp(args)
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
          await editManualOp(id, patch)
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
          const outcome = await upsertItemOp(args)
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
          await resolveItemOp(args.id)
          return okResult('ok: done')
        } catch (err) {
          return errResult(err instanceof Error ? err.message : String(err))
        }
      },
    ),
  ],
})

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
  if (url.pathname === '/api/health') {
    // The CLI's "is triage running" probe — see server/state.ts.
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        app: 'triage',
        version: VERSION,
        pid: process.pid,
        port: PORT,
        db: DB_FILE,
        liveSessions: live.size,
      }),
    )
    return
  }
  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(summaries()))
    return
  }
  if (url.pathname === '/api/inbox') {
    let body: InboxResponse
    try {
      const snap = await getInbox(url.searchParams.get('refresh') === '1')
      body = { ok: true, ...snap }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    res.writeHead(body.ok ? 200 : 502, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
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
        await store.config.set(REPOS_KEY, repos)
        inboxCache = null // scope changed — force a resync on the next view
      }
      body = { ok: true, connected: await connectedRepos(), available: await affiliatedRepos() }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    res.writeHead(body.ok ? 200 : 502, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
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
        await store.projects.create({ id: randomUUID(), name, repo, path: resolved })
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (id) await store.projects.remove(id)
      }
      body = { ok: true, projects: await store.projects.list() }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
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
        if (!p.title || !p.scope || !p.instruction || !p.cadence) {
          throw new Error('a watch needs title, scope, instruction, and cadence')
        }
        const now = Date.now()
        await store.watches.create({
          id: randomUUID(),
          source: 'slack',
          title: p.title,
          scope: p.scope,
          instruction: p.instruction,
          cadence: p.cadence,
          windowStart: p.windowStart,
          windowDay: p.windowDay,
          enabled: p.enabled ?? true,
          createsItems: p.createsItems ?? true,
          createdAt: now,
          updatedAt: now,
        })
        // active on the next scheduler tick (never run → due immediately)
      } else if (req.method === 'PUT') {
        const id = url.searchParams.get('id')
        if (!id || !(await store.watches.get(id))) throw new Error('unknown watch id')
        const parsed = watchPatchFrom(await readJsonBody(req))
        if ('error' in parsed) throw new Error(parsed.error)
        await store.watches.update(id, parsed.patch)
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (id) {
          await store.watches.remove(id)
          await store.items.removeByWatch(id)
          inboxCache = null
        }
      }
      body = { ok: true, watches: await store.watches.list() }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/watches/draft' && req.method === 'POST') {
    let body: WatchDraftResponse
    try {
      const parsed = (await readJsonBody(req)) as { text?: unknown } | null
      const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
      if (!text) throw new Error('describe the watch in plain text first')
      const draft = await draftWatch(text)
      if (!draft) throw new Error('could not parse that into a watch — fill the form manually')
      body = { ok: true, draft }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : 502, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/watches/preview' && req.method === 'POST') {
    let body: WatchPreviewResponse
    try {
      const parsed = watchPatchFrom(await readJsonBody(req))
      if ('error' in parsed) throw new Error(parsed.error)
      const { scope, instruction } = parsed.patch
      if (!scope || !instruction) throw new Error('a preview needs scope and instruction')
      if (slackConnected() === false) throw new Error('the claude.ai Slack connector is not connected')
      const { rows, tokens } = await previewWatch(scope, instruction)
      body = { ok: true, rows, tokens }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : 502, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/items/state' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown; status?: unknown; snoozeUntil?: unknown } | null
      const id = typeof parsed?.id === 'string' ? parsed.id : ''
      const statusV = parsed?.status as ItemStatus
      if (!id || !ITEM_STATUSES.has(statusV)) throw new Error('need an item id and a status (open|done|snoozed|dismissed)')
      const snoozeUntil = typeof parsed?.snoozeUntil === 'number' ? parsed.snoozeUntil : undefined
      if (statusV === 'snoozed' && !snoozeUntil) throw new Error('snoozed needs snoozeUntil (epoch ms)')
      await store.itemState.set({ itemId: id, status: statusV, statusAt: Date.now(), snoozeUntil, pinned: false })
      inboxCache = null // the overlay changed — next view recomputes
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : 400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  // The ingestion contract (.docs/watches.md): idempotent upsert + resolve,
  // shared by external scanners over HTTP and the MCP shim (server/mcp.ts).
  // User state is never written by upsert; resolve is a normal 'done'.
  if (url.pathname === '/api/items/upsert' && req.method === 'POST') {
    let body: UpsertResponse
    try {
      const outcome = await upsertItemOp(await readJsonBody(req))
      body = { ok: true, outcome }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : 400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/items/resolve' && req.method === 'POST') {
    let body: ItemStateResponse
    try {
      const parsed = (await readJsonBody(req)) as { id?: unknown } | null
      await resolveItemOp(parsed?.id)
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : 400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  // Manual items — to-dos the user adds by hand. Create/edit/delete; they merge
  // into the inbox like any other source and share the done/snooze overlay.
  if (url.pathname === '/api/items/manual') {
    let body: ManualItemResponse
    let status = 200
    try {
      if (req.method === 'POST') {
        await createManualOp(await readJsonBody(req))
      } else if (req.method === 'PUT') {
        const id = url.searchParams.get('id')
        if (!id) throw new Error('need a manual item id')
        await editManualOp(id, await readJsonBody(req))
      } else if (req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (id) {
          await store.manual.remove(id)
          inboxCache = null
        }
      } else {
        throw new Error('unsupported method')
      }
      body = { ok: true }
    } catch (err) {
      status = 400
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
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
      await store.itemState.setPriority(id, priority)
      inboxCache = null
      body = { ok: true }
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    res.writeHead(body.ok ? 200 : 400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/models') {
    let body: ModelsResponse
    try {
      const probe =
        modelCache && url.searchParams.get('refresh') !== '1' ? modelCache : await probeModels()
      body = { ok: true, probedAt: probe.probedAt, models: probe.models }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    res.writeHead(body.ok ? 200 : 502, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/api/connectors') {
    let body: ConnectorsResponse
    try {
      const probe =
        connectorCache && url.searchParams.get('refresh') !== '1'
          ? connectorCache
          : await probeConnectors()
      body = { ok: true, probedAt: probe.probedAt, connectors: probe.connectors }
    } catch (err) {
      body = { ok: false, error: String(err) }
    }
    res.writeHead(body.ok ? 200 : 502, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  await serveWeb(url.pathname, res)
})

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' })
const clients = new Set<WebSocket>()

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg)
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data)
}

function broadcastSessionList() {
  broadcast({ type: 'sessions', sessions: summaries() })
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

wss.on('connection', (ws) => {
  clients.add(ws)
  send(ws, { type: 'hello', sessions: summaries() })

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
          const title = msg.title.trim() || `Session ${rows.size + 1}`
          const row = await createSession(
            title,
            cwd,
            msg.model ?? null,
            msg.effort ?? null,
            msg.permissionMode ?? null,
          )
          send(ws, { type: 'session_created', session: summarize(row) })
          broadcastSessionList()
          if (msg.firstMessage?.trim()) live.get(row.id)?.sendUserMessage(msg.firstMessage.trim())
          break
        }
        case 'set_model': {
          const row = rows.get(msg.sessionId)
          if (!row) break
          row.model = msg.model ?? null
          row.effort = msg.effort ?? null
          await store.sessions.setModel(row.id, row.model, row.effort)
          // A session with no subprocess picks the choice up from its row when
          // it is revived; a live one is switched in place.
          await live.get(row.id)?.setModel(row.model, row.effort)
          broadcastSessionList()
          break
        }
        case 'set_permission_mode': {
          const row = rows.get(msg.sessionId)
          if (!row) break
          row.permissionMode = msg.mode
          await store.sessions.setPermissionMode(row.id, msg.mode)
          // Same shape as set_model: the row is the source of truth for a
          // revival, and a live subprocess is switched in place where it can
          // be. Where it cannot (arming a bypass needs a spawn-time flag), the
          // subprocess is retired so the next turn brings up one that can.
          const session = live.get(row.id)
          if (session && !(await session.setPermissionMode(msg.mode))) session.stop()
          broadcastSessionList()
          break
        }
        case 'rename_session': {
          const row = rows.get(msg.sessionId)
          const title = msg.title.trim()
          // An empty title would leave a nameless row in the sidebar; the old
          // one stays instead.
          if (!row || !title) break
          row.title = title
          await store.sessions.rename(row.id, title)
          broadcastSessionList()
          break
        }
        case 'set_pinned': {
          const row = rows.get(msg.sessionId)
          if (!row) break
          row.pinned = msg.pinned
          await store.sessions.setPinned(row.id, msg.pinned)
          broadcastSessionList()
          break
        }
        case 'delete_session': {
          if (!rows.has(msg.sessionId)) break
          await deleteSession(msg.sessionId)
          break
        }
        case 'subscribe': {
          if (!rows.has(msg.sessionId)) break
          const events = await store.events.read(msg.sessionId)
          send(ws, { type: 'history', sessionId: msg.sessionId, events: events.map((e) => e.event) })
          break
        }
        case 'user_message': {
          if (!msg.text.trim()) break
          const session = await getOrRevive(msg.sessionId)
          session?.sendUserMessage(msg.text.trim())
          break
        }
        case 'permission_response': {
          live.get(msg.sessionId)?.resolvePermission(msg.requestId, msg.behavior, msg.answers)
          break
        }
        case 'interrupt': {
          void live.get(msg.sessionId)?.interrupt()
          break
        }
      }
    } catch (err) {
      send(ws, { type: 'error', message: String(err) })
    }
  })

  ws.on('close', () => clients.delete(ws))
})

await loadSessions()
inboxCache = await store.inbox.load() // last snapshot, so first paint is instant
// Probe connectors in the background at startup: the Slack source gates on the
// result, and the Connectors page becomes instant.
probeConnectors().catch((err) => console.error('[connectors] startup probe failed:', err))
// Same idea for the model list: the composer's picker should be populated by
// the time anyone opens it.
probeModels().catch((err) => console.error('[models] startup probe failed:', err))
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
  console.log(`triage-dev server → http://localhost:${PORT}  (db: ${DB_FILE})`)
  // Record where we are so `triage stop/status` can find a --port server.
  writeState({ pid: process.pid, port: PORT, version: VERSION, startedAt: new Date().toISOString() }).catch(
    (err) => console.error('[state] could not write server.json:', err),
  )
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    clearState(process.pid).finally(() => process.exit(0))
  })
}
