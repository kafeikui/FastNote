import { useState, type FormEvent } from 'react';
import { useT } from '@fastnote/i18n';

interface AuthModalProps {
  onClose: () => void;
  onRegister: (username: string) => Promise<void>;
  onLogin: (username: string) => Promise<void>;
}

export function AuthModal({ onClose, onRegister, onLogin }: AuthModalProps) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setLoading(true);
    setError(null);
    try {
      if (mode === 'register') {
        await onRegister(username.trim());
      } else {
        await onLogin(username.trim());
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('authModal.failed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fn-modal-backdrop" onClick={onClose}>
      <div className="fn-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{mode === 'login' ? t('authModal.login') : t('authModal.register')}</h2>
        <p className="fn-unlock__hint">{t('authModal.hint')}</p>
        <form onSubmit={handleSubmit}>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t('authModal.usernamePlaceholder')}
            autoFocus
          />
          {error && <p className="fn-unlock__error">{error}</p>}
          <div className="fn-modal__actions">
            <button type="submit" disabled={loading}>
              {loading ? t('authModal.processing') : mode === 'login' ? t('authModal.login') : t('authModal.register')}
            </button>
            <button
              type="button"
              onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            >
              {mode === 'login' ? t('authModal.goRegister') : t('authModal.goLogin')}
            </button>
            <button type="button" onClick={onClose}>{t('authModal.cancel')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
