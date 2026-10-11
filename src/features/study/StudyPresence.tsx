// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import { MotionRegion, useMotionChange } from '../../shared/motion';

const StudyRegionActivity = createContext(true);
export const useStudyRegionActive = () => useContext(StudyRegionActivity);

/** One deliberate layout change keeps the native video aligned with the page. */
export function useStudyPresence(open: boolean) {
  return { visible: open, moving: false, dockProps: { 'data-open': open, 'data-moving': false } };
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
