/**
 * Real-time collaboration over the self-hosted relay, without weakening the zero-knowledge
 * security model:
 *
 * - The collaboration password is negotiated out-of-band between participants and never leaves
 *   the device. From it we derive (PBKDF2-SHA256, 600k iterations — same cost as the vault
 *   password) a 32-byte secret, then two independent HKDF subkeys:
 *     roomId  — an opaque hex identifier; the only thing the server ever sees.
 *     roomKey — AES-256-GCM key for every payload relayed through the room.
 * - The server keeps rooms purely in memory (a Map of sockets), relays ciphertext to the other
 *   members and never persists or logs payloads. Someone watching the server sees who talks to
 *   which opaque room and the traffic volume — never content, titles, or note identity.
 * - Sync protocol (inside the encrypted payloads): differential text sync. Each client keeps a
 *   `shadow` of the last text exchanged with the room; local edits are broadcast as
 *   diff-match-patch patches against the shadow, and remote patches are fuzzily applied to both
 *   the local text and the shadow. Whole-state messages bootstrap new joiners and recover from
 *   failed patch applications. This converges well for small rooms (the intended use case);
 *   it is not an OT/CRDT and offers no theoretical guarantee under heavy concurrent editing.
 */
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';
import {
  encryptStringNative,
  decryptStringNative,
  packEncrypted,
  unpackEncrypted,
} from '@fastnote/crypto';
import DiffMatchPatch from 'diff-match-patch';

const COLLAB_KDF_SALT = 'fastnote-collab-v1';
const RECONNECT_DELAY_MS = 2500;
const LOCAL_FLUSH_DEBOUNCE_MS = 400;

export interface CollabRoom {
  roomId: string;
  roomKey: Uint8Array;
}

/**
 * Derives the room identity and payload key from the shared collaboration password. Both
 * derivations are deterministic so every participant lands in the same room with the same key,
 * while the server-visible roomId cannot be reversed into the key (independent HKDF infos).
 */
export async function deriveCollabRoom(password: string): Promise<CollabRoom> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(COLLAB_KDF_SALT), iterations: 600_000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  const secret = new Uint8Array(bits);
  const roomId = bytesToHex(hkdf(sha256, secret, undefined, utf8ToBytes('fastnote-collab-room'), 16));
  const roomKey = hkdf(sha256, secret, undefined, utf8ToBytes('fastnote-collab-key'), 32);
  return { roomId, roomKey };
}

export type CollabConnState = 'connecting' | 'connected' | 'disconnected';

export interface CollabStatus {
  state: CollabConnState;
  /** Total members in the room, including this client (0 while disconnected). */
  peers: number;
}

/** Server-visible envelope. `payload` is always packEncrypted ciphertext. */
interface CollabWsFrame {
  type: 'ping' | 'pong' | 'peers' | 'data';
  count?: number;
  payload?: string;
}

/** Decrypted application messages exchanged between room members. */
interface CollabMessage {
  kind: 'hello' | 'state' | 'patch';
  client: string;
  seq: number;
  /** Full document text (kind: state). */
  text?: string;
  /** diff-match-patch patch text against the sender's shadow (kind: patch). */
  patches?: string;
}

export interface CollabSessionOptions {
  serverUrl: string;
  /** Relay login token (JWT); collaboration requires a logged-in cloud account. */
  token: string;
  /** The out-of-band negotiated collaboration password. */
  password: string;
  /** Returns the current local document text (markdown for notes, JSON for tables). */
  getText: () => string;
  /**
   * Applies remotely merged text to the local document. Must not feed the change back into
   * `updateLocal` (the host is expected to guard against that re-entrancy).
   */
  applyRemote: (text: string) => void;
  /**
   * Optional sanity check before applying merged text (e.g. tables verify the JSON still
   * parses). A failed validation discards the merge and requests a full state resync instead,
   * so a bad fuzzy patch can never corrupt a structured document.
   */
  validate?: (text: string) => boolean;
  onStatus?: (status: CollabStatus) => void;
}

export class CollabSession {
  private ws: WebSocket | null = null;
  private disposed = false;
  private readonly clientId = crypto.randomUUID();
  private seq = 0;
  private shadow: string;
  /** True until this client has either received a room state or made a local edit. */
  private awaitingState = true;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly dmp = new DiffMatchPatch();
  private status: CollabStatus = { state: 'connecting', peers: 0 };

  private constructor(
    private readonly room: CollabRoom,
    private readonly opts: CollabSessionOptions,
  ) {
    this.shadow = opts.getText();
  }

  static async create(opts: CollabSessionOptions): Promise<CollabSession> {
    const room = await deriveCollabRoom(opts.password);
    const session = new CollabSession(room, opts);
    session.connect();
    return session;
  }

