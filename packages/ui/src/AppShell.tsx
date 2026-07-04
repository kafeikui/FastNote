import type { ReactNode } from 'react';
import { APP_NAME } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

interface AppShellProps {
  sidebar: ReactNode;
  main: ReactNode;
  toolbar?: ReactNode;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

export function AppShell({ sidebar, main, toolbar, sidebarCollapsed = false, onToggleSidebar }: AppShellProps) {
  const t = useT();
  return (
    <div className="fn-app">
      <header className="fn-header">
        <span className="fn-logo">{APP_NAME}</span>
        {toolbar}
      </header>
      <div className="fn-body">
        <aside className={`fn-sidebar${sidebarCollapsed ? ' fn-sidebar--collapsed' : ''}`}>
          <div className="fn-sidebar__content">{sidebar}</div>
        </aside>
        {onToggleSidebar && (
          <button
            type="button"
            className="fn-sidebar-toggle"
            onClick={onToggleSidebar}
            title={sidebarCollapsed ? t('appShell.expandSidebar') : t('appShell.collapseSidebar')}
            aria-label={sidebarCollapsed ? t('appShell.expandSidebar') : t('appShell.collapseSidebar')}
          >
            {sidebarCollapsed ? '»' : '«'}
          </button>
        )}
        <main className="fn-main">{main}</main>
      </div>
    </div>
  );
}
