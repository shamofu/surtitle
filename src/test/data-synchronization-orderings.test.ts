// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { AppSnapshot } from '../shared/contracts/snapshot';
import type { ChangeCheckpoint, ChangeDomain } from '../shared/contracts/synchronization';
import { createDataSynchronizer } from '../shared/query/synchronization';
import { queryKeys } from '../shared/query/keys';
import { controlled, legalOrders, settle } from './legal-orderings';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const baseline = { media: [], cards: [], jobs: [], tools: [], settings: { locale: 'en' }, budget: {} } as unknown as AppSnapshot;
const readOrders = legalOrders({ captureOld: [], notify: ['captureOld'], startNew: ['notify'], captureNew: ['startNew'], finishOld: ['captureOld'], finishNew: ['captureNew'] } as const);
const restoreOrders = legalOrders({ captureCheckpoint: [], restore: ['captureCheckpoint'], finishPatch: ['restore'], finishCheckpoint: ['captureCheckpoint'], drain: ['finishPatch', 'finishCheckpoint'] } as const);
const eventOrders = legalOrders({ latest: [], duplicate: ['latest'], older: [], failed: ['latest'], recover: ['failed', 'duplicate', 'older'] } as const);

function makeSync() {
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  const source = { checkpoint: vi.fn<() => Promise<ChangeCheckpoint>>().mockResolvedValue({ version: 1, epoch: 'one', revision: 0, domains: [] }),
    patch: vi.fn<(domains: string[]) => Promise<Partial<AppSnapshot>>>().mockResolvedValue({}), listen: vi.fn(() => vi.fn()) };
  const errors: unknown[] = [];
  const sync = createDataSynchronizer(client, source, error => errors.push(error));
  const event = (domain: ChangeDomain, revision: number, entityId?: string, epoch = 'one') => sync.receive({ version: 1, epoch, domain, revision, entityId });
  return { client, source, sync, errors, event, close: () => { sync.dispose(); client.clear(); vi.clearAllTimers(); } };
}

it('enumerates all legal old/new active read orders across two domains, entities and epochs', async () => {
  expect(readOrders).toHaveLength(5);
  let explored = 0;
  for (const domain of ['subtitles', 'media'] as const) for (const entity of ['a', 'b']) for (const epoch of ['one', 'two']) for (const order of readOrders) {
    const f = makeSync();
    const key = domain === 'subtitles' ? queryKeys.segments(entity) : queryKeys.streams(entity);
    const unrelated = domain === 'subtitles' ? queryKeys.streams(entity === 'a' ? 'b' : 'a') : queryKeys.segments(entity === 'a' ? 'b' : 'a');
    f.client.setQueryData(unrelated, ['unrelated']);
    const reads: ReturnType<typeof controlled<string[]>>[] = [];
    const snapshots: string[][] = [];
    const observer = new QueryObserver(f.client, { queryKey: key, queryFn: () => { const read = controlled<string[]>(); reads.push(read); return read.promise; } });
    const stop = observer.subscribe(() => {});
    let expected: string[] | undefined, oldFinished = false, newStarted = false;
    let flushing: Promise<void> | undefined;
    try {
      expect(reads).toHaveLength(1);
      for (const action of order) {
        switch (action) {
          case 'captureOld': snapshots[0] = ['old']; break;
          case 'notify': f.event(domain, 1, entity, epoch); break;
          case 'startNew': newStarted = true; flushing = f.sync.flush(); await settle(); expect(reads).toHaveLength(2); if (!oldFinished) expected = undefined; break;
          case 'captureNew': snapshots[1] = [`${epoch}:new`]; break;
          case 'finishOld': reads[0].resolve(snapshots[0]); oldFinished = true; if (!newStarted) expected = snapshots[0]; break;
          case 'finishNew': reads[1].resolve(snapshots[1]); expected = snapshots[1]; break;
        }
        await settle();
        expect(f.client.getQueryData(key), order.join(' > ')).toEqual(expected);
        expect(f.client.getQueryData(unrelated)).toEqual(['unrelated']);
        expect(f.client.getQueryState(unrelated)?.isInvalidated).toBe(false);
        expect(reads.length).toBeLessThanOrEqual(2);
      }
      await flushing;
      expect(f.client.getQueryData(key)).toEqual([`${epoch}:new`]);
      expect(f.errors).toEqual([]); explored++;
    } finally { stop(); f.close(); }
  }
  expect(explored).toBe(40);
});

