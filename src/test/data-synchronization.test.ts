// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createDataSynchronizer, changedDomainKey } from '../shared/query/synchronization';
import { queryKeys } from '../shared/query/keys';
import type { AppSnapshot } from '../shared/contracts/snapshot';
import type { ChangeCheckpoint, DataChangeEvent } from '../shared/contracts/synchronization';

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); });
const baseline = { media: [], cards: [], jobs: [], tools: [], settings: { locale: 'en' }, budget: {} } as unknown as AppSnapshot;
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.snapshot, baseline);
  const source = { checkpoint: vi.fn<() => Promise<ChangeCheckpoint>>().mockResolvedValue({ version: 1, epoch: 'one', revision: 0, domains: [] }),
    patch: vi.fn<(domains: string[]) => Promise<Partial<AppSnapshot>>>().mockImplementation(async domains => Object.fromEntries(domains.map(domain => [domain, baseline[domain as keyof AppSnapshot]]))),
    listen: vi.fn(() => vi.fn()) };
  const report = vi.fn();
  const sync = createDataSynchronizer(client, source, report);
  disposers.push(() => { sync.dispose(); client.clear(); });
  const event = (domain: DataChangeEvent['domain'], revision: number, entityId?: string, epoch = 'one') => sync.receive({ version: 1, epoch, revision, domain, entityId });
  return { client, source, sync, report, event };
}

it('updates only a notified snapshot domain and preserves unrelated object identity', async () => {
  const { client, source, sync, event } = setup();
  const old = client.getQueryData<AppSnapshot>(queryKeys.snapshot)!;
  source.patch.mockResolvedValue({ jobs: [{ id: 'job', kind: 'translate', status: 'completed', progress: 1, createdAt: '' }] });
  event('jobs', 1, 'job');
  await sync.flush();
  expect(source.patch).toHaveBeenCalledExactlyOnceWith(['jobs']);
  const next = client.getQueryData<AppSnapshot>(queryKeys.snapshot)!;
  expect(next.jobs).toHaveLength(1);
  expect(next.settings).toBe(old.settings);
  expect(next.cards).toBe(old.cards);
  expect(next.media).toBe(old.media);
});

it('coalesces progress bursts and never invalidates data domains for unrelated activity', async () => {
  const { client, source, sync, event } = setup();
  [queryKeys.downloads, queryKeys.operations, queryKeys.segments('a'), queryKeys.streams('a')].forEach(key => client.setQueryData(key, []));
  for (let revision = 1; revision <= 20; revision++) event('operations', revision);
  await sync.flush();
  expect(client.getQueryState(queryKeys.operations)?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.downloads)?.isInvalidated).toBe(false);
  expect(client.getQueryState(queryKeys.snapshot)?.isInvalidated).toBe(false);
  expect(client.getQueryState(queryKeys.segments('a'))?.isInvalidated).toBe(false);
  expect(source.patch).not.toHaveBeenCalled();
  expect(source.checkpoint).not.toHaveBeenCalled();
});

it('targets only the changed media while retaining static unrelated inspection data', async () => {
  const { client, sync, event } = setup();
  const keys = [queryKeys.segments('a'), queryKeys.candidates('a'), queryKeys.versions('a'), queryKeys.segments('b'), queryKeys.streams('a'), queryKeys.review('job')];
  keys.forEach(key => client.setQueryData(key, []));
  event('subtitles', 1, 'a');
  await sync.flush();
  expect(keys.map(key => client.getQueryState(key)?.isInvalidated)).toEqual([true, true, true, false, false, false]);
});

it('recovers a dropped entity event from the revision checkpoint even when a later event has the same domain', async () => {
  const { client, source, sync, event } = setup();
  [queryKeys.segments('a'), queryKeys.segments('b')].forEach(key => client.setQueryData(key, []));
  source.checkpoint.mockResolvedValue({ version: 1, epoch: 'one', revision: 2, domains: [{ domain: 'subtitles', revision: 2 }] });
  event('subtitles', 2, 'b'); // a at revision 1 was lost.
  await sync.recover();
  await sync.flush();
  expect(client.getQueryState(queryKeys.segments('a'))?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.segments('b'))?.isInvalidated).toBe(true);
});

