// SPDX-License-Identifier: GPL-3.0-or-later
import { Children, cloneElement, Fragment, isValidElement, useId, useLayoutEffect, useRef } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, RefObject } from 'react';
import { Button as AriaButton, Dialog, Modal as AriaModal, ModalOverlay } from 'react-aria-components';
import { ArrowUpRight, LoaderCircle, X } from 'lucide-react';
import { useSurface, useAppearance } from '../../app/runtime';
import { MotionRegion, MotionSwap } from '../motion';
export { useModalExit } from './useModalExit';

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
      <MotionRegion mode="status" as="span" open={!!busy}><LoaderCircle size={16} className="spin" aria-hidden="true" /></MotionRegion>
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
interface ModalProps {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  closeDisabled?: boolean;
  open?: boolean;
  onExited?: () => void;
}
export function Modal(props: ModalProps) {
  const { activeModal } = useSurface();
  const dialog = useRef<HTMLElement>(null);
  const { open = true, closeDisabled = false } = props;
  function requestClose() {
    if (open && !closeDisabled && (!activeModal || activeModal === dialog.current)) props.onClose();
  }
  return <ModalOverlay
    className="modal-overlay"
    isOpen
    isDismissable={open && !closeDisabled}
    isKeyboardDismissDisabled={!open || closeDisabled}
    onOpenChange={next => { if (!next) requestClose(); }}
  >
    <AriaModal className="modal-container">
      <ModalContent {...props} dialog={dialog} requestClose={requestClose} />
    </AriaModal>
  </ModalOverlay>;
}
// This component mounts inside React Aria's portal, so surface registration
// happens with the actual dialog node before it can be painted over native video.
function ModalContent({
  title,
  eyebrow,
  children,
  wide = false,
  closeDisabled = false,
  open = true,
  onExited,
  dialog,
  requestClose,
}: ModalProps & { dialog: RefObject<HTMLElement | null>; requestClose: () => void }) {
  const { registerModal } = useSurface();
  const { t } = useAppearance();
  const notificationHost = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const completed = useRef(false);
  // Keep the opaque native exclusion until the owner unmounts. An accepted close can
  // still fail asynchronously; its inputs and focus scope must survive a retry.
  useLayoutEffect(() => {
    const element = dialog.current;
    const host = notificationHost.current;
    if (!element || !host) return;
    const unregister = registerModal(element, host);
    // Async editors initially render disabled inputs. Put keyboard focus on the
    // dialog before painting so inerting the opener cannot leave Escape on body.
    // React Aria still owns containment, IME handling, and return focus.
    if (!element.contains(document.activeElement)) element.focus({ preventScroll: true });
    return unregister;
  }, [dialog, registerModal]);
  useLayoutEffect(() => {
    if (open) { completed.current = false; return; }
    // Move focus out before making the old controls inert. Notifications remain usable.
    const element = dialog.current;
    if (element?.querySelector('.modal-body')?.contains(document.activeElement)) element.focus({ preventScroll: true });
    if (completed.current) return;
    completed.current = true;
    // Opaque native-video exclusions cannot follow CSS fades or transforms.
    // There is no visual exit to wait for; keep this scope while the owner commits.
    onExited?.();
  }, [open, onExited, dialog]);
  return (
    <Dialog
      ref={dialog}
      className={`modal ${wide ? 'wide' : ''}`}
      aria-labelledby={titleId}
      data-app-modal=""
      data-state={open ? 'open' : 'closing'}
    >
      <div className="modal-inner">
        <header className="modal-header">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <AriaButton className="icon-button" aria-label={t('閉じる', 'Close')} isDisabled={closeDisabled || !open} onPress={requestClose}>
            <X size={20} />
          </AriaButton>
        </header>
        <div className="modal-notifications" ref={notificationHost} />
        <div className="modal-body" inert={!open} onClickCapture={event => {
          if (!open) { event.preventDefault(); event.stopPropagation(); }
        }} onKeyDownCapture={event => {
          if (!open) { event.preventDefault(); event.stopPropagation(); }
        }}>{children}</div>
      </div>
    </Dialog>
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
      <MotionRegion mode="status" as="span" open={!!hint}><small id={`${id}-hint`}>{hint}</small></MotionRegion>
      <MotionRegion mode="status" as="span" open={!!error}><small id={`${id}-error`} className="field-error"><MotionSwap disabled as="span" stateKey={error ?? ''}>{error}</MotionSwap></small></MotionRegion>
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
  return <span className={`badge ${tone}`}><MotionSwap disabled as="span" stateKey={typeof children === 'string' || typeof children === 'number' ? children : tone}>{children}</MotionSwap></span>;
}
export function ExternalLabel({ children }: { children: ReactNode }) {
  return (
    <span className="external-label">
      {children}
      <ArrowUpRight size={14} />
    </span>
  );
}
