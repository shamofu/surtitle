// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useNotifications } from '../../app/runtime';
import { nativeAvailable } from '../../shared/native/transport';
import { closeWindow, registerCloseTask, subscribeWindowClose } from '../../shared/native/window';

export function useStudyExitGuard(dirty: boolean, saving: boolean, onDiscard: () => void, beforeLeave?: () => Promise<void>) {
  const protectedSession = dirty || saving;
  const latest = useRef(protectedSession);
  latest.current = protectedSession;
  const latestDirty = useRef(dirty); latestDirty.current = dirty;
  const latestBeforeLeave = useRef(beforeLeave); latestBeforeLeave.current = beforeLeave;
  const latestSaving = useRef(saving); latestSaving.current = saving;
  const saveWaiters = useRef<Array<() => void>>([]);
  useEffect(() => { if (!saving) saveWaiters.current.splice(0).forEach(resolve => resolve()); }, [saving]);
  const waitForSave = useCallback(() => latestSaving.current
    ? new Promise<void>(resolve => saveWaiters.current.push(resolve)) : Promise.resolve(), []);
  // Direct closeWindow calls (including detached card creation) must honor this
  // save too; a separate preventDefault guard alone cannot delay destruction.
  useEffect(() => registerCloseTask(async () => {
    await waitForSave();
    if (latestDirty.current && !latestBeforeLeave.current) throw new Error('Save unfinished input before closing.');
    await latestBeforeLeave.current?.();
  }, () => latestSaving.current || (latestDirty.current && !latestBeforeLeave.current)), [waitForSave]);
  const { notify } = useNotifications();
  const [nativeClose, setNativeClose] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const closePending = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: useCallback(({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      if (latestSaving.current) {
        return waitForSave().then(async () => { await latestBeforeLeave.current?.(); return false; }).catch(cause => {
          setError(cause instanceof Error ? cause.message : String(cause)); return true;
        });
      }
      if (latestBeforeLeave.current) {
        return latestBeforeLeave.current().then(() => false).catch(cause => {
          setError(cause instanceof Error ? cause.message : String(cause)); return true;
        });
      }
      return latest.current;
    }, [waitForSave]),
    withResolver: true,
    enableBeforeUnload: protectedSession,
    disabled: !protectedSession && !beforeLeave,
  });

  useEffect(() => {
    if (!nativeAvailable()) return;
    return subscribeWindowClose(() => {
      if (!latest.current && !latestBeforeLeave.current) return false;
      if (closePending.current) return true;
      if (!latestSaving.current && !latestBeforeLeave.current) { setNativeClose(true); return true; }
      closePending.current = true;
      setClosing(true);
      void waitForSave().then(() => latestBeforeLeave.current?.()).then(closeWindow).catch(cause => {
        setError(cause instanceof Error ? cause.message : String(cause)); setNativeClose(true);
      }).finally(() => { closePending.current = false; setClosing(false); });
      return true;
    }, cause => notify(String(cause), 'error'));
  }, [notify, waitForSave]);

  function keepEditing() {
    if (closePending.current) return;
    setNativeClose(false);
    setError('');
    if (blocker.status === 'blocked') blocker.reset();
  }
  async function discard() {
    // Failed native persistence cannot honestly promise to discard just one
    // editor while preserving every other outstanding task. Keep recovery open.
    if (saving || closePending.current || nativeClose) return false;
    if (blocker.status === 'blocked') {
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
  return { open: nativeClose || (blocker.status === 'blocked' && !saving), closing, error, canDiscard: !nativeClose, keepEditing, discard, retry };
}
