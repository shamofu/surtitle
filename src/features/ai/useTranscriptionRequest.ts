// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { useActivities } from '../../app/providers/Activities';
import { useDataActions, useSnapshot } from '../../app/runtime';
import type { AiModelPreference, AiQuote, TranscriptionPreparation } from '../../shared/contracts/ai';
import { activeProvider, aiConfiguration, providerConfigurationKey, type AiConfiguration } from './provider';
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

export function transcriptionAudioPolicy(configuration: AiConfiguration, model: AiModelPreference): TranscriptionPreparation['chunkProfile'] {
  return configuration.provider === 'openai' ? 'openai_file_silence' : model.transcriptionMode === 'transcribe' ? 'vertex_transcribe_file_silence' : 'vertex_audio_file_silence';
}

/** Older receipts may omit context; current native receipts explicitly report compatibility. */
export function preparationMatchesConfiguration(preparation: TranscriptionPreparation, configuration: AiConfiguration, model?: AiModelPreference) {
  return preparation.compatible !== false &&
    (preparation.provider === undefined || preparation.provider === configuration.provider) &&
    (preparation.aiConfigurationGeneration === undefined || preparation.aiConfigurationGeneration === configuration.aiConfigurationGeneration) &&
    (!model || preparation.chunkProfile === undefined || preparation.chunkProfile === transcriptionAudioPolicy(configuration, model));
}

/** Coordinate shared native requests while callers keep their form, persistence and retry policies. */
export function useTranscriptionRequest(scope: PreparationScope, model: AiModelPreference, label: string) {
  const { mutate } = useDataActions();
  const { runTracked } = useActivities();
  const { data } = useSnapshot();
  const configuration = providerConfigurationKey(data?.settings);
  const context = aiConfiguration(data?.settings);
  const audioPolicy = transcriptionAudioPolicy(context, model);
  const preparationSession = usePreparationSession({ ...scope, provider: activeProvider(data?.settings), aiConfigurationGeneration: data?.settings.aiConfigurationGeneration ?? 0, audioPolicy });
  const { revision } = preparationSession;
  const [phase, setPhase] = useState<'saving' | 'preparing' | 'estimating'>();
  const mounted = useRef(true);
  const pending = useRef<object | undefined>(undefined);
  const selectionKey = JSON.stringify([configuration, model]);
  const selection = useRef({ key: selectionKey, epoch: 0 });
  if (selection.current.key !== selectionKey) selection.current = { key: selectionKey, epoch: selection.current.epoch + 1 };
  const epoch = selection.current.epoch;
  const current = useRef({ sourceSignature: scope.sourceSignature, revision, epoch });
  current.current = { sourceSignature: scope.sourceSignature, revision, epoch };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { pending.current = undefined; setPhase(undefined); }, [revision, selectionKey]);

  async function estimate(options: EstimateOptions): Promise<EstimatedRequest | undefined> {
    if (pending.current) return;
    const attempt = {};
    pending.current = attempt;
    setPhase('saving');
    try {
      await options.beforePrepare();
      if (current.current.revision !== revision || current.current.epoch !== epoch) return;
      let preparation = options.reusePreparation && preparationMatchesConfiguration(options.reusePreparation, context, model) ? options.reusePreparation : undefined;
      if (!preparation) {
        if (mounted.current) setPhase('preparing');
        preparation = await preparationSession.prepare(async operationId => {
          const prepared = await mutate(
            () => aiApi.prepareTranscription(scope.mediaId, scope.startMs, scope.endMs, scope.wholeMedia, operationId, model),
            { kind: 'snapshot' },
          );
          if (!preparationMatchesConfiguration(prepared, context, model)) throw new Error('AI settings changed while preparing audio. Prepare a new estimate.');
          return prepared;
        });
      }
      const sourceSignature = current.current.sourceSignature;
      if (!mounted.current || current.current.revision !== revision || current.current.epoch !== epoch || !preparationMatchesConfiguration(preparation, context, model) || !preparedSourceMatches(scope.sourceSignature, sourceSignature, preparation)) return;
      options.onPrepared({ preparation, sourceSignature });
      setPhase('estimating');
      const prepared = preparation;
      const quote = await preparationSession.estimate(model, () => runTracked(
        { kind: 'estimate', label, phase: 'estimating', mediaId: scope.mediaId },
        () => mutate(() => aiApi.createTranscriptionQuote(prepared.id, model, aiConfiguration(data?.settings)), { kind: 'snapshot' }),
      ), options.fresh);
      if (current.current.sourceSignature !== sourceSignature || current.current.revision !== revision || current.current.epoch !== epoch) return;
      const result = { quote, preparation, sourceSignature, revision };
      await options.persistQuote(result);
      if (mounted.current && current.current.revision === revision && current.current.epoch === epoch) return result;
    } catch (error) {
      if (!mounted.current || current.current.revision !== revision || current.current.epoch !== epoch) return;
      throw error;
    } finally {
      if (pending.current === attempt) {
        pending.current = undefined;
        if (mounted.current) setPhase(undefined);
      }
    }
  }

  const session = preparationSession.session;
  return { session: session?.result && !preparationMatchesConfiguration(session.result, context, model) ? undefined : session, revision, phase, estimate, forgetEstimate: preparationSession.forgetEstimate };
}
