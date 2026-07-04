import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface UserRecord {
  id: string;
  username: string;
  password_verifier: string;
  identity_pubkey: string | null;
  exchange_pubkey: string | null;
  vault_salt: string | null;
  created_at: string;
}

export interface NoteBlobRecord {
  note_id: string;
  ciphertext: string;
  version: number;
  content_hash: string | null;
  deleted: number;
  updated_at: string;
}

export interface AttachmentBlobRecord {
  attachment_id: string;
  note_id: string;
  meta_ciphertext: string;
  data_ciphertext: string;
  version: number;
  deleted: number;
  updated_at: string;
}

export interface MessageQueueRecord {
  id: string;
  from_user: string;
  to_user: string;
  payload: string;
  created_at: string;
}

interface RelayData {
  users: UserRecord[];
  note_blobs: Array<NoteBlobRecord & { user_id: string }>;
  attachment_blobs: Array<AttachmentBlobRecord & { user_id: string }>;
  message_queue: MessageQueueRecord[];
}

function emptyData(): RelayData {
  return { users: [], note_blobs: [], attachment_blobs: [], message_queue: [] };
}

export class JsonRelayStore {
  private readonly filePath: string;
  private data: RelayData;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, 'relay.json');
    this.data = this.load();
  }

  private load(): RelayData {
    if (!existsSync(this.filePath)) return emptyData();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<RelayData>;
      return {
        users: parsed.users ?? [],
        note_blobs: parsed.note_blobs ?? [],
        attachment_blobs: parsed.attachment_blobs ?? [],
        message_queue: parsed.message_queue ?? [],
      };
    } catch {
      return emptyData();
    }
  }

  private writeNow(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeNow();
    }, 200);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeNow();
  }

  isEmpty(): boolean {
    return (
      this.data.users.length === 0 &&
      this.data.note_blobs.length === 0 &&
      this.data.attachment_blobs.length === 0 &&
      this.data.message_queue.length === 0
    );
  }

  importAll(data: RelayData): void {
    this.data = data;
    this.writeNow();
  }

  insertUser(user: UserRecord): void {
    if (this.data.users.some((u) => u.username === user.username)) {
      throw new Error('username taken');
    }
    this.data.users.push(user);
    this.scheduleSave();
  }

  findUserByUsername(username: string): UserRecord | undefined {
    return this.data.users.find((u) => u.username === username);
  }

  findUserById(id: string): UserRecord | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  updateVaultSalt(userId: string, vaultSalt: string): void {
    const user = this.findUserById(userId);
    if (!user) return;
    user.vault_salt = vaultSalt;
    this.scheduleSave();
  }

  updateUserKeys(userId: string, identityPub: string, exchangePub: string): void {
    const user = this.findUserById(userId);
    if (!user) return;
    user.identity_pubkey = identityPub;
    user.exchange_pubkey = exchangePub;
    this.scheduleSave();
  }

  getNoteVersion(userId: string, noteId: string): number | undefined {
    return this.data.note_blobs.find((n) => n.user_id === userId && n.note_id === noteId)?.version;
  }

  upsertNote(
    userId: string,
    noteId: string,
    ciphertext: string,
    version: number,
    contentHash: string,
    updatedAt: string,
  ): void {
    const existing = this.data.note_blobs.find((n) => n.user_id === userId && n.note_id === noteId);
    if (existing) {
      existing.ciphertext = ciphertext;
      existing.version = version;
      existing.content_hash = contentHash;
      existing.updated_at = updatedAt;
    } else {
      this.data.note_blobs.push({
        user_id: userId,
        note_id: noteId,
        ciphertext,
        version,
        content_hash: contentHash,
        deleted: 0,
        updated_at: updatedAt,
      });
    }
    this.scheduleSave();
  }

  listNotes(userId: string): NoteBlobRecord[] {
    return this.data.note_blobs
      .filter((n) => n.user_id === userId)
      .map(({ user_id: _uid, ...rest }) => rest);
  }

  getAttachmentVersion(userId: string, attachmentId: string): number | undefined {
    return this.data.attachment_blobs.find(
      (a) => a.user_id === userId && a.attachment_id === attachmentId,
    )?.version;
  }

  upsertAttachment(
    userId: string,
    attachmentId: string,
    noteId: string,
    metaCiphertext: string,
    dataCiphertext: string,
    version: number,
    deleted: boolean,
    updatedAt: string,
  ): void {
    const existing = this.data.attachment_blobs.find(
      (a) => a.user_id === userId && a.attachment_id === attachmentId,
    );
    if (existing) {
      existing.note_id = noteId;
      existing.meta_ciphertext = metaCiphertext;
      existing.data_ciphertext = dataCiphertext;
      existing.version = version;
      existing.deleted = deleted ? 1 : 0;
      existing.updated_at = updatedAt;
    } else {
      this.data.attachment_blobs.push({
        user_id: userId,
        attachment_id: attachmentId,
        note_id: noteId,
        meta_ciphertext: metaCiphertext,
        data_ciphertext: dataCiphertext,
        version,
        deleted: deleted ? 1 : 0,
        updated_at: updatedAt,
      });
    }
    this.scheduleSave();
  }

  listAttachments(userId: string): AttachmentBlobRecord[] {
    return this.data.attachment_blobs
      .filter((a) => a.user_id === userId)
      .map(({ user_id: _uid, ...rest }) => rest);
  }

  listPendingMessages(userId: string, limit = 100): MessageQueueRecord[] {
    return this.data.message_queue
      .filter((m) => m.to_user === userId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
  }

  deleteMessage(id: string, userId: string): void {
    this.data.message_queue = this.data.message_queue.filter(
      (m) => !(m.id === id && m.to_user === userId),
    );
    this.scheduleSave();
  }

  enqueueMessage(id: string, fromUser: string, toUser: string, payload: string, createdAt: string): void {
    if (this.data.message_queue.some((m) => m.id === id)) return;
    this.data.message_queue.push({
      id,
      from_user: fromUser,
      to_user: toUser,
      payload,
      created_at: createdAt,
    });
    this.scheduleSave();
  }
}
