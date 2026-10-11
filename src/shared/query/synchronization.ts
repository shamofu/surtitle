// SPDX-License-Identifier: GPL-3.0-or-later
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { AppSnapshot } from '../contracts/snapshot';
import { isChangeCheckpoint, isRecord, type ChangeCheckpoint, type ChangeDomain, type DataChangeEvent, type SnapshotDomain } from '../contracts/synchronization';
import { call } from '../native/transport';
import { subscribeNative } from '../native/events';
import { subscribeRecovery } from '../native/recovery';
import { queryKeys } from './keys';

const snapshotDomains: readonly SnapshotDomain[] = ['media', 'cards', 'settings', 'tools', 'jobs', 'budget'];
interface Source {
  checkpoint: () => Promise<ChangeCheckpoint>;
  patch: (domains: SnapshotDomain[]) => Promise<Partial<AppSnapshot>>;
  listen: (receive: (event: DataChangeEvent) => void, ready: () => void, error: (error: unknown) => void) => () => void;
}
export const synchronizationApi = {
  async checkpoint() {
    const result = await call('get_change_checkpoint');
    if (!isChangeCheckpoint(result)) throw new Error('Invalid native change checkpoint');
    return result;
  },
  async patch(domains: SnapshotDomain[]) {
    const result = await call('get_snapshot_patch', { domains });
    if (!isRecord(result) || !domains.every(domain => Object.hasOwn(result, domain)) || Object.entries(result).some(([key, value]) =>
      !domains.includes(key as SnapshotDomain) || (key === 'settings' || key === 'budget' ? !isRecord(value) : !Array.isArray(value)))) throw new Error('Invalid native snapshot patch');
    return result as Partial<AppSnapshot>;
  },
};

/** Domain/entity matching is independent of playback and unrelated active queries. */
export function changedDomainKey(domain: ChangeDomain, entity: string | undefined, key: QueryKey) {
  if (domain === 'restore') return true;
  if (domain === 'downloads' || domain === 'operations') return key[0] === domain;
  if (domain === 'review' || domain === 'jobs') return key[0] === 'review' && (!entity || key[1] === entity);
  if (domain === 'subtitles') return key[0] === 'media' && (!entity || key[1] === entity) && ['segments', 'candidates', 'transcript-issues', 'versions', 'drafts'].includes(String(key[2]));
  if (domain === 'drafts') return key[0] === 'media' && (!entity || key[1] === entity) && key[2] === 'drafts';
  if (domain === 'media') return key[0] === 'media' && (!entity || key[1] === entity) && key[2] === 'streams';
  return false;
}

