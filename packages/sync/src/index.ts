import type { AiMessage, AiSessionKind, AiSessionNode, NoteNode, SyncNotePayload } from '@fastnote/shared';
import {
  decryptJson,
  encryptJson,
  hashContent,
  encodeWireCiphertext,
  decodeWireCiphertext,
  type EncryptedPayload,
} from '@fastnote/crypto';
import type { ApiClient, SyncNoteItem } from '@fastnote/api';
import type { UserSession } from '@fastnote/shared';
import type { StorageAdapter } from '@fastnote/storage';

function toPayload(note: NoteNode): SyncNotePayload {
  return {
    title: note.title,
    content_md: note.contentMd,
    parent_id: note.parentId,
    node_type: note.nodeType,
    sort_order: note.sortOrder,
    deleted: note.deleted,
    trashed: note.trashed === true,
    updated_at: note.updatedAt,
  };
}

function fromPayload(noteId: string, payload: SyncNotePayload, version: number, serverVersion: number): NoteNode {
  return {
    id: noteId,
    parentId: payload.parent_id,
    nodeType: payload.node_type,
    title: payload.title,
    contentMd: payload.content_md,
    sortOrder: payload.sort_order,
    version,
    serverVersion,
    contentHash: hashContent(payload.content_md),
    syncStatus: 'synced',
    deleted: payload.deleted,
    trashed: payload.trashed === true,
    updatedAt: payload.updated_at,
  };
}

export function encryptNoteForSync(note: NoteNode, notesKey: Uint8Array): EncryptedPayload {
  return encryptJson(notesKey, toPayload(note));
}

export function decryptNoteFromSync(
  noteId: string,
  ciphertextB64: string,
  notesKey: Uint8Array,
  version: number,
  serverVersion: number,
): NoteNode {
  const payload = decryptJson<SyncNotePayload>(notesKey, decodeWireCiphertext(ciphertextB64));
  return fromPayload(noteId, payload, version, serverVersion);
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  attachmentsPushed: number;
  attachmentsPulled: number;
  chatPushed: number;
  chatPulled: number;
  aiPushed: number;
  aiPulled: number;
}

/** Wire shape of one AI session/folder inside the encrypted blob. */
interface AiSessionSyncPayload {
  parent_id: string | null;
  kind: AiSessionKind;
  title: string;
  messages: AiMessage[];
  sort_order: number;
  /** Recycle-bin flag; optional so blobs from older clients decode as "not trashed". */
  trashed?: boolean;
  updated_at: string;
}

export class SyncClient {
  constructor(
    private api: ApiClient,
    private session: UserSession,
  ) {}

