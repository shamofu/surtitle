// SPDX-License-Identifier: GPL-3.0-or-later
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { queryKeys } from './keys';
import type { DataChange } from './keys';

export function changedKeys(change: DataChange): readonly QueryKey[] {
  switch (change.kind) {
    case 'snapshot':
      return [queryKeys.snapshot];
    case 'downloads':
      return [queryKeys.snapshot, queryKeys.downloads];
    case 'media':
      return [queryKeys.snapshot, queryKeys.media(change.mediaId)];
    case 'subtitles':
      return [
        queryKeys.snapshot,
        queryKeys.segments(change.mediaId),
        queryKeys.candidates(change.mediaId),
        queryKeys.versions(change.mediaId),
        queryKeys.drafts(change.mediaId),
      ];
    case 'drafts':
      return [queryKeys.drafts(change.mediaId)];
    case 'review':
      return [queryKeys.review(change.jobId)];
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
  // cancel older reads, including any started by a heartbeat during the write.
  await Promise.all(filters.map((filter) => client.cancelQueries(filter)));
  await Promise.all(filters.map((filter) => client.invalidateQueries(filter)));
  return result;
}

/** Native app-changed is a five-second heartbeat with no resource identifiers. */
export async function refreshLiveData(client: QueryClient): Promise<void> {
  await client.invalidateQueries({
    predicate: ({ queryKey }) =>
      ['snapshot', 'downloads', 'review'].includes(String(queryKey[0])) ||
      (queryKey[0] === 'media' &&
        ['segments', 'candidates', 'drafts'].includes(String(queryKey[2]))),
  });
}
