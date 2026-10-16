// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, type ReactNode } from 'react';
import { flushEdits, pendingEdits } from '../../shared/editing/session';
import { importWorkspace } from '../../features/library/import-workspace';
import { flushEditorDrafts, pendingEditorDrafts } from '../../features/study/editor-drafts/session';
import { nativeAvailable } from '../../shared/native/transport';
import { hasPendingCloseTasks, registerCloseTask, subscribeWindowClose } from '../../shared/native/window';
import { useNotifications } from './Notifications';
import { useAppearance } from './Appearance';

/** Flushes pending writes on app exit, without introducing a confirmation dialog. */
export function EditingProvider({ children }: { children: ReactNode }) {
  const { notify } = useNotifications();
  const { t } = useAppearance();
  useEffect(() => {
    const unregister = registerCloseTask(async () => {
      const [saved] = await Promise.all([flushEdits(), importWorkspace.flush(), flushEditorDrafts()]);
      if (!saved) throw new Error(t('入力を保存できませんでした。内容は保持しています。再試行してください。', 'Could not save your input. It is still here; please retry.'));
    }, () => pendingEdits() || importWorkspace.pending || pendingEditorDrafts());
    const unsubscribe = nativeAvailable() ? subscribeWindowClose(hasPendingCloseTasks, {
      onError: error => notify(String(error), 'error'),
    }) : () => {};
    return () => { unregister(); unsubscribe(); };
  }, [notify, t]);
  return children;
}
