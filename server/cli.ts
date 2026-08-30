#!/usr/bin/env node
/**
 * `triage` — lifecycle wrapper around the server (server/index.ts).
 *
 *   triage             start the server in the background if it isn't running
 *   triage serve       run the server in the foreground (debugging, launchd)
 *   triage stop        stop the background server
 *   triage restart     stop + start (picks up a newly installed version)
 *   triage status      is it running, where, since when
 *   triage logs        print the tail of ~/.triage/server.log
 *
 * "Is triage running" is always decided by GET /api/health — a pid file can
 * lie after a crash or reboot; the health check cannot. The state file
 * (~/.triage/server.json) only records the port so stop/status/restart can
 * find a server started with --port.
 *
 * Port conflicts fail fast with a message instead of auto-incrementing: the
 * MCP shim and browser bookmarks assume a stable port, so silently moving
 * to 5179 would break every other consumer.
 */
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PORT,
  LOG_FILE,
  TRIAGE_DIR,
  checkHealth,
  pkgVersion,
  readState,
  type Health,
} from './state.js'

// --- styling -----------------------------------------------------------------
// Dependency-free ANSI. Colors turn off when piped or when NO_COLOR is set.

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
const bold = paint('1')
const dim = paint('2')
const red = paint('31')
const green = paint('32')
const yellow = paint('33')
const cyan = paint('36')

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const tilde = (p: string) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p)

/** Rounded box around pre-styled lines (width measured without ANSI codes). */
function box(lines: string[]) {
  const width = Math.max(...lines.map((l) => stripAnsi(l).length))
  console.log(dim('╭' + '─'.repeat(width + 4) + '╮'))
  for (const line of lines) {
    const pad = ' '.repeat(width - stripAnsi(line).length)
    console.log(dim('│') + '  ' + line + pad + '  ' + dim('│'))
  }
  console.log(dim('╰' + '─'.repeat(width + 4) + '╯'))
}

const row = (label: string, value: string) => dim(label.padEnd(9)) + value

const HELP = `
  ${bold('triage')} ${dim('v' + pkgVersion())} — ranked work inbox for engineers

  ${bold('Usage')}
    ${cyan('triage')}             start the server in the background ${dim('(no-op if running)')}
    ${cyan('triage serve')}       run the server in the foreground
    ${cyan('triage stop')}        stop the background server
    ${cyan('triage restart')}     stop, then start ${dim('(picks up a newly installed version)')}
    ${cyan('triage status')}      show whether the server is running and where
    ${cyan('triage logs')}        print the tail of the server log

  ${bold('Options')}
    ${cyan('--port <n>')}         port to serve on ${dim(`(default ${DEFAULT_PORT}; PORT env works too)`)}
    ${cyan('--version')}          print the version
    ${cyan('--help')}             show this help

  ${bold('Files')}
    ${dim('~/.triage/server.log')}    server output when started in the background
    ${dim('~/.triage/server.json')}   pid/port of the last started server
`

function die(message: string): never {
  console.error(`${red('✗')} triage: ${message}`)
  process.exit(1)
}

// --- argv ------------------------------------------------------------------

const args = process.argv.slice(2)
let explicitPort: number | null = null
const positional: string[] = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--help' || a === '-h') {
    console.log(HELP)
    process.exit(0)
  } else if (a === '--version' || a === '-v') {
    console.log(pkgVersion())
    process.exit(0)
  } else if (a === '--port') {
    explicitPort = Number(args[++i])
  } else if (a.startsWith('--port=')) {
    explicitPort = Number(a.slice('--port='.length))
  } else if (a.startsWith('-')) {
    die(`unknown option ${a} — try ${cyan('triage --help')}`)
  } else {
    positional.push(a)
  }
}
if (explicitPort !== null && (!Number.isInteger(explicitPort) || explicitPort <= 0 || explicitPort > 65535)) {
  die(`--port needs a port number, e.g. ${cyan('--port 5179')}`)
}
const command = positional[0] ?? 'start'

/**
 * Which port to talk to. A fresh start uses the default unless overridden;
 * stop/status/restart/logs prefer the port the last server recorded, so they
 * find a --port server without the flag being repeated.
 */
async function resolvePort(forStart: boolean): Promise<number> {
  if (explicitPort !== null) return explicitPort
  if (process.env.PORT) return Number(process.env.PORT)
  if (!forStart) {
    const state = await readState()
    if (state?.port) return state.port
  }
  return DEFAULT_PORT
}

// --- commands ---------------------------------------------------------------

