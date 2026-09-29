// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useNotifications } from '../../app/runtime';
import { nativeAvailable } from '../../shared/native/transport';
import { closeWindow, subscribeWindowClose } from '../../shared/native/window';

export function useStudyExitGuard(dirty: boolean, saving: boolean, onDiscard: () => void) {
  const protectedSession = dirty || saving;
  const latest = useRef(protectedSession);
  latest.current = protectedSession;
  const { notify } = useNotifications();
  const [nativeClose, setNativeClose] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const closePending = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: useCallback(({ current, next }) =>
      latest.current && current.pathname !== next.pathname, []),
    withResolver: true,
    enableBeforeUnload: protectedSession,
    disabled: !protectedSession,
  });

  useEffect(() => {
    if (!nativeAvailable()) return;
    return subscribeWindowClose(() => {
      if (!latest.current) return false;
      setNativeClose(true);
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
    if (saving || closePending.current) return;
    if (nativeClose) {
      closePending.current = true;
      setClosing(true);
      setError('');
      try {
        // Keep the drafts if native closure fails; destroy bypasses this close request.
        await closeWindow();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        closePending.current = false;
        setClosing(false);
      }
    } else if (blocker.status === 'blocked') {
      onDiscard();
      blocker.proceed();
    }
  }
  return { open: nativeClose || blocker.status === 'blocked', closing, error, keepEditing, discard };
}
