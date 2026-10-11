// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createDataSynchronizer } from '../shared/query/synchronization';
import { queryKeys } from '../shared/query/keys';

it('invalidates a stale resource read begun before the event but resolved during coalescing', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const sync = createDataSynchronizer(client, {
    checkpoint: async () => ({ version: 1, epoch: 'one', revision: 1, domains: [{ domain: 'subtitles', revision: 1 }] }),
    patch: async () => ({}),
    listen: () => () => {},
  }, error => { throw error; });
  try {
    let resolve!: (value: string[]) => void;
    const oldRead = client.fetchQuery({ queryKey: queryKeys.segments('media'), queryFn: () => new Promise<string[]>(done => { resolve = done; }) });
    vi.setSystemTime(1010);
    sync.receive({ version: 1, epoch: 'one', revision: 1, domain: 'subtitles', entityId: 'media' });
    vi.setSystemTime(1020);
    resolve(['before native commit']);
    await oldRead;
    await sync.flush();
    await sync.recover();
    await sync.flush();
    expect(client.getQueryState(queryKeys.segments('media'))?.isInvalidated).toBe(true);
  } finally {
    sync.dispose(); client.clear(); vi.useRealTimers();
  }
});

it('cancels an initial resource read before refetching the notified revision', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const sync = createDataSynchronizer(client, {
    checkpoint: async () => ({ version: 1, epoch: 'one', revision: 0, domains: [] }),
    patch: async () => ({}), listen: () => () => {},
  }, error => { throw error; });
  let resolveOld!: (value: string[]) => void;
  const read = vi.fn<() => Promise<string[]>>()
    .mockImplementationOnce(() => new Promise(done => { resolveOld = done; }))
    .mockResolvedValue(['after native commit']);
  const observer = new QueryObserver(client, { queryKey: queryKeys.segments('media'), queryFn: read });
  const unsubscribe = observer.subscribe(() => {});
  try {
    expect(read).toHaveBeenCalledOnce();
    sync.receive({ version: 1, epoch: 'one', revision: 1, domain: 'subtitles', entityId: 'media' });
    await sync.flush();
    expect(read).toHaveBeenCalledTimes(2);
    resolveOld(['before native commit']);
    await Promise.resolve();
    expect(client.getQueryData(queryKeys.segments('media'))).toEqual(['after native commit']);
  } finally { unsubscribe(); sync.dispose(); client.clear(); }
});

it('retains a resource revision for retry after its active refetch fails', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.segments('media'), ['before native commit']);
  const report = vi.fn();
  const sync = createDataSynchronizer(client, {
    checkpoint: async () => ({ version: 1, epoch: 'one', revision: 1, domains: [{ domain: 'subtitles', revision: 1 }] }),
    patch: async () => ({}), listen: () => () => {},
  }, report);
  const read = vi.fn<() => Promise<string[]>>()
    .mockRejectedValueOnce(new Error('temporary read failure'))
    .mockResolvedValue(['after native commit']);
  const observer = new QueryObserver(client, { queryKey: queryKeys.segments('media'), queryFn: read });
  const unsubscribe = observer.subscribe(() => {});
  try {
    sync.receive({ version: 1, epoch: 'one', revision: 1, domain: 'subtitles', entityId: 'media' });
    await sync.flush();
    expect(report).toHaveBeenCalledOnce();
    await sync.recover();
    await sync.flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(queryKeys.segments('media'))).toEqual(['after native commit']);
  } finally { unsubscribe(); sync.dispose(); client.clear(); }
});
