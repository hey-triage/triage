/**
 * SQLite adapter for the Store interface, on node:sqlite (stdlib — keeps the
 * global install dependency-free; vision principle 5).
 *
 * Single-writer by design: SQLite has one writer and this process is it.
 * Nothing here may leak into the interface — a Postgres adapter for the hosted
 * version implements core/store/types.ts, not this file.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { InboxSnapshot, Project, SessionEvent } from '../../shared/protocol.js'
import type { WorkItem } from '../work/types.js'
import type { ItemState, ItemStatus } from '../work/state.js'
import type { EffortLevel, PermissionMode } from '../../shared/protocol.js'
import type { NewWatch, Watch, WatchCadence, WatchRunResult } from '../watch/types.js'
import type {
  ConfigStore,
  ProjectStore,
  EventStore,
  InboxStore,
  ItemStateStore,
  ItemStore,
  ManualItemStore,
  NewManualItem,
  NewSession,
  SessionStore,
  Store,
  StoredEvent,
  StoredSession,
  UpsertOutcome,
  WatchStore,
} from './types.js'

// Numbered, append-only. A new migration is a new entry — never edit an old one.
const MIGRATIONS: string[] = [
  `CREATE TABLE sessions (
     id             TEXT PRIMARY KEY,
     title          TEXT NOT NULL,
     cwd            TEXT NOT NULL,
     sdk_session_id TEXT,
     created_at     INTEGER NOT NULL,
     updated_at     INTEGER NOT NULL
   );
   CREATE TABLE session_events (
     session_id TEXT NOT NULL REFERENCES sessions(id),
     seq        INTEGER NOT NULL,
     kind       TEXT NOT NULL,
     payload    TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (session_id, seq)
   );
   CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);`,
  // 2: the inbox snapshot — one row holding the latest ranked result, so the
  // page renders instantly on load and across server restarts.
  `CREATE TABLE inbox_snapshot (
     id        INTEGER PRIMARY KEY CHECK (id = 1),
     synced_at INTEGER NOT NULL,
     payload   TEXT NOT NULL
   );`,
  // 3: settings + source caches, as a small JSON KV.
  `CREATE TABLE config (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // 4: projects — a named local folder, optionally tied to a GitHub repo.
  `CREATE TABLE projects (
     id         TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     repo       TEXT NOT NULL DEFAULT '',
     path       TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  // 5: the watches engine (.docs/watches.md) — user-defined watches, the
  // persistent ingested items they (and external scanners) produce, and the
  // user-state overlay that survives every snapshot rebuild.
  `CREATE TABLE watches (
     id               TEXT PRIMARY KEY,
     source           TEXT NOT NULL,
     title            TEXT NOT NULL,
     scope            TEXT NOT NULL,
     instruction      TEXT NOT NULL,
     cadence          TEXT NOT NULL,
     window_start     TEXT,
     window_day       INTEGER,
     enabled          INTEGER NOT NULL DEFAULT 1,
     creates_items    INTEGER NOT NULL DEFAULT 1,
     cursor           TEXT,
     last_run_at      INTEGER,
     last_run_tokens  INTEGER,
     last_run_matches INTEGER,
     created_at       INTEGER NOT NULL,
     updated_at       INTEGER NOT NULL
   );
   CREATE TABLE ingested_items (
     id         TEXT PRIMARY KEY,
     updated_at INTEGER NOT NULL,
     payload    TEXT NOT NULL
   );
   CREATE TABLE item_state (
     item_id      TEXT PRIMARY KEY,
     status       TEXT NOT NULL,
     status_at    INTEGER NOT NULL,
     snooze_until INTEGER,
     pinned       INTEGER NOT NULL DEFAULT 0
   );`,
  // 6: the model a session runs on. NULL = Claude Code's own default, which
  // is not the same as any named model — an org can move it under us.
  `ALTER TABLE sessions ADD COLUMN model TEXT;
   ALTER TABLE sessions ADD COLUMN effort TEXT;`,
  // 7: how much a session asks before acting. NULL = 'default' (ask every
  // time), which is what every session predating this column was doing.
  `ALTER TABLE sessions ADD COLUMN permission_mode TEXT;`,
  // 8: pinned sessions — they sort above the rest, regardless of activity.
  `ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`,
  // 9: user priority overrides (any item, survives re-sync) + manual items —
  // to-dos the user adds by hand, in their own editable table.
  `ALTER TABLE item_state ADD COLUMN priority INTEGER;
   CREATE TABLE manual_items (
     id         TEXT PRIMARY KEY,
     title      TEXT NOT NULL,
     project_id TEXT,
     note       TEXT,
     url        TEXT,
     priority   INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
]

export function openSqliteStore(file: string): Store {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)

  return {
    sessions: new SqliteSessions(db),
    events: new SqliteEvents(db),
    inbox: new SqliteInbox(db),
    config: new SqliteConfig(db),
    projects: new SqliteProjects(db),
    watches: new SqliteWatches(db),
    items: new SqliteItems(db),
    itemState: new SqliteItemState(db),
    manual: new SqliteManualItems(db),
    close: async () => db.close(),
  }
}

function migrate(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v + 1, Date.now())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

type SessionRow = {
  id: string
  title: string
  cwd: string
  sdk_session_id: string | null
  model: string | null
  effort: string | null
  permission_mode: string | null
  pinned: number
  created_at: number
  updated_at: number
}

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'gated']

/** Storage is text; anything the app no longer recognizes reads back as null. */
const toEffort = (v: string | null): EffortLevel | null =>
  EFFORTS.includes(v as EffortLevel) ? (v as EffortLevel) : null

