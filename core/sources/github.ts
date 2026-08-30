/**
 * GitHub source — ported from hey-triage (src/sources/github.ts). Shells out
 * to `gh` (vision principle 5: prefer the CLI the user already has and has
 * already authenticated over an SDK + token management). One GraphQL round
 * trip covers all three searches. Deterministic: no LLM anywhere.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { daysSince } from '../work/score.js'
import type { ItemKind, WorkItem } from '../work/types.js'

const exec = promisify(execFile)
const MAX_BUFFER = 10 * 1024 * 1024

export async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, { maxBuffer: MAX_BUFFER })
    return stdout
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    if (e.code === 'ENOENT') {
      throw new Error(
        'GitHub CLI (gh) not found. Install it from https://cli.github.com and run `gh auth login`.',
      )
    }
    const stderr = (e.stderr ?? '').trim()
    throw new Error(
      `gh ${args[0]} failed${stderr ? `: ${stderr}` : ''}. If you're not logged in, run \`gh auth login\`.`,
    )
  }
}

let cachedLogin: string | null = null

export async function ghLogin(): Promise<string> {
  if (cachedLogin) return cachedLogin
  cachedLogin = (await gh(['api', 'user', '--jq', '.login'])).trim()
  return cachedLogin
}

// One GraphQL round trip for all three searches. `search(type: ISSUE)` covers
// both issues and PRs; inline fragments pick the fields per type.
const query = (first: number) => `
query($reviewQ: String!, $authoredQ: String!, $mentionQ: String!) {
  review: search(query: $reviewQ, type: ISSUE, first: ${first}) { nodes { ...prF } }
  authored: search(query: $authoredQ, type: ISSUE, first: ${first}) { nodes { ...prF } }
  mentions: search(query: $mentionQ, type: ISSUE, first: ${Math.min(first, 25)}) { nodes { ...prF ...issueF } }
}
fragment prF on PullRequest {
  __typename number title url isDraft createdAt updatedAt
  repository { nameWithOwner }
  author { login }
  reviewDecision
  mergeable
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
fragment issueF on Issue {
  __typename number title url createdAt updatedAt
  repository { nameWithOwner }
  author { login }
}`

interface RawNode {
  __typename: 'PullRequest' | 'Issue'
  number: number
  title: string
  url: string
  isDraft?: boolean
  createdAt: string
  updatedAt: string
  repository: { nameWithOwner: string }
  author: { login: string } | null
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  commits?: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> }
}

/**
 * @param repos owner/name repos to scope to; empty = all repos. GitHub caps
 * search queries at 256 chars: qualify the query when the repo list fits,
 * otherwise fetch wider and filter client-side (may miss items beyond the
 * first page in very noisy accounts — acceptable for now).
 */
export async function fetchGitHub(repos: string[] = [], now = Date.now()): Promise<WorkItem[]> {
  const login = await ghLogin()

  const qualifier = repos.map((r) => `repo:${r}`).join(' ')
  const useQualifier = repos.length > 0 && qualifier.length + 60 <= 256
  const scope = useQualifier ? ` ${qualifier}` : ''
  const clientFilter = repos.length > 0 && !useQualifier

  const out = await gh([
    'api',
    'graphql',
    '-f', `query=${query(clientFilter ? 50 : 30)}`,
    '-f', `reviewQ=is:open is:pr review-requested:${login} archived:false${scope}`,
    '-f', `authoredQ=is:open is:pr author:${login} archived:false${scope}`,
    '-f', `mentionQ=is:open mentions:${login} -author:${login} archived:false${scope}`,
  ])
  const data = (
    JSON.parse(out) as {
      data: Record<'review' | 'authored' | 'mentions', { nodes: RawNode[] }>
    }
  ).data

  const items = new Map<string, WorkItem>()
  const add = (item: WorkItem) => {
    if (!items.has(item.id)) items.set(item.id, item)
  }

  for (const node of data.review.nodes) {
    add(toItem(node, 'review-requested', 1))
  }
  for (const node of data.authored.nodes) {
    add(toItem(node, classifyOwnPr(node, now), node.reviewDecision === 'CHANGES_REQUESTED' ? 1 : 0))
  }
  for (const node of data.mentions.nodes) {
    add(toItem(node, 'mention', 1))
  }
  const all = [...items.values()]
  return clientFilter ? all.filter((i) => repos.includes(i.repo)) : all
}

/** repos the user can pull from, for the repo picker */
export async function listAffiliatedRepos(): Promise<string[]> {
  const out = await gh([
    'api',
    'user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=pushed',
    '--paginate',
    '--jq', '.[].full_name',
  ])
  return out.split('\n').filter(Boolean)
}

function classifyOwnPr(node: RawNode, now: number): ItemKind {
  if (node.isDraft) return 'own-pr-open'
  if (node.reviewDecision === 'CHANGES_REQUESTED') return 'reply-needed'
  if (node.reviewDecision === 'APPROVED') return 'own-pr-approved'
  if (node.mergeable === 'CONFLICTING') return 'own-pr-conflicting'
  if (daysSince(node.updatedAt, now) > 3) return 'own-pr-stale'
  return 'own-pr-open'
}

function toItem(node: RawNode, kind: ItemKind, peopleWaiting: number): WorkItem {
  const repo = node.repository.nameWithOwner
  const rollup = node.commits?.nodes[0]?.commit.statusCheckRollup?.state
  return {
    id: `github:${repo}#${node.number}`,
    source: 'github',
    kind: node.__typename === 'Issue' && kind !== 'mention' ? 'fyi' : kind,
    title: node.title,
    url: node.url,
    repo,
    author: node.author?.login ?? 'ghost',
    peopleWaiting,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    isDraft: node.isDraft ?? false,
    ciFailing: rollup === 'FAILURE' || rollup === 'ERROR',
  }
}
