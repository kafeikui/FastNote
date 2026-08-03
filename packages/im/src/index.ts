import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { gcm } from '@noble/ciphers/aes';
import { randomBytes, utf8ToBytes, bytesToUtf8 } from '@noble/hashes/utils';
import { HKDF_INFO, type IMSessionState } from '@fastnote/shared';
import { encodeChatWire, type ChatWirePayload } from '@fastnote/shared';
import { toBase64, fromBase64 } from '@fastnote/crypto';

export const IM_SESSION_STORAGE_VERSION = 3;

export interface IMEnvelope {
  counter: number;
  nonce: string;
  ciphertext: string;
}

export function verifyExchangeKeypair(privateKey: Uint8Array): string {
  return toBase64(x25519.getPublicKey(privateKey));
}

export function deriveSharedRoot(myPrivateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(myPrivateKey, peerPublicKey);
  return hkdf(sha256, shared, undefined, utf8ToBytes(HKDF_INFO.im), 32);
}

export function createSession(
  peerId: string,
  peerUsername: string,
  peerExchangePubkeyB64: string,
  myPrivateKey: Uint8Array,
): IMSessionState {
  const rootKey = deriveSharedRoot(myPrivateKey, fromBase64(peerExchangePubkeyB64));
  return {
    peerId,
    peerUsername,
    peerExchangePubkey: peerExchangePubkeyB64,
    sendCounter: 0,
    recvCounter: 0,
    rootKey: toBase64(rootKey),
  };
}

/** Merge persisted counters when refreshing session keys for the same peer. */
export function mergeSessionState(
  existing: IMSessionState | undefined,
  fresh: IMSessionState,
): IMSessionState {
  if (!existing || existing.rootKey !== fresh.rootKey) return fresh;
  return {
    ...fresh,
    sendCounter: existing.sendCounter,
    recvCounter: existing.recvCounter,
  };
}

function messageKey(rootKey: Uint8Array, counter: number): Uint8Array {
  return hkdf(
    sha256,
    rootKey,
    undefined,
    utf8ToBytes(`fastnote-msg-${counter}`),
    32,
  );
}

export function encryptMessage(
  state: IMSessionState,
  plaintext: string,
): { envelope: IMEnvelope; state: IMSessionState } {
  const rootKey = fromBase64(state.rootKey);
  const counter = state.sendCounter + 1;
  const key = messageKey(rootKey, counter);
  const nonce = randomBytes(12);
  const cipher = gcm(key, nonce);
  const ciphertext = cipher.encrypt(utf8ToBytes(plaintext));
  return {
    envelope: {
      counter,
      nonce: toBase64(nonce),
      ciphertext: toBase64(ciphertext),
    },
    state: { ...state, sendCounter: counter },
  };
}

export function decryptMessage(
  state: IMSessionState,
  envelope: IMEnvelope,
): { plaintext: string; state: IMSessionState } {
  if (envelope.counter <= state.recvCounter) {
    throw new Error('重放消息已忽略');
  }
  const rootKey = fromBase64(state.rootKey);
  const key = messageKey(rootKey, envelope.counter);
  const cipher = gcm(key, fromBase64(envelope.nonce));
  const plain = cipher.decrypt(fromBase64(envelope.ciphertext));
  return {
    plaintext: bytesToUtf8(plain),
    state: { ...state, recvCounter: envelope.counter },
  };
}

export interface WSMessage {
  type: 'message' | 'delivery_ack' | 'read_ack' | 'ping' | 'pong';
  id?: string;
  from?: string;
  to?: string;
  sent_at?: string;
  payload?: IMEnvelope;
}

/** Invoked when the peer confirms they received (`delivery_ack`) or actually
 * viewed (`read_ack`) one of OUR outgoing messages. `peerId` is who sent the
 * ack (i.e. the recipient of the original message), `msgId` is the id of our
 * original outgoing message. */
export type IMAckHandler = (peerId: string, msgId: string) => void;

export type IMMessageHandler = (
  peerId: string,
  body: string,
  msgId: string,
  sentAt: string,
) => void | Promise<void>;

