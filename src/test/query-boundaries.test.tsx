// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { mutateData, refreshLiveData } from '../shared/query/mutations';
import { queryKeys } from '../shared/query/keys';
import {
  NotificationsProvider,
  useNotifications,
} from '../app/providers/Notifications';
import { useSnapshotSelector } from '../shared/query/snapshot';
import { snapshotApi } from '../shared/query/snapshot-api';
import type { AppSnapshot } from '../shared/contracts/snapshot';

vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../shared/query/snapshot-api', () => ({
  snapshotApi: { snapshot: vi.fn() },
}));
const clients: QueryClient[] = [];
function client() {
  const value = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(value);
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((value) => value.clear());
  vi.clearAllMocks();
});

describe('data mutation boundaries', () => {
  it('refreshes affected subtitles without invalidating another media or stream inspection', async () => {
    const cache = client();
    const keys = [
      queryKeys.snapshot,
      queryKeys.segments('a'),
      queryKeys.candidates('a'),
      queryKeys.versions('a'),
      queryKeys.segments('b'),
      queryKeys.streams('a'),
    ];
    keys.forEach((key) => cache.setQueryData(key, []));
    await mutateData(cache, async () => undefined, {
      kind: 'subtitles',
      mediaId: 'a',
    });
    expect(keys.map((key) => cache.getQueryState(key)?.isInvalidated)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });
  it('preserves void success and propagates a failed write without marking data stale', async () => {
    const cache = client();
    cache.setQueryData(queryKeys.snapshot, {});
    const failure = new Error('Write rejected');
    await expect(
      mutateData(
        cache,
        async () => {
          throw failure;
        },
        { kind: 'snapshot' },
      ),
    ).rejects.toBe(failure);
    expect(cache.getQueryState(queryKeys.snapshot)?.isInvalidated).toBe(false);
    await expect(
      mutateData(cache, async () => undefined, { kind: 'snapshot' }),
    ).resolves.toBeUndefined();
    expect(cache.getQueryState(queryKeys.snapshot)?.isInvalidated).toBe(true);
  });
  it('lets a pending static read finish when the related mutation fails', async () => {
    const cache = client();
    const pending = deferred<string[]>();
    const key = queryKeys.streams('a');
    const read = vi.fn(() => pending.promise);
    const observer = new QueryObserver(cache, { queryKey: key, queryFn: read });
    const stop = observer.subscribe(() => {});
    try {
      expect(cache.getQueryState(key)?.fetchStatus).toBe('fetching');
      await expect(
        mutateData(
          cache,
          async () => {
            throw new Error('Relink rejected');
          },
          { kind: 'media', mediaId: 'a' },
        ),
      ).rejects.toThrow('Relink rejected');
      expect(cache.getQueryState(key)?.fetchStatus).toBe('fetching');
      pending.resolve(['original audio stream']);
      await waitFor(() =>
        expect(cache.getQueryData(key)).toEqual(['original audio stream']),
      );
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
  it('cancels a heartbeat read started during the mutation before refreshing committed state', async () => {
    const cache = client();
    const write = deferred<void>();
    const staleRead = deferred<string>();
    let committed = false;
    const read = vi.fn(() =>
      committed ? Promise.resolve('committed') : staleRead.promise,
    );
    cache.setQueryData(queryKeys.segments('a'), 'original');
    const observer = new QueryObserver(cache, {
      queryKey: queryKeys.segments('a'),
      queryFn: read,
      staleTime: Infinity,
    });
    const stop = observer.subscribe(() => {});
    const mutation = mutateData(
      cache,
      async () => {
        await write.promise;
        committed = true;
      },
      { kind: 'subtitles', mediaId: 'a' },
    );
    await Promise.resolve();
    const heartbeat = refreshLiveData(cache);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    write.resolve();
    await mutation;
    expect(cache.getQueryData(queryKeys.segments('a'))).toBe('committed');
    staleRead.resolve('stale before commit');
    await heartbeat;
    expect(cache.getQueryData(queryKeys.segments('a'))).toBe('committed');
    stop();
  });
  it('refreshes live results on the native heartbeat without rereading static inspection/history', async () => {
    const cache = client();
    const keys = [
      queryKeys.snapshot,
      queryKeys.downloads,
      queryKeys.segments('a'),
      queryKeys.candidates('a'),
      queryKeys.review('job'),
      queryKeys.streams('a'),
      queryKeys.versions('a'),
    ];
    keys.forEach((key) => cache.setQueryData(key, []));
    await refreshLiveData(cache);
    expect(keys.map((key) => cache.getQueryState(key)?.isInvalidated)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });
  it('refreshes all persistent caches only for restore', async () => {
    const cache = client();
    [
      queryKeys.snapshot,
      queryKeys.segments('a'),
      queryKeys.streams('b'),
    ].forEach((key) => cache.setQueryData(key, []));
    await mutateData(cache, async () => undefined, { kind: 'restore' });
    expect(
      cache
        .getQueryCache()
        .getAll()
        .every((query) => query.state.isInvalidated),
    ).toBe(true);
  });
});

it('reports read/action failures separately from void success without touching query caches', async () => {
  const cache = client();
  cache.setQueryData(queryKeys.snapshot, {});
  const { result } = renderHook(useNotifications, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <NotificationsProvider>{children}</NotificationsProvider>
    ),
  });
  await act(async () => {
    await result.current.report(async () => undefined, 'Saved');
  });
  expect(document.body.textContent).toContain('Saved');
  await act(async () => {
    await result.current.report(async () => {
      throw new Error('Not saved');
    }, 'Must not appear');
  });
  expect(document.body.textContent).toContain('Not saved');
  expect(document.body.textContent).not.toContain('Must not appear');
  expect(cache.getQueryState(queryKeys.snapshot)?.isInvalidated).toBe(false);
});

it('shares one snapshot request across domain selectors and retains unchanged selection identity', async () => {
  const cache = client();
  const snapshot = {
    media: [],
    cards: [],
    settings: { locale: 'en' },
  } as unknown as AppSnapshot;
  vi.mocked(snapshotApi.snapshot).mockResolvedValue(snapshot);
  const selectSettings = (value: AppSnapshot) => value.settings;
  const selectCards = (value: AppSnapshot) => value.cards;
  const { result } = renderHook(
    () => ({
      settings: useSnapshotSelector(selectSettings),
      cards: useSnapshotSelector(selectCards),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={cache}>{children}</QueryClientProvider>
      ),
    },
  );
  await waitFor(() => expect(result.current.settings.data).toBeDefined());
  const settings = result.current.settings.data;
  expect(snapshotApi.snapshot).toHaveBeenCalledTimes(1);
  act(() => {
    cache.setQueryData(queryKeys.snapshot, {
      ...snapshot,
      cards: [{ id: 'new-card' }],
    });
  });
  await waitFor(() => expect(result.current.cards.data).toHaveLength(1));
  expect(result.current.settings.data).toBe(settings);
});
