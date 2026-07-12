import { useEffect, useRef, useState } from 'react';
import type { AiAttachment, AiMessage, AiSessionNode } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';
import { MarkdownView } from './MarkdownView';

interface AiWorkbenchProps {
  session: AiSessionNode;
  /** False until an Anthropic API key has been saved in this vault's settings. */
  configured: boolean;
  /**
   * Streaming text of the in-flight reply *for this session*, or null when none. The stream
   * itself lives in the app layer, so switching sessions/views never interrupts it.
   */
  streamingText: string | null;
  /** Characters of hidden model thinking so far for this session's in-flight reply. */
  streamingThinkingChars?: number;
  /** Date.now() when this session's in-flight request was sent, or null when none. */
  streamingStartedAt?: number | null;
  /** True while any session (this one or another) has a reply in flight. */
  busy: boolean;
  error: string | null;
  onSend: (text: string, attachments: AiAttachment[]) => void;
  onStop: () => void;
  onDeleteMessage: (index: number) => void;
  /** Converts a picked file into an attachment record; rejects with a user-facing Error. */
  prepareAttachment: (file: File) => Promise<AiAttachment>;
  onOpenSettings: () => void;
}

/** How long a reply may stay text-less before "thinking…" turns into a patience message. */
const PATIENCE_AFTER_MS = 30_000;

function attachmentIcon(kind: AiAttachment['kind']): string {
  if (kind === 'image') return '🖼';
  if (kind === 'pdf') return '📄';
  return '📃';
}

/** Time of day for today's messages, full date+time for older ones (full ISO in the tooltip). */
function formatMsgTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
}

