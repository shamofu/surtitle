// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { snapshotOptions } from '../../shared/query/snapshot';
import { refreshLiveData } from '../../shared/query/mutations';
import { nativeAvailable } from '../../shared/native/transport';
import { subscribeNative } from '../../shared/native/events';
import { dueCards } from '../../shared/format';
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
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!nativeAvailable()) return;
    return subscribeNative(
      'app-changed',
      () => {
        void refreshLiveData(client);
      },
      (error) => notify(String(error), 'error'),
    );
  }, [client, notify]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!query.data || !nativeAvailable()) return;
    const due = dueCards(query.data.cards, clock).length;
    if (!due) return;
    const day = new Date(clock).toLocaleDateString('en-CA');
    try {
      if (localStorage.getItem('surtitle-review-notified-day') === day) return;
      localStorage.setItem('surtitle-review-notified-day', day);
    } catch {
      return;
    }
    notify(
      query.data.settings.locale === 'ja'
        ? `${due} 個のフレーズが復習の時間です。上部の「復習」から始められます。`
        : `${due} phrases are ready to revisit. Open Review in the top navigation when you have a moment.`,
    );
  }, [query.data?.cards, query.data?.settings.locale, clock, notify]);
  const value = useMemo(
    () => ({
      data: query.data,
      loading: query.isLoading,
      error: query.error,
    }),
    [query.data, query.isLoading, query.error, clock],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useSnapshot() {
  const value = useContext(Context);
  if (!value) throw new Error('SnapshotProvider missing');
  return value;
}
