import { useState } from 'react';
import type { LogEntry } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

interface LogsModalProps {
  entries: readonly LogEntry[];
  onClose: () => void;
  onClear: () => void;
  /** Pre-formatted plain text of all entries, for copy/download. */
  formatted: string;
}

function downloadText(text: string, fileName: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function LogsModal({ entries, onClose, onClear, formatted }: LogsModalProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    // Deliberately not navigator.clipboard.writeText: the hardened Electron build denies all
    // permission requests (including clipboard write), so we use the permissionless
    // selection-based copy everywhere.
    const ta = document.createElement('textarea');
    ta.value = formatted;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } finally {
      ta.remove();
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      console.error('copy logs failed: execCommand copy rejected');
    }
  };

  const handleDownload = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadText(formatted, `fastnote-logs-${stamp}.txt`);
  };

  return (
    <div className="fn-modal-backdrop" onClick={onClose}>
      <div className="fn-modal fn-logs" onClick={(e) => e.stopPropagation()}>
        <h2>{t('logsModal.title')}</h2>
        <p className="fn-unlock__hint">{t('logsModal.hint')}</p>
        <div className="fn-logs__body">
          {entries.length === 0 ? (
            <p className="fn-logs__empty">{t('logsModal.empty')}</p>
          ) : (
            entries.map((e, i) => (
              <div key={i} className={`fn-logs__entry fn-logs__entry--${e.level}`}>
                <span className="fn-logs__ts">{e.ts.slice(11, 23)}</span>
                <span className="fn-logs__level">{e.level.toUpperCase()}</span>
                <span className="fn-logs__text">{e.text}</span>
              </div>
            ))
          )}
        </div>
        <div className="fn-modal__actions">
          <button type="button" onClick={handleCopy} disabled={entries.length === 0}>
            {copied ? t('logsModal.copied') : t('logsModal.copy')}
          </button>
          <button type="button" onClick={handleDownload} disabled={entries.length === 0}>
            {t('logsModal.download')}
          </button>
          <button type="button" onClick={onClear} disabled={entries.length === 0}>
            {t('logsModal.clear')}
          </button>
          <button type="button" onClick={onClose}>{t('logsModal.close')}</button>
        </div>
      </div>
    </div>
  );
}
