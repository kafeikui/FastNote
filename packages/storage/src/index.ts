import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { NoteAttachment, NoteNode, ChatMessage, ChatAttachmentRef, ChatWireAttachment } from '@fastnote/shared';
import { META_KEYS } from '@fastnote/shared';
import type { ChatStoredPayload } from '@fastnote/shared';
import { storedToChatMessage } from '@fastnote/shared';
import type { SyncAttachmentItem, SyncChatMessageItem } from '@fastnote/api';
import { storageDbName } from '@fastnote/api';
import {
  decodeWireCiphertext,
  decrypt,
  decryptString,
  encodeWireCiphertext,
  encrypt,
  encryptString,
  fromBase64,
  toBase64,
  type EncryptedPayload,
} from '@fastnote/crypto';

const DB_VERSION = 4;

export interface StorageOptions {
  /** Logical vault namespace — maps to IndexedDB database name. */
  namespace?: string;
}

function resolveDbName(options?: StorageOptions): string {
  return storageDbName(options?.namespace);
}

interface StoredChatRow {
  id: string;
  peerId: string;
  direction: 'in' | 'out';
  payloadEnc: string;
  payloadNonce: string;
  sentAt: string;
  /** Already pushed to the cloud-sync chat blob store — undefined/false on
   * rows created before this field existed, which is exactly the "not yet
   * synced" default we want (they'll get pushed once on the next sync). */
  synced?: boolean;
}

interface StoredChatAttachment {
  id: string;
  messageId: string;
  peerId: string;
  metaEnc: string;
  metaNonce: string;
  dataEnc: string;
  dataNonce: string;
  updatedAt: string;
}

interface FastNoteDB extends DBSchema {
  vault_meta: { key: string; value: string };
  notes_local: { key: string; value: StoredNote };
  attachments_local: {
    key: string;
    value: StoredAttachment;
    indexes: { by_note: string };
  };
  chat_messages_local: {
    key: string;
    value: StoredChatRow;
    indexes: { by_peer: string };
  };
  chat_attachments_local: {
    key: string;
    value: StoredChatAttachment;
    indexes: { by_message: string };
  };
}

interface StoredNote {
  id: string;
  parentId: string | null;
  nodeType: 'folder' | 'note' | 'table';
  titleEnc: string;
  titleNonce: string;
  contentEnc: string;
  contentNonce: string;
  sortOrder: number;
  version: number;
  serverVersion: number;
  contentHash: string;
  syncStatus: 'synced' | 'pending' | 'conflict';
  deleted: number;
  updatedAt: string;
}

interface StoredAttachment {
  id: string;
  noteId: string;
  metaEnc: string;
  metaNonce: string;
  dataEnc: string;
  dataNonce: string;
  version: number;
  serverVersion: number;
  syncStatus: 'synced' | 'pending' | 'conflict';
  deleted: number;
  updatedAt: string;
}

interface AttachmentMetaPlain {
  fileName: string;
  description: string;
  mimeType: string;
  size: number;
}

export interface AttachmentWirePayload {
  noteId: string;
  metaWire: string;
  dataWire: string;
  version: number;
  deleted: boolean;
}

export interface ChatMessageWirePayload {
  peerId: string;
  direction: 'in' | 'out';
  sentAt: string;
  ciphertext: string;
}

