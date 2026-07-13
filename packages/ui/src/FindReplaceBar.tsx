import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { FindReplaceController, FindReplaceStatus } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

/** Inserts '\n' at the caret of a find-bar textarea (Enter itself is taken by next/replace). */
function insertNewlineAtCaret(el: HTMLTextAreaElement, value: string, set: (v: string) => void) {
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  set(value.slice(0, start) + '\n' + value.slice(end));
  requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1));
}

interface FindReplaceBarProps {
  /** Getter (not a captured instance): the controller changes when the editor mode switches. */
  getController: () => FindReplaceController | null;
  /** Pre-filled query, searched as soon as the controller is available (selection / global search). */
  initialQuery?: string;
  /** Bumped by the host to refocus an already-open bar (and reload initialQuery, if any). */
  focusNonce?: number;
  onClose: () => void;
}

export function FindReplaceBar({ getController, initialQuery, focusNonce = 0, onClose }: FindReplaceBarProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [status, setStatus] = useState<FindReplaceStatus>({ total: 0, current: 0 });
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus (on mount and whenever the host re-triggers find) and run the initial query once the
  // editor has registered its controller. The bar can mount in the same commit that switches the
  // editor to source mode, so the controller may not exist yet — poll briefly instead of
  // searching into the void.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    if (!initialQuery) return;
    setQuery(initialQuery);
    let cancelled = false;
    let tries = 0;
    const attempt = () => {
      if (cancelled) return;
      const ctrl = getController();
      if (ctrl) {
        setStatus(ctrl.search(initialQuery));
        return;
      }
      if (++tries < 20) window.setTimeout(attempt, 120);
    };
    attempt();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount + explicit refocus requests
  }, [focusNonce]);

  const handleClose = () => {
    getController()?.close();
    onClose();
  };

  const runSearch = (q: string) => {
    setQuery(q);
    const ctrl = getController();
    setStatus(ctrl ? ctrl.search(q) : { total: 0, current: 0 });
  };

  const step = (dir: 'next' | 'prev') => {
    const ctrl = getController();
    if (!ctrl) return;
    setStatus(dir === 'next' ? ctrl.next() : ctrl.prev());
  };

  const handleReplace = () => {
    const ctrl = getController();
    if (!ctrl || !query) return;
    setStatus(ctrl.replace(replacement));
  };

  const handleReplaceAll = () => {
    const ctrl = getController();
    if (!ctrl || !query) return;
    ctrl.replaceAll(replacement);
    setStatus(ctrl.search(query));
  };

  return (
    <div
      className="fn-findbar"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          handleClose();
        }
      }}
    >
      <div className="fn-findbar__row">
        <textarea
          ref={inputRef}
          rows={Math.max(1, query.split('\n').length)}
          value={query}
          placeholder={t('findReplace.findPlaceholder')}
          title={t('findReplace.multilineHint')}
          onChange={(e) => runSearch(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
              insertNewlineAtCaret(e.currentTarget, query, runSearch);
              return;
            }
            step(e.shiftKey ? 'prev' : 'next');
          }}
        />
        <span className="fn-findbar__count">
          {query ? (status.total > 0 ? `${status.current}/${status.total}` : t('findReplace.noMatches')) : ''}
        </span>
        <button type="button" title={t('findReplace.prev')} disabled={status.total === 0} onClick={() => step('prev')}>
          ↑
        </button>
        <button type="button" title={t('findReplace.next')} disabled={status.total === 0} onClick={() => step('next')}>
          ↓
        </button>
        <button type="button" title={t('findReplace.close')} onClick={handleClose}>
          ×
        </button>
      </div>
      <div className="fn-findbar__row">
        <textarea
          rows={Math.max(1, replacement.split('\n').length)}
          value={replacement}
          placeholder={t('findReplace.replacePlaceholder')}
          title={t('findReplace.multilineHint')}
          onChange={(e) => setReplacement(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
              insertNewlineAtCaret(e.currentTarget, replacement, setReplacement);
              return;
            }
            handleReplace();
          }}
        />
        <button type="button" disabled={status.total === 0} onClick={handleReplace}>
          {t('findReplace.replace')}
        </button>
        <button type="button" disabled={status.total === 0} onClick={handleReplaceAll}>
          {t('findReplace.replaceAll')}
        </button>
      </div>
    </div>
  );
}
