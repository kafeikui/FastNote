import { useState } from 'react';
import { useT } from '@fastnote/i18n';

export interface TransferVaultOption {
  id: string;
  namespace: string;
  label: string;
}

interface VaultTransferModalProps {
  /** Other registered vaults (current vault excluded by the caller). */
  vaults: TransferVaultOption[];
  /** How many top-level items are being transferred (folders include their contents). */
  itemCount: number;
  busy: boolean;
  error: string | null;
  progress: string | null;
  onSubmit: (targetNamespace: string, password: string, mode: 'copy' | 'move') => void;
  onClose: () => void;
}

export function VaultTransferModal({
  vaults,
  itemCount,
  busy,
  error,
  progress,
  onSubmit,
  onClose,
}: VaultTransferModalProps) {
  const t = useT();
  const [targetNs, setTargetNs] = useState(vaults[0]?.namespace ?? '');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'copy' | 'move'>('copy');

  return (
    <div className="fn-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="fn-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('vaultTransfer.title')}</h2>
        <p className="fn-field__hint">{t('vaultTransfer.hint', { count: itemCount })}</p>
        {vaults.length === 0 ? (
          <p>{t('vaultTransfer.noOtherVaults')}</p>
        ) : (
          <>
            <label className="fn-field">
              <span>{t('vaultTransfer.targetLabel')}</span>
              <select value={targetNs} disabled={busy} onChange={(e) => setTargetNs(e.target.value)}>
                {vaults.map((v) => (
                  <option key={v.id} value={v.namespace}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="fn-field">
              <span>{t('vaultTransfer.passwordLabel')}</span>
              <input
                type="password"
                value={password}
                disabled={busy}
                autoFocus
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && password && targetNs && !busy) {
                    onSubmit(targetNs, password, mode);
                  }
                }}
              />
            </label>
            <fieldset className="fn-field fn-field--checkboxes">
              <label className="fn-checkbox">
                <input
                  type="radio"
                  name="fn-transfer-mode"
                  checked={mode === 'copy'}
                  disabled={busy}
                  onChange={() => setMode('copy')}
                />
                <span>{t('vaultTransfer.modeCopy')}</span>
              </label>
              <label className="fn-checkbox">
                <input
                  type="radio"
                  name="fn-transfer-mode"
                  checked={mode === 'move'}
                  disabled={busy}
                  onChange={() => setMode('move')}
                />
                <span>{t('vaultTransfer.modeMove')}</span>
              </label>
            </fieldset>
          </>
        )}
        {progress && <p className="fn-sync-status">{progress}</p>}
        {error && <p className="fn-unlock__error">{error}</p>}
        <div className="fn-modal__actions">
          {vaults.length > 0 && (
            <button
              type="button"
              disabled={busy || !password || !targetNs}
              onClick={() => onSubmit(targetNs, password, mode)}
            >
              {busy ? t('vaultTransfer.working') : t('vaultTransfer.start')}
            </button>
          )}
          <button type="button" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
