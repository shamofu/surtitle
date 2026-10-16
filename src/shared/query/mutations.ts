// SPDX-License-Identifier: GPL-3.0-or-later
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { queryKeys } from './keys';
import type { DataChange } from './keys';
import { queryTargets } from './targets';

export function changedKeys(change: DataChange): readonly QueryKey[] {
  switch (change.kind) {
    case 'snapshot':
      return [queryKeys.snapshot];
    case 'downloads':
      return [queryKeys.snapshot, ...queryTargets.downloads()];
    case 'media':
      return [queryKeys.snapshot, ...queryTargets.media(change.mediaId)];
    case 'subtitles':
      return [queryKeys.snapshot, ...queryTargets.subtitles(change.mediaId)];
    case 'drafts':
      return queryTargets.drafts(change.mediaId);
    case 'review':
      return queryTargets.review(change.jobId);
    case 'restore':
      return [];
  }
}

/** Only committed writes refresh data. Reads and player commands bypass this boundary. */
export async function mutateData<T>(
  client: QueryClient,
  action: () => Promise<T>,
  change: DataChange,
): Promise<T> {
  const filters =
    change.kind === 'restore'
      ? [{}]
      : changedKeys(change).map((queryKey) => ({ queryKey }));
  const result = await action();
  // Keep pending reads alive when a write fails. After a successful commit,
  // cancel older reads, including any started by a resource event during the write.
  await Promise.all(filters.map((filter) => client.cancelQueries(filter)));
  await Promise.all(filters.map((filter) => client.invalidateQueries(filter)));
  return result;
}