/**
 * Same rule, and it matters more here: a mode we stop recognizing must fall
 * back to asking, never to a permissive mode inferred from a stale string.
 */
const toPermissionMode = (v: string | null): PermissionMode | null =>
  PERMISSION_MODES.includes(v as PermissionMode) ? (v as PermissionMode) : null

const toSession = (r: SessionRow): StoredSession => ({
  id: r.id,
  title: r.title,
  cwd: r.cwd,
  sdkSessionId: r.sdk_session_id,
  model: r.model,
  effort: toEffort(r.effort),
  permissionMode: toPermissionMode(r.permission_mode),
  pinned: r.pinned === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

class SqliteSessions implements SessionStore {
  constructor(private db: DatabaseSync) {}

  async create(s: NewSession): Promise<StoredSession> {
    const now = Date.now()
    const model = s.model ?? null
    const effort = s.effort ?? null
    const permissionMode = s.permissionMode ?? null
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, cwd, sdk_session_id, model, effort, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.title, s.cwd, model, effort, permissionMode, now, now)
    return {
      ...s,
      model,
      effort,
      permissionMode,
      pinned: false,
      sdkSessionId: null,
      createdAt: now,
      updatedAt: now,
    }
  }

  async get(id: string): Promise<StoredSession | null> {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return r ? toSession(r) : null
  }

  async list(): Promise<StoredSession[]> {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC')
      .all() as SessionRow[]
    return rows.map(toSession)
  }

  async setSdkSessionId(id: string, sdkSessionId: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id)
  }

  async setModel(id: string, model: string | null, effort: EffortLevel | null): Promise<void> {
    this.db.prepare('UPDATE sessions SET model = ?, effort = ? WHERE id = ?').run(model, effort, id)
  }

  async setPermissionMode(id: string, mode: PermissionMode | null): Promise<void> {
    this.db.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run(mode, id)
  }

  async rename(id: string, title: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id)
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    this.db.prepare('UPDATE sessions SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
  }

  /**
   * Delete a session and its log. The event rows reference the session, so
   * they go first — with foreign keys on, the other order fails.
   */
  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM session_events WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  async touch(id: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }
}

class SqliteEvents implements EventStore {
  constructor(private db: DatabaseSync) {}

  async append(sessionId: string, seq: number, event: SessionEvent): Promise<void> {
    this.db
      .prepare('INSERT INTO session_events (session_id, seq, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, seq, event.kind, JSON.stringify(event), Date.now())
  }

  async read(sessionId: string, afterSeq = 0): Promise<StoredEvent[]> {
    const rows = this.db
      .prepare('SELECT seq, payload, created_at FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq')
      .all(sessionId, afterSeq) as { seq: number; payload: string; created_at: number }[]
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload) as SessionEvent, createdAt: r.created_at }))
  }

  async lastSeq(sessionId: string): Promise<number> {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM session_events WHERE session_id = ?')
      .get(sessionId) as { s: number }
    return r.s
  }
}

class SqliteInbox implements InboxStore {
  constructor(private db: DatabaseSync) {}

