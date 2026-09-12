// SPDX-License-Identifier: GPL-3.0-or-later
import { invoke, isTauri } from '@tauri-apps/api/core';

export interface Media {
  id: string;
  title: string;
  path: string;
  sourceUrl?: string;
  kind: 'video' | 'audio';
  durationMs: number;
  learningLanguage: string;
  explanationLanguage: string;
  createdAt: string;
  lastPositionMs: number;
  segmentCount: number;
  cardCount: number;
  status: 'ready' | 'importing' | 'missing' | 'error';
  error?: string;
  audioStreamIndex?: number | null;
  subtitleStreamIndex?: number | null;
}
export interface SubtitleSegment {
  id: string;
  mediaId: string;
  startMs: number;
  endMs: number;
  text: string;
  translation?: string;
  status?: 'confirmed' | 'provisional' | 'review';
}
export interface StudyCard {
  sourceCues?: SubtitleSegment[];
  id: string;
  mediaId: string;
  segmentId: string;
  term: string;
  meaning: string;
  example: string;
  language: string;
  dueAt: string;
  createdAt: string;
  reviewCount: number;
  audioPath?: string;
  audioClipRange?: { startMs: number; endMs: number } | null;
  audioStreamIndex?: number | null;
  sourceTitle?: string;
  sourceUrl?: string | null;
  suspended: boolean;
  explanation?: string;
  translation?: string;
}
export type ToolId = 'ffmpeg' | 'yt-dlp' | 'deno' | 'vad';
export interface ToolStatus {
  id: ToolId;
  name: string;
  provider: 'managed' | 'external';
  status: 'ready' | 'missing' | 'installing' | 'error';
  version?: string;
  path?: string;
  error?: string;
  canRollback: boolean;
  updateAvailable?: boolean;
  latestVersion?: string;
}
export interface ExternalToolCandidate {
  toolId: ToolId;
  path: string;
  version?: string | null;
  selectable: boolean;
  verification: 'unverified';
  reason?: string | null;
}
export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  locale: 'ja' | 'en';
  learningLanguage: string;
  explanationLanguage: string;
  dailyBudgetUsd: number;
  vertexProject: string;
  vertexLocation: string;
  credentialConfigured: boolean;
  retention: number;
  sentencePause?: boolean;
  replayContextMs?: number;
  proficiency?: string;
  ytDlpChannel?: 'nightly' | 'stable';
  aiModels?: Partial<Record<AiPurpose, AiModelPreference>>;
}
export type AiPurpose = 'transcription' | 'vocabulary' | 'explanation' | 'translation';
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
export interface DiscoveredModel { id: string; displayName: string; launchStage?: string; version?: string }
export interface BudgetSummary {
  spentUsd: number;
  reservedUsd: number;
  limitUsd: number;
  unknownAttempts?: { id: string; jobId: string; ordinal: number; heldUsd: number | null; createdAt: string }[];
  unpricedAttempts?: number;
  monetaryTotalsComplete?: boolean;
}
export interface JobSummary {
  id: string;
  mediaId?: string;
  kind: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'unknown' | 'cancelled';
  progress: number;
  message?: string;
  createdAt: string;
  pendingResults?: number;
  transcriptReview?: boolean;
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
}
export interface ReviewText { startMs: number; endMs: number; text: string }
export type ManualTranscriptContent = { kind: 'subtitles'; segments: ReviewText[] } | { kind: 'confirmed_no_speech' };
export interface ManualRangeRevision { id: string; ordinal: number; createdAt: string; content: ManualTranscriptContent }
export interface TranscriptRangeEdit { ordinal: number; version: number; selectedRevisionId: string | null; latestRevision: ManualRangeRevision | null }
export type TranscriptRangeSource = { kind: 'original' } | { kind: 'manual'; revisionId: string };
export interface ReviewChunk {
  ordinal: number; coreStartMs: number; coreEndMs: number; requestStartMs: number; requestEndMs: number;
  status: 'pending' | 'received'; segments: ReviewText[]; originalSegments?: ReviewText[];
  source?: 'provider' | 'local_reparse' | 'manual' | 'unresolved'; vadPauseEvidence?: VadPauseEvidence;
  originalSource?: 'provider' | 'local_reparse' | 'unresolved';
}
export interface ReviewCue extends ReviewText { id: string; status: 'confirmed' | 'provisional' }
export type BoundaryChoice = { kind: 'left' | 'right' | 'keep_both' } | { kind: 'manual'; segments: ReviewText[] };
export interface ReviewConflict {
  id: string; atMs: number; startMs: number; endMs: number;
  leftOrdinal: number; rightOrdinal: number;
  leftAlternative: ReviewText[]; rightAlternative: ReviewText[];
  resolution: BoundaryChoice | null;
}
export interface ReviewEdgeGroupJoin {
  id: string; method: string; anchorKind: string;
  leftOrdinal: number; rightOrdinal: number;
  leftSegmentIndices: number[]; rightSegmentIndices: number[];
  overlapUnits: number; joined: ReviewText;
}
export interface VadPauseEvidence {
  policy: string; modelSha256: string; runtimeSha256: string; sampleRate: number;
  sourceStartSample: number; sourceEndSample: number; minimumPauseMs: number; boundaryGuardMs: number;
  pauses: { start_sample: number; end_sample: number }[];
}
export interface TranscriptDraft {
  id: string; mediaId: string; sourceSha256: string; sourceRevision: string; digest: string;
  startMs: number; endMs: number; canAdopt: boolean;
  segments: ReviewCue[];
  chunks: ReviewChunk[];
  conflicts: ReviewConflict[];
  warnings?: { id: string; kind: 'speech_in_vad_no_speech_range' | 'speech_in_vad_pause_range'; ordinal: number; startMs: number; endMs: number; acknowledged: boolean }[];
  edgeGroupJoins?: ReviewEdgeGroupJoin[];
  pendingRanges: { startMs: number; endMs: number }[];
}
export interface TranscriptReview {
  jobId: string; mediaId: string; draft: TranscriptDraft; applied: boolean; canApply: boolean; blockedReason?: string;
  repairAlternatives: { jobId: string; boundaryId: string; draft: TranscriptDraft }[];
  results?: TranscriptResultReview[];
  rangeEdits?: TranscriptRangeEdit[];
  manualEditingBlockedReason?: string | null;
}
export type TranscriptResultState = 'pending' | 'invalid' | 'empty' | 'received';
export type TranscriptResultReason = 'not_received' | 'evidence_unavailable' | 'evidence_incomplete' | 'candidate_missing' | 'candidate_count' | 'incomplete_response' | 'content_missing' | 'invalid_structure' | 'invalid_word_timing' | 'reversed_time' | 'time_outside_audio' | 'unaligned_words' | 'usage_unknown' | 'settlement_pending';
export interface TranscriptResultReview {
  ordinal: number; state: TranscriptResultState; reason: TranscriptResultReason | null; attemptState?: string | null;
  evidenceSha256?: string | null;
  evidence?: { attemptId: string; jobId: string; ordinal: number; inputSha256: string; requestSha256: string; taskSha256: string; modelId: string; parserRevision: string; complete: boolean; response?: unknown; state: TranscriptResultState; reason: TranscriptResultReason | null } | null;
  reparses: { id: string; evidenceSha256: string; parserRevision: string; state: TranscriptResultState; reason: TranscriptResultReason | null; output?: { kind: 'transcript'; cues: ReviewText[] } | null; selected: boolean }[];
}
export interface SavedAiResult {
  jobId: string;
  ordinal: number;
  applied: boolean;
  canApply: boolean;
  blockedReason?: string;
  translations: { source: string; translation: string; startMs: number; endMs: number }[];
}
export interface AppSnapshot {
  media: Media[];
  cards: StudyCard[];
  tools: ToolStatus[];
  settings: AppSettings;
  jobs: JobSummary[];
  budget: BudgetSummary;
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
}
export interface VocabularyCandidate {
  sourceCueIds?: string[];
  startMs?: number;
  endMs?: number;
  id: string;
  mediaId: string;
  segmentId: string;
  term: string;
  meaning: string;
  example: string;
  explanation?: string;
  translation?: string;
}
export interface RestorePreview {
  token: string;
  mediaCount: number;
  cardCount: number;
  reviewCount: number;
  audioCount: number;
  warnings: string[];
}
export interface PlayerTrack {
  id: number;
  kind: string;
  title: string;
  language?: string;
  selected: boolean;
  ffIndex?: number | null;
  external?: boolean;
}
export interface PlayerState {
  sentencePause?: boolean;
  ready?: boolean;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  rate: number;
  volume: number;
  tracks: PlayerTrack[];
  error?: string;
  surfaceVisible?: boolean;
  videoWidth?: number;
  videoHeight?: number;
}
export interface PlayerControlRequest {
  action: 'source-seek' | 'source-loop' | 'play' | 'pause' | 'seek' | 'rate' | 'volume' | 'loop' | 'bounds' | 'hide' | 'track' | 'fullscreen' | 'sentence-pause' | 'draft-mode';
  trackKind?: 'audio' | 'sub';
  value?: number;
  startMs?: number;
  endMs?: number;
  /** CSS-pixel coordinates; native backend converts using scaleFactor. */
  bounds?: { x: number; y: number; width: number; height: number; scaleFactor: number };
}
export type ExportFormat = 'json' | 'csv' | 'tsv' | 'srt' | 'vtt' | 'zip';
export interface ImportRequest { kind: 'local' | 'url'; pathOrUrl: string; title?: string; learningLanguage: string; explanationLanguage: string }
export interface MediaStream { index: number; kind: string; codec: string; language?: string; title?: string; isDefault: boolean; supportedText: boolean }
export interface SubtitleVersion { id: string; mediaId: string; createdAt: string; label: string; streamIndex?: number; segments: SubtitleSegment[] }
export interface DownloadJobSnapshot { id: string; request: ImportRequest; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; phase: string; storedBytes: number; totalBytes?: number; mediaId?: string; error?: string; updatedAt: string; toolReceiptId?: string }
export const nativeAvailable = () => isTauri();

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!nativeAvailable()) throw new Error('この操作には Surtitle デスクトップアプリが必要です。 / Open Surtitle desktop to use this feature.');
  try { return await invoke<T>(command, args); }
  catch (error) { throw new Error(typeof error === 'string' ? error : error instanceof Error ? error.message : JSON.stringify(error)); }
}

