export type NodeType = 'folder' | 'note' | 'table';

export type SyncStatus = 'synced' | 'pending' | 'conflict';

export interface NoteNode {
  id: string;
  parentId: string | null;
  nodeType: NodeType;
  title: string;
  contentMd: string;
  sortOrder: number;
  version: number;
  serverVersion: number;
  contentHash: string;
  syncStatus: SyncStatus;
  deleted: boolean;
  /**
   * In the recycle bin: hidden from the tree/search/tabs but fully recoverable (content intact,
   * unlike `deleted`, which is a cleared sync tombstone). Syncs like any other edit.
   */
  trashed?: boolean;
  updatedAt: string;
}

export interface TreeItem {
  node: NoteNode;
  children: TreeItem[];
}

export interface UserSession {
  userId: string;
  deviceId: string;
  token: string;
  username: string;
}

export interface ServerConfig {
  baseUrl: string;
}

export interface SyncNotePayload {
  title: string;
  content_md: string;
  parent_id: string | null;
  node_type: NodeType;
  sort_order: number;
  deleted: boolean;
  /** Recycle-bin flag; optional so blobs from older clients decode as "not trashed". */
  trashed?: boolean;
  updated_at: string;
}

/** Column-level numeric display format; raw cell values stay untouched. */
export interface TableColumnFormat {
  kind: 'number' | 'currency' | 'percent';
  /** Fixed number of decimal places (0-6). */
  decimals: number;
  /** Currency prefix symbol (only used when kind is 'currency'). */
  symbol?: string;
}

export interface TableColumn {
  id: string;
  name: string;
  /** Column width in px; unset means auto. */
  width?: number;
  /** Numeric display format; unset means show raw values. */
  format?: TableColumnFormat;
  /** Presentation of the header name cell (currently align/valign); unset means defaults. */
  headerStyle?: TableCellStyle;
  /** Default style for every cell in the column (per-cell and row-level styles win). */
  cellStyle?: TableCellStyle;
}

/** Per-cell presentation overrides; absent keys mean "default". */
export interface TableCellStyle {
  bold?: boolean;
  /** Font size in px. */
  fontSize?: number;
  /** Text color, CSS color string. */
  color?: string;
  /** Cell background fill, CSS color string. */
  fill?: string;
  /** Horizontal text alignment; unset means the default (left, right for formulas). */
  align?: 'left' | 'center' | 'right';
  /** Vertical alignment of the cell content; unset means the default (middle). */
  valign?: 'top' | 'middle' | 'bottom';
}

export interface TableRow {
  id: string;
  cells: Record<string, string>;
  /** Row height in px; unset means auto. */
  height?: number;
  /** Cell styles keyed by column id (parallel to `cells`). */
  styles?: Record<string, TableCellStyle>;
  /** Default style for every cell in the row (per-cell styles win; row beats column). */
  style?: TableCellStyle;
}

export interface TableDocument {
  version: 1;
  columns: TableColumn[];
  rows: TableRow[];
  /** Excel-style freeze: keeps the first data column visible while scrolling horizontally. */
  freezeFirstColumn?: boolean;
}

export interface ChatAttachmentRef {
  id: string;
  fileName: string;
  description: string;
  mimeType: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  peerId: string;
  peerUsername?: string;
  direction: 'in' | 'out';
  body: string;
  attachments?: ChatAttachmentRef[];
  sentAt: string;
  status: 'sent' | 'delivered' | 'read';
}

export interface ChatPeer {
  userId: string;
  username: string;
  exchangePubkey: string;
}

export interface IMSessionState {
  peerId: string;
  peerUsername: string;
  peerExchangePubkey: string;
  sendCounter: number;
  recvCounter: number;
  rootKey: string;
}

export const APP_NAME = 'FastNote';
export const TABLE_FILE_MAGIC = 'FNXT';
export const TABLE_FILE_VERSION = 1;

export const META_KEYS = {
  salt: 'salt',
  passwordVerifier: 'password_verifier',
  wrappedIdentityKey: 'wrapped_identity_key',
  wrappedExchangeKey: 'wrapped_exchange_key',
  identityPubkey: 'identity_pubkey',
  exchangePubkey: 'exchange_pubkey',
  searchIndexSnapshot: 'search_index_snapshot',
  searchIndexFingerprint: 'search_index_fingerprint',
  chatSessions: 'chat_sessions',
  chatStorageMigrated: 'chat_storage_migrated',
  boundUsername: 'bound_username',
  /** Encrypted JSON `{apiKey, model}` for the AI Workbench, per vault. */
  aiSettings: 'ai_settings',
} as const;

