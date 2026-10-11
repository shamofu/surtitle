// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, type ReactNode } from 'react';
import { flushEdits, pendingEdits } from '../../shared/editing/session';
import { importWorkspace } from '../../features/library/import-workspace';
import { flushEditorDrafts, pendingEditorDrafts } from '../../features/study/editor-drafts/session';
import { nativeAvailable } from '../../shared/native/transport';
import { flushCloseTasks, hasPendingCloseTasks, registerCloseTask, requestWindowClose, subscribeWindowClose } from '../../shared/native/window';
import { useNotifications } from './Notifications';
import { useAppearance } from './Appearance';

/** Flushes pending writes on app exit, without introducing a confirmation dialog. */
export function EditingProvider({ children }: { children: ReactNode }) {
  const { notify } = useNotifications();
  const { t } = useAppearance();
  const closing = useRef(false);
  useEffect(() => {
    const unregister = registerCloseTask(async () => {
      const [saved] = await Promise.all([flushEdits(), importWorkspace.flush(), flushEditorDrafts()]);
      if (!saved) throw new Error(t('入力を保存できませんでした。内容は保持しています。再試行してください。', 'Could not save your input. It is still here; please retry.'));
    }, () => pendingEdits() || importWorkspace.pending || pendingEditorDrafts());
    const unsubscribe = nativeAvailable() ? subscribeWindowClose(() => {
      if (closing.current) return true;
      if (!hasPendingCloseTasks()) return false;
      closing.current = true;
      void flushCloseTasks().then(async () => {
        closing.current = false;
        // Re-enter the close event so a pending card creation can still finish.
        await requestWindowClose();
      }).catch(error => { closing.current = false; notify(String(error), 'error'); });
      return true;
    }, error => notify(String(error), 'error')) : () => {};
    return () => { unregister(); unsubscribe(); };
  }, [notify, t]);
  return children;
}
