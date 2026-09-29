// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, LoaderCircle, X } from 'lucide-react';
import { useSurface, useAppearance } from '../../app/runtime';

export function Button({
  children,
  variant = 'secondary',
  busy,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className={`button ${variant} ${className}`}
      {...props}
      disabled={props.disabled || busy}
    >
      {busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
export function IconButton({
  label,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  eyebrow,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const { registerModal } = useSurface();
  const { t } = useAppearance();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const cleanup = registerModal();
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    element?.showModal();
    return () => {
      element?.close();
      cleanup();
      // WebView2 can lose native dialog focus restoration when React removes it.
      // Wait for the closing render, and never steal focus from another dialog.
      window.requestAnimationFrame(() => {
        if (!opener?.isConnected) return;
        const dialogs = Array.from(document.querySelectorAll('dialog[open]'));
        if (dialogs.length && !dialogs.some(item => item.contains(opener))) return;
        if (document.activeElement === document.body ||
            !document.activeElement || element?.contains(document.activeElement)) {
          opener.focus({ preventScroll: true });
        }
      });
    };
  }, [registerModal]);
  return createPortal(
    <dialog
      ref={dialog}
      className={`modal ${wide ? 'wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-inner">
        <header className="modal-header">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <IconButton label={t('閉じる', 'Close')} onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>
        {children}
      </div>
    </dialog>,
    document.body,
  );
}
export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-symbol">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function PageTitle({
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-title">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warning' | 'danger';
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function ExternalLabel({ children }: { children: ReactNode }) {
  return (
    <span className="external-label">
      {children}
      <ArrowUpRight size={14} />
    </span>
  );
}
