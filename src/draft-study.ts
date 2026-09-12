// SPDX-License-Identifier: GPL-3.0-or-later
import { invoke } from '@tauri-apps/api/core';
import { nativeAvailable } from './api';
import type { AiModelPreference, AiQuote, VocabularyCandidate } from './api';

export interface DraftSelection {
  id: string;
  mediaId: string;
  jobId: string | null;
  version: number;
  text: string;
  startMs: number;
  endMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  cueIds: string[];
  ordinal?: number | null;
  origin: 'ai' | 'manual' | 'mixed';
  timing: 'cue' | 'source_block' | 'manual';
  confirmed: boolean;
  stale: boolean;
  blockingReasons: string[];
  canConfirm: boolean;
  createdAt: string;
  updatedAt: string;
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!nativeAvailable()) throw new Error('この操作には Surtitle デスクトップアプリが必要です。 / Open Surtitle desktop to use this feature.');
  try { return await invoke<T>(command, args); }
  catch (error) { throw new Error(typeof error === 'string' ? error : error instanceof Error ? error.message : JSON.stringify(error)); }
}

export const draftStudyApi = {
  list: (mediaId: string) => call<DraftSelection[]>('list_draft_selections', { mediaId }),
  prepare: (request: { jobId: string; cueIds?: string[]; ordinal?: number }) => call<DraftSelection>('prepare_draft_selection', { request }),
  update: (request: { id: string; version: number; text: string; startMs: number; endMs: number; confirm: boolean }) => call<DraftSelection>('update_draft_selection', { request }),
  saveCard: (request: { selectionId: string; version: number; term: string; meaning: string; explanation?: string; translation?: string }) => call<void>('save_draft_selection_card', { request }),
  createQuote: (request: { selectionId: string; version: number; focusTerm?: string; model: AiModelPreference }) => call<AiQuote>('create_draft_selection_quote', { request }),
  candidates: (request: { id: string; version: number }) => call<VocabularyCandidate[]>('list_draft_selection_candidates', { request }),
  export: (request: { id: string; version: number; format: 'json' | 'srt' | 'vtt' }) => call<void>('export_draft_selection', { request }),
  remove: (request: { id: string; version: number }) => call<void>('remove_draft_selection', { request }),
};

export function savedDraftText(response: unknown): string | undefined {
  // Display only bounded, unambiguous transcript text. Never reuse its invalid word times.
  if (!response || typeof response !== 'object' || !('candidates' in response) || !Array.isArray(response.candidates) || response.candidates.length !== 1) return;
  const parts: unknown = response.candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return;
  const transcripts = parts.filter(part => part && typeof part === 'object' && part.thought !== true && part.audioTranscription && typeof part.audioTranscription === 'object');
  if (transcripts.length !== 1 || typeof transcripts[0].audioTranscription.text !== 'string') return;
  const text = transcripts[0].audioTranscription.text as string;
  if (text.trim() && new TextEncoder().encode(text).length <= 16000) return text;
}
