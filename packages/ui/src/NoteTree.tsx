import { useState, type DragEvent } from 'react';
import type { NoteNode } from '@fastnote/shared';
import { buildTree, type TreeDropPosition, type TreeItem } from '@fastnote/shared';
import { useT, type TFunction } from '@fastnote/i18n';

const DRAG_MIME = 'application/x-fastnote-node';

interface NoteTreeProps {
  notes: NoteNode[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreateFolder: (parentId: string | null) => void;
  onCreateNote: (parentId: string | null) => void;
  onCreateTable: (parentId: string | null) => void;
  onImportFolder?: (parentId: string | null) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onMove: (dragId: string, targetId: string | null, position: TreeDropPosition) => void;
}

type DropHint = TreeDropPosition | null;

function resolveDropPosition(e: DragEvent, isFolder: boolean): Exclude<TreeDropPosition, 'root'> {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = e.clientY - rect.top;
  const ratio = y / rect.height;
  if (isFolder && ratio > 0.28 && ratio < 0.72) return 'inside';
  if (ratio < 0.5) return 'before';
  return 'after';
}

function TreeNode({
  item,
  depth,
  activeId,
  onSelect,
  onCreateFolder,
  onCreateNote,
  onCreateTable,
  onImportFolder,
  onRename,
  onDelete,
  onMove,
  draggingId,
  onDragStartNode,
  onDragEndNode,
  t,
}: {
  item: TreeItem;
  depth: number;
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreateFolder: (parentId: string | null) => void;
  onCreateNote: (parentId: string | null) => void;
  onCreateTable: (parentId: string | null) => void;
  onImportFolder?: (parentId: string | null) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onMove: (dragId: string, targetId: string | null, position: TreeDropPosition) => void;
  draggingId: string | null;
  onDragStartNode: (id: string) => void;
  onDragEndNode: () => void;
  t: TFunction;
}) {
  const { node, children } = item;
  const [expanded, setExpanded] = useState(true);
  const [dropHint, setDropHint] = useState<DropHint>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.title);

  const isFolder = node.nodeType === 'folder';
  const isTable = node.nodeType === 'table';
  const isActive = node.id === activeId;
  const icon = isFolder ? '📁' : isTable ? '📊' : '📝';
  const defaultTitle = isFolder
    ? t('noteTree.untitledFolder')
    : isTable
      ? t('noteTree.untitledTable')
      : t('noteTree.untitledNote');

  const startRename = () => {
    setRenameValue(node.title || defaultTitle);
    setRenaming(true);
  };

  const commitRename = () => {
    setRenaming(false);
    const title = renameValue.trim();
    if (title && title !== node.title) onRename(node.id, title);
  };

