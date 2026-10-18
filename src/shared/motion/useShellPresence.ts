// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { animate, motionValue } from 'motion';
import { motionEase, motionExitEase } from './tokens';
import { canAnimate } from './surfaces';
import { useAppMotion } from './index';

/** One animation owner retains the current pose when a live shell reverses. */
export function useShellPresence(ref: RefObject<HTMLElement | null>, {
  open, distance, enterDuration, exitDuration, onExited,
}: { open: boolean; distance: number; enterDuration: number; exitDuration: number; onExited?: () => void }) {
  const { reducedMotion } = useAppMotion();
  const visible = useRef(0);
  const callback = useRef(onExited);
  callback.current = onExited;
  const completed = useRef(false);
  useLayoutEffect(() => {
    const shell = ref.current;
    if (!shell) return;
    if (open) completed.current = false;
    let disposed = false, finished = false;
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = (progress: number) => {
      visible.current = progress;
      shell.style.opacity = progress === 1 ? '' : String(progress);
      // CSS supplies the signed popup distance after React Aria positions it.
      shell.style.transform = progress === 1 ? '' : `translateY(calc(var(--shell-slide-distance, ${distance}px) * ${1 - progress}))`;
    };
    const destination = open ? 1 : 0;
    const finish = () => {
      if (disposed || finished) return;
      finished = true;
      stop?.();
      clearTimeout(timer);
      render(destination);
      if (!open && !completed.current) {
        completed.current = true;
        callback.current?.();
      }
    };
    // Set the initial or interrupted pose synchronously before this commit paints.
    render(visible.current);
    if (!canAnimate(shell, reducedMotion) || visible.current === destination) { finish(); return; }
    const progress = motionValue(visible.current);
    const unsubscribe = progress.on('change', render);
    const duration = (open ? enterDuration : exitDuration) * Math.abs(destination - visible.current);
    const animation = animate(progress, destination, { duration, ease: open ? motionEase : motionExitEase });
    stop = () => { unsubscribe(); animation.stop(); progress.destroy(); };
    const visibility = () => { if (document.hidden) finish(); };
    timer = setTimeout(finish, duration * 1000 + 100);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', finish);
    void animation.finished.then(finish, () => {});
    return () => {
      disposed = true;
      stop?.();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', finish);
    };
  }, [ref, open, reducedMotion, distance, enterDuration, exitDuration]);
}
