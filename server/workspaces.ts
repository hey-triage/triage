/**
 * Workspaces (.docs/workspaces.md) — the top-level scope isolating work from
 * personal. Hermes-profile-style storage under a single daemon: each workspace
 * is its own directory holding its own SQLite file, so isolation is physical
 * (a workspace cannot read another's rows), never a WHERE clause.
 *
 *   ~/.triage/
 *     workspaces.json          registry (no secrets)
 *     workspaces/<id>/
 *       triage.db              same schema as ever — no migration needed
 *       .env                   secrets (ANTHROPIC_API_KEY), mode 0600
 *       claude/                CLAUDE_CONFIG_DIR for the config-dir backend
 *
 * This module owns the registry file, the directory layout, the one-time
 * migration of the legacy single DB into the default workspace, and the
 * spawn-env resolution per auth backend. It holds no runtime state — the
 * server builds a WorkspaceRuntime per entry on top of this.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { TRIAGE_DIR } from './state.js'
import type { WorkspaceAuthBackend } from '../shared/protocol.js'

export type WorkspaceMeta = {
  id: string
  name: string
  /** hex color — the ambient "which world am I in" signal */
  color: string
  description?: string
  authBackend: WorkspaceAuthBackend
  createdAt: number
}

export type WorkspaceRegistry = {
  version: 1
  defaultId: string
  /** whether the first-run onboarding modal has been completed (or skipped) */
  onboarded: boolean
  workspaces: WorkspaceMeta[]
}

export const REGISTRY_FILE = path.join(TRIAGE_DIR, 'workspaces.json')
const WORKSPACES_DIR = path.join(TRIAGE_DIR, 'workspaces')
/** the pre-workspaces single-DB location, migrated into the default workspace */
const LEGACY_DB = path.join(TRIAGE_DIR, 'triage-dev.db')

export const workspaceDir = (id: string) => path.join(WORKSPACES_DIR, id)
export const workspaceDbFile = (id: string) => path.join(workspaceDir(id), 'triage.db')

/**
 * Which SQLite file a workspace opens. TRIAGE_DB keeps its pre-workspaces
 * meaning — "the default workspace's DB lives here" — so dev/test overrides
 * keep working; every other workspace always uses its own directory.
 */
export function dbFileFor(id: string, defaultId: string): string {
  if (process.env.TRIAGE_DB && id === defaultId) return process.env.TRIAGE_DB
  return workspaceDbFile(id)
}
export const workspaceEnvFile = (id: string) => path.join(workspaceDir(id), '.env')
export const workspaceClaudeDir = (id: string) => path.join(workspaceDir(id), 'claude')

const AUTH_BACKENDS: WorkspaceAuthBackend[] = ['inherit', 'api-key', 'config-dir']

export const toAuthBackend = (v: unknown): WorkspaceAuthBackend | undefined =>
  AUTH_BACKENDS.includes(v as WorkspaceAuthBackend) ? (v as WorkspaceAuthBackend) : undefined

/** "Work stuff!" → "work-stuff"; falls back to a uuid slice for degenerate names. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || `ws-${randomUUID().slice(0, 8)}`
}

export function saveRegistry(reg: WorkspaceRegistry): void {
  mkdirSync(TRIAGE_DIR, { recursive: true })
  writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2) + '\n')
}

/**
 * Load the registry, creating it (and migrating the legacy single DB into the
 * default workspace) on first run. Idempotent; safe to call at every boot.
 */
export function loadRegistry(): WorkspaceRegistry {
  let reg: WorkspaceRegistry | null = null
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as WorkspaceRegistry
    if (parsed && Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0) reg = parsed
  } catch {
    // no registry yet — first run
  }

  if (!reg) {
    reg = {
      version: 1,
      defaultId: 'default',
      onboarded: false,
      workspaces: [
        {
          id: 'default',
          name: 'Default',
          color: '#7aa2f7',
          authBackend: 'inherit',
          createdAt: Date.now(),
        },
      ],
    }
    saveRegistry(reg)
  }

  for (const ws of reg.workspaces) ensureWorkspaceDirs(ws.id)
  migrateLegacyDb(reg.defaultId)
  return reg
}

export function ensureWorkspaceDirs(id: string): void {
  mkdirSync(workspaceDir(id), { recursive: true })
}

/**
 * One-time migration: the pre-workspaces DB (~/.triage/triage-dev.db, or
 * TRIAGE_DB) moves into the default workspace's directory — with its WAL/SHM
 * siblings — so nothing is lost and the old path stops being written. Skipped
 * when the workspace DB already exists (never clobber) or there is nothing to
 * move.
 */
function migrateLegacyDb(defaultId: string): void {
  if (process.env.TRIAGE_DB) return // override in force — the default workspace uses it in place
  const target = workspaceDbFile(defaultId)
  if (existsSync(target) || !existsSync(LEGACY_DB)) return
  ensureWorkspaceDirs(defaultId)
  renameSync(LEGACY_DB, target)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(LEGACY_DB + suffix)) renameSync(LEGACY_DB + suffix, target + suffix)
  }
  console.log(`[workspaces] migrated ${LEGACY_DB} → ${target}`)
}

/** Write the workspace's API key to its own .env, owner-read-only. */
export function writeApiKey(id: string, key: string): void {
  ensureWorkspaceDirs(id)
  const file = workspaceEnvFile(id)
  writeFileSync(file, `ANTHROPIC_API_KEY=${key}\n`, { mode: 0o600 })
  chmodSync(file, 0o600) // writeFileSync mode is ignored when the file exists
}

function readEnvFile(id: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const line of readFileSync(workspaceEnvFile(id), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m) out[m[1]] = m[2]
    }
  } catch {
    // no .env — fine for inherit/config-dir
  }
  return out
}

/** "key set (…abcd)" material for the UI; the key itself never leaves disk. */
export function apiKeyHint(id: string): string | null {
  const key = readEnvFile(id).ANTHROPIC_API_KEY
  return key ? `…${key.slice(-4)}` : null
}

/**
 * The env overrides a workspace's subprocesses spawn with. `undefined` for
 * `inherit` — today's behavior exactly: the SDK resolves ~/.claude on its own.
 * The overrides are merged over process.env at the spawn site.
 */
export function envOverridesFor(meta: WorkspaceMeta): Record<string, string> | undefined {
  if (meta.authBackend === 'api-key') {
    const key = readEnvFile(meta.id).ANTHROPIC_API_KEY
    return key ? { ANTHROPIC_API_KEY: key } : undefined
  }
  if (meta.authBackend === 'config-dir') {
    const dir = workspaceClaudeDir(meta.id)
    mkdirSync(dir, { recursive: true })
    return { CLAUDE_CONFIG_DIR: dir }
  }
  return undefined
}

/** Full spawn env for a workspace: process.env with the overrides on top. */
export function spawnEnvFor(meta: WorkspaceMeta): Record<string, string> | undefined {
  const overrides = envOverridesFor(meta)
  if (!overrides) return undefined
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { ...env, ...overrides }
}

/** The one-time interactive login for a config-dir workspace, shown in the UI. */
export function loginCommandFor(id: string): string {
  return `CLAUDE_CONFIG_DIR=${workspaceClaudeDir(id)} claude /login`
}
