// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReviewCue } from '../../../shared/contracts/transcript';
import type { TranscriptReview } from '../../../shared/contracts/transcript';

import './draft-study.css';

export function cueOrigin(cue: ReviewCue, review: TranscriptReview) {
  const sources = review.draft.chunks
    .filter((chunk) =>
      chunk.segments.some(
        (segment) =>
          segment.startMs === cue.startMs &&
          segment.endMs === cue.endMs &&
          segment.text === cue.text,
      ),
    )
    .map((chunk) => chunk.source);
  for (const join of review.draft.edgeGroupJoins || []) {
    if (
      join.joined.startMs !== cue.startMs ||
      join.joined.endMs !== cue.endMs ||
      join.joined.text !== cue.text
    )
      continue;
    sources.push(
      review.draft.chunks.find((chunk) => chunk.ordinal === join.leftOrdinal)
        ?.source,
      review.draft.chunks.find((chunk) => chunk.ordinal === join.rightOrdinal)
        ?.source,
    );
  }
  if (sources.length && sources.every((source) => source === 'manual'))
    return 'manual';
  if (sources.some((source) => source === 'manual')) return 'mixed';
  if (
    sources.length &&
    sources.every(
      (source) => source === 'provider' || source === 'local_reparse',
    )
  )
    return 'ai';
  return 'unknown';
}
