/**
 * Per-connector read-only tool allowlists. A watch's connectors compose the
 * run's `allowedTools` — the fence the design docs call "read-only by
 * construction". Where to look inside a connector is the instruction's job;
 * the model finds channels, teams and labels itself.
 *
 * Slack and Linear arrive through the claude.ai connectors (deferred MCP tools,
 * loaded with ToolSearch). GitHub goes through the user's `gh` login, limited to
 * read verbs. A project adds the folder as cwd plus read-only code tools.
 */
import type { WatchConnector, WatchOutput } from './types.js'

export const CONNECTOR_LABEL: Record<WatchConnector, string> = {
  slack: 'Slack',
  linear: 'Linear',
  github: 'GitHub',
  web: 'Web',
}

const SLACK_TOOLS = [
  'mcp__claude_ai_Slack__slack_search_public_and_private',
  'mcp__claude_ai_Slack__slack_search_channels',
  'mcp__claude_ai_Slack__slack_read_thread',
  'mcp__claude_ai_Slack__slack_read_channel',
  'mcp__claude_ai_Slack__slack_read_user_profile',
  'mcp__claude_ai_Slack__slack_search_users',
]

// The Linear connector's read tools (Linear's official MCP tool names).
const LINEAR_TOOLS = [
  'list_issues', 'get_issue', 'list_my_issues', 'list_comments',
  'list_teams', 'get_team', 'list_projects', 'get_project', 'list_cycles',
  'list_users', 'get_user', 'list_issue_labels', 'list_issue_statuses', 'get_issue_status',
  'list_documents', 'get_document', 'search_documentation',
].map((t) => `mcp__claude_ai_Linear__${t}`)

// `gh` read verbs only — no `gh api` (it can mutate), no pr merge/close/comment.
const GITHUB_TOOLS = [
  'Bash(gh pr list:*)', 'Bash(gh pr view:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr status:*)',
  'Bash(gh issue list:*)', 'Bash(gh issue view:*)', 'Bash(gh issue status:*)',
  'Bash(gh search:*)', 'Bash(gh repo view:*)', 'Bash(gh run list:*)', 'Bash(gh run view:*)',
]

// Claude Code's own web tools — no connector, no key. Read-only by nature.
const WEB_TOOLS = ['WebSearch', 'WebFetch']
export const MAX_WEB_FETCHES = 10

const PROJECT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git blame:*)']

const CONNECTOR_TOOLS: Record<WatchConnector, string[]> = { slack: SLACK_TOOLS, linear: LINEAR_TOOLS, github: GITHUB_TOOLS, web: WEB_TOOLS }

/** The exact tools a run may call: connectors' read tools, project tools, and the upsert. */
export function runAllowedTools(connectors: WatchConnector[], hasProject: boolean, output: WatchOutput = 'items'): string[] {
  const tools = new Set<string>(['ToolSearch', output === 'digest' ? 'mcp__triage__write_digest' : 'mcp__triage__upsert_work_item'])
  for (const c of connectors) for (const t of CONNECTOR_TOOLS[c]) tools.add(t)
  if (hasProject) for (const t of PROJECT_TOOLS) tools.add(t)
  return [...tools]
}

/**
 * Tools the run must load with ToolSearch before calling. Connector MCP tools
 * are always deferred; so are Claude Code's own web tools in many setups — a
 * call made before the schema is loaded drops typed parameters and is rejected.
 */
export function runDeferredTools(connectors: WatchConnector[]): string[] {
  return connectors.flatMap((c) => CONNECTOR_TOOLS[c]).filter((t) => t.startsWith('mcp__') || WEB_TOOLS.includes(t))
}

export const MAX_ROWS_PER_RUN = 15

const HOW_TO: Record<WatchConnector, string> = {
  slack: 'Slack: search and read channels, threads and DMs through the Slack tools. The permalink of the root message identifies a thread.',
  linear: 'Linear: list and read issues, teams, projects and comments through the Linear tools. Find the team or label the instructions name by searching; never assume a key. The issue URL (or its key, e.g. PX-123) identifies an issue.',
  github: 'GitHub: use the `gh` CLI, read verbs only (pr list/view/diff/checks, issue list/view, search, run list/view). The PR or issue URL identifies it.',
  web: `Web: search with WebSearch and read pages with WebFetch. WebFetch takes two parameters, url and prompt (what to extract from the page) — always pass both. Fetch at most ${MAX_WEB_FETCHES} pages per run; judge from search snippets first. Check the date on the page itself before trusting it. The page URL identifies a find.`,
}

/**
 * The run prompt. Output contract is tool calls, not JSON: one upsert per
 * match, the server stamps identity and provenance (.docs/watches-v2.md).
 */
export function composeRunPrompt(w: {
  instruction: string
  connectors: WatchConnector[]
  cursor?: string
  /** legacy place hint from pre-connector watches */
  scope?: string
  project?: { name: string; path: string } | null
  output?: WatchOutput
}): string {
  const window = w.cursor ? `activity newer than ${w.cursor}` : `activity from the last 7 days`
  const deferred = runDeferredTools(w.connectors)
  const lines = [
    `You are a triage scanner running ONE watch, read-only. Look only where the instructions say, only at ${window}.`,
    deferred.length
      ? `Your tools are deferred: before anything else, call ToolSearch with "select:${deferred.join(',')}" to load their schemas, then use them. Never call a tool you have not loaded.`
      : '',
    ...w.connectors.map((c) => HOW_TO[c]),
    w.project ? `Project: the folder ${w.project.path} (${w.project.name}) is your working directory. Read code with Read/Grep/Glob and git log/show/diff when the instructions need it.` : '',
    w.scope ? `Look in ${w.scope} only.` : '',
    `Instructions:\n${w.instruction}`,
    `Judge each candidate on its title and first ~200 characters; open the full thread, issue or diff only when that is not enough to decide.`,
    ...(w.output === 'digest'
      ? [
          `Output: ONE digest. When you have looked at everything relevant, call the write_digest tool exactly once with:
- title: a short name for this edition (e.g. "AI news · 12 Sep")
- body: the whole digest as markdown — lead with the two or three things worth attention and why, then the rest as a tight list with links; say what window you covered
- refs: any GitHub PR/issue URLs or Linear keys you cite (omit if none)
Do not file individual items. If there is nothing new since the window began, do not call write_digest — just finish with one line saying so.`,
          `write_digest is the ONLY write tool you may use. If you cannot access any of the connector tools at all, reply with exactly no-connector-tools and stop.`,
        ]
      : [
    `For EACH match, call the upsert_work_item tool exactly once with:
- url: the canonical link (Slack permalink, Linear issue URL or key, GitHub PR/issue URL, or the web page URL)
- title: a one-line summary
- place: where it lives — "#channel", "@dm", the Linear team key, "owner/repo", or the site name
- from: the author or asker, when known
- lastActivity: ISO 8601 timestamp of the newest activity
- why: one line stating exactly what matched the instructions
- refs: any other GitHub PR/issue URLs or Linear keys visible in the content (omit if none)`,
    `Call upsert_work_item at most ${MAX_ROWS_PER_RUN} times. It is the ONLY write tool you may use. If nothing matches, do not call it — just finish with a one-line summary of what you looked at. If you cannot access any of the connector tools at all, reply with exactly no-connector-tools and stop.`,
        ]),
  ]
  return lines.filter(Boolean).join('\n\n')
}