it('applies only the latest snapshot patch when a domain changes during an earlier patch', async () => {
  const orders = legalOrders({ captureOld: [], notify: ['captureOld'], finishOld: ['captureOld'], drain: ['notify', 'finishOld'] } as const);
  expect(orders).toHaveLength(2);
  let explored = 0;
  for (const domain of ['cards', 'jobs'] as const) for (const entity of ['a', 'b']) for (const epoch of ['one', 'two']) for (const order of orders) {
    const f = makeSync(); f.client.setQueryData(queryKeys.snapshot, baseline);
    const old = controlled<Partial<AppSnapshot>>(); let captured: Partial<AppSnapshot> = {};
    f.source.patch.mockReturnValueOnce(old.promise);
    f.event(domain, 1, entity, epoch); const flushing = f.sync.flush(); await settle();
    let notified = false, finished = false, drained = false;
    for (const action of order) {
      if (action === 'captureOld') captured = { [domain]: [{ id: 'old' }] } as Partial<AppSnapshot>;
      if (action === 'notify') { notified = true; f.event(domain, 2, entity, epoch); }
      if (action === 'finishOld') { finished = true; old.resolve(captured); }
      if (action === 'drain') {
        await flushing;
        f.source.patch.mockResolvedValueOnce({ [domain]: [{ id: 'new' }] } as Partial<AppSnapshot>);
        await f.sync.flush(); drained = true;
      }
      await settle();
      const cached = f.client.getQueryData<AppSnapshot>(queryKeys.snapshot)!;
      // A result captured before revision 2 may apply only if it completed before that notification.
      const oldApplied = finished && order.indexOf('finishOld') < order.indexOf('notify');
      expect(cached[domain]).toEqual(drained ? [{ id: 'new' }] : oldApplied ? [{ id: 'old' }] : []);
      expect(cached.settings).toBe(baseline.settings);
      if (notified && !oldApplied && !drained) expect(cached[domain]).toEqual([]);
    }
    expect(f.source.patch).toHaveBeenCalledTimes(2); f.close(); explored++;
  }
  expect(explored).toBe(16);
});

it('rejects old epoch patches and checkpoints in every restore ordering and converges by active snapshot refetch', async () => {
  expect(restoreOrders).toHaveLength(3);
  let explored = 0;
  for (const domain of ['cards', 'jobs'] as const) for (const entity of ['a', 'b']) for (const order of restoreOrders) {
    const f = makeSync(); f.client.setQueryData(queryKeys.snapshot, baseline);
    const patch = controlled<Partial<AppSnapshot>>(), checkpoint = controlled<ChangeCheckpoint>();
    f.source.patch.mockReturnValueOnce(patch.promise); f.source.checkpoint.mockReturnValueOnce(checkpoint.promise);
    const restored = { ...baseline, settings: { ...baseline.settings, locale: 'restored' } };
    const observer = new QueryObserver(f.client, { queryKey: queryKeys.snapshot, queryFn: async () => restored });
    const stop = observer.subscribe(() => {});
    f.event(domain, 1, entity); const flushing = f.sync.flush(); await settle();
    const recovering = f.sync.recover();
    let restoredEvent = false, drained = false;
    try {
      expect(f.source.patch).toHaveBeenCalledOnce(); expect(f.source.checkpoint).toHaveBeenCalledOnce();
      for (const action of order) {
        switch (action) {
          case 'captureCheckpoint': break; // Captured native epoch one, completion remains independently controlled.
          case 'restore': restoredEvent = true; f.event(domain, 1, entity, 'two'); break; // Epoch change queues restore even when domain revisions repeat.
          case 'finishPatch': patch.resolve({ [domain]: [{ id: 'old-epoch' }] } as Partial<AppSnapshot>); break;
          case 'finishCheckpoint': checkpoint.resolve({ version: 1, epoch: 'one', revision: 1, domains: [{ domain, revision: 1 }] }); break;
          case 'drain': await flushing; await recovering; await f.sync.flush(); drained = true; break;
        }
        await settle();
        const cached = f.client.getQueryData<AppSnapshot>(queryKeys.snapshot)!;
        expect(cached[domain]).toEqual([]);
        expect(cached.settings.locale).toBe(drained ? 'restored' : 'en');
        if (restoredEvent) expect(cached[domain]).not.toEqual([{ id: 'old-epoch' }]);
      }
      f.source.checkpoint.mockResolvedValue({ version: 1, epoch: 'two', revision: 1, domains: [{ domain: 'restore', revision: 1 }] });
      await vi.advanceTimersByTimeAsync(1000); await f.sync.recover(); await f.sync.flush();
      expect(f.client.getQueryData(queryKeys.snapshot)).toEqual(restored); expect(f.errors).toEqual([]); explored++;
    } finally { stop(); f.close(); }
  }
  expect(explored).toBe(12);
});