  const handleDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, node.id);
    e.dataTransfer.effectAllowed = 'move';
    onDragStartNode(node.id);
  };

  const handleDragEnd = () => onDragEndNode();

  const handleDragOver = (e: DragEvent) => {
    if (!draggingId || draggingId === node.id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropHint(resolveDropPosition(e, isFolder));
  };

  const handleDragLeave = () => setDropHint(null);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const dragId = e.dataTransfer.getData(DRAG_MIME);
    if (!dragId || dragId === node.id) return;
    const position = dropHint ?? resolveDropPosition(e, isFolder);
    setDropHint(null);
    onMove(dragId, node.id, position);
  };

  const rowClass = [
    'fn-tree-node__row',
    dropHint === 'inside' ? 'fn-tree-node__row--drop-inside' : '',
    dropHint === 'before' ? 'fn-tree-node__row--drop-before' : '',
    dropHint === 'after' ? 'fn-tree-node__row--drop-after' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li className={`fn-tree-node ${isActive ? 'active' : ''}`}>
      <div
        className={rowClass}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => {
          e.stopPropagation();
          handleDrop(e);
        }}
      >
        <span className="fn-tree-node__drag" title={t('noteTree.dragHandle')}>⠿</span>
        {isFolder ? (
          <button
            type="button"
            className="fn-tree-node__toggle"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? t('noteTree.collapse') : t('noteTree.expand')}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="fn-tree-node__spacer" />
        )}
        {renaming ? (
          <input
            className="fn-tree-node__rename"
            value={renameValue}
            autoFocus
            onChange={(ev) => setRenameValue(ev.target.value)}
            onBlur={commitRename}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') commitRename();
              if (ev.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="fn-tree-node__label"
            onClick={() => onSelect(node.id)}
            onDoubleClick={(ev) => {
              ev.preventDefault();
              startRename();
            }}
          >
            <span className="fn-tree-node__icon">{icon}</span>
            <span className="fn-tree-node__text">{node.title || defaultTitle}</span>
            {node.syncStatus === 'pending' && <span className="fn-sync-dot" title={t('noteTree.pendingSync')} />}
            {node.syncStatus === 'conflict' && <span className="fn-conflict-dot" title={t('noteTree.conflict')} />}
          </button>
        )}
        <div className="fn-tree-node__actions fn-tree-node__actions--hover">
          {isFolder && (
            <>
              <button type="button" title={t('noteTree.newNote')} onClick={() => onCreateNote(node.id)}>
                +
              </button>
              <button type="button" title={t('noteTree.newTable')} onClick={() => onCreateTable(node.id)}>
                📊
              </button>
              <button type="button" title={t('noteTree.newFolder')} onClick={() => onCreateFolder(node.id)}>
                📁
              </button>
              {onImportFolder && (
                <button type="button" title={t('noteTree.importFolder')} onClick={() => onImportFolder(node.id)}>
                  ⇪
                </button>
              )}
            </>
          )}
        </div>
        <div className="fn-tree-node__actions fn-tree-node__actions--always">
          <button type="button" title={t('noteTree.rename')} onClick={startRename}>
            ✎
          </button>
          <button
            type="button"
            title={t('noteTree.delete')}
            onClick={() => {
              if (confirm(t('noteTree.deleteConfirm', { name: node.title || defaultTitle }))) onDelete(node.id);
            }}
          >
            ×
          </button>
        </div>
      </div>
      {isFolder && expanded && children.length > 0 && (
        <ul className="fn-tree fn-tree--nested">
          {children.map((child) => (
            <TreeNode
              key={child.node.id}
              item={child}
              depth={depth + 1}
              activeId={activeId}
              onSelect={onSelect}
              onCreateFolder={onCreateFolder}
              onCreateNote={onCreateNote}
              onCreateTable={onCreateTable}
              onImportFolder={onImportFolder}
              onRename={onRename}
              onDelete={onDelete}
              onMove={onMove}
              draggingId={draggingId}
              onDragStartNode={onDragStartNode}
              onDragEndNode={onDragEndNode}
              t={t}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function NoteTree({
  notes,
  activeId,
  onSelect,
  onCreateFolder,
  onCreateNote,
  onCreateTable,
  onImportFolder,
  onRename,
  onDelete,
  onMove,
}: NoteTreeProps) {
  const t = useT();
  const [rootDrop, setRootDrop] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const tree = buildTree(notes);

  const handleRootDragOver = (e: DragEvent) => {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setRootDrop(true);
  };

  const handleRootDrop = (e: DragEvent) => {
    e.preventDefault();
    const dragId = e.dataTransfer.getData(DRAG_MIME);
    setRootDrop(false);
    if (dragId) onMove(dragId, null, 'root');
  };

  if (tree.length === 0) {
    return (
      <div
        className={`fn-tree-root-zone ${rootDrop ? 'fn-tree-root-zone--active' : ''}`}
        onDragOver={handleRootDragOver}
        onDragLeave={() => setRootDrop(false)}
        onDrop={handleRootDrop}
      >
        <div className="fn-tree-empty">
          <p>{t('noteTree.empty')}</p>
          <button type="button" onClick={() => onCreateNote(null)}>
            {t('noteTree.newNote')}
          </button>
          <button type="button" onClick={() => onCreateTable(null)}>
            {t('noteTree.newTable')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`fn-tree-root-zone ${rootDrop ? 'fn-tree-root-zone--active' : ''}`}
      onDragOver={handleRootDragOver}
      onDragLeave={() => setRootDrop(false)}
      onDrop={handleRootDrop}
    >
      <div className="fn-tree-root-hint">{t('noteTree.rootDropHint')}</div>
      <ul className="fn-tree">
        {tree.map((item) => (
          <TreeNode
            key={item.node.id}
            item={item}
            depth={0}
            activeId={activeId}
            onSelect={onSelect}
            onCreateFolder={onCreateFolder}
            onCreateNote={onCreateNote}
            onCreateTable={onCreateTable}
            onImportFolder={onImportFolder}
            onRename={onRename}
            onDelete={onDelete}
            onMove={onMove}
            draggingId={draggingId}
            onDragStartNode={setDraggingId}
            onDragEndNode={() => setDraggingId(null)}
            t={t}
          />
        ))}
      </ul>
    </div>
  );
}
