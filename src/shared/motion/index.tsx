// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, useContext, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react';
import type { MotionPreference } from '../contracts/settings';

export const motionDurations = { fast: 0.16, enter: 0.3, exit: 0.22 } as const;
export const motionEase = [0.22, 0.61, 0.36, 1] as const;
export const motionCssEase = `cubic-bezier(${motionEase.join(', ')})`;

// Components rendered outside the application provider remain fully usable without motion.
const MotionContext = createContext({ reducedMotion: true });
const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
function subscribeSystemMotion(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
function readSystemMotion() {
  return typeof window.matchMedia !== 'function' || window.matchMedia(reducedMotionQuery).matches;
}

export function MotionProvider({ children, preference = 'system' }: { children: ReactNode; preference?: MotionPreference }) {
  const systemReduced = useSyncExternalStore(subscribeSystemMotion, readSystemMotion, () => true);
  const reducedMotion = preference === 'reduce' || systemReduced;
  const value = useMemo(() => ({ reducedMotion }), [reducedMotion]);

  useLayoutEffect(() => {
    document.documentElement.dataset.motion = reducedMotion ? 'reduce' : 'full';
  }, [reducedMotion]);

  return (
    <MotionContext.Provider value={value}>
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion={reducedMotion ? 'always' : 'never'} transition={{ duration: reducedMotion ? 0 : motionDurations.enter, ease: motionEase }}>
          {children}
        </MotionConfig>
      </LazyMotion>
    </MotionContext.Provider>
  );
}

export function useAppMotion() {
  return useContext(MotionContext);
}
