// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useRef, useState } from 'react';
import { useResetProjection } from 'motion/react';
import { useAppMotion } from './index';

/** Keep filtering projection separate from virtualizer transforms and live data updates. */
export function useListMotion(eligible: boolean) {
  const { reducedMotion } = useAppMotion();
  const resetProjection = useResetProjection();
  const [visible, setVisible] = useState(() => !document.hidden);
  const [, renderAfterResize] = useState(0);
  const enabled = eligible && !reducedMotion && visible;
  const previous = useRef(enabled);

  useLayoutEffect(() => {
    if (previous.current !== enabled) resetProjection();
    previous.current = enabled;
  }, [enabled, resetProjection]);

  useLayoutEffect(() => {
    const settle = () => {
      // Public Motion lifecycle: stop an in-flight projection before its coordinates
      // can be carried into a virtualized list or a changed viewport. Retain the DOM.
      resetProjection();
      renderAfterResize(revision => revision + 1);
    };
    const visibility = () => {
      settle();
      setVisible(!document.hidden);
    };
    window.addEventListener('resize', settle);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('resize', settle);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [resetProjection]);

  return enabled;
}
