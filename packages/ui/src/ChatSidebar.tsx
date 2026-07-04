import { useMemo, useState, type FormEvent } from 'react';
import type { ChatMessage } from '@fastnote/shared';
import { useT, type TFunction } from '@fastnote/i18n';

export interface ChatSessionItem {
  peerId: string;
  peerName: string;
  lastAt: string;
  preview: string;
}

interface ChatSidebarProps {
  sessions: ChatSessionItem[];
  activePeerId: string | null;
  sessionLoggedIn: boolean;
  imConnected: boolean;
  unreadByPeer?: Record<string, number>;
  onSelectPeer: (peerId: string, peerName: string) => void;
  onStartChat: (username: string) => Promise<void>;
}

export function buildChatSessions(
  messages: ChatMessage[],
  extraPeers: Array<{ peerId: string; peerName: string }> = [],
  activePeerId: string | null | undefined,
  activePeerName: string | null | undefined,
  t: TFunction,
): ChatSessionItem[] {
  const map = new Map<string, ChatSessionItem>();
  for (const peer of extraPeers) {
    map.set(peer.peerId, {
      peerId: peer.peerId,
      peerName: peer.peerName,
      lastAt: '',
      preview: '',
    });
  }
  for (const m of messages) {
    const peerName = m.peerUsername ?? m.peerId.slice(0, 8);
    const preview =
      m.body.trim().slice(0, 48) ||
      (m.attachments?.length ? t('chatSidebar.attachmentPreview') : '');
    const existing = map.get(m.peerId);
    if (!existing || m.sentAt >= existing.lastAt) {
      map.set(m.peerId, { peerId: m.peerId, peerName, lastAt: m.sentAt, preview });
    }
  }
  if (activePeerId && activePeerName && !map.has(activePeerId)) {
    map.set(activePeerId, {
      peerId: activePeerId,
      peerName: activePeerName,
      lastAt: '',
      preview: '',
    });
  }
  return [...map.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export function ChatSidebar({
  sessions,
  activePeerId,
  sessionLoggedIn,
  imConnected,
  unreadByPeer = {},
  onSelectPeer,
  onStartChat,
}: ChatSidebarProps) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const sorted = useMemo(
    () => [...sessions].sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    [sessions],
  );

  async function handleStart(e: FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setError(null);
    setLoading(true);
    try {
      await onStartChat(username.trim());
      setUsername('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('chatSidebar.startFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fn-chat-sidebar">
      <p className="fn-unlock__hint">{t('chatSidebar.tagline')}</p>
      {!sessionLoggedIn && <p className="fn-unlock__error">{t('chatSidebar.loginRequired')}</p>}
      {sessionLoggedIn && (
        <p className={imConnected ? 'fn-unlock__hint' : 'fn-unlock__error'}>
          {imConnected ? t('chatSidebar.connected') : t('chatSidebar.disconnected')}
        </p>
      )}
      <form className="fn-chat-sidebar__start" onSubmit={handleStart}>
        <input
          placeholder={t('chatSidebar.startPlaceholder')}
          value={username}
          disabled={!sessionLoggedIn || loading}
          onChange={(e) => setUsername(e.target.value)}
        />
        <button type="submit" disabled={!sessionLoggedIn || loading || !username.trim()}>
          +
        </button>
      </form>
      {error && <p className="fn-unlock__error">{error}</p>}
      <ul className="fn-chat-sidebar__list">
        {sorted.length === 0 ? (
          <li className="fn-chat-sidebar__empty">{t('chatSidebar.empty')}</li>
        ) : (
          sorted.map((s) => (
            <li key={s.peerId}>
              <button
                type="button"
                className={`fn-chat-sidebar__item${s.peerId === activePeerId ? ' active' : ''}`}
                onClick={() => onSelectPeer(s.peerId, s.peerName)}
              >
                <span className="fn-chat-sidebar__item-head">
                  <span className="fn-chat-sidebar__name">{s.peerName}</span>
                  {(unreadByPeer[s.peerId] ?? 0) > 0 ? (
                    <span className="fn-unread-badge fn-unread-badge--sidebar">
                      {unreadByPeer[s.peerId]! > 99 ? '99+' : unreadByPeer[s.peerId]}
                    </span>
                  ) : null}
                </span>
                {s.preview ? (
                  <span className="fn-chat-sidebar__preview">{s.preview}</span>
                ) : null}
                {s.lastAt ? (
                  <time className="fn-chat-sidebar__time">
                    {new Date(s.lastAt).toLocaleString(undefined, {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                ) : null}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
