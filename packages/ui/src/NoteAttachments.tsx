import { useRef, useState, type FormEvent } from 'react';
import type { NoteAttachment } from '@fastnote/shared';
import { downloadBlob, formatFileSize } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

interface NoteAttachmentsProps {
  attachments: NoteAttachment[];
  loading?: boolean;
  onUpload: (file: File, description: string) => Promise<void>;
  onUpdateDescription: (id: string, description: string) => Promise<void>;
  onDownload: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onInsert?: (attachment: NoteAttachment) => void;
}

function fileIcon(mime: string): string {
  if (mime.startsWith('image/')) return '🖼';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.includes('pdf')) return '📄';
  if (mime.includes('zip') || mime.includes('compressed')) return '📦';
  return '📎';
}

export function NoteAttachments({
  attachments,
  loading,
  onUpload,
  onUpdateDescription,
  onDownload,
  onDelete,
  onInsert,
}: NoteAttachmentsProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingDesc, setPendingDesc] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState('');

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        await onUpload(file, pendingDesc.trim());
      }
      setPendingDesc('');
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : t('noteAttachments.uploadFailed'));
    } finally {
      setUploading(false);
    }
  }

  async function commitDescription(e: FormEvent, id: string) {
    e.preventDefault();
    await onUpdateDescription(id, editDesc.trim());
    setEditingId(null);
  }

  return (
    <section className="fn-attachments">
      <div className="fn-attachments__head">
        <h3 className="fn-attachments__title">{t('noteAttachments.title')}</h3>
        <span className="fn-attachments__hint">{t('noteAttachments.hint')}</span>
      </div>

      <div
        className="fn-attachments__drop"
        onDragOver={(e) => {
          e.preventDefault();
          e.currentTarget.classList.add('fn-attachments__drop--active');
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove('fn-attachments__drop--active')}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('fn-attachments__drop--active');
          void handleFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => void handleFiles(e.target.files)}
        />
        <input
          className="fn-attachments__desc-input"
          placeholder={t('noteAttachments.descriptionPlaceholder')}
          value={pendingDesc}
          onChange={(e) => setPendingDesc(e.target.value)}
        />
        <button
          type="button"
          className="fn-attachments__upload-btn"
          disabled={uploading || loading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? t('noteAttachments.uploading') : t('noteAttachments.chooseFile')}
        </button>
        <p className="fn-attachments__drop-hint">{t('noteAttachments.dropHint')}</p>
      </div>

      {error && <p className="fn-unlock__error">{error}</p>}

      {attachments.length === 0 ? (
        <p className="fn-attachments__empty">{t('noteAttachments.empty')}</p>
      ) : (
        <ul className="fn-attachments__list">
          {attachments.map((a) => (
            <li key={a.id} className="fn-attachments__item">
              <span className="fn-attachments__icon" aria-hidden>
                {fileIcon(a.mimeType)}
              </span>
              <div className="fn-attachments__meta">
                <div className="fn-attachments__name" title={a.fileName}>
                  {a.fileName}
                  {a.syncStatus === 'pending' && (
                    <span className="fn-attachments__sync" title={t('noteAttachments.pendingSync')}> ☁</span>
                  )}
                </div>
                <div className="fn-attachments__size">{formatFileSize(a.size)}</div>
                {editingId === a.id ? (
                  <form className="fn-attachments__edit" onSubmit={(e) => void commitDescription(e, a.id)}>
                    <input
                      value={editDesc}
                      autoFocus
                      placeholder={t('noteAttachments.editDescriptionPlaceholder')}
                      onChange={(e) => setEditDesc(e.target.value)}
                    />
                    <button type="submit">{t('noteAttachments.edit')}</button>
                    <button type="button" onClick={() => setEditingId(null)}>
                      {t('common.cancel')}
                    </button>
                  </form>
                ) : (
                  <div className="fn-attachments__description">
                    {a.description || t('noteAttachments.noDescription')}
                    <button
                      type="button"
                      className="fn-attachments__link"
                      onClick={() => {
                        setEditingId(a.id);
                        setEditDesc(a.description);
                      }}
                    >
                      {t('noteAttachments.edit')}
                    </button>
                  </div>
                )}
              </div>
              <div className="fn-attachments__actions">
                {onInsert && (
                  <button type="button" title={t('noteAttachments.insert')} onClick={() => onInsert(a)}>
                    ⤵
                  </button>
                )}
                <button type="button" title={t('noteAttachments.download')} onClick={() => void onDownload(a.id)}>
                  ↓
                </button>
                <button
                  type="button"
                  title={t('noteAttachments.delete')}
                  onClick={() => {
                    if (confirm(t('noteAttachments.deleteConfirm', { name: a.fileName }))) void onDelete(a.id);
                  }}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
