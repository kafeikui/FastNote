import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AiAttachment, AiMessage, AiSessionNode } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';
import { MarkdownView, renderMarkdownHtml } from './MarkdownView';

/** Splits plain text into React nodes with query occurrences wrapped in find-marks. */
function renderHighlightedText(text: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let pos = 0;
  let i = lower.indexOf(q);
  let key = 0;
  while (i !== -1) {
    if (i > pos) parts.push(text.slice(pos, i));
    parts.push(
      <mark key={key++} className="fn-ai-find-mark">
        {text.slice(i, i + q.length)}
      </mark>,
    );
    pos = i + q.length;
    i = lower.indexOf(q, pos);
  }
  parts.push(text.slice(pos));
  return parts;
}

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
  /** Server-side web searches performed so far for this session's in-flight reply. */
  streamingWebSearches?: number;
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
  /** Creates a note from the given messages (a Q&A range or the whole session). */
  onConvertToNote: (messages: AiMessage[]) => void;
  onOpenSettings: () => void;
  /**
   * Ctrl+F forwarded from the app layer: each nonce bump opens/refocuses the in-session find
   * bar, pre-filled with `query` (the current text selection) when non-empty.
   */
  findRequest?: { nonce: number; query: string } | null;
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
function downloadText(fileName: string, text: string, mime = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Wraps rendered HTML in a Word-compatible shell; saved as .doc it opens directly in
 * Word/WPS/Pages (the classic HTML-with-msword-MIME trick — no native .docx dependency).
 */
function buildWordDocument(title: string, bodyHtml: string): string {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title>
<style>
body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 12pt; line-height: 1.6; }
pre, code { font-family: Consolas, Menlo, monospace; font-size: 10.5pt; background: #f4f4f4; }
pre { padding: 8pt; }
table { border-collapse: collapse; }
th, td { border: 1pt solid #999; padding: 3pt 6pt; }
blockquote { border-left: 3pt solid #ccc; margin-left: 0; padding-left: 8pt; color: #555; }
</style></head>
<body>${bodyHtml}</body></html>`;
}

export function AiWorkbench({
  session,
  configured,
  streamingText,
  streamingThinkingChars = 0,
  streamingWebSearches = 0,
  streamingStartedAt = null,
  busy,
  error,
  onSend,
  onStop,
  onDeleteMessage,
  prepareAttachment,
  onConvertToNote,
  onOpenSettings,
  findRequest = null,
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

  // In-session find. Navigation is occurrence-level over the <mark> elements injected below —
  // navigating by message and centering the (possibly very tall) message element made "next"
  // appear to jump to unrelated places.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  // Mirrors of the current occurrence for the counter display; findIdxRef is the source of
  // truth (the mark list lives outside React state).
  const [findIdx, setFindIdx] = useState(0);
  const [findTotal, setFindTotal] = useState(0);
  const findIdxRef = useRef(0);
  const findMarksRef = useRef<HTMLElement[]>([]);
  const lastFindQueryRef = useRef('');
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!findRequest) return;
    setFindOpen(true);
    if (findRequest.query) setFindQuery(findRequest.query);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each Ctrl+F bumps the nonce
  }, [findRequest?.nonce]);

  useEffect(() => {
    setFindOpen(false);
    setFindQuery('');
    setFindIdx(0);
    setFindTotal(0);
    findIdxRef.current = 0;
    lastFindQueryRef.current = '';
  }, [session.id]);

  /** Visible find-marks in DOM (= chronological) order. */
  const collectFindMarks = (): HTMLElement[] => {
    const root = messagesRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('mark.fn-ai-find-mark')).filter(
      (m) => m.getClientRects().length > 0,
    );
  };

  /** Centers a mark by scrolling the messages container directly (scrollIntoView proved
   *  unreliable here — it silently did nothing in the rendered-markdown view). */
  const scrollFindMarkIntoView = (mark: HTMLElement) => {
    const container = messagesRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const mRect = mark.getBoundingClientRect();
    container.scrollTop += mRect.top - cRect.top - (container.clientHeight - mRect.height) / 2;
  };

  const applyCurrentFindMark = (idx: number, scroll: boolean) => {
    const marks = findMarksRef.current;
    marks.forEach((m, i) => m.classList.toggle('fn-ai-find-mark--current', i === idx));
    if (scroll && marks[idx]) scrollFindMarkIntoView(marks[idx]);
  };

  const stepFind = (dir: 1 | -1) => {
    // Re-collect on every step: a re-render since the last collection may have replaced the
    // mark elements, leaving the cached list pointing at detached nodes.
    const marks = collectFindMarks();
    findMarksRef.current = marks;
    setFindTotal(marks.length);
    if (marks.length === 0) return;
    const idx = (Math.min(findIdxRef.current, marks.length - 1) + dir + marks.length) % marks.length;
    findIdxRef.current = idx;
    setFindIdx(idx);
    applyCurrentFindMark(idx, true);
  };

  // The marks themselves are rendered by React (highlightQuery / renderHighlightedText below) —
  // mutating the DOM after render proved unreliable against reconciliation. This effect only
  // collects the rendered marks in DOM (= chronological) order for navigation, filtering out
  // invisible ones (scrollIntoView on them is a no-op). It only auto-scrolls when the query
  // itself changed, so streaming re-renders don't yank the viewport around.
  useEffect(() => {
    const root = messagesRef.current;
    const q = findOpen ? findQuery.trim() : '';
    const isNewQuery = q !== lastFindQueryRef.current;
    lastFindQueryRef.current = q;
    if (isNewQuery) findIdxRef.current = 0;
    if (!root || !q) {
      findMarksRef.current = [];
      setFindTotal(0);
      setFindIdx(0);
      return;
    }
    const marks = collectFindMarks();
    findMarksRef.current = marks;
    const idx = Math.min(findIdxRef.current, Math.max(marks.length - 1, 0));
    findIdxRef.current = idx;
    setFindTotal(marks.length);
    setFindIdx(idx);
    applyCurrentFindMark(idx, isNewQuery && marks.length > 0);
  }, [findOpen, findQuery, session.messages, showSource, streamingText]);

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

  /** Which message's export menu (md / Word) is open, if any. */
  const [exportMenuIdx, setExportMenuIdx] = useState<number | null>(null);

  const exportMessage = (m: AiMessage, index: number, format: 'md' | 'doc') => {
    setExportMenuIdx(null);
    const stamp = m.ts.replace(/[:T]/g, '-').slice(0, 19);
    const role = m.role === 'user' ? 'request' : 'response';
    let body = m.content;
    if (m.attachments?.length) {
      const names = m.attachments.map((a) => `- ${a.name}`).join('\n');
      body = `${t('aiWorkbench.attachmentsHeading')}\n${names}\n\n${body}`;
    }
    const baseName = `${session.title || 'ai'}-${role}-${index + 1}-${stamp}`;
    if (format === 'md') {
      downloadText(`${baseName}.md`, body);
      return;
    }
    // Word export: math stays as TeX source in <code> — KaTeX HTML is unreadable without its
    // stylesheet/fonts, which a standalone document doesn't carry.
    const html = buildWordDocument(baseName, renderMarkdownHtml(body, { mathAsTex: true }));
    downloadText(`${baseName}.doc`, html, 'application/msword');
  };

  const handleDelete = (index: number) => {
    if (!confirm(t('aiWorkbench.confirmDeleteMessage'))) return;
    onDeleteMessage(index);
  };

  // Convert-to-note dialog. A "Q&A pair" is a user message plus every assistant reply that
  // follows it (up to the next user message); ranges are selected in those units.
  const [convertOpen, setConvertOpen] = useState(false);
  const [convertMode, setConvertMode] = useState<'all' | 'range'>('all');
  const [convertFrom, setConvertFrom] = useState(1);
  const [convertTo, setConvertTo] = useState(1);
  const pairStartIndices = session.messages
    .map((m, i) => (m.role === 'user' ? i : -1))
    .filter((i) => i !== -1);
  const pairCount = pairStartIndices.length;

  const openConvert = () => {
    setConvertMode('all');
    setConvertFrom(1);
    setConvertTo(Math.max(1, pairCount));
    setConvertOpen(true);
  };

  const handleConvert = () => {
    let messages: AiMessage[];
    if (convertMode === 'all' || pairCount === 0) {
      messages = session.messages;
    } else {
      const from = Math.max(1, Math.min(pairCount, Math.min(convertFrom, convertTo)));
      const to = Math.max(1, Math.min(pairCount, Math.max(convertFrom, convertTo)));
      const start = pairStartIndices[from - 1];
      const end = to < pairCount ? pairStartIndices[to] : session.messages.length;
      messages = session.messages.slice(start, end);
    }
    if (messages.length === 0) return;
    setConvertOpen(false);
    onConvertToNote(messages);
  };

  // Query currently being highlighted in message bodies (empty when the find bar is closed).
  const findActiveQuery = findOpen ? findQuery.trim() : '';

  const renderAssistantBody = (content: string) =>
    showSource ? (
      <pre className="fn-ai-msg__body fn-ai-msg__body--source">
        {findActiveQuery ? renderHighlightedText(content, findActiveQuery) : content}
      </pre>
    ) : (
      <MarkdownView
        markdown={content}
        className="fn-ai-msg__body"
        highlightQuery={findActiveQuery || undefined}
      />
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
        <button
          type="button"
          className="fn-ai-workbench__tonote"
          title={t('aiWorkbench.toNote')}
          disabled={session.messages.length === 0}
          onClick={openConvert}
        >
          📝 {t('aiWorkbench.toNote')}
        </button>
      </div>
      {findOpen && (
        <div className="fn-ai-findbar">
          <input
            ref={findInputRef}
            value={findQuery}
            placeholder={t('findReplace.findPlaceholder')}
            onChange={(e) => {
              setFindQuery(e.target.value);
              setFindIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stepFind(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setFindOpen(false);
              }
            }}
          />
          <span className="fn-ai-findbar__count">
            {findQuery.trim()
              ? findTotal > 0
                ? `${findIdx + 1}/${findTotal}`
                : t('findReplace.noMatches')
              : ''}
          </span>
          <button type="button" title={t('findReplace.prev')} disabled={findTotal === 0} onClick={() => stepFind(-1)}>
            ↑
          </button>
          <button type="button" title={t('findReplace.next')} disabled={findTotal === 0} onClick={() => stepFind(1)}>
            ↓
          </button>
          <button type="button" title={t('findReplace.close')} onClick={() => setFindOpen(false)}>
            ×
          </button>
        </div>
      )}
      {convertOpen && (
        <div className="fn-modal-backdrop" onClick={() => setConvertOpen(false)}>
          <div className="fn-modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t('aiWorkbench.toNoteTitle')}</h2>
            <p className="fn-field__hint">{t('aiWorkbench.toNotePairs', { count: String(pairCount) })}</p>
            <label className="fn-checkbox">
              <input
                type="radio"
                name="fn-ai-tonote-mode"
                checked={convertMode === 'all'}
                onChange={() => setConvertMode('all')}
              />
              <span>{t('aiWorkbench.toNoteAll')}</span>
            </label>
            <label className="fn-checkbox">
              <input
                type="radio"
                name="fn-ai-tonote-mode"
                checked={convertMode === 'range'}
                disabled={pairCount === 0}
                onChange={() => setConvertMode('range')}
              />
              <span>{t('aiWorkbench.toNoteRange')}</span>
            </label>
            {convertMode === 'range' && (
              <div className="fn-ai-tonote__range">
                <input
                  type="number"
                  min={1}
                  max={pairCount}
                  value={convertFrom}
                  onChange={(e) => setConvertFrom(Number(e.target.value) || 1)}
                />
                <span>—</span>
                <input
                  type="number"
                  min={1}
                  max={pairCount}
                  value={convertTo}
                  onChange={(e) => setConvertTo(Number(e.target.value) || 1)}
                />
              </div>
            )}
            <div className="fn-modal__actions">
              <button type="button" onClick={handleConvert}>
                {t('aiWorkbench.toNoteCreate')}
              </button>
              <button type="button" onClick={() => setConvertOpen(false)}>
                {t('aiWorkbench.toNoteCancel')}
              </button>
            </div>
          </div>
        </div>
      )}
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
              <span className="fn-ai-msg__export-wrap">
                <button
                  type="button"
                  title={t('aiWorkbench.exportMessage')}
                  onClick={() => setExportMenuIdx((cur) => (cur === i ? null : i))}
                >
                  ⇩
                </button>
                {exportMenuIdx === i && (
                  <span className="fn-ai-msg__export-menu">
                    <button type="button" onClick={() => exportMessage(m, i, 'md')}>
                      {t('aiWorkbench.exportAsMd')}
                    </button>
                    <button type="button" onClick={() => exportMessage(m, i, 'doc')}>
                      {t('aiWorkbench.exportAsDoc')}
                    </button>
                  </span>
                )}
              </span>
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
              <div className="fn-ai-msg__body fn-ai-msg__body--plain">
                {findActiveQuery ? renderHighlightedText(m.content, findActiveQuery) : m.content}
              </div>
            )}
          </div>
        ))}
        {streamingHere && (
          <div className="fn-ai-msg fn-ai-msg--assistant fn-ai-msg--streaming">
            <span className="fn-ai-msg__role">{t('aiWorkbench.roleAssistant')}</span>
            {streamingText ? (
              <>
                {renderAssistantBody(streamingText)}
                {streamingWebSearches > 0 && (
                  <div className="fn-ai-msg__websearch">
                    {t('aiWorkbench.webSearched', { count: String(streamingWebSearches) })}
                  </div>
                )}
              </>
            ) : (
              <div className="fn-ai-msg__body fn-ai-msg__body--plain">
                {streamingWebSearches > 0
                  ? t('aiWorkbench.webSearching', { count: String(streamingWebSearches) })
                  : patienceDue
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
