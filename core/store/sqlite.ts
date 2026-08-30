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
import type {
  ConfigStore,
  ProjectStore,
  EventStore,
  InboxStore,
  NewSession,
  SessionStore,
  Store,
  StoredEvent,
  StoredSession,
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
  created_at: number
  updated_at: number
}

const toSession = (r: SessionRow): StoredSession => ({
  id: r.id,
  title: r.title,
  cwd: r.cwd,
  sdkSessionId: r.sdk_session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

class SqliteSessions implements SessionStore {
  constructor(private db: DatabaseSync) {}

  async create(s: NewSession): Promise<StoredSession> {
    const now = Date.now()
    this.db
      .prepare('INSERT INTO sessions (id, title, cwd, sdk_session_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)')
      .run(s.id, s.title, s.cwd, now, now)
    return { ...s, sdkSessionId: null, createdAt: now, updatedAt: now }
  }

  async get(id: string): Promise<StoredSession | null> {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return r ? toSession(r) : null
  }

  async list(): Promise<StoredSession[]> {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as SessionRow[]
    return rows.map(toSession)
  }

  async setSdkSessionId(id: string, sdkSessionId: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id)
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
