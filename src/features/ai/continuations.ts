import { call } from '../../shared/native/transport';
import type { AiModelPreference, AiPurpose, AiQuote } from '../../shared/contracts/ai';

export interface AiContinuation {
  id: string;
  mediaId: string;
  kind: AiQuote['kind'];
  start: string;
  end: string;
  wholeMedia: boolean;
  focusTerm: string;
  models: Partial<Record<AiPurpose, AiModelPreference>>;
  preparationId?: string | null;
  quoteId?: string | null;
  sourceCueIds?: string[];
  sourceRevision?: string | null;
  sourceMediaSignature?: string | null;
  updatedAtMs?: number;
}
export const continuationApi = {
  save: (continuation: AiContinuation) => call('save_ai_continuation', { continuation }),
  list: () => call('list_ai_continuations'),
  discard: (id: string) => call('discard_ai_continuation', { id }),
};
