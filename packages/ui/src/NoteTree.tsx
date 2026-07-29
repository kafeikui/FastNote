import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { NoteNode } from '@fastnote/shared';
import { buildTree, type TreeDropPosition, type TreeItem } from '@fastnote/shared';
import { useT, type TFunction } from '@fastnote/i18n';
import { TrashSection } from './TrashSection';

const DRAG_MIME = 'application/x-fastnote-node';

export interface TreeSelectModifiers {
  ctrl: boolean;
  shift: boolean;
}

interface NoteTreeProps {
  notes: NoteNode[];
  activeId: string | null;
  /** Multi-selection (Ctrl/Shift+click); rows in this set are highlighted. */
  selectedIds?: Set<string>;
  collapsedIds: Set<string>;
  onToggleCollapse: (id: string) => void;
  revealId?: string | null;
  onSelect: (id: string, mods: TreeSelectModifiers) => void;
  /** Double-click on a note/table opens it as a permanent (pinned) tab. */
  onOpenPinned?: (id: string) => void;
  onCreateFolder: (parentId: string | null) => void;
  onCreateNote: (parentId: string | null) => void;
  onCreateTable: (parentId: string | null) => void;
  onImportFolder?: (parentId: string | null) => void;
  onRename: (id: string, title: string) => void;
  /** Moves the node (with its subtree) into the recycle bin. */
  onDelete: (id: string) => void;
  /** Restores a recycle-bin entry back into the tree. */
  onRestore?: (id: string) => void;
  /** Permanently deletes one recycle-bin entry (with its subtree). */
  onDeleteForever?: (id: string) => void;
  /** Permanently deletes everything in the recycle bin. */
  onEmptyTrash?: () => void;
  onMove: (dragId: string, targetId: string | null, position: TreeDropPosition) => void;
  /** Opens the cross-vault transfer dialog for this node (plus the current multi-selection). */
  onTransfer?: (id: string) => void;
  /** When set to a node id, that node enters rename mode (e.g. via the F2 shortcut). */
  renameRequestId?: string | null;
  onRenameRequestHandled?: () => void;
  /**
   * Whether to show the pending-sync dot. Only meaningful for cloud-connected vaults; in a
   * local-only vault every node is permanently "pending" and the dot would just be noise.
   */
  showSyncStatus?: boolean;
  /** Notes/tables with an active real-time collaboration session get a highlighted 👥 badge. */
  collabIds?: Set<string>;
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
  selectedIds,
  collapsedIds,
  onToggleCollapse,
  revealId,
  onSelect,
  onOpenPinned,
  onCreateFolder,
  onCreateNote,
  onCreateTable,
  onImportFolder,
  onRename,
  onDelete,
  onMove,
  onTransfer,
  renameRequestId,
  onRenameRequestHandled,
  showSyncStatus,
  collabIds,
  draggingId,
  onDragStartNode,
  onDragEndNode,
  t,
}: {
  item: TreeItem;
  depth: number;
  activeId: string | null;
  selectedIds?: Set<string>;
  collapsedIds: Set<string>;
  onToggleCollapse: (id: string) => void;
  revealId?: string | null;
  onSelect: (id: string, mods: TreeSelectModifiers) => void;
  onOpenPinned?: (id: string) => void;
  onCreateFolder: (parentId: string | null) => void;
  onCreateNote: (parentId: string | null) => void;
  onCreateTable: (parentId: string | null) => void;
  onImportFolder?: (parentId: string | null) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onMove: (dragId: string, targetId: string | null, position: TreeDropPosition) => void;
  onTransfer?: (id: string) => void;
  renameRequestId?: string | null;
  onRenameRequestHandled?: () => void;
  showSyncStatus?: boolean;
  collabIds?: Set<string>;
  draggingId: string | null;
  onDragStartNode: (id: string) => void;
  onDragEndNode: () => void;
  t: TFunction;
}) {
  const { node, children } = item;
  const expanded = !collapsedIds.has(node.id);
  const [dropHint, setDropHint] = useState<DropHint>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.title);
  const [flash, setFlash] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);

  const isFolder = node.nodeType === 'folder';
  const isTable = node.nodeType === 'table';
  const isActive = node.id === activeId;
  const isSelected = selectedIds?.has(node.id) ?? false;
  const icon = isFolder ? '📁' : isTable ? '📊' : '📝';
  const defaultTitle = isFolder
    ? t('noteTree.untitledFolder')
    : isTable
      ? t('noteTree.untitledTable')
      : t('noteTree.untitledNote');

  useEffect(() => {
    if (!revealId || revealId !== node.id) return;
    rowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 1400);
    return () => clearTimeout(timer);
  }, [revealId, node.id]);

  useEffect(() => {
    if (!renameRequestId || renameRequestId !== node.id) return;
    setRenameValue(node.title || defaultTitle);
    setRenaming(true);
    onRenameRequestHandled?.();
  }, [renameRequestId, node.id]);

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
    isSelected ? 'fn-tree-node__row--selected' : '',
    dropHint === 'inside' ? 'fn-tree-node__row--drop-inside' : '',
    dropHint === 'before' ? 'fn-tree-node__row--drop-before' : '',
    dropHint === 'after' ? 'fn-tree-node__row--drop-after' : '',
    flash ? 'fn-tree-node__row--flash' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li className={`fn-tree-node ${isActive ? 'active' : ''}`}>
      <div
        ref={rowRef}
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
            onClick={() => onToggleCollapse(node.id)}
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
            onClick={(ev) => onSelect(node.id, { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey })}
            onDoubleClick={(ev) => {
              ev.preventDefault();
              if (isFolder || !onOpenPinned) {
                startRename();
              } else {
                onOpenPinned(node.id);
              }
            }}
          >
            <span className="fn-tree-node__icon">{icon}</span>
            <span className="fn-tree-node__text">{node.title || defaultTitle}</span>
            {collabIds?.has(node.id) && (
              <span className="fn-collab-tree-badge" title={t('noteTree.collabActive')}>
                👥
              </span>
            )}
            {showSyncStatus && node.syncStatus === 'pending' && (
              <span className="fn-sync-dot" title={t('noteTree.pendingSync')} />
            )}
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
          {onTransfer && (
            <button type="button" title={t('noteTree.transfer')} onClick={() => onTransfer(node.id)}>
              ⇄
            </button>
          )}
          <button type="button" title={t('noteTree.rename')} onClick={startRename}>
            ✎
          </button>
          <button
            type="button"
            title={t('noteTree.delete')}
            onClick={() => {
              // Confirmed, though recoverable: the node moves into the recycle bin.
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
              selectedIds={selectedIds}
              collapsedIds={collapsedIds}
              onToggleCollapse={onToggleCollapse}
              revealId={revealId}
              onSelect={onSelect}
              onOpenPinned={onOpenPinned}
              onCreateFolder={onCreateFolder}
              onCreateNote={onCreateNote}
              onCreateTable={onCreateTable}
              onImportFolder={onImportFolder}
              onRename={onRename}
              onDelete={onDelete}
              onMove={onMove}
              onTransfer={onTransfer}
              renameRequestId={renameRequestId}
              onRenameRequestHandled={onRenameRequestHandled}
              showSyncStatus={showSyncStatus}
              collabIds={collabIds}
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
  selectedIds,
  collapsedIds,
  onToggleCollapse,
  revealId,
  onSelect,
  onOpenPinned,
  onCreateFolder,
  onCreateNote,
  onCreateTable,
  onImportFolder,
  onRename,
  onDelete,
  onRestore,
  onDeleteForever,
  onEmptyTrash,
  onMove,
  onTransfer,
  renameRequestId,
  onRenameRequestHandled,
  showSyncStatus,
  collabIds,
}: NoteTreeProps) {
  const t = useT();
  const [rootDrop, setRootDrop] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const tree = buildTree(notes.filter((n) => !n.trashed));

  // Recycle bin: only the roots of trashed subtrees are listed — restoring/purging a root
  // takes its descendants with it.
  const byId = new Map(notes.map((n) => [n.id, n]));
  const trashedCount = notes.filter((n) => n.trashed).length;
  const trashItems = notes
    .filter((n) => n.trashed && (!n.parentId || !byId.get(n.parentId)?.trashed))
    .map((n) => ({
      id: n.id,
      title:
        n.title ||
        t(
          n.nodeType === 'folder'
            ? 'noteTree.untitledFolder'
            : n.nodeType === 'table'
              ? 'noteTree.untitledTable'
              : 'noteTree.untitledNote',
        ),
      icon: n.nodeType === 'folder' ? '📁' : n.nodeType === 'table' ? '📊' : '📝',
    }));
  const trashSection =
    onRestore && onDeleteForever && onEmptyTrash ? (
      <TrashSection
        items={trashItems}
        emptyCount={trashedCount}
        onRestore={onRestore}
        onDeleteForever={onDeleteForever}
        onEmpty={onEmptyTrash}
      />
    ) : null;

  // Auto-scroll the sidebar while dragging a node near its top/bottom edge, so nodes can be
  // dropped onto targets that are currently scrolled out of view. Capture phase: the per-node
  // dragover handlers stop propagation, so a bubble-phase handler here would never fire.
  const handleDragAutoScroll = (e: DragEvent) => {
    const scroller = (e.currentTarget as HTMLElement).closest('.fn-notes-sidebar__tree, .fn-sidebar');
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const zone = 48;
    const maxStep = 24;
    const fromTop = e.clientY - rect.top;
    const fromBottom = rect.bottom - e.clientY;
    if (fromTop < zone) {
      scroller.scrollTop -= Math.ceil(((zone - fromTop) / zone) * maxStep);
    } else if (fromBottom < zone) {
      scroller.scrollTop += Math.ceil(((zone - fromBottom) / zone) * maxStep);
    }
  };

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
        onDragOverCapture={handleDragAutoScroll}
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
        {trashSection}
      </div>
    );
  }

  return (
    <div
      className={`fn-tree-root-zone ${rootDrop ? 'fn-tree-root-zone--active' : ''}`}
      onDragOver={handleRootDragOver}
      onDragOverCapture={handleDragAutoScroll}
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
            selectedIds={selectedIds}
            collapsedIds={collapsedIds}
            onToggleCollapse={onToggleCollapse}
            revealId={revealId}
            onSelect={onSelect}
            onOpenPinned={onOpenPinned}
            onCreateFolder={onCreateFolder}
            onCreateNote={onCreateNote}
            onCreateTable={onCreateTable}
            onImportFolder={onImportFolder}
            onRename={onRename}
            onDelete={onDelete}
            onMove={onMove}
            onTransfer={onTransfer}
            renameRequestId={renameRequestId}
            onRenameRequestHandled={onRenameRequestHandled}
            showSyncStatus={showSyncStatus}
            collabIds={collabIds}
            draggingId={draggingId}
            onDragStartNode={setDraggingId}
            onDragEndNode={() => setDraggingId(null)}
            t={t}
          />
        ))}
      </ul>
      {trashSection}
    </div>
  );
}
