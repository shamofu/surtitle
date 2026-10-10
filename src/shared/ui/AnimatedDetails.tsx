// SPDX-License-Identifier: GPL-3.0-or-later
import { forwardRef, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { motionDurations, useAppMotion } from '../motion';

const revealDetails = new WeakMap<HTMLDetailsElement, () => void>();

/** Reveal validation fields synchronously, including during a pending visual exit. */
export function openAnimatedDetails(details: HTMLDetailsElement) {
  const reveal = revealDetails.get(details);
  if (reveal) reveal();
  else details.open = true;
}

/** Native disclosure semantics, with content retained only for its short visual exit. */
export const AnimatedDetails = forwardRef<HTMLDetailsElement, ComponentPropsWithoutRef<'details'>>(
  function AnimatedDetails({ open, children, onClick, onToggle, ...props }, forwardedRef) {
    const element = useRef<HTMLDetailsElement | null>(null);
    const [requestedOpen, setRequestedOpen] = useState(!!open);
    const [present, setPresent] = useState(!!open);
    const { reducedMotion } = useAppMotion();
    const revision = useRef(0);
    const cancelAnimation = useRef<(() => void) | null>(null);
    useLayoutEffect(() => {
      const details = element.current;
      if (!details) return;
      revealDetails.set(details, () => {
        ++revision.current;
        cancelAnimation.current?.();
        details.querySelector(':scope > summary')?.removeAttribute('aria-expanded');
        setRequestedOpen(true);
        setPresent(true);
        // Native open is already true during an exit, so setting it alone would
        // emit no toggle and leave the focused field inert until the old timer.
        details.open = true;
      });
      return () => { revealDetails.delete(details); };
    }, []);
    // Like native <details open>, a changed prop can also reveal validation fields.
    useLayoutEffect(() => { setRequestedOpen(!!open); }, [open]);
    useLayoutEffect(() => {
      const details = element.current;
      if (!details) return;
      const generation = ++revision.current;
      if (requestedOpen && !present) { setPresent(true); return; }
      const summary = Array.from(details.children).find(child => child.tagName === 'SUMMARY');
      const content = Array.from(details.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child !== summary);
      const exiting = !requestedOpen && present;
      if (exiting) summary?.setAttribute('aria-expanded', 'false');
      else summary?.removeAttribute('aria-expanded');
      if (exiting && details.contains(document.activeElement) && !summary?.contains(document.activeElement)) {
        (summary as HTMLElement | undefined)?.focus({ preventScroll: true });
      }
      const previous = content.map(child => ({ child, inert: child.inert, hidden: child.getAttribute('aria-hidden') }));
      // A fully closed native details already hides its contents. Do not leave
      // inert behind: validation opens .open imperatively and focuses immediately.
      if (exiting) content.forEach(child => { child.inert = true; child.setAttribute('aria-hidden', 'true'); });
      const restore = () => previous.forEach(({ child, inert, hidden }) => {
        child.inert = inert;
        if (hidden === null) child.removeAttribute('aria-hidden'); else child.setAttribute('aria-hidden', hidden);
      });
      const complete = () => {
        if (generation === revision.current && !requestedOpen) setPresent(false);
      };
      let disposed = false;
      let animations: Animation[] = [];
      let fallback: number | undefined;
      const cancel = () => {
        if (disposed) return;
        disposed = true;
        ++revision.current;
        if (fallback !== undefined) window.clearTimeout(fallback);
        animations.forEach(animation => animation.cancel());
        restore();
        if (cancelAnimation.current === cancel) cancelAnimation.current = null;
      };
      cancelAnimation.current = cancel;
      if (reducedMotion || !present || content.some(child => typeof child.animate !== 'function')) {
        complete();
        return cancel;
      }
      const duration = 1000 * (requestedOpen ? motionDurations.enter : motionDurations.exit);
      animations = content.map(child => child.animate(
        requestedOpen ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }],
        { duration, easing: 'cubic-bezier(.2, 0, 0, 1)', fill: 'both' },
      ));
      void Promise.all(animations.map(animation => animation.finished)).then(complete, () => {});
      fallback = window.setTimeout(complete, duration + 80);
      return cancel;
    }, [requestedOpen, present, reducedMotion]);
    return <details {...props} open={present} data-motion-state={requestedOpen ? 'open' : present ? 'exiting' : 'closed'}
      ref={node => {
        element.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      onClick={event => {
        onClick?.(event);
        if (event.defaultPrevented || !(event.target instanceof Element)) return;
        const summary = event.target.closest('summary');
        if (summary?.parentElement !== event.currentTarget) return;
        event.preventDefault();
        setRequestedOpen(current => !current);
      }}
      onToggle={event => {
        // Honour imperative .open changes used by invalid-field focus recovery.
        if (event.currentTarget.open !== present) setRequestedOpen(event.currentTarget.open);
        onToggle?.(event);
      }}
    >{children}</details>;
  },
);
