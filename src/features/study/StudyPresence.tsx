// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode, type TransitionEvent } from 'react';
import { MotionRegion, useAppMotion, useMotionChange } from '../../shared/motion';

const StudyRegionActivity = createContext(true);
export const useStudyRegionActive = () => useContext(StudyRegionActivity);

/** CSS owns the continuous, reversible geometry; React owns activity and lifetime. */
export function useStudyPresence(open: boolean) {
  const { reducedMotion } = useAppMotion();
  const [state, setState] = useState({ target: open, retained: open, moving: false });
  const latest = useRef(open);
  latest.current = open;
  if (state.target !== open) {
    setState({ target: open, retained: open || state.retained, moving: !reducedMotion && !document.hidden });
  }
  const finish = () => setState({ target: latest.current, retained: latest.current, moving: false });
  useLayoutEffect(() => {
    if (reducedMotion || document.hidden || !state.moving) {
      if (state.retained !== open || state.moving) finish();
      return;
    }
    // WebViews can omit transitionend when hidden or resized. Settle to the latest
    // target in those cases, and let the native surface observe the final layout.
    const timer = window.setTimeout(finish, 320);
    const visibility = () => { if (document.hidden) finish(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', finish);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', finish);
    };
  }, [open, state.moving, state.retained, reducedMotion]);
  return {
    visible: open || (state.retained && !reducedMotion),
    moving: state.moving && !reducedMotion,
    dockProps: {
      'data-open': open,
      'data-moving': state.moving && !reducedMotion,
      onTransitionEnd: (event: TransitionEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget && (event.propertyName === 'width' || event.propertyName === 'height')) finish();
      },
    },
  };
}

/** Tab content changes immediately, with only the incoming view fading in. */
export function StudyRegion({ open, children, keepMounted = false, freezeOnExit = true, className = '', retain = false, animate = true }: {
  open: boolean;
  children: ReactNode;
  keepMounted?: boolean;
  freezeOnExit?: boolean;
  className?: string;
  retain?: boolean;
  animate?: boolean;
}) {
  const parentActive = useStudyRegionActive();
  const previous = useRef(children);
  const ref = useRef<HTMLDivElement>(null);
  const inline = className.split(' ').includes('study-motion-inline');
  useMotionChange(ref, Number(open), inline || !animate || !open);
  useLayoutEffect(() => { if (open) previous.current = children; }, [open, children]);
  const contents = <StudyRegionActivity.Provider value={parentActive && open}>
    {open ? children : retain && freezeOnExit ? previous.current : keepMounted ? children : null}
  </StudyRegionActivity.Provider>;
  if (inline) return <MotionRegion open={open} keepMounted={keepMounted} className={`study-motion-region ${className}`}>
    <StudyRegionActivity.Provider value={parentActive && open}>{children}</StudyRegionActivity.Provider>
  </MotionRegion>;
  return <div ref={ref} className={`study-motion-region ${className}`} hidden={!open && !retain} inert={!open} aria-hidden={!open || undefined}>
    {contents}
  </div>;
}
