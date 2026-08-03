import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiClient,
  createVaultRegistryEntry,
  ensureLegacyVaultInRegistry,
  loadChatSessions,
  loadChatUnread,
  loadServerUrl,
  loadSession,
  loadStorageNamespace,
  loadUiTheme,
  saveChatSessions,
  saveChatUnread,
  saveServerUrl,
  saveSession,
  saveStorageNamespace,
  saveVaultRegistry,
} from '@fastnote/api';
import {
  decryptString,
  deriveKeysFromPassword,
  encryptString,
  fromBase64,
  generateIdentityKeypair,
  generateSalt,
  packEncrypted,
  toBase64,
  unpackEncrypted,
  unwrapKey,
  wrapKey,
} from '@fastnote/crypto';
import { IMClient, verifyExchangeKeypair } from '@fastnote/im';
import { SyncClient } from '@fastnote/sync';
import { createStorage } from '@fastnote/storage';
import {
  AI_MAX_TOKENS_DEFAULT,
  AI_MAX_TOKENS_LIMIT,
  AI_MAX_TOKENS_MIN,
  AI_WEB_SEARCH_USES_DEFAULT,
  AI_WEB_SEARCH_USES_LIMIT,
  AI_WEB_SEARCH_USES_MIN,
  META_KEYS,
  decodeChatWire,
  serverUrlNeedsReload,
  storedToChatMessage,
  toStoredPayload,
  type AiAttachment,
  type AiMessage,
  type AiSessionNode,
  type AiSettings,
  type ChatAttachmentRef,
  type ChatMessage,
  type ChatWireAttachment,
  type UserSession,
} from '@fastnote/shared';
import {
  AiAttachmentError,
  AnthropicClient,
  AnthropicTimeoutError,
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  prepareAiAttachment,
  type AiChatMessage,
  type AiContentBlock,
} from '@fastnote/ai';
import {
  AiSessionTree,
  AiWorkbench,
  ChatPanel,
  ChatSidebar,
  UnlockScreen,
  buildChatSessions,
  type VaultListItem,
} from '@fastnote/ui';
import {
  I18nProvider,
  LOCALES,
  LOCALE_LABELS,
  loadLocale,
  saveLocale,
  translate,
  type Locale,
  type TFunction,
} from '@fastnote/i18n';

type VaultKeys = Awaited<ReturnType<typeof deriveKeysFromPassword>>;

const CHAT_STATUS_RANK: Record<ChatMessage['status'], number> = { sent: 0, delivered: 1, read: 2 };

interface AiRunState {
  sessionId: string;
  text: string;
  thinkingChars?: number;
  webSearches?: number;
  startedAt: number;
}

/** Clipboard write with an execCommand fallback for WebViews that block the async API. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fall through to execCommand
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Mobile (Android/Capacitor) shell: vault unlock + the AI assistant only. Notes, tables, chat
 * and cloud sync stay desktop/web-only for now; the vault format is identical, so the AI
 * sessions and settings live in the same encrypted IndexedDB layout the full app uses.
 */
