// SPDX-License-Identifier: GPL-3.0-or-later
export type AiPurpose =
  | 'transcription'
  | 'vocabulary'
  | 'explanation'
  | 'translation';

export interface AiPricePreference {
  id: string;
  source: string;
  observedAtMs: number;
  inputMicrousdPerMillion: number;
  outputMicrousdPerMillion: number;
}

export interface AiModelPreference {
  modelId: string;
  transcriptionMode: 'transcribe' | 'subtitles';
  maxOutputTokens: number;
  thinkingLevel?: string | null;
  thinkingBudget?: number | null;
  price?: AiPricePreference | null;
}

export interface DiscoveredModel {
  id: string;
  displayName: string;
  launchStage?: string;
  version?: string;
}

export interface BudgetSummary {
  spentUsd: number;
  reservedUsd: number;
  limitUsd: number;
  unknownAttempts?: {
    id: string;
    jobId: string;
    ordinal: number;
    heldUsd: number | null;
    createdAt: string;
  }[];
  unpricedAttempts?: number;
  monetaryTotalsComplete?: boolean;
}

export interface JobSummary {
  id: string;
  mediaId?: string;
  kind: string;
  status:
    | 'queued'
    | 'running'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'unknown'
    | 'cancelled';
  progress: number;
  message?: string;
  createdAt: string;
  pendingResults?: number;
  transcriptReview?: boolean;
  hasTranscriptResult?: boolean;
  needsAttention?: boolean;
  resultState?: 'none' | 'ready' | 'applied' | 'applied_with_warnings';
  issue?: { code: string; phase: string; occurredAt: string; ordinal?: number; httpStatus?: number; nextAction: string };
}

export interface TranscriptionPreparation {
  id: string;
  mediaId: string;
  startMs: number;
  endMs: number;
  coreDurationMs: number;
  sendDurationMs: number;
  chunkCount: number;
  jobId?: string;
  repairParentJobId?: string;
  repairBoundaryId?: string;
  wholeMedia?: boolean;
}

export interface SavedAiResult {
  jobId: string;
  ordinal: number;
  applied: boolean;
  canApply: boolean;
  blockedReason?: string;
  translations: {
    source: string;
    translation: string;
    startMs: number;
    endMs: number;
  }[];
}

export interface AiQuote {
  id: string;
  mediaId: string;
  kind: 'transcribe' | 'translate' | 'vocabulary';
  startMs: number;
  endMs: number;
  model: string;
  estimatedUsd: number | null;
  maximumUsd: number | null;
  inputTokens: number;
  maxOutputTokens: number;
  expiresAt: string;
  warnings: string[];
  canApprove: boolean;
  blockedReason?: string;
  isRetry?: boolean;
  focusTerm?: string;
  digest?: string;
  requestCount?: number;
  sendDurationMs?: number;
  totalOutputTokens?: number;
  pricingSource?: string | null;
  unpriced?: boolean;
  location?: string;
  applyPolicy?: 'manual' | 'auto';
}
