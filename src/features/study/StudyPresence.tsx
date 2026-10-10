// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as m from 'motion/react-m';
import { motionDurations, motionEase, useAppMotion } from '../../shared/motion';

const StudyRegionActivity = createContext(true);
export const useStudyRegionActive = () => useContext(StudyRegionActivity);

/** Retain geometry until the visual exit finishes; logical activity changes immediately. */
export function useStudyPresence(open: boolean) {
  const { reducedMotion } = useAppMotion();
  const [retained, setRetained] = useState(open);
  const latest = useRef({ open, revision: 0 });
  if (latest.current.open !== open) latest.current = { open, revision: latest.current.revision + 1 };
  const revision = latest.current.revision;
  useLayoutEffect(() => {
    if (open) { setRetained(true); return; }
    if (reducedMotion || document.hidden) { setRetained(false); return; }
    if (!retained) return;
    const finish = () => {
      if (!latest.current.open && revision === latest.current.revision) setRetained(false);
    };
    // A throttled/hidden WebView may never deliver animation completion.
    const timer = window.setTimeout(finish, motionDurations.exit * 1000 + 100);
    const visibility = () => { if (document.hidden) finish(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [open, reducedMotion, retained, revision]);
  return {
    visible: open || (retained && !reducedMotion),
    motionProps: {
      initial: false as const,
      animate: reducedMotion ? undefined : open ? 'shown' : 'hidden',
      style: reducedMotion ? { opacity: open ? 1 : 0 } : undefined,
      variants: reducedMotion ? undefined : { shown: { opacity: 1 }, hidden: { opacity: 0 } },
      transition: { duration: reducedMotion ? 0 : open ? motionDurations.enter : motionDurations.exit, ease: motionEase },
      onAnimationComplete: (definition: unknown) => {
        if (definition === 'hidden' && !latest.current.open && revision === latest.current.revision) setRetained(false);
      },
    },
  };
}

/** Keep the same subtree while it fades out, including unsaved form controls. */
export function StudyRegion({ open, children, keepMounted = false, freezeOnExit = true, className = '' }: {
  open: boolean;
  children: ReactNode;
  keepMounted?: boolean;
  freezeOnExit?: boolean;
  className?: string;
}) {
  const presence = useStudyPresence(open);
  const parentActive = useStudyRegionActive();
  const previous = useRef(children);
  useLayoutEffect(() => { if (open) previous.current = children; }, [open, children]);
  return <m.div
    {...presence.motionProps}
    className={`study-motion-region ${className}`}
    data-exiting={!open && presence.visible ? '' : undefined}
    hidden={!presence.visible}
    inert={!open}
    aria-hidden={!open || undefined}
  ><StudyRegionActivity.Provider value={parentActive && open}>
    {open ? children : presence.visible && freezeOnExit ? previous.current : keepMounted ? children : null}
  </StudyRegionActivity.Provider></m.div>;
}
