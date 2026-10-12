// SPDX-License-Identifier: GPL-3.0-or-later
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSurface } from './Surface';
import { motionDurations, motionCssEase, motionCssExitEase, useAppMotion } from '../../shared/motion';
import { animateEntrance, canAnimate } from '../../shared/motion/surfaces';

interface Toast {
  id: number;
  text: string;
  kind: 'success' | 'error';
  closing?: boolean;
}
interface Notifications {
  notify: (text: string, kind?: Toast['kind']) => void;
  registerRegion: (element: HTMLDivElement | null) => void;
  report: <T>(
    action: () => Promise<T>,
    success?: string,
  ) => Promise<T | undefined>;
}
const Context = createContext<Notifications | null>(null);
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { notificationHost } = useSurface();
  const { reducedMotion } = useAppMotion();
  const reduced = useRef(reducedMotion);
  reduced.current = reducedMotion;
  const [pageHost, setPageHost] = useState<HTMLDivElement | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const nextId = useRef(0);
  const stack = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const reflows = useRef(new Map<HTMLElement, Animation>());
  const previousHost = useRef<HTMLElement | null>(null);
  // Moving one portal container preserves toast identity and its live region
  // when a nested dialog becomes the frontmost surface.
  const [portalRoot] = useState(() => {
    const element = document.createElement('div');
    element.className = 'notification-portal';
    // React Aria recognizes toast layers while hiding modal background content.
    // This container moves between hosts; it must not inherit stale aria-hidden.
    element.dataset.reactAriaTopLayer = '';
    return element;
  });
  const host = notificationHost ?? pageHost;
  useLayoutEffect(() => {
    (host ?? document.body).appendChild(portalRoot);
  }, [host, portalRoot]);
  useLayoutEffect(() => () => { portalRoot.remove(); }, [portalRoot]);
  useLayoutEffect(() => {
    const cancel = () => {
      reflows.current.forEach(animation => animation.cancel());
      reflows.current.clear();
      positions.current.clear();
    };
    const visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('resize', cancel);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancel();
      window.removeEventListener('resize', cancel);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  useLayoutEffect(() => {
    const sameHost = previousHost.current === host;
    previousHost.current = host;
    const next = new Map<string, number>();
    for (const slot of stack.current?.querySelectorAll<HTMLElement>('[data-toast-id]') || []) {
      const id = slot.dataset.toastId!;
      const transform = getComputedStyle(slot).transform;
      const offset = transform && transform !== 'none' && typeof DOMMatrix !== 'undefined' ? new DOMMatrix(transform).m42 : 0;
      const top = slot.getBoundingClientRect().top - offset;
      const from = positions.current.get(id);
      reflows.current.get(slot)?.cancel();
      reflows.current.delete(slot);
      next.set(id, top);
      const delta = from === undefined ? 0 : from + offset - top;
      if (!sameHost || reducedMotion || document.hidden || Math.abs(delta) < .5 || !slot.animate) continue;
      const animation = slot.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: motionDurations.content * 1000, easing: motionCssEase });
      reflows.current.set(slot, animation);
      void animation.finished.then(() => {
        if (reflows.current.get(slot) === animation) { animation.cancel(); reflows.current.delete(slot); }
      }, () => {});
    }
    for (const [node, animation] of reflows.current) if (!node.isConnected) { animation.cancel(); reflows.current.delete(node); }
    positions.current = next;
  }, [toasts, host, reducedMotion]);
  const dismiss = useCallback((id: number) => {
    setToasts(items => reduced.current ? items.filter(item => item.id !== id)
      : items.map(item => item.id === id ? { ...item, closing: true } : item));
  }, []);
  const remove = useCallback((id: number) => setToasts(items => items.filter(item => item.id !== id)), []);
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    },
    [],
  );
  const notify = useCallback(
    (text: string, kind: Toast['kind'] = 'success') => {
      const id = ++nextId.current;
      setToasts((items) => [...items.slice(-3), { id, text, kind }]);
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        dismiss(id);
      }, 6500);
      timers.current.add(timer);
    },
    [dismiss],
  );
  // This UI error boundary never refreshes caches. Query and mutation errors remain thrown.
  const report = useCallback(
    async <T,>(action: () => Promise<T>, success?: string) => {
      try {
        const result = await action();
        if (success) notify(success);
        return result;
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), 'error');
        return undefined;
      }
    },
    [notify],
  );
  const value = useMemo(() => ({ notify, report, registerRegion: setPageHost }), [notify, report]);
  const notifications = (
    <div ref={stack} className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map(toast => (
        <div key={toast.id} className="toast-slot" data-toast-id={toast.id}><ToastMessage toast={toast} dismiss={dismiss} remove={remove} /></div>
      ))}
    </div>
  );
  return (
    <Context.Provider value={value}>
      {children}
      {createPortal(notifications, portalRoot)}
    </Context.Provider>
  );
}
function ToastMessage({ toast, dismiss, remove }: { toast: Toast; dismiss: (id: number) => void; remove: (id: number) => void }) {
  const { reducedMotion } = useAppMotion();
  const element = useRef<HTMLButtonElement>(null);
  const entered = useRef(false);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || !canAnimate(node, reducedMotion)) {
      entered.current = true;
      if (toast.closing) remove(toast.id);
      return;
    }
    if (!toast.closing) {
      if (entered.current) return;
      const cancel = animateEntrance(node, 'toast');
      const frame = requestAnimationFrame(() => {
        entered.current = true;
      });
      return () => { cancelAnimationFrame(frame); cancel?.(); };
    }
    const duration = motionDurations.exit * 1000;
    const animation = node.animate(
      [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px)' }],
      { duration, easing: motionCssExitEase, fill: 'both' });
    let settled = false;
    const cleanup = () => {
      animation.cancel(); clearTimeout(timer);
      document.removeEventListener('visibilitychange', finish);
      window.removeEventListener('resize', finish);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (toast.closing) remove(toast.id);
    };
    const timer = window.setTimeout(finish, duration + 100);
    document.addEventListener('visibilitychange', finish);
    window.addEventListener('resize', finish);
    void animation.finished.then(finish, () => {});
    return () => { settled = true; cleanup(); };
  }, [toast.closing, toast.id, reducedMotion, remove]);
  return <button ref={element} className={`toast ${toast.kind}`} disabled={toast.closing}
    onClick={() => dismiss(toast.id)}>{toast.text}</button>;
}
export function NotificationRegion() {
  const { registerRegion } = useNotifications();
  return <div className="app-notifications" ref={registerRegion} />;
}
export function useNotifications() {
  const value = useContext(Context);
  if (!value) throw new Error('NotificationsProvider missing');
  return value;
}
