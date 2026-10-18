// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useSyncExternalStore } from 'react';
import type { EditingSession } from './session';

export function useEditingSession(session: EditingSession) {
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    void session.refresh();
    return () => { void session.flush(); };
  }, [session]);
  return view;
}
