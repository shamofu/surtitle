// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { snapshotOptions } from '../../shared/query/snapshot';
import { startDataSynchronization } from '../../shared/query/synchronization';
import { nativeAvailable } from '../../shared/native/transport';
import type { AppSnapshot } from '../../shared/contracts/snapshot';
import { useNotifications } from './Notifications';
interface Snapshot {
  data?: AppSnapshot;
  loading: boolean;
  error: Error | null;
}
const Context = createContext<Snapshot | null>(null);
export function SnapshotProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery(snapshotOptions());
  const { notify } = useNotifications();
  useEffect(() => {
    if (!nativeAvailable()) return;
    return startDataSynchronization(client, error => notify(String(error), 'error'));
  }, [client, notify]);
  const value = useMemo(
    () => ({
      data: query.data,
      loading: query.isLoading,
      error: query.error,
    }),
    [query.data, query.isLoading, query.error],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useSnapshot() {
  const value = useContext(Context);
  if (!value) throw new Error('SnapshotProvider missing');
  return value;
}
