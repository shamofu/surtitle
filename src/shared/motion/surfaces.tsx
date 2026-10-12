// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { animate, motionValue } from 'motion';
import { motionDurations, useAppMotion } from './index';
import { motionEase, motionRevealEase, motionSnapEase, motionPresets, type MotionPreset } from './tokens';

type ElementProps = HTMLAttributes<HTMLElement> & { as?: 'div' | 'span'; children?: ReactNode };

export function canAnimate(element: HTMLElement, reduced: boolean) {
  return !reduced && !document.hidden && typeof element.animate === 'function';
}

/** Live text/status changes stay opaque; spatial transitions opt into a preset. */
export function useMotionChange<T extends HTMLElement>(ref: RefObject<T | null>, key: string | number, disabled = false, preset: MotionPreset = 'swap') {
  const { reducedMotion } = useAppMotion();
  const previous = useRef(key);
  useLayoutEffect(() => {
    const changed = previous.current !== key;
    previous.current = key;
    const element = ref.current;
    if (!element || !changed || preset === 'swap' || !canAnimate(element, reducedMotion || disabled)) return;
    return animateEntrance(element, preset);
  }, [ref, key, disabled, reducedMotion, preset]);
}

// One entrance owns a visual subtree. Child layout effects run before parents,
// so starting the parent also settles any entrance its children already began.
const entrances = new Map<HTMLElement, () => void>();

/** Animate only a safe live DOM region, never the native video's ancestors. */
export function animateEntrance(element: HTMLElement, preset: MotionPreset) {
  if (element.matches('.native-player-viewport, [data-app-modal]') || element.querySelector('.native-player-viewport')) return;
  for (const active of entrances.keys()) {
    if (active !== element && active.contains(element)) return;
  }
  for (const [active, cancel] of entrances) {
    if (element.contains(active)) cancel();
  }
  const { duration, x: distance, y } = motionPresets[preset];
  const direction = preset === 'page' ? element.closest('[data-page-direction]')?.getAttribute('data-page-direction') : undefined;
  const x = direction === 'backward' ? -distance : direction === 'none' ? 0 : distance;
  const original = { opacity: element.style.opacity, transform: element.style.transform };
  // Own the value rather than a cached DOM visual element. Unsubscribing before
  // stop prevents Motion's queued frame from restoring an interrupted pose.
  const progress = motionValue(0);
  const render = (value: number) => {
    element.style.opacity = String(value);
    if (x || y) element.style.transform = `translate(${x * (1 - value)}px, ${y * (1 - value)}px)`;
  };
  render(0);
  const unsubscribe = progress.on('change', render);
  const animation = animate(progress, 1, { duration, ease: preset === 'page' || preset === 'modal' ? motionSnapEase : motionEase });
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (entrances.get(element) === finish) entrances.delete(element);
    unsubscribe();
    animation.stop();
    progress.destroy();
    Object.assign(element.style, original);
    window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', finish);
    window.removeEventListener('resize', finish);
  };
  const timer = window.setTimeout(finish, duration * 1000 + 100);
  entrances.set(element, finish);
  document.addEventListener('visibilitychange', finish);
  window.addEventListener('resize', finish);
  void animation.finished.then(finish, () => {});
  return finish;
}

/** Enter once when mounted. Reduced-motion changes never replay an entrance. */
export function useMotionEntrance<T extends HTMLElement>(ref: RefObject<T | null>, preset: MotionPreset = 'page') {
  const { reducedMotion } = useAppMotion();
  const entered = useRef(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (entered.current || !element) return;
    if (!canAnimate(element, reducedMotion)) { entered.current = true; return; }
    // Install the initial frame before paint. Deferring animate() itself exposes
    // the final content for a frame, then hides it again at the start of the fade.
    const cancel = animateEntrance(element, preset);
    // Consume after the first frame so StrictMode's setup/cleanup replay remains safe.
    const frame = requestAnimationFrame(() => {
      entered.current = true;
    });
    return () => { cancelAnimationFrame(frame); cancel?.(); };
  }, [ref, preset, reducedMotion]);
}

export function hasStableGeometry(element: HTMLElement) {
  return !!element.closest('[data-motion-geometry="stable"]');
}

/** Interrupted disclosures reverse from their visible size. */
export function animateHeight(element: HTMLElement, from: number, to: number, onComplete: () => void, opening = to > from) {
  const original = { height: element.style.height, overflow: element.style.overflow, minHeight: element.style.minHeight };
  element.style.overflow = 'hidden';
  element.style.minHeight = '0';
  const duration = opening ? motionDurations.reveal : motionDurations.revealClose;
  element.style.height = from + 'px';
  const height = motionValue(from);
  const unsubscribe = height.on('change', value => { element.style.height = value + 'px'; });
  const animation = animate(height, to, { duration, ease: motionRevealEase });
  let finished = false;
  const restore = () => {
    unsubscribe();
    animation.stop();
    height.destroy();
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
  const timer = window.setTimeout(complete, duration * 1000 + 100);
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
    if (first || mode === 'status' || hasStableGeometry(node) || !canAnimate(node, reducedMotion)) {
      interruptedHeight.current = undefined;
      finish();
      return;
    }
    if (!open && !previouslyOpen) { finish(); return; }
    const from = interruptedHeight.current ?? (open ? 0 : node.getBoundingClientRect().height);
    interruptedHeight.current = undefined;
    const to = open ? node.getBoundingClientRect().height : 0;
    const cancel = animateHeight(node, from, to, finish, open);
    return () => { interruptedHeight.current = cancel(); };
  }, [open, reducedMotion, mode]);
  return <Tag {...props} ref={element as RefObject<HTMLDivElement & HTMLSpanElement>}
    className={'motion-region ' + className} data-motion-mode={mode} data-motion-state={open ? 'open' : visible ? 'exiting' : 'closed'}
    hidden={!visible} inert={!open} aria-hidden={!open || undefined}>
    {open ? children : visible ? lastChildren.current : keepMounted && hasOpened.current ? children : null}
  </Tag>;
}

/** Stable live content; dedicated navigation/disclosure components own choreography. */
export function MotionSwap({ stateKey, disabled = false, preset = 'swap', as: Tag = 'div', children, className = '', ...props }: ElementProps & {
  stateKey: string | number; disabled?: boolean; preset?: MotionPreset;
}) {
  const live = useRef<HTMLElement>(null);
  useMotionChange(live, stateKey, disabled, preset);
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
