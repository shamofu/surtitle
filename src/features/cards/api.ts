// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../shared/native/transport';

export const cardsApi = {
  editCard: (request: {
    id: string;
    term: string;
    meaning: string;
    example: string;
    translation?: string;
    explanation?: string;
  }) => call<void>('edit_card', { request }),
  suspendCard: (cardId: string, suspended: boolean) =>
    call<void>('suspend_card', { cardId, suspended }),
  deleteCard: (cardId: string) => call<void>('delete_card', { cardId }),
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
  }) => call<void>('save_card', { request }),
  rateCard: (cardId: string, rating: 'again' | 'hard' | 'good' | 'easy') =>
    call<void>('rate_card', { cardId, rating }),
};
