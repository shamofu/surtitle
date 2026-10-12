// SPDX-License-Identifier: GPL-3.0-or-later
import { useSyncExternalStore, type ReactNode } from 'react';
import { m } from 'motion/react';
import { LoaderCircle } from 'lucide-react';
import { useAppMotion } from './index';
import { motionDurations, motionEase } from './tokens';

function subscribeVisibility(update: () => void) {
  document.addEventListener('visibilitychange', update);
  return () => document.removeEventListener('visibilitychange', update);
}
/** Continuous effects stop while hidden; all feedback respects live reduction. */
export function useMotionActive() {
  const { reducedMotion } = useAppMotion();
  const visible = useSyncExternalStore(subscribeVisibility, () => !document.hidden, () => false);
  return visible && !reducedMotion;
}

export function MotionSpinner({ size = 16, children }: { size?: number; children?: ReactNode }) {
  const active = useMotionActive();
  return <m.span className="motion-spinner" aria-hidden="true" initial={false}
    animate={{ rotate: active ? 360 : 0 }}
    transition={active ? { duration: motionDurations.spin, ease: 'linear', repeat: Infinity } : { duration: 0 }}>
    {children ?? <LoaderCircle size={size} />}
  </m.span>;
}

export function AnimatedCheck({ size = 16 }: { size?: number }) {
  const active = useMotionActive();
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <m.path d="m20 6-11 11-5-5" initial={active ? { pathLength: 0 } : false}
      animate={{ pathLength: 1 }} transition={{ duration: active ? motionDurations.success : 0, ease: motionEase }} />
  </svg>;
}
