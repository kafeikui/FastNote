import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Editor } from '@tiptap/core';
import {
  ApiAuthError,
  ApiClient,
  loadServerUrl,
  loadSession,
  saveServerUrl,
  saveSession,
  loadChatMessages,
  loadChatSessions,
  saveChatSessions,
  loadChatUnread,
  saveChatUnread,
  loadChatNotificationSettings,
  saveChatNotificationSettings,
  loadUiTheme,
  saveUiTheme,
  loadProxySettings,
  saveProxySettings,
  proxyRulesFromSettings,
  loadNoteWidth,
  saveNoteWidth,
  NOTE_WIDTH_MIN,
  NOTE_WIDTH_MAX,
  NOTE_WIDTH_DEFAULT,
  loadSidebarCollapsed,
  saveSidebarCollapsed,
  loadSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT,
  loadCollapsedFolderIds,
  saveCollapsedFolderIds,
  loadTreeSortMode,
  saveTreeSortMode,
  loadShowLineNumbers,
  saveShowLineNumbers,
  loadEnableMath,
  saveEnableMath,
  loadAiPanelOpen,
  saveAiPanelOpen,
  loadTabState,
  saveTabState,
  defaultTabState,
  loadGroupSplitRatio,
  saveGroupSplitRatio,
  GROUP_SPLIT_RATIO_MIN,
  GROUP_SPLIT_RATIO_MAX,
  loadShortcuts,
  saveShortcuts,
  loadStorageNamespace,
  saveStorageNamespace,
  loadStoragePathLabel,
  saveStoragePathLabel,
  namespaceFromPath,
  ensureLegacyVaultInRegistry,
  loadVaultRegistry,
  saveVaultRegistry,
  createVaultRegistryEntry,
  type ProxySettings,
} from '@fastnote/api';
import {
  deriveKeysFromPassword,
  encryptString,
  decryptString,
  encryptStringNative,
  decryptStringNative,
  generateIdentityKeypair,
  generateSalt,
  hashContent,
  packEncrypted,
  unpackEncrypted,
  toBase64,
  fromBase64,
  wrapKey,
  unwrapKey,
} from '@fastnote/crypto';
import { NoteEditor, flushEditorMarkdown } from '@fastnote/editor';
import {
  AnthropicClient,
  AnthropicTimeoutError,
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  AiAttachmentError,
  prepareAiAttachment,
  type AiChatMessage,
  type AiContentBlock,
} from '@fastnote/ai';
import { IMClient, verifyExchangeKeypair } from '@fastnote/im';
import { CollabSession, generateCollabRoomCode, normalizeCollabRoomCode, type CollabStatus } from '@fastnote/collab';
import { NoteSearchIndex } from '@fastnote/search';
import type { ChatMessage, EditorMode, NodeType, NoteAttachment, NoteNode, UserSession, TreeDropPosition, ChatAttachmentRef, ChatWireAttachment, TabGroupState, ShortcutBindings, AiSettings, AiSessionNode, AiMessage, AiAttachment, FindReplaceController } from '@fastnote/shared';
import { META_KEYS, downloadBlob, isEditableContentNode, computeTreeMove, applySortMode, buildAttachmentMarkdownRef, buildTree, decodeChatWire, toStoredPayload, storedToChatMessage, serverUrlNeedsReload, matchesShortcut, expandAttachmentRefsForExport, installConsoleCapture, getCapturedLogs, clearCapturedLogs, formatCapturedLogs } from '@fastnote/shared';
import type { TreeItem } from '@fastnote/shared';
import type { TreeSortMode } from '@fastnote/shared';
import { createStorage } from '@fastnote/storage';
import { SyncClient } from '@fastnote/sync';
import { I18nProvider, loadLocale, saveLocale, translate, type Locale, type TFunction } from '@fastnote/i18n';
import {
  TableEditor,
  createEmptyTable,
  parseTableDocument,
  serializeTable,
  tableToSearchText,
  exportTableCsv,
  exportEncryptedTableFile,
  buildFnxtBytes,
  downloadTextFile,
  downloadBinaryFile,
  importFnxtFile,
  importCsvFile,
  importTableCsv,
} from '@fastnote/table';
import {
  AppShell,
  UnlockScreen,
  NoteTree,
  TreeToolbar,
  TabBar,
  EditorToolbar,
  SettingsModal,
  AuthModal,
  ChatPanel,
  ChatSidebar,
  buildChatSessions,
  playChatNotificationSound,
  AboutModal,
  LogsModal,
  InlineInputBar,
  AiSessionTree,
  AiWorkbench,
  VaultTransferModal,
  FindReplaceBar,
  NoteAttachments,
  DropdownMenu,
  type VaultListItem,
} from '@fastnote/ui';

type VaultKeys = Awaited<ReturnType<typeof deriveKeysFromPassword>>;
type AppView = 'notes' | 'chat';

const SAVE_DEBOUNCE_MS = 500;

/** sessionStorage key: which unlock tab to reopen after a server-change page reload. */
const UNLOCK_TAB_HINT_KEY = 'fastnote_unlock_tab';

function chatStatusRank(status: ChatMessage['status']): number {
  return status === 'read' ? 2 : status === 'delivered' ? 1 : 0;
}

function newNode(nodeType: NodeType, parentId: string | null, sortOrder: number, locale: Locale): NoteNode {
  const now = new Date().toISOString();
  const contentMd =
    nodeType === 'table' ? serializeTable(createEmptyTable(locale)) : '';
  return {
    id: crypto.randomUUID(),
    parentId,
    nodeType,
    title:
      nodeType === 'folder'
        ? translate(locale, 'noteTree.untitledFolder')
        : nodeType === 'table'
          ? translate(locale, 'noteTree.untitledTable')
          : translate(locale, 'noteTree.untitledNote'),
    contentMd,
    sortOrder,
    version: 1,
    serverVersion: 0,
    contentHash: hashContent(contentMd),
    syncStatus: 'pending',
    deleted: false,
    updatedAt: now,
  };
}

function buildUpdated(current: NoteNode, patch: Partial<NoteNode>): NoteNode {
  const contentMd = patch.contentMd ?? current.contentMd;
  return {
    ...current,
    ...patch,
    version: current.version + 1,
    contentHash: hashContent(contentMd),
    syncStatus: 'pending',
    updatedAt: new Date().toISOString(),
  };
}

function noteSearchBody(note: NoteNode): string {
  if (note.nodeType === 'table') {
    return tableToSearchText(parseTableDocument(note.contentMd));
  }
  return note.contentMd;
}

// Start capturing console output as early as possible (module load), so the log viewer in the
// toolbar has the full history — the packaged desktop app has no DevTools to fall back to.
installConsoleCapture();

