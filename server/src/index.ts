import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { JsonRelayStore } from './store.js';
import { migrateRelayDbIfNeeded } from './migrate.js';

const PORT = Number(process.env.PORT ?? 8787);
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');

const store = new JsonRelayStore(DATA_DIR);
await migrateRelayDbIfNeeded(DATA_DIR, store);

function flushAndExit(code = 0): void {
  store.flush();
  process.exit(code);
}

process.on('SIGINT', () => flushAndExit(0));
process.on('SIGTERM', () => flushAndExit(0));

// Fastify's default 1 MB body limit rejects large encrypted notes/attachments with HTTP 413;
// match the WebSocket maxPayload so both transports accept the same sizes.
const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });
await app.register(cors, { origin: true });
await app.register(websocket, {
  options: { maxPayload: 32 * 1024 * 1024 },
});

function authUser(authHeader?: string): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as { sub: string };
    return payload.sub;
  } catch {
    return null;
  }
}

app.post<{ Body: { username: string; password_proof: string; identity_pubkey?: string; exchange_pubkey?: string; vault_salt?: string } }>(
  '/api/v1/register',
  async (req, reply) => {
    const { username, password_proof, identity_pubkey, exchange_pubkey, vault_salt } = req.body ?? {};
    if (!username || !password_proof) {
      return reply.code(400).send({ error: 'missing fields' });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      store.insertUser({
        id,
        username,
        password_verifier: password_proof,
        identity_pubkey: identity_pubkey ?? null,
        exchange_pubkey: exchange_pubkey ?? null,
        vault_salt: vault_salt ?? null,
        created_at: now,
      });
    } catch {
      return reply.code(409).send({ error: 'username taken' });
    }
    const token = jwt.sign({ sub: id, username }, JWT_SECRET, { expiresIn: '7d' });
    return { user_id: id, device_id: randomUUID(), token };
  },
);

app.post<{ Body: { username: string; password_proof: string } }>(
  '/api/v1/login',
  async (req, reply) => {
    const { username, password_proof } = req.body ?? {};
    const row = store.findUserByUsername(username);
    if (!row || row.password_verifier !== password_proof) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    const token = jwt.sign({ sub: row.id, username }, JWT_SECRET, { expiresIn: '7d' });
    return { user_id: row.id, device_id: randomUUID(), token };
  },
);

app.get<{ Querystring: { username?: string } }>('/api/v1/vault-salt', async (req, reply) => {
  const username = req.query.username?.trim();
  if (!username) return reply.code(400).send({ error: 'missing username' });
  const row = store.findUserByUsername(username);
  if (!row) return reply.code(404).send({ error: 'user_not_found' });
  if (!row.vault_salt) return reply.code(404).send({ error: 'vault_salt_missing' });
  return { vault_salt: row.vault_salt };
});

app.put<{ Body: { vault_salt?: string } }>('/api/v1/vault-salt', async (req, reply) => {
  const userId = authUser(req.headers.authorization);
  if (!userId) return reply.code(401).send({ error: 'unauthorized' });
  const vaultSalt = req.body?.vault_salt?.trim();
  if (!vaultSalt) return reply.code(400).send({ error: 'missing vault_salt' });
  store.updateVaultSalt(userId, vaultSalt);
  return { ok: true };
});

app.put<{
  Params: { noteId: string };
  Body: { ciphertext: string; version: number; content_hash: string; deleted?: boolean };
}>(
  '/api/v1/sync/notes/:noteId',
  async (req, reply) => {
    const userId = authUser(req.headers.authorization);
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const { noteId } = req.params;
    const { ciphertext, version, content_hash, deleted } = req.body;
    const existingVersion = store.getNoteVersion(userId, noteId);
    if (existingVersion !== undefined && version < existingVersion) {
      return reply.code(409).send({ error: 'version_conflict', server_version: existingVersion });
    }
    store.upsertNote(userId, noteId, ciphertext, version, content_hash, new Date().toISOString(), !!deleted);
    return { ok: true };
  },
);

app.get('/api/v1/sync/notes', async (req, reply) => {
  const userId = authUser(req.headers.authorization);
  if (!userId) return reply.code(401).send({ error: 'unauthorized' });
  const rows = store.listNotes(userId);
  return {
    items: rows.map((r) => ({
      note_id: r.note_id,
      ciphertext: r.ciphertext,
      version: r.version,
      content_hash: r.content_hash,
      deleted: r.deleted === 1,
      updated_at: r.updated_at,
    })),
    next_cursor: null,
  };
});