  async syncAll(
    notes: NoteNode[],
    notesKey: Uint8Array,
    onSave: (note: NoteNode) => Promise<void>,
    storage?: StorageAdapter,
  ): Promise<{ notes: NoteNode[]; result: SyncResult }> {
    let pushed = 0;
    let pulled = 0;
    let conflicts = 0;
    let attachmentsPushed = 0;
    let attachmentsPulled = 0;
    let chatPushed = 0;
    let chatPulled = 0;
    let aiPushed = 0;
    let aiPulled = 0;
    const localMap = new Map(notes.map((n) => [n.id, n]));

    // Push deletion tombstones first, then hard-delete the local tombstone rows: once the server
    // knows, keeping (and re-decrypting) them locally on every unlock serves no purpose.
    if (storage) {
      const deletedStubs = await storage.listDeletedNoteStubs();
      for (const stub of deletedStubs) {
        const enc = encryptNoteForSync(stub, notesKey);
        const pushResult = await this.api.pushNote(this.session.token, stub.id, {
          ciphertext: encodeWireCiphertext(enc),
          version: stub.version,
          content_hash: stub.contentHash,
          deleted: true,
        });
        if (!pushResult.conflict) await storage.deleteNote(stub.id);
      }
    }

    for (const note of notes) {
      if (note.deleted || note.syncStatus === 'synced') continue;
      const enc = encryptNoteForSync(note, notesKey);
      const pushResult = await this.api.pushNote(this.session.token, note.id, {
        ciphertext: encodeWireCiphertext(enc),
        version: note.version,
        content_hash: note.contentHash,
      });
      if (pushResult.conflict) {
        conflicts++;
        const conflictCopy: NoteNode = {
          ...note,
          id: crypto.randomUUID(),
          title: `${note.title} (冲突副本)`,
          syncStatus: 'conflict',
        };
        await onSave(conflictCopy);
        localMap.set(conflictCopy.id, conflictCopy);
        continue;
      }
      const synced = { ...note, syncStatus: 'synced' as const, serverVersion: note.version };
      await onSave(synced);
      localMap.set(note.id, synced);
      pushed++;
    }

    const remoteItems = await this.api.pullNotes(this.session.token);
    for (const item of remoteItems) {
      if (item.deleted) {
        // Deletion made on another device: drop our local copy (tab pruning and UI state are
        // reconciled by the caller from the returned notes list).
        const local = localMap.get(item.note_id);
        if (local && item.version >= local.serverVersion) {
          localMap.delete(item.note_id);
          if (storage) await storage.deleteNote(item.note_id);
          pulled++;
        } else if (!local && storage) {
          // Not in the caller's (non-deleted) list, but a stale local tombstone row may remain.
          await storage.deleteNote(item.note_id);
        }
        continue;
      }
      const remote = decryptNoteFromSync(
        item.note_id,
        item.ciphertext,
        notesKey,
        item.version,
        item.version,
      );
      const local = localMap.get(item.note_id);
      if (!local) {
        await onSave(remote);
        localMap.set(remote.id, remote);
        pulled++;
        continue;
      }
      if (item.version > local.serverVersion && item.content_hash !== local.contentHash) {
        if (local.syncStatus === 'pending') {
          const conflictCopy: NoteNode = {
            ...remote,
            id: crypto.randomUUID(),
            title: `${remote.title} (冲突副本)`,
            syncStatus: 'conflict',
          };
          await onSave(conflictCopy);
          localMap.set(conflictCopy.id, conflictCopy);
          conflicts++;
        } else {
          await onSave(remote);
          localMap.set(remote.id, remote);
          pulled++;
        }
      } else if (item.version > local.serverVersion) {
        const synced = { ...remote, syncStatus: 'synced' as const };
        await onSave(synced);
        localMap.set(synced.id, synced);
        pulled++;
      }
    }

    if (storage) {
      const att = await this.syncAttachments(storage);
      attachmentsPushed = att.pushed;
      attachmentsPulled = att.pulled;
      const chat = await this.syncChatMessages(storage);
      chatPushed = chat.pushed;
      chatPulled = chat.pulled;
      const ai = await this.syncAiSessions(storage, notesKey);
      aiPushed = ai.pushed;
      aiPulled = ai.pulled;
    }

    return {
      notes: Array.from(localMap.values()),
      result: {
        pushed,
        pulled,
        conflicts,
        attachmentsPushed,
        attachmentsPulled,
        chatPushed,
        chatPulled,
        aiPushed,
        aiPulled,
      },
    };
  }

  async syncAttachments(storage: StorageAdapter): Promise<{ pushed: number; pulled: number }> {
    let pushed = 0;
    let pulled = 0;

    const pending = await storage.listPendingAttachments();
    for (const { id } of pending) {
      const wire = await storage.getAttachmentWire(id);
      if (!wire) continue;
      const pushResult = await this.api.pushAttachment(this.session.token, id, {
        note_id: wire.noteId,
        meta_ciphertext: wire.metaWire,
        data_ciphertext: wire.dataWire,
        version: wire.version,
        deleted: wire.deleted,
      });
      if (pushResult.conflict) continue;
      if (wire.deleted) {
        await storage.purgeAttachment(id);
      } else {
        await storage.markAttachmentSynced(id, wire.version);
      }
      pushed++;
    }

    const remoteItems = await this.api.pullAttachments(this.session.token);
    for (const item of remoteItems) {
      if (item.deleted) {
        const localVersion = await storage.getAttachmentServerVersion(item.attachment_id);
        if (localVersion === null || item.version > localVersion) {
          await storage.purgeAttachment(item.attachment_id);
          pulled++;
        }
        continue;
      }
      const localVersion = await storage.getAttachmentServerVersion(item.attachment_id);
      if (localVersion === null || item.version > localVersion) {
        await storage.saveAttachmentFromRemote(item);
        pulled++;
      }
    }

    return { pushed, pulled };
  }

