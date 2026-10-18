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
import { animate, motionValue, type AnimationPlaybackControls } from 'motion';
import { useSurface } from './Surface';
import { motionDistances, motionDurations, motionEase, motionToastTransition, useAppMotion } from '../../shared/motion';

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
  const reflows = useRef(new Map<HTMLElement, () => void>());
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
      reflows.current.forEach(cancel => cancel());
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
      reflows.current.get(slot)?.();
      reflows.current.delete(slot);
      slot.style.transform = '';
      next.set(id, top);
      const delta = from === undefined ? 0 : from + offset - top;
      if (!sameHost || reducedMotion || document.hidden || Math.abs(delta) < .5) continue;
      const offsetValue = motionValue(delta);
      const render = (offset: number) => { slot.style.transform = offset ? `translateY(${offset}px)` : ''; };
      render(delta);
      const unsubscribe = offsetValue.on('change', render);
      let animation: AnimationPlaybackControls | undefined;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        // Numeric values never enqueue a cached DOM render after cancellation.
        unsubscribe(); animation?.stop(); offsetValue.destroy(); slot.style.transform = '';
        if (reflows.current.get(slot) === finish) reflows.current.delete(slot);
      };
      reflows.current.set(slot, finish);
      animation = animate(offsetValue, 0, { duration: motionDurations.toastReflow, ease: motionEase, onComplete: finish });
    }
    for (const [node, cancel] of reflows.current) if (!node.isConnected) cancel();
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
        <div key={toast.id} className="toast-slot" data-toast-id={toast.id}><ToastMessage toast={toast} host={host} dismiss={dismiss} remove={remove} /></div>
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
function ToastMessage({ toast, host, dismiss, remove }: { toast: Toast; host: HTMLElement | null; dismiss: (id: number) => void; remove: (id: number) => void }) {
  const { reducedMotion } = useAppMotion();
  const element = useRef<HTMLButtonElement>(null);
  const entered = useRef(false);
  const previousHost = useRef(host);
  useLayoutEffect(() => {
    const node = element.current;
    const moved = previousHost.current !== host;
    previousHost.current = host;
    if (!node) return;
    const reveal = () => { node.style.opacity = ''; node.style.transform = ''; };
    if (moved || reducedMotion || document.hidden) {
      entered.current = true;
      reveal();
      if (toast.closing) remove(toast.id);
      return;
    }
    if (!toast.closing && entered.current) { reveal(); return; }
    entered.current = true;
    let animation: AnimationPlaybackControls | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const current = getComputedStyle(node);
    const fromOpacity = toast.closing ? Number(current.opacity) : 0;
    const fromOffset = toast.closing
      ? typeof DOMMatrix !== 'undefined' ? new DOMMatrix(current.transform === 'none' ? '' : current.transform).m42
        : Number(current.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? 0)
      : motionDistances.toast;
    const toOpacity = toast.closing ? 0 : 1;
    const toOffset = toast.closing ? motionDistances.toast : 0;
    const progress = motionValue(0);
    const render = (value: number) => {
      node.style.opacity = String(fromOpacity + (toOpacity - fromOpacity) * value);
      node.style.transform = `translateY(${fromOffset + (toOffset - fromOffset) * value}px)`;
    };
    render(0);
    const unsubscribe = progress.on('change', render);
    const cleanup = () => {
      unsubscribe(); animation?.stop(); progress.destroy(); clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', finish);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (toast.closing) remove(toast.id);
      else reveal();
    };
    const visibility = () => { if (document.hidden) finish(); };
    animation = animate(progress, 1, toast.closing
      ? { duration: motionDurations.toastExit, ease: 'easeIn', onComplete: finish }
      : { ...motionToastTransition, onComplete: finish });
    // A spring's visual duration precedes its quiet settling tail. The fallback
    // only releases a stalled animation; lifecycle events settle synchronously.
    timer = setTimeout(finish, (toast.closing ? motionDurations.toastExit + .1 : motionDurations.toastEnter + 1) * 1000);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', finish);
    return () => { settled = true; cleanup(); };
  }, [toast.closing, toast.id, host, reducedMotion, remove]);
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
