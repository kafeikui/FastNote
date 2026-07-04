import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import type { JsonRelayStore } from './store.js';
import type {
  AttachmentBlobRecord,
  MessageQueueRecord,
  NoteBlobRecord,
  UserRecord,
} from './store.js';

function blobToBase64(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return Buffer.from(value).toString('base64');
  if (typeof value === 'string') return value;
  return null;
}

function queryRows(db: import('sql.js').Database, sql: string): Record<string, unknown>[] {
  const result = db.exec(sql);
  if (!result.length) return [];
  const { columns, values } = result[0]!;
  return values.map((row: unknown[]) => {
    const record: Record<string, unknown> = {};
    columns.forEach((col: string, index: number) => {
      record[col] = row[index];
    });
    return record;
  });
}

function hasColumn(db: import('sql.js').Database, table: string, column: string): boolean {
  const info = queryRows(db, `PRAGMA table_info(${table})`);
  return info.some((row) => row.name === column);
}

function readSqliteRelay(dbPath: string): Promise<{
  users: UserRecord[];
  note_blobs: Array<NoteBlobRecord & { user_id: string }>;
  attachment_blobs: Array<AttachmentBlobRecord & { user_id: string }>;
  message_queue: MessageQueueRecord[];
}> {
  return initSqlJs().then((sql) => {
    const db = new sql.Database(readFileSync(dbPath));
    try {
      const userRows = queryRows(
        db,
        hasColumn(db, 'users', 'vault_salt')
          ? 'SELECT id, username, password_verifier, identity_pubkey, exchange_pubkey, vault_salt, created_at FROM users'
          : 'SELECT id, username, password_verifier, identity_pubkey, exchange_pubkey, created_at FROM users',
      );
      const users: UserRecord[] = userRows.map((row) => ({
        id: String(row.id),
        username: String(row.username),
        password_verifier: String(row.password_verifier),
        identity_pubkey: blobToBase64(row.identity_pubkey),
        exchange_pubkey: blobToBase64(row.exchange_pubkey),
        vault_salt: row.vault_salt != null ? String(row.vault_salt) : null,
        created_at: String(row.created_at),
      }));

      const noteRows = queryRows(
        db,
        'SELECT user_id, note_id, ciphertext, version, content_hash, deleted, updated_at FROM note_blobs',
      );
      const note_blobs = noteRows.map((row) => ({
        user_id: String(row.user_id),
        note_id: String(row.note_id),
        ciphertext: blobToBase64(row.ciphertext) ?? '',
        version: Number(row.version),
        content_hash: row.content_hash != null ? String(row.content_hash) : null,
        deleted: Number(row.deleted ?? 0),
        updated_at: String(row.updated_at),
      }));

      const attachmentRows = queryRows(
        db,
        'SELECT user_id, attachment_id, note_id, meta_ciphertext, data_ciphertext, version, deleted, updated_at FROM attachment_blobs',
      );
      const attachment_blobs = attachmentRows.map((row) => ({
        user_id: String(row.user_id),
        attachment_id: String(row.attachment_id),
        note_id: String(row.note_id),
        meta_ciphertext: blobToBase64(row.meta_ciphertext) ?? '',
        data_ciphertext: blobToBase64(row.data_ciphertext) ?? '',
        version: Number(row.version),
        deleted: Number(row.deleted ?? 0),
        updated_at: String(row.updated_at),
      }));

      const messageRows = queryRows(
        db,
        'SELECT id, from_user, to_user, payload, created_at FROM message_queue',
      );
      const message_queue: MessageQueueRecord[] = messageRows.map((row) => {
        let payload = '';
        if (typeof row.payload === 'string') {
          payload = row.payload;
        } else if (row.payload instanceof Uint8Array || Array.isArray(row.payload)) {
          payload = Buffer.from(row.payload as Uint8Array).toString('utf8');
        }
        return {
          id: String(row.id),
          from_user: String(row.from_user),
          to_user: String(row.to_user),
          payload,
          created_at: String(row.created_at),
        };
      });

      return { users, note_blobs, attachment_blobs, message_queue };
    } finally {
      db.close();
    }
  });
}

export async function migrateRelayDbIfNeeded(dataDir: string, store: JsonRelayStore): Promise<void> {
  if (!store.isEmpty()) return;
  const dbPath = path.join(dataDir, 'relay.db');
  if (!existsSync(dbPath)) return;

  const data = await readSqliteRelay(dbPath);
  if (!data.users.length && !data.note_blobs.length) return;

  store.importAll(data);
  const backupPath = `${dbPath}.bak`;
  if (!existsSync(backupPath)) {
    renameSync(dbPath, backupPath);
  }
  console.log(
    `[FastNote] Migrated relay.db → relay.json (${data.users.length} users, ${data.note_blobs.length} notes)`,
  );
}
