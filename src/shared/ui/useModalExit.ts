// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

interface PendingExit {
  action: () => void | Promise<void>;
  promise: Promise<boolean>;
  resolve: (completed: boolean) => void;
  reject: (reason: unknown) => void;
  running: boolean;
}

/** Run an already accepted close only after the native dialog has left the top layer. */
export function useModalExit(active = true) {
  const [exiting, setExiting] = useState(false);
  const pending = useRef<PendingExit | null>(null);
  const mounted = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;

  const cancel = useCallback(() => {
    const previous = pending.current;
    pending.current = null;
    if (previous && !previous.running) previous.resolve(false);
  }, []);
  const reopen = useCallback(() => {
    cancel();
    if (mounted.current) setExiting(false);
  }, [cancel]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [cancel]);
  useLayoutEffect(() => {
    if (!active) reopen();
  }, [active, reopen]);

  const close = useCallback((action: () => void | Promise<void>): Promise<boolean> => {
    if (!mounted.current || !activeRef.current) return Promise.resolve(false);
    if (pending.current) return pending.current.promise;
    let resolve!: PendingExit['resolve'];
    let reject!: PendingExit['reject'];
    const promise = new Promise<boolean>((done, fail) => { resolve = done; reject = fail; });
    pending.current = { action, promise, resolve, reject, running: false };
    setExiting(true);
    return promise;
  }, []);
  const currentExit = pending.current;
  const onExited = useCallback(() => {
    const entry = currentExit;
    if (!entry || pending.current !== entry || entry.running || !mounted.current || !activeRef.current) return;
    entry.running = true;
    // Invoke synchronously: focus restoration must observe the owner's closing render.
    try {
      const result = entry.action();
      void Promise.resolve(result).then(() => {
        entry.resolve(true);
      }, error => {
        if (pending.current === entry) reopen();
        entry.reject(error);
      });
    } catch (error) {
      if (pending.current === entry) reopen();
      entry.reject(error);
    }
  }, [currentExit, reopen]);

  return { exiting, close, reopen, modalProps: { open: active && !exiting, onExited } };
}
