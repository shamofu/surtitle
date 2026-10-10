// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode } from 'react';
import { AppearanceProvider } from './providers/Appearance';
import { NotificationsProvider } from './providers/Notifications';
import { SnapshotProvider } from './providers/Snapshot';
import { SurfaceProvider } from './providers/Surface';
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <SurfaceProvider>
      <NotificationsProvider>
        <SnapshotProvider>
          <AppearanceProvider>{children}</AppearanceProvider>
        </SnapshotProvider>
      </NotificationsProvider>
    </SurfaceProvider>
  );
}
