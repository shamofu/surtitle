// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, useContext, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { domMax, LazyMotion, MotionConfig } from 'motion/react';
import type { MotionPreference } from '../contracts/settings';
import { motionDurations, motionEase, motionVariables } from './tokens';
export * from './tokens';

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
    for (const [name, value] of Object.entries(motionVariables)) document.documentElement.style.setProperty(name, value);
  }, [reducedMotion]);
  useLayoutEffect(() => {
    const updateVisibility = () => {
      document.documentElement.dataset.visibility = document.hidden ? 'hidden' : 'visible';
    };
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility);
      delete document.documentElement.dataset.visibility;
    };
  }, []);

  return (
    <MotionContext.Provider value={value}>
      <LazyMotion features={domMax} strict>
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

export { MotionRegion, MotionSwap, AnimatedValue, useMotionChange, useMotionEntrance } from './surfaces';
export { AnimatedCheck, MotionSpinner, useMotionActive } from './feedback';