export function VaultApp() {
  const [storageEpoch, setStorageEpoch] = useState(0);
  const storage = useMemo(
    () => createStorage({ namespace: loadStorageNamespace() }),
    [storageEpoch],
  );
  const [dataDirectory, setDataDirectory] = useState('');
  const [realStoragePath, setRealStoragePath] = useState('');
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null);
  const [keys, setKeys] = useState<VaultKeys | null>(null);
  const [notes, setNotes] = useState<NoteNode[]>([]);
  const [unlockProgress, setUnlockProgress] = useState<{ current: number; total: number } | null>(null);
  const [isLocking, setIsLocking] = useState(false);
  const [groups, setGroups] = useState<TabGroupState[]>(() => loadTabState().groups);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const [activeGroupId, setActiveGroupId] = useState<string>(() => loadTabState().activeGroupId);
  const [editorModeByGroup, setEditorModeByGroup] = useState<Record<string, EditorMode>>({});
  const [tiptapEditorByGroup, setTiptapEditorByGroup] = useState<Record<string, Editor | null>>({});
  const [selCharsByGroup, setSelCharsByGroup] = useState<Record<string, number>>({});
  // Inline formula editing (clicking an existing formula); window.prompt is unusable in Electron.
  const [formulaEdit, setFormulaEdit] = useState<{
    groupId: string;
    latex: string;
    apply: (next: string) => void;
  } | null>(null);
  // AI Workbench: per-vault settings (API key encrypted in vault_meta) + encrypted session tree.
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiSessions, setAiSessions] = useState<AiSessionNode[]>([]);
  const [activeAiSessionId, setActiveAiSessionId] = useState<string | null>(null);
  const activeAiSessionIdRef = useRef(activeAiSessionId);
  activeAiSessionIdRef.current = activeAiSessionId;
  // In-flight AI reply: streamed here (app level) so switching sessions/views never interrupts it.
  const [aiRun, setAiRun] = useState<{
    sessionId: string;
    text: string;
    thinkingChars?: number;
    webSearches?: number;
    startedAt: number;
  } | null>(null);
  const [aiRunError, setAiRunError] = useState<{ sessionId: string; message: string } | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);
  // Find/replace bar: id of the tab group it is open in (null = closed).
  const [findBarGroupId, setFindBarGroupId] = useState<string | null>(null);
  // Pre-filled query for the find bar (selected editor text on Ctrl+F, or the global-search
  // query when a result is opened). Cleared when the bar closes.
  const [findInitialQuery, setFindInitialQuery] = useState<string | null>(null);
  // Bumped on every Ctrl+F so an already-open bar refocuses (and reloads the initial query).
  const [findBarNonce, setFindBarNonce] = useState(0);
  // Ctrl+F while an AI session is open: forwarded to the AI workbench's own find bar.
  const [aiFindRequest, setAiFindRequest] = useState<{ nonce: number; query: string } | null>(null);
  // Attachment manager modal for the focused note/table (opened from the 📎 header button).
  const [showAttachmentsModal, setShowAttachmentsModal] = useState(false);
  const findReplaceByGroupRef = useRef<Record<string, FindReplaceController | null>>({});
  // Select-all actions registered by the mounted note/table editors, used by the app-level
  // Ctrl/Cmd+A so "select all" targets the active content instead of the whole UI.
  const selectAllByGroupRef = useRef<Record<string, (() => void) | null>>({});
  // Scroll positions per group+tab, restored when a tab becomes active again (so switching
  // between tabs preserves each tab's viewport).
  const viewportByTabRef = useRef<Record<string, { top: number; left: number }>>({});
  const paneElsByGroupRef = useRef<Record<string, HTMLDivElement | null>>({});
  // While a restore is in flight, ignore scroll events (the browser clamps/fires scrolls when
  // content swaps, which would corrupt the saved positions).
  const restoringViewportRef = useRef(false);
  // Cross-vault transfer: ids of the tree nodes being transferred (null = dialog closed).
  const [transferIds, setTransferIds] = useState<string[] | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferProgress, setTransferProgress] = useState<string | null>(null);
  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? groups[0];
  const activeId = activeGroup?.activeTabId ?? null;
  useEffect(() => {
    if (!groups.some((g) => g.id === activeGroupId)) {
      setActiveGroupId(groups[0]?.id ?? 'g1');
    }
  }, [groups, activeGroupId]);
  // Guards against a race where the intermediate render right after
  // `setKeys(derived)` (but before the async `restoreTabState` call inside
  // `loadNotes` has run) would otherwise persist the still-empty/default
  // `groups` left over from the previous lock, clobbering the real saved
  // tab state before it gets a chance to be restored.
  const tabStateReadyRef = useRef(false);
  useEffect(() => {
    if (!keys || !tabStateReadyRef.current) return;
    saveTabState({ groups, activeGroupId }, loadStorageNamespace());
  }, [keys, groups, activeGroupId]);
  const [appView, setAppView] = useState<AppView>('notes');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  // Re-renders the logs modal after clearing (the buffer itself lives outside React).
  const [, setLogsTick] = useState(0);
  const [session, setSession] = useState<UserSession | null>(() => loadSession(loadStorageNamespace()));
  const sessionRef = useRef<UserSession | null>(null);
  sessionRef.current = session;
  // True after any authenticated call answered 401: the stored token is dead (7-day server TTL
  // or JWT_SECRET rotation), so the "logged in" state it represented is a lie. We drop the
  // session immediately and show a banner prompting a fresh login instead.
  const [sessionExpired, setSessionExpired] = useState(false);
  const [serverUrl, setServerUrl] = useState(() => loadServerUrl());
  // One-shot hint left behind by the server-change reload path in `handleCloudSync`, so the
  // unlock screen reopens on the cloud tab with the new address prefilled.
  const [unlockInitialTab] = useState<'local' | 'cloud'>(() => {
    try {
      if (sessionStorage.getItem(UNLOCK_TAB_HINT_KEY) === 'cloud') {
        sessionStorage.removeItem(UNLOCK_TAB_HINT_KEY);
        return 'cloud';
      }
    } catch {
      /* ignore */
    }
    return 'local';
  });
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [expandedSearch, setExpandedSearch] = useState(false);
  const [searchTick, setSearchTick] = useState(0);
  const [vaultRegistry, setVaultRegistry] = useState(() => ensureLegacyVaultInRegistry());
  const [activeVaultId, setActiveVaultId] = useState(() => {
    const reg = ensureLegacyVaultInRegistry();
    const ns = loadStorageNamespace();
    return reg.find((v) => v.namespace === ns)?.id ?? reg[0]?.id ?? '';
  });
  const [vaultListItems, setVaultListItems] = useState<VaultListItem[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [activePeerName, setActivePeerName] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<NoteAttachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [imConnected, setImConnected] = useState(false);
  const [unreadByPeer, setUnreadByPeer] = useState<Record<string, number>>({});
  const [chatNotify, setChatNotify] = useState(() => loadChatNotificationSettings());
  const [uiTheme, setUiTheme] = useState(() => loadUiTheme());
  const [locale, setLocale] = useState<Locale>(() => loadLocale());
  const t = useCallback<TFunction>((key, vars) => translate(locale, key, vars), [locale]);
  const handleLocaleChange = useCallback((next: Locale) => {
    setLocale(next);
    saveLocale(next);
  }, []);
  const [noteWidth, setNoteWidth] = useState(() => loadNoteWidth());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadSidebarCollapsed());
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      saveSidebarCollapsed(next);
      return next;
    });
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth());
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() => loadCollapsedFolderIds());
  const [treeSortMode, setTreeSortMode] = useState<TreeSortMode>(() => loadTreeSortMode());
  const [revealId, setRevealId] = useState<string | null>(null);
  const [showLineNumbers, setShowLineNumbers] = useState(() => loadShowLineNumbers());
  const toggleLineNumbers = useCallback(() => {
    setShowLineNumbers((prev) => {
      const next = !prev;
      saveShowLineNumbers(next);
      return next;
    });
  }, []);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const sidebarDraggedRef = useRef(false);
  const [groupSplitRatio, setGroupSplitRatio] = useState(() => loadGroupSplitRatio());
  const groupSplitRatioRef = useRef(groupSplitRatio);
  groupSplitRatioRef.current = groupSplitRatio;
  const [shortcuts, setShortcuts] = useState<ShortcutBindings>(() => loadShortcuts());
  const [renameRequestId, setRenameRequestId] = useState<string | null>(null);
  const handleShortcutsChange = useCallback((next: ShortcutBindings) => {
    setShortcuts(next);
    saveShortcuts(next);
  }, []);
  const [enableMath, setEnableMath] = useState(() => loadEnableMath());
  const handleEnableMathChange = useCallback((enable: boolean) => {
    setEnableMath(enable);
    saveEnableMath(enable);
  }, []);
  const handleAiSettingsSave = useCallback(
    async (settings: AiSettings) => {
      const k = keysRef.current;
      if (!k) return;
      setAiSettings(settings);
      await storage.setMeta(
        META_KEYS.aiSettings,
        packEncrypted(encryptString(k.masterKey, JSON.stringify(settings))),
      );
    },
    [storage],
  );
  const [aiPanelOpen, setAiPanelOpen] = useState<boolean>(() => loadAiPanelOpen());
  // Sidebar multi-selection (Ctrl/Shift+click). The anchor is the row a Shift-range extends from.
  const [treeSelectedIds, setTreeSelectedIds] = useState<Set<string>>(() => new Set());
  const treeAnchorIdRef = useRef<string | null>(null);
  const treeSelectedIdsRef = useRef(treeSelectedIds);
  treeSelectedIdsRef.current = treeSelectedIds;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', uiTheme);
  }, [uiTheme]);

  // Network proxy (desktop only): Electron's session.setProxy routes every renderer
  // request — fetch and the chat/collab WebSockets (wss) included — through the
  // configured HTTP/SOCKS5 proxy. Browsers can't set a per-page proxy, so on web the
  // stored setting is surfaced in Settings with a hint to use the system proxy instead.
  const [proxySettings, setProxySettings] = useState(() => loadProxySettings());
  useEffect(() => {
    void window.fastnote?.setProxy?.(proxyRulesFromSettings(proxySettings));
  }, [proxySettings]);
  const handleProxySettingsChange = useCallback((next: ProxySettings) => {
    setProxySettings(next);
    saveProxySettings(next);
  }, []);

  // Outbound network access is locked down to only the user-configured
  // server (HTTP + WebSocket) via a Content-Security-Policy baked into the
  // page at load time (see index.html + packages/shared/src/csp.ts) — a
  // <meta> CSP cannot be widened at runtime, so instead of "applying" it
  // here, `commitServerUrl` below detects when a change requires a reload.
  const commitServerUrl = useCallback((next: string) => {
    saveServerUrl(next);
    setServerUrl(next);
    if (serverUrlNeedsReload(next)) {
      if (window.confirm(t('vaultApp.serverUrlReloadConfirm'))) {
        window.location.reload();
      }
    }
  }, [t]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchIndexRef = useRef(new NoteSearchIndex());
  const keysRef = useRef(keys);
  const imRef = useRef<IMClient | null>(null);
  const appViewRef = useRef(appView);
  const activePeerRef = useRef(activePeerId);
  const chatNotifyRef = useRef(chatNotify);
  const insertDocRef = useRef<(text: string) => void>(() => {});
  const insertTableRef = useRef<(text: string) => void>(() => {});
  const importFolderInputRef = useRef<HTMLInputElement>(null);
  const importNoteFileInputRef = useRef<HTMLInputElement>(null);
  const importTableFileInputRef = useRef<HTMLInputElement>(null);
  const importTargetParentRef = useRef<string | null>(null);
  const importNoteForceRef = useRef(false);
  const importFolderForceRef = useRef(false);
  const noteWidthRef = useRef(noteWidth);
  noteWidthRef.current = noteWidth;
  keysRef.current = keys;
  appViewRef.current = appView;
  activePeerRef.current = activePeerId;
  chatNotifyRef.current = chatNotify;

  useEffect(() => {
    void window.fastnote?.getUserDataPath?.().then((p) => p && setRealStoragePath(p));
  }, []);

  useEffect(() => {
    void (async () => {
      const dir = await window.fastnote?.getDataDirectory?.();
      const label = loadStoragePathLabel();
      if (label) {
        setDataDirectory(label);
        return;
      }
      if (dir) {
        setDataDirectory(dir);
        if (loadStorageNamespace() === 'default') {
          const namespace = namespaceFromPath(dir);
          saveStorageNamespace(namespace);
          saveStoragePathLabel(dir);
          let reg = loadVaultRegistry();
          if (!reg.some((v) => v.namespace === namespace)) {
            const entry = createVaultRegistryEntry(dir.split(/[/\\]/).pop() || t('vaultApp.defaultDesktopVaultLabel'));
            entry.namespace = namespace;
            reg = [...reg, entry];
            saveVaultRegistry(reg);
            setVaultRegistry(reg);
            setActiveVaultId(entry.id);
          }
          setStorageEpoch((n) => n + 1);
        }
      }
    })();
  }, []);

  useEffect(() => {
    storage
      .getMeta(META_KEYS.salt)
      .then((salt) => setIsFirstRun(!salt))
      .catch((err) => {
        console.error('storage init failed', err);
        setIsFirstRun(true);
      });
  }, [storage]);

  useEffect(() => {
    if (keys) return;
    void (async () => {
      const items: VaultListItem[] = [];
      for (const vault of vaultRegistry) {
        const vaultStorage = createStorage({ namespace: vault.namespace });
        const salt = await vaultStorage.getMeta(META_KEYS.salt);
        const boundUsername = salt
          ? (await vaultStorage.getMeta(META_KEYS.boundUsername)) ?? undefined
          : undefined;
        items.push({
          id: vault.id,
          namespace: vault.namespace,
          label: vault.label,
          initialized: !!salt,
          boundUsername,
        });
      }
      setVaultListItems(items);
    })();
  }, [keys, vaultRegistry, storageEpoch]);

  const selectVaultById = useCallback((vaultId: string) => {
    const entry = vaultRegistry.find((v) => v.id === vaultId);
    if (!entry) return;
    saveStorageNamespace(entry.namespace);
    setActiveVaultId(vaultId);
    setSession(loadSession(entry.namespace));
    setSessionExpired(false);
    setStorageEpoch((n) => n + 1);
  }, [vaultRegistry]);

  const createVaultEntry = useCallback(async (label: string) => {
    const entry = createVaultRegistryEntry(label, locale);
    const next = [...vaultRegistry, entry];
    saveVaultRegistry(next);
    setVaultRegistry(next);
    selectVaultById(entry.id);
  }, [selectVaultById, vaultRegistry, locale]);

  const assertVaultUsernameMatch = useCallback(async (username: string) => {
    const bound = await storage.getMeta(META_KEYS.boundUsername);
    const trimmed = username.trim();
    if (bound && bound !== trimmed) {
      throw new Error(t('vaultApp.boundUsernameLoginError', { bound, attempted: trimmed }));
    }
  }, [storage, t]);

  const bindVaultUsername = useCallback(async (username: string) => {
    const trimmed = username.trim();
    const bound = await storage.getMeta(META_KEYS.boundUsername);
    if (bound && bound !== trimmed) {
      throw new Error(t('vaultApp.boundUsernameLoginError', { bound, attempted: trimmed }));
    }
    if (!bound) {
      await storage.setMeta(META_KEYS.boundUsername, trimmed);
    }
  }, [storage, t]);

  const hydrateSession = useCallback(() => {
    setSession(loadSession(loadStorageNamespace()));
    setSessionExpired(false);
  }, []);

  useEffect(() => {
    if (keys) hydrateSession();
  }, [keys, hydrateSession]);

  const handleSaveVaultLabel = useCallback((label: string) => {
    const trimmed = label.trim();
    if (!trimmed || !activeVaultId) return;
    const next = vaultRegistry.map((v) =>
      v.id === activeVaultId ? { ...v, label: trimmed } : v,
    );
    saveVaultRegistry(next);
    setVaultRegistry(next);
    setVaultListItems((prev) =>
      prev.map((v) => (v.id === activeVaultId ? { ...v, label: trimmed } : v)),
    );
  }, [activeVaultId, vaultRegistry]);

  const refreshAttachments = useCallback(async (noteId: string) => {
    if (!keys) return;
    setAttachmentsLoading(true);
    try {
      const list = await storage.listAttachments(noteId, keys.notesKey);
      setAttachments(list);
    } finally {
      setAttachmentsLoading(false);
    }
  }, [keys, storage]);

  /**
   * Debounced real-time upload of chat history blobs: every sent/received message lands on the
   * account within a few seconds instead of waiting for the next login/unlock/manual sync, so
   * other devices of the same account can pull it. No-op while logged out — pending rows are
   * picked up by the next sync as before.
   */
  const chatPushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last reconnect catch-up chat sync (ms epoch), throttles the on-connect full sync. */
  const lastChatCatchupRef = useRef(0);
  const scheduleChatPush = () => {
    if (chatPushTimerRef.current) clearTimeout(chatPushTimerRef.current);
    chatPushTimerRef.current = setTimeout(() => {
      chatPushTimerRef.current = null;
      const s = sessionRef.current;
      if (!s) return;
      void new SyncClient(new ApiClient(serverUrl, locale), s)
        .pushChatMessages(storage)
        .catch((err) => {
          console.warn('[FastNote] chat: realtime push failed (will retry on next sync)', err);
        });
    }, 3000);
  };
  const scheduleChatPushRef = useRef(scheduleChatPush);
  scheduleChatPushRef.current = scheduleChatPush;

  const persistChatMessage = useCallback(
    async (message: ChatMessage) => {
      const k = keysRef.current;
      if (!k) return;
      await storage.saveChatMessage(message, k.notesKey);
      setChatMessages((prev) => {
        if (prev.some((m) => m.id === message.id)) {
          return prev.map((m) => (m.id === message.id ? message : m));
        }
        return [...prev, message].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
      });
      scheduleChatPushRef.current();
    },
    [storage],
  );

  // Delivery/read receipts only ever move a message's status forward
  // (sent -> delivered -> read); an ack arriving out of order (or twice)
  // should never regress a message that's already further along.
  const updateChatMessageStatus = useCallback(
    (msgId: string, status: ChatMessage['status']) => {
      const k = keysRef.current;
      if (!k) return;
      setChatMessages((prev) => {
        let changed = false;
        const next = prev.map((m) => {
          if (m.id !== msgId || m.direction !== 'out' || chatStatusRank(status) <= chatStatusRank(m.status)) {
            return m;
          }
          changed = true;
          const updated = { ...m, status };
          void storage.saveChatMessage(updated, k.notesKey);
          return updated;
        });
        return changed ? next : prev;
      });
    },
    [storage],
  );

  const clearPeerUnread = useCallback((peerId: string) => {
    setUnreadByPeer((prev) => {
      if (!prev[peerId]) return prev;
      const next = { ...prev };
      delete next[peerId];
      saveChatUnread(next, loadStorageNamespace());
      return next;
    });
  }, []);

  const bumpUnread = useCallback((peerId: string) => {
    setUnreadByPeer((prev) => {
      const next = { ...prev, [peerId]: (prev[peerId] ?? 0) + 1 };
      saveChatUnread(next, loadStorageNamespace());
      return next;
    });
  }, []);

  const migrateLegacyChat = useCallback(
    async (derived: VaultKeys) => {
      const migrated = await storage.getMeta(META_KEYS.chatStorageMigrated);
      if (migrated === '1') return;
      const legacy = loadChatMessages();
      for (const msg of legacy) {
        await storage.saveChatMessage(msg, derived.notesKey);
      }
      await storage.setMeta(META_KEYS.chatStorageMigrated, '1');
    },
    [storage],
  );

  const loadChatHistory = useCallback(
    async (derived: VaultKeys) => {
      await migrateLegacyChat(derived);
      const messages = await storage.listChatMessagesDecrypted(derived.notesKey);
      setChatMessages(messages);
    },
    [migrateLegacyChat, storage],
  );

  /** Manual "sync history" from the chat header: full push+pull, then refresh the thread. */
  const handleChatHistorySync = useCallback(async () => {
    const k = keysRef.current;
    const s = sessionRef.current;
    if (!k || !s) throw new Error(t('chatPanel.syncNeedsLogin'));
    const client = new SyncClient(new ApiClient(serverUrl, locale), s);
    const { pulled } = await client.syncChatMessages(storage);
    if (pulled > 0 && keysRef.current === k) await loadChatHistory(k);
  }, [serverUrl, locale, storage, loadChatHistory, t]);

  const processIncomingChat = useCallback(
    async (peerId: string, plaintext: string, msgId: string, sentAt: string) => {
      const k = keysRef.current;
      if (!k) return;
      const existing = await storage.listChatMessagesDecrypted(k.notesKey);
      if (existing.some((m) => m.id === msgId)) return;

      // Self-chat ("file transfer assistant"): a message from another device of this same
      // account. It was authored by us, so store it as outgoing and keep notifications quiet
      // (badge only, no sound).
      const isSelf = peerId === sessionRef.current?.userId;

      const wire = decodeChatWire(plaintext);
      const refs: ChatAttachmentRef[] = [];
      for (const att of wire.attachments ?? []) {
        try {
          const ref = await storage.saveChatAttachmentFromWire(msgId, peerId, att, k.notesKey);
          refs.push(ref);
        } catch (err) {
          console.warn('[chat] failed to save incoming attachment', att.fileName, err);
        }
      }
      const session = imRef.current?.getSession(peerId);
      const msg = storedToChatMessage(
        msgId,
        peerId,
        isSelf ? 'out' : 'in',
        sentAt,
        toStoredPayload({ ...wire, peerUsername: session?.peerUsername }, refs),
      );
      await persistChatMessage(msg);

      const viewingThread =
        appViewRef.current === 'chat' && activePeerRef.current === peerId;
      if (!viewingThread) {
        bumpUnread(peerId);
        if (chatNotifyRef.current.sound && !isSelf) {
          playChatNotificationSound(chatNotifyRef.current.soundId, chatNotifyRef.current.volume);
        }
      }

      const imSession = imRef.current?.getSession(peerId);
      if (imSession && appViewRef.current === 'chat') {
        if (!activePeerRef.current || activePeerRef.current === peerId) {
          setActivePeerId(peerId);
          setActivePeerName(isSelf ? t('chatSidebar.selfChat') : imSession.peerUsername);
          clearPeerUnread(peerId);
        }
      }
    },
    [persistChatMessage, storage, bumpUnread, clearPeerUnread, t],
  );

  useEffect(() => {
    if (appView !== 'chat' || !session) {
      setImConnected(false);
      return;
    }
    const tick = () => setImConnected(imRef.current?.isConnected() ?? false);
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [appView, session]);

  // While a thread is actively open, tell the peer we've read whatever's
  // still marked unread on our side and flip it to 'read' locally. Re-runs
  // whenever chatMessages changes (e.g. a new message just arrived while the
  // thread is open) but converges immediately since the next pass finds
  // nothing left with status !== 'read'.
  useEffect(() => {
    if (appView !== 'chat' || !activePeerId || !keys) return;
    const unread = chatMessages.filter(
      (m) => m.peerId === activePeerId && m.direction === 'in' && m.status !== 'read',
    );
    if (unread.length === 0) return;
    const client = imRef.current;
    for (const m of unread) {
      client?.sendReadAck(activePeerId, m.id);
    }
    const notesKey = keys.notesKey;
    setChatMessages((prev) =>
      prev.map((m) =>
        m.peerId === activePeerId && m.direction === 'in' && m.status !== 'read'
          ? { ...m, status: 'read' }
          : m,
      ),
    );
    void Promise.all(unread.map((m) => storage.saveChatMessage({ ...m, status: 'read' }, notesKey)));
  }, [appView, activePeerId, chatMessages, keys, storage]);

  const chatSessions = useMemo(
    () =>
      buildChatSessions(
        chatMessages,
        loadChatSessions(loadStorageNamespace()).map((s) => ({
          peerId: s.peerId,
          peerName: s.peerUsername,
        })),
        activePeerId,
        activePeerName,
        t,
      ),
    [chatMessages, activePeerId, activePeerName, imConnected, appView, t],
  );

  const totalUnread = useMemo(
    () => Object.values(unreadByPeer).reduce((sum, n) => sum + n, 0),
    [unreadByPeer],
  );

  useEffect(() => {
    if (!keys) {
      setUnreadByPeer({});
      return;
    }
    setUnreadByPeer(loadChatUnread(loadStorageNamespace()));
  }, [keys, storageEpoch]);

  useEffect(() => {
    if (appView === 'chat' && activePeerId) clearPeerUnread(activePeerId);
  }, [appView, activePeerId, clearPeerUnread]);

  useEffect(() => {
    if (!keys || !activeId) {
      setAttachments([]);
      return;
    }
    const node = notes.find(
      (n) => n.id === activeId && (n.nodeType === 'note' || n.nodeType === 'table'),
    );
    if (!node) {
      setAttachments([]);
      return;
    }
    void refreshAttachments(node.id);
  }, [activeId, notes, keys, refreshAttachments]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      imRef.current?.disconnect();
    };
  }, []);

  /** True when the in-memory search index has changes not yet persisted to the snapshot. */
  const searchDirtyRef = useRef(false);

  /**
   * Cheap fingerprint of the vault's note set (ids + versions). Stored alongside the search
   * snapshot so unlock can tell whether the snapshot still matches the database — if it does, the
   * expensive full index rebuild is skipped entirely.
   */
  // The schema tag invalidates persisted snapshots whenever tokenization/stripping rules change
  // (v2: underscores inside identifiers are no longer stripped), forcing a clean rebuild.
  const searchFingerprint = (items: NoteNode[]): string =>
    hashContent(
      'search-schema-v2|' +
        items
          .filter((n) => !n.deleted)
          .map((n) => `${n.id}:${n.version}`)
          .sort()
          .join('|'),
    );

  /**
   * False while the index is being prepared in the background after unlock (snapshot
   * deserialization or full rebuild). Mutations arriving in that window are queued in
   * `pendingSearchOpsRef` and replayed once the index is ready.
   */
  const searchReadyRef = useRef(true);
  /** Invalidates an in-flight background index build (re-unlock, sync rebuild, lock). */
  const searchGenRef = useRef(0);
  const pendingSearchOpsRef = useRef<
    Array<{ type: 'upsert'; note: NoteNode } | { type: 'remove'; id: string }>
  >([]);

  /** Reads the persisted snapshot and deserializes it off the main thread (chunked). */
  const loadSearchSnapshotAsync = useCallback(
    async (indexKey: Uint8Array, expectedFingerprint: string): Promise<NoteSearchIndex | null> => {
      const raw = await storage.getMeta(META_KEYS.searchIndexSnapshot);
      if (!raw) return null;
      const storedFingerprint = await storage.getMeta(META_KEYS.searchIndexFingerprint);
      // No/stale fingerprint means the snapshot may not reflect the current notes (e.g. the app
      // was killed before locking); the caller falls back to a full rebuild.
      if (storedFingerprint !== expectedFingerprint) return null;
      try {
        const plain = await decryptStringNative(indexKey, unpackEncrypted(raw));
        return await NoteSearchIndex.fromSerializedAsync(plain);
      } catch {
        return null;
      }
    },
    [storage],
  );

  const saveSearchSnapshot = useCallback(
    async (indexKey: Uint8Array, items: NoteNode[]) => {
      // While the background build is still running the in-memory index is empty/partial —
      // persisting it would poison the next unlock. Keeping the previous snapshot is safe: its
      // fingerprint won't match anymore, so the next unlock falls back to a full rebuild.
      if (!searchReadyRef.current) return;
      // Nothing changed since the last save/load — skip the serialize+encrypt+write entirely
      // (this is what used to make locking an untouched large vault stall).
      if (!searchDirtyRef.current) return;
      const json = searchIndexRef.current.serialize();
      const enc = await encryptStringNative(indexKey, json);
      await storage.setMeta(META_KEYS.searchIndexSnapshot, packEncrypted(enc));
      await storage.setMeta(META_KEYS.searchIndexFingerprint, searchFingerprint(items));
      searchDirtyRef.current = false;
    },
    [storage],
  );

  const upsertSearch = (note: NoteNode) => {
    // Trashed notes are invisible to search; treating the upsert as a removal keeps every save
    // path (trash, restore, remote sync pull) consistent without special-casing callers.
    if (note.trashed) {
      removeFromSearch(note.id);
      return;
    }
    searchDirtyRef.current = true;
    if (!searchReadyRef.current) {
      pendingSearchOpsRef.current.push({ type: 'upsert', note });
      return;
    }
    searchIndexRef.current.upsert({
      ...note,
      contentMd: noteSearchBody(note),
    });
    setSearchTick((n) => n + 1);
  };

  const removeFromSearch = (id: string) => {
    searchDirtyRef.current = true;
    if (!searchReadyRef.current) {
      pendingSearchOpsRef.current.push({ type: 'remove', id });
      return;
    }
    searchIndexRef.current.remove(id);
  };

  const rebuildSearchIndex = useCallback((items: NoteNode[]) => {
    // A synchronous full rebuild supersedes any in-flight background build.
    searchGenRef.current += 1;
    searchReadyRef.current = true;
    pendingSearchOpsRef.current = [];
    searchIndexRef.current.rebuild(
      items.filter((n) => !n.trashed).map((n) => ({ ...n, contentMd: noteSearchBody(n) })),
    );
    searchDirtyRef.current = true;
    setSearchTick((n) => n + 1);
  }, []);

  /**
   * Prepares the search index in the background after unlock. Deserializing the snapshot of a
   * large vault (or rebuilding from scratch) takes seconds of CPU; doing it here — with MiniSearch's
   * chunked async APIs — instead of on the unlock critical path lets the main UI open immediately.
   * Searches in the first moments simply see an empty index until this finishes.
   */
  const prepareSearchIndexInBackground = useCallback(
    (derived: VaultKeys, decrypted: NoteNode[]) => {
      const gen = ++searchGenRef.current;
      searchReadyRef.current = false;
      pendingSearchOpsRef.current = [];
      searchIndexRef.current = new NoteSearchIndex();
      const fingerprint = searchFingerprint(decrypted);
      void (async () => {
        const t0 = performance.now();
        let built: NoteSearchIndex | null = null;
        try {
          built = await loadSearchSnapshotAsync(derived.indexKey, fingerprint);
          const fromSnapshot = built !== null;
          if (!built) {
            built = await NoteSearchIndex.buildAsync(
              decrypted.filter((n) => !n.trashed).map((n) => ({ ...n, contentMd: noteSearchBody(n) })),
            );
          }
          if (searchGenRef.current !== gen || keysRef.current !== derived) return;
          for (const op of pendingSearchOpsRef.current) {
            if (op.type === 'upsert') {
              built.upsert({ ...op.note, contentMd: noteSearchBody(op.note) });
            } else {
              built.remove(op.id);
            }
          }
          const hadPendingOps = pendingSearchOpsRef.current.length > 0;
          pendingSearchOpsRef.current = [];
          searchIndexRef.current = built;
          searchReadyRef.current = true;
          // A freshly restored snapshot with no interim edits needs no re-save at lock.
          searchDirtyRef.current = !fromSnapshot || hadPendingOps;
          setSearchTick((n) => n + 1);
          console.info(
            `[FastNote] search index ready in ${Math.round(performance.now() - t0)}ms (${
              fromSnapshot ? 'snapshot' : 'rebuild'
            }, ${decrypted.length} notes)`,
          );
        } catch (err) {
          if (searchGenRef.current !== gen || keysRef.current !== derived) return;
          console.error('background search index build failed', err);
          searchReadyRef.current = true;
          rebuildSearchIndex(decrypted);
        }
      })();
    },
    [loadSearchSnapshotAsync, rebuildSearchIndex],
  );

  /**
   * Settings-triggered maintenance: drops the persisted snapshot + fingerprint (which may have
   * gone stale and be serving entries for documents that no longer exist), then rebuilds the
   * index from the live notes in the background. The fresh snapshot is written at the next lock.
   */
  const handleRebuildSearchIndex = useCallback(() => {
    const k = keysRef.current;
    if (!k) return;
    void (async () => {
      await storage.setMeta(META_KEYS.searchIndexSnapshot, '');
      await storage.setMeta(META_KEYS.searchIndexFingerprint, '');
      prepareSearchIndexInBackground(k, notesRef.current);
      console.info('[FastNote] search index cache cleared, rebuild started');
    })();
  }, [storage, prepareSearchIndexInBackground]);

  const loadExchangePrivate = async (masterKey: Uint8Array) => {
    const wrapped = await storage.getMeta(META_KEYS.wrappedExchangeKey);
    if (!wrapped) return null;
    return unwrapKey(masterKey, unpackEncrypted(wrapped));
  };

  const setupIdentityKeys = async (derived: VaultKeys) => {
    const existing = await storage.getMeta(META_KEYS.identityPubkey);
    if (existing) return;
    const kp = generateIdentityKeypair();
    await storage.setMeta(
      META_KEYS.wrappedIdentityKey,
      packEncrypted(wrapKey(derived.masterKey, kp.identityPrivateKey)),
    );
    await storage.setMeta(
      META_KEYS.wrappedExchangeKey,
      packEncrypted(wrapKey(derived.masterKey, kp.exchangePrivateKey)),
    );
    await storage.setMeta(META_KEYS.identityPubkey, toBase64(kp.identityPublicKey));
    await storage.setMeta(META_KEYS.exchangePubkey, toBase64(kp.exchangePublicKey));
  };

  /**
   * The stored token was rejected with 401. Stop pretending to be logged in: drop the persisted
   * session (per-vault localStorage), disconnect IM, and raise the re-login banner. Login /
   * register / cloud-sync all clear the flag again via setSession + setSessionExpired(false).
   */
  const expireSession = useCallback(() => {
    saveSession(null, loadStorageNamespace());
    setSession(null);
    imRef.current?.disconnect();
    imRef.current = null;
    setSessionExpired(true);
  }, []);

  const initIM = useCallback(
    async (derived: VaultKeys, userSession: UserSession) => {
      const priv = await loadExchangePrivate(derived.masterKey);
      if (!priv) {
        throw new Error(t('vaultApp.chatKeyNotReady'));
      }
      const derivedPub = verifyExchangeKeypair(priv);
      const storedPub = await storage.getMeta(META_KEYS.exchangePubkey);
      if (storedPub !== derivedPub) {
        await storage.setMeta(META_KEYS.exchangePubkey, derivedPub);
      }
      const { identity } = await ensureLocalPubkeys(derived);
      await new ApiClient(serverUrl, locale).updateKeys(userSession.token, identity, derivedPub);
      imRef.current?.disconnect();
      const client = new IMClient(serverUrl, userSession.token, priv);
      client.setSelfId(userSession.userId);
      imRef.current = client;
      const vaultNs = loadStorageNamespace();
      for (const s of loadChatSessions(vaultNs)) client.loadSession(s);

      const persistSessions = () => saveChatSessions(client.allSessions(), vaultNs);

      client.setEnsurePeerSession(async (peerId: string) => {
        try {
          const peer = await new ApiClient(serverUrl, locale).lookupUserById(userSession.token, peerId);
          if (!peer.exchangePubkey) return false;
          client.upsertSession(peer.userId, peer.username, peer.exchangePubkey);
          persistSessions();
          return true;
        } catch (err) {
          console.warn('[IM] ensurePeerSession failed', peerId, err);
          return false;
        }
      });

      const handleDecrypted = async (
        peerId: string,
        plaintext: string,
        msgId: string,
        sentAt: string,
      ) => {
        await processIncomingChat(peerId, plaintext, msgId, sentAt);
        persistSessions();
      };

      client.setOnMessage(handleDecrypted);
      client.setOnDeliveryAck((_peerId, msgId) => updateChatMessageStatus(msgId, 'delivered'));
      client.setOnReadAck((_peerId, msgId) => updateChatMessageStatus(msgId, 'read'));
      client.setOnAuthError(() => expireSession());

      const pullPending = async () => {
        await client.pullPendingMessages(serverUrl, userSession.token);
        persistSessions();
      };

      client.setPendingFetcher(() => pullPending());
      // Reconnect catch-up: while this device was offline another logged-in device may have
      // already delivery-acked (and thus deleted) queued relay messages, so the pending pull
      // alone can miss them. Pull the account chat history too, throttled to once a minute.
      client.setOnConnected(() => {
        const now = Date.now();
        if (now - lastChatCatchupRef.current < 15_000) return;
        lastChatCatchupRef.current = now;
        void handleChatHistorySync().catch(() => {
          lastChatCatchupRef.current = 0; // let the next reconnect retry
        });
      });
      client.connect();
      void pullPending().catch((err) => console.error('fetchPending failed', err));
    },
    [serverUrl, processIncomingChat, storage, t, updateChatMessageStatus, handleChatHistorySync, expireSession],
  );

  const ensureImReady = useCallback(async (): Promise<IMClient> => {
    const derived = keysRef.current;
    const userSession = session;
    if (!derived || !userSession) {
      throw new Error(t('vaultApp.loginRequired'));
    }
    if (!imRef.current) {
      await initIM(derived, userSession);
    }
    if (!imRef.current) {
      throw new Error(t('vaultApp.messageServiceInitFailed'));
    }
    await imRef.current.waitForConnection();
    return imRef.current;
  }, [initIM, session, t]);

  const ensureChatPeerSession = useCallback(
    async (peerId: string, peerName?: string | null) => {
      const client = await ensureImReady();
      if (!session) throw new Error(t('vaultApp.loginRequired'));
      const api = new ApiClient(serverUrl, locale);
      // Self-chat: `peerName` is the localized "file transfer assistant" label, not an actual
      // username — always resolve by id (returns our own exchange pubkey).
      const peer =
        peerName && peerId !== session.userId
          ? await api.lookupUser(session.token, peerName)
          : await api.lookupUserById(session.token, peerId);
      if (!peer.exchangePubkey) {
        throw new Error(t('vaultApp.peerKeyNotReady', { username: peer.username }));
      }
      client.upsertSession(peer.userId, peer.username, peer.exchangePubkey);
      saveChatSessions(client.allSessions(), loadStorageNamespace());
      return client;
    },
    [ensureImReady, session, serverUrl, t],
  );

  const pruneStaleTabs = useCallback((survivingIds: Set<string>) => {
    setGroups((prev) => {
      const next = prev.map((g) => {
        const tabs = g.tabs.filter((tb) => survivingIds.has(tb.id));
        const activeTabId =
          g.activeTabId && survivingIds.has(g.activeTabId) ? g.activeTabId : (tabs[0]?.id ?? null);
        return { ...g, tabs, activeTabId };
      });
      const collapsed = next.length > 1 ? next.filter((g) => g.tabs.length > 0) : next;
      return collapsed.length > 0 ? collapsed : [{ id: 'g1', tabs: [], activeTabId: null }];
    });
  }, []);

  const restoreTabState = useCallback((decrypted: NoteNode[]) => {
    const survivingIds = new Set(
      decrypted.filter((n) => isEditableContentNode(n) && !n.trashed).map((n) => n.id),
    );
    const stored = loadTabState(loadStorageNamespace());
    const filteredGroups: TabGroupState[] = stored.groups.map((g) => {
      const tabs = g.tabs.filter((tb) => survivingIds.has(tb.id));
      const activeTabId = g.activeTabId && survivingIds.has(g.activeTabId) ? g.activeTabId : (tabs[0]?.id ?? null);
      return { ...g, tabs, activeTabId };
    });
    let finalGroups = filteredGroups.length > 0 ? filteredGroups : defaultTabState().groups;
    if (!finalGroups.some((g) => g.tabs.length > 0)) {
      const firstId = decrypted.find((n) => isEditableContentNode(n) && !n.trashed)?.id;
      finalGroups = firstId
        ? [{ id: 'g1', tabs: [{ id: firstId, pinned: false }], activeTabId: firstId }]
        : [{ id: 'g1', tabs: [], activeTabId: null }];
    }
    setGroups(finalGroups);
    setActiveGroupId(
      stored.activeGroupId && finalGroups.some((g) => g.id === stored.activeGroupId)
        ? stored.activeGroupId
        : (finalGroups[0]?.id ?? 'g1'),
    );
    tabStateReadyRef.current = true;
  }, []);

  const loadNotes = useCallback(
    async (derived: VaultKeys) => {
      const t0 = performance.now();
      // One IndexedDB getAll() + WebCrypto AES-GCM decryption in parallel chunks (tombstoned rows
      // are skipped inside the loader). The progress callback drives the unlock screen's bar.
      const decrypted = await storage.loadAllNotesDecrypted(derived.notesKey, (current, total) => {
        if (total > 0) setUnlockProgress({ current, total });
      });
      setUnlockProgress(null);
      console.info(
        `[FastNote] unlock: ${decrypted.length} notes decrypted in ${Math.round(performance.now() - t0)}ms`,
      );
      // Local-only vaults have no server to propagate deletions to, so any tombstones left over
      // from older versions can be cleared out here (off the critical path, fire-and-forget).
      if (!session) void storage.purgeDeleted();
      setNotes(decrypted);
      // Snapshot deserialization / index rebuild both take seconds of CPU on large vaults, so the
      // whole thing happens in the background — it isn't needed to render the main UI.
      prepareSearchIndexInBackground(derived, decrypted);
      restoreTabState(decrypted);
      // Everything below is off the unlock critical path. The salt backfill and IM handshake are
      // network round-trips with no fetch timeout (an unreachable server used to keep the unlock
      // screen on "processing" for tens of seconds), and chat-history decryption scales with the
      // number of messages. None of it is needed to start working with notes, so it runs in the
      // background after the main UI has opened. Same relative order as before; aborts if the
      // vault got locked (keysRef reset/replaced) in the meantime.
      const sessionAtUnlock = session;
      void (async () => {
        try {
          // AI Workbench state: cheap reads, but not needed to render notes.
          const rawAi = await storage.getMeta(META_KEYS.aiSettings);
          if (rawAi && keysRef.current === derived) {
            try {
              setAiSettings(JSON.parse(decryptString(derived.masterKey, unpackEncrypted(rawAi))) as AiSettings);
            } catch (err) {
              console.error('failed to decrypt AI settings', err);
            }
          }
          const aiList = await storage.listAiSessions(derived.notesKey);
          if (keysRef.current === derived) setAiSessions(aiList);
          if (sessionAtUnlock) {
            const saltB64 = await storage.getMeta(META_KEYS.salt);
            if (saltB64) {
              try {
                await new ApiClient(serverUrl, locale).uploadVaultSalt(sessionAtUnlock.token, saltB64);
              } catch {
                /* backfill vault_salt for older accounts */
              }
            }
          }
          if (keysRef.current !== derived) return;
          await loadChatHistory(derived);
          if (sessionAtUnlock && keysRef.current === derived) {
            await initIM(derived, sessionAtUnlock);
            // Already-logged-in unlock: pull any chat history synced from other devices.
            try {
              const client = new SyncClient(new ApiClient(serverUrl, locale), sessionAtUnlock);
              const { pulled } = await client.syncChatMessages(storage);
              if (pulled > 0 && keysRef.current === derived) await loadChatHistory(derived);
              const ai = await client.syncAiSessions(storage, derived.notesKey);
              if (ai.pulled > 0 && keysRef.current === derived) {
                const aiList = await storage.listAiSessions(derived.notesKey);
                setAiSessions(aiList);
                setActiveAiSessionId((cur) => (cur && aiList.some((n) => n.id === cur) ? cur : null));
              }
            } catch (err) {
              console.warn('[FastNote] chat: history sync after unlock failed', err);
            }
          }
        } catch (err) {
          console.error('post-unlock background init failed', err);
          if (err instanceof ApiAuthError) expireSession();
        }
      })();
    },
    [storage, prepareSearchIndexInBackground, session, initIM, serverUrl, locale, loadChatHistory, restoreTabState, expireSession],
  );

  const handleCreateVault = async (password: string) => {
    const salt = generateSalt();
    const saltB64 = toBase64(salt);
    await storage.setMeta(META_KEYS.salt, saltB64);
    const derived = await deriveKeysFromPassword(password, salt);
    await storage.setMeta(META_KEYS.passwordVerifier, toBase64(derived.passwordVerifier));
    await setupIdentityKeys(derived);
    keysRef.current = derived;
    // Load (and decrypt) notes before flipping `keys`/switching away from the unlock screen, so
    // the main app shell never mounts with an empty note tree mid-decrypt (previously this showed
    // as a long blank sidebar for larger vaults). The unlock screen keeps showing its progress bar
    // in the meantime.
    await loadNotes(derived);
    setKeys(derived);
    setIsFirstRun(false);
    setVaultListItems((prev) =>
      prev.map((v) => (v.id === activeVaultId ? { ...v, initialized: true } : v)),
    );
  };

  const handleUnlockLocal = async (password: string) => {
    const saltB64 = await storage.getMeta(META_KEYS.salt);
    if (!saltB64) throw new Error(t('vaultApp.noLocalVault'));
    const derived = await deriveKeysFromPassword(password, fromBase64(saltB64));
    const verifier = await storage.getMeta(META_KEYS.passwordVerifier);
    if (!verifier || toBase64(derived.passwordVerifier) !== verifier) {
      throw new Error(t('vaultApp.wrongPassword'));
    }
    await setupIdentityKeys(derived);
    keysRef.current = derived;
    await loadNotes(derived);
    const tPaint = performance.now();
    setKeys(derived);
    // Measures how long the first render of the main app takes (note tree + restored tab editors)
    // — the last remaining chunk of "processing…" time not covered by the phases logged above.
    requestAnimationFrame(() =>
      console.info(`[FastNote] unlock: first paint ${Math.round(performance.now() - tPaint)}ms after keys`),
    );
  };

  const handleLock = async () => {
    setIsLocking(true);
    // Let the "locking…" overlay actually paint before the (synchronous) teardown below, which
    // can otherwise make the app feel like it hangs for a moment on vaults with lots of open tabs.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (aiPushTimerRef.current) {
        clearTimeout(aiPushTimerRef.current);
        aiPushTimerRef.current = null;
      }
      if (keys) await saveSearchSnapshot(keys.indexKey, notes);
      imRef.current?.disconnect();
      imRef.current = null;
      for (const collab of collabSessionsRef.current.values()) collab.close();
      collabSessionsRef.current.clear();
      setCollabUi({});
      setCollabModal(null);
      setCollabContentNonce({});
      setCollabRoomCodes({});
      tabStateReadyRef.current = false;
      setKeys(null);
      setNotes([]);
      setChatMessages([]);
      setGroups(defaultTabState().groups);
      setActiveGroupId(defaultTabState().activeGroupId);
      setEditorModeByGroup({});
      setTiptapEditorByGroup({});
      setActivePeerId(null);
      setActivePeerName(null);
      setExpandedSearch(false);
      setTreeSelectedIds(new Set());
      treeAnchorIdRef.current = null;
      editHistoryRef.current = [];
      editHistoryIdxRef.current = -1;
      setAiSettings(null);
      setAiSessions([]);
      setActiveAiSessionId(null);
      // Locking must not leave an AI stream running against a wiped session list.
      aiAbortRef.current?.abort();
      setAiRun(null);
      setAiRunError(null);
      setFindBarGroupId(null);
      setShowAttachmentsModal(false);
      setFormulaEdit(null);
    } finally {
      setIsLocking(false);
    }
  };

  const handleLockRef = useRef(handleLock);
  handleLockRef.current = handleLock;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const activeGroupIdRef = useRef(activeGroupId);
  activeGroupIdRef.current = activeGroupId;
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  const modalOpenRef = useRef(false);
  modalOpenRef.current = showSettings || showAuth || showAbout;
  const tRef = useRef(t);
  tRef.current = t;
  const handleTrashManyRef = useRef<(ids: string[]) => Promise<void>>(async () => {});
  const formatJsonByGroupRef = useRef<Record<string, (() => boolean) | null>>({});

  // Focus history: content/title edits, tab clicks, and cursor clicks inside a page all record
  // the note id (consecutive duplicates collapsed); the focusPrev/focusNext shortcuts (default
  // Ctrl+Alt+Left/Right) walk the trail. Kept in refs — recording happens on every keystroke and
  // must not re-render.
  const editHistoryRef = useRef<string[]>([]);
  const editHistoryIdxRef = useRef(-1);
  const notesRef = useRef<NoteNode[]>([]);
  notesRef.current = notes;
  const navigateEditFocusRef = useRef<(dir: -1 | 1) => void>(() => {});

  // Real-time collaboration: one E2E-encrypted relay session per note/table (keyed by note id).
  // Sessions live in a ref (they hold sockets); `collabUi` mirrors connection state for rendering
  // and `collabContentNonce` tells an open NoteEditor "this content change came from the room".
  const collabSessionsRef = useRef(new Map<string, CollabSession>());
  const [collabUi, setCollabUi] = useState<Record<string, CollabStatus>>({});
  const [collabModal, setCollabModal] = useState<string | null>(null);
  const [collabContentNonce, setCollabContentNonce] = useState<Record<string, number>>({});
  /** Room code of each active session, kept for display so the initiator can share it later. */
  const [collabRoomCodes, setCollabRoomCodes] = useState<Record<string, string>>({});
  const collabActiveIds = useMemo(() => new Set(Object.keys(collabUi)), [collabUi]);

  const recordEditFocus = useCallback((id: string) => {
    const h = editHistoryRef.current;
    if (h[editHistoryIdxRef.current] === id) return;
    // Editing after walking back forks the trail: drop the forward entries, like undo history.
    h.splice(editHistoryIdxRef.current + 1);
    h.push(id);
    if (h.length > 100) h.shift();
    editHistoryIdxRef.current = h.length - 1;
  }, []);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (modalOpenRef.current) return;
      const bindings = shortcutsRef.current;
      // Focus-history navigation (customizable, default Ctrl+Alt+Left/Right); works while typing
      // in editors (that's where the user is).
      if (matchesShortcut(e, bindings.focusPrev)) {
        e.preventDefault();
        navigateEditFocusRef.current(-1);
        return;
      }
      if (matchesShortcut(e, bindings.focusNext)) {
        e.preventDefault();
        navigateEditFocusRef.current(1);
        return;
      }
      if (matchesShortcut(e, bindings.lockVault)) {
        e.preventDefault();
        void handleLockRef.current();
        return;
      }
      if (matchesShortcut(e, bindings.renameNote)) {
        // Prefer the sidebar's focused node (folders can only be renamed there); tab selection
        // keeps the anchor in sync, so this also covers "rename the note I'm working on".
        const id = treeAnchorIdRef.current ?? activeIdRef.current;
        if (!id) return;
        e.preventDefault();
        setRenameRequestId(id);
        return;
      }
      // Find in note: works while typing in the editor too (that's where the user usually is).
      // preventDefault stops the browser's native find; CodeMirror's own Mod-f panel is swallowed
      // inside the editor extension.
      if (matchesShortcut(e, bindings.findInNote)) {
        if (appViewRef.current !== 'notes') return;
        e.preventDefault();
        // Pre-fill the bar with the current editor selection (browser convention): text inputs
        // and textareas expose the selection directly; PM/CM selections come from the DOM.
        const el = document.activeElement;
        let selected = '';
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          const start = el.selectionStart ?? 0;
          const end = el.selectionEnd ?? 0;
          if (end > start) selected = el.value.slice(start, end);
        } else {
          selected = window.getSelection()?.toString() ?? '';
        }
        // Multi-line selections are kept intact — the find engines match across lines.
        const query = selected.replace(/^\n+|\n+$/g, '').slice(0, 500);
        // An open AI session has its own find bar (the tab groups behind it aren't visible).
        if (activeAiSessionIdRef.current) {
          setAiFindRequest((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, query }));
          return;
        }
        setFindInitialQuery(query || null);
        setFindBarNonce((n) => n + 1);
        setFindBarGroupId(activeGroupIdRef.current);
        return;
      }
      // Ctrl/Cmd+A outside any editable element: select the active content (note text, table
      // cells, or the AI conversation) instead of letting the browser select the whole UI.
      // Inside inputs/editors the native per-field select-all keeps working.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'a' &&
        !isTypingTarget(e.target) &&
        appViewRef.current === 'notes'
      ) {
        if (activeAiSessionIdRef.current) {
          const messages = document.querySelector('.fn-ai-workbench__messages');
          if (messages) {
            e.preventDefault();
            const range = document.createRange();
            range.selectNodeContents(messages);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
          return;
        }
        const selectAll = selectAllByGroupRef.current[activeGroupIdRef.current ?? ''];
        if (selectAll) {
          e.preventDefault();
          selectAll();
        }
        return;
      }
      // Delete the sidebar selection — but never while the user is typing in an input or editor,
      // where Delete/Backspace must keep its normal text-editing meaning, and never when the key
      // was already handled (or pressed) inside a table editor, where Del clears cells/headers.
      if (
        matchesShortcut(e, bindings.deleteSelected) &&
        !isTypingTarget(e.target) &&
        !e.defaultPrevented &&
        !(e.target instanceof Element && e.target.closest('.fn-table-editor'))
      ) {
        const ids = [...treeSelectedIdsRef.current];
        if (ids.length === 0) return;
        e.preventDefault();
        // Confirmed, though recoverable: the items land in the recycle bin.
        if (confirm(tRef.current('vaultApp.deleteSelectedConfirm', { count: ids.length }))) {
          void handleTrashManyRef.current(ids);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const persistNote = useCallback(
    async (note: NoteNode) => {
      const k = keysRef.current;
      if (!k) return;
      await storage.saveNote(note, k.notesKey);
      upsertSearch(note);
    },
    [storage],
  );

  const schedulePersist = useCallback(
    (note: NoteNode) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => void persistNote(note), SAVE_DEBOUNCE_MS);
    },
    [persistNote],
  );

  const saveNoteNow = useCallback(
    async (note: NoteNode) => {
      setNotes((prev) => {
        const exists = prev.some((n) => n.id === note.id);
        if (exists) return prev.map((n) => (n.id === note.id ? note : n));
        return [...prev, note];
      });
      await persistNote(note);
    },
    [persistNote],
  );

  const updateNoteById = useCallback(
    (id: string, patch: Partial<NoteNode>) => {
      if (!keys) return;
      recordEditFocus(id);
      // Feed content/title edits into an active collaboration session (no-op re-entrancy: after
      // a remote apply the session's shadow already equals the value, so nothing is re-broadcast).
      if (patch.contentMd !== undefined) collabSessionsRef.current.get(id)?.updateLocal(patch.contentMd);
      if (patch.title !== undefined) collabSessionsRef.current.get(id)?.updateLocalTitle(patch.title);
      setNotes((prev) => {
        const current = prev.find((n) => n.id === id);
        if (!current) return prev;
        const updated = buildUpdated(current, patch);
        schedulePersist(updated);
        return prev.map((n) => (n.id === updated.id ? updated : n));
      });
    },
    [keys, schedulePersist, recordEditFocus],
  );

  /** Applies changes merged from the collaboration room without recording an edit-focus entry. */
  const applyCollabRemotePatch = useCallback(
    (noteId: string, patch: Partial<NoteNode>) => {
      setNotes((prev) => {
        const current = prev.find((n) => n.id === noteId);
        if (!current) return prev;
        const unchanged =
          (patch.contentMd === undefined || current.contentMd === patch.contentMd) &&
          (patch.title === undefined || current.title === patch.title);
        if (unchanged) return prev;
        const updated = buildUpdated(current, patch);
        schedulePersist(updated);
        return prev.map((n) => (n.id === updated.id ? updated : n));
      });
      // Only content changes need the editor nudge; titles render from state everywhere.
      if (patch.contentMd !== undefined) {
        setCollabContentNonce((prev) => ({ ...prev, [noteId]: (prev[noteId] ?? 0) + 1 }));
      }
    },
    [schedulePersist],
  );

  const handleCollabJoin = useCallback(
    async (noteId: string, roomCode: string, password: string) => {
      if (!session) throw new Error(t('vaultApp.collabLoginRequired'));
      const note = notesRef.current.find((n) => n.id === noteId);
      if (!note) return;
      const isTable = note.nodeType === 'table';
      const collab = await CollabSession.create({
        serverUrl,
        token: session.token,
        password,
        roomCode,
        getText: () => notesRef.current.find((n) => n.id === noteId)?.contentMd ?? '',
        // Tables are stored as JSON; refuse any merge that would no longer parse so a bad
        // fuzzy patch can never corrupt the document (the session resyncs full state instead).
        validate: isTable
          ? (text) => {
              if (!text.trim()) return true;
              try {
                const doc = JSON.parse(text) as { version?: number; columns?: unknown; rows?: unknown };
                return doc.version === 1 && Array.isArray(doc.columns) && Array.isArray(doc.rows);
              } catch {
                return false;
              }
            }
          : undefined,
        applyRemote: (text) => applyCollabRemotePatch(noteId, { contentMd: text }),
        getTitle: () => notesRef.current.find((n) => n.id === noteId)?.title ?? '',
        applyRemoteTitle: (title) => applyCollabRemotePatch(noteId, { title }),
        onStatus: (status) => setCollabUi((prev) => ({ ...prev, [noteId]: status })),
      });
      collabSessionsRef.current.get(noteId)?.close();
      collabSessionsRef.current.set(noteId, collab);
      setCollabRoomCodes((prev) => ({ ...prev, [noteId]: normalizeCollabRoomCode(roomCode) }));
    },
    [session, serverUrl, applyCollabRemotePatch, t],
  );

  const handleCollabLeave = useCallback((noteId: string) => {
    collabSessionsRef.current.get(noteId)?.close();
    collabSessionsRef.current.delete(noteId);
    setCollabUi((prev) => {
      const next = { ...prev };
      delete next[noteId];
      return next;
    });
    setCollabRoomCodes((prev) => {
      const next = { ...prev };
      delete next[noteId];
      return next;
    });
  }, []);

  const handleCreate = async (nodeType: NodeType, parentId: string | null) => {
    if (!keys) return;
    const sortOrder = notes.filter((n) => n.parentId === parentId && !n.deleted).length;
    const node = newNode(nodeType, parentId, sortOrder, locale);
    await saveNoteNow(node);
    // Sidebar focus jumps to the new item (folders included) so F2-rename/keyboard actions
    // target it right away; the parent folder is expanded so the item is actually visible.
    if (parentId) {
      setCollapsedFolderIds((prev) => {
        if (!prev.has(parentId)) return prev;
        const next = new Set(prev);
        next.delete(parentId);
        saveCollapsedFolderIds(next);
        return next;
      });
    }
    setTreeSelectedIds(new Set([node.id]));
    treeAnchorIdRef.current = node.id;
    // Scroll the sidebar so the new row is actually visible (reveal also flashes it briefly).
    setRevealId(node.id);
    setTimeout(() => setRevealId((prev) => (prev === node.id ? null : prev)), 1500);
    if (isEditableContentNode(node)) {
      openNote(node.id, { pin: true });
      setAppView('notes');
    }
  };

  /**
   * Level for top-toolbar "new"/"import": alongside the sidebar's focused file (or inside it,
   * when the focused node is a folder). Falls back to the root when nothing is focused.
   */
  const focusedTreeParentId = (): string | null => {
    const focusId = treeAnchorIdRef.current ?? activeId;
    const node = focusId ? notes.find((n) => n.id === focusId) : undefined;
    if (!node) return null;
    return node.nodeType === 'folder' ? node.id : node.parentId;
  };

  const handleImportFolder = async (fileList: FileList, targetParentId: string | null, force = false) => {
    if (!keys || fileList.length === 0) return;

    const folderIdByPath = new Map<string, string>();
    const sortCounters = new Map<string | null, number>();
    const newNotes: NoteNode[] = [];

    const nextSortOrder = (parentId: string | null): number => {
      const existing = sortCounters.get(parentId);
      if (existing !== undefined) {
        sortCounters.set(parentId, existing + 1);
        return existing;
      }
      const baseline = notes.filter((n) => n.parentId === parentId && !n.deleted).length;
      sortCounters.set(parentId, baseline + 1);
      return baseline;
    };

    const ensureFolder = (segments: string[]): string | null => {
      if (segments.length === 0) return targetParentId;
      const key = segments.join('/');
      const existingId = folderIdByPath.get(key);
      if (existingId) return existingId;
      const parentId = ensureFolder(segments.slice(0, -1));
      const folder = newNode('folder', parentId, nextSortOrder(parentId), locale);
      folder.title = segments[segments.length - 1];
      newNotes.push(folder);
      folderIdByPath.set(key, folder.id);
      return folder.id;
    };

    let importedCount = 0;
    let skippedCount = 0;

    for (const file of Array.from(fileList)) {
      const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const segments = relPath.split('/').filter(Boolean);
      const fileName = segments[segments.length - 1] ?? file.name;
      const parentId = ensureFolder(segments.slice(0, -1));

      const lastDot = fileName.lastIndexOf('.');
      const hasExt = lastDot > 0;
      const ext = hasExt ? fileName.slice(lastDot + 1).toLowerCase() : '';
      const baseName = hasExt ? fileName.slice(0, lastDot) : fileName;

      // Force mode: ignore the extension entirely and import every file's
      // raw text content as a note (e.g. useful for source files, configs,
      // logs, or misnamed/extension-less text files that would otherwise be
      // skipped or misdetected as a table below).
      if (force) {
        try {
          const text = await file.text();
          const node = newNode('note', parentId, nextSortOrder(parentId), locale);
          node.title = baseName;
          node.contentMd = text;
          node.contentHash = hashContent(text);
          newNotes.push(node);
          importedCount++;
        } catch {
          skippedCount++;
        }
      } else if (!hasExt || ext === 'txt') {
        try {
          const text = await file.text();
          const node = newNode('note', parentId, nextSortOrder(parentId), locale);
          node.title = baseName;
          node.contentMd = text;
          node.contentHash = hashContent(text);
          newNotes.push(node);
          importedCount++;
        } catch {
          skippedCount++;
        }
      } else if (ext === 'csv') {
        try {
          const text = await file.text();
          const doc = importTableCsv(text, locale);
          const md = serializeTable(doc);
          const node = newNode('table', parentId, nextSortOrder(parentId), locale);
          node.title = baseName;
          node.contentMd = md;
          node.contentHash = hashContent(md);
          newNotes.push(node);
          importedCount++;
        } catch {
          skippedCount++;
        }
      } else {
        skippedCount++;
      }
    }

    if (newNotes.length === 0) {
      alert(t('vaultApp.importNothingFound'));
      return;
    }

    setNotes((prev) => [...prev, ...newNotes]);
    for (const node of newNotes) {
      await persistNote(node);
    }
    alert(
      t('vaultApp.importDone', {
        imported: importedCount,
        skipped: skippedCount ? t('vaultApp.importSkipped', { count: skippedCount }) : '',
      }),
    );
  };

  const openImportFolder = (parentId: string | null, force = false) => {
    importTargetParentRef.current = parentId;
    importFolderForceRef.current = force;
    importFolderInputRef.current?.click();
  };

  const openImportNoteFile = (parentId: string | null, force = false) => {
    importTargetParentRef.current = parentId;
    importNoteForceRef.current = force;
    // The `accept` filter is only a UI hint for the native file picker (it
    // never restricts what `handleImportFiles` will actually read/import —
    // that already accepts any file's text content for notes); force mode
    // just lifts the filter so non-.txt files are selectable in the dialog
    // in the first place.
    const input = importNoteFileInputRef.current;
    if (input) input.accept = force ? '' : '.txt,text/plain';
    input?.click();
  };

  const openImportTableFile = (parentId: string | null) => {
    importTargetParentRef.current = parentId;
    importTableFileInputRef.current?.click();
  };

  const handleImportFiles = async (
    fileList: FileList,
    targetParentId: string | null,
    kind: 'note' | 'table',
  ) => {
    if (!keys || fileList.length === 0) return;

    let order = notes.filter((n) => n.parentId === targetParentId && !n.deleted).length;
    const newNotes: NoteNode[] = [];
    let importedCount = 0;
    let skippedCount = 0;

    for (const file of Array.from(fileList)) {
      const lastDot = file.name.lastIndexOf('.');
      const baseName = lastDot > 0 ? file.name.slice(0, lastDot) : file.name;
      try {
        const text = await file.text();
        if (kind === 'table') {
          const doc = importTableCsv(text, locale);
          const md = serializeTable(doc);
          const node = newNode('table', targetParentId, order++, locale);
          node.title = baseName;
          node.contentMd = md;
          node.contentHash = hashContent(md);
          newNotes.push(node);
        } else {
          const node = newNode('note', targetParentId, order++, locale);
          node.title = baseName;
          node.contentMd = text;
          node.contentHash = hashContent(text);
          newNotes.push(node);
        }
        importedCount++;
      } catch {
        skippedCount++;
      }
    }

    if (newNotes.length === 0) {
      alert(t('vaultApp.importNothingFound'));
      return;
    }

    setNotes((prev) => [...prev, ...newNotes]);
    for (const node of newNotes) {
      await persistNote(node);
    }
    alert(
      t('vaultApp.importDone', {
        imported: importedCount,
        skipped: skippedCount ? t('vaultApp.importSkipped', { count: skippedCount }) : '',
      }),
    );
  };

  const handleNoteResizeStart = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = noteWidthRef.current;

    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientX - startX) * 2;
      const next = Math.min(NOTE_WIDTH_MAX, Math.max(NOTE_WIDTH_MIN, startWidth + delta));
      setNoteWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('fn-resizing-note');
      saveNoteWidth(noteWidthRef.current);
    };
    document.body.classList.add('fn-resizing-note');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const resetNoteWidth = () => {
    setNoteWidth(NOTE_WIDTH_DEFAULT);
    saveNoteWidth(NOTE_WIDTH_DEFAULT);
  };

  const renderNoteResizeHandle = () => (
    <div
      className="fn-note-resize-handle"
      onMouseDown={handleNoteResizeStart}
      onDoubleClick={resetNoteWidth}
      title={t('vaultApp.resizeHandleTitle')}
    />
  );

  const handleMove = async (
    dragId: string,
    targetId: string | null,
    position: TreeDropPosition,
  ) => {
    if (!keys) return;
    const next = computeTreeMove(notes, dragId, targetId, position);
    if (!next) return;
    setNotes(next);
    // Manual drag reordering always reverts the sort mode back to "manual".
    if (treeSortMode !== 'manual') {
      setTreeSortMode('manual');
      saveTreeSortMode('manual');
    }
    for (const n of next) {
      const prev = notes.find((x) => x.id === n.id);
      if (!prev || prev.parentId !== n.parentId || prev.sortOrder !== n.sortOrder) {
        await persistNote(n);
      }
    }
  };

  const handleSidebarToggleClick = useCallback(() => {
    if (sidebarDraggedRef.current) {
      sidebarDraggedRef.current = false;
      return;
    }
    toggleSidebar();
  }, [toggleSidebar]);

  const handleSidebarResizeStart = (e: ReactMouseEvent) => {
    if (sidebarCollapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;
    sidebarDraggedRef.current = false;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      if (Math.abs(delta) > 4) sidebarDraggedRef.current = true;
      const next = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, startWidth + delta));
      setSidebarWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('fn-resizing-sidebar');
      if (sidebarDraggedRef.current) saveSidebarWidth(sidebarWidthRef.current);
    };
    document.body.classList.add('fn-resizing-sidebar');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleToggleFolderCollapse = useCallback((id: string) => {
    setCollapsedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollapsedFolderIds(next);
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    const empty = new Set<string>();
    saveCollapsedFolderIds(empty);
    setCollapsedFolderIds(empty);
  }, []);

  const handleCollapseAll = useCallback(() => {
    setCollapsedFolderIds(() => {
      const all = new Set(notes.filter((n) => n.nodeType === 'folder' && !n.deleted).map((n) => n.id));
      saveCollapsedFolderIds(all);
      return all;
    });
  }, [notes]);

  const handleTreeSortMode = useCallback(
    (mode: TreeSortMode) => {
      setTreeSortMode(mode);
      saveTreeSortMode(mode);
      if (mode === 'manual') return;
      const next = applySortMode(notes, mode);
      if (next === notes) return;
      setNotes(next);
      next.forEach((n) => {
        const prev = notes.find((x) => x.id === n.id);
        if (!prev || prev.sortOrder !== n.sortOrder) {
          void persistNote(n);
        }
      });
    },
    [notes, persistNote],
  );

  const revealNoteInTree = useCallback(
    (id: string) => {
      const ancestors: string[] = [];
      let current = notes.find((n) => n.id === id);
      while (current?.parentId) {
        ancestors.push(current.parentId);
        current = notes.find((n) => n.id === current!.parentId);
      }
      if (ancestors.length > 0) {
        setCollapsedFolderIds((prev) => {
          if (!ancestors.some((a) => prev.has(a))) return prev;
          const next = new Set(prev);
          ancestors.forEach((a) => next.delete(a));
          saveCollapsedFolderIds(next);
          return next;
        });
      }
      setRevealId(id);
      setTimeout(() => setRevealId((prev) => (prev === id ? null : prev)), 1500);
    },
    [notes],
  );

  /** Ids in visual (top-to-bottom) sidebar order, skipping children of collapsed folders. */
  const visibleTreeOrder = useCallback((): string[] => {
    const order: string[] = [];
    const walk = (items: TreeItem[]) => {
      items.forEach((item) => {
        order.push(item.node.id);
        if (item.node.nodeType === 'folder' && !collapsedFolderIds.has(item.node.id)) {
          walk(item.children);
        }
      });
    };
    walk(buildTree(notes));
    return order;
  }, [notes, collapsedFolderIds]);

  const handleTreeSelect = (id: string, mods: { ctrl: boolean; shift: boolean }) => {
    if (mods.ctrl) {
      setTreeSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      treeAnchorIdRef.current = id;
      return;
    }
    if (mods.shift) {
      const order = visibleTreeOrder();
      const anchor = treeAnchorIdRef.current ?? activeId ?? id;
      const a = order.indexOf(anchor);
      const b = order.indexOf(id);
      if (a === -1 || b === -1) {
        setTreeSelectedIds(new Set([id]));
      } else {
        setTreeSelectedIds(new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1)));
      }
      return;
    }
    setTreeSelectedIds(new Set([id]));
    treeAnchorIdRef.current = id;
    const node = notes.find((n) => n.id === id);
    if (node && isEditableContentNode(node)) openNote(id);
  };

  const openNoteInGroup = (groupId: string, id: string, opts?: { pin?: boolean }) => {
    // Opening a note leaves the AI workbench and returns to the tab groups.
    setActiveAiSessionId(null);
    // Opening a tab counts as a focus switch. During focus-history navigation this is a no-op:
    // navigateEditFocus points the history index at the target id before opening, so the
    // consecutive-duplicate guard skips it (no forward-branch truncation).
    recordEditFocus(id);
    const existingGroup = groups.find((g) => g.tabs.some((tb) => tb.id === id));
    if (existingGroup) {
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id !== existingGroup.id) return g;
          const tabs = opts?.pin ? g.tabs.map((tb) => (tb.id === id ? { ...tb, pinned: true } : tb)) : g.tabs;
          return { ...g, tabs, activeTabId: id };
        }),
      );
      setActiveGroupId(existingGroup.id);
      return;
    }
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        if (opts?.pin) {
          return { ...g, tabs: [...g.tabs, { id, pinned: true }], activeTabId: id };
        }
        const previewIdx = g.tabs.findIndex((tb) => !tb.pinned);
        if (previewIdx !== -1) {
          const tabs = [...g.tabs];
          tabs[previewIdx] = { id, pinned: false };
          return { ...g, tabs, activeTabId: id };
        }
        return { ...g, tabs: [...g.tabs, { id, pinned: false }], activeTabId: id };
      }),
    );
    setActiveGroupId(groupId);
  };

  const openNote = (id: string, opts?: { pin?: boolean }) => openNoteInGroup(activeGroupId, id, opts);

  /**
   * Ctrl+Alt+Left/Right: jump to the previous/next edit focus. The target tab becomes active and
   * pinned; if it was closed in the meantime, openNote reopens it. Entries whose note has been
   * deleted since are skipped.
   */
  navigateEditFocusRef.current = (dir: -1 | 1) => {
    const h = editHistoryRef.current;
    let idx = editHistoryIdxRef.current + dir;
    while (idx >= 0 && idx < h.length) {
      const id = h[idx];
      const node = notesRef.current.find((n) => n.id === id);
      if (node && !node.deleted && !node.trashed && isEditableContentNode(node)) {
        editHistoryIdxRef.current = idx;
        openNote(id, { pin: true });
        setAppView('notes');
        revealNoteInTree(id);
        return;
      }
      idx += dir;
    }
  };

  const selectTabInGroup = (groupId: string, tabId: string) => {
    setActiveAiSessionId(null);
    recordEditFocus(tabId);
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, activeTabId: tabId } : g)));
    setActiveGroupId(groupId);
    // Keep the sidebar in sync with the tab the user just picked: expand ancestors, scroll to and
    // highlight the file. The anchor moves too, so F2 renames what the user just selected instead
    // of a stale sidebar row.
    treeAnchorIdRef.current = tabId;
    revealNoteInTree(tabId);
  };

  // --- AI Workbench session tree -------------------------------------------------------------

  /**
   * Debounced background push of locally-changed AI sessions, so edits reach the account without
   * waiting for a manual sync. Also applies anything pulled back (LWW) to the tree. No-op while
   * logged out — pending rows are picked up by the next login/unlock/manual sync.
   */
  const aiPushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAiSessionPush = () => {
    if (aiPushTimerRef.current) clearTimeout(aiPushTimerRef.current);
    aiPushTimerRef.current = setTimeout(() => {
      aiPushTimerRef.current = null;
      const k = keysRef.current;
      const s = sessionRef.current;
      if (!k || !s) return;
      void (async () => {
        try {
          const client = new SyncClient(new ApiClient(serverUrl, locale), s);
          const { pulled } = await client.syncAiSessions(storage, k.notesKey);
          if (pulled > 0 && keysRef.current === k) {
            const list = await storage.listAiSessions(k.notesKey);
            setAiSessions(list);
            setActiveAiSessionId((cur) => (cur && list.some((n) => n.id === cur) ? cur : null));
          }
        } catch (err) {
          console.warn('[FastNote] ai: session sync failed (will retry on next sync)', err);
        }
      })();
    }, 5000);
  };

  const persistAiSession = (node: AiSessionNode) => {
    const k = keysRef.current;
    if (!k) return;
    void storage.saveAiSession(node, k.notesKey);
    scheduleAiSessionPush();
  };

  const handleAiPanelToggle = () => {
    setAiPanelOpen((open) => {
      saveAiPanelOpen(!open);
      return !open;
    });
  };

  // Quick toggle between the AI workbench and the note tabs (toolbar button). Remembers the
  // last visited session so toggling back returns to where the user left off.
  const lastAiSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeAiSessionId) lastAiSessionIdRef.current = activeAiSessionId;
  }, [activeAiSessionId]);

  const handleAiQuickSwitch = () => {
    if (activeAiSessionId) {
      setActiveAiSessionId(null);
      return;
    }
    const sessionsOnly = aiSessions.filter((s) => s.kind === 'session');
    const target = sessionsOnly.find((s) => s.id === lastAiSessionIdRef.current) ?? sessionsOnly[0];
    if (target) setActiveAiSessionId(target.id);
    else handleAiCreate('session', null);
  };

  const handleAiCreate = (kind: 'folder' | 'session', parentId: string | null) => {
    const node: AiSessionNode = {
      id: crypto.randomUUID(),
      parentId,
      kind,
      title: kind === 'folder' ? t('aiPanel.defaultFolderTitle') : t('aiPanel.defaultSessionTitle'),
      messages: [],
      sortOrder: Date.now(),
      updatedAt: new Date().toISOString(),
    };
    setAiSessions((prev) => [...prev, node]);
    persistAiSession(node);
    if (kind === 'session') setActiveAiSessionId(node.id);
  };

  const handleAiRename = (id: string, title: string) => {
    setAiSessions((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        const next = { ...s, title, updatedAt: new Date().toISOString() };
        persistAiSession(next);
        return next;
      }),
    );
  };

  const handleAiMove = (id: string, newParentId: string | null) => {
    setAiSessions((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        const next = { ...s, parentId: newParentId, updatedAt: new Date().toISOString() };
        persistAiSession(next);
        return next;
      }),
    );
  };

  /** Collects an AI node plus its whole subtree (folders cascade). */
  const collectAiSubtree = (id: string): Set<string> => {
    const out = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of aiSessions) {
        if (s.parentId && out.has(s.parentId) && !out.has(s.id)) {
          out.add(s.id);
          grew = true;
        }
      }
    }
    return out;
  };

  /** Deleting from the sidebar moves the node (with its subtree) into the recycle bin. */
  const handleAiDelete = (id: string) => {
    const doomed = collectAiSubtree(id);
    const now = new Date().toISOString();
    setAiSessions((prev) =>
      prev.map((s) => {
        if (!doomed.has(s.id) || s.trashed) return s;
        const next = { ...s, trashed: true, updatedAt: now };
        persistAiSession(next);
        return next;
      }),
    );
    setActiveAiSessionId((cur) => (cur && doomed.has(cur) ? null : cur));
  };

  /** Restores a recycle-bin entry (and its trashed subtree); orphans re-attach at the root. */
  const handleAiRestore = (id: string) => {
    const target = aiSessions.find((s) => s.id === id);
    if (!target?.trashed) return;
    const restoring = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of aiSessions) {
        if (s.trashed && s.parentId && restoring.has(s.parentId) && !restoring.has(s.id)) {
          restoring.add(s.id);
          grew = true;
        }
      }
    }
    const parent = target.parentId ? aiSessions.find((s) => s.id === target.parentId) : undefined;
    const parentOk = target.parentId === null || (parent && !parent.trashed);
    const now = new Date().toISOString();
    setAiSessions((prev) =>
      prev.map((s) => {
        if (!restoring.has(s.id)) return s;
        const next = {
          ...s,
          trashed: false,
          parentId: s.id === id && !parentOk ? null : s.parentId,
          updatedAt: now,
        };
        persistAiSession(next);
        return next;
      }),
    );
  };

  /** Permanently deletes one recycle-bin entry (tombstone, so the deletion syncs). */
  const handleAiDeleteForever = (id: string) => {
    const doomed = collectAiSubtree(id);
    setAiSessions((prev) => prev.filter((s) => !doomed.has(s.id)));
    for (const doomedId of doomed) void storage.deleteAiSession(doomedId);
    setActiveAiSessionId((cur) => (cur && doomed.has(cur) ? null : cur));
    scheduleAiSessionPush();
  };

  /** Permanently deletes everything in the AI recycle bin. */
  const handleAiEmptyTrash = () => {
    const doomed = new Set(aiSessions.filter((s) => s.trashed).map((s) => s.id));
    setAiSessions((prev) => prev.filter((s) => !doomed.has(s.id)));
    for (const doomedId of doomed) void storage.deleteAiSession(doomedId);
    setActiveAiSessionId((cur) => (cur && doomed.has(cur) ? null : cur));
    scheduleAiSessionPush();
  };

  const handleAiMessagesChange = (sessionId: string, messages: AiMessage[]) => {
    setAiSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        const next = { ...s, messages, updatedAt: new Date().toISOString() };
        persistAiSession(next);
        return next;
      }),
    );
  };

  /** Appends against the *current* session state so edits made while streaming aren't clobbered. */
  const appendAiMessage = (sessionId: string, msg: AiMessage) => {
    setAiSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        const next = { ...s, messages: [...s.messages, msg], updatedAt: new Date().toISOString() };
        persistAiSession(next);
        return next;
      }),
    );
  };

  /** Turns a stored AiMessage into API content blocks (attachments become image/document/text blocks). */
  const aiMessageToApi = (m: AiMessage): AiChatMessage => {
    if (!m.attachments || m.attachments.length === 0) return { role: m.role, content: m.content };
    const blocks: AiContentBlock[] = [];
    for (const a of m.attachments) {
      if (a.kind === 'image' && a.dataBase64) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.dataBase64 } });
      } else if (a.kind === 'pdf' && a.dataBase64) {
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: a.dataBase64 },
        });
      } else if (a.text) {
        blocks.push({ type: 'text', text: `[Attachment: ${a.name}]\n${a.text}` });
      }
    }
    if (m.content) blocks.push({ type: 'text', text: m.content });
    return { role: m.role, content: blocks };
  };

  // The in-flight AI run lives here (not in AiWorkbench) so that switching sessions or views
  // never aborts a streaming reply — it finishes in the background and lands in its session.
  const runAiRequest = async (sessionId: string, text: string, attachments: AiAttachment[]) => {
    if (!aiSettings?.apiKey || aiAbortRef.current) return;
    const session = aiSessions.find((s) => s.id === sessionId && s.kind === 'session');
    if (!session) return;
    const userMsg: AiMessage = {
      role: 'user',
      content: text,
      ts: new Date().toISOString(),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    const base = [...session.messages, userMsg];
    handleAiMessagesChange(sessionId, base);
    setAiRunError(null);
    const startedAt = Date.now();
    setAiRun({ sessionId, text: '', startedAt });
    const ac = new AbortController();
    aiAbortRef.current = ac;
    let acc = '';
    let thinking = 0;
    let searches = 0;
    // When the first streamed content (text or hidden thinking) arrived — shown in the reply's
    // timestamp line alongside the completion time.
    let receiveStartTs: string | null = null;
    const markReceiveStart = () => {
      if (!receiveStartTs) receiveStartTs = new Date().toISOString();
    };
    try {
      const client = new AnthropicClient(aiSettings.apiKey);
      const result = await client.streamMessage({
        model: aiSettings.model || DEFAULT_CLAUDE_MODEL,
        maxTokens: aiSettings.maxTokens,
        webSearch: aiSettings.webSearch,
        webSearchMaxUses: aiSettings.webSearchMaxUses,
        messages: base.map(aiMessageToApi),
        signal: ac.signal,
        onDelta: (delta) => {
          markReceiveStart();
          acc += delta;
          setAiRun({ sessionId, text: acc, thinkingChars: thinking, webSearches: searches, startedAt });
        },
        onThinking: (total) => {
          markReceiveStart();
          thinking = total;
          setAiRun({ sessionId, text: acc, thinkingChars: total, webSearches: searches, startedAt });
        },
        onWebSearch: (total) => {
          markReceiveStart();
          searches = total;
          setAiRun({ sessionId, text: acc, thinkingChars: thinking, webSearches: total, startedAt });
        },
      });
      const finalText = result.text || acc;
      if (finalText) {
        appendAiMessage(sessionId, {
          role: 'assistant',
          content: finalText,
          ts: new Date().toISOString(),
          ...(receiveStartTs ? { startedTs: receiveStartTs } : {}),
        });
        if (result.stopReason === 'max_tokens') {
          setAiRunError({ sessionId, message: t('aiWorkbench.truncatedMaxTokens') });
        }
      } else {
        // Stream finished but produced no visible text — typically the whole token budget was
        // consumed by hidden thinking (stop_reason=max_tokens). Surface it instead of silence.
        setAiRunError({
          sessionId,
          message:
            result.stopReason === 'max_tokens'
              ? t('aiWorkbench.emptyMaxTokens')
              : t('aiWorkbench.emptyReply', { reason: result.stopReason ?? 'unknown' }),
        });
      }
    } catch (err) {
      // A user-initiated stop keeps whatever partial text already streamed in.
      if (acc) {
        appendAiMessage(sessionId, {
          role: 'assistant',
          content: acc,
          ts: new Date().toISOString(),
          ...(receiveStartTs ? { startedTs: receiveStartTs } : {}),
        });
      }
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        const message =
          err instanceof AnthropicTimeoutError
            ? t(err.phase === 'connect' ? 'aiWorkbench.timeoutConnect' : 'aiWorkbench.timeoutStream')
            : err instanceof Error
              ? err.message
              : String(err);
        setAiRunError({ sessionId, message });
      }
    } finally {
      setAiRun(null);
      aiAbortRef.current = null;
    }
  };

  const handleAiStop = () => {
    aiAbortRef.current?.abort();
  };

  const handleAiDeleteMessage = (sessionId: string, index: number) => {
    const session = aiSessions.find((s) => s.id === sessionId);
    if (!session) return;
    handleAiMessagesChange(
      sessionId,
      session.messages.filter((_, i) => i !== index),
    );
  };

  /** Creates a root-level note from an AI session's messages (a Q&A range or all of them). */
  const handleAiConvertToNote = async (sessionId: string, messages: AiMessage[]) => {
    if (!keys || messages.length === 0) return;
    const session = aiSessions.find((s) => s.id === sessionId);
    if (!session) return;
    const fmtTs = (iso: string) => {
      const d = new Date(iso);
      return isNaN(d.getTime()) ? iso : d.toLocaleString();
    };
    const md = messages
      .map((m) => {
        const heading = m.role === 'user' ? t('aiWorkbench.roleUser') : t('aiWorkbench.roleAssistant');
        const attach = m.attachments?.length
          ? `\n\n${m.attachments.map((a) => `> 📎 ${a.name}`).join('\n')}`
          : '';
        return `## ${heading} · ${fmtTs(m.ts)}${attach}\n\n${m.content}`;
      })
      .join('\n\n---\n\n');
    const sortOrder = notes.filter((n) => n.parentId === null && !n.deleted).length;
    const node = newNode('note', null, sortOrder, locale);
    node.title = t('aiWorkbench.noteTitle', { title: session.title });
    node.contentMd = md;
    node.contentHash = hashContent(md);
    await saveNoteNow(node);
    openNote(node.id, { pin: true });
    setAppView('notes');
  };

  /** Wraps prepareAiAttachment to surface localized error messages in the workbench UI. */
  const handlePrepareAiAttachment = async (file: File): Promise<AiAttachment> => {
    try {
      return await prepareAiAttachment(file);
    } catch (err) {
      if (err instanceof AiAttachmentError) {
        const key =
          err.code === 'tooLarge'
            ? 'aiWorkbench.attachTooLarge'
            : err.code === 'emptyDoc'
              ? 'aiWorkbench.attachEmpty'
              : 'aiWorkbench.attachUnsupported';
        throw new Error(t(key, { name: err.fileName }));
      }
      throw err;
    }
  };

  const activeAiSession =
    aiSessions.find((s) => s.id === activeAiSessionId && s.kind === 'session') ?? null;

  const pinTabInGroup = (groupId: string, tabId: string) => {
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId ? { ...g, tabs: g.tabs.map((tb) => (tb.id === tabId ? { ...tb, pinned: true } : tb)) } : g,
      ),
    );
  };

  const closeTabInGroup = (groupId: string, tabId: string) => {
    const idx = groups.findIndex((g) => g.id === groupId);
    if (idx === -1) return;
    const group = groups[idx];
    const tabIdx = group.tabs.findIndex((tb) => tb.id === tabId);
    if (tabIdx === -1) return;
    const tabs = group.tabs.filter((tb) => tb.id !== tabId);
    let activeTabId = group.activeTabId;
    if (activeTabId === tabId) {
      activeTabId = (tabs[tabIdx] ?? tabs[tabIdx - 1] ?? null)?.id ?? null;
    }
    let next = groups.map((g, i) => (i === idx ? { ...g, tabs, activeTabId } : g));
    if (tabs.length === 0 && next.length > 1) {
      next = next.filter((g) => g.id !== groupId);
      if (activeGroupId === groupId) setActiveGroupId(next[0]?.id ?? 'g1');
    }
    setGroups(next);
  };

  const reorderTabInGroup = (groupId: string, dragId: string, targetId: string, position: 'before' | 'after') => {
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        const tabs = [...g.tabs];
        const dragIdx = tabs.findIndex((tb) => tb.id === dragId);
        if (dragIdx === -1) return g;
        const [dragTab] = tabs.splice(dragIdx, 1);
        let targetIdx = tabs.findIndex((tb) => tb.id === targetId);
        if (targetIdx === -1) {
          tabs.push(dragTab);
          return { ...g, tabs };
        }
        if (position === 'after') targetIdx += 1;
        tabs.splice(targetIdx, 0, dragTab);
        return { ...g, tabs };
      }),
    );
  };

  const splitTabToOtherGroup = (fromGroupId: string, tabId: string) => {
    const fromIdx = groups.findIndex((g) => g.id === fromGroupId);
    if (fromIdx === -1) return;
    const fromGroup = groups[fromIdx];
    const tab = fromGroup.tabs.find((tb) => tb.id === tabId);
    if (!tab) return;
    const otherGroup = groups.find((g) => g.id !== fromGroupId);
    const targetGroupId = otherGroup ? otherGroup.id : fromGroupId === 'g1' ? 'g2' : 'g1';
    let next: TabGroupState[] = otherGroup ? [...groups] : [...groups, { id: targetGroupId, tabs: [], activeTabId: null }];

    const fromTabs = fromGroup.tabs.filter((tb) => tb.id !== tabId);
    const fromActiveTabId = fromGroup.activeTabId === tabId ? (fromTabs[0]?.id ?? null) : fromGroup.activeTabId;

    next = next.map((g) => {
      if (g.id === fromGroupId) return { ...g, tabs: fromTabs, activeTabId: fromActiveTabId };
      if (g.id === targetGroupId) return { ...g, tabs: [...g.tabs, tab], activeTabId: tab.id };
      return g;
    });
    if (fromTabs.length === 0 && next.length > 1) {
      next = next.filter((g) => g.id !== fromGroupId);
    }
    setGroups(next);
    setActiveGroupId(targetGroupId);
  };

  const handleDeleteMany = async (ids: string[]) => {
    if (!keys || ids.length === 0) return;
    // Deleting a folder deletes its whole subtree.
    const doomed = new Set<string>();
    const queue = [...ids];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (doomed.has(id)) continue;
      doomed.add(id);
      notes.forEach((n) => {
        if (n.parentId === id) queue.push(n.id);
      });
    }
    for (const id of doomed) {
      const target = notes.find((n) => n.id === id);
      if (!target) continue;
      await storage.deleteAttachmentsByNote(id, keys.notesKey);
      if (session) {
        // Tombstone (with cleared plaintext) until the deletion has been pushed to the server;
        // the sync client purges the row after a successful push.
        const updated = buildUpdated(target, { deleted: true, title: '', contentMd: '' });
        await storage.saveNote(updated, keys.notesKey);
      } else {
        // Local-only vault: nothing to propagate to, so remove the row outright — lingering
        // tombstones only slow down unlock.
        await storage.deleteNote(id);
      }
      removeFromSearch(id);
    }
    if (!session) await storage.purgeDeleted();
    setSearchTick((n) => n + 1);
    const remaining = notes.filter((n) => !doomed.has(n.id));
    setNotes(remaining);
    setTreeSelectedIds((prev) => {
      if (![...prev].some((id) => doomed.has(id))) return prev;
      const next = new Set([...prev].filter((id) => !doomed.has(id)));
      return next;
    });
    pruneStaleTabs(
      new Set(remaining.filter((n) => isEditableContentNode(n) && !n.trashed).map((n) => n.id)),
    );
    void syncAttachmentsIfOnline();
  };

  /** Collects `ids` plus every descendant, walking the full notes list (trashed included). */
  const collectSubtree = (ids: string[]): Set<string> => {
    const out = new Set<string>();
    const queue = [...ids];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      notes.forEach((n) => {
        if (n.parentId === id) queue.push(n.id);
      });
    }
    return out;
  };

  /**
   * Moves nodes (with their subtrees) into the recycle bin. Unlike a real deletion this keeps
   * the content intact and syncs as a normal edit, so it's recoverable on every device.
   */
  const handleTrashMany = async (ids: string[]) => {
    if (!keys || ids.length === 0) return;
    const doomed = collectSubtree(ids);
    const next = notes.map((n) => {
      if (!doomed.has(n.id) || n.trashed) return n;
      const updated = buildUpdated(n, { trashed: true });
      void persistNote(updated); // persistNote's upsertSearch drops trashed notes from the index
      return updated;
    });
    setSearchTick((n) => n + 1);
    setNotes(next);
    setTreeSelectedIds((prev) => {
      if (![...prev].some((id) => doomed.has(id))) return prev;
      return new Set([...prev].filter((id) => !doomed.has(id)));
    });
    pruneStaleTabs(new Set(next.filter((n) => isEditableContentNode(n) && !n.trashed).map((n) => n.id)));
  };

  /**
   * Restores a recycle-bin entry (and its trashed subtree). When the original parent is gone or
   * itself still in the bin, the node re-attaches at the root instead of staying orphaned.
   */
  const handleRestoreFromTrash = async (id: string) => {
    if (!keys) return;
    const byId = new Map(notes.map((n) => [n.id, n]));
    const target = byId.get(id);
    if (!target?.trashed) return;
    const restoring = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of notes) {
        if (n.trashed && n.parentId && restoring.has(n.parentId) && !restoring.has(n.id)) {
          restoring.add(n.id);
          grew = true;
        }
      }
    }
    const parent = target.parentId ? byId.get(target.parentId) : undefined;
    const parentOk = target.parentId === null || (parent && !parent.trashed && !parent.deleted);
    const next = notes.map((n) => {
      if (!restoring.has(n.id)) return n;
      const patch: Partial<NoteNode> = { trashed: false };
      if (n.id === id && !parentOk) patch.parentId = null;
      const updated = buildUpdated(n, patch);
      void persistNote(updated);
      return updated;
    });
    setSearchTick((n) => n + 1);
    setNotes(next);
  };

  /** Permanently deletes everything in the recycle bin (real tombstone/hard-delete path). */
  const handleEmptyTrash = async () => {
    await handleDeleteMany(notes.filter((n) => n.trashed).map((n) => n.id));
  };

  handleTrashManyRef.current = handleTrashMany;

  // --- Cross-vault transfer ------------------------------------------------------------------

  /** Opens the transfer dialog for a node (plus the multi-selection when it contains the node). */
  const handleTransferRequest = (id: string) => {
    const ids = treeSelectedIds.has(id) ? [...treeSelectedIds] : [id];
    setTransferError(null);
    setTransferProgress(null);
    setTransferIds(ids);
  };

  /**
   * Copies/moves the selected subtrees into another registered vault: verifies the target vault's
   * password, re-encrypts everything with the target's keys, regenerates every UUID (avoiding
   * collisions), remaps parent ids, and rewrites `fnattach:` references to the newly saved
   * attachment ids. Move = copy + regular delete of the source nodes afterwards.
   */
  const handleTransferToVault = async (
    targetNamespace: string,
    password: string,
    mode: 'copy' | 'move',
  ) => {
    const k = keysRef.current;
    if (!k || !transferIds) return;
    setTransferBusy(true);
    setTransferError(null);
    try {
      const target = createStorage({ namespace: targetNamespace });
      const saltB64 = await target.getMeta(META_KEYS.salt);
      const verifier = await target.getMeta(META_KEYS.passwordVerifier);
      if (!saltB64 || !verifier) throw new Error(t('vaultTransfer.targetNotInitialized'));
      const derived = await deriveKeysFromPassword(password, fromBase64(saltB64));
      if (toBase64(derived.passwordVerifier) !== verifier) {
        throw new Error(t('vaultApp.wrongPassword'));
      }

      const byId = new Map(notes.map((n) => [n.id, n]));
      const requested = transferIds.filter((id) => byId.has(id));
      // Drop ids already contained in another selected subtree so nothing is copied twice.
      const requestedSet = new Set(requested);
      const isInsideSelection = (node: NoteNode): boolean => {
        let p = node.parentId;
        while (p) {
          if (requestedSet.has(p)) return true;
          p = byId.get(p)?.parentId ?? null;
        }
        return false;
      };
      const roots = requested.filter((id) => !isInsideSelection(byId.get(id)!));

      const collected: NoteNode[] = [];
      const queue = [...roots];
      while (queue.length > 0) {
        const id = queue.pop()!;
        const node = byId.get(id);
        if (!node || node.deleted) continue;
        collected.push(node);
        for (const n of notes) {
          if (n.parentId === id) queue.push(n.id);
        }
      }
      if (collected.length === 0) throw new Error(t('vaultTransfer.nothingToTransfer'));

      const idMap = new Map(collected.map((n) => [n.id, crypto.randomUUID()]));
      const now = new Date().toISOString();
      let done = 0;
      for (const node of collected) {
        setTransferProgress(t('vaultTransfer.progress', { done, total: collected.length }));
        let contentMd = node.contentMd;
        if (isEditableContentNode(node)) {
          const atts = await storage.listAttachments(node.id, k.notesKey);
          for (const att of atts) {
            const loaded = await storage.loadAttachmentDecrypted(att.id, k.notesKey);
            if (!loaded) continue;
            const saved = await target.saveAttachment(
              idMap.get(node.id)!,
              loaded.meta.fileName,
              loaded.meta.description,
              loaded.meta.mimeType,
              loaded.data,
              derived.notesKey,
            );
            // fnattach: references embed the attachment UUID; point them at the new copy.
            contentMd = contentMd.split(att.id).join(saved.id);
          }
        }
        const copied: NoteNode = {
          ...node,
          id: idMap.get(node.id)!,
          parentId: node.parentId && idMap.has(node.parentId) ? idMap.get(node.parentId)! : null,
          contentMd,
          contentHash: hashContent(contentMd),
          version: 1,
          serverVersion: 0,
          syncStatus: 'pending',
          deleted: false,
          updatedAt: now,
        };
        await target.saveNote(copied, derived.notesKey);
        done++;
      }
      setTransferProgress(null);
      if (mode === 'move') {
        await handleDeleteMany(roots);
      }
      setTransferIds(null);
      alert(t('vaultTransfer.done', { count: collected.length }));
    } catch (err) {
      setTransferProgress(null);
      setTransferError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusy(false);
    }
  };

  const syncAttachmentsIfOnline = useCallback(async () => {
    if (!keys || !session) return;
    try {
      const client = new SyncClient(new ApiClient(serverUrl, locale), session);
      await client.syncAttachments(storage);
      if (activeId) {
        const node = notes.find(
          (n) => n.id === activeId && (n.nodeType === 'note' || n.nodeType === 'table'),
        );
        if (node) await refreshAttachments(node.id);
      }
    } catch (err) {
      if (err instanceof ApiAuthError) expireSession();
      /* otherwise: server offline, retried on next occasion */
    }
  }, [keys, session, serverUrl, storage, activeId, notes, refreshAttachments, expireSession]);

  const handleInsertAttachment = useCallback(
    (att: NoteAttachment) => {
      const ref = buildAttachmentMarkdownRef(att);
      const node = notes.find((n) => n.id === activeId);
      if (node?.nodeType === 'table') {
        insertTableRef.current(ref);
      } else {
        insertDocRef.current(ref);
      }
    },
    [activeId, notes],
  );

  const handleAttachmentDownload = useCallback(
    async (id: string) => {
      if (!keys) return;
      const loaded = await storage.loadAttachmentDecrypted(id, keys.notesKey);
      if (loaded) downloadBlob(loaded.meta.fileName, loaded.data, loaded.meta.mimeType);
    },
    [keys, storage],
  );

  const attachmentLookup = useCallback(
    (id: string) => attachments.find((a) => a.id === id),
    [attachments],
  );

  const handleAttachmentEdit = useCallback(
    async (id: string, description: string) => {
      if (!keys || !activeId) return;
      await storage.updateAttachmentDescription(id, description, keys.notesKey);
      await refreshAttachments(activeId);
      void syncAttachmentsIfOnline();
    },
    [keys, activeId, storage, refreshAttachments, syncAttachmentsIfOnline],
  );

  const renderAttachmentsPanel = (ownerId: string, showInsert: boolean) =>
    keys ? (
      <NoteAttachments
        attachments={attachments}
        loading={attachmentsLoading}
        onUpload={async (file, description) => {
          const data = new Uint8Array(await file.arrayBuffer());
          await storage.saveAttachment(
            ownerId,
            file.name,
            description,
            file.type || 'application/octet-stream',
            data,
            keys.notesKey,
          );
          await refreshAttachments(ownerId);
          void syncAttachmentsIfOnline();
        }}
        onUpdateDescription={async (id, description) => {
          await storage.updateAttachmentDescription(id, description, keys.notesKey);
          await refreshAttachments(ownerId);
          void syncAttachmentsIfOnline();
        }}
        onDownload={handleAttachmentDownload}
        onDelete={async (id) => {
          await storage.deleteAttachment(id, keys.notesKey);
          await refreshAttachments(ownerId);
          void syncAttachmentsIfOnline();
        }}
        onInsert={showInsert ? handleInsertAttachment : undefined}
      />
    ) : null;

  const requireUnlockedKeys = (): VaultKeys => {
    if (!keys) throw new Error(t('vaultApp.localVaultNotUnlocked'));
    return keys;
  };

  const passwordProofFromVault = (derived: VaultKeys): string => toBase64(derived.passwordVerifier);

  const ensureLocalPubkeys = async (derived: VaultKeys) => {
    await setupIdentityKeys(derived);
    const identity = await storage.getMeta(META_KEYS.identityPubkey);
    const exchange = await storage.getMeta(META_KEYS.exchangePubkey);
    if (!identity || !exchange) throw new Error(t('vaultApp.localKeysNotReady'));
    return { identity, exchange };
  };

  const syncLocalExchangeKeys = async (derived: VaultKeys, userSession?: UserSession) => {
    const priv = await loadExchangePrivate(derived.masterKey);
    if (!priv) throw new Error(t('vaultApp.localChatKeyNotReady'));
    const derivedPub = verifyExchangeKeypair(priv);
    const storedPub = await storage.getMeta(META_KEYS.exchangePubkey);
    if (storedPub !== derivedPub) {
      await storage.setMeta(META_KEYS.exchangePubkey, derivedPub);
    }
    if (userSession) {
      const { identity } = await ensureLocalPubkeys(derived);
      await new ApiClient(serverUrl, locale).updateKeys(userSession.token, identity, derivedPub);
    }
    return priv;
  };

  const uploadKeysIfNeeded = async (
    userSession: UserSession,
    derived: VaultKeys,
    baseUrl = serverUrl,
  ) => {
    await syncLocalExchangeKeys(derived, userSession);
    void baseUrl;
  };

  const ensureVaultSaltOnServer = async (
    userSession: UserSession,
    baseUrl = serverUrl,
  ) => {
    const saltB64 = await storage.getMeta(META_KEYS.salt);
    if (!saltB64) return;
    try {
      await new ApiClient(baseUrl, locale).uploadVaultSalt(userSession.token, saltB64);
    } catch {
      /* optional backfill for accounts created before vault_salt */
    }
  };

  const runCloudSync = async (
    derived: VaultKeys,
    userSession: UserSession,
    initialNotes: NoteNode[],
    baseUrl = serverUrl,
  ) => {
    const client = new SyncClient(new ApiClient(baseUrl, locale), userSession);
    const result = await client.syncAll(initialNotes, derived.notesKey, saveNoteNow, storage);
    setNotes(result.notes);
    // Pushes don't change local content, so the index only needs a rebuild when something was
    // actually pulled or merged.
    if (result.result.pulled > 0 || result.result.conflicts > 0) {
      rebuildSearchIndex(result.notes);
    }
    await saveSearchSnapshot(derived.indexKey, result.notes);
    await loadChatHistory(derived);
    const { pushed, pulled, conflicts, attachmentsPushed, attachmentsPulled } = result.result;
    setSyncStatus(
      t('vaultApp.syncResult', {
        pushed,
        pulled,
        attachmentsPushed,
        attachmentsPulled,
        conflicts: conflicts ? t('vaultApp.syncConflictsSuffix', { count: conflicts }) : '',
      }),
    );
    return result;
  };

  const handleCloudSync = async ({
    password,
    username,
    serverUrl: nextServerUrl,
  }: {
    password: string;
    username: string;
    serverUrl: string;
  }) => {
    // A brand-new server origin can't be reached until the page's CSP is rebuilt around it, so
    // logging in against it right away would just fail with an opaque network error. Save the
    // address, tell the user what's happening, and reload — after the reload the unlock screen
    // reopens on this tab with the address prefilled, ready for the actual login. (No native
    // confirm here: on Windows/Electron it wrecks keyboard focus across the reload.)
    if (serverUrlNeedsReload(nextServerUrl)) {
      saveServerUrl(nextServerUrl);
      setServerUrl(nextServerUrl);
      try {
        sessionStorage.setItem(UNLOCK_TAB_HINT_KEY, 'cloud');
      } catch {
        /* private mode etc. — worst case the user re-picks the tab */
      }
      window.setTimeout(() => window.location.reload(), 1800);
      throw new Error(t('unlockScreen.serverChangedReloading'));
    }
    commitServerUrl(nextServerUrl);
    const api = new ApiClient(nextServerUrl, locale);
    await assertVaultUsernameMatch(username);

    let saltB64 = await storage.getMeta(META_KEYS.salt);
    if (!saltB64) {
      const saltInfo = await api.getVaultSaltInfo(username);
      if (saltInfo.status === 'user_not_found') {
        throw new Error(t('vaultApp.cloudAccountNotFound'));
      }
      if (saltInfo.status === 'vault_salt_missing') {
        throw new Error(t('vaultApp.vaultParamsMissing'));
      }
      saltB64 = saltInfo.vault_salt;
      const derived = await deriveKeysFromPassword(password, fromBase64(saltB64));
      const proof = toBase64(derived.passwordVerifier);
      const userSession = await api.login(username, proof);
      await storage.setMeta(META_KEYS.salt, saltB64);
      await storage.setMeta(META_KEYS.passwordVerifier, proof);
      await setupIdentityKeys(derived);
      await bindVaultUsername(username);
      saveSession(userSession, loadStorageNamespace());
      setSession(userSession);
      setSessionExpired(false);
      setVaultListItems((prev) =>
        prev.map((v) =>
          v.id === activeVaultId
            ? { ...v, initialized: true, boundUsername: username.trim() }
            : v,
        ),
      );
      keysRef.current = derived;
      setKeys(derived);
      setIsFirstRun(false);
      // Brand-new cloud account: there is no prior tab state to restore, so
      // this session's tabs are immediately eligible for persistence.
      tabStateReadyRef.current = true;
      await uploadKeysIfNeeded(userSession, derived, nextServerUrl);
      await initIM(derived, userSession);
      await runCloudSync(derived, userSession, [], nextServerUrl);
      return;
    }

    const derived = await deriveKeysFromPassword(password, fromBase64(saltB64));
    const verifier = await storage.getMeta(META_KEYS.passwordVerifier);
    if (!verifier || toBase64(derived.passwordVerifier) !== verifier) {
      throw new Error(t('vaultApp.wrongPassword'));
    }
    await setupIdentityKeys(derived);
    const userSession = await api.login(username, toBase64(derived.passwordVerifier));
    await bindVaultUsername(username);
    saveSession(userSession, loadStorageNamespace());
    setSession(userSession);
    setSessionExpired(false);
    setVaultListItems((prev) =>
      prev.map((v) =>
        v.id === activeVaultId ? { ...v, boundUsername: username.trim() } : v,
      ),
    );
    keysRef.current = derived;
    setKeys(derived);
    await loadNotes(derived);
    await ensureVaultSaltOnServer(userSession, nextServerUrl);
    await uploadKeysIfNeeded(userSession, derived, nextServerUrl);
    await initIM(derived, userSession);

    const stubs = await storage.listNotes();
    const decrypted: NoteNode[] = [];
    for (const stub of stubs) {
      const full = await storage.loadNoteDecrypted(stub.id, derived.notesKey);
      if (full) decrypted.push(full);
    }
    await runCloudSync(derived, userSession, decrypted, nextServerUrl);
  };

  const handleRegister = async (username: string) => {
    const derived = requireUnlockedKeys();
    await assertVaultUsernameMatch(username);
    const proof = passwordProofFromVault(derived);
    const { identity, exchange } = await ensureLocalPubkeys(derived);
    const saltB64 = await storage.getMeta(META_KEYS.salt);
    const api = new ApiClient(serverUrl, locale);
    const s = await api.register(username, proof, {
      identity_pubkey: identity,
      exchange_pubkey: exchange,
    }, saltB64 ?? undefined);
    await bindVaultUsername(username);
    saveSession(s, loadStorageNamespace());
    setSession(s);
    setSessionExpired(false);
    setVaultListItems((prev) =>
      prev.map((v) =>
        v.id === activeVaultId ? { ...v, boundUsername: username.trim() } : v,
      ),
    );
    await initIM(derived, s);
  };

  const handleLogin = async (username: string) => {
    const derived = requireUnlockedKeys();
    await assertVaultUsernameMatch(username);
    const proof = passwordProofFromVault(derived);
    const api = new ApiClient(serverUrl, locale);
    const s = await api.login(username, proof);
    await bindVaultUsername(username);
    saveSession(s, loadStorageNamespace());
    setSession(s);
    setSessionExpired(false);
    setVaultListItems((prev) =>
      prev.map((v) =>
        v.id === activeVaultId ? { ...v, boundUsername: username.trim() } : v,
      ),
    );
    await ensureVaultSaltOnServer(s);
    await uploadKeysIfNeeded(s, derived);
    await initIM(derived, s);
    void syncAttachmentsIfOnline();
    // Pull the full chat history right after login (new device / re-login) instead of waiting
    // for a manual sync — messages are immutable ciphertext blobs, so this is cheap and safe.
    void (async () => {
      try {
        const client = new SyncClient(api, s);
        const { pulled } = await client.syncChatMessages(storage);
        if (pulled > 0 && keysRef.current) await loadChatHistory(keysRef.current);
        const k = keysRef.current;
        if (k) {
          const ai = await client.syncAiSessions(storage, k.notesKey);
          if (ai.pulled > 0 && keysRef.current === k) {
            const aiList = await storage.listAiSessions(k.notesKey);
            setAiSessions(aiList);
            setActiveAiSessionId((cur) => (cur && aiList.some((n) => n.id === cur) ? cur : null));
          }
        }
      } catch (err) {
        console.warn('[FastNote] chat: history sync after login failed', err);
      }
    })();
  };

  const handleSync = async () => {
    if (!keys || !session) {
      setShowAuth(true);
      return;
    }
    setSyncStatus(t('vaultApp.syncing'));
    try {
      await ensureVaultSaltOnServer(session);
      const client = new SyncClient(new ApiClient(serverUrl, locale), session);
      const result = await client.syncAll(notes, keys.notesKey, saveNoteNow, storage);
      setNotes(result.notes);
      if (result.result.pulled > 0 || result.result.conflicts > 0) {
        rebuildSearchIndex(result.notes);
      }
      await saveSearchSnapshot(keys.indexKey, result.notes);
      await loadChatHistory(keys);
      if (result.result.aiPulled > 0) {
        // AI sessions pulled from another device: refresh the tree, keeping the active session
        // when it still exists.
        const list = await storage.listAiSessions(keys.notesKey);
        setAiSessions(list);
        setActiveAiSessionId((cur) => (cur && list.some((s) => s.id === cur) ? cur : null));
      }
      const { pushed, pulled, conflicts, attachmentsPushed, attachmentsPulled } = result.result;
      setSyncStatus(
        t('vaultApp.syncResult', {
          pushed,
          pulled,
          attachmentsPushed,
          attachmentsPulled,
          conflicts: conflicts ? t('vaultApp.syncConflictsSuffix', { count: conflicts }) : '',
        }),
      );
      if (activeId) {
        const node = notes.find(
          (n) => n.id === activeId && (n.nodeType === 'note' || n.nodeType === 'table'),
        );
        if (node) await refreshAttachments(node.id);
      }
    } catch (err) {
      // The status line only shows a short localized message; the full error (stack, fetch
      // failure reason, server detail already logged by ApiClient) goes to the captured logs.
      console.error('[FastNote] sync: failed', err);
      if (err instanceof ApiAuthError) {
        expireSession();
        setShowAuth(true);
      }
      setSyncStatus(err instanceof Error ? err.message : t('vaultApp.syncFailed'));
    }
  };

  const handleStartChat = async (username: string) => {
    if (!session) throw new Error(t('vaultApp.loginRequired'));
    const api = new ApiClient(serverUrl, locale);
    const peer = await api.lookupUser(session.token, username);
    if (!peer.exchangePubkey) {
      throw new Error(t('vaultApp.peerKeyNotReady', { username: peer.username }));
    }
    const client = await ensureImReady();
    client.upsertSession(peer.userId, peer.username, peer.exchangePubkey);
    saveChatSessions(client.allSessions(), loadStorageNamespace());
    setActivePeerId(peer.userId);
    setActivePeerName(peer.username);
  };

  const handleSendChat = async (body: string, files: File[]) => {
    if (!activePeerId || !keys) return;
    const client = await ensureChatPeerSession(activePeerId, activePeerName);
    const messageId = crypto.randomUUID();
    const wireAttachments: ChatWireAttachment[] = [];
    for (const file of files) {
      const buf = new Uint8Array(await file.arrayBuffer());
      wireAttachments.push({
        id: crypto.randomUUID(),
        fileName: file.name,
        description: '',
        mimeType: file.type || 'application/octet-stream',
        size: buf.byteLength,
        dataB64: toBase64(buf),
      });
    }
    const refs: ChatAttachmentRef[] = [];
    for (const att of wireAttachments) {
      const ref = await storage.saveChatAttachmentFromWire(messageId, activePeerId, att, keys.notesKey);
      refs.push(ref);
    }
    const payload = { v: 1 as const, body, attachments: wireAttachments };
    await client.sendPayload(activePeerId, payload, messageId);
    saveChatSessions(client.allSessions(), loadStorageNamespace());
    const msg: ChatMessage = {
      id: messageId,
      peerId: activePeerId,
      peerUsername: activePeerName ?? undefined,
      direction: 'out',
      body,
      attachments: refs,
      sentAt: new Date().toISOString(),
      status: 'sent',
    };
    await persistChatMessage(msg);
  };

  const handleDeleteChatMessage = async (messageId: string) => {
    if (!keys) return;
    await storage.deleteChatMessage(messageId, keys.notesKey);
    setChatMessages((prev) => prev.filter((m) => m.id !== messageId));
  };

  const handleChatAttachmentDownload = async (attachmentId: string) => {
    if (!keys) return;
    const loaded = await storage.loadChatAttachmentDecrypted(attachmentId, keys.notesKey);
    if (!loaded) return;
    downloadBlob(loaded.meta.fileName, loaded.data, loaded.meta.mimeType);
  };

  const handleChatAttachmentPreview = async (attachmentId: string): Promise<Blob | null> => {
    if (!keys) return null;
    const loaded = await storage.loadChatAttachmentDecrypted(attachmentId, keys.notesKey);
    if (!loaded) return null;
    return new Blob([loaded.data.slice()], { type: loaded.meta.mimeType || 'application/octet-stream' });
  };

  const handleChatAttachmentEdit = async (attachmentId: string, description: string) => {
    if (!keys) return;
    await storage.updateChatAttachmentDescription(attachmentId, description, keys.notesKey);
    setChatMessages((prev) =>
      prev.map((m) => {
        if (!m.attachments?.some((a) => a.id === attachmentId)) return m;
        const attachments = m.attachments.map((a) =>
          a.id === attachmentId ? { ...a, description } : a,
        );
        const updated = { ...m, attachments };
        void storage.saveChatMessage(updated, keys.notesKey);
        return updated;
      }),
    );
  };

  const handleChatAttachmentRemove = async (messageId: string, attachmentId: string) => {
    if (!keys) return;
    await storage.deleteChatAttachment(attachmentId);
    setChatMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        const attachments = m.attachments?.filter((a) => a.id !== attachmentId) ?? [];
        const updated = { ...m, attachments };
        void storage.saveChatMessage(updated, keys.notesKey);
        return updated;
      }),
    );
  };

  const handleEditorModeForGroup = (groupId: string, next: EditorMode) => {
    const group = groups.find((g) => g.id === groupId);
    const current = editorModeByGroup[groupId] ?? 'wysiwyg';
    if (current === 'wysiwyg' && next === 'source' && group?.activeTabId) {
      const note = notes.find((n) => n.id === group.activeTabId && n.nodeType === 'note');
      if (note) {
        const md = flushEditorMarkdown(tiptapEditorByGroup[groupId] ?? null);
        if (md !== null) {
          updateNoteById(note.id, { contentMd: md });
        }
      }
    }
    setEditorModeByGroup((prev) => ({ ...prev, [groupId]: next }));
  };
  const contentForGroup = (group: TabGroupState) =>
    notes.find((n) => n.id === group.activeTabId && isEditableContentNode(n)) ?? null;
  const searchResults = useMemo(() => {
    if (!searchQuery) return [];
    // A stale snapshot can contain entries for documents that no longer exist (e.g. deleted on
    // another device) or that sit in the recycle bin; never surface those — and never show the
    // same note twice.
    const liveIds = new Set(notes.filter((n) => !n.deleted && !n.trashed).map((n) => n.id));
    const seen = new Set<string>();
    return searchIndexRef.current.search(searchQuery).filter((r) => {
      if (!liveIds.has(r.id) || seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  }, [searchQuery, searchTick, notes]);

  /**
   * After a global-search result is opened: switch that note's group to the source view and open
   * the find bar pre-filled with the query, so the keyword is highlighted and jumped to. Runs on
   * the next tick so openNote's state updates have landed and the group can be resolved.
   */
  const locateNoteInSource = (noteId: string, query: string) => {
    const q = query.trim();
    if (!q) return;
    window.setTimeout(() => {
      // Only markdown notes have a source view; tables would just get a dangling mode flag.
      if (notesRef.current.find((n) => n.id === noteId)?.nodeType !== 'note') return;
      const group = groupsRef.current.find((g) => g.activeTabId === noteId);
      if (!group) return;
      setEditorModeByGroup((prev) =>
        prev[group.id] === 'source' ? prev : { ...prev, [group.id]: 'source' },
      );
      setFindInitialQuery(q);
      setFindBarNonce((n) => n + 1);
      setFindBarGroupId(group.id);
    }, 0);
  };

  const handleSaveDataDirectory = async (dir: string) => {
    if (!dir) return;
    // Switching vaults/namespaces requires unlocking again, which means
    // tearing down the current React tree (UnlockScreen replaces it). Doing
    // that reset via setState + a blocking window.alert() used to leave the
    // renderer's keyboard focus in limbo in Electron (the native alert steals
    // OS-level focus and doesn't reliably hand it back to the freshly-mounted
    // password input) — the app looked fine but you could not type. A full
    // page reload sidesteps this entirely: on load the browser/renderer
    // always starts with a clean focus state, and UnlockScreen's autoFocus
    // reliably applies.
    if (!window.confirm(t('vaultApp.dataDirChangeConfirm'))) return;
    let saved = dir;
    if (window.fastnote?.setDataDirectory) {
      saved = await window.fastnote.setDataDirectory(dir);
    }
    const namespace = namespaceFromPath(saved);
    saveStorageNamespace(namespace);
    saveStoragePathLabel(saved);
    let reg = loadVaultRegistry();
    if (!reg.some((v) => v.namespace === namespace)) {
      const entry = createVaultRegistryEntry(saved.split(/[/\\]/).pop() || t('vaultApp.defaultDesktopVaultLabel'));
      entry.namespace = namespace;
      reg = [...reg, entry];
      saveVaultRegistry(reg);
    }
    window.location.reload();
  };

  const handlePickDataDirectory = async (): Promise<string | null> => {
    return window.fastnote?.pickStorageDirectory?.() ?? null;
  };

  const activeVault = vaultListItems.find((v) => v.id === activeVaultId);
  const activeVaultLabel =
    vaultRegistry.find((v) => v.id === activeVaultId)?.label ?? activeVault?.label ?? t('vaultApp.defaultVaultLabel');

  const handleGroupDividerResizeStart = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = e.currentTarget.parentElement;
    if (!container) return;
    const totalWidth = container.getBoundingClientRect().width;
    const startX = e.clientX;
    const startRatio = groupSplitRatioRef.current;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const next = Math.min(GROUP_SPLIT_RATIO_MAX, Math.max(GROUP_SPLIT_RATIO_MIN, startRatio + delta / totalWidth));
      setGroupSplitRatio(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('fn-resizing-group');
      saveGroupSplitRatio(groupSplitRatioRef.current);
    };
    document.body.classList.add('fn-resizing-group');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Restore each group's viewport when its active tab changes. Runs one frame later so the
  // freshly mounted content has laid out; fresh tabs (no saved position) reset to the top.
  const activeTabsKey = groups.map((g) => `${g.id}:${g.activeTabId ?? ''}`).join('|');
  useEffect(() => {
    restoringViewportRef.current = true;
    const raf = requestAnimationFrame(() => {
      for (const g of groupsRef.current) {
        if (!g.activeTabId) continue;
        const pane = paneElsByGroupRef.current[g.id];
        if (!pane) continue;
        const scroller =
          pane.querySelector<HTMLElement>('.fn-table-wrap') ??
          pane.querySelector<HTMLElement>('.fn-tab-group__scroll');
        if (!scroller) continue;
        const saved = viewportByTabRef.current[`${g.id}:${g.activeTabId}`];
        scroller.scrollTop = saved?.top ?? 0;
        scroller.scrollLeft = saved?.left ?? 0;
      }
      requestAnimationFrame(() => {
        restoringViewportRef.current = false;
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      restoringViewportRef.current = false;
    };
  }, [activeTabsKey]);

  const renderGroupPane = (group: TabGroupState, idx: number) => {
    const isFocused = group.id === activeGroupId;
    const content = contentForGroup(group);
    const mode = editorModeByGroup[group.id] ?? 'wysiwyg';
    const groupEditor = tiptapEditorByGroup[group.id] ?? null;
    const flexGrow = groups.length === 2 ? (idx === 0 ? groupSplitRatio : 1 - groupSplitRatio) : 1;
    return (
      <div
        key={group.id}
        ref={(el) => {
          paneElsByGroupRef.current[group.id] = el;
        }}
        className={`fn-tab-group${isFocused ? ' fn-tab-group--focused' : ''}`}
        style={{ flex: `${flexGrow} 1 0%` }}
        // Scroll doesn't bubble, so the capture phase is the only way to observe the inner
        // scrollers (note pane / table wrap) from here. Positions are keyed per group+tab and
        // restored when the tab becomes active again.
        onScrollCapture={(e) => {
          if (restoringViewportRef.current) return;
          const target = e.target;
          if (!(target instanceof HTMLElement)) return;
          const isScroller =
            target.classList.contains('fn-tab-group__scroll') || target.classList.contains('fn-table-wrap');
          if (!isScroller || !group.activeTabId) return;
          viewportByTabRef.current[`${group.id}:${group.activeTabId}`] = {
            top: target.scrollTop,
            left: target.scrollLeft,
          };
        }}
        onMouseDownCapture={(e) => {
          if (activeGroupId !== group.id) setActiveGroupId(group.id);
          // Placing the cursor inside the page content counts as a focus switch for the
          // focus-history trail. Tab-bar clicks are excluded here — selectTabInGroup records the
          // *target* tab itself (recording here would log the group's outgoing tab instead).
          if (content && !(e.target instanceof Element && e.target.closest('.fn-tabbar'))) {
            recordEditFocus(content.id);
          }
        }}
      >
        <TabBar
          tabs={group.tabs}
          activeTabId={group.activeTabId}
          notes={notes}
          canSplit
          onSelectTab={(tabId) => selectTabInGroup(group.id, tabId)}
          onPinTab={(tabId) => pinTabInGroup(group.id, tabId)}
          onCloseTab={(tabId) => closeTabInGroup(group.id, tabId)}
          onSplitTab={(tabId) => splitTabToOtherGroup(group.id, tabId)}
          onReorderTab={(dragId, targetId, position) => reorderTabInGroup(group.id, dragId, targetId, position)}
        />
        {content?.nodeType === 'table' ? (
          <>
            <div className="fn-tab-group__header">
              <div className="fn-note-header" style={{ maxWidth: noteWidth }}>
                {renderNoteResizeHandle()}
                <div className="fn-table-export">
              <button
                type="button"
                onClick={() =>
                  downloadTextFile(
                    `${content.title || 'table'}.csv`,
                    exportTableCsv(content.title, parseTableDocument(content.contentMd, locale), attachmentLookup),
                    'text/csv',
                  )
                }
              >
                {t('vaultApp.exportCsv')}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!keys) return;
                  const f = exportEncryptedTableFile(content.title, parseTableDocument(content.contentMd, locale), keys.notesKey);
                  downloadBinaryFile(`${content.title || 'table'}.fnxt`, buildFnxtBytes(f), 'application/octet-stream');
                }}
              >
                {t('vaultApp.exportFnxt')}
              </button>
              <label className="fn-import-btn">
                {t('vaultApp.importCsv')}
                <input
                  type="file"
                  accept=".csv,text/csv"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void importCsvFile(file, locale)
                      .then((doc) => updateNoteById(content.id, { contentMd: serializeTable(doc) }))
                      .catch((err) => alert(err instanceof Error ? err.message : t('vaultApp.csvImportFailed')));
                    e.target.value = '';
                  }}
                />
              </label>
              <label className="fn-import-btn">
                {t('vaultApp.importFnxt')}
                <input
                  type="file"
                  accept=".fnxt"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file || !keys) return;
                    void importFnxtFile(file, keys.notesKey, locale).then(({ doc }) => updateNoteById(content.id, { contentMd: serializeTable(doc) }));
                    e.target.value = '';
                  }}
                />
              </label>
              {isFocused && (
                <button type="button" onClick={() => setShowAttachmentsModal(true)}>
                  📎 {t('vaultApp.attachmentsBtn')}
                  {attachments.length > 0 ? ` (${attachments.length})` : ''}
                </button>
              )}
              {isFocused && (
                <button
                  type="button"
                  className={collabUi[content.id]?.state === 'connected' ? 'active' : ''}
                  onClick={() => setCollabModal(content.id)}
                  title={t('vaultApp.collabTitle')}
                >
                  👥 {t('vaultApp.collabBtn')}
                  {collabUi[content.id]?.state === 'connected' ? ` (${collabUi[content.id].peers})` : ''}
                </button>
              )}
                </div>
                {findBarGroupId === group.id && (
                  <FindReplaceBar
                    key={content.id}
                    getController={() => findReplaceByGroupRef.current[group.id] ?? null}
                    initialQuery={findInitialQuery ?? undefined}
                    focusNonce={findBarNonce}
                    onClose={() => {
                      setFindBarGroupId(null);
                      setFindInitialQuery(null);
                    }}
                  />
                )}
              </div>
            </div>
            {isFocused && showAttachmentsModal && (
              <div className="fn-modal-backdrop" onClick={() => setShowAttachmentsModal(false)}>
                <div className="fn-modal fn-attach-modal" onClick={(e) => e.stopPropagation()}>
                  <h2>{t('vaultApp.attachmentsBtn')}</h2>
                  {renderAttachmentsPanel(content.id, true)}
                  <div className="fn-modal__actions">
                    <button type="button" onClick={() => setShowAttachmentsModal(false)}>
                      {t('common.close')}
                    </button>
                  </div>
                </div>
              </div>
            )}
            <div className="fn-tab-group__scroll fn-tab-group__scroll--table">
              <div className="fn-note" style={{ maxWidth: noteWidth }}>
                {renderNoteResizeHandle()}
                <TableEditor
                  key={content.id}
                  document={parseTableDocument(content.contentMd, locale)}
                  onChange={(doc) => updateNoteById(content.id, { contentMd: serializeTable(doc) })}
                  attachments={isFocused ? attachments : []}
                  onRegisterInsert={
                    isFocused
                      ? (insert) => {
                          insertTableRef.current = insert;
                        }
                      : undefined
                  }
                  onAttachmentDownload={handleAttachmentDownload}
                  onAttachmentEdit={handleAttachmentEdit}
                  repeatActionShortcut={shortcuts.tableRepeatAction}
                  undoShortcut={shortcuts.tableUndo}
                  redoShortcut={shortcuts.tableRedo}
                  onRegisterFindReplace={(ctrl) => {
                    findReplaceByGroupRef.current[group.id] = ctrl;
                  }}
                  onRegisterSelectAll={(fn) => {
                    selectAllByGroupRef.current[group.id] = fn;
                  }}
                />
              </div>
            </div>
          </>
        ) : content?.nodeType === 'note' ? (
          <>
            <div className="fn-tab-group__header">
              <div className="fn-note-header" style={{ maxWidth: noteWidth }}>
                {renderNoteResizeHandle()}
                <div className="fn-tab-group__controls">
                  <button type="button" className={mode === 'wysiwyg' ? 'active' : ''} onClick={() => handleEditorModeForGroup(group.id, 'wysiwyg')}>
                    {t('vaultApp.modeWysiwyg')}
                  </button>
                  <button type="button" className={mode === 'source' ? 'active' : ''} onClick={() => handleEditorModeForGroup(group.id, 'source')}>
                    {t('vaultApp.modeSource')}
                  </button>
                  <button
                    type="button"
                    className={showLineNumbers ? 'active' : ''}
                    onClick={toggleLineNumbers}
                    title={t('vaultApp.toggleLineNumbers')}
                  >
                    #
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const plain = expandAttachmentRefsForExport(content.contentMd, attachmentLookup);
                      downloadTextFile(`${content.title || t('common.untitled')}.md`, plain, 'text/markdown');
                    }}
                    title={t('vaultApp.exportNoteMd')}
                  >
                    ⇩
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const format = formatJsonByGroupRef.current[group.id];
                      if (!format || !format()) alert(t('vaultApp.jsonFormatFailed'));
                    }}
                    title={t('vaultApp.formatJsonTitle')}
                  >
                    {'{ }'}
                  </button>
                  {isFocused && (
                    <button type="button" onClick={() => setShowAttachmentsModal(true)}>
                      📎 {t('vaultApp.attachmentsBtn')}
                      {attachments.length > 0 ? ` (${attachments.length})` : ''}
                    </button>
                  )}
                  {isFocused && (
                    <button
                      type="button"
                      className={collabUi[content.id]?.state === 'connected' ? 'active' : ''}
                      onClick={() => setCollabModal(content.id)}
                      title={t('vaultApp.collabTitle')}
                    >
                      👥 {t('vaultApp.collabBtn')}
                      {collabUi[content.id]?.state === 'connected' ? ` (${collabUi[content.id].peers})` : ''}
                    </button>
                  )}
                  {(selCharsByGroup[group.id] ?? 0) > 0 && (
                    <span className="fn-selchars">
                      {t('vaultApp.selectedChars', { count: String(selCharsByGroup[group.id]) })}
                    </span>
                  )}
                </div>
                <EditorToolbar editor={groupEditor} mode={mode} enableMath={enableMath} />
                {findBarGroupId === group.id && (
                  <FindReplaceBar
                    key={`${content.id}-${mode}`}
                    getController={() => findReplaceByGroupRef.current[group.id] ?? null}
                    initialQuery={findInitialQuery ?? undefined}
                    focusNonce={findBarNonce}
                    onClose={() => {
                      setFindBarGroupId(null);
                      setFindInitialQuery(null);
                    }}
                  />
                )}
                {formulaEdit && formulaEdit.groupId === group.id && (
                  <InlineInputBar
                    label={t('noteEditor.editFormulaPrompt')}
                    initial={formulaEdit.latex}
                    onConfirm={(value) => {
                      if (value.trim()) formulaEdit.apply(value.trim());
                      setFormulaEdit(null);
                    }}
                    onCancel={() => setFormulaEdit(null)}
                  />
                )}
              </div>
            </div>
            {isFocused && showAttachmentsModal && (
              <div className="fn-modal-backdrop" onClick={() => setShowAttachmentsModal(false)}>
                <div className="fn-modal fn-attach-modal" onClick={(e) => e.stopPropagation()}>
                  <h2>{t('vaultApp.attachmentsBtn')}</h2>
                  {renderAttachmentsPanel(content.id, true)}
                  <div className="fn-modal__actions">
                    <button type="button" onClick={() => setShowAttachmentsModal(false)}>
                      {t('common.close')}
                    </button>
                  </div>
                </div>
              </div>
            )}
            <div className="fn-tab-group__scroll">
              <div className="fn-note" style={{ maxWidth: noteWidth }}>
                {renderNoteResizeHandle()}
                <NoteEditor
                  key={content.id}
                  noteId={content.id}
                  mode={mode}
                  content={content.contentMd}
                  onChange={(md) => updateNoteById(content.id, { contentMd: md })}
                  onEditorReady={(editor) => setTiptapEditorByGroup((prev) => ({ ...prev, [group.id]: editor }))}
                  onRegisterInsert={
                    isFocused
                      ? (insert) => {
                          insertDocRef.current = insert;
                        }
                      : undefined
                  }
                  onRegisterFormatJson={(format) => {
                    formatJsonByGroupRef.current[group.id] = format;
                  }}
                  onSelectionChars={(count) =>
                    setSelCharsByGroup((prev) => (prev[group.id] === count ? prev : { ...prev, [group.id]: count }))
                  }
                  onEditFormula={(latex, apply) => setFormulaEdit({ groupId: group.id, latex, apply })}
                  onRegisterFindReplace={(ctrl) => {
                    findReplaceByGroupRef.current[group.id] = ctrl;
                  }}
                  onRegisterSelectAll={(fn) => {
                    selectAllByGroupRef.current[group.id] = fn;
                  }}
                  attachments={isFocused ? attachments : []}
                  onAttachmentDownload={handleAttachmentDownload}
                  onAttachmentEdit={handleAttachmentEdit}
                  showLineNumbers={showLineNumbers}
                  enableMath={enableMath}
                  externalContentNonce={collabContentNonce[content.id] ?? 0}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="fn-tab-group__scroll">
            <div className="fn-empty fn-empty--inline">{t('vaultApp.emptySelectOrCreate')}</div>
          </div>
        )}
      </div>
    );
  };

  if (isFirstRun === null) return <div className="fn-loading">{t('vaultApp.loading')}</div>;
  if (!keys) {
    return (
      <I18nProvider locale={locale}>
        <UnlockScreen
          vaults={vaultListItems}
          activeVaultId={activeVaultId}
          isFirstRun={isFirstRun}
          defaultServerUrl={serverUrl}
          defaultUsername={activeVault?.boundUsername ?? session?.username ?? ''}
          onSelectVault={selectVaultById}
          onCreateVaultEntry={createVaultEntry}
          onCreateVault={handleCreateVault}
          onUnlockLocal={handleUnlockLocal}
          onCloudSync={handleCloudSync}
          progress={unlockProgress}
          initialTab={unlockInitialTab}
        />
      </I18nProvider>
    );
  }

  return (
    <I18nProvider locale={locale}>
      {isLocking && (
        <div className="fn-locking-overlay">
          <div className="fn-locking-overlay__spinner" />
          <span>{t('vaultApp.locking')}</span>
        </div>
      )}
      <input
        ref={importFolderInputRef}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: 'true', directory: 'true' } as Record<string, string>)}
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 0) {
            void handleImportFolder(files, importTargetParentRef.current, importFolderForceRef.current);
          }
          e.target.value = '';
        }}
      />
      <input
        ref={importNoteFileInputRef}
        type="file"
        multiple
        hidden
        accept=".txt,text/plain"
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 0) {
            void handleImportFiles(files, importTargetParentRef.current, 'note');
          }
          e.target.value = '';
        }}
      />
      <input
        ref={importTableFileInputRef}
        type="file"
        multiple
        hidden
        accept=".csv,text/csv"
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 0) {
            void handleImportFiles(files, importTargetParentRef.current, 'table');
          }
          e.target.value = '';
        }}
      />
      {sessionExpired && (
        <div className="fn-session-expired-banner" role="alert">
          <span>{t('vaultApp.sessionExpiredBanner')}</span>
          <button type="button" onClick={() => { setSessionExpired(false); setShowAuth(true); }}>
            {t('vaultApp.sessionExpiredLogin')}
          </button>
          <button
            type="button"
            className="fn-session-expired-banner__dismiss"
            title={t('vaultApp.sessionExpiredDismiss')}
            onClick={() => setSessionExpired(false)}
          >
            ×
          </button>
        </div>
      )}
      <AppShell
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={handleSidebarToggleClick}
        sidebarWidth={sidebarWidth}
        onSidebarResizeStart={handleSidebarResizeStart}
        toolbar={
          <div className="fn-toolbar">
            <button type="button" className={appView === 'notes' ? 'active' : ''} onClick={() => setAppView('notes')}>
              {t('vaultApp.navNotes')}
            </button>
            <button
              type="button"
              className={`fn-toolbar__tab${appView === 'chat' ? ' active' : ''}`}
              onClick={() => setAppView('chat')}
            >
              {t('vaultApp.navChat')}
              {chatNotify.bubble && totalUnread > 0 ? (
                <span className="fn-unread-badge">{totalUnread > 99 ? '99+' : totalUnread}</span>
              ) : null}
            </button>
            {appView === 'notes' && (
              <>
                <DropdownMenu label={`+ ${t('vaultApp.newMenu')}`}>
                  <button type="button" onClick={() => handleCreate('note', focusedTreeParentId())}>{t('vaultApp.newNote')}</button>
                  <button type="button" onClick={() => handleCreate('table', focusedTreeParentId())}>{t('vaultApp.newTable')}</button>
                  <button type="button" onClick={() => handleCreate('folder', focusedTreeParentId())}>{t('vaultApp.newFolder')}</button>
                </DropdownMenu>
                <DropdownMenu label={`⇪ ${t('vaultApp.importMenu')}`}>
                  <button type="button" title={t('vaultApp.importNoteFileTitle')} onClick={() => openImportNoteFile(focusedTreeParentId())}>{t('vaultApp.importNoteFile')}</button>
                  <button type="button" title={t('vaultApp.importNoteFileForceTitle')} onClick={() => openImportNoteFile(focusedTreeParentId(), true)}>{t('vaultApp.importNoteFileForce')}</button>
                  <button type="button" title={t('vaultApp.importTableFileTitle')} onClick={() => openImportTableFile(focusedTreeParentId())}>{t('vaultApp.importTableFile')}</button>
                  <button type="button" title={t('vaultApp.importFolderTitle')} onClick={() => openImportFolder(focusedTreeParentId())}>{t('vaultApp.importFolder')}</button>
                  <button type="button" title={t('vaultApp.importFolderForceTitle')} onClick={() => openImportFolder(focusedTreeParentId(), true)}>{t('vaultApp.importFolderForce')}</button>
                </DropdownMenu>
                <input className="fn-search" placeholder={t('vaultApp.searchPlaceholder')} value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setExpandedSearch(!!e.target.value); }} />
                <button
                  type="button"
                  className={activeAiSessionId ? 'active' : ''}
                  onClick={handleAiQuickSwitch}
                  title={activeAiSessionId ? t('vaultApp.aiSwitchToNotes') : t('vaultApp.aiSwitchToAi')}
                >
                  {activeAiSessionId ? '📝' : '🤖'}
                </button>
              </>
            )}
            <button type="button" onClick={() => setShowLogs(true)} title={t('logsModal.title')}>📋</button>
            <button type="button" onClick={() => setShowSettings(true)} title={t('vaultApp.settingsTitle')}>⚙</button>
            <button type="button" onClick={handleLock} title={t('vaultApp.lockTitle')}>🔒</button>
          </div>
        }
        sidebar={
          appView === 'chat' ? (
            <ChatSidebar
              sessions={chatSessions}
              activePeerId={activePeerId}
              sessionLoggedIn={!!session}
              imConnected={imConnected}
              selfPeerId={session?.userId ?? null}
              unreadByPeer={chatNotify.bubble ? unreadByPeer : {}}
              onSelectPeer={(id, name) => {
                setActivePeerId(id);
                setActivePeerName(name);
                clearPeerUnread(id);
              }}
              onStartChat={handleStartChat}
            />
          ) : expandedSearch && searchQuery ? (
            <ul className="fn-tree fn-tree--search">
              {searchResults.length === 0 ? (
                <li className="fn-tree-empty">{t('vaultApp.noResults')}</li>
              ) : (
                searchResults.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="fn-search-result"
                      onClick={() => {
                        const q = searchQuery;
                        openNote(r.id);
                        setExpandedSearch(false);
                        setSearchQuery('');
                        revealNoteInTree(r.id);
                        locateNoteInSource(r.id, q);
                      }}
                    >
                      <span className="fn-search-result__title">{r.title || t('common.untitled')}</span>
                      {r.snippet && <span className="fn-search-result__snippet">{r.snippet}</span>}
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : (
            // Flex column: the AI panel is a fixed (non-scrolling) block at the top with its own
            // internal scrolling when expanded; the note tree scrolls independently below it.
            <div className="fn-notes-sidebar">
              <div className="fn-ai-panel">
                <button type="button" className="fn-ai-panel__header" onClick={handleAiPanelToggle}>
                  <span className="fn-ai-panel__chevron">{aiPanelOpen ? '▾' : '▸'}</span>
                  {t('aiPanel.title')}
                </button>
                {aiPanelOpen && (
                  <AiSessionTree
                    sessions={aiSessions}
                    activeId={activeAiSessionId}
                    onSelect={(id) => setActiveAiSessionId(id)}
                    onCreate={handleAiCreate}
                    onRename={handleAiRename}
                    onDelete={handleAiDelete}
                    onRestore={handleAiRestore}
                    onDeleteForever={handleAiDeleteForever}
                    onEmptyTrash={handleAiEmptyTrash}
                    onMove={handleAiMove}
                  />
                )}
              </div>
              <div className="fn-notes-sidebar__tree">
                <TreeToolbar
                  sortMode={treeSortMode}
                  onSortMode={handleTreeSortMode}
                  onExpandAll={handleExpandAll}
                  onCollapseAll={handleCollapseAll}
                />
                <NoteTree
                  notes={notes}
                  activeId={activeId}
                  selectedIds={treeSelectedIds}
                  collapsedIds={collapsedFolderIds}
                  onToggleCollapse={handleToggleFolderCollapse}
                  revealId={revealId}
                  onSelect={handleTreeSelect}
                  onOpenPinned={(id) => openNote(id, { pin: true })}
                  onCreateFolder={(pid) => void handleCreate('folder', pid)}
                  onCreateNote={(pid) => void handleCreate('note', pid)}
                  onCreateTable={(pid) => void handleCreate('table', pid)}
                  onImportFolder={(pid) => openImportFolder(pid)}
                  onRename={(id, title) => updateNoteById(id, { title })}
                  onDelete={(id) => void handleTrashMany([id])}
                  onRestore={(id) => void handleRestoreFromTrash(id)}
                  onDeleteForever={(id) => void handleDeleteMany([id])}
                  onEmptyTrash={() => void handleEmptyTrash()}
                  onMove={(dragId, targetId, position) => void handleMove(dragId, targetId, position)}
                  onTransfer={handleTransferRequest}
                  renameRequestId={renameRequestId}
                  onRenameRequestHandled={() => setRenameRequestId(null)}
                  showSyncStatus={!!session}
                  collabIds={collabActiveIds}
                />
              </div>
            </div>
          )
        }
        main={
          appView === 'chat' ? (
            <ChatPanel
              messages={chatMessages}
              activePeerId={activePeerId}
              activePeerName={activePeerName}
              onSend={handleSendChat}
              onDeleteMessage={handleDeleteChatMessage}
              onDownloadAttachment={handleChatAttachmentDownload}
              onEditAttachment={handleChatAttachmentEdit}
              onRemoveAttachment={handleChatAttachmentRemove}
              onLoadAttachmentPreview={handleChatAttachmentPreview}
              onSyncHistory={handleChatHistorySync}
            />
          ) : activeAiSession ? (
            <AiWorkbench
              session={activeAiSession}
              configured={!!aiSettings?.apiKey}
              streamingText={aiRun && aiRun.sessionId === activeAiSession.id ? aiRun.text : null}
              streamingThinkingChars={
                aiRun && aiRun.sessionId === activeAiSession.id ? (aiRun.thinkingChars ?? 0) : 0
              }
              streamingStartedAt={
                aiRun && aiRun.sessionId === activeAiSession.id ? aiRun.startedAt : null
              }
              streamingWebSearches={
                aiRun && aiRun.sessionId === activeAiSession.id ? (aiRun.webSearches ?? 0) : 0
              }
              busy={aiRun !== null}
              error={aiRunError && aiRunError.sessionId === activeAiSession.id ? aiRunError.message : null}
              onSend={(text, attachments) => void runAiRequest(activeAiSession.id, text, attachments)}
              onStop={handleAiStop}
              onDeleteMessage={(index) => handleAiDeleteMessage(activeAiSession.id, index)}
              prepareAttachment={handlePrepareAiAttachment}
              onConvertToNote={(messages) => void handleAiConvertToNote(activeAiSession.id, messages)}
              onOpenSettings={() => setShowSettings(true)}
              findRequest={aiFindRequest}
            />
          ) : (
            <>
              {groups.flatMap((group, idx) => [
                ...(idx > 0
                  ? [
                      <div
                        key={`divider-${group.id}`}
                        className="fn-tab-group-divider"
                        onMouseDown={handleGroupDividerResizeStart}
                      />,
                    ]
                  : []),
                renderGroupPane(group, idx),
              ])}
            </>
          )
        }
      />
      {showSettings && (
        <SettingsModal
          serverUrl={serverUrl}
          sessionUsername={session?.username ?? null}
          vaultLabel={activeVaultLabel}
          syncStatus={syncStatus}
          dataDirectory={dataDirectory}
          realStoragePath={realStoragePath}
          onOpenStorageFolder={
            window.fastnote?.openUserDataFolder
              ? () => void window.fastnote?.openUserDataFolder?.()
              : undefined
          }
          isElectron={!!window.fastnote?.isElectron}
          chatNotify={chatNotify}
          proxySettings={proxySettings}
          onProxySettingsChange={handleProxySettingsChange}
          uiTheme={uiTheme}
          locale={locale}
          shortcuts={shortcuts}
          onShortcutsChange={handleShortcutsChange}
          enableMath={enableMath}
          onEnableMathChange={handleEnableMathChange}
          aiSettings={aiSettings}
          aiModels={CLAUDE_MODELS}
          onAiSettingsSave={(settings) => void handleAiSettingsSave(settings)}
          onLocaleChange={handleLocaleChange}
          onClose={() => setShowSettings(false)}
          onSaveServer={commitServerUrl}
          onSaveVaultLabel={handleSaveVaultLabel}
          onSaveDataDirectory={handleSaveDataDirectory}
          onPickDataDirectory={handlePickDataDirectory}
          onChatNotifyChange={(settings) => {
            setChatNotify(settings);
            saveChatNotificationSettings(settings);
          }}
          onUiThemeChange={(theme) => {
            setUiTheme(theme);
            saveUiTheme(theme);
          }}
          onOpenAuth={() => { setShowSettings(false); setShowAuth(true); }}
          onLogout={() => {
            saveSession(null, loadStorageNamespace());
            setSession(null);
            setSessionExpired(false);
            imRef.current?.disconnect();
          }}
          onSync={() => void handleSync()}
          onAbout={() => { setShowSettings(false); setShowAbout(true); }}
          onRebuildSearchIndex={handleRebuildSearchIndex}
        />
      )}
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onRegister={handleRegister} onLogin={handleLogin} />}
      {transferIds && (
        <VaultTransferModal
          vaults={vaultRegistry
            .filter((v) => v.id !== activeVaultId)
            .map((v) => ({ id: v.id, namespace: v.namespace, label: v.label }))}
          itemCount={transferIds.length}
          busy={transferBusy}
          error={transferError}
          progress={transferProgress}
          onSubmit={(ns, password, mode) => void handleTransferToVault(ns, password, mode)}
          onClose={() => setTransferIds(null)}
        />
      )}
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} version={__APP_VERSION__} />}
      {collabModal &&
        (() => {
          const note = notes.find((n) => n.id === collabModal);
          if (!note) return null;
          const ui = collabUi[collabModal];
          const active = collabSessionsRef.current.has(collabModal);
          return (
            <div className="fn-modal-backdrop" onClick={() => setCollabModal(null)}>
              <div className="fn-modal fn-collab-modal" onClick={(e) => e.stopPropagation()}>
                <h2>
                  {t('vaultApp.collabTitle')} — {note.title || t('common.untitled')}
                </h2>
                {active ? (
                  <>
                    <p className="fn-collab-modal__status">
                      <span className={`fn-collab-dot fn-collab-dot--${ui?.state ?? 'connecting'}`} />
                      {ui?.state === 'connected'
                        ? t('vaultApp.collabConnected', { count: String(ui.peers) })
                        : ui?.state === 'connecting'
                          ? t('vaultApp.collabConnecting')
                          : t('vaultApp.collabDisconnected')}
                    </p>
                    {collabRoomCodes[collabModal] && (
                      <p className="fn-collab-modal__room">
                        {t('vaultApp.collabActiveRoom')}
                        <code>{collabRoomCodes[collabModal]}</code>
                      </p>
                    )}
                    <p className="fn-collab-modal__hint">{t('vaultApp.collabActiveHint')}</p>
                    <div className="fn-modal__actions">
                      <button type="button" onClick={() => handleCollabLeave(collabModal)}>
                        {t('vaultApp.collabLeave')}
                      </button>
                      <button type="button" onClick={() => setCollabModal(null)}>
                        {t('common.close')}
                      </button>
                    </div>
                  </>
                ) : (
                  <CollabJoinForm
                    t={t}
                    loggedIn={!!session}
                    onJoin={(roomCode, password) => handleCollabJoin(collabModal, roomCode, password)}
                    onClose={() => setCollabModal(null)}
                  />
                )}
              </div>
            </div>
          );
        })()}
      {showLogs && (
        <LogsModal
          entries={getCapturedLogs()}
          formatted={formatCapturedLogs()}
          onClose={() => setShowLogs(false)}
          onClear={() => {
            clearCapturedLogs();
            setLogsTick((n) => n + 1);
          }}
        />
      )}
    </I18nProvider>
  );
}

