// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode } from 'react';
import { AppearanceProvider } from './providers/Appearance';
import { NotificationsProvider } from './providers/Notifications';
import { SnapshotProvider } from './providers/Snapshot';
import { SurfaceProvider } from './providers/Surface';
import { ActivityProvider } from './providers/Activities';
import { PreparationSessionsProvider } from '../features/ai/PreparationSessions';
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <SurfaceProvider>
      <NotificationsProvider>
        <SnapshotProvider>
          <AppearanceProvider><ActivityProvider><PreparationSessionsProvider>{children}</PreparationSessionsProvider></ActivityProvider></AppearanceProvider>
        </SnapshotProvider>
      </NotificationsProvider>
    </SurfaceProvider>
  );
}
