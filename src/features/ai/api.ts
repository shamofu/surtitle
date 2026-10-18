// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../shared/native/transport';
import type { AiModelPreference, AiQuote } from '../../shared/contracts/ai';

export const aiApi = {
  runtime: (jobId: string) => call('get_ai_runtime', { jobId }),
  vertexModels: (location?: string) =>
    call('list_vertex_models', { location }),
  vertexPrice: (modelId: string, location?: string) =>
    call('lookup_vertex_price', { modelId, location }),
  createQuote: (request: {
    mediaId: string;
    kind: AiQuote['kind'];
    startMs: number;
    endMs: number;
    focusTerm?: string;
    model?: AiModelPreference;
  }) => call('create_quote', { request }),
  prepareTranscription: (mediaId: string, startMs: number, endMs: number, wholeMedia = false, operationId?: string) =>
    call('prepare_transcription', {
      mediaId,
      startMs,
      endMs,
      wholeMedia,
      operationId,
    }),
  transcriptionPreparations: (mediaId: string) =>
    call('list_transcription_preparations', {
      mediaId,
    }),
  createTranscriptionQuote: (
    preparationId: string,
    model?: AiModelPreference,
  ) => call('create_transcription_quote', { preparationId, model }),
  prepareBoundaryRepair: (
    jobId: string,
    draftDigest: string,
    boundaryId: string,
  ) =>
    call('prepare_boundary_repair', {
      jobId,
      draftDigest,
      boundaryId,
    }),
  cancelPreparation: (operationId?: string) => call('cancel_preparation', { operationId }),
  approveQuote: (quote: AiQuote) =>
    call('approve_quote', {
      quoteId: quote.id,
      digest: quote.digest || '',
      acknowledgeUnpriced: quote.unpriced === true || quote.maximumUsd == null,
      acknowledgeUnqualified: true,
      retryPolicyVersion: quote.retryPolicy?.version,
    }),
  reapproveQuote: (quote: AiQuote) =>
    call('reapprove_quote', {
      quoteId: quote.id,
      digest: quote.digest || '',
      acknowledgeUnpriced: quote.unpriced === true || quote.maximumUsd == null,
      acknowledgeUnqualified: true,
      retryPolicyVersion: quote.retryPolicy?.version,
    }),
  createRetryQuote: (jobId: string) =>
    call('create_retry_quote', { jobId }),
  reviewAiJob: (jobId: string) => call('review_ai_job', { jobId }),
  retryAiApplication: (jobId: string) => call('retry_ai_application', { jobId }),
  savedAiResults: (jobId: string) =>
    call('list_saved_ai_results', { jobId }),
  applySavedAiResult: (jobId: string, ordinal: number) =>
    call('apply_saved_ai_result', { jobId, ordinal }),
  pauseAiJob: (jobId: string) => call('pause_ai_job', { jobId }),
  cancelAiJob: (jobId: string) => call('cancel_ai_job', { jobId }),
  resolveUnknownAttempt: (attemptId: string) =>
    call('resolve_unknown_attempt', { attemptId }),
};