export class IMClient {
  private ws: WebSocket | null = null;
  private sessions = new Map<string, IMSessionState>();
  private onMessage?: IMMessageHandler;
  private onDeliveryAck?: IMAckHandler;
  private onReadAck?: IMAckHandler;
  private ensurePeerSession?: (peerId: string) => Promise<boolean>;
  private openPromise: Promise<void> | null = null;
  private openResolve: (() => void) | null = null;
  private disposed = false;
  private pendingPollTimer: ReturnType<typeof setInterval> | null = null;
  private pendingFetcher?: () => Promise<void>;
  private onConnected?: () => void;

  constructor(
    private wsBaseUrl: string,
    private token: string,
    private myPrivateKey: Uint8Array,
  ) {}

  setOnMessage(handler: IMMessageHandler): void {
    this.onMessage = handler;
  }

  setOnDeliveryAck(handler: IMAckHandler): void {
    this.onDeliveryAck = handler;
  }

  setOnReadAck(handler: IMAckHandler): void {
    this.onReadAck = handler;
  }

  setEnsurePeerSession(handler: (peerId: string) => Promise<boolean>): void {
    this.ensurePeerSession = handler;
  }

  setPendingFetcher(fetcher: () => Promise<void>): void {
    this.pendingFetcher = fetcher;
  }

  /** Fires on every successful (re)connect — used for catch-up syncs after being offline. */
  setOnConnected(handler: () => void): void {
    this.onConnected = handler;
  }

  upsertSession(
    peerId: string,
    peerUsername: string,
    peerExchangePubkeyB64: string,
  ): IMSessionState {
    const fresh = createSession(peerId, peerUsername, peerExchangePubkeyB64, this.myPrivateKey);
    const merged = mergeSessionState(this.sessions.get(peerId), fresh);
    this.sessions.set(peerId, merged);
    return merged;
  }

