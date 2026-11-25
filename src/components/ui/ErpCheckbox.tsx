import { useEffect, useRef } from 'react';
import { Check, Minus } from 'lucide-react';

export interface ErpCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  locked?: boolean;
  ariaLabel: string;
  title?: string;
  onChange?: () => void;
}

export function ErpCheckbox({
  checked,
  indeterminate = false,
  disabled = false,
  locked = false,
  ariaLabel,
  title,
  onChange,
}: ErpCheckboxProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  const isDisabled = disabled || locked;
  const isActive = checked || indeterminate;

  const boxClass = locked
    ? 'bg-slate-200/80 border-slate-300 text-slate-500 cursor-not-allowed'
    : isDisabled
      ? isActive
        ? 'bg-brand/45 border-brand/45 text-white cursor-not-allowed'
        : 'bg-slate-100 border-hairline-strong text-transparent cursor-not-allowed'
      : isActive
        ? 'bg-brand border-brand text-white hover:bg-brand-hover cursor-pointer'
        : 'bg-white border-[#b5c2d4] text-transparent hover:border-brand cursor-pointer';

  return (
    <span
      className="relative inline-flex items-center justify-center w-4 h-4 align-middle"
      title={title}
    >
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        disabled={isDisabled}
        aria-label={ariaLabel}
        onChange={onChange}
        className="peer absolute inset-0 w-full h-full opacity-0 m-0 cursor-pointer disabled:cursor-not-allowed z-10"
      />
      <span
        aria-hidden="true"
        className={`w-4 h-4 rounded-[2px] border inline-flex items-center justify-center transition-colors duration-150 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand ${boxClass}`}
      >
        {indeterminate ? (
          <Minus className="w-3 h-3 stroke-[2.75]" />
        ) : checked ? (
          <Check className="w-3 h-3 stroke-[2.75]" />
        ) : null}
      </span>
    </span>
  );
}
