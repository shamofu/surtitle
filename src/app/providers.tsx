// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode } from 'react';
import { AppearanceProvider } from './providers/Appearance';
import { NotificationsProvider } from './providers/Notifications';
import { SnapshotProvider } from './providers/Snapshot';
import { SurfaceProvider } from './providers/Surface';
import { ActivityProvider } from './providers/Activities';
import { PreparationSessionsProvider } from '../features/ai/PreparationSessions';
import { MotionProvider } from '../shared/motion';
import { useSettings } from '../shared/query/snapshot';
import { nativeAvailable } from '../shared/native/transport';

function AppMotionProvider({ children }: { children: ReactNode }) {
  const { data: settings } = useSettings();
  // Avoid animating the startup UI before a saved reduced-motion preference is read.
  const preference = !settings && nativeAvailable() ? 'reduce' : settings?.motionPreference ?? 'system';
  return <MotionProvider preference={preference}>{children}</MotionProvider>;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AppMotionProvider>
      <SurfaceProvider>
        <NotificationsProvider>
          <SnapshotProvider>
            <AppearanceProvider><ActivityProvider><PreparationSessionsProvider>{children}</PreparationSessionsProvider></ActivityProvider></AppearanceProvider>
          </SnapshotProvider>
        </NotificationsProvider>
      </SurfaceProvider>
    </AppMotionProvider>
  );
}