export interface StorageAdapter {
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  listNotes(): Promise<NoteNode[]>;
  loadNoteDecrypted(id: string, notesKey: Uint8Array): Promise<NoteNode | null>;
  saveNote(note: NoteNode, notesKey: Uint8Array): Promise<void>;
  deleteNote(id: string): Promise<void>;
  listDeletedNoteStubs(): Promise<NoteNode[]>;
  purgeDeleted(): Promise<void>;
  listAttachments(noteId: string, notesKey: Uint8Array): Promise<NoteAttachment[]>;
  loadAttachmentDecrypted(
    id: string,
    notesKey: Uint8Array,
  ): Promise<{ meta: NoteAttachment; data: Uint8Array } | null>;
  saveAttachment(
    noteId: string,
    fileName: string,
    description: string,
    mimeType: string,
    data: Uint8Array,
    notesKey: Uint8Array,
  ): Promise<NoteAttachment>;
  updateAttachmentDescription(id: string, description: string, notesKey: Uint8Array): Promise<void>;
  deleteAttachment(id: string, notesKey: Uint8Array): Promise<void>;
  deleteAttachmentsByNote(noteId: string, notesKey: Uint8Array): Promise<void>;
  listPendingAttachments(): Promise<Array<{ id: string }>>;
  getAttachmentWire(id: string): Promise<AttachmentWirePayload | null>;
  markAttachmentSynced(id: string, serverVersion: number): Promise<void>;
  purgeAttachment(id: string): Promise<void>;
  getAttachmentServerVersion(id: string): Promise<number | null>;
  saveAttachmentFromRemote(item: SyncAttachmentItem): Promise<void>;
  listChatMessagesDecrypted(notesKey: Uint8Array): Promise<ChatMessage[]>;
  saveChatMessage(message: ChatMessage, notesKey: Uint8Array): Promise<void>;
  deleteChatMessage(id: string, notesKey: Uint8Array): Promise<void>;
  hasChatMessage(id: string): Promise<boolean>;
  listPendingChatMessages(): Promise<Array<{ id: string }>>;
  getChatMessageWire(id: string): Promise<ChatMessageWirePayload | null>;
  markChatMessageSynced(id: string): Promise<void>;
  saveChatMessageFromRemote(item: SyncChatMessageItem): Promise<void>;
  saveChatAttachmentFromWire(
    messageId: string,
    peerId: string,
    attachment: ChatWireAttachment,
    notesKey: Uint8Array,
  ): Promise<ChatAttachmentRef>;
  loadChatAttachmentDecrypted(
    id: string,
    notesKey: Uint8Array,
  ): Promise<{ meta: ChatAttachmentRef; data: Uint8Array } | null>;
  updateChatAttachmentDescription(id: string, description: string, notesKey: Uint8Array): Promise<void>;
  deleteChatAttachment(id: string): Promise<void>;
}

function pack(payload: EncryptedPayload): { enc: string; nonce: string } {
  return { enc: toBase64(payload.ciphertext), nonce: toBase64(payload.nonce) };
}

function unpack(enc: string, nonce: string): EncryptedPayload {
  return { ciphertext: fromBase64(enc), nonce: fromBase64(nonce) };
}

function wireFromRow(row: StoredAttachment): { metaWire: string; dataWire: string } {
  return {
    metaWire: encodeWireCiphertext(unpack(row.metaEnc, row.metaNonce)),
    dataWire: encodeWireCiphertext(unpack(row.dataEnc, row.dataNonce)),
  };
}

function rowFromWire(
  id: string,
  noteId: string,
  metaWire: string,
  dataWire: string,
  version: number,
  serverVersion: number,
  deleted: boolean,
  updatedAt: string,
): StoredAttachment {
  const meta = decodeWireCiphertext(metaWire);
  const data = decodeWireCiphertext(dataWire);
  const m = pack(meta);
  const d = pack(data);
  return {
    id,
    noteId,
    metaEnc: m.enc,
    metaNonce: m.nonce,
    dataEnc: d.enc,
    dataNonce: d.nonce,
    version,
    serverVersion,
    syncStatus: 'synced',
    deleted: deleted ? 1 : 0,
    updatedAt,
  };
}

function normalizeAttachmentRow(row: StoredAttachment): StoredAttachment {
  return {
    ...row,
    version: row.version ?? 1,
    serverVersion: row.serverVersion ?? 0,
    syncStatus: row.syncStatus ?? 'pending',
    deleted: row.deleted ?? 0,
  };
}

function toNodeStub(r: StoredNote): NoteNode {
  return {
    id: r.id,
    parentId: r.parentId,
    nodeType: r.nodeType,
    title: '',
    contentMd: '',
    sortOrder: r.sortOrder,
    version: r.version,
    serverVersion: r.serverVersion,
    contentHash: r.contentHash,
    syncStatus: r.syncStatus,
    deleted: r.deleted === 1,
    updatedAt: r.updatedAt,
  };
}

function toStoredRow(note: NoteNode, notesKey: Uint8Array): StoredNote {
  const title = encryptString(notesKey, note.title);
  const content = encryptString(notesKey, note.contentMd);
  const t = pack(title);
  const c = pack(content);
  return {
    id: note.id,
    parentId: note.parentId,
    nodeType: note.nodeType,
    titleEnc: t.enc,
    titleNonce: t.nonce,
    contentEnc: c.enc,
    contentNonce: c.nonce,
    sortOrder: note.sortOrder,
    version: note.version,
    serverVersion: note.serverVersion,
    contentHash: note.contentHash,
    syncStatus: note.syncStatus,
    deleted: note.deleted ? 1 : 0,
    updatedAt: note.updatedAt,
  };
}

