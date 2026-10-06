// SPDX-License-Identifier: GPL-3.0-or-later
export const queryKeys = {
  snapshot: ['snapshot'] as const,
  downloads: ['downloads'] as const,
  media: (id: string) => ['media', id] as const,
  segments: (id: string) => ['media', id, 'segments'] as const,
  transcriptIssues: (id: string) => ['media', id, 'transcript-issues'] as const,
  candidates: (id: string) => ['media', id, 'candidates'] as const,
  streams: (id: string) => ['media', id, 'streams'] as const,
  versions: (id: string) => ['media', id, 'versions'] as const,
  drafts: (id: string) => ['media', id, 'drafts'] as const,
  review: (id: string) => ['review', id] as const,
};
export type DataChange =
  | { kind: 'snapshot' | 'downloads' | 'restore' }
  | { kind: 'media' | 'subtitles' | 'drafts'; mediaId: string }
  | { kind: 'review'; jobId: string };