// ---------------------------------------------------------------------------
// AI Workbench
// ---------------------------------------------------------------------------

export const AI_MAX_TOKENS_MIN = 1024;
export const AI_MAX_TOKENS_LIMIT = 128000;
/** Roomy default: reasoning models spend part of the budget on hidden thinking. */
export const AI_MAX_TOKENS_DEFAULT = 16384;

/** Bounds for the per-reply web search budget (each search adds latency and token cost). */
export const AI_WEB_SEARCH_USES_MIN = 1;
export const AI_WEB_SEARCH_USES_LIMIT = 50;
export const AI_WEB_SEARCH_USES_DEFAULT = 5;

/** Per-vault AI Workbench settings, stored encrypted in vault_meta. */
export interface AiSettings {
  apiKey: string;
  model: string;
  /** Per-reply output token budget; unset falls back to AI_MAX_TOKENS_DEFAULT. */
  maxTokens?: number;
  /** Lets the model run Anthropic's server-side web search during a reply (off by default). */
  webSearch?: boolean;
  /** Max web searches per reply; unset falls back to AI_WEB_SEARCH_USES_DEFAULT. */
  webSearchMaxUses?: number;
}

/**
 * An attachment on an AI request message. Images and PDFs are sent to the API as native
 * base64 content blocks; everything else (txt/md/csv/doc/docx/...) is converted to extracted
 * plain text at attach time and inlined as a text block.
 */
export interface AiAttachment {
  id: string;
  name: string;
  mediaType: string;
  kind: 'image' | 'pdf' | 'text';
  /** Base64 payload for image/pdf kinds. */
  dataBase64?: string;
  /** Extracted plain text for the text kind. */
  text?: string;
  /** Original file size in bytes. */
  size: number;
}

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
  /** ISO timestamp: send time for user messages, receive-complete time for assistant ones. */
  ts: string;
  /** Assistant messages only: when the first streamed content (text or thinking) arrived. */
  startedTs?: string;
  /** Attachments (user messages only). */
  attachments?: AiAttachment[];
}

export type AiSessionKind = 'folder' | 'session';

/** A node of the AI session tree (folders organize sessions). */
export interface AiSessionNode {
  id: string;
  parentId: string | null;
  kind: AiSessionKind;
  title: string;
  /** Full conversation history; always empty for folders. */
  messages: AiMessage[];
  sortOrder: number;
  /** In the recycle bin: hidden from the tree but recoverable; syncs like any other edit. */
  trashed?: boolean;
  updatedAt: string;
}

export const HKDF_INFO = {
  notes: 'fastnote-notes-v1',
  index: 'fastnote-index-v1',
  vault: 'fastnote-vault-v1',
  im: 'fastnote-im-v1',
} as const;

export type EditorMode = 'wysiwyg' | 'source';

export interface OpenTab {
  id: string;
  pinned: boolean;
}

export interface TabGroupState {
  id: string;
  tabs: OpenTab[];
  activeTabId: string | null;
}

