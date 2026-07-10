import { useMemo, useState, type DragEvent } from 'react';
import type { AiSessionNode } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

interface AiSessionTreeProps {
  sessions: AiSessionNode[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (kind: 'folder' | 'session', parentId: string | null) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, newParentId: string | null) => void;
}

interface AiTreeLevel {
  node: AiSessionNode;
  children: AiTreeLevel[];
}

function buildLevels(sessions: AiSessionNode[], parentId: string | null): AiTreeLevel[] {
  return sessions
    .filter((s) => s.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.updatedAt.localeCompare(b.updatedAt))
    .map((node) => ({ node, children: node.kind === 'folder' ? buildLevels(sessions, node.id) : [] }));
}

/** Collects a folder's descendant ids so a folder can't be dropped into itself. */
function descendantIds(sessions: AiSessionNode[], rootId: string): Set<string> {
  const out = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of sessions) {
      if (s.parentId && out.has(s.parentId) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return out;
}

const DRAG_MIME = 'application/x-fastnote-ai-session';

export function AiSessionTree({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onMove,
}: AiSessionTreeProps) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const levels = useMemo(() => buildLevels(sessions, null), [sessions]);

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const commitRename = (id: string) => {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (title) onRename(id, title);
  };

  const handleDrop = (e: DragEvent, targetFolderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTargetId(null);
    const draggedId = e.dataTransfer.getData(DRAG_MIME);
    if (!draggedId || draggedId === targetFolderId) return;
    const dragged = sessions.find((s) => s.id === draggedId);
    if (!dragged) return;
    if (dragged.kind === 'folder' && targetFolderId && descendantIds(sessions, draggedId).has(targetFolderId)) {
      return;
    }
    if (dragged.parentId === targetFolderId) return;
    onMove(draggedId, targetFolderId);
  };

  const renderLevel = (items: AiTreeLevel[], depth: number) => (
    <ul className="fn-ai-tree__list">
      {items.map(({ node, children }) => {
        const isFolder = node.kind === 'folder';
        const isCollapsed = collapsed.has(node.id);
        return (
          <li key={node.id}>
            <div
              className={[
                'fn-ai-tree__row',
                node.id === activeId ? 'fn-ai-tree__row--active' : '',
                dropTargetId === node.id ? 'fn-ai-tree__row--drop' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ paddingLeft: `${depth * 14 + 4}px` }}
              draggable={renamingId !== node.id}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, node.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={
                isFolder
                  ? (e) => {
                      if (e.dataTransfer.types.includes(DRAG_MIME)) {
                        e.preventDefault();
                        setDropTargetId(node.id);
                      }
                    }
                  : undefined
              }
              onDragLeave={isFolder ? () => setDropTargetId((cur) => (cur === node.id ? null : cur)) : undefined}
              onDrop={isFolder ? (e) => handleDrop(e, node.id) : undefined}
              onClick={() => {
                if (isFolder) toggleCollapse(node.id);
                else onSelect(node.id);
              }}
            >
              <span className="fn-ai-tree__icon">{isFolder ? (isCollapsed ? '▸' : '▾') : '💬'}</span>
              {renamingId === node.id ? (
                <input
                  className="fn-ai-tree__rename"
                  value={renameDraft}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => commitRename(node.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(node.id);
                    else if (e.key === 'Escape') setRenamingId(null);
                  }}
                />
              ) : (
                <span className="fn-ai-tree__title" title={node.title}>
                  {node.title}
                </span>
              )}
              <span className="fn-ai-tree__actions" onClick={(e) => e.stopPropagation()}>
                {isFolder && (
                  <button
                    type="button"
                    title={t('aiPanel.newSession')}
                    onClick={() => onCreate('session', node.id)}
                  >
                    ＋
                  </button>
                )}
                <button
                  type="button"
                  title={t('aiPanel.rename')}
                  onClick={() => {
                    setRenamingId(node.id);
                    setRenameDraft(node.title);
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  title={t('aiPanel.delete')}
                  onClick={() => {
                    if (confirm(t(isFolder ? 'aiPanel.confirmDeleteFolder' : 'aiPanel.confirmDeleteSession', { title: node.title }))) {
                      onDelete(node.id);
                    }
                  }}
                >
                  ×
                </button>
              </span>
            </div>
            {isFolder && !isCollapsed && children.length > 0 && renderLevel(children, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div
      className={`fn-ai-tree${dropTargetId === '__root__' ? ' fn-ai-tree--drop' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_MIME)) {
          e.preventDefault();
          setDropTargetId('__root__');
        }
      }}
      onDragLeave={() => setDropTargetId((cur) => (cur === '__root__' ? null : cur))}
      onDrop={(e) => handleDrop(e, null)}
    >
      <div className="fn-ai-tree__toolbar">
        <button type="button" onClick={() => onCreate('session', null)}>
          {t('aiPanel.newSession')}
        </button>
        <button type="button" onClick={() => onCreate('folder', null)}>
          {t('aiPanel.newFolder')}
        </button>
      </div>
      {levels.length === 0 ? (
        <p className="fn-ai-tree__empty">{t('aiPanel.empty')}</p>
      ) : (
        renderLevel(levels, 0)
      )}
    </div>
  );
}
