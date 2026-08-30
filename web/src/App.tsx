import { useCallback, useEffect, useRef, useState } from 'react'
import type { PermissionBehavior, Project, ProjectsResponse, ScoredItem } from '../../shared/protocol.js'
import { CommandPalette } from './components/CommandPalette.js'
import { Composer } from './components/Composer.js'
import { ConnectorsPage } from './components/ConnectorsPage.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { InboxPage } from './components/InboxPage.js'
import { ProjectsPage } from './components/ProjectsPage.js'
import {
  NewSessionDialog,
  type NewSession,
  type SessionPreset,
} from './components/NewSessionDialog.js'
import { Sidebar } from './components/Sidebar.js'
import { Transcript } from './components/Transcript.js'
import { ADD_WATCH_KEY, REFINE_WATCH_KEY, WatchesPage } from './components/WatchesPage.js'
import { useConn, useEvents, useHashRoute, useSessions } from './hooks.js'
import { anyDialogOpen, isTypingTarget } from './keys.js'
import { store } from './store.js'

export function App() {
  const conn = useConn()
  const sessions = useSessions()
  const [route, navigate] = useHashRoute()
  const currentId = route.page === 'session' ? route.id : null
  const events = useEvents(currentId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [preset, setPreset] = useState<SessionPreset | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [inboxNonce, setInboxNonce] = useState(0)
  // pending "g" prefix for two-key sequences (g i, g c)
  const goPrefix = useRef<number | undefined>(undefined)

  const current = sessions.find((s) => s.id === currentId) ?? null

  // A session created from this tab becomes the selected one.
  useEffect(() => store.onSessionCreated((s) => navigate(s.id)), [navigate])

  // Replay the log whenever the selection changes (and after a reconnect).
  useEffect(() => {
    if (currentId) store.subscribeSession(currentId)
  }, [currentId, conn])

  const respond = useCallback(
    (requestId: string, behavior: PermissionBehavior) => {
      if (currentId) store.send({ type: 'permission_response', sessionId: currentId, requestId, behavior })
    },
    [currentId],
  )

  const sendMessage = useCallback(
    (text: string) => {
      if (currentId) store.send({ type: 'user_message', sessionId: currentId, text })
    },
    [currentId],
  )

  const interrupt = useCallback(() => {
    if (currentId) store.send({ type: 'interrupt', sessionId: currentId })
  }, [currentId])

  const newSession = useCallback(() => {
    setPreset(null)
    setDialogOpen(true)
  }, [])

  const newSessionIn = useCallback((project: Project) => {
    setPreset({ title: '', firstMessage: '', cwd: project.path })
    setDialogOpen(true)
  }, [])

  const syncInbox = useCallback(() => {
    // Bust the server cache, then (re)mount the inbox so it renders the result.
    void fetch('/api/inbox?refresh=1').finally(() => {
      setInboxNonce((n) => n + 1)
      navigate('/inbox')
    })
  }, [navigate])

  // Global hotkeys. ⌘K works everywhere (even in inputs); single keys only
  // outside text fields and while no dialog is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setHelpOpen(false)
        setPaletteOpen((v) => !v)
        return
      }
      if (isTypingTarget(e) || anyDialogOpen() || e.metaKey || e.ctrlKey || e.altKey) return

      if (goPrefix.current !== undefined) {
        clearTimeout(goPrefix.current)
        goPrefix.current = undefined
        if (e.key === 'i') return navigate('/inbox')
        if (e.key === 'c') return navigate('/connectors')
        if (e.key === 'p') return navigate('/projects')
        if (e.key === 'w') return navigate('/watches')
        return // unknown sequence — swallow
      }
      if (e.key === 'g') {
        goPrefix.current = window.setTimeout(() => (goPrefix.current = undefined), 1000)
        return
      }
      if (e.key === 'n') {
        e.preventDefault()
        newSession()
      } else if (e.key === '?') {
        e.preventDefault()
        setHelpOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, newSession])

  const create = useCallback((s: NewSession) => {
    store.send({
      type: 'create_session',
      title: s.title,
      cwd: s.cwd,
      firstMessage: s.firstMessage || undefined,
    })
  }, [])

  const addWatch = useCallback(() => {
    sessionStorage.setItem(ADD_WATCH_KEY, '1')
    navigate('/watches')
  }, [navigate])

  // Thumbs-down on a matched item: the correction lands as appended text on
  // the watch's instruction — the rule stays human-readable.
  const refineWatch = useCallback(
    (item: ScoredItem) => {
      if (!item.watchId) return
      sessionStorage.setItem(REFINE_WATCH_KEY, JSON.stringify({ watchId: item.watchId, note: item.title }))
      navigate('/watches')
    },
    [navigate],
  )

  const dispatch = useCallback((item: ScoredItem) => {
    const openWith = (cwd?: string) => {
      setPreset({
        title: item.title.slice(0, 80),
        cwd,
        firstMessage: [
          `Work item from the triage inbox — ${item.kind}:`,
          `${item.title}`,
          item.url,
          `Why it ranked: ${item.reason}`,
          '',
          'Use `gh` to pull the full context (diff, comments, CI) and get started.',
        ].join('\n'),
      })
      setDialogOpen(true)
    }
    // A project tied to the item's repo decides where the session runs.
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        const match = b.ok ? b.projects.find((p) => p.repo && p.repo === item.repo) : undefined
        openWith(match?.path)
      })
      .catch(() => openWith())
  }, [])

  return (
    <>
      <Sidebar
        sessions={sessions}
        currentId={currentId}
        inboxActive={route.page === 'inbox'}
        watchesActive={route.page === 'watches'}
        projectsActive={route.page === 'projects'}
        connectorsActive={route.page === 'connectors'}
        conn={conn}
        onSelect={navigate}
        onNew={newSession}
        onInbox={() => navigate('/inbox')}
        onWatches={() => navigate('/watches')}
        onProjects={() => navigate('/projects')}
        onConnectors={() => navigate('/connectors')}
      />

      <div id="main" className={current?.status === 'running' ? 'running' : undefined}>
        {route.page === 'inbox' ? (
          <InboxPage key={inboxNonce} onDispatch={dispatch} onRefineWatch={refineWatch} />
        ) : route.page === 'watches' ? (
          <WatchesPage />
        ) : route.page === 'connectors' ? (
          <ConnectorsPage />
        ) : route.page === 'projects' ? (
          <ProjectsPage />
        ) : current ? (
          <>
            <div id="chatHeader">
              <span id="chatTitle">{current.title}</span>
              <span id="chatMeta">{current.model ?? ''}</span>
            </div>
            <Transcript
              key={current.id}
              sessionId={current.id}
              events={events}
              onRespond={respond}
            />
            <Composer
              key={`composer-${current.id}`}
              status={current.status}
              cwd={current.cwd}
              branch={current.branch}
              onSend={sendMessage}
              onInterrupt={interrupt}
            />
          </>
        ) : (
          <div id="empty">Start a session to dispatch work to Claude Code →</div>
        )}
      </div>

      <NewSessionDialog
        open={dialogOpen}
        preset={preset}
        onClose={() => setDialogOpen(false)}
        onCreate={create}
      />

      <CommandPalette
        open={paletteOpen}
        sessions={sessions}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
        onNewSession={newSession}
        onDispatch={dispatch}
        onNewSessionIn={newSessionIn}
        onSyncInbox={syncInbox}
        onAddWatch={addWatch}
        onHelp={() => setHelpOpen(true)}
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  )
}
