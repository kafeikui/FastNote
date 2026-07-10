import { useEffect, useRef, useState } from 'react';
import type { AiMessage, AiSessionNode } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';
import { MarkdownView } from './MarkdownView';

interface AiWorkbenchProps {
  session: AiSessionNode;
  /** False until an Anthropic API key has been saved in this vault's settings. */
  configured: boolean;
  /** Streams a completion for the given history; resolves with the full reply text. */
  sendMessage: (
    messages: AiMessage[],
    onDelta: (text: string) => void,
    signal: AbortSignal,
  ) => Promise<string>;
  onMessagesChange: (sessionId: string, messages: AiMessage[]) => void;
  onOpenSettings: () => void;
}

export function AiWorkbench({
  session,
  configured,
  sendMessage,
  onMessagesChange,
  onOpenSettings,
}: AiWorkbenchProps) {
  const t = useT();
  const [draft, setDraft] = useState('');
  // Assistant message display: rendered markdown (default) vs. raw source text.
  const [showSource, setShowSource] = useState(false);
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Abort an in-flight stream when switching sessions or unmounting.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [session.messages.length, streamingText]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || sending || !configured) return;
    const userMsg: AiMessage = { role: 'user', content: text, ts: new Date().toISOString() };
    const base = [...session.messages, userMsg];
    onMessagesChange(session.id, base);
    setDraft('');
    setSending(true);
    setStreamingText('');
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    let acc = '';
    try {
      const full = await sendMessage(
        base,
        (delta) => {
          acc += delta;
          setStreamingText(acc);
        },
        ac.signal,
      );
      const finalText = full || acc;
      if (finalText) {
        onMessagesChange(session.id, [
          ...base,
          { role: 'assistant', content: finalText, ts: new Date().toISOString() },
        ]);
      }
    } catch (err) {
      // A user-initiated stop keeps whatever partial text already streamed in.
      if (acc) {
        onMessagesChange(session.id, [
          ...base,
          { role: 'assistant', content: acc, ts: new Date().toISOString() },
        ]);
      }
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSending(false);
      setStreamingText(null);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
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
      <div className="fn-ai-workbench__messages">
        {session.messages.length === 0 && streamingText === null && (
          <p className="fn-ai-workbench__empty">
            {configured ? t('aiWorkbench.emptyHint') : t('aiWorkbench.notConfigured')}
          </p>
        )}
        {session.messages.map((m, i) => (
          <div
            key={`${m.ts}-${i}`}
            className={`fn-ai-msg fn-ai-msg--${m.role}`}
          >
            <span className="fn-ai-msg__role">
              {m.role === 'user' ? t('aiWorkbench.roleUser') : t('aiWorkbench.roleAssistant')}
            </span>
            {m.role === 'assistant' ? (
              renderAssistantBody(m.content)
            ) : (
              <div className="fn-ai-msg__body fn-ai-msg__body--plain">{m.content}</div>
            )}
          </div>
        ))}
        {streamingText !== null && (
          <div className="fn-ai-msg fn-ai-msg--assistant fn-ai-msg--streaming">
            <span className="fn-ai-msg__role">{t('aiWorkbench.roleAssistant')}</span>
            {streamingText ? (
              renderAssistantBody(streamingText)
            ) : (
              <div className="fn-ai-msg__body fn-ai-msg__body--plain">{t('aiWorkbench.thinking')}</div>
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
            <textarea
              value={draft}
              placeholder={t('aiWorkbench.inputPlaceholder')}
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            {sending ? (
              <button type="button" onClick={handleStop}>
                {t('aiWorkbench.stop')}
              </button>
            ) : (
              <button type="button" disabled={!draft.trim()} onClick={() => void handleSend()}>
                {t('aiWorkbench.send')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