app.put<{
  Params: { attachmentId: string };
  Body: {
    note_id: string;
    meta_ciphertext: string;
    data_ciphertext: string;
    version: number;
    deleted?: boolean;
  };
}>('/api/v1/sync/attachments/:attachmentId', async (req, reply) => {
  const userId = authUser(req.headers.authorization);
  if (!userId) return reply.code(401).send({ error: 'unauthorized' });
  const { attachmentId } = req.params;
  const { note_id, meta_ciphertext, data_ciphertext, version, deleted } = req.body;
  const existingVersion = store.getAttachmentVersion(userId, attachmentId);
  if (existingVersion !== undefined && version < existingVersion) {
    return reply.code(409).send({ error: 'version_conflict', server_version: existingVersion });
  }
  store.upsertAttachment(
    userId,
    attachmentId,
    note_id,
    meta_ciphertext,
    data_ciphertext,
    version,
    !!deleted,
    new Date().toISOString(),
  );
  return { ok: true };
});

app.get('/api/v1/sync/attachments', async (req, reply) => {
  const userId = authUser(req.headers.authorization);
  if (!userId) return reply.code(401).send({ error: 'unauthorized' });
  const rows = store.listAttachments(userId);
  return {
    items: rows.map((r) => ({
      attachment_id: r.attachment_id,
      note_id: r.note_id,
      meta_ciphertext: r.meta_ciphertext,
      data_ciphertext: r.data_ciphertext,
      version: r.version,
      deleted: r.deleted === 1,
      updated_at: r.updated_at,
    })),
  };
});

app.put<{
  Params: { messageId: string };
  Body: { peer_id: string; direction: 'in' | 'out'; sent_at: string; ciphertext: string };
}>('/api/v1/sync/chat/:messageId', async (req, reply) => {
  const userId = authUser(req.headers.authorization);
  if (!userId) return reply.code(401).send({ error: 'unauthorized' });
  const { messageId } = req.params;
  const { peer_id, direction, sent_at, ciphertext } = req.body ?? {};
  if (!peer_id || !direction || !sent_at || !ciphertext) {
    return reply.code(400).send({ error: 'missing fields' });
  }
  store.upsertChatMessage(userId, messageId, peer_id, direction, sent_at, ciphertext, new Date().toISOString());
  return { ok: true };
});

app.get('/api/v1/sync/chat', async (req, reply) => {
  const userId = authUser(req.headers.authorization);
  if (!userId) return reply.code(401).send({ error: 'unauthorized' });
  const rows = store.listChatMessages(userId);
  return {
    items: rows.map((r) => ({
      message_id: r.message_id,
      peer_id: r.peer_id,
      direction: r.direction,
      sent_at: r.sent_at,
      ciphertext: r.ciphertext,
    })),
  };
});

app.get('/health', async () => ({ status: 'ok' }));

app.put<{ Body: { identity_pubkey: string; exchange_pubkey: string } }>(
  '/api/v1/keys',
  async (req, reply) => {
    const userId = authUser(req.headers.authorization);
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const { identity_pubkey, exchange_pubkey } = req.body ?? {};
    store.updateUserKeys(userId, identity_pubkey, exchange_pubkey);
    return { ok: true };
  },
);

app.get<{ Querystring: { username: string } }>('/api/v1/users/lookup', async (req, reply) => {
  const userId = authUser(req.headers.authorization);
  if (!userId) return reply.code(401).send({ error: 'unauthorized' });
  const username = req.query.username;
  const row = store.findUserByUsername(username);
  if (!row?.exchange_pubkey) return reply.code(404).send({ error: 'not found' });
  return {
    user_id: row.id,
    username: row.username,
    exchange_pubkey: row.exchange_pubkey,
  };
});

app.get<{ Params: { id: string } }>('/api/v1/users/:id', async (req, reply) => {
  const userId = authUser(req.headers.authorization);
  if (!userId) return reply.code(401).send({ error: 'unauthorized' });
  const row = store.findUserById(req.params.id);
  if (!row?.exchange_pubkey) return reply.code(404).send({ error: 'not found' });
  return {
    user_id: row.id,
    username: row.username,
    exchange_pubkey: row.exchange_pubkey,
  };
});

app.get('/api/v1/messages/pending', async (req, reply) => {
  const userId = authUser(req.headers.authorization);
  if (!userId) return reply.code(401).send({ error: 'unauthorized' });
  const rows = store.listPendingMessages(userId);
  return {
    items: rows.map((r) => {
      const fromUser = store.findUserById(r.from_user);
      return {
        id: r.id,
        from_user: r.from_user,
        from_username: fromUser?.username ?? null,
        payload: JSON.parse(r.payload) as unknown,
        created_at: r.created_at,
      };
    }),
  };
});

app.delete<{ Params: { id: string } }>('/api/v1/messages/:id', async (req, reply) => {
  const userId = authUser(req.headers.authorization);
  if (!userId) return reply.code(401).send({ error: 'unauthorized' });
  store.deleteMessage(req.params.id, userId);
  return { ok: true };
});

