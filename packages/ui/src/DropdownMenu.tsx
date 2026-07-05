import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface DropdownMenuProps {
  label: ReactNode;
  title?: string;
  align?: 'left' | 'right';
  className?: string;
  children: ReactNode;
}

/**
 * Small, generic click-to-toggle menu used to group several related actions
 * (e.g. "New note / table / folder") behind a single toolbar button so they
 * don't each take up permanent horizontal space. Any click on a menu item
 * (or outside the menu, or Escape) closes it — items are plain buttons
 * passed in as children, no special API required from callers.
 */
export function DropdownMenu({ label, title, align = 'left', className, children }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className={`fn-dropdown${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className={`fn-dropdown__trigger${open ? ' active' : ''}`}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        {label} <span className="fn-dropdown__caret">▾</span>
      </button>
      {open && (
        <div
          className={`fn-dropdown__menu${align === 'right' ? ' fn-dropdown__menu--right' : ''}`}
          // Bubble phase (not capture!) so the clicked item's own onClick
          // always runs first — bubbling always fires target-before-ancestor,
          // whereas a capture-phase listener here would run before the
          // item's handler and risks the item unmounting (menu closing)
          // before its own click logic ever executes.
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}