it('performs no data reads for unchanged recovery checkpoints', async () => {
  const { source, sync } = setup();
  await sync.recover(); await sync.recover(); await sync.flush();
  expect(source.checkpoint).toHaveBeenCalledTimes(2);
  expect(source.patch).not.toHaveBeenCalled();
});

it('rejects a stale patch when a newer revision arrives in flight and retains failed work for retry', async () => {
  const { client, source, sync, event, report } = setup();
  let finish!: (value: Partial<AppSnapshot>) => void;
  source.patch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  event('settings', 1);
  const first = sync.flush();
  await vi.waitFor(() => expect(source.patch).toHaveBeenCalledOnce());
  event('settings', 2);
  finish({ settings: { ...baseline.settings, locale: 'ja' } });
  await first;
  expect(client.getQueryData<AppSnapshot>(queryKeys.snapshot)?.settings.locale).toBe('en');
  source.patch.mockRejectedValueOnce(new Error('Offline'));
  await sync.flush();
  expect(report).toHaveBeenCalledOnce();
  source.patch.mockResolvedValueOnce({ settings: { ...baseline.settings, locale: 'ja' } });
  await sync.flush();
  expect(client.getQueryData<AppSnapshot>(queryKeys.snapshot)?.settings.locale).toBe('ja');
});

it('recovers all cached state only after an epoch change or restore event', async () => {
  const { client, source, sync } = setup();
  client.setQueryData(queryKeys.streams('old-media'), []);
  await sync.recover();
  source.checkpoint.mockResolvedValue({ version: 1, epoch: 'two', revision: 0, domains: [] });
  await sync.recover(); await sync.flush();
  expect(client.getQueryState(queryKeys.snapshot)?.isInvalidated).toBe(true);
  expect(client.getQueryState(queryKeys.streams('old-media'))?.isInvalidated).toBe(true);
});

it('does not treat playback keys as a mutable data domain', () => {
  expect(changedDomainKey('jobs', undefined, ['player-state'])).toBe(false);
  expect(changedDomainKey('operations', undefined, queryKeys.snapshot)).toBe(false);
});

it('discards an old process patch when reconnect starts a new revision epoch', async () => {
  const { client, source, sync, event } = setup();
  let finish!: (value: Partial<AppSnapshot>) => void;
  source.patch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  event('settings', 1);
  const oldRead = sync.flush();
  await vi.waitFor(() => expect(source.patch).toHaveBeenCalledOnce());
  event('cards', 1, 'new', 'two');
  finish({ settings: { ...baseline.settings, locale: 'ja' } });
  await oldRead;
  expect(client.getQueryData<AppSnapshot>(queryKeys.snapshot)?.settings.locale).toBe('en');
  await sync.flush();
  expect(client.getQueryState(queryKeys.snapshot)?.isInvalidated).toBe(true);
});

it('retries a checkpoint that predates a newly observed revision gap', async () => {
  vi.useFakeTimers();
  const { client, source, sync, event } = setup();
  client.setQueryData(queryKeys.segments('lost'), []);
  let finish!: (value: ChangeCheckpoint) => void;
  source.checkpoint.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const recovery = sync.recover();
  event('cards', 2);
  finish({ version: 1, epoch: 'one', revision: 0, domains: [] });
  await recovery;
  source.checkpoint.mockResolvedValue({ version: 1, epoch: 'one', revision: 2, domains: [{ domain: 'subtitles', revision: 1 }, { domain: 'cards', revision: 2 }] });
  await vi.advanceTimersByTimeAsync(1200);
  expect(source.checkpoint).toHaveBeenCalledTimes(2);
  expect(client.getQueryState(queryKeys.segments('lost'))?.isInvalidated).toBe(true);
});