  ensureSession(peerId: string, peerUsername: string, peerExchangePubkey: string): IMSessionState {
    return this.upsertSession(peerId, peerUsername, peerExchangePubkey);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  waitForConnection(timeoutMs = 12000): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    if (!this.ws) return Promise.reject(new Error('消息连接未建立，请确认已登录'));
    if (!this.openPromise) {
      return Promise.reject(new Error('消息连接未建立，请确认已登录'));
    }
    return Promise.race([
      this.openPromise,
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('连接消息服务器超时，请检查服务器地址')), timeoutMs);
      }),
    ]);
  }

  connect(): void {
    this.disposed = false;
    this.ws?.close();
    const url = `${this.wsBaseUrl.replace(/^http/, 'ws')}/ws/v1?token=${encodeURIComponent(this.token)}`;
    this.openPromise = new Promise<void>((resolve) => {
      this.openResolve = resolve;
    });
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => void this.handleRaw(ev.data as string);
    this.ws.onopen = () => {
      this.ws?.send(JSON.stringify({ type: 'ping' }));
      this.openResolve?.();
      this.openResolve = null;
      void this.pendingFetcher?.();
      this.onConnected?.();
    };
    this.ws.onclose = () => {
      this.openPromise = null;
      this.openResolve = null;
      if (!this.disposed) {
        setTimeout(() => {
          if (!this.disposed && !this.isConnected()) this.connect();
        }, 2500);
      }
    };
    this.ws.onerror = () => {
      /* onclose handles reconnect */
    };
    if (this.pendingPollTimer) clearInterval(this.pendingPollTimer);
    this.pendingPollTimer = setInterval(() => {
      if (this.isConnected()) void this.pendingFetcher?.();
    }, 15000);
  }

  disconnect(): void {
    this.disposed = true;
    if (this.pendingPollTimer) {
      clearInterval(this.pendingPollTimer);
      this.pendingPollTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.openPromise = null;
    this.openResolve = null;
  }

  loadSession(state: IMSessionState): void {
    this.sessions.set(state.peerId, state);
  }

  getSession(peerId: string): IMSessionState | undefined {
    return this.sessions.get(peerId);
  }

  allSessions(): IMSessionState[] {
    return [...this.sessions.values()];
  }

  sendText(peerId: string, body: string): Promise<IMSessionState> {
    return this.sendPayload(peerId, { v: 1, body, attachments: [] });
  }

  async sendPayload(
    peerId: string,
    payload: ChatWirePayload,
    messageId?: string,
  ): Promise<IMSessionState> {
    await this.waitForConnection();
    const session = this.sessions.get(peerId);
    if (!session) {
      throw new Error('未建立与该用户的加密会话，请先发起聊天');
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('消息连接未就绪，请稍后重试');
    }
    const wire = encodeChatWire(payload);
    const { envelope, state } = encryptMessage(session, wire);
    this.sessions.set(peerId, state);
    const id = messageId ?? crypto.randomUUID();
    this.ws.send(
      JSON.stringify({
        type: 'message',
        id,
        to: peerId,
        sent_at: new Date().toISOString(),
        payload: envelope,
      } satisfies WSMessage),
    );
    return state;
  }

  /** Tell `peerId` that we've actually displayed their message `messageId` to
   * the user (as opposed to `delivery_ack`, which just means our client
   * received and decrypted it). Best-effort only — like `delivery_ack`, it's
   * a plaintext WS control frame that's simply dropped if we're offline. */
  sendReadAck(peerId: string, messageId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'read_ack', id: messageId, to: peerId } satisfies WSMessage));
  }

  async processEnvelope(
    from: string,
    msgId: string,
    envelope: IMEnvelope,
    sentAt: string,
  ): Promise<boolean> {
    if (this.ensurePeerSession) {
      const ready = await this.ensurePeerSession(from);
      if (!ready) return false;
    }
    const session = this.sessions.get(from);
    if (!session) return false;
    try {
      const { plaintext, state } = decryptMessage(session, envelope);
      if (this.onMessage) {
        await this.onMessage(from, plaintext, msgId, sentAt);
      }
      this.sessions.set(from, state);
      return true;
    } catch (err) {
      console.warn('[IM] decrypt/process failed', from, msgId, err);
      return false;
    }
  }

  private async handleRaw(raw: string): Promise<void> {
    try {
      const msg = JSON.parse(raw) as WSMessage & { payload?: IMEnvelope; sent_at?: string };
      if (msg.type === 'pong') return;
      if (msg.type === 'message' && msg.from && msg.payload && msg.id) {
        const ok = await this.processEnvelope(
          msg.from,
          msg.id,
          msg.payload,
          msg.sent_at ?? new Date().toISOString(),
        );
        if (ok) {
          this.ws?.send(JSON.stringify({ type: 'delivery_ack', id: msg.id, to: msg.from }));
        }
        return;
      }
      if (msg.type === 'delivery_ack' && msg.from && msg.id) {
        this.onDeliveryAck?.(msg.from, msg.id);
        return;
      }
      if (msg.type === 'read_ack' && msg.from && msg.id) {
        this.onReadAck?.(msg.from, msg.id);
        return;
      }
    } catch (err) {
      console.warn('[IM] handleRaw failed', err);
    }
  }

  async fetchPending(
    apiBase: string,
    token: string,
    onEnvelope: (
      from: string,
      msgId: string,
      envelope: IMEnvelope,
      sentAt: string,
    ) => boolean | Promise<boolean>,
  ): Promise<void> {
    const res = await fetch(`${apiBase}/api/v1/messages/pending`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      items: Array<{ id: string; from_user: string; payload: IMEnvelope; created_at: string }>;
    };
    for (const item of data.items) {
      const ok = await onEnvelope(
        item.from_user,
        item.id,
        item.payload,
        item.created_at,
      );
      if (ok) {
        await fetch(`${apiBase}/api/v1/messages/${item.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    }
  }

  /** Fetch pending messages; undecryptable entries are dropped to avoid infinite retry. */
  async pullPendingMessages(
    apiBase: string,
    token: string,
  ): Promise<void> {
    await this.fetchPending(apiBase, token, async (from, msgId, envelope, sentAt) =>
      this.processEnvelope(from, msgId, envelope, sentAt),
    );
    const res = await fetch(`${apiBase}/api/v1/messages/pending`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      items: Array<{ id: string }>;
    };
    for (const item of data.items) {
      await fetch(`${apiBase}/api/v1/messages/${item.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  }
}