function decryptAttachmentMeta(row: StoredAttachment, notesKey: Uint8Array): AttachmentMetaPlain {
  return JSON.parse(
    decryptString(notesKey, unpack(row.metaEnc, row.metaNonce)),
  ) as AttachmentMetaPlain;
}

function toAttachment(row: StoredAttachment, notesKey: Uint8Array): NoteAttachment {
  const r = normalizeAttachmentRow(row);
  const plain = decryptAttachmentMeta(r, notesKey);
  return {
    id: r.id,
    noteId: r.noteId,
    fileName: plain.fileName,
    description: plain.description,
    mimeType: plain.mimeType,
    size: plain.size,
    updatedAt: r.updatedAt,
    version: r.version,
    serverVersion: r.serverVersion,
    syncStatus: r.syncStatus,
    deleted: r.deleted === 1,
  };
}

export class WebStorageAdapter implements StorageAdapter {
  private db: IDBPDatabase<FastNoteDB> | null = null;
  private readonly dbName: string;

  constructor(options?: StorageOptions) {
    this.dbName = resolveDbName(options);
  }

  private async getDb(): Promise<IDBPDatabase<FastNoteDB>> {
    if (!this.db) {
      this.db = await openDB<FastNoteDB>(this.dbName, DB_VERSION, {
        upgrade(db, oldVersion) {
          if (oldVersion < 1) {
            db.createObjectStore('vault_meta');
            db.createObjectStore('notes_local', { keyPath: 'id' });
          }
          if (oldVersion < 2) {
            const store = db.createObjectStore('attachments_local', { keyPath: 'id' });
            store.createIndex('by_note', 'noteId');
          }
          if (oldVersion < 4) {
            const chatMsgs = db.createObjectStore('chat_messages_local', { keyPath: 'id' });
            chatMsgs.createIndex('by_peer', 'peerId');
            const chatAtt = db.createObjectStore('chat_attachments_local', { keyPath: 'id' });
            chatAtt.createIndex('by_message', 'messageId');
          }
        },
      });
    }
    return this.db;
  }

  async getMeta(key: string): Promise<string | undefined> {
    const db = await this.getDb();
    return db.get('vault_meta', key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    const db = await this.getDb();
    await db.put('vault_meta', value, key);
  }

  async listNotes(): Promise<NoteNode[]> {
    const db = await this.getDb();
    const rows = await db.getAll('notes_local');
    return rows.map((r) => toNodeStub(r));
  }

  async loadNoteDecrypted(id: string, notesKey: Uint8Array): Promise<NoteNode | null> {
    const db = await this.getDb();
    const r = await db.get('notes_local', id);
    if (!r) return null;
    const node = toNodeStub(r);
    node.title = decryptString(notesKey, unpack(r.titleEnc, r.titleNonce));
    node.contentMd = decryptString(notesKey, unpack(r.contentEnc, r.contentNonce));
    return node;
  }

  async saveNote(note: NoteNode, notesKey: Uint8Array): Promise<void> {
    const db = await this.getDb();
    await db.put('notes_local', toStoredRow(note, notesKey));
  }

  async deleteNote(id: string): Promise<void> {
    const db = await this.getDb();
    await db.delete('notes_local', id);
  }

  /** Tombstoned note rows (no decryption), for pushing deletions to the server. */
  async listDeletedNoteStubs(): Promise<NoteNode[]> {
    const db = await this.getDb();
    const rows = await db.getAll('notes_local');
    return rows.filter((r) => r.deleted === 1).map((r) => toNodeStub(r));
  }

  /**
   * Hard-deletes tombstoned note and attachment rows. Used for local-only vaults (no server to
   * propagate deletions to) and as cleanup after a sync has pushed the tombstones — leftover
   * tombstones otherwise accumulate forever and slow down unlock.
   */
  async purgeDeleted(): Promise<void> {
    const db = await this.getDb();
    const noteRows = await db.getAll('notes_local');
    for (const r of noteRows) {
      if (r.deleted === 1) await db.delete('notes_local', r.id);
    }
    const attRows = await db.getAll('attachments_local');
    for (const r of attRows) {
      if (normalizeAttachmentRow(r).deleted === 1) await db.delete('attachments_local', r.id);
    }
  }

  async listAttachments(noteId: string, notesKey: Uint8Array): Promise<NoteAttachment[]> {
    const db = await this.getDb();
    const rows = await db.getAllFromIndex('attachments_local', 'by_note', noteId);
    return rows
      .map((r) => normalizeAttachmentRow(r))
      .filter((r) => r.deleted === 0)
      .map((r) => toAttachment(r, notesKey));
  }

  async loadAttachmentDecrypted(
    id: string,
    notesKey: Uint8Array,
  ): Promise<{ meta: NoteAttachment; data: Uint8Array } | null> {
    const db = await this.getDb();
    const row = await db.get('attachments_local', id);
    if (!row || normalizeAttachmentRow(row).deleted === 1) return null;
    const meta = toAttachment(normalizeAttachmentRow(row), notesKey);
    const data = decrypt(notesKey, unpack(row.dataEnc, row.dataNonce));
    return { meta, data };
  }

  async saveAttachment(
    noteId: string,
    fileName: string,
    description: string,
    mimeType: string,
    data: Uint8Array,
    notesKey: Uint8Array,
  ): Promise<NoteAttachment> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const metaPlain: AttachmentMetaPlain = { fileName, description, mimeType, size: data.byteLength };
    const metaEnc = pack(encryptString(notesKey, JSON.stringify(metaPlain)));
    const dataEnc = pack(encrypt(notesKey, data));
    const row: StoredAttachment = {
      id,
      noteId,
      metaEnc: metaEnc.enc,
      metaNonce: metaEnc.nonce,
      dataEnc: dataEnc.enc,
      dataNonce: dataEnc.nonce,
      version: 1,
      serverVersion: 0,
      syncStatus: 'pending',
      deleted: 0,
      updatedAt: now,
    };
    const db = await this.getDb();
    await db.put('attachments_local', row);
    return toAttachment(row, notesKey);
  }

