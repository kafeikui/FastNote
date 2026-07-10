import { useEffect, useRef, useState } from 'react';
import { useT } from '@fastnote/i18n';

interface InlineInputBarProps {
  label: string;
  initial?: string;
  placeholder?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

/**
 * Small inline prompt row (label + input + confirm/cancel). Replaces window.prompt(), which is
 * non-functional in the Electron renderer (returns null immediately).
 */
export function InlineInputBar({ label, initial = '', placeholder, onConfirm, onCancel }: InlineInputBarProps) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="fn-inline-input">
      <span className="fn-inline-input__label">{label}</span>
      <input
        ref={inputRef}
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onConfirm(draft);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <button type="button" onClick={() => onConfirm(draft)}>{t('common.confirm')}</button>
      <button type="button" onClick={onCancel}>{t('common.cancel')}</button>
    </div>
  );
}
