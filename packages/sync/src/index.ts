import type { NoteNode, SyncNotePayload } from '@fastnote/shared';
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
    const localMap = new Map(notes.map((n) => [n.id, n]));

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
      if (item.deleted) continue;
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
    }

    return {
      notes: Array.from(localMap.values()),
      result: { pushed, pulled, conflicts, attachmentsPushed, attachmentsPulled },
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
}

export type { SyncNoteItem };
