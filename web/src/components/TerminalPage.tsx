/**
 * One terminal tab: an xterm.js emulator wired to a daemon-side PTY over the
 * WebSocket. Output never touches React state — it streams straight from the
 * store's terminal channel into the emulator; the summary (title, status) is
 * the only structural state.
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Pencil, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TerminalSummary } from '../../../shared/protocol.js'
import { store } from '../store.js'

type Props = {
  terminal: TerminalSummary
  onRename: (title: string) => void
  onClose: () => void
  onNewHere: () => void
}

const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

/** The design's palette, as xterm sees it. */
const THEME = {
  background: '#06060a',
  foreground: 'rgba(252,253,255,0.86)',
  cursor: '#fcfdff',
  cursorAccent: '#000000',
  selectionBackground: 'rgba(255,255,255,0.18)',
  black: '#0a0a0c',
  red: '#ff2047',
  green: '#11ff99',
  yellow: '#ffc53d',
  blue: '#3b9eff',
  magenta: '#c084fc',
  cyan: '#2dd4bf',
  white: '#a1a4a5',
  brightBlack: '#464a4d',
  brightRed: '#ff6b85',
  brightGreen: '#5dffb8',
  brightYellow: '#ffd76b',
  brightBlue: '#6db6ff',
  brightMagenta: '#d8b4fe',
  brightCyan: '#5eead4',
  brightWhite: '#fcfdff',
}

export function TerminalPage({ terminal, onRename, onClose, onNewHere }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [renaming, setRenaming] = useState(false)
  const running = terminal.status === 'running'

  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Terminal({
      theme: THEME,
      fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: false,
      macOptionIsMeta: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)

    const id = terminal.id
    const sendSize = () => {
      try {
        fit.fit()
      } catch {
        return
      }
      store.send({ type: 'terminal_resize', terminalId: id, cols: term.cols, rows: term.rows })
    }
    sendSize()
    term.focus()

    const offData = term.onData((data) => store.send({ type: 'terminal_input', terminalId: id, data }))
    const offOutput = store.onTerminalData(id, (data, replay) => {
      if (replay) term.reset()
      term.write(data)
    })

    const ro = new ResizeObserver(() => sendSize())
    ro.observe(el)

    return () => {
      ro.disconnect()
      offData.dispose()
      offOutput()
      term.dispose()
    }
    // The emulator is bound to one PTY for its whole life; the page remounts
    // per terminal id (see the key in App).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id])

  return (
    <div className="termPage">
      <div id="chatHeader" className="termHeader">
        {renaming ? (
          <input
            className="termRename"
            autoFocus
            defaultValue={terminal.title}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const v = e.currentTarget.value.trim()
                if (v && v !== terminal.title) onRename(v)
                setRenaming(false)
              } else if (e.key === 'Escape') setRenaming(false)
            }}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim()
              if (v && v !== terminal.title) onRename(v)
              setRenaming(false)
            }}
          />
        ) : (
          <button type="button" id="chatTitle" className="termTitle" title="Rename" onClick={() => setRenaming(true)}>
            {terminal.title}
            <Pencil size={11} aria-hidden="true" />
          </button>
        )}
        <span className="pills">
          <span className="pill mono" title={terminal.cwd}>
            <span className="t">{homely(terminal.cwd)}</span>
          </span>
        </span>
        <span className={`state ${running ? 'running' : ''}`}>
          <span className={`dot ${running ? 'green' : 'stone'}`} />
          {running ? `running · pid ${terminal.pid}` : `exited · code ${terminal.exitCode ?? '?'}`}
        </span>
        <button type="button" className="iconBtn" title="New terminal in this folder" onClick={onNewHere}>
          <Plus size={14} aria-hidden="true" />
        </button>
        <button type="button" className="iconBtn red" title={running ? 'Kill and close' : 'Close'} onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className={`termHost${running ? '' : ' exited'}`} ref={host} onClick={() => host.current?.querySelector('textarea')?.focus()} />
      {!running && (
        <div className="termExited">
          <span>
            The shell exited with code {terminal.exitCode ?? '?'}. The scrollback stays until you close the tab.
          </span>
          <button type="button" className="btn sm" onClick={onNewHere}>
            New terminal here
          </button>
          <button type="button" className="btn sm ghost" onClick={onClose}>
            Close tab
          </button>
        </div>
      )}
    </div>
  )
}