export interface NoteAttachment {
  id: string;
  noteId: string;
  fileName: string;
  description: string;
  mimeType: string;
  size: number;
  updatedAt: string;
  version: number;
  serverVersion: number;
  syncStatus: SyncStatus;
  deleted: boolean;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function downloadBlob(filename: string, data: Uint8Array, mimeType: string): void {
  const bytes = new Uint8Array(data);
  const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export {
  FNATTACH_SCHEME,
  attachmentDisplayLabel,
  buildAttachmentMarkdownRef,
  parseAttachmentIdFromHref,
  expandAttachmentRefsForExport,
  extractAttachmentIdsFromText,
  splitTextWithAttachmentRefs,
  segmentsToMarkdown,
  type ContentSegment,
  type AttachmentRefMeta,
} from './attachmentRefs';

export {
  markdownWithAttachmentHtml,
  ensureAttachmentRefsInMarkdown,
  attachmentRefFromAnchor,
} from './markdownAttachments';

export {
  encodeChatWire,
  decodeChatWire,
  toStoredPayload,
  storedToChatMessage,
  type ChatWirePayload,
  type ChatWireAttachment,
  type ChatStoredPayload,
} from './chatPayload';

export { buildContentSecurityPolicy, serverUrlNeedsReload } from './csp';
export {
  installConsoleCapture,
  getCapturedLogs,
  clearCapturedLogs,
  formatCapturedLogs,
} from './logBuffer';
export type { LogEntry, LogLevel } from './logBuffer';

export { normalizeLatexDelimiters, extractMathSegments } from './latexDelimiters';
export type { MathSegment } from './latexDelimiters';

export function buildTree(notes: NoteNode[], parentId: string | null = null): TreeItem[] {
  const live = notes.filter((n) => !n.deleted);
  // Orphans (parentId pointing at a node that no longer exists — e.g. the parent was deleted on
  // another device before this child synced) are adopted at the root level: otherwise they stay
  // invisible in the sidebar forever while still existing in storage and search results.
  const liveIds = new Set(live.map((n) => n.id));
  const isChildOf = (n: NoteNode, pid: string | null): boolean =>
    pid === null ? n.parentId === null || !liveIds.has(n.parentId) : n.parentId === pid;
  const level = (pid: string | null): TreeItem[] =>
    live
      .filter((n) => isChildOf(n, pid))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title))
      .map((node) => ({
        node,
        children: level(node.id),
      }));
  return level(parentId);
}

export function isDescendantOf(notes: NoteNode[], ancestorId: string, nodeId: string): boolean {
  let current = notes.find((n) => n.id === nodeId);
  while (current?.parentId) {
    if (current.parentId === ancestorId) return true;
    current = notes.find((n) => n.id === current!.parentId);
  }
  return false;
}

export type TreeDropPosition = 'before' | 'after' | 'inside' | 'root';

