import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  EffortLevel,
  PermissionBehavior,
  PermissionMode,
  Project,
  ProjectsResponse,
  QuestionAnswers,
  ScoredItem,
} from '../../shared/protocol.js'
import { CommandPalette } from './components/CommandPalette.js'
import { Composer } from './components/Composer.js'
import { ConnectorsPage } from './components/ConnectorsPage.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { InboxPage } from './components/InboxPage.js'
import { ProjectsPage } from './components/ProjectsPage.js'
import {
  NewSessionComposer,
  type NewSession,
  type SessionPreset,
} from './components/NewSessionComposer.js'
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
    (requestId: string, behavior: PermissionBehavior, answers?: QuestionAnswers) => {
      if (currentId)
        store.send({ type: 'permission_response', sessionId: currentId, requestId, behavior, answers })
    },
    [currentId],
  )

  const sendMessage = useCallback(
    (text: string) => {
      if (currentId) store.send({ type: 'user_message', sessionId: currentId, text })
    },
    [currentId],
  )

  const setModel = useCallback(
    (model: string | undefined, effort: EffortLevel | undefined) => {
      if (currentId) store.send({ type: 'set_model', sessionId: currentId, model, effort })
    },
    [currentId],
  )

  const setPermissionMode = useCallback(
    (mode: PermissionMode) => {
      if (currentId) store.send({ type: 'set_permission_mode', sessionId: currentId, mode })
    },
    [currentId],
  )

  const interrupt = useCallback(() => {
    if (currentId) store.send({ type: 'interrupt', sessionId: currentId })
  }, [currentId])

  const renameSession = useCallback((sessionId: string, title: string) => {
    store.send({ type: 'rename_session', sessionId, title })
  }, [])

  const setPinned = useCallback((sessionId: string, pinned: boolean) => {
    store.send({ type: 'set_pinned', sessionId, pinned })
  }, [])

  const deleteSession = useCallback(
    (sessionId: string) => {
      store.send({ type: 'delete_session', sessionId })
      // Deleting what you are looking at leaves nothing to look at.
      if (sessionId === currentId) navigate('')
    },
    [currentId, navigate],
  )

  const newSession = useCallback(() => {
    setPreset(null)
    navigate('')
  }, [navigate])

  const newSessionIn = useCallback(
    (project: Project) => {
      setPreset({ title: '', firstMessage: '', cwd: project.path })
      navigate('')
    },
    [navigate],
  )

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
      model: s.model,
      effort: s.effort,
      permissionMode: s.permissionMode,
    })
    setPreset(null)
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
      const isManual = item.source === 'manual'
      const lines = isManual
        ? [
            'Work item from the triage inbox — a to-do you added:',
            item.title,
            ...(item.url ? [item.url] : []),
            ...(item.why ? [`Note: ${item.why}`] : []),
          ]
        : [
            `Work item from the triage inbox — ${item.kind}:`,
            item.title,
            item.url,
            `Why it ranked: ${item.reason}`,
            '',
            'Use `gh` to pull the full context (diff, comments, CI) and get started.',
          ]
      setPreset({ title: item.title.slice(0, 80), cwd, firstMessage: lines.join('\n') })
      navigate('')
    }
    // An explicit project (manual items) decides the folder; otherwise a project
    // tied to the item's repo does.
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (!b.ok) return openWith()
        const match =
          (item.projectId && b.projects.find((p) => p.id === item.projectId)) ||
          (item.repo && b.projects.find((p) => p.repo && p.repo === item.repo))
        openWith(match ? match.path : undefined)
      })
      .catch(() => openWith())
  }, [navigate])

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
        onRename={renameSession}
        onSetPinned={setPinned}
        onDelete={deleteSession}
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
        ) : route.page === 'home' ? (
          <NewSessionComposer preset={preset} onCreate={create} />
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
              model={current.model}
              effort={current.effort}
              permissionMode={current.permissionMode}
              onSend={sendMessage}
              onInterrupt={interrupt}
              onModelChange={setModel}
              onPermissionModeChange={setPermissionMode}
            />
          </>
        ) : (
          <div id="empty">Session not found →</div>
        )}
      </div>

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