const onlineSockets = new Map<string, WebSocket>();

function authTokenFromReq(req: { headers: { authorization?: string }; url?: string }): string | null {
  const header = authUser(req.headers.authorization);
  if (header) return header;
  if (!req.url) return null;
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
    return payload.sub;
  } catch {
    return null;
  }
}

app.register(async (fastify) => {
  fastify.get('/ws/v1', { websocket: true }, (socket, req) => {
    const userId = authTokenFromReq(req);
    if (!userId) {
      socket.close();
      return;
    }
    onlineSockets.set(userId, socket);
    socket.on('close', () => {
      if (onlineSockets.get(userId) === socket) onlineSockets.delete(userId);
    });
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
        const msg = JSON.parse(text) as {
          type: string;
          to?: string;
          id?: string;
          sent_at?: string;
          payload?: unknown;
        };
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (msg.type === 'message' && msg.to && msg.payload) {
          const id = msg.id ?? randomUUID();
          const sender = store.findUserById(userId);
          const sentAt = msg.sent_at ?? new Date().toISOString();
          const envelope = {
            type: 'message',
            id,
            from: userId,
            from_username: sender?.username ?? null,
            to: msg.to,
            sent_at: sentAt,
            payload: msg.payload,
          };
          store.enqueueMessage(
            id,
            userId,
            msg.to,
            JSON.stringify(msg.payload),
            sentAt,
          );
          const peer = onlineSockets.get(msg.to);
          if (peer && peer.readyState === 1) {
            peer.send(JSON.stringify(envelope));
            app.log.info({ from: userId, to: msg.to, id }, 'im message pushed');
          } else {
            app.log.info({ from: userId, to: msg.to, id }, 'im message queued (offline)');
          }
          return;
        }
        // `delivery_ack`/`read_ack`: `userId` here is the recipient of the
        // original message (they're the one confirming receipt/read), and
        // `msg.to` is the original sender who should be notified. Both are
        // best-effort, live-forward-only control frames — if the original
        // sender isn't connected right now the ack is simply dropped, same
        // as the existing (already best-effort) `delivery_ack` design.
        if (msg.type === 'delivery_ack' && msg.to && msg.id) {
          // We now know for certain this message was actually received, so
          // it no longer needs to sit in the recipient's offline mailbox —
          // without this, delivered messages would linger in message_queue
          // forever and get needlessly retried by the pending-poll cycle.
          store.deleteMessage(msg.id, userId);
          const peer = onlineSockets.get(msg.to);
          if (peer && peer.readyState === 1) {
            peer.send(JSON.stringify({ type: 'delivery_ack', id: msg.id, from: userId }));
          }
          return;
        }
        if (msg.type === 'read_ack' && msg.to && msg.id) {
          const peer = onlineSockets.get(msg.to);
          if (peer && peer.readyState === 1) {
            peer.send(JSON.stringify({ type: 'read_ack', id: msg.id, from: userId }));
          }
        }
      } catch {
        /* ignore malformed */
      }
    });
  });

  // Real-time collaboration rooms: pure in-memory ciphertext relay. The room id is derived
  // client-side from an out-of-band collaboration password and payloads are AES-GCM encrypted
  // with a key the server never sees — nothing here is persisted or logged, preserving the
  // zero-knowledge model. Login is still required so the relay can't be abused anonymously.
  const collabRooms = new Map<string, Set<WebSocket>>();

  fastify.get('/ws/v1/collab', { websocket: true }, (socket, req) => {
    const userId = authTokenFromReq(req);
    if (!userId) {
      socket.close();
      return;
    }
    const url = new URL(req.url ?? '', 'http://localhost');
    const room = url.searchParams.get('room') ?? '';
    if (!/^[a-f0-9]{16,64}$/.test(room)) {
      socket.close();
      return;
    }
    let members = collabRooms.get(room);
    if (!members) {
      members = new Set();
      collabRooms.set(room, members);
    }
    members.add(socket);
    const broadcastPeers = () => {
      const frame = JSON.stringify({ type: 'peers', count: members.size });
      for (const m of members) if (m.readyState === 1) m.send(frame);
    };
    broadcastPeers();
    socket.on('close', () => {
      members.delete(socket);
      if (members.size === 0) collabRooms.delete(room);
      else broadcastPeers();
    });
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
        const msg = JSON.parse(text) as { type: string; payload?: unknown };
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (msg.type === 'data' && typeof msg.payload === 'string') {
          const frame = JSON.stringify({ type: 'data', payload: msg.payload });
          for (const m of members) {
            if (m !== socket && m.readyState === 1) m.send(frame);
          }
        }
      } catch {
        /* ignore malformed */
      }
    });
  });
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`FastNote relay listening on :${PORT} (store: ${path.join(DATA_DIR, 'relay.json')})`);
