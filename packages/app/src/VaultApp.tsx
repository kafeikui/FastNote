import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Editor } from '@tiptap/core';
import {
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
  loadNoteWidth,
  saveNoteWidth,
  NOTE_WIDTH_MIN,
  NOTE_WIDTH_MAX,
  NOTE_WIDTH_DEFAULT,
  loadSidebarCollapsed,
  saveSidebarCollapsed,
  loadStorageNamespace,
  saveStorageNamespace,
  loadStoragePathLabel,
  saveStoragePathLabel,
  namespaceFromPath,
  ensureLegacyVaultInRegistry,
  loadVaultRegistry,
  saveVaultRegistry,
  createVaultRegistryEntry,
} from '@fastnote/api';
import {
  deriveKeysFromPassword,
  encryptString,
  decryptString,
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
import { IMClient, verifyExchangeKeypair } from '@fastnote/im';
import { NoteSearchIndex } from '@fastnote/search';
import type { ChatMessage, EditorMode, NodeType, NoteAttachment, NoteNode, UserSession, TreeDropPosition, ChatAttachmentRef, ChatWireAttachment } from '@fastnote/shared';
import { META_KEYS, downloadBlob, isEditableContentNode, computeTreeMove, buildAttachmentMarkdownRef, decodeChatWire, toStoredPayload, storedToChatMessage, serverUrlNeedsReload } from '@fastnote/shared';
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
  EditorToolbar,
  SettingsModal,
  AuthModal,
  ChatPanel,
  ChatSidebar,
  buildChatSessions,
  playChatNotificationSound,
  AboutModal,
  NoteAttachments,
  type VaultListItem,
} from '@fastnote/ui';

type VaultKeys = Awaited<ReturnType<typeof deriveKeysFromPassword>>;
type AppView = 'notes' | 'chat';

const SAVE_DEBOUNCE_MS = 500;

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