/** Blob-URL download; works in the hardened Electron renderer (no clipboard/permission APIs needed). */
function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function AiWorkbench({
  session,
  configured,
  streamingText,
  streamingThinkingChars = 0,
  streamingStartedAt = null,
  busy,
  error,
  onSend,
  onStop,
  onDeleteMessage,
  prepareAttachment,
  onOpenSettings,
}: AiWorkbenchProps) {
  const t = useT();
  const [draft, setDraft] = useState('');
  // Assistant message display: rendered markdown (default) vs. raw source text.
  const [showSource, setShowSource] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<AiAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  // Follow the stream only while the user is already at the bottom; scrolling up to read
  // earlier messages must not be fought by the auto-scroll. Re-armed by scrolling back down.
  const stickToBottomRef = useRef(true);

  const handleMessagesScroll = () => {
    const el = messagesRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    // Entering a session always starts at its latest message.
    stickToBottomRef.current = true;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [session.id]);

  useEffect(() => {
    if (stickToBottomRef.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [session.messages.length, streamingText]);

  const streamingHere = streamingText !== null;
  const busyElsewhere = busy && !streamingHere;

  // True once an in-flight reply has produced no visible text for PATIENCE_AFTER_MS; swaps the
  // "thinking…" placeholder for a calmer long-wait message. Keyed to the request start time from
  // the app layer, so re-entering the session mid-run shows the right state immediately.
  const [patienceDue, setPatienceDue] = useState(false);
  useEffect(() => {
    if (!streamingHere || streamingText || streamingStartedAt === null) {
      setPatienceDue(false);
      return;
    }
    const remaining = streamingStartedAt + PATIENCE_AFTER_MS - Date.now();
    if (remaining <= 0) {
      setPatienceDue(true);
      return;
    }
    setPatienceDue(false);
    const timer = setTimeout(() => setPatienceDue(true), remaining);
    return () => clearTimeout(timer);
  }, [streamingHere, streamingText, streamingStartedAt]);

  const handleSend = () => {
    const text = draft.trim();
    if ((!text && pendingAttachments.length === 0) || busy || !configured) return;
    onSend(text, pendingAttachments);
    setDraft('');
    setPendingAttachments([]);
  };

  const handleFilesPicked = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAttaching(true);
    try {
      for (const file of Array.from(files)) {
        try {
          const att = await prepareAttachment(file);
          setPendingAttachments((prev) => [...prev, att]);
        } catch (err) {
          alert(err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const exportMessage = (m: AiMessage, index: number) => {
    const stamp = m.ts.replace(/[:T]/g, '-').slice(0, 19);
    const role = m.role === 'user' ? 'request' : 'response';
    let body = m.content;
    if (m.attachments?.length) {
      const names = m.attachments.map((a) => `- ${a.name}`).join('\n');
      body = `${t('aiWorkbench.attachmentsHeading')}\n${names}\n\n${body}`;
    }
    downloadText(`${session.title || 'ai'}-${role}-${index + 1}-${stamp}.md`, body);
  };

  const handleDelete = (index: number) => {
    if (!confirm(t('aiWorkbench.confirmDeleteMessage'))) return;
    onDeleteMessage(index);
  };

  const renderAssistantBody = (content: string) =>
    showSource ? (
      <pre className="fn-ai-msg__body fn-ai-msg__body--source">{content}</pre>
    ) : (
      <MarkdownView markdown={content} className="fn-ai-msg__body" />
    );

  return (
    <div className="fn-ai-workbench">
      <div className="fn-ai-workbench__header">
        <span className="fn-ai-workbench__title" title={session.title}>
          {session.title}
        </span>
        <div className="fn-ai-workbench__viewmode">
          <button type="button" className={!showSource ? 'active' : ''} onClick={() => setShowSource(false)}>
            {t('aiWorkbench.viewRendered')}
          </button>
          <button type="button" className={showSource ? 'active' : ''} onClick={() => setShowSource(true)}>
            {t('aiWorkbench.viewSource')}
          </button>
        </div>
      </div>
      <div className="fn-ai-workbench__messages" ref={messagesRef} onScroll={handleMessagesScroll}>
        {session.messages.length === 0 && !streamingHere && (
          <p className="fn-ai-workbench__empty">
            {configured ? t('aiWorkbench.emptyHint') : t('aiWorkbench.notConfigured')}
          </p>
        )}
        {session.messages.map((m, i) => (
          <div
            key={`${m.ts}-${i}`}
            className={`fn-ai-msg fn-ai-msg--${m.role}`}
          >
            <div className="fn-ai-msg__meta">
              <span className="fn-ai-msg__role">
                {m.role === 'user' ? t('aiWorkbench.roleUser') : t('aiWorkbench.roleAssistant')}
              </span>
              {m.role === 'user' ? (
                <span className="fn-ai-msg__time" title={m.ts}>
                  {t('aiWorkbench.sentAt')} {formatMsgTime(m.ts)}
                </span>
              ) : (
                <span
                  className="fn-ai-msg__time"
                  title={m.startedTs ? `${m.startedTs} → ${m.ts}` : m.ts}
                >
                  {m.startedTs ? `${t('aiWorkbench.recvStartAt')} ${formatMsgTime(m.startedTs)} · ` : ''}
                  {t('aiWorkbench.recvEndAt')} {formatMsgTime(m.ts)}
                </span>
              )}
            </div>
            <span className="fn-ai-msg__actions">
              <button type="button" title={t('aiWorkbench.exportMessage')} onClick={() => exportMessage(m, i)}>
                ⇩
              </button>
              <button type="button" title={t('aiWorkbench.deleteMessage')} onClick={() => handleDelete(i)}>
                ×
              </button>
            </span>
            {m.attachments && m.attachments.length > 0 && (
              <div className="fn-ai-msg__attachments">
                {m.attachments.map((a) => (
                  <span key={a.id} className="fn-ai-attachment-chip" title={a.name}>
                    {attachmentIcon(a.kind)} {a.name}
                  </span>
                ))}
              </div>
            )}
            {m.role === 'assistant' ? (
              renderAssistantBody(m.content)
            ) : (
              <div className="fn-ai-msg__body fn-ai-msg__body--plain">{m.content}</div>
            )}
          </div>
        ))}
        {streamingHere && (
          <div className="fn-ai-msg fn-ai-msg--assistant fn-ai-msg--streaming">
            <span className="fn-ai-msg__role">{t('aiWorkbench.roleAssistant')}</span>
            {streamingText ? (
              renderAssistantBody(streamingText)
            ) : (
              <div className="fn-ai-msg__body fn-ai-msg__body--plain">
                {patienceDue
                  ? streamingThinkingChars > 0
                    ? t('aiWorkbench.patienceThinking', { chars: String(streamingThinkingChars) })
                    : t('aiWorkbench.patience')
                  : streamingThinkingChars > 0
                    ? t('aiWorkbench.thinkingDeep', { chars: String(streamingThinkingChars) })
                    : t('aiWorkbench.thinking')}
              </div>
            )}
          </div>
        )}
        {error && <p className="fn-ai-workbench__error">{error}</p>}
        <div ref={bottomRef} />
      </div>
      <div className="fn-ai-workbench__composer">
        {!configured ? (
          <button type="button" className="fn-ai-workbench__configure" onClick={onOpenSettings}>
            {t('aiWorkbench.openSettings')}
          </button>
        ) : (
          <>
            {pendingAttachments.length > 0 && (
              <div className="fn-ai-composer__attachments">
                {pendingAttachments.map((a) => (
                  <span key={a.id} className="fn-ai-attachment-chip" title={a.name}>
                    {attachmentIcon(a.kind)} {a.name}
                    <button
                      type="button"
                      title={t('aiWorkbench.removeAttachment')}
                      onClick={() => setPendingAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {busyElsewhere && <p className="fn-ai-workbench__busy-hint">{t('aiWorkbench.busyElsewhere')}</p>}
            <textarea
              value={draft}
              placeholder={t('aiWorkbench.inputPlaceholder')}
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <div className="fn-ai-composer__buttons">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.doc,.docx,.txt,.md,.csv,.json,.log,text/*"
                onChange={(e) => void handleFilesPicked(e.target.files)}
              />
              <button
                type="button"
                title={t('aiWorkbench.attach')}
                disabled={attaching}
                onClick={() => fileInputRef.current?.click()}
              >
                📎
              </button>
              {streamingHere ? (
                <button type="button" onClick={onStop}>
                  {t('aiWorkbench.stop')}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy || attaching || (!draft.trim() && pendingAttachments.length === 0)}
                  onClick={handleSend}
                >
                  {t('aiWorkbench.send')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
