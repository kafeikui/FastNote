import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { AiSessionNode } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';
import { TrashSection } from './TrashSection';

interface AiSessionTreeProps {
  sessions: AiSessionNode[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (kind: 'folder' | 'session', parentId: string | null) => void;
  onRename: (id: string, title: string) => void;
  /** Moves the node (with its subtree) into the recycle bin. */
  onDelete: (id: string) => void;
  /** Restores a recycle-bin entry back into the tree. */
  onRestore?: (id: string) => void;
  /** Permanently deletes one recycle-bin entry (with its subtree). */
  onDeleteForever?: (id: string) => void;
  /** Permanently deletes everything in the recycle bin. */
  onEmptyTrash?: () => void;
  onMove: (id: string, newParentId: string | null) => void;
}

interface AiTreeLevel {
  node: AiSessionNode;
  children: AiTreeLevel[];
}

function buildLevels(sessions: AiSessionNode[], parentId: string | null): AiTreeLevel[] {
  return sessions
    .filter((s) => s.parentId === parentId && !s.trashed)
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
  onRestore,
  onDeleteForever,
  onEmptyTrash,
  onMove,
}: AiSessionTreeProps) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // Last clicked node (folder or session) — the anchor for toolbar creation and F2 rename.
  const [focusId, setFocusId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const levels = useMemo(() => buildLevels(sessions, null), [sessions]);

  // When a node is created, jump the tree focus to it (and reveal it if it landed inside a
  // collapsed folder). AI sessions are local-only, so a grown list always means a user action.
  const prevIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const prev = prevIdsRef.current;
    prevIdsRef.current = new Set(sessions.map((s) => s.id));
    if (!prev) return;
    const added = sessions.filter((s) => !prev.has(s.id));
    if (added.length !== 1) return;
    const node = added[0]!;
    setFocusId(node.id);
    setCollapsed((cur) => {
      const next = new Set(cur);
      let pid = node.parentId;
      while (pid) {
        next.delete(pid);
        pid = sessions.find((s) => s.id === pid)?.parentId ?? null;
      }
      return next.size === cur.size ? cur : next;
    });
    // Keyboard focus moves onto the tree so F2 renames the new node (not a sidebar note), and
    // the new row scrolls into view on the next frame (after it has rendered).
    rootRef.current?.focus();
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector(`[data-ai-node-id="${node.id}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }, [sessions]);

  /** Toolbar creation target: inside the focused folder, or alongside the focused session. */
  const createParentId = (): string | null => {
    const anchor =
      (focusId && sessions.find((s) => s.id === focusId)) ||
      (activeId && sessions.find((s) => s.id === activeId)) ||
      null;
    if (!anchor) return null;
    return anchor.kind === 'folder' ? anchor.id : anchor.parentId;
  };

  const startRename = (node: AiSessionNode) => {
    setRenamingId(node.id);
    setRenameDraft(node.title);
  };

  const handleTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'F2' || renamingId) return;
    const target = focusId ?? activeId;
    const node = target ? sessions.find((s) => s.id === target) : undefined;
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    startRename(node);
  };

  const allFolderIds = useMemo(
    () => sessions.filter((s) => s.kind === 'folder' && !s.trashed).map((s) => s.id),
    [sessions],
  );

  // Recycle bin: only the roots of trashed subtrees are listed — restoring/purging a root
  // takes its descendants with it.
  const trashItems = useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return sessions
      .filter((s) => s.trashed && (!s.parentId || !byId.get(s.parentId)?.trashed))
      .map((s) => ({
        id: s.id,
        title: s.title || t(s.kind === 'folder' ? 'aiPanel.defaultFolderTitle' : 'aiPanel.defaultSessionTitle'),
        icon: s.kind === 'folder' ? '📁' : '💬',
      }));
  }, [sessions, t]);
  const trashedCount = sessions.filter((s) => s.trashed).length;
  const anyExpanded = allFolderIds.some((id) => !collapsed.has(id));

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
                node.id === focusId && node.id !== activeId ? 'fn-ai-tree__row--focus' : '',
                dropTargetId === node.id ? 'fn-ai-tree__row--drop' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ paddingLeft: `${depth * 14 + 4}px` }}
              data-ai-node-id={node.id}
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
                setFocusId(node.id);
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
                  onClick={() => startRename(node)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  title={t('aiPanel.delete')}
                  onClick={() => {
                    // Confirmed, though recoverable: the node moves into the recycle bin.
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
      ref={rootRef}
      className={`fn-ai-tree${dropTargetId === '__root__' ? ' fn-ai-tree--drop' : ''}`}
      tabIndex={-1}
      onKeyDown={handleTreeKeyDown}
      onMouseDown={(e) => {
        // Rows aren't focusable; keep keyboard focus on the tree itself so F2 works after a
        // click (but never steal focus from the rename input or the toolbar buttons).
        if (e.target instanceof HTMLElement && !e.target.closest('input, button')) {
          e.currentTarget.focus();
        }
      }}
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
        <button type="button" onClick={() => onCreate('session', createParentId())}>
          {t('aiPanel.newSession')}
        </button>
        <button type="button" onClick={() => onCreate('folder', createParentId())}>
          {t('aiPanel.newFolder')}
        </button>
        {allFolderIds.length > 0 && (
          <button
            type="button"
            className="fn-ai-tree__fold-btn"
            title={anyExpanded ? t('aiPanel.collapseAll') : t('aiPanel.expandAll')}
            onClick={() =>
              setCollapsed(anyExpanded ? new Set(allFolderIds) : new Set())
            }
          >
            {anyExpanded ? '⊟' : '⊞'}
          </button>
        )}
      </div>
      {levels.length === 0 ? (
        <p className="fn-ai-tree__empty">{t('aiPanel.empty')}</p>
      ) : (
        renderLevel(levels, 0)
      )}
      {onRestore && onDeleteForever && onEmptyTrash && (
        <TrashSection
          items={trashItems}
          emptyCount={trashedCount}
          onRestore={onRestore}
          onDeleteForever={onDeleteForever}
          onEmpty={onEmptyTrash}
        />
      )}
    </div>
  );
}
