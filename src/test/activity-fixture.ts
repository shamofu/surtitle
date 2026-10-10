// SPDX-License-Identifier: GPL-3.0-or-later
// Feature-only tests exercise their commands independently of the app-wide store.
// The real provider and lifecycle are covered in activities.test.tsx.
import type { ReactNode } from 'react';
import type { ActivityDescriptor, ActivityUpdate } from '../shared/contracts/activity';

const runTracked = <T,>(_descriptor: ActivityDescriptor, action: (update: (patch: ActivityUpdate) => void) => Promise<T>) => action(() => {});
export function useActivities() {
  return { activities: [], runningCount: 0, isOpen: false, open: () => {}, close: () => {}, runTracked };
}
export function ActivityProvider({ children }: { children: ReactNode }) { return children; }
