import type { TreeSortMode } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

interface TreeToolbarProps {
  sortMode: TreeSortMode;
  onSortMode: (mode: TreeSortMode) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

export function TreeToolbar({ sortMode, onSortMode, onExpandAll, onCollapseAll }: TreeToolbarProps) {
  const t = useT();
  return (
    <div className="fn-tree-toolbar">
      <div className="fn-tree-toolbar__group">
        <button type="button" title={t('treeToolbar.expandAll')} onClick={onExpandAll}>
          ▾▾
        </button>
        <button type="button" title={t('treeToolbar.collapseAll')} onClick={onCollapseAll}>
          ▸▸
        </button>
      </div>
      <select
        className="fn-tree-toolbar__sort"
        value={sortMode}
        onChange={(e) => onSortMode(e.target.value as TreeSortMode)}
        title={t('treeToolbar.sortLabel')}
      >
        <option value="manual">{t('treeToolbar.sortManual')}</option>
        <option value="name">{t('treeToolbar.sortName')}</option>
        <option value="modified">{t('treeToolbar.sortModified')}</option>
      </select>
    </div>
  );
}
