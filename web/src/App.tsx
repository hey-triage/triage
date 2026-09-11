import { Eye, Folder, PenLine, Plug, Terminal as TerminalIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type {
  EffortLevel,
  ImageAttachment,
  PermissionBehavior,
  PermissionMode,
  Project,
  ProjectsResponse,
  QuestionAnswers,
  ScoredItem,
  SessionStatus,
  TerminalSummary,
} from '../../shared/protocol.js'
import { CommandPalette } from './components/CommandPalette.js'
import { Composer } from './components/Composer.js'
import { ConnectorsPage } from './components/ConnectorsPage.js'
import { NewTerminalMenu, QueuePanel, SessionsPanel, TerminalsPanel } from './components/ContextPanel.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { InboxPage } from './components/InboxPage.js'
import { ItemPage } from './components/ItemPage.js'
import { NewSessionComposer, type NewSession } from './components/NewSessionComposer.js'
import { ProjectsPage } from './components/ProjectsPage.js'
import { Rail, type RailSection } from './components/Rail.js'
import { SettingsModal } from './components/SettingsModal.js'
import { SystemModal, type SystemTab } from './components/SystemModal.js'
import { TabBand, type OpenTab, type PageTab } from './components/TabBand.js'
import { dispatchPrompt, dispatchTitle } from './dispatch.js'
import { draftStore, draftTitle, useDrafts } from './drafts.js'
import { TerminalPage } from './components/TerminalPage.js'
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
  useTerminals,
  useWorkspaceId,
  useWorkspaces,
} from './hooks.js'
import { inboxStore, useInbox } from './inboxStore.js'
import { anyDialogOpen, isTypingTarget } from './keys.js'
import { EFFORT_LABEL, findModel, useModels } from './models.js'
import { openSettings } from './settings.js'
import { store } from './store.js'
import { usePanelWidth } from './panelWidth.js'
import { projectColor, useOpenTabs } from './tabs.js'

/** `/Users/you/Code/x` → `~/Code/x` — display only. */
const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'starting',
  running: 'working',
  idle: 'idle',
  error: 'error',
}

const PAGE_TABS: Record<'watches' | 'projects' | 'connectors' | 'terminals', PageTab> = {
  terminals: { key: 'page:terminals', label: 'Terminals', icon: TerminalIcon },
  watches: { key: 'page:watches', label: 'Watches', icon: Eye },
  projects: { key: 'page:projects', label: 'Projects', icon: Folder },
  connectors: { key: 'page:connectors', label: 'Connectors', icon: Plug },
}

