import type { ReactNode } from 'react';
import { Check, LoaderCircle, RotateCcw } from 'lucide-react';
import './form-save-bar.css';

export interface FormSaveBarProps {
  form?: string;
  busy?: boolean;
  disabled?: boolean;
  dirty?: boolean;
  status: ReactNode;
  saveLabel?: string;
  onSave?: () => void;
  onDiscard?: () => void;
  discardLabel?: string;
  children?: ReactNode;
  label?: string;
  className?: string;
}

/** One persistent action area for a long editor. The caller owns its saved
 * baseline, validation and submit lifecycle; the bar never writes by itself. */
export function FormSaveBar({
  form,
  busy = false,
  disabled = false,
  dirty = false,
  status,
  saveLabel = '保存',
  onSave,
  onDiscard,
  discardLabel = '放弃当前修改',
  children,
  label = '保存操作',
  className = '',
}: FormSaveBarProps) {
  return (
    <section
      className={`form-save-bar${dirty ? ' is-dirty' : ''} ${className}`}
      aria-label={label}
      aria-busy={busy || undefined}
    >
      <div className="form-save-bar-status" role="status">
        {status}
      </div>
      <div className="form-save-bar-actions">
        {children}
        {onDiscard && (
          <button
            className="button"
            type="button"
            disabled={busy || disabled || !dirty}
            onClick={onDiscard}
          >
            <RotateCcw size={15} />
            {discardLabel}
          </button>
        )}
        <button
          className="button primary"
          type={onSave ? 'button' : 'submit'}
          form={onSave ? undefined : form}
          disabled={busy || disabled}
          onClick={onSave}
        >
          {busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
          {busy ? '正在保存…' : saveLabel}
        </button>
      </div>
    </section>
  );
}
