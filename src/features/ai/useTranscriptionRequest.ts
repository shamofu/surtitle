// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { useActivities } from '../../app/providers/Activities';
import { useDataActions } from '../../app/runtime';
import type { AiModelPreference, AiQuote, TranscriptionPreparation } from '../../shared/contracts/ai';
import { aiApi } from './api';
import { preparedSourceMatches, usePreparationSession, type PreparationScope } from './PreparationSessions';

interface PreparedRequest {
  preparation: TranscriptionPreparation;
  sourceSignature: string;
}

interface EstimatedRequest extends PreparedRequest {
  quote: AiQuote;
  revision: number;
}

interface EstimateOptions {
  fresh: boolean;
  reusePreparation?: TranscriptionPreparation;
  beforePrepare: () => Promise<unknown>;
  onPrepared: (request: PreparedRequest) => void;
  persistQuote: (request: EstimatedRequest) => Promise<unknown>;
}

/** Coordinate shared native requests while callers keep their form, persistence and retry policies. */
export function useTranscriptionRequest(scope: PreparationScope, model: AiModelPreference, label: string) {
  const { mutate } = useDataActions();
  const { runTracked } = useActivities();
  const preparationSession = usePreparationSession(scope);
  const { revision } = preparationSession;
  const [phase, setPhase] = useState<'saving' | 'preparing' | 'estimating'>();
  const mounted = useRef(true);
  const pending = useRef<object | undefined>(undefined);
  const current = useRef({ sourceSignature: scope.sourceSignature, revision });
  current.current = { sourceSignature: scope.sourceSignature, revision };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { pending.current = undefined; setPhase(undefined); }, [revision]);

  async function estimate(options: EstimateOptions): Promise<EstimatedRequest | undefined> {
    if (pending.current) return;
    const attempt = {};
    pending.current = attempt;
    setPhase('saving');
    try {
      await options.beforePrepare();
      if (current.current.revision !== revision) return;
      let preparation = options.reusePreparation;
      if (!preparation) {
        if (mounted.current) setPhase('preparing');
        preparation = await preparationSession.prepare(operationId => mutate(
          () => aiApi.prepareTranscription(scope.mediaId, scope.startMs, scope.endMs, scope.wholeMedia, operationId),
          { kind: 'snapshot' },
        ));
      }
      const sourceSignature = current.current.sourceSignature;
      if (!mounted.current || current.current.revision !== revision || !preparedSourceMatches(scope.sourceSignature, sourceSignature, preparation)) return;
      options.onPrepared({ preparation, sourceSignature });
      setPhase('estimating');
      const prepared = preparation;
      const quote = await preparationSession.estimate(model, () => runTracked(
        { kind: 'estimate', label, phase: 'estimating', mediaId: scope.mediaId },
        () => mutate(() => aiApi.createTranscriptionQuote(prepared.id, model), { kind: 'snapshot' }),
      ), options.fresh);
      if (current.current.sourceSignature !== sourceSignature || current.current.revision !== revision) return;
      const result = { quote, preparation, sourceSignature, revision };
      await options.persistQuote(result);
      if (mounted.current && current.current.revision === revision) return result;
    } finally {
      if (pending.current === attempt) {
        pending.current = undefined;
        if (mounted.current) setPhase(undefined);
      }
    }
  }

  return { session: preparationSession.session, revision, phase, estimate, forgetEstimate: preparationSession.forgetEstimate };
}
