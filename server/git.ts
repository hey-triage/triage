/**
 * Git plumbing for the session changes view.
 *
 * Everything here is read-only and never touches the user's index, HEAD or
 * working tree. A "snapshot" is a tree object built through a throwaway index
 * (`GIT_INDEX_FILE=<tmp> git read-tree HEAD && git add -A && git write-tree`),
 * which is what lets us photograph the working tree — untracked files included
 * — without staging anything. `.gitignore` is respected, so an edit to an
 * ignored file is invisible to this whole feature.
 *
 * Trees are written into the repo's object database, so they survive until a
 * `git gc` prunes unreachable objects. That is acceptable for a view that only
 * ever looks back over one session's lifetime; nothing here is durable state.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const pExecFile = promisify(execFile)

/** Patches above this are cut off; the file still reports its real counts. */
export const PATCH_BUDGET = 256 * 1024

async function git(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await pExecFile('git', ['-C', root, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  })
  return stdout
}

/** The repo root containing `cwd`, or null when it is not in a git repo. */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ['rev-parse', '--show-toplevel'])
    return out.trim() || null
  } catch {
    return null
  }
}

/**
 * Photograph the working tree as a git tree object.
 *
 * Returns null on any failure — a snapshot is best-effort telemetry about a
 * session, never something worth failing a turn over.
 */
export async function snapshotTree(root: string): Promise<string | null> {
  const index = path.join(os.tmpdir(), `triage-index-${randomUUID()}`)
  const env = { GIT_INDEX_FILE: index }
  try {
    // An unborn HEAD (a repo with no commits yet) has nothing to read; the
    // empty index that `add -A` then fills is exactly right in that case.
    try {
      await git(root, ['read-tree', 'HEAD'], env)
    } catch {
      /* unborn branch — start from an empty index */
    }
    await git(root, ['add', '-A'], env)
    const sha = (await git(root, ['write-tree'], env)).trim()
    return sha || null
  } catch {
    return null
  } finally {
    await rm(index, { force: true }).catch(() => {})
  }
}

export type TreeChange = {
  path: string
  status: 'modified' | 'added' | 'deleted'
  insertions: number
  deletions: number
  isBinary: boolean
}

const STATUS: Record<string, TreeChange['status']> = { M: 'modified', A: 'added', D: 'deleted', T: 'modified' }

/**
 * What changed between two trees. Rename detection is deliberately off: a
 * rename reads as a delete plus an add, which is both simpler to attribute and
 * closer to what the agent actually did to the files on disk.
 */
export async function treeDiff(root: string, from: string, to: string): Promise<TreeChange[]> {
  if (from === to) return []
  const byPath = new Map<string, TreeChange>()

  const names = await git(root, ['diff-tree', '-r', '--no-commit-id', '--no-renames', '--name-status', '-z', from, to])
  const nf = names.split('\0')
  for (let i = 0; i + 1 < nf.length; i += 2) {
    const code = nf[i]?.trim()
    const p = nf[i + 1]
    if (!code || !p) continue
    byPath.set(p, { path: p, status: STATUS[code[0]] ?? 'modified', insertions: 0, deletions: 0, isBinary: false })
  }

  const nums = await git(root, ['diff-tree', '-r', '--no-commit-id', '--no-renames', '--numstat', '-z', from, to])
  const parts = nums.split('\0')
  for (const rec of parts) {
    if (!rec) continue
    // `<ins>\t<del>\t<path>` — a binary file reports "-" for both counts.
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec)
    if (!m) continue
    const entry = byPath.get(m[3])
    if (!entry) continue
    entry.isBinary = m[1] === '-' || m[2] === '-'
    entry.insertions = m[1] === '-' ? 0 : Number(m[1])
    entry.deletions = m[2] === '-' ? 0 : Number(m[2])
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** One file's patch between two trees, as unified-diff text. */
export async function filePatch(
  root: string,
  from: string,
  to: string,
  file: string,
): Promise<{ patch: string; truncated: boolean }> {
  const out = await git(root, [
    'diff',
    '--no-renames',
    '--no-color',
    '--no-ext-diff',
    `--unified=3`,
    from,
    to,
    '--',
    file,
  ])
  if (out.length <= PATCH_BUDGET) return { patch: out, truncated: false }
  return { patch: out.slice(0, PATCH_BUDGET), truncated: true }
}