export function createDataSynchronizer(client: QueryClient, source: Source, report: (error: unknown) => void) {
  let epoch: string | undefined, revision = 0, disposed = false;
  let lastError = '';
  function fail(error: unknown) { const message = String(error); if (message !== lastError) { lastError = message; report(error); } }
  const versions = new Map<ChangeDomain, number>();
  const entityVersions = new Map<string, number>();
  let gapAfter: number | undefined, gapThrough = 0, epochGeneration = 0, failures = 0;
  const pending = new Map<string, { domain: ChangeDomain; entity?: string }>();
  let timer: ReturnType<typeof setTimeout> | undefined, recoveryTimer: ReturnType<typeof setTimeout> | undefined, recovery: Promise<void> | undefined, flushing = false;
  function retryRecovery() {
    if (!disposed && !recoveryTimer) recoveryTimer = setTimeout(() => { recoveryTimer = undefined; void recover(); }, 1000);
  }
  function queue(domain: ChangeDomain, entity?: string) {
    pending.set(`${domain}:${entity ?? '*'}`, { domain, entity });
    if (!timer && !flushing) timer = setTimeout(() => { timer = undefined; void flush(); }, 80);
  }
  async function flush() {
    if (disposed || flushing || !pending.size) return;
    flushing = true;
    const work = [...pending.values()]; pending.clear();
    const before = new Map(versions);
    const beforeEpoch = epochGeneration;
    try {
      if (work.some(item => item.domain === 'restore')) {
        await client.cancelQueries();
        await client.invalidateQueries({}, { throwOnError: true });
      } else {
        const domains = snapshotDomains.filter(domain => work.some(item => item.domain === domain));
        if (domains.length) {
          if (!client.getQueryData(queryKeys.snapshot)) {
            await client.cancelQueries({ queryKey: queryKeys.snapshot });
            await client.invalidateQueries({ queryKey: queryKeys.snapshot }, { throwOnError: true });
          }
          else {
            await client.cancelQueries({ queryKey: queryKeys.snapshot });
            const patch = await source.patch([...domains]);
            if (!disposed && beforeEpoch === epochGeneration) client.setQueryData<AppSnapshot>(queryKeys.snapshot, current => {
              if (!current) return current;
              const next = { ...current };
              for (const domain of domains) {
                if (versions.get(domain) !== before.get(domain)) continue;
                if (patch[domain] !== undefined) Object.assign(next, { [domain]: patch[domain] });
              }
              return next;
            });
          }
        }
        if (!disposed) {
          const filters = { predicate: (query: { queryKey: QueryKey }) => work.some(item => changedDomainKey(item.domain, item.entity, query.queryKey)) };
          // Completion time does not establish which native revision a read saw.
          // Cancel even an initial read (no cached data) before refetching, and
          // surface failures so the revision remains queued for recovery.
          await client.cancelQueries(filters);
          await client.invalidateQueries(filters, { throwOnError: true });
        }
      }
      failures = 0;
    } catch (error) {
      if (!disposed) {
        fail(error);
        // A failed fetch cannot consume a revision; recovery will retry these domains.
        failures++;
        work.forEach(item => { const key = `${item.domain}:${item.entity ?? '*'}`; if (!pending.has(key)) pending.set(key, item); });
      }
    } finally {
      flushing = false;
      // Reconnect retries back off; later events stay queued until the connection recovers.
      if (pending.size && !disposed && !timer) timer = setTimeout(() => { timer = undefined; void flush(); }, failures ? Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)) : 80);
    }
  }
  function receive(event: DataChangeEvent) {
    if (disposed) return;
    if (epoch && epoch !== event.epoch) { epochGeneration++; versions.clear(); entityVersions.clear(); revision = 0; gapAfter = undefined; queue('restore'); }
    const gap = event.revision > revision + 1;
    if (gap) { gapAfter = Math.min(gapAfter ?? revision, revision); gapThrough = event.revision; }
    epoch = event.epoch;
    const key = `${event.domain}:${event.entityId ?? '*'}`;
    if (event.revision <= (entityVersions.get(key) ?? 0)) return;
    if (event.domain === 'restore') epochGeneration++;
    entityVersions.set(key, event.revision);
    versions.set(event.domain, Math.max(event.revision, versions.get(event.domain) ?? 0));
    revision = Math.max(revision, event.revision);
    queue(event.domain, event.entityId);
    if (gap) void recover();
  }
  function recover() {
    if (disposed) return Promise.resolve();
    if (recovery) return recovery;
    const beforeEpoch = epochGeneration;
    recovery = source.checkpoint().then(checkpoint => {
      if (disposed) return;
      if (beforeEpoch !== epochGeneration && epoch !== checkpoint.epoch) { retryRecovery(); return; }
      if (epoch && epoch !== checkpoint.epoch) { epochGeneration++; versions.clear(); entityVersions.clear(); revision = 0; gapAfter = undefined; queue('restore'); }
      epoch = checkpoint.epoch;
      for (const entry of checkpoint.domains) {
        if (entry.revision > (versions.get(entry.domain) ?? 0) || (gapAfter !== undefined && entry.revision > gapAfter)) {
          if (entry.domain === 'restore') epochGeneration++;
          versions.set(entry.domain, Math.max(entry.revision, versions.get(entry.domain) ?? 0)); queue(entry.domain);
        }
      }
      if (checkpoint.revision >= gapThrough) gapAfter = undefined;
      else if (gapAfter !== undefined) retryRecovery();
      revision = Math.max(revision, checkpoint.revision);
      if (pending.size && !timer) timer = setTimeout(() => { timer = undefined; void flush(); }, 0);
      lastError = '';
    }).catch(error => { if (!disposed) fail(error); }).finally(() => { recovery = undefined; });
    return recovery;
  }
  const stop = source.listen(receive, () => { void recover(); }, fail);
  return { receive, recover, flush, dispose() { disposed = true; stop(); if (timer) clearTimeout(timer); if (recoveryTimer) clearTimeout(recoveryTimer); } };
}

export function startDataSynchronization(client: QueryClient, report: (error: unknown) => void) {
  const sync = createDataSynchronizer(client, { ...synchronizationApi,
    listen: (receive, ready, error) => subscribeNative('data-changed', event => receive(event.payload), error, ready),
  }, report);
  const stopRecovery = subscribeRecovery(() => { void sync.recover(); });
  return () => { stopRecovery(); sync.dispose(); };
}
