import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export const DEFAULT_TABLE_PAGE_SIZE = 10;
export const HIGH_VOLUME_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export interface PaginatedSlice<T> {
  pageItems: T[];
  safePage: number;
  totalPages: number;
}

export function paginateItems<T>(
  items: readonly T[],
  currentPage: number,
  pageSize = DEFAULT_TABLE_PAGE_SIZE
): PaginatedSlice<T> {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    pageItems: items.slice(start, start + pageSize),
    safePage,
    totalPages,
  };
}

export interface TablePaginationProps {
  currentPage: number;
  totalItems: number;
  pageSize?: number;
  maxVisiblePages?: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
  itemLabel?: string;
  hideWhenSinglePage?: boolean;
}

interface PaginationModel {
  showFirst: boolean;
  showLeadingEllipsis: boolean;
  middlePages: number[];
  showTrailingEllipsis: boolean;
  showLast: boolean;
}

function buildPaginationModel(
  currentPage: number,
  totalPages: number,
  maxVisible: number
): PaginationModel {
  if (totalPages <= maxVisible + 2) {
    return {
      showFirst: false,
      showLeadingEllipsis: false,
      middlePages: Array.from({ length: totalPages }, (_, i) => i + 1),
      showTrailingEllipsis: false,
      showLast: false,
    };
  }

  const half = Math.floor(maxVisible / 2);
  let start = Math.max(1, currentPage - half);
  let end = start + maxVisible - 1;
  if (end > totalPages) {
    end = totalPages;
    start = Math.max(1, end - maxVisible + 1);
  }

  const middlePages = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const showFirst = start > 1;
  const showLeadingEllipsis = start > 2;
  const showLast = end < totalPages;
  const showTrailingEllipsis = end < totalPages - 1;

  return {
    showFirst,
    showLeadingEllipsis,
    middlePages,
    showTrailingEllipsis,
    showLast,
  };
}

export function TablePagination({
  currentPage,
  totalItems,
  pageSize = DEFAULT_TABLE_PAGE_SIZE,
  maxVisiblePages = 3,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  itemLabel,
  hideWhenSinglePage = false,
}: TablePaginationProps) {
  const { t } = useTranslation('common');
  const resolvedLabel = itemLabel ?? t('pagination.defaultItemLabel');
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if (hideWhenSinglePage && totalPages <= 1) {
    return null;
  }

  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, totalItems);
  const model = buildPaginationModel(safePage, totalPages, maxVisiblePages);

  const renderPageButton = (page: number) => {
    const isCurrent = page === safePage;
    return (
      <button
        key={page}
        type="button"
        onClick={() => onPageChange(page)}
        aria-label={t('pagination.pageAria', { page })}
        aria-current={isCurrent ? 'page' : undefined}
        className={`inline-flex items-center justify-center min-w-7 h-7 px-1.5 rounded-[2px] border text-xs font-mono tabular-nums transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand ${
          isCurrent
            ? 'bg-brand text-white border-brand font-semibold'
            : 'bg-surface text-slate-700 border-hairline-strong hover:bg-[#f4f6f9] hover:text-ink font-medium'
        }`}
      >
        {page}
      </button>
    );
  };

  return (
    <div className="px-5 py-3 border-t border-hairline bg-surface flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-slate-600 tabular-nums whitespace-nowrap">
        {totalItems === 0 ? (
          <span>{t('pagination.empty', { label: resolvedLabel })}</span>
        ) : (
          <span>
            {t('pagination.showing')} <strong className="text-ink">{startIndex}–{endIndex}</strong>{' '}
            {t('pagination.of')}{' '}
            <strong className="text-ink">{totalItems.toLocaleString()}</strong> {resolvedLabel}
          </span>
        )}

        {onPageSizeChange && (
          <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
            <span className="font-sans text-slate-500">{t('pagination.rowsPerPage')}</span>
            <select
              value={pageSize}
              onChange={(e) => {
                onPageSizeChange(Number(e.target.value));
                onPageChange(1);
              }}
              aria-label={t('pagination.rowsPerPageAria')}
              className="px-1.5 py-0.5 text-[11px] font-mono bg-surface border border-hairline-strong rounded-[2px] text-ink cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
            >
              {pageSizeOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <nav
        aria-label={t('pagination.navAria')}
        className="flex items-center justify-end gap-1 ml-auto shrink-0"
      >
        <button
          type="button"
          onClick={() => onPageChange(safePage - 1)}
          disabled={safePage <= 1}
          aria-label={t('pagination.previousPage')}
          title={t('pagination.previousPage')}
          className="inline-flex items-center justify-center w-7 h-7 rounded-[2px] border border-hairline-strong bg-surface text-slate-700 hover:bg-[#f4f6f9] hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>

        {model.showFirst && renderPageButton(1)}

        {model.showLeadingEllipsis && (
          <span
            aria-hidden="true"
            className="inline-flex items-center justify-center w-5 h-7 text-xs font-mono text-slate-400 select-none"
          >
            …
          </span>
        )}

        {model.middlePages.map((page) => renderPageButton(page))}

        {model.showTrailingEllipsis && (
          <span
            aria-hidden="true"
            className="inline-flex items-center justify-center w-5 h-7 text-xs font-mono text-slate-400 select-none"
          >
            …
          </span>
        )}

        {model.showLast && renderPageButton(totalPages)}

        <button
          type="button"
          onClick={() => onPageChange(safePage + 1)}
          disabled={safePage >= totalPages}
          aria-label={t('pagination.nextPage')}
          title={t('pagination.nextPage')}
          className="inline-flex items-center justify-center w-7 h-7 rounded-[2px] border border-hairline-strong bg-surface text-slate-700 hover:bg-[#f4f6f9] hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </nav>
    </div>
  );
}
