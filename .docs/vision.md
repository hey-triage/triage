# Vision

## What triage is

**The ranked inbox for your actual work — with one-click dispatch to the agent you
already have.**

Triage is a local-first command center for working engineers. It pulls the work that
already exists — review requests, assigned issues, failing CI, stale PRs (GitHub first) —
ranks it deterministically, and lets you dispatch any item to your locally installed
Claude Code with full context, then steer the session from a browser tab with streaming
chat and in-page permission prompts.

```
npm i -g @hey-triage/triage
triage        →  local server + web UI at http://localhost:5178
```

One long-running process. Everything stays on your machine.

## The brief (added 2026-08-30, from the first-user interview)

The dispatch model is stronger than "one click": **every work item arrives with its
action already drafted.** For anything read-only, the playbook runs in the background
before the user looks — a review request lands as a computed risk brief, a mention as
a draft reply, a red CI as an attempted fix. The inbox is a list of things *almost
done, awaiting judgment*. Playbooks are user-editable skills with opinionated defaults.

The safety line: **read-only runs itself; outward writes wait for the human.** Reviews
are never posted; replies are drafted for copy-paste (no Slack write scopes — see
non-goals); pushes are gated on approval.

Two more interview corrections: work arrives through **Slack as much as GitHub**
(review-request channels, weekly-plan threads, DMs), so source coverage there is
identity, not integration; and sessions surface in the inbox for **cheap re-entry**
(what it did / what it asks / how to verify), not for faster interrupts — the user
protects focus on purpose.

## Why a web app (not a TUI)

Dispatching to an *interactive* Claude Code session in a new terminal tab is not
portable — Warp, iTerm, Terminal.app, and Linux terminals all need different hacks, and
most support none. The browser sidesteps the problem entirely: the Claude Agent SDK
drives the installed Claude Code headlessly, and the web page becomes the session
surface. Streaming responses, tool-call cards, Allow/Deny permission buttons, many
sessions in many tabs — all things a browser does better than a spawned terminal.

The web UI is still a thin frontend. All ranking, source, and session logic lives in the
core; the server just serves the SPA and speaks WebSocket.

## Principles

1. **Local-first.** The server binds to localhost. Work items, sessions, and config live
   on disk in the user's home. No cloud, no telemetry required to function.
2. **Your agent, your subscription.** Sessions run on the user's installed Claude Code
   with their existing login. Their claude.ai connectors, plugins, skills, and
   permission allowlists load exactly as in an interactive session. **Never require an
   LLM API key.**
3. **Deterministic ranking.** No LLM calls in the scoring path. Generative work happens
   only inside dispatched sessions, and everything degrades gracefully when no agent is
   installed (the inbox still works).
4. **Thin frontends, fat core.** Web UI, CLI, and MCP server are all clients of the same
   core. Never put scoring or source logic in a frontend.
5. **Minimal dependencies.** Global npm install must stay cheap. Prefer shelling out to
   `gh` over SDKs.
6. **Localhost is a security boundary — treat it like one.** Bind 127.0.0.1 only,
   validate `Origin` on WebSocket upgrade, auth-token in the URL. A server that can
   drive an agent with the user's credentials is a target.

## Positioning

- **vs. Paperclip** ("the company of agents"): Paperclip starts from goals and builds an
  AI org downward. Triage starts from reality — the work already sitting in GitHub — and
  ranks it. Our buyer is an engineer with a normal job, not someone building an
  autonomous AI organization. No org charts, no budgets, no hiring a CEO.
- **vs. Hermes-style chat UIs**: those are a chat surface over an API. Triage is an
  inbox first; sessions are the plumbing that gets ranked work *done*. And it runs on
  the Claude Code harness (subscription, connectors, permissions), not raw API calls.

The inbox is the identity. The sessions are the plumbing.

## Non-goals

- Slack / email / calendar OAuth in this repo
- Multi-agent orchestration, org charts, autonomous "companies"
- Hosted execution on users' personal Claude subscriptions (won't work, won't try)
- Desktop app wrappers (the browser is enough)

## The future (a story for another day)

A paid hosted version for teams — shared visibility, routing, dashboards — where **we
provide Claude via our own API keys**, metered. The local product stays free, OSS (MIT),
and complete on its own. Nothing in the local architecture may depend on the hosted
version existing; the only obligation today is keeping the core frontend-agnostic so a
hosted frontend is possible later.
