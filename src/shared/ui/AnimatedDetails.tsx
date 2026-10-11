// SPDX-License-Identifier: GPL-3.0-or-later
import { forwardRef, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { useAppMotion } from '../motion';
import { animateHeight, canAnimate } from '../motion/surfaces';

const revealDetails = new WeakMap<HTMLDetailsElement, () => void>();

/** Reveal validation fields synchronously, including during a pending visual exit. */
export function openAnimatedDetails(details: HTMLDetailsElement) {
  const reveal = revealDetails.get(details);
  if (reveal) reveal();
  else details.open = true;
}

/** Native disclosure semantics with a measured, reversible height transition. */
export const AnimatedDetails = forwardRef<HTMLDetailsElement, ComponentPropsWithoutRef<'details'>>(
  function AnimatedDetails({ open, children, onClick, onToggle, ...props }, forwardedRef) {
    const element = useRef<HTMLDetailsElement | null>(null);
    const [requestedOpen, setRequestedOpen] = useState(!!open);
    const [present, setPresent] = useState(!!open);
    const { reducedMotion } = useAppMotion();
    const revision = useRef(0);
    const mounted = useRef(false);
    const immediate = useRef(false);
    const interruptedHeight = useRef<number | undefined>(undefined);
    const cancelAnimation = useRef<(() => void) | null>(null);
    useLayoutEffect(() => {
      const details = element.current;
      if (!details) return;
      revealDetails.set(details, () => {
        ++revision.current;
        cancelAnimation.current?.();
        interruptedHeight.current = undefined;
        immediate.current = true;
        details.querySelector(':scope > summary')?.removeAttribute('aria-expanded');
        setRequestedOpen(true);
        setPresent(true);
        details.open = true;
      });
      return () => { revealDetails.delete(details); };
    }, []);
    useLayoutEffect(() => { setRequestedOpen(!!open); }, [open]);
    useLayoutEffect(() => {
      const details = element.current;
      if (!details) return;
      const generation = ++revision.current;
      if (requestedOpen && !present) { setPresent(true); return; }
      const first = !mounted.current;
      mounted.current = true;
      const summary = Array.from(details.children).find(child => child.tagName === 'SUMMARY');
      const content = Array.from(details.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child !== summary);
      const exiting = !requestedOpen && present;
      if (exiting) summary?.setAttribute('aria-expanded', 'false');
      else summary?.removeAttribute('aria-expanded');
      if (exiting && details.contains(document.activeElement) && !summary?.contains(document.activeElement)) {
        (summary as HTMLElement | undefined)?.focus({ preventScroll: true });
      }
      const previous = content.map(child => ({ child, inert: child.hasAttribute('inert'), hidden: child.getAttribute('aria-hidden') }));
      if (exiting) content.forEach(child => { child.setAttribute('inert', ''); child.setAttribute('aria-hidden', 'true'); });
      const restore = () => previous.forEach(({ child, inert, hidden }) => {
        if (inert) child.setAttribute('inert', ''); else child.removeAttribute('inert');
        if (hidden === null) child.removeAttribute('aria-hidden'); else child.setAttribute('aria-hidden', hidden);
      });
      const complete = () => {
        if (generation === revision.current && !requestedOpen) setPresent(false);
      };
      if (first || immediate.current || !present || !canAnimate(details, reducedMotion)) {
        immediate.current = false;
        interruptedHeight.current = undefined;
        complete();
        return restore;
      }
      // Measure the real closed geometry, including summary padding and borders.
      const expandedHeight = details.getBoundingClientRect().height;
      details.open = false;
      const collapsedHeight = details.getBoundingClientRect().height;
      details.open = true;
      const from = interruptedHeight.current ?? (requestedOpen ? collapsedHeight : expandedHeight);
      interruptedHeight.current = undefined;
      const stop = animateHeight(details, from, requestedOpen ? expandedHeight : collapsedHeight, complete);
      const cancel = () => {
        ++revision.current;
        interruptedHeight.current = stop();
        restore();
        if (cancelAnimation.current === cancel) cancelAnimation.current = null;
      };
      cancelAnimation.current = cancel;
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
        if (event.currentTarget.open !== present) setRequestedOpen(event.currentTarget.open);
        onToggle?.(event);
      }}
    >{children}</details>;
  },
);
