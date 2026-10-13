// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { animate as motionAnimate, motionValue } from 'motion';
import { MotionRegion, motionDistances, motionDurations, motionEase, motionRevealEase, useAppMotion } from '../../shared/motion';
import { nativeDockInset, subscribeSurfaceFootprint } from './playback/surfaceFootprint';

const StudyRegionActivity = createContext(true);
export const useStudyRegionActive = () => useContext(StudyRegionActivity);

/** One desktop extent reveals the companion while resizing its native player. */
export function useStudyPresence(open: boolean) {
  const { reducedMotion } = useAppMotion();
  const panelRef = useRef<HTMLElement>(null);
  const [retained, setRetained] = useState(open);
  const [settled, setSettled] = useState(open);
  const [ready, setReady] = useState(open);
  const [animating, setAnimating] = useState(false);
  const [position] = useState(() => motionValue(open ? 0 : 1));
  const [extent] = useState(() => motionValue(open ? 1 : 0));
  const [layoutRevision, setLayoutRevision] = useState(0);
  const previousLayout = useRef(layoutRevision);
  const visible = open || retained;
  const moving = !reducedMotion && (animating || open !== settled);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const dock = panel.parentElement;
    const rail = dock?.querySelector<HTMLElement>('.study-transcript-rail');
    const resized = previousLayout.current !== layoutRevision;
    previousLayout.current = layoutRevision;
    const resize = () => setLayoutRevision(value => value + 1);
    if (window.innerWidth >= 1000 && dock) {
      let disposed = false;
      let stop: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let observer: MutationObserver | undefined;
      let generation = 0;
      const width = parseFloat(getComputedStyle(dock).getPropertyValue('--study-panel-width')) || (window.innerWidth >= 1400 ? 360 : 320);
      const viewport = dock.closest('.study-grid')?.querySelector<HTMLElement>('.native-player-viewport');
      const clip = () => {
        if (disposed) return;
        const inset = nativeDockInset(dock.getBoundingClientRect(), window.devicePixelRatio || 1);
        dock.style.clipPath = inset > 0 ? `inset(0px 0px 0px ${inset}px)` : '';
        dock.dataset.nativeClipLeft = String(inset);
      };
      const render = () => {
        dock.style.width = `${44 + width * extent.get()}px`;
        // The fixed-width contents move with the dock. Its overflow reveals
        // them without a second transform or a second animation phase.
        panel.style.transform = '';
        if (rail) rail.style.transform = '';
        clip();
      };
      const unsubscribeExtent = extent.on('change', () => {
        render();
        window.dispatchEvent(new Event('surtitle-player-layout'));
      });
      const unsubscribeFootprint = subscribeSurfaceFootprint(clip);
      const cancel = () => { generation += 1; stop?.(); stop = undefined; clearTimeout(timer); observer?.disconnect(); };
      const finish = () => {
        if (disposed) return;
        cancel();
        position.jump(open ? 0 : 1);
        render();
        // Keep the closing endpoint hidden until React commits retained=false;
        // restoring visibility here can expose a frame before that commit.
        panel.style.visibility = open ? '' : 'hidden';
        setRetained(open); setSettled(open); setReady(open); setAnimating(false);
      };
      const acknowledge = (complete: () => void) => {
        observer?.disconnect();
        if (!viewport) { complete(); return; }
        const version = ++generation;
        const accept = () => {
          if (disposed || version !== generation || viewport.dataset.nativePlacement === 'pending') return;
          observer?.disconnect();
          complete();
        };
        observer = new MutationObserver(accept);
        observer.observe(viewport, { attributes: true, attributeFilter: ['data-native-placement'] });
        // The final measurement is synchronous, including when an earlier IPC
        // is pending; its acknowledgement always belongs to this exact endpoint.
        window.dispatchEvent(new CustomEvent('surtitle-player-layout', { detail: { immediate: true } }));
        accept();
      };
      const endpoint = open ? 1 : 0;
      const complete = () => {
        // Hidden documents have no visible overlap and native visibility has
        // its own hide barrier. Do not wait for a superseded placement callback.
        if (document.hidden) finish();
        else acknowledge(finish);
      };
      const animate = () => {
        cancel();
        const distance = Math.abs(extent.get() - endpoint);
        if (reducedMotion || document.hidden || resized || distance < .001) { extent.jump(endpoint); complete(); return; }
        const version = generation;
        setAnimating(true);
        const done = () => {
          if (disposed || version !== generation) return;
          stop?.(); stop = undefined; clearTimeout(timer);
          extent.jump(endpoint);
          complete();
        };
        const seconds = open ? motionDurations.studyResize : motionDurations.studyCollapse;
        const controls = motionAnimate(extent, endpoint, { duration: seconds * distance, ease: motionRevealEase, onComplete: done });
        stop = () => controls.stop();
        timer = setTimeout(done, seconds * distance * 1000 + 100);
      };
      render();
      if (open) setRetained(true);
      // A settled workspace keeps its focused input through resize/reduction.
      // Newly opening or reversing drawers still wait for endpoint placement.
      setReady(current => open && settled ? current : false);
      panel.style.visibility = '';
      animate();
      const visibility = () => {
        if (!document.hidden) return;
        cancel();
        extent.jump(open ? 1 : 0);
        finish();
      };
      window.addEventListener('resize', resize);
      document.addEventListener('visibilitychange', visibility);
      return () => {
        disposed = true; cancel(); unsubscribeExtent(); unsubscribeFootprint();
        dock.style.clipPath = '';
        delete dock.dataset.nativeClipLeft;
        window.removeEventListener('resize', resize);
        document.removeEventListener('visibilitychange', visibility);
      };
    }
    // Stacked layouts retain their existing stationary player and sliding panel.
    if (dock) { dock.style.width = ''; dock.style.clipPath = ''; delete dock.dataset.nativeClipLeft; }
    if (rail) rail.style.transform = '';
    extent.jump(open ? 1 : 0);
    let disposed = false;
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let placementObserver: MutationObserver | undefined;
    let started = false;
    let settleRequested = resized;
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
      if (viewport && (resized || !retained || viewport.dataset.nativePlacement === 'pending')) {
        setReady(false);
        panel.style.visibility = 'hidden';
        // Scroll the stationary dock before acknowledging the final page clip.
        if (window.innerWidth < 1000) panel.closest('.study-companion-dock')?.scrollIntoView({ block: 'start', behavior: 'auto' });
        placementObserver = new MutationObserver(() => {
          if (viewport.dataset.nativePlacement === 'ready') start();
        });
        placementObserver.observe(viewport, { attributes: true, attributeFilter: ['data-native-placement'] });
        window.dispatchEvent(new CustomEvent('surtitle-player-layout', { detail: { immediate: true } }));
        if (viewport.dataset.nativePlacement !== 'pending') start();
      } else {
        if (!retained && window.innerWidth < 1000) panel.closest('.study-companion-dock')?.scrollIntoView({ block: 'start', behavior: 'auto' });
        start();
      }
    } else start();
    const visibility = () => { if (document.hidden) finish(); };
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true;
      stop?.();
      clearTimeout(timer);
      placementObserver?.disconnect();
      unsubscribe();
      panel.style.visibility = '';
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [open, reducedMotion, position, extent, layoutRevision]);
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
    const transform = open && !fromOpen && !exiting ? `translateX(${direction * motionDistances.tab}px)` : from.transform || 'translateX(0px)';
    let disposed = false;
    animated.current = true;
    // Install the first pose before paint; both retained pages remain opaque.
    node.style.opacity = '1';
    node.style.transform = transform;
    const controls = motionAnimate(node, {
      opacity: [1, 1],
      transform: [transform, `translateX(${open ? 0 : -direction * motionDistances.tab}px)`],
    }, {
      duration: motionDurations.tab, ease: motionEase,
      onComplete: () => { if (!disposed) settle(); },
    });
    const finish = () => { controls.complete(); settle(); };
    const timer = setTimeout(finish, motionDurations.tab * 1000 + 100);
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
