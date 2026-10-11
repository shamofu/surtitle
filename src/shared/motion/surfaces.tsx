// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { motionCssEase, motionDurations, useAppMotion } from './index';

type ElementProps = HTMLAttributes<HTMLElement> & { as?: 'div' | 'span'; children?: ReactNode };

export function canAnimate(element: HTMLElement, reduced: boolean) {
  return !reduced && !document.hidden && typeof element.animate === 'function';
}

/** Only current content enters. Live inputs and their selection never remount. */
export function useMotionChange<T extends HTMLElement>(ref: RefObject<T | null>, key: string | number, disabled = false) {
  const { reducedMotion } = useAppMotion();
  const previous = useRef(key);
  useLayoutEffect(() => {
    const changed = previous.current !== key;
    previous.current = key;
    const element = ref.current;
    if (!element || !changed || !canAnimate(element, reducedMotion || disabled)) return;
    const animation = element.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: motionDurations.swap * 1000, easing: motionCssEase,
    });
    const finish = () => animation.cancel();
    const timer = window.setTimeout(finish, motionDurations.swap * 1000 + 100);
    document.addEventListener('visibilitychange', finish);
    void animation.finished.then(finish, () => {});
    return () => {
      animation.cancel(); window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', finish);
    };
  }, [ref, key, disabled, reducedMotion]);
}

/** Interrupted disclosures reverse from their visible size. */
export function animateHeight(element: HTMLElement, from: number, to: number, onComplete: () => void) {
  const original = { height: element.style.height, overflow: element.style.overflow, minHeight: element.style.minHeight };
  element.style.overflow = 'hidden';
  element.style.minHeight = '0';
  const animation = element.animate([{ height: from + 'px' }, { height: to + 'px' }], {
    duration: motionDurations.reveal * 1000, easing: motionCssEase, fill: 'both',
  });
  let finished = false;
  const restore = () => {
    animation.cancel();
    Object.assign(element.style, original);
    window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('resize', complete);
  };
  const complete = () => {
    if (finished) return;
    finished = true;
    // Keep the measured endpoint until React commits hidden/open=false. Restoring
    // natural height first can expose the full contents for one painted frame.
    flushSync(onComplete);
    restore();
  };
  const visibility = () => { if (document.hidden) complete(); };
  const timer = window.setTimeout(complete, motionDurations.reveal * 1000 + 100);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('resize', complete);
  void animation.finished.then(complete, () => {});
  return () => {
    const height = finished ? undefined : element.getBoundingClientRect().height;
    finished = true;
    restore();
    return height;
  };
}

/** Spatial disclosure retains its live subtree; status changes are immediate. */
export function MotionRegion({ open, keepMounted = false, mode = 'disclosure', as: Tag = 'div', children, className = '', ...props }: ElementProps & {
  open: boolean; keepMounted?: boolean; mode?: 'disclosure' | 'status';
}) {
  const { reducedMotion } = useAppMotion();
  const element = useRef<HTMLElement>(null);
  const [retained, setRetained] = useState(open);
  const lastChildren = useRef(children);
  const hasOpened = useRef(open);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(open);
  const mounted = useRef(false);
  const interruptedHeight = useRef<number | undefined>(undefined);
  const visible = open || (retained && !reducedMotion && mode === 'disclosure');
  useLayoutEffect(() => { if (open) { lastChildren.current = children; hasOpened.current = true; } }, [open, children]);
  useLayoutEffect(() => {
    const node = element.current;
    const previouslyOpen = wasOpen.current;
    const first = !mounted.current;
    mounted.current = true;
    wasOpen.current = open;
    if (open) setRetained(true);
    if (!node) return;
    if (open && !previouslyOpen && document.activeElement instanceof HTMLElement && !node.contains(document.activeElement)) opener.current = document.activeElement;
    const restoreFocus = !open && node.contains(document.activeElement) && opener.current?.isConnected;
    if (restoreFocus && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const finish = () => {
      if (!open) setRetained(false);
      if (restoreFocus && opener.current?.isConnected &&
          (document.activeElement === document.body || node.contains(document.activeElement))) opener.current.focus({ preventScroll: true });
    };
    if (first || mode === 'status' || !canAnimate(node, reducedMotion)) {
      interruptedHeight.current = undefined;
      finish();
      return;
    }
    if (!open && !previouslyOpen) { finish(); return; }
    const from = interruptedHeight.current ?? (open ? 0 : node.getBoundingClientRect().height);
    interruptedHeight.current = undefined;
    const to = open ? node.getBoundingClientRect().height : 0;
    const cancel = animateHeight(node, from, to, finish);
    return () => { interruptedHeight.current = cancel(); };
  }, [open, reducedMotion, mode]);
  return <Tag {...props} ref={element as RefObject<HTMLDivElement & HTMLSpanElement>}
    className={'motion-region ' + className} data-motion-mode={mode} data-motion-state={open ? 'open' : visible ? 'exiting' : 'closed'}
    hidden={!visible} inert={!open} aria-hidden={!open || undefined}>
    {open ? children : visible ? lastChildren.current : keepMounted && hasOpened.current ? children : null}
  </Tag>;
}

/** Incoming content only, without cloning old actions or replacing the live subtree. */
export function MotionSwap({ stateKey, disabled = false, as: Tag = 'div', children, className = '', ...props }: ElementProps & {
  stateKey: string | number; disabled?: boolean;
}) {
  const live = useRef<HTMLElement>(null);
  useMotionChange(live, stateKey, disabled);
  return <Tag {...props} className={'motion-swap' + (Tag === 'span' ? ' motion-swap-inline' : '') + ' ' + className}>
    <Tag ref={live as RefObject<HTMLDivElement & HTMLSpanElement>} className="motion-swap-live">{children}</Tag>
  </Tag>;
}

/** Measured values update immediately, including during playback and progress ticks. */
export function AnimatedValue({ value, immediate: _immediate, className = '' }: {
  value: string | number; immediate?: boolean; className?: string;
}) {
  return <span className={'animated-value ' + className}>{value}</span>;
}
