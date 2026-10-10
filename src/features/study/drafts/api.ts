// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../../shared/native/transport';
import type { AiModelPreference } from '../../../shared/contracts/ai';
import type { AiQuote } from '../../../shared/contracts/ai';
import type { VocabularyCandidate } from '../../../shared/contracts/cards';

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

export const draftStudyApi = {
  list: (mediaId: string) =>
    call<DraftSelection[]>('list_draft_selections', { mediaId }),
  prepare: (request: { jobId: string; cueIds?: string[]; ordinal?: number }) =>
    call<DraftSelection>('prepare_draft_selection', { request }),
  update: (request: {
    id: string;
    version: number;
    text: string;
    startMs: number;
    endMs: number;
    confirm: boolean;
  }) => call<DraftSelection>('update_draft_selection', { request }),
  saveCard: (request: {
    selectionId: string;
    version: number;
    term: string;
    meaning: string;
    explanation?: string;
    translation?: string;
  }, operationId?: string) => call<void>('save_draft_selection_card', { request, operationId }),
  createQuote: (request: {
    selectionId: string;
    version: number;
    focusTerm?: string;
    model: AiModelPreference;
  }) => call<AiQuote>('create_draft_selection_quote', { request }),
  candidates: (request: { id: string; version: number }) =>
    call<VocabularyCandidate[]>('list_draft_selection_candidates', { request }),
  export: (request: {
    id: string;
    version: number;
    format: 'json' | 'srt' | 'vtt';
  }) => call<boolean>('export_draft_selection', { request }),
  remove: (request: { id: string; version: number }) =>
    call<void>('remove_draft_selection', { request }),
};
