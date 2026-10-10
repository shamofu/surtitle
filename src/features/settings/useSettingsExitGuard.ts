// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useAppearance, useNotifications } from '../../app/runtime';
import { nativeAvailable } from '../../shared/native/transport';
import { closeWindow, subscribeWindowClose } from '../../shared/native/window';
import { useModalExit } from '../../shared/ui';

export function useSettingsExitGuard(dirty: boolean, saving: boolean, save: () => Promise<boolean | undefined>, preparing = false) {
  const { t } = useAppearance();
  const { notify } = useNotifications();
  const latest = useRef({ dirty, saving, save, preparing });
  latest.current = { dirty, saving, save, preparing };
  const leaving = useRef(false);
  const savedNavigation = useRef(false);
  const [nativeClose, setNativeClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const blocker = useBlocker({
    shouldBlockFn: useCallback(({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      if (savedNavigation.current) {
        savedNavigation.current = false;
        return false;
      }
      return latest.current.dirty || latest.current.saving || latest.current.preparing;
    }, []),
    withResolver: true,
    enableBeforeUnload: dirty || saving || busy || preparing,
  });
  const open = nativeClose || blocker.status === 'blocked';
  const exit = useModalExit(open);

  useEffect(() => {
    if (!nativeAvailable()) return;
    return subscribeWindowClose(() => {
      if (leaving.current) return true;
      if (!latest.current.dirty && !latest.current.saving && !latest.current.preparing) return false;
      setNativeClose(true);
      return true;
    }, cause => notify(String(cause), 'error'));
  }, [notify]);

  function keepEditing() {
    if (leaving.current || latest.current.saving || exit.exiting) return;
    void exit.close(() => {
      setNativeClose(false);
      setError('');
      if (blocker.status === 'blocked') blocker.reset();
    });
  }

  async function leave(saveFirst: boolean) {
    if (leaving.current || latest.current.saving || (saveFirst && latest.current.preparing)) return;
    leaving.current = true;
    setBusy(true);
    setError('');
    try {
      if (saveFirst && !await latest.current.save()) {
        setError(t('設定を保存できませんでした。入力内容を確認して、もう一度保存してください。', 'Settings could not be saved. Check the values and try again.'));
        return;
      }
      await exit.close(async () => {
        if (nativeClose) await closeWindow();
        else if (blocker.status === 'blocked') blocker.proceed();
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      leaving.current = false;
      setBusy(false);
    }
  }

  return {
    open,
    modalProps: exit.modalProps,
    busy: busy || saving || exit.exiting,
    error,
    keepEditing,
    saveAndLeave: () => leave(true),
    discardAndLeave: () => leave(false),
    allowSavedNavigation: () => { savedNavigation.current = true; },
  };
}
