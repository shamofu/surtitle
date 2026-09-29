// SPDX-License-Identifier: GPL-3.0-or-later
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { AppSnapshot } from '../contracts/snapshot';
import { nativeAvailable } from '../native/transport';
import { snapshotApi } from './snapshot-api';
import { queryKeys } from './keys';

export const snapshotOptions = () =>
  queryOptions({
    queryKey: queryKeys.snapshot,
    queryFn: snapshotApi.snapshot,
    enabled: nativeAvailable(),
  });

/** All domain selectors share the same native request and structurally shared cache. */
export function useSnapshotSelector<T>(select: (snapshot: AppSnapshot) => T) {
  return useQuery({ ...snapshotOptions(), select });
}
const settings = (snapshot: AppSnapshot) => snapshot.settings;
const media = (snapshot: AppSnapshot) => snapshot.media;
const cards = (snapshot: AppSnapshot) => snapshot.cards;
export const useSettings = () => useSnapshotSelector(settings);
export const useMedia = () => useSnapshotSelector(media);
export const useCards = () => useSnapshotSelector(cards);