export const api = {
  vertexModels: (location?: string) => call<DiscoveredModel[]>('list_vertex_models', { location }),
  vertexPrice: (modelId: string, location?: string) => call<{ price: AiPricePreference | null; candidates: { sku: string; description: string; direction: string; microusdPerMillion: number }[]; complete: boolean; observedAtMs: number }>('lookup_vertex_price', { modelId, location }),
  snapshot: () => call<AppSnapshot>('get_app_snapshot'),
  segments: (mediaId: string) => call<SubtitleSegment[]>('list_segments', { mediaId }),
  candidates: (mediaId: string) => call<VocabularyCandidate[]>('list_vocabulary_candidates', { mediaId }),
  selectMediaFiles: () => call<string[]>('select_media_files'),
  importMedia: (request: ImportRequest) => call<void>('import_media', { request }),
  startUrlImport: (request: ImportRequest) => call<string>('start_url_import', { request }),
  downloadJobs: () => call<DownloadJobSnapshot[]>('list_download_jobs'),
  cancelDownload: (jobId: string) => call<void>('cancel_download', { jobId }),
  mediaStreams: (mediaId: string) => call<MediaStream[]>('list_media_streams', { mediaId }),
  selectAudioStream: (mediaId: string, streamIndex: number) => call<void>('select_audio_stream', { mediaId, streamIndex }),
  subtitleVersions: (mediaId: string) => call<SubtitleVersion[]>('list_subtitle_versions', { mediaId }),
  restoreSubtitleVersion: (mediaId: string, versionId: string) => call<void>('restore_subtitle_version', { mediaId, versionId }),
  importSubtitles: (mediaId: string, replaceExisting = false) => call<void>('import_subtitles', { mediaId, replaceExisting }),
  extractEmbeddedSubtitles: (mediaId: string, streamIndex?: number, replaceExisting = false) => call<void>('extract_embedded_subtitles', { mediaId, streamIndex, replaceExisting }),
  editCard: (request: { id: string; term: string; meaning: string; example: string; translation?: string; explanation?: string }) => call<void>('edit_card', { request }),
  suspendCard: (cardId: string, suspended: boolean) => call<void>('suspend_card', { cardId, suspended }),
  deleteCard: (cardId: string) => call<void>('delete_card', { cardId }),
  removeMedia: (mediaId: string) => call<void>('remove_media', { mediaId }),
  relinkMedia: (mediaId: string) => call<void>('relink_media', { mediaId }),
  importCredential: () => call<void>('import_credential'),
  loadMedia: (mediaId: string) => call<void>('load_media', { mediaId }),
  playerState: () => call<PlayerState>('get_player_state'),
  player: (request: PlayerControlRequest) => call<void>('player_control', { request }),
  playSourceRange: (mediaId: string, sourceCueIds: string[]) => call<void>('play_source_range', { mediaId, sourceCueIds }),
  editSegment: (segment: SubtitleSegment) => call<void>('edit_segment', { segment }),
  createQuote: (request: { mediaId: string; kind: AiQuote['kind']; startMs: number; endMs: number; focusTerm?: string; model?: AiModelPreference }) => call<AiQuote>('create_quote', { request }),
  prepareTranscription: (mediaId: string, startMs: number, endMs: number) => call<TranscriptionPreparation>('prepare_transcription', { mediaId, startMs, endMs }),
  transcriptionPreparations: (mediaId: string) => call<TranscriptionPreparation[]>('list_transcription_preparations', { mediaId }),
  createTranscriptionQuote: (preparationId: string, model?: AiModelPreference) => call<AiQuote>('create_transcription_quote', { preparationId, model }),
  transcriptReview: (jobId: string) => call<TranscriptReview>('get_transcript_review', { jobId }),
  saveManualTranscriptRange: (jobId: string, draftDigest: string, ordinal: number, expectedRangeVersion: number, content: ManualTranscriptContent) => call<TranscriptReview>('save_manual_transcript_range', { jobId, draftDigest, ordinal, expectedRangeVersion, content }),
  selectTranscriptRangeSource: (jobId: string, draftDigest: string, ordinal: number, expectedRangeVersion: number, source: TranscriptRangeSource) => call<TranscriptReview>('select_transcript_range_source', { jobId, draftDigest, ordinal, expectedRangeVersion, source }),
  resolveTranscriptBoundary: (jobId: string, draftDigest: string, boundaryId: string, choice: BoundaryChoice) => call<TranscriptReview>('resolve_transcript_boundary', { jobId, draftDigest, boundaryId, choice }),
  transcriptResultDetail: (jobId: string, ordinal: number) => call<TranscriptResultReview>('get_transcript_result_detail', { jobId, ordinal }),
  reparseTranscriptEvidence: (jobId: string, ordinal: number, evidenceSha256: string) => call<TranscriptReview>('reparse_transcript_evidence', { jobId, ordinal, evidenceSha256 }),
  selectTranscriptReparse: (jobId: string, ordinal: number, candidateId: string, draftDigest: string) => call<TranscriptReview>('select_transcript_reparse', { jobId, ordinal, candidateId, draftDigest }),
  acknowledgeTranscriptWarning: (jobId: string, draftDigest: string, warningId: string) => call<TranscriptReview>('acknowledge_transcript_warning', { jobId, draftDigest, warningId }),
  applyTranscriptReview: (jobId: string, draftDigest: string) => call<TranscriptReview>('apply_transcript_review', { jobId, draftDigest }),
  prepareBoundaryRepair: (jobId: string, draftDigest: string, boundaryId: string) => call<AiQuote>('prepare_boundary_repair', { jobId, draftDigest, boundaryId }),
  cancelPreparation: () => call<void>('cancel_preparation'),
  approveQuote: (quote: AiQuote) => call<void>('approve_quote', { quoteId: quote.id, digest: quote.digest || '', acknowledgeUnpriced: quote.unpriced === true, acknowledgeUnqualified: true }),
  reapproveQuote: (quote: AiQuote) => call<void>('reapprove_quote', { quoteId: quote.id, digest: quote.digest || '', acknowledgeUnpriced: quote.unpriced === true, acknowledgeUnqualified: true }),
  createRetryQuote: (jobId: string) => call<AiQuote>('create_retry_quote', { jobId }),
  savedAiResults: (jobId: string) => call<SavedAiResult[]>('list_saved_ai_results', { jobId }),
  applySavedAiResult: (jobId: string, ordinal: number) => call<void>('apply_saved_ai_result', { jobId, ordinal }),
  pauseAiJob: (jobId: string) => call<void>('pause_ai_job', { jobId }),
  cancelAiJob: (jobId: string) => call<void>('cancel_ai_job', { jobId }),
  resolveUnknownAttempt: (attemptId: string) => call<void>('resolve_unknown_attempt', { attemptId }),
  saveCard: (request: { mediaId: string; segmentId: string; sourceCueIds?: string[]; term: string; meaning: string; example: string; explanation?: string; translation?: string }) => call<void>('save_card', { request }),
  rateCard: (cardId: string, rating: 'again' | 'hard' | 'good' | 'easy') => call<void>('rate_card', { cardId, rating }),
  playCardAudio: (cardId: string) => call<void>('play_card_audio', { cardId }),
  updateSettings: (settings: AppSettings) => call<void>('update_settings', { settings }),
  updateAppearance: (appearance: { locale?: AppSettings['locale']; theme?: AppSettings['theme'] }) => call<void>('update_appearance', appearance),
  scanExternalTools: (rescan = true) => call<ExternalToolCandidate[]>('scan_external_tools', { rescan }),
  checkToolUpdates: () => call<void>('check_tool_updates'),
  setToolProvider: (request: { toolId: ToolId; provider: 'managed' | 'external'; path?: string }) => call<void>('set_tool_provider', { request }),
  installTool: (toolId: ToolId) => call<void>('install_tool', { toolId }),
  updateTool: (toolId: ToolId) => call<void>('update_tool', { toolId }),
  rollbackTool: (toolId: ToolId) => call<void>('rollback_tool', { toolId }),
  exportLearning: (format: ExportFormat, mediaId?: string) => call<string>('export_learning', { format, mediaId }),
  previewRestore: () => call<RestorePreview | null>('preview_restore'),
  discardRestorePreview: (token: string) => call<void>('discard_restore_preview', { token }),
  restoreLearning: (token: string) => call<void>('restore_learning', { token }),
};
