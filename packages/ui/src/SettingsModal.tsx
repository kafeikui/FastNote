import { useState, useEffect } from 'react';
import type { ChatNotificationSettings, ChatSoundId, UiThemeId } from '@fastnote/api';
import { CHAT_SOUND_IDS, UI_THEMES } from '@fastnote/api';
import { LOCALES, LOCALE_LABELS, useT, type Locale } from '@fastnote/i18n';
import { chatSoundLabel, playChatNotificationSound } from './chatNotification';

const THEME_SWATCHES: Record<UiThemeId, string> = {
  warm: '#c97b5a',
  elegant: '#7c4a8c',
  business: '#2563eb',
  fresh: '#1f9d78',
};

interface SettingsModalProps {
  serverUrl: string;
  sessionUsername: string | null;
  vaultLabel: string;
  syncStatus: string | null;
  dataDirectory: string;
  isElectron: boolean;
  chatNotify: ChatNotificationSettings;
  uiTheme: UiThemeId;
  locale: Locale;
  onClose: () => void;
  onSaveServer: (url: string) => void;
  onSaveVaultLabel: (label: string) => void;
  onSaveDataDirectory: (path: string) => void | Promise<void>;
  onPickDataDirectory?: () => Promise<string | null>;
  onChatNotifyChange: (settings: ChatNotificationSettings) => void;
  onUiThemeChange: (theme: UiThemeId) => void;
  onLocaleChange: (locale: Locale) => void;
  onOpenAuth: () => void;
  onLogout: () => void;
  onSync: () => void;
  onAbout: () => void;
}