export function VaultApp() {
  const [storageEpoch, setStorageEpoch] = useState(0);
  const storage = useMemo(
    () => createStorage({ namespace: loadStorageNamespace() }),
    [storageEpoch],
  );
  const [dataDirectory, setDataDirectory] = useState('');
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null);
  const [keys, setKeys] = useState<VaultKeys | null>(null);
  const [notes, setNotes] = useState<NoteNode[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [appView, setAppView] = useState<AppView>('notes');
  const [editorMode, setEditorMode] = useState<EditorMode>('wysiwyg');
  const [searchQuery, setSearchQuery] = useState('');
  const [tiptapEditor, setTiptapEditor] = useState<Editor | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [session, setSession] = useState<UserSession | null>(() => loadSession(loadStorageNamespace()));
  const [serverUrl, setServerUrl] = useState(() => loadServerUrl());
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

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', uiTheme);
  }, [uiTheme]);

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
  const importTargetParentRef = useRef<string | null>(null);
  const noteWidthRef = useRef(noteWidth);
  noteWidthRef.current = noteWidth;
  keysRef.current = keys;
  appViewRef.current = appView;
  activePeerRef.current = activePeerId;
  chatNotifyRef.current = chatNotify;

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

  const processIncomingChat = useCallback(
    async (peerId: string, plaintext: string, msgId: string, sentAt: string) => {
      const k = keysRef.current;
      if (!k) return;
      const existing = await storage.listChatMessagesDecrypted(k.notesKey);
      if (existing.some((m) => m.id === msgId)) return;

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
        'in',
        sentAt,
        toStoredPayload({ ...wire, peerUsername: session?.peerUsername }, refs),
      );
      await persistChatMessage(msg);

      const viewingThread =
        appViewRef.current === 'chat' && activePeerRef.current === peerId;
      if (!viewingThread) {
        bumpUnread(peerId);
        if (chatNotifyRef.current.sound) {
          playChatNotificationSound(chatNotifyRef.current.soundId, chatNotifyRef.current.volume);
        }
      }

      const imSession = imRef.current?.getSession(peerId);
      if (imSession && appViewRef.current === 'chat') {
        if (!activePeerRef.current || activePeerRef.current === peerId) {
          setActivePeerId(peerId);
          setActivePeerName(imSession.peerUsername);
          clearPeerUnread(peerId);
        }
      }
    },
    [persistChatMessage, storage, bumpUnread, clearPeerUnread],
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

  const loadSearchSnapshot = useCallback(
    async (indexKey: Uint8Array) => {
      const raw = await storage.getMeta(META_KEYS.searchIndexSnapshot);
      if (!raw) return;
      try {
        const plain = decryptString(indexKey, unpackEncrypted(raw));
        searchIndexRef.current = NoteSearchIndex.fromSerialized(plain);
      } catch {
        /* rebuild */
      }
    },
    [storage],
  );

  const saveSearchSnapshot = useCallback(
    async (indexKey: Uint8Array) => {
      const json = searchIndexRef.current.serialize();
      const enc = encryptString(indexKey, json);
      await storage.setMeta(META_KEYS.searchIndexSnapshot, packEncrypted(enc));
    },
    [storage],
  );

  const upsertSearch = (note: NoteNode) => {
    searchIndexRef.current.upsert({
      ...note,
      contentMd: noteSearchBody(note),
    });
    setSearchTick((n) => n + 1);
  };

  const rebuildSearchIndex = useCallback((items: NoteNode[]) => {
    searchIndexRef.current.rebuild(
      items.map((n) => ({ ...n, contentMd: noteSearchBody(n) })),
    );
    setSearchTick((n) => n + 1);
  }, []);

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

      const pullPending = async () => {
        await client.pullPendingMessages(serverUrl, userSession.token);
        persistSessions();
      };

      client.setPendingFetcher(() => pullPending());
      client.connect();
      void pullPending().catch((err) => console.error('fetchPending failed', err));
    },
    [serverUrl, processIncomingChat, storage, t],
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
      const peer = peerName
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

  const loadNotes = useCallback(
    async (derived: VaultKeys) => {
      await loadSearchSnapshot(derived.indexKey);
      const stubs = await storage.listNotes();
      const decrypted: NoteNode[] = [];
      for (const stub of stubs) {
        const full = await storage.loadNoteDecrypted(stub.id, derived.notesKey);
        if (full) decrypted.push(full);
      }
      setNotes(decrypted);
      rebuildSearchIndex(decrypted);
      setActiveId((prev) => {
        if (prev && decrypted.some((n) => n.id === prev)) return prev;
        return decrypted.find((n) => isEditableContentNode(n))?.id ?? null;
      });
      const priv = await loadExchangePrivate(derived.masterKey);
      if (priv) void priv;
      if (session) {
        const saltB64 = await storage.getMeta(META_KEYS.salt);
        if (saltB64) {
          try {
            await new ApiClient(serverUrl, locale).uploadVaultSalt(session.token, saltB64);
          } catch {
            /* backfill vault_salt for older accounts */
          }
        }
        await loadChatHistory(derived);
        try {
          await initIM(derived, session);
        } catch (err) {
          console.error('IM init failed', err);
        }
      } else {
        await loadChatHistory(derived);
      }
    },
    [storage, loadSearchSnapshot, session, initIM, rebuildSearchIndex, serverUrl, loadChatHistory],
  );

  const handleCreateVault = async (password: string) => {
    const salt = generateSalt();
    const saltB64 = toBase64(salt);
    await storage.setMeta(META_KEYS.salt, saltB64);
    const derived = await deriveKeysFromPassword(password, salt);
    await storage.setMeta(META_KEYS.passwordVerifier, toBase64(derived.passwordVerifier));
    await setupIdentityKeys(derived);
    keysRef.current = derived;
    setKeys(derived);
    setIsFirstRun(false);
    setVaultListItems((prev) =>
      prev.map((v) => (v.id === activeVaultId ? { ...v, initialized: true } : v)),
    );
    await loadNotes(derived);
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
    setKeys(derived);
    await loadNotes(derived);
  };

  const handleLock = async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (keys) await saveSearchSnapshot(keys.indexKey);
    imRef.current?.disconnect();
    imRef.current = null;
    setKeys(null);
    setNotes([]);
    setChatMessages([]);
    setActiveId(null);
    setActivePeerId(null);
    setActivePeerName(null);
    setTiptapEditor(null);
    setExpandedSearch(false);
  };

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
      setNotes((prev) => {
        const current = prev.find((n) => n.id === id);
        if (!current) return prev;
        const updated = buildUpdated(current, patch);
        schedulePersist(updated);
        return prev.map((n) => (n.id === updated.id ? updated : n));
      });
    },
    [keys, schedulePersist],
  );

  const handleCreate = async (nodeType: NodeType, parentId: string | null) => {
    if (!keys) return;
    const sortOrder = notes.filter((n) => n.parentId === parentId && !n.deleted).length;
    const node = newNode(nodeType, parentId, sortOrder, locale);
    await saveNoteNow(node);
    if (isEditableContentNode(node)) {
      setActiveId(node.id);
      setAppView('notes');
    }
  };

  const handleImportFolder = async (fileList: FileList, targetParentId: string | null) => {
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

      if (!hasExt) {
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

  const openImportFolder = (parentId: string | null) => {
    importTargetParentRef.current = parentId;
    importFolderInputRef.current?.click();
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
    for (const n of next) {
      const prev = notes.find((x) => x.id === n.id);
      if (!prev || prev.parentId !== n.parentId || prev.sortOrder !== n.sortOrder) {
        await persistNote(n);
      }
    }
  };

  const handleDelete = async (id: string) => {
    if (!keys) return;
    const target = notes.find((n) => n.id === id);
    if (!target) return;
    await storage.deleteAttachmentsByNote(id, keys.notesKey);
    const updated = buildUpdated({ ...target, deleted: true }, { deleted: true });
    await storage.saveNote(updated, keys.notesKey);
    upsertSearch(updated);
    setNotes((prev) => prev.filter((n) => n.id !== id && n.parentId !== id));
    if (activeId === id) setActiveId(null);
    void syncAttachmentsIfOnline();
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
    } catch {
      /* server offline */
    }
  }, [keys, session, serverUrl, storage, activeId, notes, refreshAttachments]);

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
    rebuildSearchIndex(result.notes);
    await saveSearchSnapshot(derived.indexKey);
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
    setVaultListItems((prev) =>
      prev.map((v) =>
        v.id === activeVaultId ? { ...v, boundUsername: username.trim() } : v,
      ),
    );
    await ensureVaultSaltOnServer(s);
    await uploadKeysIfNeeded(s, derived);
    await initIM(derived, s);
    void syncAttachmentsIfOnline();
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
      rebuildSearchIndex(result.notes);
      await saveSearchSnapshot(keys.indexKey);
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

  const handleEditorMode = (next: EditorMode) => {
    if (editorMode === 'wysiwyg' && next === 'source' && activeId) {
      const note = notes.find((n) => n.id === activeId && n.nodeType === 'note');
      if (note) {
        const md = flushEditorMarkdown(tiptapEditor);
        if (md !== null) {
          updateNoteById(note.id, { contentMd: md });
        }
      }
    }
    setEditorMode(next);
  };

  const activeContent =
    notes.find((n) => n.id === activeId && isEditableContentNode(n)) ?? null;
  const searchResults = useMemo(
    () => (searchQuery ? searchIndexRef.current.search(searchQuery) : []),
    [searchQuery, searchTick],
  );

  const handleSaveDataDirectory = async (dir: string) => {
    if (!dir) return;
    let saved = dir;
    if (window.fastnote?.setDataDirectory) {
      saved = await window.fastnote.setDataDirectory(dir);
    }
    const namespace = namespaceFromPath(saved);
    saveStorageNamespace(namespace);
    saveStoragePathLabel(saved);
    setDataDirectory(saved);
    let reg = loadVaultRegistry();
    if (!reg.some((v) => v.namespace === namespace)) {
      const entry = createVaultRegistryEntry(saved.split(/[/\\]/).pop() || t('vaultApp.defaultDesktopVaultLabel'));
      entry.namespace = namespace;
      reg = [...reg, entry];
      saveVaultRegistry(reg);
      setVaultRegistry(reg);
      setActiveVaultId(entry.id);
    } else {
      setActiveVaultId(reg.find((v) => v.namespace === namespace)!.id);
    }
    setStorageEpoch((n) => n + 1);
    setKeys(null);
    setNotes([]);
    setActiveId(null);
    setAttachments([]);
    setSession(loadSession(namespace));
    alert(t('vaultApp.dataDirUpdated'));
  };

  const handlePickDataDirectory = async (): Promise<string | null> => {
    return window.fastnote?.pickStorageDirectory?.() ?? null;
  };

  const activeVault = vaultListItems.find((v) => v.id === activeVaultId);
  const activeVaultLabel =
    vaultRegistry.find((v) => v.id === activeVaultId)?.label ?? activeVault?.label ?? t('vaultApp.defaultVaultLabel');

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
        />
      </I18nProvider>
    );
  }

  return (
    <I18nProvider locale={locale}>
      <input
        ref={importFolderInputRef}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: 'true', directory: 'true' } as Record<string, string>)}
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 0) {
            void handleImportFolder(files, importTargetParentRef.current);
          }
          e.target.value = '';
        }}
      />
      <AppShell
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
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
                <button type="button" onClick={() => handleCreate('note', null)}>{t('vaultApp.newNote')}</button>
                <button type="button" onClick={() => handleCreate('table', null)}>{t('vaultApp.newTable')}</button>
                <button type="button" onClick={() => handleCreate('folder', null)}>{t('vaultApp.newFolder')}</button>
                <button type="button" title={t('vaultApp.importFolderTitle')} onClick={() => openImportFolder(null)}>{t('vaultApp.importFolder')}</button>
                {activeContent?.nodeType === 'note' && (
                  <>
                    <button type="button" className={editorMode === 'wysiwyg' ? 'active' : ''} onClick={() => handleEditorMode('wysiwyg')}>{t('vaultApp.modeWysiwyg')}</button>
                    <button type="button" className={editorMode === 'source' ? 'active' : ''} onClick={() => handleEditorMode('source')}>{t('vaultApp.modeSource')}</button>
                  </>
                )}
                <input className="fn-search" placeholder={t('vaultApp.searchPlaceholder')} value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setExpandedSearch(!!e.target.value); }} />
              </>
            )}
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
                    <button type="button" className="fn-search-result" onClick={() => { setActiveId(r.id); setExpandedSearch(false); setSearchQuery(''); }}>
                      <span className="fn-search-result__title">{r.title || t('common.untitled')}</span>
                      {r.snippet && <span className="fn-search-result__snippet">{r.snippet}</span>}
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : (
            <NoteTree
              notes={notes}
              activeId={activeId}
              onSelect={setActiveId}
              onCreateFolder={(pid) => void handleCreate('folder', pid)}
              onCreateNote={(pid) => void handleCreate('note', pid)}
              onCreateTable={(pid) => void handleCreate('table', pid)}
              onImportFolder={(pid) => openImportFolder(pid)}
              onRename={(id, title) => updateNoteById(id, { title })}
              onDelete={(id) => void handleDelete(id)}
              onMove={(dragId, targetId, position) => void handleMove(dragId, targetId, position)}
            />
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
            />
          ) : activeContent?.nodeType === 'table' ? (
            <div className="fn-note" style={{ maxWidth: noteWidth }}>
              {renderNoteResizeHandle()}
              <input className="fn-note__title" value={activeContent.title} onChange={(e) => updateNoteById(activeContent.id, { title: e.target.value })} placeholder={t('vaultApp.tableTitlePlaceholder')} />
              <div className="fn-table-export">
                <button type="button" onClick={() => downloadTextFile(`${activeContent.title || 'table'}.csv`, exportTableCsv(activeContent.title, parseTableDocument(activeContent.contentMd, locale), attachmentLookup), 'text/csv')}>{t('vaultApp.exportCsv')}</button>
                <button type="button" onClick={() => { if (!keys) return; const f = exportEncryptedTableFile(activeContent.title, parseTableDocument(activeContent.contentMd, locale), keys.notesKey); downloadBinaryFile(`${activeContent.title || 'table'}.fnxt`, buildFnxtBytes(f), 'application/octet-stream'); }}>{t('vaultApp.exportFnxt')}</button>
                <label className="fn-import-btn">
                  {t('vaultApp.importCsv')}
                  <input type="file" accept=".csv,text/csv" hidden onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void importCsvFile(file, locale)
                      .then((doc) => updateNoteById(activeContent.id, { contentMd: serializeTable(doc) }))
                      .catch((err) => alert(err instanceof Error ? err.message : t('vaultApp.csvImportFailed')));
                    e.target.value = '';
                  }} />
                </label>
                <label className="fn-import-btn">
                  {t('vaultApp.importFnxt')}
                  <input type="file" accept=".fnxt" hidden onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file || !keys) return;
                    void importFnxtFile(file, keys.notesKey, locale).then(({ doc }) => updateNoteById(activeContent.id, { contentMd: serializeTable(doc) }));
                    e.target.value = '';
                  }} />
                </label>
              </div>
              <TableEditor
                document={parseTableDocument(activeContent.contentMd, locale)}
                onChange={(doc) => updateNoteById(activeContent.id, { contentMd: serializeTable(doc) })}
                attachments={attachments}
                onRegisterInsert={(insert) => {
                  insertTableRef.current = insert;
                }}
                onAttachmentDownload={handleAttachmentDownload}
                onAttachmentEdit={handleAttachmentEdit}
              />
              {renderAttachmentsPanel(activeContent.id, true)}
            </div>
          ) : activeContent?.nodeType === 'note' ? (
            <div className="fn-note" style={{ maxWidth: noteWidth }}>
              {renderNoteResizeHandle()}
              <input className="fn-note__title" value={activeContent.title} onChange={(e) => updateNoteById(activeContent.id, { title: e.target.value })} placeholder={t('vaultApp.notePlaceholder')} />
              <EditorToolbar editor={tiptapEditor} mode={editorMode} />
              <NoteEditor
                key={activeContent.id}
                noteId={activeContent.id}
                mode={editorMode}
                content={activeContent.contentMd}
                onChange={(md) => updateNoteById(activeContent.id, { contentMd: md })}
                onEditorReady={setTiptapEditor}
                onRegisterInsert={(insert) => {
                  insertDocRef.current = insert;
                }}
                attachments={attachments}
                onAttachmentDownload={handleAttachmentDownload}
                onAttachmentEdit={handleAttachmentEdit}
              />
              {renderAttachmentsPanel(activeContent.id, true)}
            </div>
          ) : (
            <div className="fn-empty fn-empty--inline">{t('vaultApp.emptySelectOrCreate')}</div>
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
          isElectron={!!window.fastnote?.isElectron}
          chatNotify={chatNotify}
          uiTheme={uiTheme}
          locale={locale}
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
            imRef.current?.disconnect();
          }}
          onSync={() => void handleSync()}
          onAbout={() => { setShowSettings(false); setShowAbout(true); }}
        />
      )}
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onRegister={handleRegister} onLogin={handleLogin} />}
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
    </I18nProvider>
  );
}