  async updateAttachmentDescription(id: string, description: string, notesKey: Uint8Array): Promise<void> {
    const db = await this.getDb();
    const row = await db.get('attachments_local', id);
    if (!row) return;
    const normalized = normalizeAttachmentRow(row);
    const plain = decryptAttachmentMeta(normalized, notesKey);
    plain.description = description;
    const metaEnc = pack(encryptString(notesKey, JSON.stringify(plain)));
    await db.put('attachments_local', {
      ...normalized,
      metaEnc: metaEnc.enc,
      metaNonce: metaEnc.nonce,
      version: normalized.version + 1,
      syncStatus: 'pending',
      updatedAt: new Date().toISOString(),
    });
  }

  async deleteAttachment(id: string, notesKey: Uint8Array): Promise<void> {
    const db = await this.getDb();
    const row = await db.get('attachments_local', id);
    if (!row) return;
    const normalized = normalizeAttachmentRow(row);
    await db.put('attachments_local', {
      ...normalized,
      deleted: 1,
      version: normalized.version + 1,
      syncStatus: 'pending',
      updatedAt: new Date().toISOString(),
    });
    void notesKey;
  }

  async deleteAttachmentsByNote(noteId: string, notesKey: Uint8Array): Promise<void> {
    const db = await this.getDb();
    const rows = await db.getAllFromIndex('attachments_local', 'by_note', noteId);
    const now = new Date().toISOString();
    await Promise.all(
      rows.map(async (r) => {
        const normalized = normalizeAttachmentRow(r);
        if (normalized.deleted === 1) return;
        await db.put('attachments_local', {
          ...normalized,
          deleted: 1,
          version: normalized.version + 1,
          syncStatus: 'pending',
          updatedAt: now,
        });
      }),
    );
    void notesKey;
  }

  async listPendingAttachments(): Promise<Array<{ id: string }>> {
    const db = await this.getDb();
    const rows = await db.getAll('attachments_local');
    return rows
      .map((r) => normalizeAttachmentRow(r))
      .filter((r) => r.syncStatus === 'pending')
      .map((r) => ({ id: r.id }));
  }

  async getAttachmentWire(id: string): Promise<AttachmentWirePayload | null> {
    const db = await this.getDb();
    const row = await db.get('attachments_local', id);
    if (!row) return null;
    const normalized = normalizeAttachmentRow(row);
    const { metaWire, dataWire } = wireFromRow(normalized);
    return {
      noteId: normalized.noteId,
      metaWire,
      dataWire,
      version: normalized.version,
      deleted: normalized.deleted === 1,
    };
  }