  async save(snapshot: InboxSnapshot): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO inbox_snapshot (id, synced_at, payload) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET synced_at = excluded.synced_at, payload = excluded.payload`,
      )
      .run(snapshot.syncedAt, JSON.stringify({ items: snapshot.items, notices: snapshot.notices }))
  }

  async load(): Promise<InboxSnapshot | null> {
    const r = this.db.prepare('SELECT synced_at, payload FROM inbox_snapshot WHERE id = 1').get() as
      | { synced_at: number; payload: string }
      | undefined
    if (!r) return null
    const body = JSON.parse(r.payload) as Pick<InboxSnapshot, 'items' | 'notices'>
    return { syncedAt: r.synced_at, items: body.items, notices: body.notices }
  }
}

class SqliteConfig implements ConfigStore {
  constructor(private db: DatabaseSync) {}

  async get<T>(key: string): Promise<T | null> {
    const r = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return r ? (JSON.parse(r.value) as T) : null
  }

  async set(key: string, value: unknown): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value))
  }
}

type WatchRow = {
  id: string
  source: string
  title: string
  scope: string
  instruction: string
  cadence: string
  window_start: string | null
  window_day: number | null
  enabled: number
  creates_items: number
  cursor: string | null
  last_run_at: number | null
  last_run_tokens: number | null
  last_run_matches: number | null
  created_at: number
  updated_at: number
}

const toWatch = (r: WatchRow): Watch => ({
  id: r.id,
  source: 'slack',
  title: r.title,
  scope: r.scope,
  instruction: r.instruction,
  cadence: r.cadence as WatchCadence,
  windowStart: r.window_start ?? undefined,
  windowDay: r.window_day ?? undefined,
  enabled: r.enabled === 1,
  createsItems: r.creates_items === 1,
  cursor: r.cursor ?? undefined,
  lastRunAt: r.last_run_at ?? undefined,
  lastRunTokens: r.last_run_tokens ?? undefined,
  lastRunMatches: r.last_run_matches ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

class SqliteWatches implements WatchStore {
  constructor(private db: DatabaseSync) {}

  async list(): Promise<Watch[]> {
    const rows = this.db.prepare('SELECT * FROM watches ORDER BY created_at').all() as WatchRow[]
    return rows.map(toWatch)
  }

  async get(id: string): Promise<Watch | null> {
    const r = this.db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as WatchRow | undefined
    return r ? toWatch(r) : null
  }

  async create(w: Watch): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO watches (id, source, title, scope, instruction, cadence, window_start, window_day,
           enabled, creates_items, cursor, last_run_at, last_run_tokens, last_run_matches, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        w.id, w.source, w.title, w.scope, w.instruction, w.cadence,
        w.windowStart ?? null, w.windowDay ?? null,
        w.enabled ? 1 : 0, w.createsItems ? 1 : 0,
        w.createdAt, w.updatedAt,
      )
  }

  async update(id: string, patch: Partial<NewWatch> & { enabled?: boolean }): Promise<void> {
    const current = await this.get(id)
    if (!current) return
    const next = { ...current, ...patch }
    this.db
      .prepare(
        `UPDATE watches SET title = ?, scope = ?, instruction = ?, cadence = ?, window_start = ?,
           window_day = ?, enabled = ?, creates_items = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.title, next.scope, next.instruction, next.cadence,
        next.windowStart ?? null, next.windowDay ?? null,
        next.enabled ? 1 : 0, next.createsItems ? 1 : 0,
        Date.now(), id,
      )
  }

  async recordRun(id: string, run: WatchRunResult): Promise<void> {
    this.db
      .prepare(
        'UPDATE watches SET cursor = ?, last_run_at = ?, last_run_tokens = ?, last_run_matches = ? WHERE id = ?',
      )
      .run(run.cursor, run.lastRunAt, run.lastRunTokens, run.lastRunMatches, id)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM watches WHERE id = ?').run(id)
  }
}

class SqliteItems implements ItemStore {
  constructor(private db: DatabaseSync) {}

  async upsert(item: WorkItem): Promise<UpsertOutcome> {
    const incoming = Date.parse(item.updatedAt)
    if (!Number.isFinite(incoming)) return 'unchanged'
    const existing = this.db.prepare('SELECT updated_at FROM ingested_items WHERE id = ?').get(item.id) as
      | { updated_at: number }
      | undefined
    if (!existing) {
      this.db
        .prepare('INSERT INTO ingested_items (id, updated_at, payload) VALUES (?, ?, ?)')
        .run(item.id, incoming, JSON.stringify(item))
      return 'inserted'
    }
    // update only if newer — re-ranking is correct, waiting time grew;
    // an equal-or-older write touches nothing (idempotence).
    if (incoming <= existing.updated_at) return 'unchanged'
    this.db
      .prepare('UPDATE ingested_items SET updated_at = ?, payload = ? WHERE id = ?')
      .run(incoming, JSON.stringify(item), item.id)
    return 'updated'
  }

  async list(): Promise<WorkItem[]> {
    const rows = this.db.prepare('SELECT payload FROM ingested_items ORDER BY updated_at DESC').all() as { payload: string }[]
    return rows.map((r) => JSON.parse(r.payload) as WorkItem)
  }

  async prune(cutoff: number): Promise<void> {
    this.db.prepare('DELETE FROM ingested_items WHERE updated_at < ?').run(cutoff)
  }

