import { Eye, Folder, Plug } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  EffortLevel,
  PermissionBehavior,
  PermissionMode,
  Project,
  ProjectsResponse,
  QuestionAnswers,
  ScoredItem,
  SessionStatus,
} from '../../shared/protocol.js'
import { CommandPalette } from './components/CommandPalette.js'
import { Composer } from './components/Composer.js'
import { ConnectorsPage } from './components/ConnectorsPage.js'
import { QueuePanel, SessionsPanel } from './components/ContextPanel.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { InboxPage } from './components/InboxPage.js'
import { ItemPage } from './components/ItemPage.js'
import { NewSessionComposer, type NewSession, type SessionPreset } from './components/NewSessionComposer.js'
import { ProjectsPage } from './components/ProjectsPage.js'
import { Rail, type RailSection } from './components/Rail.js'
import { SystemModal, type SystemTab } from './components/SystemModal.js'
import { TabBand, type PageTab, type SessionTab } from './components/TabBand.js'
import { TopBar } from './components/TopBar.js'
import { Transcript } from './components/Transcript.js'
import { ADD_WATCH_KEY, REFINE_WATCH_KEY, WatchesPage } from './components/WatchesPage.js'
import { WorkspaceModal, type WorkspaceModalMode } from './components/WorkspaceModal.js'
import {
  itemHash,
  useConn,
  useEvents,
  useHashRoute,
  useOnboarded,
  useSessions,
  useWorkspaceId,
  useWorkspaces,
} from './hooks.js'
import { inboxStore, useInbox } from './inboxStore.js'
import { anyDialogOpen, isTypingTarget } from './keys.js'
import { EFFORT_LABEL, findModel, useModels } from './models.js'
import { store } from './store.js'
import { projectColor, useOpenTabs } from './tabs.js'

/** `/Users/you/Code/x` → `~/Code/x` — display only. */
const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'starting',
  running: 'working',
  idle: 'idle',
  error: 'error',
}

const PAGE_TABS: Record<'watches' | 'projects' | 'connectors', PageTab> = {
  watches: { key: 'page:watches', label: 'Watches', icon: Eye },
  projects: { key: 'page:projects', label: 'Projects', icon: Folder },
  connectors: { key: 'page:connectors', label: 'Connectors', icon: Plug },
}