  async markAttachmentSynced(id: string, serverVersion: number): Promise<void> {
    const db = await this.getDb();
    const row = await db.get('attachments_local', id);
    if (!row) return;
    await db.put('attachments_local', {
      ...normalizeAttachmentRow(row),
      serverVersion,
      syncStatus: 'synced',
    });
  }

  async purgeAttachment(id: string): Promise<void> {
    const db = await this.getDb();
    await db.delete('attachments_local', id);
  }

  async getAttachmentServerVersion(id: string): Promise<number | null> {
    const db = await this.getDb();
    const row = await db.get('attachments_local', id);
    if (!row) return null;
    return normalizeAttachmentRow(row).serverVersion;
  }

  async saveAttachmentFromRemote(item: SyncAttachmentItem): Promise<void> {
    const db = await this.getDb();
    const row = rowFromWire(
      item.attachment_id,
      item.note_id,
      item.meta_ciphertext,
      item.data_ciphertext,
      item.version,
      item.version,
      item.deleted,
      item.updated_at,
    );
    await db.put('attachments_local', row);
  }

  async listChatMessagesDecrypted(notesKey: Uint8Array): Promise<ChatMessage[]> {
    const db = await this.getDb();
    const rows = await db.getAll('chat_messages_local');
    const messages = await Promise.all(
      rows.map(async (row) => {
        const stored = JSON.parse(
          decryptString(notesKey, unpack(row.payloadEnc, row.payloadNonce)),
        ) as ChatStoredPayload;
        let msg = storedToChatMessage(row.id, row.peerId, row.direction, row.sentAt, stored);
        if (!msg.attachments?.length) {
          const attRows = await db.getAllFromIndex('chat_attachments_local', 'by_message', row.id);
          if (attRows.length) {
            const attachments = attRows.map((attRow) => {
              const plain = JSON.parse(
                decryptString(notesKey, unpack(attRow.metaEnc, attRow.metaNonce)),
              ) as AttachmentMetaPlain;
              return {
                id: attRow.id,
                fileName: plain.fileName,
                description: plain.description,
                mimeType: plain.mimeType,
                size: plain.size,
              };
            });
            msg = { ...msg, attachments };
          }
        }
        return msg;
      }),
    );
    return messages.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }

  async saveChatMessage(message: ChatMessage, notesKey: Uint8Array): Promise<void> {
    const stored: ChatStoredPayload = {
      v: 1,
      body: message.body,
      peerUsername: message.peerUsername,
      attachments: message.attachments ?? [],
      status: message.status,
    };
    const enc = pack(encryptString(notesKey, JSON.stringify(stored)));
    const db = await this.getDb();
    // Preserve the existing `synced` flag (e.g. a status-only update like a
    // delivery/read ack shouldn't re-mark an already cloud-synced message as
    // pending — that would just get re-pushed as unchanged content forever).
    const existing = await db.get('chat_messages_local', message.id);
    await db.put('chat_messages_local', {
      id: message.id,
      peerId: message.peerId,
      direction: message.direction,
      payloadEnc: enc.enc,
      payloadNonce: enc.nonce,
      sentAt: message.sentAt,
      synced: existing?.synced ?? false,
    });
  }

  async deleteChatMessage(id: string, notesKey: Uint8Array): Promise<void> {
    const db = await this.getDb();
    const attRows = await db.getAllFromIndex('chat_attachments_local', 'by_message', id);
    await Promise.all(attRows.map((row) => db.delete('chat_attachments_local', row.id)));
    await db.delete('chat_messages_local', id);
    void notesKey;
  }

  async hasChatMessage(id: string): Promise<boolean> {
    const db = await this.getDb();
    return !!(await db.get('chat_messages_local', id));
  }

  async listPendingChatMessages(): Promise<Array<{ id: string }>> {
    const db = await this.getDb();
    const rows = await db.getAll('chat_messages_local');
    return rows.filter((r) => !r.synced).map((r) => ({ id: r.id }));
  }

  async getChatMessageWire(id: string): Promise<ChatMessageWirePayload | null> {
    const db = await this.getDb();
    const row = await db.get('chat_messages_local', id);
    if (!row) return null;
    return {
      peerId: row.peerId,
      direction: row.direction,
      sentAt: row.sentAt,
      ciphertext: encodeWireCiphertext(unpack(row.payloadEnc, row.payloadNonce)),
    };
  }

