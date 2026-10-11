// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../shared/native/transport';

export const cardsApi = {
  editState: (cardId: string) => call('get_card_edit_state', { cardId }),
  saveEdit: (request: { id: string; term: string; meaning: string; example: string; translation?: string; explanation?: string }, expectedRevision: string) =>
    call('save_card_edit', { request, expectedRevision }),
  editCard: (request: {
    id: string;
    term: string;
    meaning: string;
    example: string;
    translation?: string;
    explanation?: string;
  }) => call('edit_card', { request }),
  suspendCard: (cardId: string, suspended: boolean) =>
    call('suspend_card', { cardId, suspended }),
  deleteCard: (cardId: string) => call('delete_card', { cardId }),
  saveCard: (request: {
    mediaId: string;
    segmentId: string;
    sourceCueIds?: string[];
    sourceRange?: { startMs: number; endMs: number };
    term: string;
    meaning: string;
    example: string;
    explanation?: string;
    translation?: string;
  }, operationId?: string) => call('save_card', { request, operationId }),
  rateCard: (cardId: string, rating: 'again' | 'hard' | 'good' | 'easy') =>
    call('rate_card', { cardId, rating }),
};
