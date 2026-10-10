// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../shared/native/transport';
import type {
  AiPricePreference,
  AiModelPreference,
  DiscoveredModel,
  AiQuote,
  SavedAiResult,
  TranscriptionPreparation,
} from '../../shared/contracts/ai';

export const aiApi = {
  vertexModels: (location?: string) =>
    call<DiscoveredModel[]>('list_vertex_models', { location }),
  vertexPrice: (modelId: string, location?: string) =>
    call<{
      price: AiPricePreference | null;
      candidates: {
        sku: string;
        description: string;
        direction: string;
        microusdPerMillion: number;
      }[];
      complete: boolean;
      observedAtMs: number;
    }>('lookup_vertex_price', { modelId, location }),
  createQuote: (request: {
    mediaId: string;
    kind: AiQuote['kind'];
    startMs: number;
    endMs: number;
    focusTerm?: string;
    model?: AiModelPreference;
  }) => call<AiQuote>('create_quote', { request }),
  prepareTranscription: (mediaId: string, startMs: number, endMs: number, wholeMedia = false, operationId?: string) =>
    call<TranscriptionPreparation>('prepare_transcription', {
      mediaId,
      startMs,
      endMs,
      wholeMedia,
      operationId,
    }),
  transcriptionPreparations: (mediaId: string) =>
    call<TranscriptionPreparation[]>('list_transcription_preparations', {
      mediaId,
    }),
  createTranscriptionQuote: (
    preparationId: string,
    model?: AiModelPreference,
  ) => call<AiQuote>('create_transcription_quote', { preparationId, model }),
  prepareBoundaryRepair: (
    jobId: string,
    draftDigest: string,
    boundaryId: string,
  ) =>
    call<AiQuote>('prepare_boundary_repair', {
      jobId,
      draftDigest,
      boundaryId,
    }),
  cancelPreparation: (operationId?: string) => call<void>('cancel_preparation', { operationId }),
  approveQuote: (quote: AiQuote) =>
    call<void>('approve_quote', {
      quoteId: quote.id,
      digest: quote.digest || '',
      acknowledgeUnpriced: quote.unpriced === true,
      acknowledgeUnqualified: true,
      retryPolicyVersion: quote.retryPolicy?.version,
    }),
  reapproveQuote: (quote: AiQuote) =>
    call<void>('reapprove_quote', {
      quoteId: quote.id,
      digest: quote.digest || '',
      acknowledgeUnpriced: quote.unpriced === true,
      acknowledgeUnqualified: true,
      retryPolicyVersion: quote.retryPolicy?.version,
    }),
  createRetryQuote: (jobId: string) =>
    call<AiQuote>('create_retry_quote', { jobId }),
  reviewAiJob: (jobId: string) => call<AiQuote>('review_ai_job', { jobId }),
  retryAiApplication: (jobId: string) => call<void>('retry_ai_application', { jobId }),
  savedAiResults: (jobId: string) =>
    call<SavedAiResult[]>('list_saved_ai_results', { jobId }),
  applySavedAiResult: (jobId: string, ordinal: number) =>
    call<void>('apply_saved_ai_result', { jobId, ordinal }),
  pauseAiJob: (jobId: string) => call<void>('pause_ai_job', { jobId }),
  cancelAiJob: (jobId: string) => call<void>('cancel_ai_job', { jobId }),
  resolveUnknownAttempt: (attemptId: string) =>
    call<void>('resolve_unknown_attempt', { attemptId }),
};
