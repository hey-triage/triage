/**
 * Cross-source linking (.docs/watches.md): two items about the same work get
 * linked, not merged. The scanner *extracts* refs (verifiable); this module
 * canonicalizes them and folds items sharing a canonical ref into one card.
 * No shared ref → never auto-linked. No LLM anywhere.
 */
import type { ScoredItem } from './types.js'

// Canonical ref = the same scheme work-item ids use, so a Slack thread that
// mentions a PR links to the PR's own inbox item by string equality.
const GITHUB_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/
const GITHUB_SHORT = /^([\w.-]+)\/([\w.-]+)#(\d+)$/
const LINEAR_URL = /linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]+-\d+)/
const LINEAR_KEY = /^[A-Z][A-Z0-9]+-\d+$/

/** One extracted string (URL or key) → canonical ref, or null if unrecognized. */
export function canonicalizeRef(raw: string): string | null {
  const s = raw.trim()
  const gh = GITHUB_URL.exec(s) ?? GITHUB_SHORT.exec(s)
  if (gh) return `github:${gh[1]}/${gh[2]}#${gh[3]}`
  const linUrl = LINEAR_URL.exec(s)
  if (linUrl) return `linear:${linUrl[1]}`
  if (LINEAR_KEY.test(s)) return `linear:${s}`
  // already-canonical refs pass through (external scanners may send them)
  if (/^(github|linear|slack):\S+$/.test(s)) return s
  return null
}

export function canonicalizeRefs(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const refs = [...new Set(raw.filter((r): r is string => typeof r === 'string').map(canonicalizeRef).filter((r): r is string => r !== null))]
  return refs.length > 0 ? refs : undefined
}

/**
 * Fold items sharing a canonical ref into one card: the highest-scored item
 * stays, gains a +10 multi-source bonus (two signals about the same work =
 * more urgent) and carries the others as `linked`. An item's own id counts as
 * a ref, so "Slack asks for review of PR #123" folds into the PR's item.
 */
export function linkByRefs(items: ScoredItem[]): ScoredItem[] {
  // union-find over shared refs
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const p = parent.get(id)
    if (p === undefined || p === id) return id
    const root = find(p)
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const byRef = new Map<string, string>() // canonical ref → first item id seen
  for (const item of items) {
    parent.set(item.id, item.id)
    for (const ref of [item.id, ...(item.refs ?? [])]) {
      const owner = byRef.get(ref)
      if (owner === undefined) byRef.set(ref, item.id)
      else union(owner, item.id)
    }
  }

  const groups = new Map<string, ScoredItem[]>()
  for (const item of items) {
    const root = find(item.id)
    const g = groups.get(root)
    if (g) g.push(item)
    else groups.set(root, [item])
  }

  const out: ScoredItem[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0])
      continue
    }
    const [primary, ...rest] = [...group].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    out.push({
      ...primary,
      score: Math.round((primary.score + 10) * 10) / 10,
      linked: rest.map((i) => ({ source: i.source, url: i.url, repo: i.repo })),
    })
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}
