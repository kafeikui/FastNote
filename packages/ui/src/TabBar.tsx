import { useState, type DragEvent } from 'react';
import type { NoteNode, OpenTab } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

const TAB_DRAG_MIME = 'application/x-fastnote-tab';

interface TabBarProps {
  tabs: OpenTab[];
  activeTabId: string | null;
  notes: NoteNode[];
  canSplit: boolean;
  onSelectTab: (tabId: string) => void;
  onPinTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onSplitTab: (tabId: string) => void;
  onReorderTab: (dragId: string, targetId: string, position: 'before' | 'after') => void;
}

export function TabBar({
  tabs,
  activeTabId,
  notes,
  canSplit,
  onSelectTab,
  onPinTab,
  onCloseTab,
  onSplitTab,
  onReorderTab,
}: TabBarProps) {
  const t = useT();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; position: 'before' | 'after' } | null>(null);

  if (tabs.length === 0) return null;

  return (
    <div className="fn-tabbar">
      {tabs.map((tab) => {
        const note = notes.find((n) => n.id === tab.id);
        const title = note?.title || t('common.untitled');
        const isActive = tab.id === activeTabId;
        const hint = dropHint?.id === tab.id ? dropHint.position : null;
        return (
          <div
            key={tab.id}
            className={[
              'fn-tab',
              isActive ? 'fn-tab--active' : '',
              tab.pinned ? 'fn-tab--pinned' : 'fn-tab--preview',
              hint === 'before' ? 'fn-tab--drop-before' : '',
              hint === 'after' ? 'fn-tab--drop-after' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            draggable
            onDragStart={(e: DragEvent) => {
              e.dataTransfer.setData(TAB_DRAG_MIME, tab.id);
              e.dataTransfer.effectAllowed = 'move';
              setDraggingId(tab.id);
            }}
            onDragEnd={() => {
              setDraggingId(null);
              setDropHint(null);
            }}
            onDragOver={(e: DragEvent) => {
              if (!draggingId || draggingId === tab.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const position = e.clientX - rect.left < rect.width / 2 ? 'before' : 'after';
              setDropHint({ id: tab.id, position });
            }}
            onDragLeave={() => setDropHint(null)}
            onDrop={(e: DragEvent) => {
              e.preventDefault();
              const dragId = e.dataTransfer.getData(TAB_DRAG_MIME);
              const position = dropHint?.position ?? 'before';
              setDropHint(null);
              if (dragId && dragId !== tab.id) onReorderTab(dragId, tab.id, position);
            }}
            onClick={() => onSelectTab(tab.id)}
            onDoubleClick={() => onPinTab(tab.id)}
            title={title}
          >
            <span className={`fn-tab__title${tab.pinned ? '' : ' fn-tab__title--preview'}`}>{title}</span>
            {canSplit && (
              <button
                type="button"
                className="fn-tab__split"
                title={t('tabBar.split')}
                onClick={(e) => {
                  e.stopPropagation();
                  onSplitTab(tab.id);
                }}
              >
                ⇄
              </button>
            )}
            <button
              type="button"
              className="fn-tab__close"
              title={t('tabBar.close')}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
