/**
 * The persistence seam ("thin frontends, fat core").
 *
 * One interface per aggregate, expressed in domain types — no SQL, no driver
 * types, no dialect. Everything is async even though the SQLite adapter is
 * synchronous underneath: `pg`/`mysql2` never will be, and retrofitting
 * Promises onto every call site later is the expensive rewrite this seam
 * exists to avoid.
 *
 * Portability rules the adapters must follow:
 * - IDs are generated in app code (UUIDs), never by the database.
 * - Times are integer epoch milliseconds.
 * - Booleans are 0/1 in storage, real booleans out here.
 * - JSON is (de)serialized inside the adapter; domain types carry objects.
 */
import type { InboxSnapshot, Project, SessionEvent } from '../../shared/protocol.js'
import type { WorkItem } from '../work/types.js'
import type { ItemState } from '../work/state.js'
import type { NewWatch, Watch, WatchRunResult } from '../watch/types.js'

export type StoredSession = {
  id: string
  title: string
  cwd: string
  /** Claude Code's own session id — the key for `resume` and the link to its transcript. */
  sdkSessionId: string | null
  createdAt: number
  updatedAt: number
}

export type NewSession = {
  id: string
  title: string
  cwd: string
}

export type StoredEvent = {
  seq: number
  event: SessionEvent
  createdAt: number
}

export interface SessionStore {
  create(s: NewSession): Promise<StoredSession>
  get(id: string): Promise<StoredSession | null>
  /** All sessions, most recently active first. */
  list(): Promise<StoredSession[]>
  setSdkSessionId(id: string, sdkSessionId: string): Promise<void>
  /** Bump updatedAt (a session saw activity). */
  touch(id: string): Promise<void>
}

export interface EventStore {
  /** Append one event; `seq` must be the caller's next per-session sequence number. */
  append(sessionId: string, seq: number, event: SessionEvent): Promise<void>
  /** Events after `afterSeq` (exclusive), in order. Omit for the full log. */
  read(sessionId: string, afterSeq?: number): Promise<StoredEvent[]>
  /** The highest seq for a session, or 0 if none. */
  lastSeq(sessionId: string): Promise<number>
}

export interface InboxStore {
  /** Persist the latest ranked snapshot (replaces the previous one). */
  save(snapshot: InboxSnapshot): Promise<void>
  load(): Promise<InboxSnapshot | null>
}

/** Small typed KV for settings and source caches (JSON values). */
export interface ConfigStore {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
}

export interface ProjectStore {
  list(): Promise<Project[]>
  create(p: Project): Promise<void>
  remove(id: string): Promise<void>
}

export interface WatchStore {
  list(): Promise<Watch[]>
  get(id: string): Promise<Watch | null>
  create(w: Watch): Promise<void>
  /** Edit the user-authored fields (and enabled). Bumps updatedAt. */
  update(id: string, patch: Partial<NewWatch> & { enabled?: boolean }): Promise<void>
  /** What a completed scan writes back: cursor, lastRunAt, cost, matches. */
  recordRun(id: string, run: WatchRunResult): Promise<void>
  remove(id: string): Promise<void>
}

export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged'

/**
 * Ingested work items (watch hits and external-scanner upserts). Unlike the
 * snapshot, these persist: scans are cursor-incremental, so earlier hits are
 * never re-derivable. The idempotent upsert rule lives in the adapter —
 * correctness in the contract, not the prompt.
 */
export interface ItemStore {
  /** id exists → update only if the incoming updatedAt is newer; new → insert. */
  upsert(item: WorkItem): Promise<UpsertOutcome>
  list(): Promise<WorkItem[]>
  /** Drop items whose source updatedAt is older than `cutoff` (epoch ms). */
  prune(cutoff: number): Promise<void>
  removeByWatch(watchId: string): Promise<void>
}

/** User-state overlay — the user's, never written by ingestion. */
export interface ItemStateStore {
  all(): Promise<Map<string, ItemState>>
  set(state: ItemState): Promise<void>
  /** The re-arm rule's write-back: these items are open again. */
  reopen(itemIds: string[], now: number): Promise<void>
}

export interface Store {
  sessions: SessionStore
  events: EventStore
  inbox: InboxStore
  config: ConfigStore
  projects: ProjectStore
  watches: WatchStore
  items: ItemStore
  itemState: ItemStateStore
  close(): Promise<void>
}
