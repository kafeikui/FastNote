import type { ChatAttachmentRef, ChatMessage } from './index';

export interface ChatWireAttachment extends ChatAttachmentRef {
  dataB64: string;
}

export interface ChatWirePayload {
  v: 1;
  body: string;
  peerUsername?: string;
  attachments?: ChatWireAttachment[];
  status?: ChatMessage['status'];
}

export interface ChatStoredPayload {
  v: 1;
  body: string;
  peerUsername?: string;
  attachments?: ChatAttachmentRef[];
  status?: ChatMessage['status'];
}

function normalizeWireAttachment(raw: unknown): ChatWireAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const att = raw as Partial<ChatWireAttachment>;
  if (typeof att.dataB64 !== 'string' || !att.dataB64) return null;
  return {
    id: typeof att.id === 'string' && att.id ? att.id : crypto.randomUUID(),
    fileName: typeof att.fileName === 'string' && att.fileName ? att.fileName : 'file',
    description: typeof att.description === 'string' ? att.description : '',
    mimeType: typeof att.mimeType === 'string' && att.mimeType ? att.mimeType : 'application/octet-stream',
    size: typeof att.size === 'number' ? att.size : 0,
    dataB64: att.dataB64,
  };
}

export function encodeChatWire(payload: ChatWirePayload): string {
  return JSON.stringify(payload);
}

export function decodeChatWire(plaintext: string): ChatWirePayload {
  try {
    const parsed = JSON.parse(plaintext) as Partial<ChatWirePayload>;
    if (parsed?.v === 1 && typeof parsed.body === 'string') {
      const attachments = Array.isArray(parsed.attachments)
        ? parsed.attachments.map(normalizeWireAttachment).filter((a): a is ChatWireAttachment => a !== null)
        : [];
      return {
        v: 1,
        body: parsed.body,
        peerUsername: parsed.peerUsername,
        attachments,
        status: parsed.status,
      };
    }
  } catch {
    /* plain text legacy */
  }
  return { v: 1, body: plaintext, attachments: [] };
}

export function toStoredPayload(wire: ChatWirePayload, refs: ChatAttachmentRef[]): ChatStoredPayload {
  return {
    v: 1,
    body: wire.body,
    peerUsername: wire.peerUsername,
    attachments: refs,
    status: wire.status,
  };
}

export function storedToChatMessage(
  id: string,
  peerId: string,
  direction: ChatMessage['direction'],
  sentAt: string,
  stored: ChatStoredPayload,
): ChatMessage {
  return {
    id,
    peerId,
    peerUsername: stored.peerUsername,
    direction,
    body: stored.body,
    attachments: stored.attachments ?? [],
    sentAt,
    status: stored.status ?? (direction === 'out' ? 'sent' : 'delivered'),
  };
}
