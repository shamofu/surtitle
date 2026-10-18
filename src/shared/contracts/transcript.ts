// SPDX-License-Identifier: GPL-3.0-or-later
export interface ReviewText {
  startMs: number;
  endMs: number;
  text: string;
}

export type ManualTranscriptContent =
  | { kind: 'subtitles'; segments: ReviewText[] }
  | { kind: 'confirmed_no_speech' };

export interface ManualRangeRevision {
  id: string;
  ordinal: number;
  createdAt: string;
  content: ManualTranscriptContent;
}

export interface TranscriptRangeEdit {
  ordinal: number;
  version: number;
  selectedRevisionId: string | null;
  latestRevision: ManualRangeRevision | null;
}

export type TranscriptRangeSource =
  | { kind: 'original' }
  | { kind: 'manual'; revisionId: string };

export interface ReviewChunk {
  ordinal: number;
  coreStartMs: number;
  coreEndMs: number;
  requestStartMs: number;
  requestEndMs: number;
  status: 'pending' | 'received';
  segments: ReviewText[];
  originalSegments?: ReviewText[];
  source?: 'provider' | 'local_reparse' | 'manual' | 'unresolved';
  vadPauseEvidence?: VadPauseEvidence;
  originalSource?: 'provider' | 'local_reparse' | 'unresolved';
}

export interface ReviewCue extends ReviewText {
  id: string;
  status: 'confirmed' | 'provisional';
}

export type BoundaryChoice =
  | { kind: 'left' | 'right' | 'keep_both' }
  | { kind: 'manual'; segments: ReviewText[] };

export interface ReviewConflict {
  id: string;
  atMs: number;
  startMs: number;
  endMs: number;
  leftOrdinal: number;
  rightOrdinal: number;
  leftAlternative: ReviewText[];
  rightAlternative: ReviewText[];
  resolution: BoundaryChoice | null;
}

export interface ReviewEdgeGroupJoin {
  id: string;
  method: string;
  anchorKind: string;
  leftOrdinal: number;
  rightOrdinal: number;
  leftSegmentIndices: number[];
  rightSegmentIndices: number[];
  overlapUnits: number;
  joined: ReviewText;
}

export interface VadPauseEvidence {
  policy: string;
  modelSha256: string;
  runtimeSha256: string;
  sampleRate: number;
  sourceStartSample: number;
  sourceEndSample: number;
  minimumPauseMs: number;
  boundaryGuardMs: number;
  pauses: { start_sample: number; end_sample: number }[];
}

export interface TranscriptDraft {
  id: string;
  mediaId: string;
  sourceSha256: string;
  sourceRevision: string;
  digest: string;
  startMs: number;
  endMs: number;
  canAdopt: boolean;
  segments: ReviewCue[];
  chunks: ReviewChunk[];
  conflicts: ReviewConflict[];
  warnings?: {
    id: string;
    kind: 'speech_in_vad_no_speech_range' | 'speech_in_vad_pause_range';
    ordinal: number;
    startMs: number;
    endMs: number;
    acknowledged: boolean;
  }[];
  edgeGroupJoins?: ReviewEdgeGroupJoin[];
  pendingRanges: { startMs: number; endMs: number }[];
}

export interface TranscriptReview {
  jobId: string;
  mediaId: string;
  draft: TranscriptDraft;
  applied: boolean;
  canApply: boolean;
  blockedReason?: string;
  repairAlternatives: {
    jobId: string;
    boundaryId: string;
    draft: TranscriptDraft;
  }[];
  results?: TranscriptResultReview[];
  rangeEdits?: TranscriptRangeEdit[];
  manualEditingBlockedReason?: string | null;
}

export type TranscriptResultState =
  | 'pending'
  | 'invalid'
  | 'empty'
  | 'received';

export type TranscriptResultReason =
  | 'not_received'
  | 'evidence_unavailable'
  | 'evidence_incomplete'
  | 'candidate_missing'
  | 'candidate_count'
  | 'incomplete_response'
  | 'content_missing'
  | 'invalid_structure'
  | 'invalid_word_timing'
  | 'reversed_time'
  | 'time_outside_audio'
  | 'unaligned_words'
  | 'usage_unknown'
  | 'settlement_pending';

export interface TranscriptResultReview {
  ordinal: number;
  state: TranscriptResultState;
  reason: TranscriptResultReason | null;
  attemptState?: string | null;
  evidenceSha256?: string | null;
  evidence?: {
    attemptId: string;
    jobId: string;
    ordinal: number;
    inputSha256: string;
    requestSha256: string;
    taskSha256: string;
    modelId: string;
    parserRevision: string;
    complete: boolean;
    response?: unknown;
    state: TranscriptResultState;
    reason: TranscriptResultReason | null;
  } | null;
  reparses: {
    id: string;
    evidenceSha256: string;
    parserRevision: string;
    state: TranscriptResultState;
    reason: TranscriptResultReason | null;
    output?: { kind: 'transcript'; cues: ReviewText[] } | null;
    selected: boolean;
  }[];
}
