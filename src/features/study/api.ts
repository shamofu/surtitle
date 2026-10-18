// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../shared/native/transport';
import type { SubtitleSegment } from '../../shared/contracts/media';
import type { ManualTranscriptContent, TranscriptRangeSource, BoundaryChoice } from '../../shared/contracts/transcript';

export const studyApi = {
  editSegment: (segment: SubtitleSegment) =>
    call('edit_segment', { segment }),
  segments: (mediaId: string) =>
    call('list_segments', { mediaId }),
  transcriptIssues: (mediaId: string) =>
    call('list_transcript_issues', { mediaId }),
  candidates: (mediaId: string) =>
    call('list_vocabulary_candidates', { mediaId }),
  transcriptReview: (jobId: string) =>
    call('get_transcript_review', { jobId }),
  saveManualTranscriptRange: (
    jobId: string,
    draftDigest: string,
    ordinal: number,
    expectedRangeVersion: number,
    content: ManualTranscriptContent,
  ) =>
    call('save_manual_transcript_range', {
      jobId,
      draftDigest,
      ordinal,
      expectedRangeVersion,
      content,
    }),
  selectTranscriptRangeSource: (
    jobId: string,
    draftDigest: string,
    ordinal: number,
    expectedRangeVersion: number,
    source: TranscriptRangeSource,
  ) =>
    call('select_transcript_range_source', {
      jobId,
      draftDigest,
      ordinal,
      expectedRangeVersion,
      source,
    }),
  resolveTranscriptBoundary: (
    jobId: string,
    draftDigest: string,
    boundaryId: string,
    choice: BoundaryChoice,
  ) =>
    call('resolve_transcript_boundary', {
      jobId,
      draftDigest,
      boundaryId,
      choice,
    }),
  transcriptResultDetail: (jobId: string, ordinal: number) =>
    call('get_transcript_result_detail', {
      jobId,
      ordinal,
    }),
  reparseTranscriptEvidence: (
    jobId: string,
    ordinal: number,
    evidenceSha256: string,
  ) =>
    call('reparse_transcript_evidence', {
      jobId,
      ordinal,
      evidenceSha256,
    }),
  selectTranscriptReparse: (
    jobId: string,
    ordinal: number,
    candidateId: string,
    draftDigest: string,
  ) =>
    call('select_transcript_reparse', {
      jobId,
      ordinal,
      candidateId,
      draftDigest,
    }),
  acknowledgeTranscriptWarning: (
    jobId: string,
    draftDigest: string,
    warningId: string,
  ) =>
    call('acknowledge_transcript_warning', {
      jobId,
      draftDigest,
      warningId,
    }),
  applyTranscriptReview: (jobId: string, draftDigest: string) =>
    call('apply_transcript_review', { jobId, draftDigest }),
};