  async markChatMessageSynced(id: string): Promise<void> {
    const db = await this.getDb();
    const row = await db.get('chat_messages_local', id);
    if (!row) return;
    await db.put('chat_messages_local', { ...row, synced: true });
  }

  async saveChatMessageFromRemote(item: SyncChatMessageItem): Promise<void> {
    const db = await this.getDb();
    const { enc, nonce } = pack(decodeWireCiphertext(item.ciphertext));
    await db.put('chat_messages_local', {
      id: item.message_id,
      peerId: item.peer_id,
      direction: item.direction,
      payloadEnc: enc,
      payloadNonce: nonce,
      sentAt: item.sent_at,
      synced: true,
    });
  }

  async saveChatAttachmentFromWire(
    messageId: string,
    peerId: string,
    attachment: ChatWireAttachment,
    notesKey: Uint8Array,
  ): Promise<ChatAttachmentRef> {
    if (!attachment.dataB64) {
      throw new Error('附件数据缺失');
    }
    const data = fromBase64(attachment.dataB64);
    const id = attachment.id || crypto.randomUUID();
    const metaPlain: AttachmentMetaPlain = {
      fileName: attachment.fileName,
      description: attachment.description,
      mimeType: attachment.mimeType,
      size: data.byteLength,
    };
    const metaEnc = pack(encryptString(notesKey, JSON.stringify(metaPlain)));
    const dataEnc = pack(encrypt(notesKey, data));
    const row: StoredChatAttachment = {
      id,
      messageId,
      peerId,
      metaEnc: metaEnc.enc,
      metaNonce: metaEnc.nonce,
      dataEnc: dataEnc.enc,
      dataNonce: dataEnc.nonce,
      updatedAt: new Date().toISOString(),
    };
    const db = await this.getDb();
    await db.put('chat_attachments_local', row);
    return {
      id,
      fileName: metaPlain.fileName,
      description: metaPlain.description,
      mimeType: metaPlain.mimeType,
      size: metaPlain.size,
    };
  }

  async loadChatAttachmentDecrypted(
    id: string,
    notesKey: Uint8Array,
  ): Promise<{ meta: ChatAttachmentRef; data: Uint8Array } | null> {
    const db = await this.getDb();
    const row = await db.get('chat_attachments_local', id);
    if (!row) return null;
    const plain = JSON.parse(decryptString(notesKey, unpack(row.metaEnc, row.metaNonce))) as AttachmentMetaPlain;
    const data = decrypt(notesKey, unpack(row.dataEnc, row.dataNonce));
    return {
      meta: {
        id: row.id,
        fileName: plain.fileName,
        description: plain.description,
        mimeType: plain.mimeType,
        size: plain.size,
      },
      data,
    };
  }

  async updateChatAttachmentDescription(id: string, description: string, notesKey: Uint8Array): Promise<void> {
    const db = await this.getDb();
    const chatRow = await db.get('chat_attachments_local', id);
    if (chatRow) {
      const plain = JSON.parse(
        decryptString(notesKey, unpack(chatRow.metaEnc, chatRow.metaNonce)),
      ) as AttachmentMetaPlain;
      plain.description = description;
      const metaEnc = pack(encryptString(notesKey, JSON.stringify(plain)));
      await db.put('chat_attachments_local', {
        ...chatRow,
        metaEnc: metaEnc.enc,
        metaNonce: metaEnc.nonce,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    await this.updateAttachmentDescription(id, description, notesKey);
  }

  async deleteChatAttachment(id: string): Promise<void> {
    const db = await this.getDb();
    await db.delete('chat_attachments_local', id);
  }
}

export function createStorage(options?: StorageOptions): StorageAdapter {
  return new WebStorageAdapter(options);
}

export { META_KEYS };

declare global {
  interface Window {
    fastnote?: {
      platform: string;
      isElectron: boolean;
      getDataDirectory?: () => Promise<string>;
      getDefaultDataDirectory?: () => Promise<string>;
      setDataDirectory?: (dir: string) => Promise<string>;
      pickStorageDirectory?: () => Promise<string | null>;
      getUserDataPath?: () => Promise<string>;
      openUserDataFolder?: () => Promise<void>;
    };
  }
}