  /**
   * Chat message history sync. Unlike notes/attachments, chat messages are
   * effectively immutable once created (no meaningful concurrent-edit
   * conflicts to resolve), so this uses a much simpler push-once /
   * pull-if-missing model instead of the notes' version+conflict-copy
   * machinery: push any locally-unsynced message as an opaque ciphertext
   * blob (it's already encrypted with `notesKey` locally, so no
   * decrypt/re-encrypt round-trip is needed here), and pull down any remote
   * message this device doesn't have yet. A message already present locally
   * is never overwritten by a pull, so local-only state (e.g. read/delivered
   * status refinements) is never clobbered — the trade-off is that status
   * changes made after the first sync don't themselves get re-synced.
   */
  async syncChatMessages(storage: StorageAdapter): Promise<{ pushed: number; pulled: number }> {
    let pushed = 0;
    let pulled = 0;

    const pending = await storage.listPendingChatMessages();
    for (const { id } of pending) {
      const wire = await storage.getChatMessageWire(id);
      if (!wire) continue;
      await this.api.pushChatMessage(this.session.token, id, {
        peer_id: wire.peerId,
        direction: wire.direction,
        sent_at: wire.sentAt,
        ciphertext: wire.ciphertext,
      });
      await storage.markChatMessageSynced(id);
      pushed++;
    }

    const remoteItems = await this.api.pullChatMessages(this.session.token);
    for (const item of remoteItems) {
      if (await storage.hasChatMessage(item.message_id)) continue;
      await storage.saveChatMessageFromRemote(item);
      pulled++;
    }

    return { pushed, pulled };
  }

  /**
   * AI Workbench session sync. Each session/folder travels as one opaque blob encrypted with the
   * vault's notes key (the server never sees plaintext), merged whole-node last-writer-wins on
   * `updatedAt` — fine-grained message merging isn't needed because a session is only ever
   * appended to from one device at a time in practice. Deletions propagate via tombstones: the
   * local row is kept as a tombstone until pushed, and remote tombstones drop the local copy
   * unless it has been edited more recently.
   */
  async syncAiSessions(
    storage: StorageAdapter,
    notesKey: Uint8Array,
  ): Promise<{ pushed: number; pulled: number }> {
    let pushed = 0;
    let pulled = 0;

    const pending = await storage.listPendingAiSessions(notesKey);
    for (const { session, deleted } of pending) {
      const payload: AiSessionSyncPayload = {
        parent_id: session.parentId,
        kind: session.kind,
        title: session.title,
        messages: session.messages,
        sort_order: session.sortOrder,
        trashed: session.trashed === true,
        updated_at: session.updatedAt,
      };
      await this.api.pushAiSession(this.session.token, session.id, {
        ciphertext: encodeWireCiphertext(encryptJson(notesKey, payload)),
        updated_at: session.updatedAt,
        deleted,
      });
      await storage.markAiSessionSynced(session.id);
      pushed++;
    }

    const remoteItems = await this.api.pullAiSessions(this.session.token);
    for (const item of remoteItems) {
      const local = await storage.getAiSessionSyncMeta(item.session_id);
      if (item.deleted) {
        // Drop the local copy unless it was edited after the deletion (LWW keeps the edit; the
        // push loop above has already re-uploaded it in that case).
        if (local && local.updatedAt <= item.updated_at) {
          await storage.purgeAiSession(item.session_id);
          pulled++;
        }
        continue;
      }
      if (local && (local.deleted || item.updated_at <= local.updatedAt)) continue;
      const payload = decryptJson<AiSessionSyncPayload>(
        notesKey,
        decodeWireCiphertext(item.ciphertext),
      );
      const node: AiSessionNode = {
        id: item.session_id,
        parentId: payload.parent_id,
        kind: payload.kind,
        title: payload.title,
        messages: payload.messages ?? [],
        sortOrder: payload.sort_order,
        trashed: payload.trashed === true,
        updatedAt: payload.updated_at,
      };
      await storage.saveAiSessionFromRemote(node, notesKey);
      pulled++;
    }

    return { pushed, pulled };
  }
}

export type { SyncNoteItem };