  async removeByWatch(watchId: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM ingested_items WHERE json_extract(payload, '$.watchId') = ?`)
      .run(watchId)
  }
}

class SqliteItemState implements ItemStateStore {
  constructor(private db: DatabaseSync) {}

  async all(): Promise<Map<string, ItemState>> {
    const rows = this.db.prepare('SELECT * FROM item_state').all() as {
      item_id: string
      status: string
      status_at: number
      snooze_until: number | null
      priority: number | null
      pinned: number
    }[]
    return new Map(
      rows.map((r) => [
        r.item_id,
        {
          itemId: r.item_id,
          status: r.status as ItemStatus,
          statusAt: r.status_at,
          snoozeUntil: r.snooze_until ?? undefined,
          priority: r.priority ?? undefined,
          pinned: r.pinned === 1,
        },
      ]),
    )
  }

  /** Status/snooze only — a priority override already on the row is preserved. */
  async set(state: ItemState): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO item_state (item_id, status, status_at, snooze_until, pinned) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (item_id) DO UPDATE SET status = excluded.status, status_at = excluded.status_at,
           snooze_until = excluded.snooze_until`,
      )
      .run(state.itemId, state.status, state.statusAt, state.snoozeUntil ?? null, state.pinned ? 1 : 0)
  }

  /** Priority override only — status/snooze on the row are preserved. */
  async setPriority(itemId: string, priority: number | null): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO item_state (item_id, status, status_at, priority) VALUES (?, 'open', ?, ?)
         ON CONFLICT (item_id) DO UPDATE SET priority = excluded.priority`,
      )
      .run(itemId, Date.now(), priority)
  }

  async reopen(itemIds: string[], now: number): Promise<void> {
    const stmt = this.db.prepare(
      'UPDATE item_state SET status = ?, status_at = ?, snooze_until = NULL WHERE item_id = ?',
    )
    for (const id of itemIds) stmt.run('open', now, id)
  }
}

type ManualRow = {
  id: string
  title: string
  project_id: string | null
  note: string | null
  url: string | null
  priority: number | null
  created_at: number
  updated_at: number
}

/** A stored manual to-do, projected into the WorkItem shape the inbox merges. */
const toManualItem = (r: ManualRow): WorkItem => ({
  id: r.id,
  source: 'manual',
  kind: 'manual',
  title: r.title,
  url: r.url ?? '',
  repo: '',
  author: '',
  peopleWaiting: 0,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
  ...(r.project_id ? { projectId: r.project_id } : {}),
  ...(r.priority != null ? { priority: r.priority } : {}),
  ...(r.note ? { why: r.note } : {}), // the note renders on the card via `why`
})

class SqliteManualItems implements ManualItemStore {
  constructor(private db: DatabaseSync) {}

  async list(): Promise<WorkItem[]> {
    const rows = this.db
      .prepare('SELECT * FROM manual_items ORDER BY updated_at DESC')
      .all() as ManualRow[]
    return rows.map(toManualItem)
  }

  async create(item: NewManualItem): Promise<void> {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO manual_items (id, title, project_id, note, url, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.title,
        item.projectId ?? null,
        item.note ?? null,
        item.url ?? null,
        item.priority || null, // 0 ("none") stores as NULL
        now,
        now,
      )
  }

  async update(id: string, patch: Partial<Omit<NewManualItem, 'id'>>): Promise<void> {
    const current = this.db.prepare('SELECT * FROM manual_items WHERE id = ?').get(id) as
      | ManualRow
      | undefined
    if (!current) return
    const title = patch.title ?? current.title
    const projectId = patch.projectId !== undefined ? patch.projectId : current.project_id
    const note = patch.note !== undefined ? patch.note : current.note
    const url = patch.url !== undefined ? patch.url : current.url
    const priority = patch.priority !== undefined ? patch.priority : current.priority
    this.db
      .prepare(
        `UPDATE manual_items SET title = ?, project_id = ?, note = ?, url = ?, priority = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(title, projectId ?? null, note ?? null, url ?? null, priority || null, Date.now(), id)
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM manual_items WHERE id = ?').run(id)
  }
}

class SqliteProjects implements ProjectStore {
  constructor(private db: DatabaseSync) {}

  async list(): Promise<Project[]> {
    const rows = this.db
      .prepare('SELECT id, name, repo, path FROM projects ORDER BY name COLLATE NOCASE')
      .all() as Project[]
    return rows.map((r) => ({ id: r.id, name: r.name, repo: r.repo, path: r.path }))
  }

  async create(p: Project): Promise<void> {
    this.db
      .prepare('INSERT INTO projects (id, name, repo, path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(p.id, p.name, p.repo, p.path, Date.now())
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
}