export function computeTreeMove(
  notes: NoteNode[],
  dragId: string,
  targetId: string | null,
  position: TreeDropPosition,
): NoteNode[] | null {
  const dragged = notes.find((n) => n.id === dragId && !n.deleted);
  if (!dragged) return null;

  const oldParentId = dragged.parentId;
  let newParentId: string | null;
  let insertAt: number;

  if (position === 'root') {
    newParentId = null;
    const siblings = notes
      .filter((n) => n.parentId === null && !n.deleted && n.id !== dragId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    insertAt = siblings.length;
  } else if (!targetId) {
    return null;
  } else {
    const target = notes.find((n) => n.id === targetId && !n.deleted);
    if (!target || target.id === dragId) return null;
    if (isDescendantOf(notes, dragId, target.id)) return null;

    if (position === 'inside' && target.nodeType === 'folder') {
      newParentId = target.id;
      const siblings = notes
        .filter((n) => n.parentId === newParentId && !n.deleted && n.id !== dragId)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      insertAt = siblings.length;
    } else {
      newParentId = target.parentId;
      const siblings = notes
        .filter((n) => n.parentId === newParentId && !n.deleted && n.id !== dragId)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const targetIdx = siblings.findIndex((s) => s.id === target.id);
      if (targetIdx === -1) return null;
      insertAt = position === 'before' ? targetIdx : targetIdx + 1;
    }
  }

  if (newParentId !== null) {
    const parent = notes.find((n) => n.id === newParentId);
    if (!parent || parent.nodeType !== 'folder') return null;
  }

  const newSiblings = notes
    .filter((n) => n.parentId === newParentId && !n.deleted && n.id !== dragId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const newOrder = newSiblings.map((s) => s.id);
  newOrder.splice(Math.min(insertAt, newOrder.length), 0, dragId);

  const oldSiblings =
    oldParentId !== newParentId
      ? notes
          .filter((n) => n.parentId === oldParentId && !n.deleted && n.id !== dragId)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((s) => s.id)
      : null;

  const now = new Date().toISOString();
  let changed = false;
  const result = notes.map((n) => ({ ...n }));

  const applyOrder = (parentId: string | null, ids: string[]) => {
    ids.forEach((id, index) => {
      const idx = result.findIndex((n) => n.id === id);
      if (idx === -1) return;
      const node = result[idx];
      if (node.parentId !== parentId || node.sortOrder !== index) {
        result[idx] = {
          ...node,
          parentId,
          sortOrder: index,
          version: node.version + 1,
          syncStatus: 'pending',
          updatedAt: now,
        };
        changed = true;
      }
    });
  };

  applyOrder(newParentId, newOrder);
  if (oldSiblings) applyOrder(oldParentId, oldSiblings);

  return changed ? result : null;
}

export function countChildren(notes: NoteNode[], folderId: string): number {
  return notes.filter((n) => n.parentId === folderId && !n.deleted).length;
}

export type TreeSortMode = 'manual' | 'name' | 'modified';

/**
 * Recomputes and persists sortOrder for every folder's children according to
 * the given mode (name ascending, or modified time descending). Manual drag
 * order is left untouched until the user picks a non-manual mode again.
 */
export function applySortMode(notes: NoteNode[], mode: Exclude<TreeSortMode, 'manual'>): NoteNode[] {
  const parentIds = new Set<string | null>();
  notes.forEach((n) => {
    if (!n.deleted) parentIds.add(n.parentId);
  });

  let changed = false;
  const result = notes.map((n) => ({ ...n }));

  parentIds.forEach((parentId) => {
    const siblings = result
      .filter((n) => n.parentId === parentId && !n.deleted)
      .sort((a, b) => {
        if (mode === 'name') return a.title.localeCompare(b.title);
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
    siblings.forEach((node, index) => {
      const idx = result.findIndex((n) => n.id === node.id);
      if (idx !== -1 && result[idx].sortOrder !== index) {
        result[idx] = {
          ...result[idx],
          sortOrder: index,
          version: result[idx].version + 1,
          syncStatus: 'pending',
        };
        changed = true;
      }
    });
  });

  return changed ? result : notes;
}

export type ShortcutAction =
  | 'renameNote'
  | 'lockVault'
  | 'tableRepeatAction'
  | 'tableUndo'
  | 'tableRedo'
  | 'deleteSelected'
  | 'findInNote'
  | 'focusPrev'
  | 'focusNext';

export interface ShortcutBinding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type ShortcutBindings = Record<ShortcutAction, ShortcutBinding>;

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  renameNote: { key: 'F2' },
  lockVault: { key: 'l', ctrl: true },
  tableRepeatAction: { key: 'F4' },
  tableUndo: { key: 'z', ctrl: true },
  tableRedo: { key: 'y', ctrl: true },
  deleteSelected: { key: 'Delete' },
  findInNote: { key: 'f', ctrl: true },
  focusPrev: { key: 'ArrowLeft', ctrl: true, alt: true },
  focusNext: { key: 'ArrowRight', ctrl: true, alt: true },
};

interface ShortcutKeyEventLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** `ctrl` in a binding matches either Ctrl (Win/Linux) or Cmd (macOS). */
export function matchesShortcut(e: ShortcutKeyEventLike, binding: ShortcutBinding | undefined): boolean {
  if (!binding) return false;
  if (e.key.toLowerCase() !== binding.key.toLowerCase()) return false;
  if (!!binding.ctrl !== (e.ctrlKey || e.metaKey)) return false;
  if (!!binding.shift !== e.shiftKey) return false;
  if (!!binding.alt !== e.altKey) return false;
  return true;
}

export function formatShortcutBinding(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts.join('+');
}

const IGNORED_SHORTCUT_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/** Builds a binding from a captured keydown event; returns null for bare modifier presses. */
export function shortcutBindingFromEvent(e: ShortcutKeyEventLike): ShortcutBinding | null {
  if (IGNORED_SHORTCUT_KEYS.has(e.key)) return null;
  return {
    key: e.key.length === 1 ? e.key.toUpperCase() : e.key,
    ctrl: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

// ---------------------------------------------------------------------------
// Note find & replace
// ---------------------------------------------------------------------------

/** `current` is 1-based; both are 0 when there are no matches. */
export interface FindReplaceStatus {
  total: number;
  current: number;
}

/**
 * Mode-specific search driver registered by the editor (CodeMirror in source mode, a ProseMirror
 * plugin in render mode) and driven by the shared FindReplaceBar UI.
 */
export interface FindReplaceController {
  search: (query: string) => FindReplaceStatus;
  next: () => FindReplaceStatus;
  prev: () => FindReplaceStatus;
  replace: (replacement: string) => FindReplaceStatus;
  /** Returns the number of replacements made. */
  replaceAll: (replacement: string) => number;
  /** Clears the query and any highlight decorations. */
  close: () => void;
}

export function isTableNode(node: NoteNode): boolean {
  return node.nodeType === 'table';
}

export function isEditableContentNode(node: NoteNode): boolean {
  return node.nodeType === 'note' || node.nodeType === 'table';
}
