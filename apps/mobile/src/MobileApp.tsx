import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createVaultRegistryEntry,
  ensureLegacyVaultInRegistry,
  loadServerUrl,
  loadStorageNamespace,
  loadUiTheme,
  saveStorageNamespace,
  saveVaultRegistry,
} from '@fastnote/api';
import {
  decryptString,
  deriveKeysFromPassword,
  encryptString,
  fromBase64,
  generateSalt,
  packEncrypted,
  toBase64,
  unpackEncrypted,
} from '@fastnote/crypto';
import { createStorage } from '@fastnote/storage';
import {
  AI_MAX_TOKENS_DEFAULT,
  AI_MAX_TOKENS_LIMIT,
  AI_MAX_TOKENS_MIN,
  AI_WEB_SEARCH_USES_DEFAULT,
  AI_WEB_SEARCH_USES_LIMIT,
  AI_WEB_SEARCH_USES_MIN,
  META_KEYS,
  type AiAttachment,
  type AiMessage,
  type AiSessionNode,
  type AiSettings,
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
import { AiSessionTree, AiWorkbench, UnlockScreen, type VaultListItem } from '@fastnote/ui';
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

  // --- UI state ---------------------------------------------------------------
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', loadUiTheme());
  }, []);

  useEffect(() => {
    storage
      .getMeta(META_KEYS.salt)
      .then((salt) => setIsFirstRun(!salt))
      .catch(() => setIsFirstRun(true));
  }, [storage]);

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

  const handleCreateVault = async (password: string) => {
    const salt = generateSalt();
    await storage.setMeta(META_KEYS.salt, toBase64(salt));
    const derived = await deriveKeysFromPassword(password, salt);
    await storage.setMeta(META_KEYS.passwordVerifier, toBase64(derived.passwordVerifier));
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
  };

  const handleLock = () => {
    aiAbortRef.current?.abort();
    keysRef.current = null;
    setKeys(null);
    setAiSettings(null);
    setAiSessions([]);
    setActiveAiSessionId(null);
    setAiRun(null);
    setAiRunError(null);
    setDrawerOpen(false);
    setSettingsOpen(false);
  };

  // --- AI session CRUD ----------------------------------------------------------
  const persistAiSession = (node: AiSessionNode) => {
    const k = keysRef.current;
    if (k) void storage.saveAiSession(node, k.notesKey);
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

  const handleAiDelete = (id: string) => {
    // Deleting a folder removes its whole subtree.
    const doomed = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of aiSessions) {
        if (s.parentId && doomed.has(s.parentId) && !doomed.has(s.id)) {
          doomed.add(s.id);
          grew = true;
        }
      }
    }
    setAiSessions((prev) => prev.filter((s) => !doomed.has(s.id)));
    for (const doomedId of doomed) void storage.deleteAiSession(doomedId);
    setActiveAiSessionId((cur) => (cur && doomed.has(cur) ? null : cur));
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
            onCloudSync={() => Promise.reject(new Error(t('mobileApp.cloudNotSupported')))}
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
            {activeAiSession ? activeAiSession.title : t('aiPanel.title')}
          </div>
          <div className="fn-mobile__header-actions">
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
          {activeAiSession ? (
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
              <div className="fn-mobile__drawer-title">{t('aiPanel.title')}</div>
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
                onMove={handleAiMove}
              />
            </div>
          </div>
        )}

        {settingsOpen && (
          <MobileSettings
            t={t}
            locale={locale}
            settings={aiSettings}
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
  onSaveSettings: (settings: AiSettings) => Promise<void>;
  onChangeLocale: (locale: Locale) => void;
  onClose: () => void;
}

function MobileSettings({ t, locale, settings, onSaveSettings, onChangeLocale, onClose }: MobileSettingsProps) {
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
