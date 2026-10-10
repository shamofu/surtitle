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
import * as m from 'motion/react-m';
import { useSurface } from './Surface';
import { motionDurations, motionEase, useAppMotion } from '../../shared/motion';

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
  // Moving one portal container preserves toast identity and its live region
  // when a nested dialog becomes the frontmost surface.
  const [portalRoot] = useState(() => {
    const element = document.createElement('div');
    element.className = 'notification-portal';
    return element;
  });
  const host = notificationHost ?? pageHost;
  useLayoutEffect(() => {
    (host ?? document.body).appendChild(portalRoot);
  }, [host, portalRoot]);
  useLayoutEffect(() => () => { portalRoot.remove(); }, [portalRoot]);
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
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map(toast => (
        <ToastMessage key={toast.id} toast={toast} dismiss={dismiss} remove={remove} />
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
  useEffect(() => {
    if (!toast.closing) return;
    if (reducedMotion) { remove(toast.id); return; }
    const fallback = window.setTimeout(() => remove(toast.id), motionDurations.exit * 1000 + 100);
    return () => clearTimeout(fallback);
  }, [toast.closing, toast.id, reducedMotion, remove]);
  return <m.button className={`toast ${toast.kind}`} disabled={toast.closing}
    initial={reducedMotion ? false : { opacity: 0, y: -10 }}
    animate={{ opacity: toast.closing ? 0 : 1, y: toast.closing && !reducedMotion ? -8 : 0 }}
    transition={{ duration: reducedMotion ? 0 : toast.closing ? motionDurations.exit : motionDurations.enter, ease: motionEase }}
    onAnimationComplete={() => { if (toast.closing) remove(toast.id); }}
    onClick={() => dismiss(toast.id)}>{toast.text}</m.button>;
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