function printRunning(health: Health, verb: string, showDb = false) {
  const lines = [
    `${green('●')} ${bold(`triage ${verb}`)}`,
    '',
    `${dim('→')} ${bold(cyan(`http://localhost:${health.port}`))}`,
    '',
    row('version', health.version),
    row('pid', String(health.pid)),
  ]
  if (health.liveSessions > 0) {
    lines.push(row('sessions', yellow(`${health.liveSessions} live`)))
  }
  lines.push(row('logs', tilde(LOG_FILE)))
  if (showDb) lines.push(row('db', tilde(health.db)))
  lines.push('', `${cyan('triage restart')} ${dim('·')} ${cyan('triage stop')} ${dim('·')} ${cyan('triage logs')}`)
  box(lines)
}

async function logTail(lines: number): Promise<string> {
  try {
    const log = await readFile(LOG_FILE, 'utf8')
    return log.trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

async function start(port: number) {
  const health = await checkHealth(port)
  if (health === 'other') {
    die(
      `port ${port} is in use by something that isn't triage — pick another port: ${cyan(`triage --port ${port + 1}`)}`,
    )
  }
  if (health) {
    printRunning(health, 'is already running')
    return
  }

  await mkdir(TRIAGE_DIR, { recursive: true })
  const logFd = openSync(LOG_FILE, 'a')
  // Re-invoke this same script with `serve`, detached, logging to the file.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PORT: String(port) },
  })
  let exited: number | null = null
  child.on('exit', (code) => {
    exited = code ?? 1
  })
  child.unref()

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    if (exited !== null) {
      const tail = await logTail(15)
      console.error(`${red('✗')} triage: server exited before it came up ${dim(`(code ${exited})`)}`)
      if (tail) console.error(dim(tail))
      process.exit(1)
    }
    const up = await checkHealth(port)
    if (up && up !== 'other') {
      printRunning(up, 'started')
      return
    }
  }
  die(`server did not come up on port ${port} within 15s — check ${cyan('triage logs')}`)
}

async function stop(port: number): Promise<boolean> {
  const health = await checkHealth(port)
  if (health === 'other') {
    die(`port ${port} is in use by something that isn't triage — nothing to stop`)
  }
  if (!health) {
    const state = await readState()
    if (state && state.port === port && isAlive(state.pid)) {
      die(
        `process ${state.pid} from ${TRIAGE_DIR}/server.json is alive but not answering ` +
          `/api/health — not touching it; if it's a hung triage, run ${cyan(`kill ${state.pid}`)}`,
      )
    }
    console.log(`${dim('○')} triage is not running`)
    return false
  }

  if (health.liveSessions > 0) {
    console.log(
      `${yellow('!')} stopping ends ${bold(String(health.liveSessions))} live Claude session${health.liveSessions === 1 ? '' : 's'}`,
    )
  }
  process.kill(health.pid, 'SIGTERM')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    if (!isAlive(health.pid)) {
      console.log(`${green('✓')} triage stopped ${dim(`(pid ${health.pid})`)}`)
      return true
    }
  }
  process.kill(health.pid, 'SIGKILL')
  console.log(`${yellow('!')} triage did not exit within 10s — killed ${dim(`(pid ${health.pid})`)}`)
  return true
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function status(port: number) {
  const health = await checkHealth(port)
  if (health === 'other') {
    console.log(`${dim('○')} triage is not running ${dim(`(port ${port} is in use by something else)`)}`)
    process.exitCode = 1
    return
  }
  if (!health) {
    console.log(`${dim('○')} triage is not running — start it with ${cyan('triage')}`)
    process.exitCode = 1
    return
  }
  printRunning(health, 'is running', true)
}

async function logs() {
  const tail = await logTail(50)
  if (!tail) {
    console.log(
      `${dim('○')} no log file yet at ${tilde(LOG_FILE)} — the server hasn't been started in the background`,
    )
    return
  }
  console.log(tail)
  console.log(dim(`\n(full log: ${tilde(LOG_FILE)})`))
}

// --- dispatch ----------------------------------------------------------------

switch (command) {
  case 'start':
    await start(await resolvePort(true))
    break
  case 'serve':
    // Foreground: hand over to the server module (it listens on import).
    await import('./index.js')
    break
  case 'stop':
    await stop(await resolvePort(false))
    break
  case 'restart': {
    const port = await resolvePort(false)
    await stop(port)
    await start(port)
    break
  }
  case 'status':
    await status(await resolvePort(false))
    break
  case 'logs':
    await logs()
    break
  default:
    die(`unknown command "${command}" — try ${cyan('triage --help')}`)
}
