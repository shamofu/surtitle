// SPDX-License-Identifier: GPL-3.0-or-later
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

interface Toast {
  id: number;
  text: string;
  kind: 'success' | 'error';
}
interface Notifications {
  notify: (text: string, kind?: Toast['kind']) => void;
  report: <T>(
    action: () => Promise<T>,
    success?: string,
  ) => Promise<T | undefined>;
}
const Context = createContext<Notifications | null>(null);
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const nextId = useRef(0);
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
        setToasts((items) => items.filter((item) => item.id !== id));
      }, 6500);
      timers.current.add(timer);
    },
    [],
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
  const value = useMemo(() => ({ notify, report }), [notify, report]);
  return (
    <Context.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            className={`toast ${toast.kind}`}
            onClick={() =>
              setToasts((items) => items.filter((item) => item.id !== toast.id))
            }
          >
            {toast.text}
          </button>
        ))}
      </div>
    </Context.Provider>
  );
}
export function useNotifications() {
  const value = useContext(Context);
  if (!value) throw new Error('NotificationsProvider missing');
  return value;
}
