import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatAttachmentRef, ChatMessage } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';
import { ChatAttachmentContent } from './ChatAttachmentContent';

const SCROLL_BOTTOM_THRESHOLD = 48;

interface ChatPanelProps {
  messages: ChatMessage[];
  activePeerId: string | null;
  activePeerName: string | null;
  onSend: (body: string, files: File[]) => void | Promise<void>;
  onDeleteMessage: (messageId: string) => void | Promise<void>;
  onDownloadAttachment: (attachmentId: string) => void | Promise<void>;
  onEditAttachment: (attachmentId: string, description: string) => void | Promise<void>;
  onRemoveAttachment: (messageId: string, attachmentId: string) => void | Promise<void>;
  onLoadAttachmentPreview?: (attachmentId: string) => Promise<Blob | null>;
}

export function ChatPanel({
  messages,
  activePeerId,
  activePeerName,
  onSend,
  onDeleteMessage,
  onDownloadAttachment,
  onEditAttachment,
  onRemoveAttachment,
  onLoadAttachmentPreview,
}: ChatPanelProps) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const isAtBottomRef = useRef(true);
  const prevThreadLenRef = useRef(0);
  const prevPeerRef = useRef<string | null>(null);
  // Custom right-click menu on a message bubble ("copy full message").
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; msg: ChatMessage } | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  const copyFullMessage = (msg: ChatMessage) => {
    const parts = [msg.body ?? ''];
    for (const att of msg.attachments ?? []) parts.push(`📎 ${att.fileName}`);
    const text = parts.filter(Boolean).join('\n');
    if (!text) return;
    // execCommand keeps working where the async clipboard API is permission-blocked (Electron).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  };

  const thread = messages.filter((m) => m.peerId === activePeerId);

  const isNearBottom = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    isAtBottomRef.current = true;
    setShowNewMessages(false);
  }, []);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = isNearBottom();
      isAtBottomRef.current = atBottom;
      if (atBottom) setShowNewMessages(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [activePeerId, isNearBottom]);

  useEffect(() => {
    if (prevPeerRef.current !== activePeerId) {
      prevPeerRef.current = activePeerId;
      prevThreadLenRef.current = 0;
      isAtBottomRef.current = true;
      setShowNewMessages(false);
      requestAnimationFrame(() => scrollToBottom('auto'));
      return;
    }

    const prevLen = prevThreadLenRef.current;
    const newLen = thread.length;
    if (newLen === prevLen) return;

    const added = newLen > prevLen;
    prevThreadLenRef.current = newLen;

    if (!added) return;

    if (isAtBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom(prevLen === 0 ? 'auto' : 'smooth'));
    } else {
      const last = thread[thread.length - 1];
      if (last?.direction === 'in') {
        setShowNewMessages(true);
      }
    }
  }, [thread, activePeerId, scrollToBottom]);

  async function handleSend() {
    if (!activePeerId || sending) return;
    if (!draft.trim() && pendingFiles.length === 0) return;
    setSending(true);
    setError(null);
    try {
      await onSend(draft.trim(), pendingFiles);
      setDraft('');
      setPendingFiles([]);
      resetFileInput();
      isAtBottomRef.current = true;
      requestAnimationFrame(() => scrollToBottom('smooth'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('chatPanel.sendFailed'));
    } finally {
      setSending(false);
    }
  }

  function resetFileInput() {
    if (fileRef.current) fileRef.current.value = '';
  }

  function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setPendingFiles((prev) => [...prev, ...Array.from(files)]);
    resetFileInput();
  }

  function removePendingFile(index: number) {
    setPendingFiles((prev) => prev.filter((_, j) => j !== index));
    resetFileInput();
  }

  return (
    <div className="fn-chat">
      <div className="fn-chat__header">
        {activePeerName ? t('chatPanel.conversationWith', { name: activePeerName }) : t('chatPanel.selectOrStart')}
      </div>
      <div className="fn-chat__messages-wrap">
        {showNewMessages && (
          <button
            type="button"
            className="fn-chat__new-msg-badge"
            onClick={() => scrollToBottom('smooth')}
          >
            {t('chatPanel.newMessageBadge')}
          </button>
        )}
        <div ref={messagesRef} className="fn-chat__messages">
          {!activePeerId ? (
            <p className="fn-chat__empty">{t('chatPanel.selectSessionHint')}</p>
          ) : thread.length === 0 ? (
            <p className="fn-chat__empty">{t('chatPanel.emptyThread')}</p>
          ) : (
            thread.map((m) => (
              <div
                key={m.id}
                className={`fn-chat__bubble fn-chat__bubble--${m.direction}${
                  !m.body && m.attachments?.length ? ' fn-chat__bubble--attachment' : ''
                }`}
                onContextMenu={(e) => {
                  // With a text selection the (desktop) native copy menu takes over; the custom
                  // "copy full message" menu handles the no-selection case.
                  if (window.getSelection()?.toString().trim()) return;
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, msg: m });
                }}
              >
                <div className="fn-chat__bubble-head">
                  <button
                    type="button"
                    className="fn-chat__delete"
                    title={t('chatPanel.deleteMessage')}
                    onClick={() => void onDeleteMessage(m.id)}
                  >
                    ×
                  </button>
                </div>
                {m.body ? <p className="fn-chat__text">{m.body}</p> : null}
                {m.attachments?.length ? (
                  <ChatAttachmentContent
                    messageId={m.id}
                    messageDirection={m.direction}
                    attachments={m.attachments}
                    onDownload={onDownloadAttachment}
                    onEdit={onEditAttachment}
                    onRemove={onRemoveAttachment}
                    onLoadPreview={onLoadAttachmentPreview}
                  />
                ) : null}
                <div className="fn-chat__bubble-foot">
                  <time>{new Date(m.sentAt).toLocaleString()}</time>
                  {m.direction === 'out' && (
                    <span
                      className={`fn-chat__status fn-chat__status--${m.status}`}
                      title={
                        m.status === 'read'
                          ? t('chatPanel.statusRead')
                          : m.status === 'delivered'
                            ? t('chatPanel.statusDelivered')
                            : t('chatPanel.statusSent')
                      }
                    >
                      {m.status === 'read' ? '✓✓' : '✓'}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      {error && <p className="fn-unlock__error">{error}</p>}
      {pendingFiles.length > 0 && (
        <div className="fn-chat__pending-files">
          {pendingFiles.map((f, i) => (
            <span key={`${f.name}-${i}`} className="fn-chat__pending-file">
              📎 {f.name}
              <button
                type="button"
                onClick={() => removePendingFile(i)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="fn-chat__composer">
        <button
          type="button"
          className="fn-chat__attach-btn"
          disabled={!activePeerId}
          title={t('chatPanel.attachBtn')}
          onClick={() => fileRef.current?.click()}
        >
          📎
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <textarea
          className="fn-chat__composer-input"
          placeholder={activePeerId ? t('chatPanel.composerPlaceholderActive') : t('chatPanel.composerPlaceholderInactive')}
          value={draft}
          disabled={!activePeerId}
          rows={1}
          onChange={(e) => {
            setDraft(e.target.value);
            // Auto-grow up to the CSS max-height, then let the textarea scroll internally.
            e.target.style.height = 'auto';
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
              // Type a literal tab character instead of moving focus.
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart ?? el.value.length;
              const end = el.selectionEnd ?? start;
              setDraft(el.value.slice(0, start) + '\t' + el.value.slice(end));
              requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1));
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void handleSend();
              (e.target as HTMLTextAreaElement).style.height = 'auto';
            }
          }}
        />
        <button type="button" disabled={!activePeerId || sending} onClick={() => void handleSend()}>
          {sending ? t('chatPanel.sending') : t('chatPanel.send')}
        </button>
      </div>
      {ctxMenu && (
        <div
          className="fn-chat__ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              copyFullMessage(ctxMenu.msg);
              setCtxMenu(null);
            }}
          >
            {t('chatPanel.copyMessage')}
          </button>
        </div>
      )}
    </div>
  );
}
