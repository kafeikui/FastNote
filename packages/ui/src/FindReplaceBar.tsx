import { useEffect, useRef, useState } from 'react';
import type { FindReplaceController, FindReplaceStatus } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

interface FindReplaceBarProps {
  /** Getter (not a captured instance): the controller changes when the editor mode switches. */
  getController: () => FindReplaceController | null;
  onClose: () => void;
}

export function FindReplaceBar({ getController, onClose }: FindReplaceBarProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [status, setStatus] = useState<FindReplaceStatus>({ total: 0, current: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

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
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={t('findReplace.findPlaceholder')}
          onChange={(e) => runSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              step(e.shiftKey ? 'prev' : 'next');
            }
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
        <input
          type="text"
          value={replacement}
          placeholder={t('findReplace.replacePlaceholder')}
          onChange={(e) => setReplacement(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleReplace();
            }
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
