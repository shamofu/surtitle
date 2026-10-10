// SPDX-License-Identifier: GPL-3.0-or-later
import { Children, cloneElement, Fragment, isValidElement, useId, useLayoutEffect, useRef } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
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
  closeDisabled = false,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  closeDisabled?: boolean;
}) {
  const { registerModal, activeModal } = useSurface();
  const { t } = useAppearance();
  const dialog = useRef<HTMLDialogElement>(null);
  const notificationHost = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Register the native top layer before paint so an immediate Escape cannot
  // observe the previous modal as the active surface.
  useLayoutEffect(() => {
    const element = dialog.current;
    const host = notificationHost.current;
    if (!element || !host) return;
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    element.showModal();
    const cleanup = registerModal(element, host);
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
  function requestClose() {
    if (!closeDisabled && (!activeModal || activeModal === dialog.current)) onClose();
  }
  return createPortal(
    <dialog
      ref={dialog}
      className={`modal ${wide ? 'wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.target === event.currentTarget) requestClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          event.stopPropagation();
          requestClose();
        }
      }}
    >
      <div className="modal-inner">
        <header className="modal-header">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <IconButton label={t('閉じる', 'Close')} disabled={closeDisabled} onClick={requestClose}>
            <X size={20} />
          </IconButton>
        </header>
        <div className="modal-notifications" ref={notificationHost} />
        <div className="modal-body">{children}</div>
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
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  const id = useId();
  const description = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');
  const associate = (content: ReactNode): ReactNode => Children.map(content, child => {
    if (!isValidElement<HTMLAttributes<HTMLElement>>(child)) return child;
    const nativeControl = typeof child.type === 'string' && ['input', 'select', 'textarea'].includes(child.type);
    const customControl = typeof child.type !== 'string' && child.type !== Fragment &&
      ('value' in child.props || 'defaultValue' in child.props || 'checked' in child.props);
    if (!nativeControl && !customControl) {
      return child.props.children ? cloneElement(child, { children: associate(child.props.children) }) : child;
    }
    // Custom controls such as LanguageInput forward these attributes to input.
    return cloneElement(child, {
      'aria-labelledby': child.props['aria-labelledby'] || `${id}-label`,
      'aria-invalid': error ? true : child.props['aria-invalid'],
      'aria-describedby': [child.props['aria-describedby'], description].filter(Boolean).join(' ') || undefined,
    });
  });
  return (
    <label className="field">
      <span id={`${id}-label`}>{label}</span>
      {associate(children)}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {error && <small id={`${id}-error`} className="field-error">{error}</small>}
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