it('does not consume failed revisions despite lost, duplicate and out-of-order entity events', async () => {
  expect(eventOrders).toHaveLength(8);
  let explored = 0;
  for (const domain of ['subtitles', 'media'] as const) for (const epoch of ['one', 'two']) for (const order of eventOrders) {
    const f = makeSync();
    const key = (id: string) => domain === 'subtitles' ? queryKeys.segments(id) : queryKeys.streams(id);
    const count = { a: 0, b: 0 };
    const stops = (['a', 'b'] as const).map(id => {
      f.client.setQueryData(key(id), ['baseline']);
      return new QueryObserver(f.client, { queryKey: key(id), queryFn: async () => { count[id]++; if (id === 'b' && count[id] === 1) throw Error('offline'); return [`${epoch}:${id}:latest`]; } }).subscribe(() => {});
    });
    // Entity a's revision 1 is missing; checkpoint repairs the entire domain.
    f.source.checkpoint.mockResolvedValue({ version: 1, epoch, revision: 3, domains: [{ domain, revision: 3 }] });
    let failed = false;
    try {
      for (const action of order) {
        if (action === 'latest' || action === 'duplicate') f.event(domain, 3, 'b', epoch);
        if (action === 'older') f.event(domain, 2, 'b', epoch);
        if (action === 'failed') { await f.sync.flush(); failed = true; expect(f.errors).toHaveLength(1); }
        if (action === 'recover') { await f.sync.recover(); await f.sync.flush(); }
        await settle();
        for (const id of ['a', 'b'] as const) expect([['baseline'], [`${epoch}:${id}:latest`]]).toContainEqual(f.client.getQueryData(key(id)));
        if (failed) expect(f.errors).toHaveLength(1);
      }
      for (const id of ['a', 'b'] as const) expect(f.client.getQueryData(key(id))).toEqual([`${epoch}:${id}:latest`]);
      expect(count.b).toBe(2); expect(count.a).toBeGreaterThanOrEqual(1); explored++;
    } finally { stops.forEach(stop => stop()); f.close(); }
  }
  expect(explored).toBe(32);
});

it('does not apply a delayed snapshot patch or checkpoint after disposal', async () => {
  const orders = legalOrders({ dispose: [], patch: ['dispose'], checkpoint: ['dispose'] } as const);
  expect(orders).toHaveLength(2);
  let explored = 0;
  for (const domain of ['cards', 'jobs'] as const) for (const order of orders) {
    const f = makeSync(); f.client.setQueryData(queryKeys.snapshot, baseline);
    const patch = controlled<Partial<AppSnapshot>>(), checkpoint = controlled<ChangeCheckpoint>();
    f.source.patch.mockReturnValueOnce(patch.promise); f.source.checkpoint.mockReturnValueOnce(checkpoint.promise);
    f.event(domain, 1); const flushing = f.sync.flush(); await settle(); const recovering = f.sync.recover();
    for (const action of order) {
      if (action === 'dispose') f.sync.dispose();
      if (action === 'patch') patch.resolve({ [domain]: [{ id: 'late' }] } as Partial<AppSnapshot>);
      if (action === 'checkpoint') checkpoint.resolve({ version: 1, epoch: 'two', revision: 2, domains: [{ domain: 'restore', revision: 2 }] });
      await settle(); expect(f.client.getQueryData(queryKeys.snapshot)).toEqual(baseline);
    }
    await flushing; await recovering; await vi.advanceTimersByTimeAsync(2000);
    expect(f.source.patch).toHaveBeenCalledOnce(); expect(f.source.checkpoint).toHaveBeenCalledOnce(); f.close(); explored++;
  }
  expect(explored).toBe(4);
});
