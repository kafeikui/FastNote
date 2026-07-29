import { useState } from 'react';
import { useT } from '@fastnote/i18n';

export interface TrashItem {
  id: string;
  title: string;
  icon: string;
}

/**
 * Collapsible recycle-bin section shared by the notes and AI sidebars. Shows the trashed
 * top-level entries (subtrees are restored/purged with their root); restore is one click,
 * emptying or permanently deleting asks for confirmation.
 */
export function TrashSection({
  items,
  emptyCount,
  onRestore,
  onDeleteForever,
  onEmpty,
}: {
  items: TrashItem[];
  /** Total number of nodes an "empty" would purge (roots + descendants); defaults to items. */
  emptyCount?: number;
  onRestore: (id: string) => void;
  onDeleteForever: (id: string) => void;
  onEmpty: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="fn-trash">
      <div className="fn-trash__header">
        <button type="button" className="fn-trash__toggle" onClick={() => setOpen((v) => !v)}>
          <span className="fn-trash__chevron">{open ? '▾' : '▸'}</span>
          <span aria-hidden>🗑</span> {t('trash.title')} ({items.length})
        </button>
        {items.length > 0 && (
          <button
            type="button"
            className="fn-trash__empty-btn"
            onClick={() => {
              if (confirm(t('trash.emptyConfirm', { count: emptyCount ?? items.length }))) onEmpty();
            }}
          >
            {t('trash.empty')}
          </button>
        )}
      </div>
      {open &&
        (items.length === 0 ? (
          <p className="fn-trash__none">{t('trash.noItems')}</p>
        ) : (
          <ul className="fn-trash__list">
            {items.map((it) => (
              <li key={it.id} className="fn-trash__row">
                <span className="fn-trash__icon">{it.icon}</span>
                <span className="fn-trash__title" title={it.title}>
                  {it.title}
                </span>
                <span className="fn-trash__actions">
                  <button type="button" title={t('trash.restore')} onClick={() => onRestore(it.id)}>
                    ↩
                  </button>
                  <button
                    type="button"
                    title={t('trash.deleteForever')}
                    onClick={() => {
                      if (confirm(t('trash.deleteForeverConfirm', { name: it.title }))) {
                        onDeleteForever(it.id);
                      }
                    }}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
