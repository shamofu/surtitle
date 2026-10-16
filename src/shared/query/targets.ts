// SPDX-License-Identifier: GPL-3.0-or-later
import type { QueryKey } from '@tanstack/react-query';
import { queryKeys } from './keys';

/** Resource membership shared by committed mutations and native change events. */
export const queryTargets = {
  downloads: () => [queryKeys.downloads],
  operations: () => [queryKeys.operations],
  media: (id: string) => [queryKeys.media(id)],
  streams: (id: string) => [queryKeys.streams(id)],
  subtitles: (id: string) => [
    queryKeys.segments(id),
    queryKeys.transcriptIssues(id),
    queryKeys.candidates(id),
    queryKeys.versions(id),
    queryKeys.drafts(id),
  ],
  drafts: (id: string) => [queryKeys.drafts(id)],
  review: (id: string) => [queryKeys.review(id)],
} satisfies Record<string, (id: string) => readonly QueryKey[]>;

export function matchesQueryTarget(
  resource: keyof typeof queryTargets,
  entity: string | undefined,
  key: QueryKey,
) {
  return queryTargets[resource](entity ?? '').some(target =>
    target.every((part, index) => (index === 1 && !entity) || key[index] === part),
  );
}
