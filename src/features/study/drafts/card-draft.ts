// SPDX-License-Identifier: GPL-3.0-or-later
import type { VocabularyCandidate } from '../../../shared/contracts/cards';
import { editingSession } from '../../../shared/editing/session';
import type { DraftSelection } from './api';

const sources = new Map<string, { selection: DraftSelection; candidate?: VocabularyCandidate }>();
/** App-owned raw input only. Creating a card always requires the dialog's Save action. */
export function draftCardEditor(selection: DraftSelection, candidate?: VocabularyCandidate) {
  sources.set(selection.id, { selection, candidate });
  return editingSession('draft_card', selection.id, {
    read: async () => {
      const current = sources.get(selection.id)!;
      return {
        revision: String(current.selection.version),
        fields: {
          term: '', meaning: '', explanation: '', translation: '',
        },
      };
    },
    draftOnly: ['term', 'meaning', 'explanation', 'translation'],
    save: async (_fields, previous) => ({ ...previous, applied: [] }),
  });
}