export function App() {
  const conn = useConn()
  const sessions = useSessions()
  const terminals = useTerminals()
  const drafts = useDrafts()
  const models = useModels()
  const inbox = useInbox()
  const [route, navigate] = useHashRoute()
  const currentId = route.page === 'session' ? route.id : null
  const currentTerminalId = route.page === 'terminal' ? route.id : null
  const currentDraftId = route.page === 'draft' ? route.id : null
  const events = useEvents(currentId)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [system, setSystem] = useState<{ open: boolean; tab: SystemTab }>({ open: false, tab: 'status' })
  const [composeSignal, setComposeSignal] = useState(0)
  const workspaces = useWorkspaces()
  const workspaceId = useWorkspaceId()
  const onboarded = useOnboarded()
  const [wsModal, setWsModal] = useState<WorkspaceModalMode | null>(null)
  const activeWorkspace = workspaces.find((w) => w.id === workspaceId) ?? null
  const { tabs, open: openTab, close: closeTab, replace: replaceTab } = useOpenTabs(workspaceId)
  const panelSize = usePanelWidth()

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
  const currentTerminal = terminals.find((t) => t.id === currentTerminalId) ?? null
  const currentDraft = drafts.find((d) => d.id === currentDraftId) ?? null
  const termKey = (id: string) => `term:${id}`
  const draftKey = (id: string) => `draft:${id}`
  const draftRoute = (id: string) => `/new/${id}`
  // Drafts are per workspace; bind before anything reads them.
  useEffect(() => draftStore.bind(workspaceId), [workspaceId])
  // The old home route: the inbox is the product's home now.
  useEffect(() => {
    if (route.page === 'home') navigate('/inbox')
  }, [route.page, navigate])

  // `#/settings/<tab>` is a door, not a page: open the modal on that tab and
  // put the URL back on whatever was underneath (the inbox on a cold load).
  const lastPageHash = useRef('/inbox')
  useEffect(() => {
    if (route.page === 'settings') {
      openSettings(route.tab)
      navigate(lastPageHash.current)
    } else if (route.page !== 'home') {
      lastPageHash.current = location.hash.slice(1) || '/inbox'
    }
  }, [route, navigate])

  // The open inbox feeds the rail badge and the Queue panel from the start.
  useEffect(() => {
    if (conn === 'connected') void inboxStore.refresh()
  }, [conn])

  // A session created from this tab becomes the selected one — and when it
  // came from a draft tab, it takes that tab's slot.
  const pendingDraft = useRef<string | null>(null)
  useEffect(
    () =>
      store.onSessionCreated((s) => {
        const d = pendingDraft.current
        pendingDraft.current = null
        if (d) {
          replaceTab(draftKey(d), s.id)
          draftStore.remove(d)
        }
        navigate(s.id)
      }),
    [navigate, replaceTab],
  )
  useEffect(() => store.onTerminalCreated((t) => navigate(`/terminal/${t.id}`)), [navigate])

  // A visited terminal or draft gets a tab too.
  useEffect(() => {
    if (currentTerminalId) openTab(termKey(currentTerminalId))
  }, [currentTerminalId, openTab])
  useEffect(() => {
    if (currentDraftId) openTab(draftKey(currentDraftId))
  }, [currentDraftId, openTab])

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
    (text: string, images?: ImageAttachment[]) => {
      if (currentId) store.send({ type: 'user_message', sessionId: currentId, text, images })
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

  // New session = a draft tab. An untouched draft is reused rather than
  // stacking blank tabs; a folder-specific one is always fresh.
  const newSession = useCallback(() => {
    const d = draftStore.findEmpty() ?? draftStore.create()
    navigate(draftRoute(d.id))
  }, [navigate])

  const newSessionIn = useCallback(
    (project: Project) => {
      const d = draftStore.create({ cwd: project.path })
      navigate(draftRoute(d.id))
    },
    [navigate],
  )

  const discardDraft = useCallback(
    (id: string) => {
      draftStore.remove(id)
      closeTab(draftKey(id))
      if (id === currentDraftId) navigate('/inbox')
    },
    [closeTab, currentDraftId, navigate],
  )

  const syncInbox = useCallback(() => {
    void inboxStore.refresh(true).finally(() => navigate('/inbox'))
  }, [navigate])

  const openItem = useCallback((id: string) => navigate(itemHash(id)), [navigate])

  // Terminals: open in a folder (the server falls back to home), rename, kill.
  const newTerminal = useCallback((cwd?: string) => {
    store.send({ type: 'terminal_create', cwd })
  }, [])
  const renameTerminal = useCallback((terminalId: string, title: string) => {
    store.send({ type: 'terminal_rename', terminalId, title })
  }, [])
  const closeTerminal = useCallback(
    (terminalId: string) => {
      store.send({ type: 'terminal_close', terminalId })
      closeTab(termKey(terminalId))
      if (terminalId === currentTerminalId) {
        const rest = terminals.filter((t) => t.id !== terminalId)
        navigate(rest.length ? `/terminal/${rest[rest.length - 1].id}` : '/terminals')
      }
    },
    [closeTab, currentTerminalId, terminals, navigate],
  )
  // Where "+" opens a shell: the folder of whatever tab is in front.
  const terminalCwd = current?.cwd ?? currentTerminal?.cwd ?? currentDraft?.cwd

  const goTo = useCallback(
    (section: RailSection) => {
      if (section === 'inbox') navigate('/inbox')
      else if (section === 'sessions') {
        // The session in front, else the last session tab, else a fresh draft.
        const last = currentId ?? [...tabs].reverse().find((k) => sessions.some((s) => s.id === k))
        if (last) navigate(last)
        else newSession()
      } else if (section === 'terminals') {
        const last = currentTerminalId ?? terminals[terminals.length - 1]?.id
        navigate(last ? `/terminal/${last}` : '/terminals')
      } else navigate(`/${section}`)
    },
    [navigate, currentId, currentTerminalId, terminals, tabs, sessions, newSession],
  )

  // Closing the tab you are on lands you on its neighbour, else the inbox.
  // A terminal tab closing does not kill the shell — that is the panel's menu.
  const activeTabKey =
    route.page === 'inbox' || route.page === 'item'
      ? 'inbox'
      : route.page === 'session'
        ? route.id
        : route.page === 'terminal'
          ? termKey(route.id)
          : route.page === 'draft'
            ? draftKey(route.id)
            : route.page === 'home' || route.page === 'settings'
              ? 'home'
              : PAGE_TABS[route.page].key
  const tabRoute = (key: string) =>
    key.startsWith('term:') ? `/terminal/${key.slice(5)}` : key.startsWith('draft:') ? draftRoute(key.slice(6)) : key
  const closeOpenTab = useCallback(
    (key: string) => {
      if (key === activeTabKey) {
        const i = tabs.indexOf(key)
        const next = tabs[i + 1] ?? tabs[i - 1]
        navigate(next ? tabRoute(next) : '/inbox')
      }
      // Closing a draft tab discards the draft — there is nowhere else it lives.
      if (key.startsWith('draft:')) draftStore.remove(key.slice(6))
      closeTab(key)
    },
    [tabs, activeTabKey, navigate, closeTab],
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
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setHelpOpen(false)
        setPaletteOpen(false)
        openSettings()
        return
      }
      if (isTypingTarget(e) || anyDialogOpen() || e.metaKey || e.ctrlKey || e.altKey) return

      if (goPrefix.current !== undefined) {
        clearTimeout(goPrefix.current)
        goPrefix.current = undefined
        if (e.key === 'i') return navigate('/inbox')
        if (e.key === 's') return goTo('sessions')
        if (e.key === 't') return goTo('terminals')
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
        // In the inbox, `n` is "new work item"; among terminals, a new shell;
        // everywhere else, a new session.
        if (route.page === 'inbox') setComposeSignal((n) => n + 1)
        else if (route.page === 'terminal' || route.page === 'terminals') newTerminal(terminalCwd)
        else newSession()
      } else if (e.key === '?') {
        e.preventDefault()
        setHelpOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, newSession, newTerminal, terminalCwd, goTo, currentId, route.page])

  const create = useCallback((draftId: string, s: NewSession) => {
    pendingDraft.current = draftId
    store.send({
      type: 'create_session',
      title: s.title,
      cwd: s.cwd,
      firstMessage: s.firstMessage || undefined,
      model: s.model,
      effort: s.effort,
      fastMode: s.fastMode,
      permissionMode: s.permissionMode,
      images: s.images,
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

  const dispatch = useCallback(
    (item: ScoredItem) => {
      const openWith = (cwd?: string) => {
        const d = draftStore.create({ label: dispatchTitle(item), cwd, text: dispatchPrompt(item) })
        navigate(draftRoute(d.id))
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
      : route.page === 'home' || route.page === 'session' || route.page === 'draft'
        ? 'sessions'
        : route.page === 'terminal'
          ? 'terminals'
          : route.page === 'settings'
            ? null
            : route.page

  const openTabs = useMemo<OpenTab[]>(
    () =>
      tabs.flatMap((key): OpenTab[] => {
        if (key.startsWith('draft:')) {
          const d = drafts.find((x) => x.id === key.slice(6))
          return d ? [{ key, kind: 'draft', title: draftTitle(d), color: 'var(--stone)', running: false }] : []
        }
        if (key.startsWith('term:')) {
          const t: TerminalSummary | undefined = terminals.find((x) => x.id === key.slice(5))
          return t ? [{ key, kind: 'terminal', title: t.title, color: projectColor(t.cwd), running: t.status === 'running' }] : []
        }
        const s = sessions.find((x) => x.id === key)
        return s
          ? [{ key, kind: 'session', title: s.title, color: projectColor(s.cwd), running: s.status === 'running' || s.status === 'starting' }]
          : []
      }),
    [tabs, sessions, terminals, drafts],
  )

  const pageTab =
    route.page === 'watches' || route.page === 'projects' || route.page === 'connectors' || route.page === 'terminals'
      ? PAGE_TABS[route.page]
      : null

  const runningCount = sessions.filter((s) => s.status === 'running' || s.status === 'starting').length
  const modelName = current ? findModel(models, current.model)?.name ?? current.model : undefined

  const panel =
    railActive === 'terminals' ? (
      <TerminalsPanel
        terminals={terminals}
        currentId={currentTerminalId}
        defaultCwd={terminalCwd}
        onSelect={(id) => navigate(`/terminal/${id}`)}
        onNew={newTerminal}
        onRename={renameTerminal}
        onClose={closeTerminal}
        onSearch={() => setPaletteOpen(true)}
      />
    ) : railActive === 'inbox' ? (
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
        drafts={drafts}
        currentDraftId={currentDraftId}
        onSelectDraft={(id) => navigate(draftRoute(id))}
        onDiscardDraft={discardDraft}
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
        onWorkspaceSettings={() => openSettings('workspace')}
        onOpenSystem={(tab) => setSystem({ open: true, tab })}
        onOpenSettings={() => openSettings()}
        onHelp={() => setHelpOpen(true)}
      />

      <div
        className={`shell${panelSize.dragging ? ' resizing' : ''}`}
        style={{ '--panel-w': `${panelSize.width}px` } as CSSProperties}
      >
        <Rail
          active={railActive}
          inboxCount={inbox.items.length}
          runningCount={runningCount}
          terminalCount={terminals.filter((t) => t.status === 'running').length}
          workspaceColor={activeWorkspace?.color}
          conn={conn}
          onGo={goTo}
        />

        {panel}
        <div
          className="panelResize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the panel (double-click to reset)"
          title="Drag to resize · double-click to reset"
          {...panelSize.handleProps}
        />

        <div id="main">
          <TabBand
            activeKey={activeTabKey}
            tabs={openTabs}
            pageTab={pageTab}
            onInbox={() => navigate('/inbox')}
            onSelect={(key) => navigate(tabRoute(key))}
            onClose={closeOpenTab}
            onNew={newSession}
            onNewTerminal={newTerminal}
            terminalCwd={terminalCwd}
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
            ) : route.page === 'terminal' ? (
              currentTerminal ? (
                <TerminalPage
                  key={currentTerminal.id}
                  terminal={currentTerminal}
                  onRename={(title) => renameTerminal(currentTerminal.id, title)}
                  onClose={() => closeTerminal(currentTerminal.id)}
                  onNewHere={() => newTerminal(currentTerminal.cwd)}
                />
              ) : (
                <div id="empty">Terminal not found — it may have been closed.</div>
              )
            ) : route.page === 'terminals' ? (
              <div className="termHome">
                <div className="glow green" aria-hidden="true" />
                <h2 className="display">Terminals.</h2>
                <p>
                  A real shell, run by the daemon in a project folder. It lands as a tab beside your
                  sessions, and anything you start in it keeps running while you look elsewhere.
                </p>
                <div className="choices">
                  <NewTerminalMenu defaultCwd={terminalCwd} onNew={newTerminal} className="btn primary" />
                </div>
              </div>
            ) : route.page === 'watches' ? (
              <WatchesPage />
            ) : route.page === 'connectors' ? (
              <ConnectorsPage />
            ) : route.page === 'projects' ? (
              <ProjectsPage />
            ) : route.page === 'draft' ? (
              currentDraft ? (
                <NewSessionComposer
                  key={currentDraft.id}
                  draft={currentDraft}
                  onChange={(patch) => draftStore.update(currentDraft.id, patch)}
                  onCreate={(s) => create(currentDraft.id, s)}
                />
              ) : (
                <div id="empty">This draft was discarded.</div>
              )
            ) : route.page === 'home' || route.page === 'settings' ? null : current ? (
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
                  cwd={current.cwd}
                  branch={current.branch}
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
        terminals={terminals}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
        onNewSession={newSession}
        onNewTerminal={() => newTerminal(terminalCwd)}
        onOpenItem={(item) => openItem(item.id)}
        onNewSessionIn={newSessionIn}
        onSyncInbox={syncInbox}
        onAddWatch={addWatch}
        onOpenSettings={(tab) => openSettings(tab)}
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
      <SettingsModal
        workspace={activeWorkspace}
        onNavigate={navigate}
        onOpenSystem={(tab) => setSystem({ open: true, tab })}
      />
    </div>
  )
}