export function MobileApp() {
  const [locale, setLocale] = useState<Locale>(() => loadLocale());
  const t = useCallback<TFunction>((key, vars) => translate(locale, key, vars), [locale]);

  // --- vault / unlock state -------------------------------------------------
  const [storageEpoch, setStorageEpoch] = useState(0);
  const storage = useMemo(() => createStorage({ namespace: loadStorageNamespace() }), [storageEpoch]);
  const [vaultRegistry, setVaultRegistry] = useState(() => ensureLegacyVaultInRegistry(loadLocale()));
  const [activeVaultId, setActiveVaultId] = useState(() => {
    const ns = loadStorageNamespace();
    const registry = ensureLegacyVaultInRegistry(loadLocale());
    return (registry.find((v) => v.namespace === ns) ?? registry[0]).id;
  });
  const [vaultListItems, setVaultListItems] = useState<VaultListItem[]>([]);
  const [isFirstRun, setIsFirstRun] = useState(false);
  const [keys, setKeys] = useState<VaultKeys | null>(null);
  const keysRef = useRef<VaultKeys | null>(null);

  // --- AI state ---------------------------------------------------------------
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiSessions, setAiSessions] = useState<AiSessionNode[]>([]);
  const [activeAiSessionId, setActiveAiSessionId] = useState<string | null>(null);
  const [aiRun, setAiRun] = useState<AiRunState | null>(null);
  const [aiRunError, setAiRunError] = useState<{ sessionId: string; message: string } | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);

  // --- chat / IM state ----------------------------------------------------------
  const [session, setSession] = useState<UserSession | null>(null);
  const [boundUsername, setBoundUsername] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [activePeerName, setActivePeerName] = useState<string | null>(null);
  const [unreadByPeer, setUnreadByPeer] = useState<Record<string, number>>({});
  const [imConnected, setImConnected] = useState(false);
  const imRef = useRef<IMClient | null>(null);
  const sessionRef = useRef<UserSession | null>(null);
  const activePeerRef = useRef<string | null>(null);

  // --- UI state ---------------------------------------------------------------
  const [view, setView] = useState<'ai' | 'chat'>('ai');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  sessionRef.current = session;
  activePeerRef.current = activePeerId;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', loadUiTheme());
  }, []);

  useEffect(() => {
    storage
      .getMeta(META_KEYS.salt)
      .then((salt) => setIsFirstRun(!salt))
      .catch(() => setIsFirstRun(true));
  }, [storage]);

  // The vault's bound cloud username pre-fills the login form in settings.
  useEffect(() => {
    if (!keys) {
      setBoundUsername(null);
      return;
    }
    storage
      .getMeta(META_KEYS.boundUsername)
      .then((u) => setBoundUsername(u ?? null))
      .catch(() => setBoundUsername(null));
  }, [keys, storage]);

  // Probe each registered vault's namespace so the unlock screen can show its state.
  useEffect(() => {
    if (keys) return;
    void (async () => {
      const items: VaultListItem[] = [];
      for (const vault of vaultRegistry) {
        const vaultStorage = createStorage({ namespace: vault.namespace });
        const salt = await vaultStorage.getMeta(META_KEYS.salt);
        const boundUsername = salt
          ? ((await vaultStorage.getMeta(META_KEYS.boundUsername)) ?? undefined)
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

  const selectVaultById = (vaultId: string) => {
    const entry = vaultRegistry.find((v) => v.id === vaultId);
    if (!entry) return;
    setActiveVaultId(vaultId);
    saveStorageNamespace(entry.namespace);
    setStorageEpoch((n) => n + 1);
  };

  const createVaultEntry = (label: string) => {
    const entry = createVaultRegistryEntry(label, locale);
    const next = [...vaultRegistry, entry];
    setVaultRegistry(next);
    saveVaultRegistry(next);
    setActiveVaultId(entry.id);
    saveStorageNamespace(entry.namespace);
    setStorageEpoch((n) => n + 1);
  };

  /** Loads the (encrypted) AI settings + sessions after keys are available. */
  const loadAiState = async (derived: VaultKeys) => {
    const rawAi = await storage.getMeta(META_KEYS.aiSettings);
    if (rawAi) {
      try {
        setAiSettings(JSON.parse(decryptString(derived.masterKey, unpackEncrypted(rawAi))) as AiSettings);
      } catch (err) {
        console.error('failed to decrypt AI settings', err);
      }
    }
    const list = await storage.listAiSessions(derived.notesKey);
    setAiSessions(list);
    const sessionsOnly = list
      .filter((s) => s.kind === 'session')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    setActiveAiSessionId(sessionsOnly[0]?.id ?? null);
  };

  // --- chat / IM logic (a trimmed port of the desktop VaultApp wiring) -----------

  // Read at call time (not render time): handleCloudLogin saves a new URL and then immediately
  // connects, so a render-scoped constant would be stale.
  const serverUrl = () => loadServerUrl();

  /** Generates and stores the ed25519/x25519 identity keys on first use. */
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

  const loadExchangePrivate = async (masterKey: Uint8Array): Promise<Uint8Array | null> => {
    const wrapped = await storage.getMeta(META_KEYS.wrappedExchangeKey);
    if (!wrapped) return null;
    return unwrapKey(masterKey, unpackEncrypted(wrapped));
  };

  const ensureLocalPubkeys = async (derived: VaultKeys) => {
    await setupIdentityKeys(derived);
    const identity = await storage.getMeta(META_KEYS.identityPubkey);
    const exchange = await storage.getMeta(META_KEYS.exchangePubkey);
    if (!identity || !exchange) throw new Error(t('vaultApp.localKeysNotReady'));
    return { identity, exchange };
  };

  /** Debounced real-time upload of chat blobs so other devices can pull them right away. */
  const chatPushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last reconnect catch-up chat sync (ms epoch), throttles the on-connect full sync. */
  const lastChatCatchupRef = useRef(0);
  const scheduleChatPush = () => {
    if (chatPushTimerRef.current) clearTimeout(chatPushTimerRef.current);
    chatPushTimerRef.current = setTimeout(() => {
      chatPushTimerRef.current = null;
      const s = sessionRef.current;
      if (!s) return;
      void new SyncClient(new ApiClient(serverUrl(), locale), s)
        .pushChatMessages(storage)
        .catch((err) => console.warn('[chat] realtime push failed (will retry on next sync)', err));
    }, 3000);
  };

  const persistChatMessage = async (message: ChatMessage) => {
    const k = keysRef.current;
    if (!k) return;
    await storage.saveChatMessage(message, k.notesKey);
    setChatMessages((prev) => {
      if (prev.some((m) => m.id === message.id)) {
        return prev.map((m) => (m.id === message.id ? message : m));
      }
      return [...prev, message].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    });
    scheduleChatPush();
  };

  /** Receipts only ever move a message's status forward (sent → delivered → read). */
  const updateChatMessageStatus = (msgId: string, status: ChatMessage['status']) => {
    const k = keysRef.current;
    if (!k) return;
    setChatMessages((prev) => {
      let changed = false;
      const next = prev.map((m) => {
        if (m.id !== msgId || m.direction !== 'out' || CHAT_STATUS_RANK[status] <= CHAT_STATUS_RANK[m.status]) {
          return m;
        }
        changed = true;
        const updated = { ...m, status };
        void storage.saveChatMessage(updated, k.notesKey);
        return updated;
      });
      return changed ? next : prev;
    });
  };

  const bumpUnread = (peerId: string) => {
    setUnreadByPeer((prev) => {
      const next = { ...prev, [peerId]: (prev[peerId] ?? 0) + 1 };
      saveChatUnread(next, loadStorageNamespace());
      return next;
    });
  };

  const clearPeerUnread = (peerId: string) => {
    setUnreadByPeer((prev) => {
      if (!prev[peerId]) return prev;
      const next = { ...prev };
      delete next[peerId];
      saveChatUnread(next, loadStorageNamespace());
      return next;
    });
  };

  const loadChatHistoryFor = async (derived: VaultKeys) => {
    const messages = await storage.listChatMessagesDecrypted(derived.notesKey);
    setChatMessages(messages);
  };

  const processIncomingChat = async (peerId: string, plaintext: string, msgId: string, sentAt: string) => {
    const k = keysRef.current;
    if (!k) return;
    if (await storage.hasChatMessage(msgId)) return;

    const wire = decodeChatWire(plaintext);
    const refs: ChatAttachmentRef[] = [];
    for (const att of wire.attachments ?? []) {
      try {
        refs.push(await storage.saveChatAttachmentFromWire(msgId, peerId, att, k.notesKey));
      } catch (err) {
        console.warn('[chat] failed to save incoming attachment', att.fileName, err);
      }
    }
    const imSession = imRef.current?.getSession(peerId);
    const msg = storedToChatMessage(
      msgId,
      peerId,
      'in',
      sentAt,
      toStoredPayload({ ...wire, peerUsername: imSession?.peerUsername }, refs),
    );
    await persistChatMessage(msg);

    const viewingThread = viewRef.current === 'chat' && activePeerRef.current === peerId;
    if (!viewingThread) bumpUnread(peerId);
    if (imSession && viewRef.current === 'chat' && (!activePeerRef.current || activePeerRef.current === peerId)) {
      setActivePeerId(peerId);
      setActivePeerName(imSession.peerUsername);
      clearPeerUnread(peerId);
    }
  };

  const initIM = async (derived: VaultKeys, userSession: UserSession) => {
    const priv = await loadExchangePrivate(derived.masterKey);
    if (!priv) throw new Error(t('vaultApp.chatKeyNotReady'));
    const derivedPub = verifyExchangeKeypair(priv);
    const storedPub = await storage.getMeta(META_KEYS.exchangePubkey);
    if (storedPub !== derivedPub) await storage.setMeta(META_KEYS.exchangePubkey, derivedPub);
    const { identity } = await ensureLocalPubkeys(derived);
    await new ApiClient(serverUrl(), locale).updateKeys(userSession.token, identity, derivedPub);

    imRef.current?.disconnect();
    const client = new IMClient(serverUrl(), userSession.token, priv);
    imRef.current = client;
    const vaultNs = loadStorageNamespace();
    for (const s of loadChatSessions(vaultNs)) client.loadSession(s);
    const persistSessions = () => saveChatSessions(client.allSessions(), vaultNs);

    client.setEnsurePeerSession(async (peerId: string) => {
      try {
        const peer = await new ApiClient(serverUrl(), locale).lookupUserById(userSession.token, peerId);
        if (!peer.exchangePubkey) return false;
        client.upsertSession(peer.userId, peer.username, peer.exchangePubkey);
        persistSessions();
        return true;
      } catch (err) {
        console.warn('[IM] ensurePeerSession failed', peerId, err);
        return false;
      }
    });
    client.setOnMessage(async (peerId, plaintext, msgId, sentAt) => {
      await processIncomingChat(peerId, plaintext, msgId, sentAt);
      persistSessions();
    });
    client.setOnDeliveryAck((_peerId, msgId) => updateChatMessageStatus(msgId, 'delivered'));
    client.setOnReadAck((_peerId, msgId) => updateChatMessageStatus(msgId, 'read'));

    const pullPending = async () => {
      await client.pullPendingMessages(serverUrl(), userSession.token);
      persistSessions();
    };
    client.setPendingFetcher(() => pullPending());
    // Reconnect catch-up: another logged-in device may have already delivery-acked (deleted)
    // queued relay messages while this device was offline, so also pull the account chat
    // history on every (re)connect, throttled to once a minute.
    client.setOnConnected(() => {
      const now = Date.now();
      if (now - lastChatCatchupRef.current < 60_000) return;
      lastChatCatchupRef.current = now;
      const k = keysRef.current;
      const s = sessionRef.current;
      if (!k || !s) return;
      void syncChatHistory(s, k);
    });
    client.connect();
    void pullPending().catch((err) => console.error('fetchPending failed', err));
  };

  /** Pull the full chat history from the server (messages synced by other devices). */
  const syncChatHistory = async (userSession: UserSession, derived: VaultKeys) => {
    try {
      const client = new SyncClient(new ApiClient(serverUrl(), locale), userSession);
      const { pulled } = await client.syncChatMessages(storage);
      if (pulled > 0 && keysRef.current === derived) await loadChatHistoryFor(derived);
      // AI sessions ride the same account sync (encrypted whole-node blobs, LWW).
      const ai = await client.syncAiSessions(storage, derived.notesKey);
      if (ai.pulled > 0 && keysRef.current === derived) {
        const list = await storage.listAiSessions(derived.notesKey);
        setAiSessions(list);
        setActiveAiSessionId((cur) => (cur && list.some((n) => n.id === cur) ? cur : null));
      }
    } catch (err) {
      console.warn('[chat] history sync failed', err);
    }
  };

  /** Manual "sync history" from the chat header: full push+pull, then refresh the thread. */
  const handleChatHistorySync = async () => {
    const k = keysRef.current;
    const s = sessionRef.current;
    if (!k || !s) throw new Error(t('chatPanel.syncNeedsLogin'));
    const client = new SyncClient(new ApiClient(serverUrl(), locale), s);
    const { pulled } = await client.syncChatMessages(storage);
    if (pulled > 0 && keysRef.current === k) await loadChatHistoryFor(k);
  };

  const ensureImReady = async (): Promise<IMClient> => {
    const derived = keysRef.current;
    const userSession = sessionRef.current;
    if (!derived || !userSession) throw new Error(t('vaultApp.loginRequired'));
    if (!imRef.current) await initIM(derived, userSession);
    if (!imRef.current) throw new Error(t('vaultApp.messageServiceInitFailed'));
    await imRef.current.waitForConnection();
    return imRef.current;
  };

  const ensureChatPeerSession = async (peerId: string, peerName?: string | null) => {
    const client = await ensureImReady();
    const userSession = sessionRef.current;
    if (!userSession) throw new Error(t('vaultApp.loginRequired'));
    const api = new ApiClient(serverUrl(), locale);
    const peer = peerName
      ? await api.lookupUser(userSession.token, peerName)
      : await api.lookupUserById(userSession.token, peerId);
    if (!peer.exchangePubkey) {
      throw new Error(t('vaultApp.peerKeyNotReady', { username: peer.username }));
    }
    client.upsertSession(peer.userId, peer.username, peer.exchangePubkey);
    saveChatSessions(client.allSessions(), loadStorageNamespace());
    return client;
  };

  const handleStartChat = async (username: string) => {
    const userSession = sessionRef.current;
    if (!userSession) throw new Error(t('vaultApp.loginRequired'));
    const api = new ApiClient(serverUrl(), locale);
    const peer = await api.lookupUser(userSession.token, username);
    if (!peer.exchangePubkey) {
      throw new Error(t('vaultApp.peerKeyNotReady', { username: peer.username }));
    }
    const client = await ensureImReady();
    client.upsertSession(peer.userId, peer.username, peer.exchangePubkey);
    saveChatSessions(client.allSessions(), loadStorageNamespace());
    setActivePeerId(peer.userId);
    setActivePeerName(peer.username);
    setDrawerOpen(false);
  };

  const handleSendChat = async (body: string, files: File[]) => {
    const k = keysRef.current;
    if (!activePeerId || !k) return;
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
      refs.push(await storage.saveChatAttachmentFromWire(messageId, activePeerId, att, k.notesKey));
    }
    const payload = { v: 1 as const, body, attachments: wireAttachments };
    await client.sendPayload(activePeerId, payload, messageId);
    saveChatSessions(client.allSessions(), loadStorageNamespace());
    await persistChatMessage({
      id: messageId,
      peerId: activePeerId,
      peerUsername: activePeerName ?? undefined,
      direction: 'out',
      body,
      attachments: refs,
      sentAt: new Date().toISOString(),
      status: 'sent',
    });
  };

  const handleDeleteChatMessage = async (messageId: string) => {
    const k = keysRef.current;
    if (!k) return;
    await storage.deleteChatMessage(messageId, k.notesKey);
    setChatMessages((prev) => prev.filter((m) => m.id !== messageId));
  };

  /** Attachment "download" on mobile: Android share sheet when possible, clipboard-less fallback. */
  const handleChatAttachmentDownload = async (attachmentId: string) => {
    const k = keysRef.current;
    if (!k) return;
    const loaded = await storage.loadChatAttachmentDecrypted(attachmentId, k.notesKey);
    if (!loaded) return;
    const mime = loaded.meta.mimeType || 'application/octet-stream';
    const file = new File([loaded.data.slice()], loaded.meta.fileName, { type: mime });
    if (typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch {
        // cancelled or unsupported — fall through to the anchor download
      }
    }
    const url = URL.createObjectURL(new Blob([loaded.data.slice()], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = loaded.meta.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const handleChatAttachmentPreview = async (attachmentId: string): Promise<Blob | null> => {
    const k = keysRef.current;
    if (!k) return null;
    const loaded = await storage.loadChatAttachmentDecrypted(attachmentId, k.notesKey);
    if (!loaded) return null;
    return new Blob([loaded.data.slice()], { type: loaded.meta.mimeType || 'application/octet-stream' });
  };

  const handleChatAttachmentEdit = async (attachmentId: string, description: string) => {
    const k = keysRef.current;
    if (!k) return;
    await storage.updateChatAttachmentDescription(attachmentId, description, k.notesKey);
    setChatMessages((prev) =>
      prev.map((m) => {
        if (!m.attachments?.some((a) => a.id === attachmentId)) return m;
        const attachments = m.attachments.map((a) => (a.id === attachmentId ? { ...a, description } : a));
        const updated = { ...m, attachments };
        void storage.saveChatMessage(updated, k.notesKey);
        return updated;
      }),
    );
  };

  const handleChatAttachmentRemove = async (messageId: string, attachmentId: string) => {
    const k = keysRef.current;
    if (!k) return;
    await storage.deleteChatAttachment(attachmentId);
    setChatMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        const attachments = m.attachments?.filter((a) => a.id !== attachmentId) ?? [];
        const updated = { ...m, attachments };
        void storage.saveChatMessage(updated, k.notesKey);
        return updated;
      }),
    );
  };

  /** Restores a persisted login (if any) after unlock and brings chat online in the background. */
  const restoreChatAfterUnlock = (derived: VaultKeys) => {
    void loadChatHistoryFor(derived).catch((err) => console.warn('[chat] history load failed', err));
    setUnreadByPeer(loadChatUnread(loadStorageNamespace()));
    const stored = loadSession(loadStorageNamespace());
    if (!stored) return;
    setSession(stored);
    sessionRef.current = stored;
    void (async () => {
      try {
        await initIM(derived, stored);
        await syncChatHistory(stored, derived);
      } catch (err) {
        console.warn('[chat] IM init after unlock failed', err);
      }
    })();
  };

  /**
   * Cloud login from the unlock screen. Unlike desktop this only enables chat (there is no note
   * sync UI on mobile): resolve/verify the vault salt, log in, upload pubkeys, connect IM and
   * pull the full chat history.
   */
  const handleCloudLogin = async ({
    password,
    username,
    serverUrl: nextServerUrl,
  }: {
    password: string;
    username: string;
    serverUrl: string;
  }) => {
    saveServerUrl(nextServerUrl);
    if (serverUrlNeedsReload(nextServerUrl)) {
      // The CSP was written at page parse time for the old server origin; a reload re-runs the
      // bootstrap against the freshly saved URL, after which the user can log in again.
      if (window.confirm(t('vaultApp.serverUrlReloadConfirm'))) {
        window.location.reload();
        return;
      }
      throw new Error(t('vaultApp.serverUrlReloadConfirm'));
    }
    const api = new ApiClient(nextServerUrl, locale);

    let saltB64 = await storage.getMeta(META_KEYS.salt);
    let derived: VaultKeys;
    if (!saltB64) {
      // Brand-new device: adopt the account's vault salt so the derived proof matches.
      const saltInfo = await api.getVaultSaltInfo(username);
      if (saltInfo.status === 'user_not_found') throw new Error(t('vaultApp.cloudAccountNotFound'));
      if (saltInfo.status === 'vault_salt_missing') throw new Error(t('vaultApp.vaultParamsMissing'));
      saltB64 = saltInfo.vault_salt;
      derived = await deriveKeysFromPassword(password, fromBase64(saltB64));
      const proof = toBase64(derived.passwordVerifier);
      const userSession = await api.login(username, proof);
      await storage.setMeta(META_KEYS.salt, saltB64);
      await storage.setMeta(META_KEYS.passwordVerifier, proof);
      await storage.setMeta(META_KEYS.boundUsername, username.trim());
      setBoundUsername(username.trim());
      await setupIdentityKeys(derived);
      saveSession(userSession, loadStorageNamespace());
      setSession(userSession);
      sessionRef.current = userSession;
      keysRef.current = derived;
      await loadAiState(derived);
      setKeys(derived);
      setIsFirstRun(false);
      setVaultListItems((prev) =>
        prev.map((v) => (v.id === activeVaultId ? { ...v, initialized: true, boundUsername: username.trim() } : v)),
      );
      await initIM(derived, userSession);
      await syncChatHistory(userSession, derived);
      await loadChatHistoryFor(derived);
      return;
    }

    derived = await deriveKeysFromPassword(password, fromBase64(saltB64));
    const verifier = await storage.getMeta(META_KEYS.passwordVerifier);
    if (!verifier || toBase64(derived.passwordVerifier) !== verifier) {
      throw new Error(t('vaultApp.wrongPassword'));
    }
    await setupIdentityKeys(derived);
    const userSession = await api.login(username, toBase64(derived.passwordVerifier));
    await storage.setMeta(META_KEYS.boundUsername, username.trim());
    setBoundUsername(username.trim());
    saveSession(userSession, loadStorageNamespace());
    setSession(userSession);
    sessionRef.current = userSession;
    // Already-unlocked path (login from settings): keep the current AI state untouched.
    const alreadyUnlocked = !!keysRef.current;
    keysRef.current = derived;
    if (!alreadyUnlocked) {
      await loadAiState(derived);
      setKeys(derived);
    }
    setVaultListItems((prev) =>
      prev.map((v) => (v.id === activeVaultId ? { ...v, boundUsername: username.trim() } : v)),
    );
    await initIM(derived, userSession);
    await syncChatHistory(userSession, derived);
    await loadChatHistoryFor(derived);
  };

  /** Logs out of the cloud account (chat goes offline); the vault stays unlocked. */
  const handleLogout = () => {
    saveSession(null, loadStorageNamespace());
    setSession(null);
    sessionRef.current = null;
    imRef.current?.disconnect();
    imRef.current = null;
    setImConnected(false);
  };

  // Poll the WS connection state while the chat view is open.
  useEffect(() => {
    if (view !== 'chat' || !session) {
      setImConnected(false);
      return;
    }
    const tick = () => setImConnected(imRef.current?.isConnected() ?? false);
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [view, session]);

  // While a thread is open, read-ack whatever is still unread and flip it locally.
  useEffect(() => {
    const k = keysRef.current;
    if (view !== 'chat' || !activePeerId || !k) return;
    const unread = chatMessages.filter(
      (m) => m.peerId === activePeerId && m.direction === 'in' && m.status !== 'read',
    );
    if (unread.length === 0) return;
    for (const m of unread) imRef.current?.sendReadAck(activePeerId, m.id);
    setChatMessages((prev) =>
      prev.map((m) =>
        m.peerId === activePeerId && m.direction === 'in' && m.status !== 'read' ? { ...m, status: 'read' } : m,
      ),
    );
    void Promise.all(unread.map((m) => storage.saveChatMessage({ ...m, status: 'read' }, k.notesKey)));
  }, [view, activePeerId, chatMessages, keys, storage]);

  useEffect(() => {
    if (view === 'chat' && activePeerId) clearPeerUnread(activePeerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, activePeerId]);

  const chatSessions = useMemo(
    () =>
      buildChatSessions(
        chatMessages,
        loadChatSessions(loadStorageNamespace()).map((s) => ({ peerId: s.peerId, peerName: s.peerUsername })),
        activePeerId,
        activePeerName,
        t,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatMessages, activePeerId, activePeerName, imConnected, t],
  );

  const totalUnread = useMemo(
    () => Object.values(unreadByPeer).reduce((sum, n) => sum + n, 0),
    [unreadByPeer],
  );

  const handleCreateVault = async (password: string) => {
    const salt = generateSalt();
    await storage.setMeta(META_KEYS.salt, toBase64(salt));
    const derived = await deriveKeysFromPassword(password, salt);
    await storage.setMeta(META_KEYS.passwordVerifier, toBase64(derived.passwordVerifier));
    await setupIdentityKeys(derived);
    keysRef.current = derived;
    await loadAiState(derived);
    setKeys(derived);
    setIsFirstRun(false);
    setVaultListItems((prev) => prev.map((v) => (v.id === activeVaultId ? { ...v, initialized: true } : v)));
  };

  const handleUnlockLocal = async (password: string) => {
    const saltB64 = await storage.getMeta(META_KEYS.salt);
    if (!saltB64) throw new Error(t('vaultApp.noLocalVault'));
    const derived = await deriveKeysFromPassword(password, fromBase64(saltB64));
    const verifier = await storage.getMeta(META_KEYS.passwordVerifier);
    if (!verifier || toBase64(derived.passwordVerifier) !== verifier) {
      throw new Error(t('vaultApp.wrongPassword'));
    }
    keysRef.current = derived;
    await loadAiState(derived);
    setKeys(derived);
    restoreChatAfterUnlock(derived);
  };

  const handleLock = () => {
    aiAbortRef.current?.abort();
    if (aiPushTimerRef.current) {
      clearTimeout(aiPushTimerRef.current);
      aiPushTimerRef.current = null;
    }
    imRef.current?.disconnect();
    imRef.current = null;
    keysRef.current = null;
    sessionRef.current = null;
    setKeys(null);
    setSession(null);
    setAiSettings(null);
    setAiSessions([]);
    setActiveAiSessionId(null);
    setAiRun(null);
    setAiRunError(null);
    setChatMessages([]);
    setActivePeerId(null);
    setActivePeerName(null);
    setUnreadByPeer({});
    setImConnected(false);
    setView('ai');
    setDrawerOpen(false);
    setSettingsOpen(false);
  };

  // --- AI session CRUD ----------------------------------------------------------

  /** Debounced background push of locally-changed AI sessions (no-op while logged out). */
  const aiPushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAiSessionPush = () => {
    if (aiPushTimerRef.current) clearTimeout(aiPushTimerRef.current);
    aiPushTimerRef.current = setTimeout(() => {
      aiPushTimerRef.current = null;
      const k = keysRef.current;
      const s = sessionRef.current;
      if (!k || !s) return;
      const client = new SyncClient(new ApiClient(serverUrl(), locale), s);
      void client.syncAiSessions(storage, k.notesKey).catch((err) => {
        console.warn('[ai] session sync failed (will retry on next sync)', err);
      });
    }, 5000);
  };

  const persistAiSession = (node: AiSessionNode) => {
    const k = keysRef.current;
    if (!k) return;
    void storage.saveAiSession(node, k.notesKey);
    scheduleAiSessionPush();
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
    if (kind === 'session') {
      setActiveAiSessionId(node.id);
      setDrawerOpen(false);
    }
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
    const out = new Set([id]);
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
    const restoring = new Set([id]);
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

  /**
   * The mobile build has no note editor, so "convert to note" shares/copies the Q&A range as
   * markdown instead (Android share sheet when available, clipboard otherwise).
   */
  const handleAiShareAsMarkdown = async (messages: AiMessage[]) => {
    if (messages.length === 0) return;
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
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ text: md });
        return;
      } catch {
        // cancelled or unsupported payload — fall back to clipboard
      }
    }
    alert((await copyText(md)) ? t('mobileApp.copiedAsMarkdown') : t('mobileApp.copyFailed'));
  };

  const activeAiSession =
    aiSessions.find((s) => s.id === activeAiSessionId && s.kind === 'session') ?? null;

  // --- render -------------------------------------------------------------------
  if (!keys) {
    return (
      <I18nProvider locale={locale}>
        <div className="fn-mobile">
          <UnlockScreen
            vaults={vaultListItems}
            activeVaultId={activeVaultId}
            isFirstRun={isFirstRun}
            defaultServerUrl={loadServerUrl()}
            onSelectVault={selectVaultById}
            onCreateVaultEntry={createVaultEntry}
            onCreateVault={handleCreateVault}
            onUnlockLocal={handleUnlockLocal}
            onCloudSync={handleCloudLogin}
          />
        </div>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider locale={locale}>
      <div className="fn-mobile">
        <header className="fn-mobile__header">
          <button
            type="button"
            className="fn-mobile__header-btn"
            title={t('mobileApp.sessions')}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            ☰
          </button>
          <div className="fn-mobile__header-title">
            {view === 'chat'
              ? (activePeerName ?? t('mobileApp.chat'))
              : activeAiSession
                ? activeAiSession.title
                : t('aiPanel.title')}
          </div>
          <div className="fn-mobile__header-actions">
            <button
              type="button"
              className={`fn-mobile__header-btn${view === 'chat' ? ' fn-mobile__header-btn--active' : ''}`}
              title={view === 'chat' ? t('aiPanel.title') : t('mobileApp.chat')}
              onClick={() => {
                setView((v) => (v === 'chat' ? 'ai' : 'chat'));
                setDrawerOpen(false);
              }}
            >
              {view === 'chat' ? '🤖' : '💬'}
              {view !== 'chat' && totalUnread > 0 && (
                <span className="fn-mobile__badge">{totalUnread > 99 ? '99+' : totalUnread}</span>
              )}
            </button>
            <button
              type="button"
              className="fn-mobile__header-btn"
              title={t('mobileApp.settings')}
              onClick={() => setSettingsOpen(true)}
            >
              ⚙
            </button>
            <button
              type="button"
              className="fn-mobile__header-btn"
              title={t('mobileApp.lock')}
              onClick={handleLock}
            >
              🔒
            </button>
          </div>
        </header>

        <main className="fn-mobile__main">
          {view === 'chat' ? (
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
              streamingWebSearches={
                aiRun && aiRun.sessionId === activeAiSession.id ? (aiRun.webSearches ?? 0) : 0
              }
              streamingStartedAt={
                aiRun && aiRun.sessionId === activeAiSession.id ? aiRun.startedAt : null
              }
              busy={aiRun !== null}
              error={
                aiRunError && aiRunError.sessionId === activeAiSession.id ? aiRunError.message : null
              }
              onSend={(text, attachments) => void runAiRequest(activeAiSession.id, text, attachments)}
              onStop={handleAiStop}
              onDeleteMessage={(index) => handleAiDeleteMessage(activeAiSession.id, index)}
              prepareAttachment={handlePrepareAiAttachment}
              onConvertToNote={(messages) => void handleAiShareAsMarkdown(messages)}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : (
            <div className="fn-mobile__empty">
              <p>{t('mobileApp.noSession')}</p>
              <button type="button" onClick={() => handleAiCreate('session', null)}>
                {t('aiPanel.newSession')}
              </button>
            </div>
          )}
        </main>

        {drawerOpen && (
          <div className="fn-mobile__drawer-backdrop" onClick={() => setDrawerOpen(false)}>
            <div className="fn-mobile__drawer" onClick={(e) => e.stopPropagation()}>
              <div className="fn-mobile__drawer-title">
                {view === 'chat' ? t('mobileApp.chat') : t('aiPanel.title')}
              </div>
              {view === 'chat' ? (
                <ChatSidebar
                  sessions={chatSessions}
                  activePeerId={activePeerId}
                  sessionLoggedIn={!!session}
                  imConnected={imConnected}
                  unreadByPeer={unreadByPeer}
                  onSelectPeer={(id, name) => {
                    setActivePeerId(id);
                    setActivePeerName(name);
                    clearPeerUnread(id);
                    setDrawerOpen(false);
                  }}
                  onStartChat={handleStartChat}
                />
              ) : (
                <AiSessionTree
                  sessions={aiSessions}
                  activeId={activeAiSessionId}
                  onSelect={(id) => {
                    setActiveAiSessionId(id);
                    setDrawerOpen(false);
                  }}
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
          </div>
        )}

        {settingsOpen && (
          <MobileSettings
            t={t}
            locale={locale}
            settings={aiSettings}
            session={session}
            boundUsername={boundUsername}
            onLogin={handleCloudLogin}
            onLogout={handleLogout}
            onSaveSettings={async (next) => {
              const k = keysRef.current;
              if (!k) return;
              setAiSettings(next);
              await storage.setMeta(
                META_KEYS.aiSettings,
                packEncrypted(encryptString(k.masterKey, JSON.stringify(next))),
              );
            }}
            onChangeLocale={(next) => {
              setLocale(next);
              saveLocale(next);
            }}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>
    </I18nProvider>
  );
}

interface MobileSettingsProps {
  t: TFunction;
  locale: Locale;
  settings: AiSettings | null;
  session: UserSession | null;
  boundUsername: string | null;
  onLogin: (args: { password: string; username: string; serverUrl: string }) => Promise<void>;
  onLogout: () => void;
  onSaveSettings: (settings: AiSettings) => Promise<void>;
  onChangeLocale: (locale: Locale) => void;
  onClose: () => void;
}

function MobileSettings({
  t,
  locale,
  settings,
  session,
  boundUsername,
  onLogin,
  onLogout,
  onSaveSettings,
  onChangeLocale,
  onClose,
}: MobileSettingsProps) {
  const [apiKey, setApiKey] = useState(settings?.apiKey ?? '');
  const knownModel = CLAUDE_MODELS.some((m) => m.id === (settings?.model ?? DEFAULT_CLAUDE_MODEL));
  const [model, setModel] = useState(knownModel ? (settings?.model ?? DEFAULT_CLAUDE_MODEL) : '__custom__');
  const [customModel, setCustomModel] = useState(knownModel ? '' : (settings?.model ?? ''));
  const [maxTokens, setMaxTokens] = useState(settings?.maxTokens ?? AI_MAX_TOKENS_DEFAULT);
  const [webSearch, setWebSearch] = useState(settings?.webSearch ?? false);
  const [webSearchMaxUses, setWebSearchMaxUses] = useState(
    settings?.webSearchMaxUses ?? AI_WEB_SEARCH_USES_DEFAULT,
  );
  const [saved, setSaved] = useState(false);

  // --- cloud account (chat) ---------------------------------------------------
  const [loginServerUrl, setLoginServerUrl] = useState(() => loadServerUrl());
  const [loginUsername, setLoginUsername] = useState(boundUsername ?? '');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const handleLogin = async () => {
    if (loginBusy) return;
    if (!loginServerUrl.trim()) {
      setLoginError(t('unlockScreen.errorServerUrlRequired'));
      return;
    }
    if (!loginUsername.trim()) {
      setLoginError(t('unlockScreen.errorUsernameRequired'));
      return;
    }
    setLoginBusy(true);
    setLoginError(null);
    try {
      await onLogin({
        serverUrl: loginServerUrl.trim(),
        username: loginUsername.trim(),
        password: loginPassword,
      });
      setLoginPassword('');
    } catch (err) {
      setLoginError(err instanceof Error && err.message ? err.message : t('unlockScreen.errorGeneric'));
    } finally {
      setLoginBusy(false);
    }
  };

  const handleSave = async () => {
    const resolvedModel = model === '__custom__' ? customModel.trim() || DEFAULT_CLAUDE_MODEL : model;
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));
    await onSaveSettings({
      apiKey: apiKey.trim(),
      model: resolvedModel,
      maxTokens: clamp(maxTokens || AI_MAX_TOKENS_DEFAULT, AI_MAX_TOKENS_MIN, AI_MAX_TOKENS_LIMIT),
      webSearch,
      webSearchMaxUses: clamp(
        webSearchMaxUses || AI_WEB_SEARCH_USES_DEFAULT,
        AI_WEB_SEARCH_USES_MIN,
        AI_WEB_SEARCH_USES_LIMIT,
      ),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="fn-mobile__drawer-backdrop" onClick={onClose}>
      <div className="fn-mobile__settings" onClick={(e) => e.stopPropagation()}>
        <div className="fn-mobile__settings-head">
          <span>{t('settingsModal.title')}</span>
          <button type="button" onClick={onClose}>
            ✕
          </button>
        </div>

        <label className="fn-mobile__field">
          <span>{t('settingsModal.languageLegend')}</span>
          <select value={locale} onChange={(e) => onChangeLocale(e.target.value as Locale)}>
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {LOCALE_LABELS[l]}
              </option>
            ))}
          </select>
        </label>

        <div className="fn-mobile__settings-section">{t('settingsModal.tabs.account')}</div>

        {session ? (
          <>
            <p className="fn-mobile__hint">
              {t('settingsModal.accountLabel', { username: session.username })}
            </p>
            <button type="button" className="fn-mobile__save" onClick={onLogout}>
              {t('settingsModal.logout')}
            </button>
          </>
        ) : (
          <>
            <p className="fn-mobile__hint">{t('mobileApp.accountHint')}</p>
            <label className="fn-mobile__field">
              <span>{t('settingsModal.serverUrlLabel')}</span>
              <input
                value={loginServerUrl}
                autoComplete="off"
                onChange={(e) => setLoginServerUrl(e.target.value)}
                placeholder={t('unlockScreen.serverUrlPlaceholder')}
              />
            </label>
            <label className="fn-mobile__field">
              <span>{t('unlockScreen.usernamePlaceholder')}</span>
              <input
                value={loginUsername}
                autoComplete="username"
                onChange={(e) => setLoginUsername(e.target.value)}
                placeholder={t('unlockScreen.usernamePlaceholder')}
              />
            </label>
            <label className="fn-mobile__field">
              <span>{t('unlockScreen.masterPasswordPlaceholder')}</span>
              <input
                type="password"
                value={loginPassword}
                autoComplete="current-password"
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder={t('unlockScreen.masterPasswordPlaceholder')}
              />
            </label>
            {loginError && <p className="fn-unlock__error">{loginError}</p>}
            <button
              type="button"
              className="fn-mobile__save"
              disabled={loginBusy}
              onClick={() => void handleLogin()}
            >
              {loginBusy ? t('unlockScreen.loggingIn') : t('unlockScreen.loginAndSync')}
            </button>
          </>
        )}

        <div className="fn-mobile__settings-section">{t('settingsModal.ai.legend')}</div>

        <label className="fn-mobile__field">
          <span>{t('settingsModal.ai.apiKeyLabel')}</span>
          <input
            type="password"
            value={apiKey}
            autoComplete="off"
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-…"
          />
        </label>

        <label className="fn-mobile__field">
          <span>{t('settingsModal.ai.modelLabel')}</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {CLAUDE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value="__custom__">{t('settingsModal.ai.customModel')}</option>
          </select>
        </label>

        {model === '__custom__' && (
          <label className="fn-mobile__field">
            <span>{t('settingsModal.ai.customModelLabel')}</span>
            <input value={customModel} onChange={(e) => setCustomModel(e.target.value)} />
          </label>
        )}

        <label className="fn-mobile__field">
          <span>{t('settingsModal.ai.maxTokensLabel')}</span>
          <input
            type="number"
            min={AI_MAX_TOKENS_MIN}
            max={AI_MAX_TOKENS_LIMIT}
            value={maxTokens}
            onChange={(e) => setMaxTokens(Number(e.target.value))}
          />
        </label>

        <label className="fn-mobile__field fn-mobile__field--row">
          <input type="checkbox" checked={webSearch} onChange={(e) => setWebSearch(e.target.checked)} />
          <span>{t('settingsModal.ai.webSearchLabel')}</span>
        </label>

        {webSearch && (
          <label className="fn-mobile__field">
            <span>{t('settingsModal.ai.webSearchMaxUsesLabel')}</span>
            <input
              type="number"
              min={AI_WEB_SEARCH_USES_MIN}
              max={AI_WEB_SEARCH_USES_LIMIT}
              value={webSearchMaxUses}
              onChange={(e) => setWebSearchMaxUses(Number(e.target.value))}
            />
          </label>
        )}

        <p className="fn-mobile__hint">{t('settingsModal.ai.hint')}</p>

        <button type="button" className="fn-mobile__save" onClick={() => void handleSave()}>
          {saved ? t('settingsModal.ai.saved') : t('settingsModal.ai.save')}
        </button>

        <p className="fn-mobile__version">FastNote Mobile v{__APP_VERSION__}</p>
      </div>
    </div>
  );
}
