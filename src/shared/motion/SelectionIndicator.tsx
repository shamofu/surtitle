// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useRef } from 'react';
import { motionCssEase, motionDurations, useAppMotion } from './index';
import './selection-indicator.css';

type Geometry = { left: number; top: number; width: number; height: number };
const frame = (box: Geometry): Keyframe => ({
  left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`,
});
const sameGeometry = (a: Geometry | null, b: Geometry) => !!a &&
  Math.abs(a.left - b.left) < .5 && Math.abs(a.top - b.top) < .5 &&
  Math.abs(a.width - b.width) < .5 && Math.abs(a.height - b.height) < .5;

/** A decorative sibling of the existing controls; their selection and focus stay synchronous. */
export function SelectionIndicator({
  variant = 'underline',
  selector = ':scope > [aria-selected="true"], :scope > [aria-pressed="true"], :scope > [aria-current="page"]',
  thickness = 2,
}: {
  variant?: 'underline' | 'pill';
  selector?: string;
  thickness?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const updateRef = useRef<(() => void) | null>(null);
  const { reducedMotion } = useAppMotion();

  useLayoutEffect(() => {
    const marker = ref.current;
    const host = marker?.parentElement;
    if (!marker || !host) return;
    let selected: HTMLElement | null = null;
    let destination: Geometry | null = null;
    let animation: Animation | undefined;
    host.dataset.selectionIndicator = variant;

    const boxInHost = (element: HTMLElement): Geometry => {
      const box = element.getBoundingClientRect();
      const parent = host.getBoundingClientRect();
      return {
        left: box.left - parent.left - host.clientLeft + host.scrollLeft,
        top: box.top - parent.top - host.clientTop + host.scrollTop,
        width: box.width,
        height: box.height,
      };
    };
    const stop = () => {
      animation?.cancel();
      animation = undefined;
    };
    const update = (settle = false) => {
      const next = host.querySelector<HTMLElement>(selector);
      const bounds = next && boxInHost(next);
      if (!next || !bounds || bounds.width <= 0 || bounds.height <= 0) {
        stop();
        marker.hidden = true;
        delete host.dataset.selectionReady;
        selected = next;
        destination = null;
        return;
      }
      const target = variant === 'underline'
        ? { ...bounds, top: bounds.top + bounds.height - thickness, height: thickness }
        : bounds;
      if (!settle && next === selected && sameGeometry(destination, target)) return;
      // Read the visible frame before cancelling, so rapid changes never jump back.
      const previous = destination && !marker.hidden ? boxInHost(marker) : null;
      const changed = !!selected && selected !== next;
      stop();
      selected = next;
      destination = target;
      Object.assign(marker.style, frame(target));
      marker.hidden = false;
      host.dataset.selectionReady = 'true';
      if (settle || !changed || !previous || previous.width <= 0 || reducedMotion || document.hidden || !marker.animate) return;

      // Stretch the leading edge first. Wrapped rows move directly to avoid a
      // wide marker crossing unrelated controls between rows.
      const sameRow = Math.abs(previous.top - target.top) < 1;
      const stretch = {
        left: Math.min(previous.left, target.left), top: target.top,
        width: Math.max(previous.left + previous.width, target.left + target.width) - Math.min(previous.left, target.left),
        height: target.height,
      };
      const frames = sameRow
        ? [frame(previous), { ...frame(stretch), offset: .45 }, frame(target)]
        : [frame(previous), frame(target)];
      const current = marker.animate(frames, { duration: motionDurations.selection * 1000, easing: motionCssEase });
      animation = current;
      void current.finished.then(() => {
        if (animation === current) stop();
      }, () => {});
    };
    update(true);
    updateRef.current = () => update();

    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const next = host.querySelector<HTMLElement>(selector);
      const bounds = next && boxInHost(next);
      const target = bounds && (variant === 'underline'
        ? { ...bounds, top: bounds.top + bounds.height - thickness, height: thickness }
        : bounds);
      if (!target || !sameGeometry(destination, target)) update(true);
    });
    const observeControls = () => {
      resize?.disconnect();
      resize?.observe(host);
      for (const child of host.children) if (child !== marker) resize?.observe(child);
    };
    observeControls();
    const mutations = new MutationObserver(records => {
      const layoutChanged = records.some(record => record.type !== 'attributes');
      if (layoutChanged) observeControls();
      update(layoutChanged);
    });
    mutations.observe(host, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-pressed', 'aria-current'] });
    const settle = () => update(true);
    window.addEventListener('resize', settle);
    document.addEventListener('visibilitychange', settle);
    return () => {
      updateRef.current = null;
      mutations.disconnect();
      resize?.disconnect();
      window.removeEventListener('resize', settle);
      document.removeEventListener('visibilitychange', settle);
      stop();
      delete host.dataset.selectionIndicator;
      delete host.dataset.selectionReady;
    };
  }, [reducedMotion, selector, thickness, variant]);

  useLayoutEffect(() => { updateRef.current?.(); });
  return <span ref={ref} className="selection-indicator" aria-hidden="true" hidden />;
}