export function SettingsModal({
  serverUrl,
  sessionUsername,
  vaultLabel,
  syncStatus,
  dataDirectory,
  isElectron,
  chatNotify,
  uiTheme,
  locale,
  onClose,
  onSaveServer,
  onSaveVaultLabel,
  onSaveDataDirectory,
  onPickDataDirectory,
  onChatNotifyChange,
  onUiThemeChange,
  onLocaleChange,
  onOpenAuth,
  onLogout,
  onSync,
  onAbout,
}: SettingsModalProps) {
  const t = useT();
  const [pathDraft, setPathDraft] = useState(dataDirectory);
  const [vaultLabelDraft, setVaultLabelDraft] = useState(vaultLabel);

  const THEME_LABELS: Record<UiThemeId, string> = {
    warm: t('settingsModal.theme.warm'),
    elegant: t('settingsModal.theme.elegant'),
    business: t('settingsModal.theme.business'),
    fresh: t('settingsModal.theme.fresh'),
  };

  useEffect(() => {
    setPathDraft(dataDirectory);
  }, [dataDirectory]);

  useEffect(() => {
    setVaultLabelDraft(vaultLabel);
  }, [vaultLabel]);

  return (
    <div className="fn-modal-backdrop" onClick={onClose}>
      <div className="fn-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('settingsModal.title')}</h2>
        <label className="fn-field">
          <span>{t('settingsModal.serverUrlLabel')}</span>
          <input id="server-url" defaultValue={serverUrl} placeholder="http://localhost:8787" />
        </label>
        <div className="fn-modal__actions">
          <button
            type="button"
            onClick={() => {
              const input = document.getElementById('server-url') as HTMLInputElement;
              onSaveServer(input.value.trim());
            }}
          >
            {t('settingsModal.saveServer')}
          </button>
        </div>
        <hr />
        <label className="fn-field">
          <span>{t('settingsModal.vaultLabelLabel')}</span>
          <input
            value={vaultLabelDraft}
            onChange={(e) => setVaultLabelDraft(e.target.value)}
            placeholder={t('settingsModal.vaultLabelPlaceholder')}
          />
        </label>
        <div className="fn-modal__actions">
          <button
            type="button"
            onClick={() => onSaveVaultLabel(vaultLabelDraft.trim())}
            disabled={!vaultLabelDraft.trim()}
          >
            {t('settingsModal.saveVaultLabel')}
          </button>
        </div>
        <hr />
        <fieldset className="fn-field fn-field--checkboxes">
          <legend>{t('settingsModal.notifyLegend')}</legend>
          <label className="fn-checkbox">
            <input
              type="checkbox"
              checked={chatNotify.bubble}
              onChange={(e) => onChatNotifyChange({ ...chatNotify, bubble: e.target.checked })}
            />
            <span>{t('settingsModal.notifyBubble')}</span>
          </label>
          <label className="fn-checkbox">
            <input
              type="checkbox"
              checked={chatNotify.sound}
              onChange={(e) => onChatNotifyChange({ ...chatNotify, sound: e.target.checked })}
            />
            <span>{t('settingsModal.notifySound')}</span>
          </label>
          <div className="fn-sound-settings">
            <label className="fn-sound-settings__row">
              <span>{t('settingsModal.soundLabel')}</span>
              <select
                value={chatNotify.soundId}
                disabled={!chatNotify.sound}
                onChange={(e) =>
                  onChatNotifyChange({ ...chatNotify, soundId: e.target.value as ChatSoundId })
                }
              >
                {CHAT_SOUND_IDS.map((id) => (
                  <option key={id} value={id}>
                    {chatSoundLabel(id, locale)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="fn-sound-preview-btn"
                disabled={!chatNotify.sound}
                onClick={() => playChatNotificationSound(chatNotify.soundId, chatNotify.volume)}
                title={t('settingsModal.previewSound')}
              >
                {t('settingsModal.previewSoundBtn')}
              </button>
            </label>
            <label className="fn-sound-settings__row">
              <span>{t('settingsModal.volumeLabel')}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={chatNotify.volume}
                disabled={!chatNotify.sound}
                onChange={(e) => onChatNotifyChange({ ...chatNotify, volume: Number(e.target.value) })}
              />
              <span className="fn-sound-settings__value">{Math.round(chatNotify.volume * 100)}%</span>
            </label>
          </div>
        </fieldset>
        <hr />
        <fieldset className="fn-field fn-field--checkboxes">
          <legend>{t('settingsModal.themeLegend')}</legend>
          <div className="fn-theme-picker">
            {UI_THEMES.map((theme) => (
              <button
                key={theme}
                type="button"
                className={`fn-theme-swatch${theme === uiTheme ? ' active' : ''}`}
                onClick={() => onUiThemeChange(theme)}
                title={THEME_LABELS[theme]}
              >
                <span
                  className="fn-theme-swatch__dot"
                  style={{ background: THEME_SWATCHES[theme] }}
                />
                <span>{THEME_LABELS[theme]}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <hr />
        <fieldset className="fn-field fn-field--checkboxes">
          <legend>{t('settingsModal.languageLegend')}</legend>
          <div className="fn-theme-picker">
            {LOCALES.map((loc) => (
              <button
                key={loc}
                type="button"
                className={`fn-theme-swatch${loc === locale ? ' active' : ''}`}
                onClick={() => onLocaleChange(loc)}
                title={LOCALE_LABELS[loc]}
              >
                <span>{LOCALE_LABELS[loc]}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <hr />
        <label className="fn-field">
          <span>{t('settingsModal.dataDirLabel')}</span>
          {isElectron ? (
            <>
              <div className="fn-field__row">
                <input
                  value={pathDraft}
                  onChange={(e) => setPathDraft(e.target.value)}
                  placeholder={t('settingsModal.dataDirPlaceholder')}
                />
                {onPickDataDirectory && (
                  <button
                    type="button"
                    onClick={() => {
                      void onPickDataDirectory().then((path) => {
                        if (path) setPathDraft(path);
                      });
                    }}
                  >
                    {t('settingsModal.browse')}
                  </button>
                )}
              </div>
              <p className="fn-unlock__hint">{t('settingsModal.desktopDataDirHint')}</p>
            </>
          ) : (
            <>
              <input value={t('settingsModal.webDataDirValue')} readOnly disabled />
              <p className="fn-unlock__hint">{t('settingsModal.webDataDirHint')}</p>
            </>
          )}
        </label>
        {isElectron && (
          <div className="fn-modal__actions">
            <button type="button" onClick={() => void onSaveDataDirectory(pathDraft.trim())}>
              {t('settingsModal.saveDataDir')}
            </button>
          </div>
        )}
        <hr />
        <p className="fn-field">
          {t('settingsModal.accountLabel', { username: sessionUsername ?? t('settingsModal.notLoggedIn') })}
        </p>
        {syncStatus && <p className="fn-sync-status">{syncStatus}</p>}
        <div className="fn-modal__actions">
          {!sessionUsername ? (
            <button type="button" onClick={onOpenAuth}>
              {t('settingsModal.loginOrRegister')}
            </button>
          ) : (
            <>
              <button type="button" onClick={onSync}>
                {t('settingsModal.syncNow')}
              </button>
              <button type="button" onClick={onLogout}>
                {t('settingsModal.logout')}
              </button>
            </>
          )}
          <button type="button" onClick={onClose}>
            {t('settingsModal.close')}
          </button>
          <button type="button" onClick={onAbout}>
            {t('settingsModal.about')}
          </button>
        </div>
      </div>
    </div>
  );
}
