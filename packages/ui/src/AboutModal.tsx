import { APP_NAME } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

interface AboutModalProps {
  onClose: () => void;
}

export function AboutModal({ onClose }: AboutModalProps) {
  const t = useT();
  return (
    <div className="fn-modal-backdrop" onClick={onClose}>
      <div className="fn-modal fn-about" onClick={(e) => e.stopPropagation()}>
        <h2>{APP_NAME}</h2>
        <p>{t('aboutModal.version', { version: '0.1.0' })}</p>
        <p className="fn-unlock__hint">{t('aboutModal.tagline')}</p>
        <p className="fn-unlock__hint">{t('aboutModal.platforms')}</p>
        <div className="fn-modal__actions">
          <button type="button" onClick={onClose}>{t('aboutModal.close')}</button>
        </div>
      </div>
    </div>
  );
}
