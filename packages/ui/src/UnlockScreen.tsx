import { useEffect, useRef, useState, type FormEvent } from 'react';
import { APP_NAME } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

export type UnlockTab = 'local' | 'cloud';

export interface CloudSyncParams {
  password: string;
  username: string;
  serverUrl: string;
}

export interface VaultListItem {
  id: string;
  namespace: string;
  label: string;
  initialized: boolean;
  boundUsername?: string;
}

interface UnlockScreenProps {
  vaults: VaultListItem[];
  activeVaultId: string;
  isFirstRun: boolean;
  defaultServerUrl: string;
  defaultUsername?: string;
  onSelectVault: (vaultId: string) => void;
  onCreateVaultEntry: (label: string) => void | Promise<void>;
  onCreateVault: (password: string) => Promise<void>;
  onUnlockLocal: (password: string) => Promise<void>;
  onCloudSync: (params: CloudSyncParams) => Promise<void>;
  progress?: { current: number; total: number } | null;
  /** Tab to open initially — e.g. 'cloud' right after a server-change reload. */
  initialTab?: UnlockTab;
}

export function UnlockScreen({
  vaults,
  activeVaultId,
  isFirstRun,
  defaultServerUrl,
  defaultUsername = '',
  onSelectVault,
  onCreateVaultEntry,
  onCreateVault,
  onUnlockLocal,
  onCloudSync,
  progress = null,
  initialTab = 'local',
}: UnlockScreenProps) {
  const t = useT();
  const activeVault = vaults.find((v) => v.id === activeVaultId);
  const [tab, setTab] = useState<UnlockTab>(initialTab);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [username, setUsername] = useState(defaultUsername);
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showNewVault, setShowNewVault] = useState(false);
  const [newVaultLabel, setNewVaultLabel] = useState('');

  useEffect(() => {
    setUsername(defaultUsername);
  }, [defaultUsername, activeVaultId]);

  // A bare `autoFocus` is not reliable on Windows/Electron right after a page reload that was
  // triggered while a native dialog held OS focus (e.g. the server-change confirm): the renderer
  // document isn't focused yet, Chromium skips autofocus, and the password field looks dead.
  // Focus explicitly with a few retries over the first moments, and re-grab focus whenever the
  // window itself regains focus while nothing else has it.
  useEffect(() => {
    const grab = () => {
      const el = passwordRef.current;
      if (!el) return;
      const active = document.activeElement;
      // Never steal focus from a field the user has already picked.
      if (
        active &&
        active !== el &&
        (active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active instanceof HTMLSelectElement)
      ) {
        return;
      }
      el.focus();
    };
    grab();
    const raf = requestAnimationFrame(grab);
    const t1 = window.setTimeout(grab, 200);
    const t2 = window.setTimeout(grab, 600);
    const onWindowFocus = () => {
      if (!document.activeElement || document.activeElement === document.body) grab();
    };
    window.addEventListener('focus', onWindowFocus);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, [tab]);

  async function handleLocalSubmit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);

    if (isFirstRun && password !== confirm) {
      setLocalError(t('unlockScreen.errorPasswordMismatch'));
      return;
    }
    if (password.length < 8) {
      setLocalError(t('unlockScreen.errorPasswordTooShort'));
      return;
    }

    setLoading(true);
    try {
      if (isFirstRun) {
        await onCreateVault(password);
      } else {
        await onUnlockLocal(password);
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t('unlockScreen.errorGeneric'));
    } finally {
      setLoading(false);
    }
  }

  async function handleCloudSubmit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);

    if (!username.trim()) {
      setLocalError(t('unlockScreen.errorUsernameRequired'));
      return;
    }
    if (activeVault?.boundUsername && username.trim() !== activeVault.boundUsername) {
      setLocalError(t('unlockScreen.errorBoundUsername', { username: activeVault.boundUsername }));
      return;
    }
    if (!serverUrl.trim()) {
      setLocalError(t('unlockScreen.errorServerUrlRequired'));
      return;
    }
    if (password.length < 8) {
      setLocalError(t('unlockScreen.errorPasswordTooShort'));
      return;
    }

    setLoading(true);
    try {
      await onCloudSync({
        password,
        username: username.trim(),
        serverUrl: serverUrl.trim(),
      });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t('unlockScreen.errorCloudSyncFailed'));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateVaultEntry(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    setLoading(true);
    try {
      await onCreateVaultEntry(
        newVaultLabel.trim() || t('unlockScreen.defaultNewVaultName', { index: vaults.length + 1 }),
      );
      setNewVaultLabel('');
      setShowNewVault(false);
      setPassword('');
      setConfirm('');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t('unlockScreen.errorCannotCreateVault'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fn-unlock">
      <div className="fn-unlock__card fn-unlock__card--wide">
        <h1>{APP_NAME}</h1>

        {progress && progress.total > 0 && (
          <div className="fn-unlock__progress">
            <div className="fn-unlock__progress-bar">
              <div
                className="fn-unlock__progress-fill"
                style={{ width: `${Math.min(100, Math.round((progress.current / progress.total) * 100))}%` }}
              />
            </div>
            <span className="fn-unlock__progress-text">
              {t('unlockScreen.decryptingProgress', { current: progress.current, total: progress.total })}
            </span>
          </div>
        )}

        <div className="fn-unlock__vaults">
          <p className="fn-unlock__hint">{t('unlockScreen.selectOrCreateVault')}</p>
          <ul className="fn-unlock__vault-list">
            {vaults.map((vault) => (
              <li key={vault.id}>
                <button
                  type="button"
                  className={`fn-unlock__vault-item${vault.id === activeVaultId ? ' active' : ''}`}
                  onClick={() => onSelectVault(vault.id)}
                  disabled={loading}
                >
                  <span className="fn-unlock__vault-label">{vault.label}</span>
                  <span className="fn-unlock__vault-meta">
                    {!vault.initialized
                      ? t('unlockScreen.pendingCreate')
                      : vault.boundUsername
                        ? `@${vault.boundUsername}`
                        : t('unlockScreen.localVault')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {showNewVault ? (
            <form className="fn-unlock__new-vault" onSubmit={handleCreateVaultEntry}>
              <input
                type="text"
                placeholder={t('unlockScreen.newVaultNamePlaceholder')}
                value={newVaultLabel}
                onChange={(e) => setNewVaultLabel(e.target.value)}
                autoFocus
              />
              <div className="fn-unlock__new-vault-actions">
                <button type="submit" disabled={loading}>
                  {t('unlockScreen.create')}
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => { setShowNewVault(false); setNewVaultLabel(''); }}
                >
                  {t('unlockScreen.cancel')}
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="fn-unlock__vault-add"
              disabled={loading}
              onClick={() => setShowNewVault(true)}
            >
              {t('unlockScreen.addVault')}
            </button>
          )}
        </div>

        <div className="fn-unlock__tabs">
          <button
            type="button"
            className={tab === 'local' ? 'active' : ''}
            onClick={() => { setTab('local'); setLocalError(null); }}
          >
            {isFirstRun ? t('unlockScreen.tabCreateVault') : t('unlockScreen.tabUnlockLocal')}
          </button>
          <button
            type="button"
            className={tab === 'cloud' ? 'active' : ''}
            onClick={() => { setTab('cloud'); setLocalError(null); }}
          >
            {t('unlockScreen.tabCloudSync')}
          </button>
        </div>

        {tab === 'local' ? (
          <>
            <p className="fn-unlock__hint">
              {isFirstRun
                ? t('unlockScreen.createVaultHint', { label: activeVault?.label ?? t('unlockScreen.defaultVaultLabel') })
                : t('unlockScreen.unlockVaultHint', { label: activeVault?.label ?? t('unlockScreen.defaultVaultLabel') })}
            </p>
            <form onSubmit={handleLocalSubmit}>
              <input
                ref={passwordRef}
                type="password"
                placeholder={t('unlockScreen.masterPasswordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              {isFirstRun && (
                <input
                  type="password"
                  placeholder={t('unlockScreen.confirmPasswordPlaceholder')}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              )}
              {localError && <p className="fn-unlock__error">{localError}</p>}
              <button type="submit" disabled={loading || !activeVaultId}>
                {loading ? t('unlockScreen.processing') : isFirstRun ? t('unlockScreen.createAndEnter') : t('unlockScreen.unlock')}
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="fn-unlock__hint">
              {activeVault?.boundUsername
                ? t('unlockScreen.cloudBoundHint', { username: activeVault.boundUsername })
                : isFirstRun
                  ? t('unlockScreen.cloudFirstRunHint')
                  : t('unlockScreen.cloudReturningHint')}
            </p>
            <form onSubmit={handleCloudSubmit}>
              <input
                type="url"
                placeholder={t('unlockScreen.serverUrlPlaceholder')}
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
              />
              <input
                type="text"
                placeholder={t('unlockScreen.usernamePlaceholder')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                readOnly={!!activeVault?.boundUsername}
              />
              <input
                ref={passwordRef}
                type="password"
                placeholder={t('unlockScreen.masterPasswordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              {localError && <p className="fn-unlock__error">{localError}</p>}
              <button type="submit" disabled={loading || !activeVaultId}>
                {loading ? t('unlockScreen.loggingIn') : t('unlockScreen.loginAndSync')}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
