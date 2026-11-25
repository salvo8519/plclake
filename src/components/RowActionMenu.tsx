import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';

export interface RowActionItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'danger';
  dividerBefore?: boolean;
  title?: string;
}

interface RowActionMenuProps {
  items: RowActionItem[];
  ariaLabel: string;
  disabled?: boolean;
}

interface MenuPosition {
  top: number;
  left: number;
}

export function RowActionMenu({ items, ariaLabel, disabled = false }: RowActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const computePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const menuWidth = menuRef.current?.offsetWidth ?? 196;
    const menuHeight = menuRef.current?.offsetHeight ?? Math.max(items.length * 34 + 12, 48);
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const gap = 4;
    const margin = 8;

    let left = rect.right - menuWidth;
    if (left < margin) left = margin;
    if (left + menuWidth > viewportW - margin) {
      left = Math.max(margin, viewportW - menuWidth - margin);
    }

    const spaceBelow = viewportH - rect.bottom;
    const spaceAbove = rect.top;
    let top: number;
    if (spaceBelow >= menuHeight + gap || spaceBelow >= spaceAbove) {
      top = Math.min(rect.bottom + gap, viewportH - menuHeight - margin);
    } else {
      top = Math.max(margin, rect.top - menuHeight - gap);
    }

    setPosition({ top, left });
  }, [items.length]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    computePosition();
    const rafId = window.requestAnimationFrame(computePosition);
    return () => window.cancelAnimationFrame(rafId);
  }, [open, computePosition]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    const handleViewportChange = () => {
      setOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [open]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ??
        []
    );
    if (buttons.length === 0) return;

    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = currentIndex < 0 ? 0 : (currentIndex + 1) % buttons.length;
      buttons[next].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prev = currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1;
      buttons[prev].focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      buttons[0].focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      buttons[buttons.length - 1].focus();
    }
  };

  const allDisabled = disabled || items.every((item) => item.disabled);

  return (
    <div className="inline-flex justify-end">
      <button
        ref={triggerRef}
        type="button"
        disabled={allDisabled}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
        className={`inline-flex items-center justify-center w-7 h-7 rounded-[2px] border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand ${
          open
            ? 'bg-[#f4f6f9] border-hairline-strong text-ink'
            : 'bg-transparent border-transparent text-slate-600 hover:bg-[#f4f6f9] hover:border-hairline-strong hover:text-ink'
        }`}
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={ariaLabel}
            onKeyDown={handleMenuKeyDown}
            style={
              position
                ? { top: `${position.top}px`, left: `${position.left}px` }
                : { top: '-9999px', left: '-9999px' }
            }
            className="fixed z-50 min-w-[188px] max-w-[240px] bg-white border border-hairline-strong rounded-[2px] shadow-lg py-1 text-left"
          >
            {items.map((item) => {
              const toneClass =
                item.tone === 'danger'
                  ? 'text-red-700 hover:bg-red-50 focus-visible:bg-red-50'
                  : item.tone === 'primary'
                  ? 'text-brand hover:bg-brand-subtle focus-visible:bg-brand-subtle font-medium'
                  : 'text-slate-700 hover:bg-[#f4f6f9] focus-visible:bg-[#f4f6f9]';

              return (
                <div key={item.id}>
                  {item.dividerBefore && (
                    <div role="separator" className="my-1 border-t border-hairline" />
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    title={item.title}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (item.disabled) return;
                      setOpen(false);
                      item.onClick();
                    }}
                    className={`w-full px-3 py-1.5 text-xs flex items-center gap-2 text-left transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none whitespace-nowrap ${toneClass}`}
                  >
                    {item.icon && (
                      <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
                        {item.icon}
                      </span>
                    )}
                    <span className="truncate">{item.label}</span>
                  </button>
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}