interface CollabJoinFormProps {
  t: TFunction;
  loggedIn: boolean;
  onJoin: (roomCode: string, password: string) => Promise<void>;
  onClose: () => void;
}

/**
 * Join step of the collaboration modal: enter the out-of-band negotiated room code + password.
 * The initiator generates a fresh random room code (🎲) — without it, two unrelated documents
 * that happened to pick the same password would collide in the same relay room. Kept as a
 * separate component so the credentials live in local state and are dropped as soon as the form
 * unmounts (the session only keeps the derived room key).
 */
function CollabJoinForm({ t, loggedIn, onJoin, onClose }: CollabJoinFormProps) {
  const [roomCode, setRoomCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    if (normalizeCollabRoomCode(roomCode).length < 4) {
      setError(t('vaultApp.collabRoomMissing'));
      return;
    }
    if (password.length < 6) {
      setError(t('vaultApp.collabPasswordTooShort'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onJoin(roomCode, password);
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && loggedIn && !busy && roomCode && password) void join();
  };

  return (
    <>
      <p className="fn-collab-modal__hint">{t('vaultApp.collabHint')}</p>
      {!loggedIn && <p className="fn-collab-modal__error">{t('vaultApp.collabLoginRequired')}</p>}
      <div className="fn-collab-modal__room-row">
        <input
          type="text"
          className="fn-collab-modal__password"
          value={roomCode}
          placeholder={t('vaultApp.collabRoomPlaceholder')}
          onChange={(e) => setRoomCode(e.target.value)}
          onKeyDown={submitOnEnter}
          autoFocus
        />
        <button
          type="button"
          onClick={() => setRoomCode(generateCollabRoomCode())}
          title={t('vaultApp.collabGenerateRoom')}
        >
          🎲 {t('vaultApp.collabGenerateRoom')}
        </button>
      </div>
      <input
        type="password"
        className="fn-collab-modal__password"
        value={password}
        placeholder={t('vaultApp.collabPasswordPlaceholder')}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={submitOnEnter}
      />
      {error && <p className="fn-collab-modal__error">{error}</p>}
      <div className="fn-modal__actions">
        <button type="button" disabled={!loggedIn || busy || !roomCode || !password} onClick={() => void join()}>
          {busy ? t('vaultApp.collabJoining') : t('vaultApp.collabJoin')}
        </button>
        <button type="button" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </>
  );
}
