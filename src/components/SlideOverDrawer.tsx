import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SlideOverDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  size?: 'md' | 'lg' | 'xl';
  headerActions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

const SIZE_CLASS: Record<NonNullable<SlideOverDrawerProps['size']>, string> = {
  md: 'max-w-lg',
  lg: 'max-w-xl',
  xl: 'max-w-2xl',
};

export function SlideOverDrawer({
  open,
  onClose,
  title,
  subtitle,
  size = 'lg',
  headerActions,
  footer,
  children,
}: SlideOverDrawerProps) {
  const { t } = useTranslation('common');
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();

  useEffect(() => {
    if (open) {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMounted(true);
      const raf = window.requestAnimationFrame(() => {
        setVisible(true);
      });
      return () => window.cancelAnimationFrame(raf);
    }

    setVisible(false);
    const timer = window.setTimeout(() => {
      setMounted(false);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    }, 200);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const firstInput = panel.querySelector<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])'
      );
      if (firstInput) {
        firstInput.focus();
      } else {
        panel.focus();
      }
    }, 30);

    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={subtitle ? subtitleId : undefined}
    >
      {/* Scrim */}
      <div
        className={`fixed inset-0 bg-chrome/45 transition-opacity duration-200 ease-out motion-reduce:transition-none ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Right-anchored ERP Drawer Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`relative z-10 w-full ${SIZE_CLASS[size]} bg-white h-full border-l border-hairline-strong shadow-xl flex flex-col transform transition-transform duration-200 ease-out motion-reduce:transition-none focus:outline-none ${
          visible ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="px-5 py-4 border-b border-hairline bg-[#f8f9fb] flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-ink truncate">
              {title}
            </h2>
            {subtitle && (
              <p id={subtitleId} className="text-xs text-slate-600 mt-0.5">
                {subtitle}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {headerActions}
            <span className="hidden sm:inline font-mono text-[10px] text-slate-500 border border-hairline-strong bg-white px-1.5 py-0.5 rounded-[2px] select-none">
              ESC
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('actions.closeDrawer')}
              className="p-1.5 text-slate-500 hover:text-ink hover:bg-slate-200/70 rounded-[2px] cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="px-5 py-3.5 border-t border-hairline bg-[#f8f9fb] flex items-center justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