export function App() {
  const conn = useConn()
  const sessions = useSessions()
  const models = useModels()
  const inbox = useInbox()
  const [route, navigate] = useHashRoute()
  const currentId = route.page === 'session' ? route.id : null
  const events = useEvents(currentId)
  const [preset, setPreset] = useState<SessionPreset | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [system, setSystem] = useState<{ open: boolean; tab: SystemTab }>({ open: false, tab: 'status' })
  const [composeSignal, setComposeSignal] = useState(0)
  const workspaces = useWorkspaces()
  const workspaceId = useWorkspaceId()
  const onboarded = useOnboarded()
  const [wsModal, setWsModal] = useState<WorkspaceModalMode | null>(null)
  const activeWorkspace = workspaces.find((w) => w.id === workspaceId) ?? null
  const { tabs, open: openTab, close: closeTab } = useOpenTabs(workspaceId)

  // First run: the workspace modal doubles as onboarding — introduce the
  // concept, name the default workspace, pick the Claude auth method.
  useEffect(() => {
    if (!onboarded && activeWorkspace) {
      setWsModal({ kind: 'onboarding', workspace: activeWorkspace })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded, activeWorkspace?.id])
  // pending "g" prefix for two-key sequences (g i, g s, g w, g p, g c)
  const goPrefix = useRef<number | undefined>(undefined)

  const current = sessions.find((s) => s.id === currentId) ?? null

  // The open inbox feeds the rail badge and the Queue panel from the start.
  useEffect(() => {
    if (conn === 'connected') void inboxStore.refresh()
  }, [conn])

  // A session created from this tab becomes the selected one.
  useEffect(() => store.onSessionCreated((s) => navigate(s.id)), [navigate])

  // Replay the log whenever the selection changes (and after a reconnect);
  // a visited session gets a tab.
  useEffect(() => {
    if (currentId) {
      store.subscribeSession(currentId)
      openTab(currentId)
    }
  }, [currentId, conn, openTab])

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

  const setFastMode = useCallback(
    (fastMode: boolean) => {
      if (currentId) store.send({ type: 'set_fast_mode', sessionId: currentId, fastMode })
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
      closeTab(sessionId)
      // Deleting what you are looking at leaves nothing to look at.
      if (sessionId === currentId) navigate('')
    },
    [currentId, navigate, closeTab],
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
    void inboxStore.refresh(true).finally(() => navigate('/inbox'))
  }, [navigate])

  const openItem = useCallback((id: string) => navigate(itemHash(id)), [navigate])

  const goTo = useCallback(
    (section: RailSection) => {
      if (section === 'inbox') navigate('/inbox')
      else if (section === 'sessions') navigate(currentId ?? '')
      else navigate(`/${section}`)
    },
    [navigate, currentId],
  )

  // Closing the tab you are on lands you on its neighbour, else the inbox.
  const closeSessionTab = useCallback(
    (id: string) => {
      if (id === currentId) {
        const i = tabs.indexOf(id)
        const next = tabs[i + 1] ?? tabs[i - 1]
        navigate(next ?? '/inbox')
      }
      closeTab(id)
    },
    [tabs, currentId, navigate, closeTab],
  )

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
        if (e.key === 's') return navigate(currentId ?? '')
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
        // In the inbox, `n` is "new work item"; everywhere else, a new session.
        if (route.page === 'inbox') setComposeSignal((n) => n + 1)
        else newSession()
      } else if (e.key === '?') {
        e.preventDefault()
        setHelpOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, newSession, currentId, route.page])

  const create = useCallback((s: NewSession) => {
    store.send({
      type: 'create_session',
      title: s.title,
      cwd: s.cwd,
      firstMessage: s.firstMessage || undefined,
      model: s.model,
      effort: s.effort,
      fastMode: s.fastMode,
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

  const dispatch = useCallback(
    (item: ScoredItem) => {
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
    },
    [navigate],
  )

  // --- derived shell state -------------------------------------------------

  const railActive: RailSection | null =
    route.page === 'inbox' || route.page === 'item'
      ? 'inbox'
      : route.page === 'home' || route.page === 'session'
        ? 'sessions'
        : route.page

  const sessionTabs = useMemo<SessionTab[]>(
    () =>
      tabs
        .map((id) => sessions.find((s) => s.id === id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
        .map((s) => ({
          id: s.id,
          title: s.title,
          color: projectColor(s.cwd),
          running: s.status === 'running' || s.status === 'starting',
        })),
    [tabs, sessions],
  )

  const activeTabKey =
    route.page === 'inbox' || route.page === 'item'
      ? 'inbox'
      : route.page === 'session'
        ? route.id
        : route.page === 'home'
          ? 'home'
          : PAGE_TABS[route.page].key
  const pageTab = route.page === 'watches' || route.page === 'projects' || route.page === 'connectors' ? PAGE_TABS[route.page] : null

  const runningCount = sessions.filter((s) => s.status === 'running' || s.status === 'starting').length
  const modelName = current ? findModel(models, current.model)?.name ?? current.model : undefined

  const panel =
    railActive === 'inbox' ? (
      <QueuePanel
        items={inbox.items}
        loaded={inbox.loaded}
        selectedId={route.page === 'item' ? route.id : null}
        onOpenItem={openItem}
        onAdd={() => {
          setComposeSignal((n) => n + 1)
          if (route.page !== 'inbox') navigate('/inbox')
        }}
        onRefresh={() => void inboxStore.refresh(true)}
        onSearch={() => setPaletteOpen(true)}
      />
    ) : (
      <SessionsPanel
        sessions={sessions}
        currentId={currentId}
        onSelect={navigate}
        onNew={newSession}
        onRename={renameSession}
        onSetPinned={setPinned}
        onDelete={deleteSession}
        onSearch={() => setPaletteOpen(true)}
      />
    )

  return (
    <div className="app">
      <TopBar
        workspaces={workspaces}
        workspaceId={workspaceId}
        conn={conn}
        onSwitchWorkspace={(id) => store.switchWorkspace(id)}
        onNewWorkspace={() => setWsModal({ kind: 'create' })}
        onWorkspaceSettings={() => activeWorkspace && setWsModal({ kind: 'settings', workspace: activeWorkspace })}
        onOpenSystem={(tab) => setSystem({ open: true, tab })}
        onHelp={() => setHelpOpen(true)}
      />

      <div className="shell">
        <Rail
          active={railActive}
          inboxCount={inbox.items.length}
          runningCount={runningCount}
          workspaceColor={activeWorkspace?.color}
          conn={conn}
          onGo={goTo}
        />

        {panel}

        <div id="main">
          <TabBand
            activeKey={activeTabKey}
            sessionTabs={sessionTabs}
            pageTab={pageTab}
            onInbox={() => navigate('/inbox')}
            onSelect={navigate}
            onClose={closeSessionTab}
            onNew={newSession}
          />

          <div className="content">
            {route.page === 'inbox' ? (
              <InboxPage
                onDispatch={dispatch}
                onRefineWatch={refineWatch}
                onOpenItem={openItem}
                composeSignal={composeSignal}
              />
            ) : route.page === 'item' ? (
              <ItemPage key={route.id} id={route.id} onDispatch={dispatch} onNavigate={navigate} />
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
                  <span id="chatTitle" title={current.title}>
                    {current.title}
                  </span>
                  <span className="pills">
                    {modelName && (
                      <span className="pill" title="Model · effort">
                        {modelName}
                        {current.effort ? ` · ${EFFORT_LABEL[current.effort].toLowerCase()}` : ''}
                      </span>
                    )}
                    <span className="pill mono" title={current.cwd}>
                      <span className="t">{homely(current.cwd)}</span>
                      {current.branch ? ` · ${current.branch}` : ''}
                    </span>
                  </span>
                  <span className={`state ${current.status}`}>
                    <span
                      className={`dot ${
                        current.status === 'running' || current.status === 'starting'
                          ? 'live'
                          : current.status === 'error'
                            ? 'red'
                            : 'green'
                      }`}
                    />
                    {STATUS_LABEL[current.status]}
                  </span>
                </div>
                <Transcript key={current.id} sessionId={current.id} events={events} onRespond={respond} />
                <Composer
                  key={`composer-${current.id}`}
                  status={current.status}
                  model={current.model}
                  effort={current.effort}
                  fastMode={current.fastMode}
                  fastModeState={current.fastModeState}
                  fastModeDisabledReason={current.fastModeDisabledReason}
                  permissionMode={current.permissionMode}
                  onSend={sendMessage}
                  onInterrupt={interrupt}
                  onModelChange={setModel}
                  onFastModeChange={setFastMode}
                  onPermissionModeChange={setPermissionMode}
                />
              </>
            ) : (
              <div id="empty">Session not found — it may have been deleted.</div>
            )}
          </div>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        sessions={sessions}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
        onNewSession={newSession}
        onOpenItem={(item) => openItem(item.id)}
        onNewSessionIn={newSessionIn}
        onSyncInbox={syncInbox}
        onAddWatch={addWatch}
        onHelp={() => setHelpOpen(true)}
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <SystemModal
        open={system.open}
        initialTab={system.tab}
        conn={conn}
        onClose={() => setSystem((s) => ({ ...s, open: false }))}
      />
      <WorkspaceModal mode={wsModal} onClose={() => setWsModal(null)} />
    </div>
  )
}
