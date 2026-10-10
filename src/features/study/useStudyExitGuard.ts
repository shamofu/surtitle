// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useNotifications } from '../../app/runtime';
import { nativeAvailable } from '../../shared/native/transport';
import { closeWindow, subscribeWindowClose } from '../../shared/native/window';

export function useStudyExitGuard(dirty: boolean, saving: boolean, onDiscard: () => void, beforeLeave?: () => Promise<void>) {
  const protectedSession = dirty || saving;
  const latest = useRef(protectedSession);
  latest.current = protectedSession;
  const latestBeforeLeave = useRef(beforeLeave); latestBeforeLeave.current = beforeLeave;
  const latestSaving = useRef(saving); latestSaving.current = saving;
  const { notify } = useNotifications();
  const [nativeClose, setNativeClose] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const closePending = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: useCallback(({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      if (latestSaving.current) return true;
      if (latestBeforeLeave.current) {
        return latestBeforeLeave.current().then(() => false).catch(cause => {
          setError(cause instanceof Error ? cause.message : String(cause)); return true;
        });
      }
      return latest.current;
    }, []),
    withResolver: true,
    enableBeforeUnload: protectedSession,
    disabled: !protectedSession && !beforeLeave,
  });

  useEffect(() => {
    if (!nativeAvailable()) return;
    return subscribeWindowClose(() => {
      if (!latest.current && !latestBeforeLeave.current) return false;
      if (closePending.current) return true;
      if (latestSaving.current || !latestBeforeLeave.current) { setNativeClose(true); return true; }
      closePending.current = true;
      setClosing(true);
      void latestBeforeLeave.current().then(closeWindow).catch(cause => {
        setError(cause instanceof Error ? cause.message : String(cause)); setNativeClose(true);
      }).finally(() => { closePending.current = false; setClosing(false); });
      return true;
    }, cause => notify(String(cause), 'error'));
  }, [notify]);

  function keepEditing() {
    if (closePending.current) return;
    setNativeClose(false);
    setError('');
    if (blocker.status === 'blocked') blocker.reset();
  }
  async function discard() {
    if (saving || closePending.current) return false;
    if (nativeClose) {
      closePending.current = true;
      setClosing(true);
      setError('');
      try {
        // Keep the drafts if native closure fails; destroy bypasses this close request.
        await closeWindow();
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        closePending.current = false;
        setClosing(false);
      }
    } else if (blocker.status === 'blocked') {
      onDiscard();
      blocker.proceed();
      return true;
    }
    return false;
  }
  async function retry() {
    if (saving || closePending.current || !beforeLeave) return false;
    setClosing(true); setError(''); closePending.current = true;
    try {
      await beforeLeave();
      if (nativeClose) await closeWindow();
      else if (blocker.status === 'blocked') blocker.proceed();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { closePending.current = false; setClosing(false); }
  }
  return { open: nativeClose || blocker.status === 'blocked', closing, error, keepEditing, discard, retry };
}
