// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, createRef, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { motionCssEase, motionDurations, useAppMotion } from './index';

type ElementProps = HTMLAttributes<HTMLElement> & { as?: 'div' | 'span'; children?: ReactNode };

function canAnimate(element: HTMLElement, reduced: boolean) {
  return !reduced && !document.hidden && typeof element.animate === 'function';
}

/** Same DOM, new content. Never retrigger from unrelated renders or playback ticks. */
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
    document.addEventListener('visibilitychange', finish);
    return () => { animation.cancel(); document.removeEventListener('visibilitychange', finish); };
  }, [ref, key, disabled, reducedMotion]);
}

/** Retain the same subtree during exit; logical activity ends immediately. */
export function MotionRegion({ open, keepMounted = false, as: Tag = 'div', children, className = '', ...props }: ElementProps & {
  open: boolean; keepMounted?: boolean;
}) {
  const { reducedMotion } = useAppMotion();
  const element = useRef<HTMLElement>(null);
  const [retained, setRetained] = useState(open);
  const lastChildren = useRef(children);
  const hasOpened = useRef(open);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const revision = useRef(0);
  const visible = open || (retained && !reducedMotion);
  useLayoutEffect(() => { if (open) { lastChildren.current = children; hasOpened.current = true; } }, [open, children]);
  useLayoutEffect(() => {
    const node = element.current;
    const generation = ++revision.current;
    const previouslyOpen = wasOpen.current;
    wasOpen.current = open;
    if (open) setRetained(true);
    if (!node) return;
    if (open && !previouslyOpen && document.activeElement instanceof HTMLElement && !node.contains(document.activeElement)) opener.current = document.activeElement;
    if (!open && node.contains(document.activeElement) && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    const finish = () => { if (generation === revision.current && !open) setRetained(false); };
    if (!canAnimate(node, reducedMotion)) { finish(); return; }
    if (!open && !previouslyOpen) return;
    const duration = (open ? motionDurations.enter : motionDurations.exit) * 1000;
    const animation = node.animate(open ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], {
      duration, easing: motionCssEase, fill: 'both',
    });
    void animation.finished.then(finish, () => {});
    const timer = window.setTimeout(finish, duration + 100);
    const visibility = () => { if (document.hidden) { animation.cancel(); finish(); } };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      ++revision.current; animation.cancel(); window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [open, reducedMotion]);
  return <Tag {...props} ref={element as RefObject<HTMLDivElement & HTMLSpanElement>}
    className={`motion-region ${className}`} data-motion-state={open ? 'open' : visible ? 'exiting' : 'closed'}
    hidden={!visible} inert={!open} aria-hidden={!open || undefined}>
    {open ? children : visible ? lastChildren.current : keepMounted && hasOpened.current ? children : null}
  </Tag>;
}

/** A decorative snapshot only: never duplicate live components, IDs or form actions. */
function snapshotOf(element: HTMLElement) {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[data-motion-snapshot]').forEach(node => node.remove());
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  copy.setAttribute('inert', '');
  copy.setAttribute('data-motion-snapshot', '');
  for (const node of [copy, ...copy.querySelectorAll('*')]) {
    for (const attribute of ['id', 'name', 'for', 'autofocus', 'aria-live', 'aria-describedby', 'aria-labelledby', 'aria-label', 'data-testid']) node.removeAttribute(attribute);
    if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement || node instanceof HTMLButtonElement) node.disabled = true;
  }
  // Inert visuals must not keep implicit form-label associations either.
  copy.querySelectorAll('label').forEach(label => {
    const replacement = document.createElement('span');
    for (const attribute of label.attributes) replacement.setAttribute(attribute.name, attribute.value);
    replacement.append(...label.childNodes);
    label.replaceWith(replacement);
  });
  return copy;
}

/** Crossfade semantic changes without key-remounting the live controls. */
type SwapProps = ElementProps & {
  stateKey: string | number; disabled?: boolean;
};
export function MotionSwap(props: SwapProps) {
  const { reducedMotion } = useAppMotion();
  return <SwapSurface {...props} reducedMotion={reducedMotion} />;
}

// The pre-commit lifecycle captures the actual old DOM only when its semantic
// identity changes. Unrelated renders, typing and 100 ms playback ticks do no
// cloning or DOM traversal, even for a large library or a form with many fields.
class SwapSurface extends Component<SwapProps & { reducedMotion: boolean }> {
  private host = createRef<HTMLElement>();
  private live = createRef<HTMLElement>();
  private cancel: (() => void) | null = null;

  getSnapshotBeforeUpdate(previous: SwapProps) {
    const element = this.live.current;
    if (!element || previous.stateKey === this.props.stateKey ||
      !canAnimate(element, this.props.reducedMotion || !!this.props.disabled)) return null;
    return snapshotOf(element);
  }

  componentDidUpdate(_previous: SwapProps, _state: unknown, outgoing: HTMLElement | null) {
    const element = this.live.current;
    const container = this.host.current;
    if (!element || !container) return;
    if (!canAnimate(element, this.props.reducedMotion || !!this.props.disabled)) { this.cancel?.(); return; }
    if (!outgoing) return;
    this.cancel?.();
    container.appendChild(outgoing);
    const options = { duration: motionDurations.swap * 1000, easing: motionCssEase, fill: 'both' as const };
    const entering = element.animate([{ opacity: 0 }, { opacity: 1 }], options);
    const exiting = outgoing.animate([{ opacity: 1 }, { opacity: 0 }], options);
    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      entering.cancel(); exiting.cancel(); outgoing.remove(); window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      if (this.cancel === cleanup) this.cancel = null;
    };
    const visibility = () => { if (document.hidden) cleanup(); };
    const timer = window.setTimeout(cleanup, motionDurations.swap * 1000 + 100);
    this.cancel = cleanup;
    document.addEventListener('visibilitychange', visibility);
    void Promise.all([entering.finished, exiting.finished]).then(cleanup, () => {});
  }

  componentWillUnmount() { this.cancel?.(); }

  render() {
    const { stateKey: _key, disabled: _disabled, reducedMotion: _reduced, as: Tag = 'div', children, className = '', ...props } = this.props;
    return <Tag {...props} ref={this.host as RefObject<HTMLDivElement & HTMLSpanElement>}
    className={`motion-swap${Tag === 'span' ? ' motion-swap-inline' : ''} ${className}`}>
      <Tag ref={this.live as RefObject<HTMLDivElement & HTMLSpanElement>} className="motion-swap-live">{children}</Tag>
    </Tag>;
  }
}

/** Animate exact formatted values, never invented intermediate counts or amounts. */
export function AnimatedValue({ value, immediate = false, className = '' }: {
  value: string | number; immediate?: boolean; className?: string;
}) {
  return <MotionSwap as="span" className={`animated-value ${className}`} stateKey={String(value)} disabled={immediate}>{value}</MotionSwap>;
}
