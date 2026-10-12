// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { animate as motionAnimate, motionValue } from 'motion';
import { MotionRegion, motionDurations, motionEase, useAppMotion } from '../../shared/motion';

const StudyRegionActivity = createContext(true);
export const useStudyRegionActive = () => useContext(StudyRegionActivity);

/** Reserve geometry once; only the opaque companion moves inside its clipped dock. */
export function useStudyPresence(open: boolean) {
  const { reducedMotion } = useAppMotion();
  const panelRef = useRef<HTMLElement>(null);
  const [retained, setRetained] = useState(open);
  const [settled, setSettled] = useState(open);
  const [ready, setReady] = useState(open);
  const [animating, setAnimating] = useState(false);
  const [position] = useState(() => motionValue(open ? 0 : 1));
  const visible = open || retained;
  const moving = !reducedMotion && (animating || open !== settled);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let placementObserver: MutationObserver | undefined;
    let started = false;
    let settleRequested = false;
    const axis = window.innerWidth < 1000 ? 'Y' : 'X';
    const render = (value: number) => { panel.style.transform = `translate${axis}(${value * 100}%)`; };
    const unsubscribe = position.on('change', render);
    render(position.get());
    if (open) setRetained(true);
    const finish = () => {
      if (disposed) return;
      if (open && !started) {
        // Resize/reduction may settle the visual offset, but cannot acknowledge
        // stale native geometry or expose/focus a panel over the old HWND bounds.
        settleRequested = true;
        position.jump(0);
        return;
      }
      stop?.();
      stop = undefined;
      placementObserver?.disconnect();
      clearTimeout(timer);
      position.jump(open ? 0 : 1);
      panel.style.visibility = '';
      setRetained(open);
      setSettled(open);
      setReady(open);
      setAnimating(false);
    };
    const start = () => {
      if (disposed || started) return;
      started = true;
      placementObserver?.disconnect();
      panel.style.visibility = '';
      setReady(open);
      const distance = Math.abs(position.get() - (open ? 0 : 1));
      if (settleRequested || reducedMotion || document.hidden || distance < .001) { finish(); return; }
      const duration = (open ? motionDurations.panelOpen : motionDurations.panelClose) * distance;
      setAnimating(true);
      const controls = motionAnimate(position, open ? 0 : 1, { duration, ease: motionEase, onComplete: finish });
      stop = () => controls.stop();
      timer = setTimeout(finish, duration * 1000 + 100);
    };
    if (open) {
      const viewport = panel.closest('.study-grid')?.querySelector<HTMLElement>('.native-player-viewport');
      if (viewport && (!retained || viewport.dataset.nativePlacement === 'pending')) {
        setReady(false);
        panel.style.visibility = 'hidden';
        // Scroll the stationary dock before acknowledging the final page clip.
        if (window.innerWidth < 1000) panel.closest('.study-companion-dock')?.scrollIntoView({ block: 'start', behavior: 'auto' });
        placementObserver = new MutationObserver(() => {
          if (viewport.dataset.nativePlacement === 'ready') start();
        });
        placementObserver.observe(viewport, { attributes: true, attributeFilter: ['data-native-placement'] });
        window.dispatchEvent(new Event('surtitle-player-layout'));
        if (viewport.dataset.nativePlacement !== 'pending') start();
      } else {
        if (!retained && window.innerWidth < 1000) panel.closest('.study-companion-dock')?.scrollIntoView({ block: 'start', behavior: 'auto' });
        start();
      }
    } else start();
    const visibility = () => { if (document.hidden) finish(); };
    window.addEventListener('resize', finish);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true;
      stop?.();
      clearTimeout(timer);
      placementObserver?.disconnect();
      unsubscribe();
      panel.style.visibility = '';
      window.removeEventListener('resize', finish);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [open, reducedMotion, position]);
  return { visible, moving, ready, panelRef, dockProps: { 'data-open': visible, 'data-moving': moving } };
}
/** Retain real outgoing views, inert, while the next view takes over the same space. */
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
  const { reducedMotion } = useAppMotion();
  const wasOpen = useRef(open);
  const mounted = useRef(false);
  const animated = useRef(false);
  const [exiting, setExiting] = useState(open);
  const inline = className.split(' ').includes('study-motion-inline');
  const visible = open || retain || (exiting && animate && !reducedMotion);
  useLayoutEffect(() => { if (open) previous.current = children; }, [open, children]);
  useLayoutEffect(() => {
    const node = ref.current;
    const changed = wasOpen.current !== open;
    const first = !mounted.current;
    mounted.current = true;
    const fromOpen = wasOpen.current;
    wasOpen.current = open;
    if (!node || inline) return;
    if (open) setExiting(true);
    const settle = () => {
      // Let Motion own the endpoint as well, so its cached transform cannot
      // reappear after a reduced-motion change or a later interrupted reveal.
      if (animated.current) motionAnimate(node, { opacity: [1, 1], transform: ['translateX(0px)', 'translateX(0px)'] }, { duration: 0 }).complete();
      node.style.opacity = '';
      node.style.transform = '';
      if (!open) setExiting(false);
    };
    if (first || !changed || !animate || reducedMotion || document.hidden) { settle(); return; }
    const direction = Number(node.closest('[data-motion-direction]')?.getAttribute('data-motion-direction') || 1);
    const from = getComputedStyle(node);
    const opacity = open && !fromOpen && !exiting ? 0 : Number(from.opacity);
    const transform = open && !fromOpen && !exiting ? `translateX(${direction * 12}px)` : from.transform || 'translateX(0px)';
    let disposed = false;
    animated.current = true;
    const controls = motionAnimate(node, {
      opacity: [opacity, open ? 1 : 0],
      transform: [transform, `translateX(${open ? 0 : -direction * 12}px)`],
    }, {
      duration: motionDurations.content, ease: motionEase,
      onComplete: () => { if (!disposed) settle(); },
    });
    const finish = () => { controls.complete(); settle(); };
    const timer = setTimeout(finish, motionDurations.content * 1000 + 100);
    const visibility = () => { if (document.hidden) finish(); };
    window.addEventListener('resize', finish);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true;
      controls.stop();
      clearTimeout(timer);
      window.removeEventListener('resize', finish);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [open, reducedMotion, animate, inline]);
  const contents = <StudyRegionActivity.Provider value={parentActive && open}>
    {open ? children : visible && freezeOnExit ? previous.current : keepMounted || visible ? children : null}
  </StudyRegionActivity.Provider>;
  if (inline) return <MotionRegion open={open} keepMounted={keepMounted} className={`study-motion-region ${className}`}>
    <StudyRegionActivity.Provider value={parentActive && open}>{children}</StudyRegionActivity.Provider>
  </MotionRegion>;
  return <div ref={ref} className={`study-motion-region ${className}`} hidden={!visible} inert={!open} aria-hidden={!open || undefined}
    data-motion-state={open ? 'open' : visible ? 'exiting' : 'closed'}>
    {contents}
  </div>;
}
