import type {
  UserSession,
  ChatPeer,
  ChatMessage,
  IMSessionState,
  TabGroupState,
  ShortcutAction,
  ShortcutBindings,
} from "@fastnote/shared";
import { DEFAULT_SHORTCUTS } from "@fastnote/shared";
import { translate, type Locale } from "@fastnote/i18n";

export interface RegisterResponse {
  user_id: string;
  device_id: string;
  token: string;
}

export interface SyncNoteItem {
  note_id: string;
  ciphertext: string;
  version: number;
  content_hash: string;
  deleted: boolean;
  updated_at: string;
}

export interface SyncAttachmentItem {
  attachment_id: string;
  note_id: string;
  meta_ciphertext: string;
  data_ciphertext: string;
  version: number;
  deleted: boolean;
  updated_at: string;
}

export interface SyncChatMessageItem {
  message_id: string;
  peer_id: string;
  direction: 'in' | 'out';
  sent_at: string;
  ciphertext: string;
}

export class ApiClient {
  constructor(private baseUrl: string, private locale: Locale = "zh") {}

  private t(key: string, vars?: Record<string, string | number>): string {
    return translate(this.locale, key, vars);
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  async register(
    username: string,
    passwordProof: string,
    keys?: { identity_pubkey: string; exchange_pubkey: string },
    vaultSalt?: string,
  ): Promise<UserSession> {
    const res = await fetch(this.url("/api/v1/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password_proof: passwordProof,
        identity_pubkey: keys?.identity_pubkey,
        exchange_pubkey: keys?.exchange_pubkey,
        vault_salt: vaultSalt,
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        err.error === "username taken" ? this.t("apiClient.usernameTaken") : this.t("apiClient.registerFailed"),
      );
    }
    const data = (await res.json()) as RegisterResponse;
    return {
      userId: data.user_id,
      deviceId: data.device_id,
      token: data.token,
      username,
    };
  }

  async login(username: string, passwordProof: string): Promise<UserSession> {
    const res = await fetch(this.url("/api/v1/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password_proof: passwordProof }),
    });
    if (!res.ok) throw new Error(this.t("apiClient.loginFailed"));
    const data = (await res.json()) as RegisterResponse;
    return {
      userId: data.user_id,
      deviceId: data.device_id,
      token: data.token,
      username,
    };
  }

  async getVaultSalt(username: string): Promise<string | null> {
    const info = await this.getVaultSaltInfo(username);
    return info.status === "ok" ? info.vault_salt : null;
  }

  async getVaultSaltInfo(
    username: string,
  ): Promise<
    | { status: "ok"; vault_salt: string }
    | { status: "user_not_found" }
    | { status: "vault_salt_missing" }
  > {
    const res = await fetch(
      this.url(`/api/v1/vault-salt?username=${encodeURIComponent(username)}`),
    );
    if (res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (body.error === "vault_salt_missing")
        return { status: "vault_salt_missing" };
      return { status: "user_not_found" };
    }
    if (!res.ok) throw new Error(this.t("apiClient.vaultLookupFailed"));
    const data = (await res.json()) as { vault_salt?: string };
    if (!data.vault_salt) return { status: "vault_salt_missing" };
    return { status: "ok", vault_salt: data.vault_salt };
  }

  async uploadVaultSalt(token: string, vaultSalt: string): Promise<void> {
    const res = await fetch(this.url("/api/v1/vault-salt"), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ vault_salt: vaultSalt }),
    });
    if (!res.ok) throw new Error(this.t("apiClient.vaultSaltUploadFailed"));
  }

  async updateKeys(
    token: string,
    identityPub: string,
    exchangePub: string,
  ): Promise<void> {
    const res = await fetch(this.url("/api/v1/keys"), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        identity_pubkey: identityPub,
        exchange_pubkey: exchangePub,
      }),
    });
    if (!res.ok) throw new Error(this.t("apiClient.keysUploadFailed"));
  }

  async lookupUser(token: string, username: string): Promise<ChatPeer> {
    const res = await fetch(
      this.url(`/api/v1/users/lookup?username=${encodeURIComponent(username)}`),
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!res.ok) throw new Error(this.t("apiClient.userNotFound"));
    const data = (await res.json()) as {
      user_id: string;
      username: string;
      exchange_pubkey: string;
    };
    return {
      userId: data.user_id,
      username: data.username,
      exchangePubkey: data.exchange_pubkey,
    };
  }

  async lookupUserById(token: string, userId: string): Promise<ChatPeer> {
    const res = await fetch(
      this.url(`/api/v1/users/${encodeURIComponent(userId)}`),
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!res.ok) throw new Error(this.t("apiClient.userNotFound"));
    const data = (await res.json()) as {
      user_id: string;
      username: string;
      exchange_pubkey: string;
    };
    return {
      userId: data.user_id,
      username: data.username,
      exchangePubkey: data.exchange_pubkey,
    };
  }

  async pushNote(
    token: string,
    noteId: string,
    body: { ciphertext: string; version: number; content_hash: string },
  ): Promise<{ conflict?: boolean; serverVersion?: number }> {
    const res = await fetch(this.url(`/api/v1/sync/notes/${noteId}`), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      const data = (await res.json()) as { server_version: number };
      return { conflict: true, serverVersion: data.server_version };
    }
    if (!res.ok) throw new Error(this.t("apiClient.syncPushFailed"));
    return {};
  }

  async pullNotes(token: string): Promise<SyncNoteItem[]> {
    const res = await fetch(this.url("/api/v1/sync/notes"), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(this.t("apiClient.syncPullFailed"));
    const data = (await res.json()) as { items: SyncNoteItem[] };
    return data.items;
  }

  async pushAttachment(
    token: string,
    attachmentId: string,
    body: {
      note_id: string;
      meta_ciphertext: string;
      data_ciphertext: string;
      version: number;
      deleted: boolean;
    },
  ): Promise<{ conflict?: boolean; serverVersion?: number }> {
    const res = await fetch(
      this.url(`/api/v1/sync/attachments/${attachmentId}`),
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    );
    if (res.status === 409) {
      const data = (await res.json()) as { server_version: number };
      return { conflict: true, serverVersion: data.server_version };
    }
    if (!res.ok) throw new Error(this.t("apiClient.attachmentPushFailed"));
    return {};
  }

  async pullAttachments(token: string): Promise<SyncAttachmentItem[]> {
    const res = await fetch(this.url("/api/v1/sync/attachments"), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(this.t("apiClient.attachmentPullFailed"));
    const data = (await res.json()) as { items: SyncAttachmentItem[] };
    return data.items;
  }

  async pushChatMessage(
    token: string,
    messageId: string,
    body: { peer_id: string; direction: "in" | "out"; sent_at: string; ciphertext: string },
  ): Promise<void> {
    const res = await fetch(this.url(`/api/v1/sync/chat/${messageId}`), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(this.t("apiClient.syncPushFailed"));
  }

  async pullChatMessages(token: string): Promise<SyncChatMessageItem[]> {
    const res = await fetch(this.url("/api/v1/sync/chat"), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(this.t("apiClient.syncPullFailed"));
    const data = (await res.json()) as { items: SyncChatMessageItem[] };
    return data.items;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(this.url("/health"));
      return res.ok;
    } catch {
      return false;
    }
  }
}

const SERVER_URL_KEY = "fastnote_server_url";
const SESSION_KEY = "fastnote_session";
const CHAT_MSG_KEY = "fastnote_chat_messages";
const CHAT_SESSIONS_KEY = "fastnote_chat_sessions";
const CHAT_SESSIONS_VERSION_KEY = "fastnote_chat_sessions_version";
const CHAT_SESSIONS_VERSION = 3;
const STORAGE_NAMESPACE_KEY = "fastnote_storage_namespace";
const STORAGE_PATH_LABEL_KEY = "fastnote_storage_path_label";
const VAULT_REGISTRY_KEY = "fastnote_vault_registry";

export interface VaultRegistryEntry {
  id: string;
  namespace: string;
  label: string;
  createdAt: string;
}

function sessionStorageKey(namespace?: string): string {
  const ns = sanitizeStorageNamespace(namespace ?? loadStorageNamespace());
  return ns === "default" ? SESSION_KEY : `${SESSION_KEY}_${ns}`;
}

export function loadVaultRegistry(): VaultRegistryEntry[] {
  const raw = localStorage.getItem(VAULT_REGISTRY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as VaultRegistryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveVaultRegistry(entries: VaultRegistryEntry[]): void {
  localStorage.setItem(VAULT_REGISTRY_KEY, JSON.stringify(entries));
}

export function createVaultRegistryEntry(
  label: string,
  locale: Locale = "zh",
): VaultRegistryEntry {
  const id = crypto.randomUUID();
  return {
    id,
    namespace: `vault-${id.slice(0, 8)}`,
    label: label.trim() || translate(locale, "apiClient.defaultVaultLabel"),
    createdAt: new Date().toISOString(),
  };
}

/** Ensure at least one registry entry exists (migrates legacy single-vault installs). */
export function ensureLegacyVaultInRegistry(locale: Locale = "zh"): VaultRegistryEntry[] {
  const existing = loadVaultRegistry();
  if (existing.length > 0) return existing;
  const ns = loadStorageNamespace();
  const entry: VaultRegistryEntry = {
    id: crypto.randomUUID(),
    namespace: ns,
    label: ns === "default" ? translate(locale, "apiClient.defaultLegacyVaultLabel") : ns,
    createdAt: new Date().toISOString(),
  };
  saveVaultRegistry([entry]);
  return [entry];
}

function sanitizeStorageNamespace(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "default";
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
}

export function loadStorageNamespace(): string {
  return sanitizeStorageNamespace(
    localStorage.getItem(STORAGE_NAMESPACE_KEY) ?? "default",
  );
}

export function saveStorageNamespace(namespace: string): void {
  localStorage.setItem(
    STORAGE_NAMESPACE_KEY,
    sanitizeStorageNamespace(namespace),
  );
}

export function loadStoragePathLabel(): string {
  return localStorage.getItem(STORAGE_PATH_LABEL_KEY) ?? "";
}

export function saveStoragePathLabel(label: string): void {
  localStorage.setItem(STORAGE_PATH_LABEL_KEY, label);
}

/** Map a filesystem path to a stable IndexedDB namespace (desktop multi-vault). */
export function namespaceFromPath(dir: string): string {
  const trimmed = dir.trim();
  if (!trimmed) return "default";
  return sanitizeStorageNamespace(trimmed.replace(/^~(?=\/)/, "home"));
}

export function storageDbName(namespace?: string): string {
  const ns = sanitizeStorageNamespace(namespace ?? loadStorageNamespace());
  return ns === "default" ? "fastnote-vault" : `fastnote-vault-${ns}`;
}

export function loadServerUrl(): string {
  return localStorage.getItem(SERVER_URL_KEY) ?? "http://localhost:8787";
}

export function saveServerUrl(url: string): void {
  localStorage.setItem(SERVER_URL_KEY, url);
}

export function loadSession(namespace?: string): UserSession | null {
  const raw = localStorage.getItem(sessionStorageKey(namespace));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserSession;
  } catch {
    return null;
  }
}

export function saveSession(
  session: UserSession | null,
  namespace?: string,
): void {
  const key = sessionStorageKey(namespace);
  if (session) localStorage.setItem(key, JSON.stringify(session));
  else localStorage.removeItem(key);
}

export function loadChatMessages(): ChatMessage[] {
  const raw = localStorage.getItem(CHAT_MSG_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ChatMessage[];
  } catch {
    return [];
  }
}

export function saveChatMessages(messages: ChatMessage[]): void {
  localStorage.setItem(CHAT_MSG_KEY, JSON.stringify(messages));
}

export function loadChatSessions(namespace?: string): IMSessionState[] {
  const versionKey = chatSessionsVersionKey(namespace);
  const storedVersion = Number(localStorage.getItem(versionKey) ?? "0");
  if (storedVersion !== CHAT_SESSIONS_VERSION) {
    localStorage.removeItem(chatSessionsKey(namespace));
    localStorage.setItem(versionKey, String(CHAT_SESSIONS_VERSION));
    return [];
  }
  const raw = localStorage.getItem(chatSessionsKey(namespace));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as IMSessionState[];
  } catch {
    return [];
  }
}

export function saveChatSessions(
  sessions: IMSessionState[],
  namespace?: string,
): void {
  localStorage.setItem(chatSessionsKey(namespace), JSON.stringify(sessions));
  localStorage.setItem(
    chatSessionsVersionKey(namespace),
    String(CHAT_SESSIONS_VERSION),
  );
}

export type ChatSoundId = "chime" | "bell" | "pop" | "soft";

export const CHAT_SOUND_IDS: ChatSoundId[] = ["chime", "bell", "pop", "soft"];

export interface ChatNotificationSettings {
  bubble: boolean;
  sound: boolean;
  soundId: ChatSoundId;
  volume: number;
}

const CHAT_NOTIFY_KEY = "fastnote_chat_notify";
const DEFAULT_CHAT_NOTIFY: ChatNotificationSettings = {
  bubble: true,
  sound: true,
  soundId: "chime",
  volume: 0.6,
};

function isChatSoundId(value: unknown): value is ChatSoundId {
  return typeof value === "string" && (CHAT_SOUND_IDS as string[]).includes(value);
}

export function loadChatNotificationSettings(): ChatNotificationSettings {
  try {
    const raw = localStorage.getItem(CHAT_NOTIFY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ChatNotificationSettings>;
      return {
        bubble: parsed.bubble !== false,
        sound: parsed.sound !== false,
        soundId: isChatSoundId(parsed.soundId) ? parsed.soundId : DEFAULT_CHAT_NOTIFY.soundId,
        volume:
          typeof parsed.volume === "number" && parsed.volume >= 0 && parsed.volume <= 1
            ? parsed.volume
            : DEFAULT_CHAT_NOTIFY.volume,
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_CHAT_NOTIFY };
}

export function saveChatNotificationSettings(
  settings: ChatNotificationSettings,
): void {
  localStorage.setItem(CHAT_NOTIFY_KEY, JSON.stringify(settings));
}

export type UiThemeId = "warm" | "elegant" | "business" | "fresh";

export const UI_THEMES: UiThemeId[] = ["warm", "elegant", "business", "fresh"];

const UI_THEME_KEY = "fastnote_ui_theme";

export function loadUiTheme(): UiThemeId {
  const raw = localStorage.getItem(UI_THEME_KEY);
  return (UI_THEMES as string[]).includes(raw ?? "") ? (raw as UiThemeId) : "warm";
}

export function saveUiTheme(theme: UiThemeId): void {
  localStorage.setItem(UI_THEME_KEY, theme);
}

export const NOTE_WIDTH_MIN = 480;
export const NOTE_WIDTH_MAX = 1400;
export const NOTE_WIDTH_DEFAULT = 820;

const NOTE_WIDTH_KEY = "fastnote_note_width";

export function loadNoteWidth(): number {
  const raw = Number(localStorage.getItem(NOTE_WIDTH_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return NOTE_WIDTH_DEFAULT;
  return Math.min(NOTE_WIDTH_MAX, Math.max(NOTE_WIDTH_MIN, raw));
}

export function saveNoteWidth(width: number): void {
  const clamped = Math.min(NOTE_WIDTH_MAX, Math.max(NOTE_WIDTH_MIN, Math.round(width)));
  localStorage.setItem(NOTE_WIDTH_KEY, String(clamped));
}

const SIDEBAR_COLLAPSED_KEY = "fastnote_sidebar_collapsed";

export function loadSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
}

const SHOW_LINE_NUMBERS_KEY = "fastnote_show_line_numbers";

export function loadShowLineNumbers(): boolean {
  const raw = localStorage.getItem(SHOW_LINE_NUMBERS_KEY);
  return raw === null ? true : raw === "1";
}

export function saveShowLineNumbers(show: boolean): void {
  localStorage.setItem(SHOW_LINE_NUMBERS_KEY, show ? "1" : "0");
}

export const SIDEBAR_WIDTH_MIN = 180;
// Wide enough that long note/folder titles can be dragged fully into view instead of being
// truncated with an ellipsis.
export const SIDEBAR_WIDTH_MAX = 720;
export const SIDEBAR_WIDTH_DEFAULT = 280;

const SIDEBAR_WIDTH_KEY = "fastnote_sidebar_width";

export function loadSidebarWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, raw));
}

export function saveSidebarWidth(width: number): void {
  const clamped = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
}

export type TreeSortModeValue = "manual" | "name" | "modified";

const TREE_SORT_MODE_KEY = "fastnote_tree_sort_mode";

export function loadTreeSortMode(): TreeSortModeValue {
  const raw = localStorage.getItem(TREE_SORT_MODE_KEY);
  return raw === "name" || raw === "modified" ? raw : "manual";
}

export function saveTreeSortMode(mode: TreeSortModeValue): void {
  localStorage.setItem(TREE_SORT_MODE_KEY, mode);
}

function collapsedFolderIdsKey(namespace?: string): string {
  const ns = sanitizeStorageNamespace(namespace ?? loadStorageNamespace());
  return ns === "default"
    ? "fastnote_collapsed_folders"
    : `fastnote_collapsed_folders_${ns}`;
}

export function loadCollapsedFolderIds(namespace?: string): Set<string> {
  try {
    const raw = localStorage.getItem(collapsedFolderIdsKey(namespace));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedFolderIds(ids: Set<string>, namespace?: string): void {
  const key = collapsedFolderIdsKey(namespace);
  if (ids.size === 0) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(Array.from(ids)));
}

export interface TabState {
  groups: TabGroupState[];
  activeGroupId: string;
}

export function defaultTabState(): TabState {
  return { groups: [{ id: "g1", tabs: [], activeTabId: null }], activeGroupId: "g1" };
}

function tabStateKey(namespace?: string): string {
  const ns = sanitizeStorageNamespace(namespace ?? loadStorageNamespace());
  return ns === "default" ? "fastnote_tab_state" : `fastnote_tab_state_${ns}`;
}

function isValidTabState(value: unknown): value is TabState {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<TabState>;
  if (!Array.isArray(v.groups) || typeof v.activeGroupId !== "string") return false;
  return v.groups.every(
    (g) =>
      g &&
      typeof g.id === "string" &&
      Array.isArray(g.tabs) &&
      g.tabs.every((t) => t && typeof t.id === "string" && typeof t.pinned === "boolean") &&
      (g.activeTabId === null || typeof g.activeTabId === "string"),
  );
}

export function loadTabState(namespace?: string): TabState {
  try {
    const raw = localStorage.getItem(tabStateKey(namespace));
    if (!raw) return defaultTabState();
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidTabState(parsed) || parsed.groups.length === 0) return defaultTabState();
    return parsed;
  } catch {
    return defaultTabState();
  }
}

export function saveTabState(state: TabState, namespace?: string): void {
  localStorage.setItem(tabStateKey(namespace), JSON.stringify(state));
}

export const GROUP_SPLIT_RATIO_MIN = 0.15;
export const GROUP_SPLIT_RATIO_MAX = 0.85;
export const GROUP_SPLIT_RATIO_DEFAULT = 0.5;

const GROUP_SPLIT_RATIO_KEY = "fastnote_group_split_ratio";

export function loadGroupSplitRatio(): number {
  const raw = Number(localStorage.getItem(GROUP_SPLIT_RATIO_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return GROUP_SPLIT_RATIO_DEFAULT;
  return Math.min(GROUP_SPLIT_RATIO_MAX, Math.max(GROUP_SPLIT_RATIO_MIN, raw));
}

export function saveGroupSplitRatio(ratio: number): void {
  const clamped = Math.min(GROUP_SPLIT_RATIO_MAX, Math.max(GROUP_SPLIT_RATIO_MIN, ratio));
  localStorage.setItem(GROUP_SPLIT_RATIO_KEY, String(clamped));
}

const SHORTCUTS_KEY = "fastnote_shortcuts";

export function loadShortcuts(): ShortcutBindings {
  const merged: ShortcutBindings = { ...DEFAULT_SHORTCUTS };
  try {
    const raw = localStorage.getItem(SHORTCUTS_KEY);
    if (!raw) return merged;
    const parsed = JSON.parse(raw) as Partial<Record<ShortcutAction, { key?: unknown; ctrl?: unknown; shift?: unknown; alt?: unknown }>>;
    (Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]).forEach((action) => {
      const b = parsed[action];
      if (b && typeof b.key === "string" && b.key) {
        merged[action] = { key: b.key, ctrl: !!b.ctrl, shift: !!b.shift, alt: !!b.alt };
      }
    });
    return merged;
  } catch {
    return merged;
  }
}

export function saveShortcuts(bindings: ShortcutBindings): void {
  localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(bindings));
}

function chatUnreadKey(namespace?: string): string {
  const ns = sanitizeStorageNamespace(namespace ?? loadStorageNamespace());
  return ns === "default"
    ? "fastnote_chat_unread"
    : `fastnote_chat_unread_${ns}`;
}

export function loadChatUnread(namespace?: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(chatUnreadKey(namespace));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, n]) => typeof n === "number" && n > 0),
    );
  } catch {
    return {};
  }
}

export function saveChatUnread(
  counts: Record<string, number>,
  namespace?: string,
): void {
  const cleaned = Object.fromEntries(
    Object.entries(counts).filter(([, n]) => typeof n === "number" && n > 0),
  );
  const key = chatUnreadKey(namespace);
  if (Object.keys(cleaned).length === 0) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(cleaned));
}

function chatSessionsKey(namespace?: string): string {
  const ns = sanitizeStorageNamespace(namespace ?? loadStorageNamespace());
  return ns === "default" ? CHAT_SESSIONS_KEY : `${CHAT_SESSIONS_KEY}_${ns}`;
}

function chatSessionsVersionKey(namespace?: string): string {
  const ns = sanitizeStorageNamespace(namespace ?? loadStorageNamespace());
  return ns === "default"
    ? CHAT_SESSIONS_VERSION_KEY
    : `${CHAT_SESSIONS_VERSION_KEY}_${ns}`;
}

export function createApiClient(locale: Locale = "zh"): ApiClient {
  return new ApiClient(loadServerUrl(), locale);
}