  /** Feed every local edit of the document here; broadcasts are debounced internally. */
  updateLocal(_text: string): void {
    if (this.disposed) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushLocal(), LOCAL_FLUSH_DEBOUNCE_MS);
  }

  getStatus(): CollabStatus {
    return this.status;
  }

  close(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.ws?.close();
    this.ws = null;
    this.setStatus({ state: 'disconnected', peers: 0 });
  }

  // --- connection ---------------------------------------------------------------

  private connect(): void {
    if (this.disposed) return;
    this.setStatus({ state: 'connecting', peers: 0 });
    const base = this.opts.serverUrl.replace(/^http/, 'ws');
    const url = `${base}/ws/v1/collab?token=${encodeURIComponent(this.opts.token)}&room=${this.room.roomId}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.setStatus({ state: 'connected', peers: Math.max(1, this.status.peers) });
      // (Re)joining: ask the room for its current state unless we already own local edits.
      if (this.awaitingState) void this.sendMessage({ kind: 'hello', client: this.clientId, seq: this.seq });
    };
    ws.onmessage = (ev) => void this.handleFrame(String(ev.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.setStatus({ state: this.disposed ? 'disconnected' : 'connecting', peers: 0 });
      if (!this.disposed) {
        setTimeout(() => {
          if (!this.disposed && this.ws === ws) this.connect();
        }, RECONNECT_DELAY_MS);
      }
    };
    ws.onerror = () => {
      /* onclose handles reconnect */
    };
  }

  private setStatus(next: CollabStatus): void {
    this.status = next;
    this.opts.onStatus?.(next);
  }

  private async sendMessage(msg: CollabMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = packEncrypted(await encryptStringNative(this.room.roomKey, JSON.stringify(msg)));
    this.ws.send(JSON.stringify({ type: 'data', payload } satisfies CollabWsFrame));
  }

  // --- protocol ------------------------------------------------------------------

  private async handleFrame(raw: string): Promise<void> {
    let frame: CollabWsFrame;
    try {
      frame = JSON.parse(raw) as CollabWsFrame;
    } catch {
      return;
    }
    if (frame.type === 'peers' && typeof frame.count === 'number') {
      // Alone in the room: nobody can seed us, so our local text *is* the room content and we
      // must answer future newcomers' hello. (The starter of a session always hits this.)
      if (this.awaitingState && frame.count === 1) this.awaitingState = false;
      this.setStatus({ state: 'connected', peers: frame.count });
      return;
    }
    if (frame.type !== 'data' || typeof frame.payload !== 'string') return;
    let msg: CollabMessage;
    try {
      msg = JSON.parse(
        await decryptStringNative(this.room.roomKey, unpackEncrypted(frame.payload)),
      ) as CollabMessage;
    } catch {
      // Wrong key (someone with a different password somehow landed in the room) or corruption —
      // ignore; we can't and shouldn't process what we can't authenticate.
      return;
    }
    if (msg.client === this.clientId) return;
    this.seq = Math.max(this.seq, msg.seq);

    if (msg.kind === 'hello') {
      // A newcomer asks for the room's content. Anyone who already holds state answers; the
      // newcomer adopts the first reply. Clients that are themselves still waiting stay silent
      // so two fresh joiners can't swap each other's stale documents.
      if (!this.awaitingState) {
        void this.sendMessage({ kind: 'state', client: this.clientId, seq: ++this.seq, text: this.opts.getText() });
      }
      return;
    }

    if (msg.kind === 'state' && typeof msg.text === 'string') {
      this.handleState(msg.text);
      return;
    }

    if (msg.kind === 'patch' && typeof msg.patches === 'string') {
      this.handlePatch(msg.patches);
    }
  }

  private handleState(remoteText: string): void {
    if (this.awaitingState) {
      // Joining an active session adopts the session's content (documented in the join UI).
      if (this.opts.validate && !this.opts.validate(remoteText)) return;
      this.awaitingState = false;
      this.shadow = remoteText;
      if (remoteText !== this.opts.getText()) this.opts.applyRemote(remoteText);
      return;
    }
    if (remoteText === this.shadow) return;
    // Late full state (usually a resync we answered for someone else, or recovery traffic):
    // three-way merge — replay shadow→remote as a patch on top of our local text.
    const patches = this.dmp.patch_make(this.shadow, remoteText);
    const [merged, results] = this.dmp.patch_apply(patches, this.opts.getText()) as [string, boolean[]];
    if (results.every(Boolean) && (!this.opts.validate || this.opts.validate(merged))) {
      this.shadow = remoteText;
      if (merged !== this.opts.getText()) this.opts.applyRemote(merged);
    }
  }

  private handlePatch(patchText: string): void {
    if (this.awaitingState) {
      // We can't apply patches without a shadow baseline; ask for a full state instead.
      void this.sendMessage({ kind: 'hello', client: this.clientId, seq: this.seq });
      return;
    }
    let patches: ReturnType<DiffMatchPatch['patch_fromText']>;
    try {
      patches = this.dmp.patch_fromText(patchText);
    } catch {
      return;
    }
    const [newShadow, shadowOk] = this.dmp.patch_apply(patches, this.shadow) as [string, boolean[]];
    const [newLocal, localOk] = this.dmp.patch_apply(patches, this.opts.getText()) as [string, boolean[]];
    const applied = shadowOk.every(Boolean) && localOk.every(Boolean);
    if (!applied || (this.opts.validate && !this.opts.validate(newLocal))) {
      // Divergence — fall back to a full resync rather than guessing.
      this.awaitingState = true;
      void this.sendMessage({ kind: 'hello', client: this.clientId, seq: this.seq });
      return;
    }
    this.shadow = newShadow;
    if (newLocal !== this.opts.getText()) this.opts.applyRemote(newLocal);
  }

  private flushLocal(): void {
    if (this.disposed) return;
    const text = this.opts.getText();
    if (text === this.shadow) return;
    // Editing before any state arrived makes this client a content source for the room.
    this.awaitingState = false;
    const patches = this.dmp.patch_make(this.shadow, text);
    this.shadow = text;
    void this.sendMessage({
      kind: 'patch',
      client: this.clientId,
      seq: ++this.seq,
      patches: this.dmp.patch_toText(patches),
    });
  }
}
