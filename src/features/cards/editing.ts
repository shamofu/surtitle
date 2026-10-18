// SPDX-License-Identifier: GPL-3.0-or-later
import type { QueryClient } from '@tanstack/react-query';
import type { StudyCard } from '../../shared/contracts/cards';
import { editingSession } from '../../shared/editing/session';
import { queryKeys } from '../../shared/query/keys';
import { cardsApi } from './api';
import type { AppSnapshot } from '../../shared/contracts/snapshot';

const cardFields = (card: StudyCard) => ({ term: card.term, meaning: card.meaning, example: card.example,
  translation: card.translation ?? '', explanation: card.explanation ?? '' });
export function cardEditor(cardId: string, client: QueryClient) {
  return editingSession('card', cardId, {
    read: async () => { const state = await cardsApi.editState(cardId); return { fields: cardFields(state.card), revision: state.revision }; },
    save: async (fields, previous) => {
      if (!fields.term?.trim()) return { ...previous, applied: [] };
      const state = await cardsApi.saveEdit({ id: cardId, term: fields.term.trim(), meaning: fields.meaning, example: fields.example,
        translation: fields.translation || undefined, explanation: fields.explanation || undefined }, previous.revision);
      client.setQueryData<AppSnapshot>(queryKeys.snapshot, data => data && { ...data, cards: data.cards.map(card => card.id === cardId ? state.card : card) });
      return { fields: cardFields(state.card), revision: state.revision, applied: Object.keys(fields) };
    },
  });
}
