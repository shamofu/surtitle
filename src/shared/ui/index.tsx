// SPDX-License-Identifier: GPL-3.0-or-later
import { Children, cloneElement, Fragment, isValidElement, useId, useLayoutEffect, useRef } from 'react';
import type { ButtonHTMLAttributes, ComponentPropsWithRef, HTMLAttributes, ReactNode, RefObject } from 'react';
import { m, type HTMLMotionProps } from 'motion/react';
import { Button as AriaButton, Dialog, Modal as AriaModal, ModalOverlay } from 'react-aria-components';
import { ArrowUpRight, X } from 'lucide-react';
import { useSurface, useAppearance } from '../../app/runtime';
import { MotionRegion, MotionSwap, MotionSpinner, motionDistances, motionDurations, motionEase, motionScales, useMotionActive } from '../motion';
import { useShellPresence } from '../motion/useShellPresence';
export { useModalExit } from './useModalExit';

export function MotionButton({ hoverMotion = true, ...props }: ComponentPropsWithRef<'button'> & { hoverMotion?: boolean }) {
  const active = useMotionActive();
  const enabled = active && !props.disabled && props['aria-disabled'] !== true && props['aria-disabled'] !== 'true';
  // Expansion keeps the original hit area under a stationary edge pointer.
  return <m.button {...props as HTMLMotionProps<'button'>} data-motion-control initial={false} animate={{ scale: 1 }}
    whileHover={enabled && hoverMotion ? { scale: motionScales.hover } : undefined}
    whileTap={enabled ? { scale: motionScales.press, transition: { duration: motionDurations.press, ease: motionEase } } : undefined}
    transition={{ duration: active ? motionDurations.release : 0, ease: motionEase }} />;
}

const MotionAriaButton = m.create(AriaButton);

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
    <MotionButton
      type="button"
      className={`button ${variant} ${className}`}
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || props['aria-busy'] || undefined}
    >
      <MotionRegion mode="status" as="span" open={!!busy}><MotionSpinner /></MotionRegion>
      {children}
    </MotionButton>
  );
}
export function IconButton({
  label,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <MotionButton
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </MotionButton>
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
// Register the actual portal node to retain input blocking and notification focus.
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
  const motionActive = useMotionActive();
  const titleId = useId();
  // Accepted async closes retain their input subtree and focus scope for retries.
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
    if (open) return;
    // Move focus out before making the old controls inert. Notifications remain usable.
    const element = dialog.current;
    if (element?.querySelector('.modal-body')?.contains(document.activeElement)) element.focus({ preventScroll: true });
  }, [open, dialog]);
  useShellPresence(dialog, { open, distance: motionDistances.modal, enterDuration: motionDurations.modal, exitDuration: motionDurations.exit, onExited });
  return (
    <Dialog
      ref={dialog}
      className={`modal ${wide ? 'wide' : ''}`}
      aria-labelledby={titleId}
      data-app-modal=""
      data-motion-geometry="stable"
      data-state={open ? 'open' : 'closing'}
    >
      <div className="modal-inner">
        <header className="modal-header">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <MotionAriaButton className="icon-button" data-motion-control aria-label={t('閉じる', 'Close')} isDisabled={closeDisabled || !open} onPress={requestClose}
            initial={false} animate={{ scale: 1 }}
            whileHover={motionActive && open && !closeDisabled ? { scale: motionScales.hover } : undefined}
            whileTap={motionActive && open && !closeDisabled ? { scale: motionScales.press, transition: { duration: motionDurations.press } } : undefined}
            transition={{ duration: motionActive ? motionDurations.release : 0, ease: motionEase }}>
            <X size={20} />
          </MotionAriaButton>
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
