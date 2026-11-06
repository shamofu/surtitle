// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PreparationSessionsProvider } from '../features/ai/PreparationSessions';
import { useTranscriptionRequest } from '../features/ai/useTranscriptionRequest';
import { aiApi } from '../features/ai/api';
import type { AiModelPreference, AiQuote, TranscriptionPreparation } from '../shared/contracts/ai';

vi.mock('../app/providers/Activities', () => ({ useActivities: () => ({ runTracked: (_descriptor: unknown, action: () => Promise<unknown>) => action() }) }));
vi.mock('../app/runtime', () => ({
  useDataActions: () => ({ mutate: (action: () => Promise<unknown>) => action() }),
  useSnapshot: () => ({ data: { settings: { activeProvider: 'vertex', aiConfigurationGeneration: 7 } } }),
}));
vi.mock('../features/ai/api', () => ({ aiApi: { prepareTranscription: vi.fn(), createTranscriptionQuote: vi.fn() } }));

const scope = { mediaId: 'media', sourceSignature: 'unchanged-source', startMs: 0, endMs: 901_000, wholeMedia: true };
const transcribe: AiModelPreference = { modelId: 'selected-model', transcriptionMode: 'transcribe', maxOutputTokens: 4096 };
const subtitles: AiModelPreference = { ...transcribe, transcriptionMode: 'subtitles' };
const preparation: TranscriptionPreparation = {
  id: 'prepared', mediaId: 'media', startMs: 0, endMs: 901_000, coreDurationMs: 901_000,
  sendDurationMs: 901_000, chunkCount: 1, provider: 'vertex', aiConfigurationGeneration: 7,
  compatible: true, chunkProfile: 'vertex_transcribe_file_silence', wholeMedia: true,
};
const quote: AiQuote = {
  id: 'quote', mediaId: 'media', kind: 'transcribe', startMs: 0, endMs: 901_000, provider: 'vertex', aiConfigurationGeneration: 7,
  model: transcribe.modelId, estimatedUsd: 1, maximumUsd: 2, inputTokens: 100,
  maxOutputTokens: 4096, expiresAt: '2099-01-01T00:00:00Z', warnings: [], canApprove: true,
};
const options = () => ({ fresh: false, beforePrepare: vi.fn(async () => {}), onPrepared: vi.fn(), persistQuote: vi.fn(async () => {}) });
beforeEach(() => {
  vi.mocked(aiApi.prepareTranscription).mockImplementation(async (_media, _start, _end, _whole, _operation, selected) => ({
    ...preparation, id: selected?.transcriptionMode ?? 'default',
    chunkProfile: selected?.transcriptionMode === 'subtitles' ? 'vertex_audio_file_silence' : 'vertex_transcribe_file_silence',
  }));
  vi.mocked(aiApi.createTranscriptionQuote).mockResolvedValue(quote);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('sends the dialog-selected mode to preparation and does not reuse another mode at the same settings generation', async () => {
  const view = renderHook(({ model }) => useTranscriptionRequest(scope, model, 'Recording'), { initialProps: { model: transcribe }, wrapper: PreparationSessionsProvider });
  let previous: TranscriptionPreparation | undefined;
  await act(async () => { previous = (await view.result.current.estimate(options()))?.preparation; });
  view.rerender({ model: subtitles });
  await act(async () => { await view.result.current.estimate({ ...options(), reusePreparation: previous }); });
  expect(aiApi.prepareTranscription).toHaveBeenCalledTimes(2);
  expect(aiApi.prepareTranscription).toHaveBeenLastCalledWith('media', 0, 901_000, true, expect.any(String), subtitles);
  expect(aiApi.createTranscriptionQuote).toHaveBeenLastCalledWith('subtitles', subtitles, { provider: 'vertex', aiConfigurationGeneration: 7 });
});

it('reuses prepared audio for a different model with the same mode and estimates the selected model', async () => {
  const view = renderHook(({ model }) => useTranscriptionRequest(scope, model, 'Recording'), { initialProps: { model: transcribe }, wrapper: PreparationSessionsProvider });
  await act(async () => { await view.result.current.estimate(options()); });
  const alternate = { ...transcribe, modelId: 'another-selected-model' };
  view.rerender({ model: alternate });
  await act(async () => { await view.result.current.estimate(options()); });
  expect(aiApi.prepareTranscription).toHaveBeenCalledOnce();
  expect(aiApi.createTranscriptionQuote).toHaveBeenCalledTimes(2);
  expect(aiApi.createTranscriptionQuote).toHaveBeenLastCalledWith('transcribe', alternate, { provider: 'vertex', aiConfigurationGeneration: 7 });
});

it.each(['preparation', 'quote'] as const)('ignores a delayed %s after switching modes away and back without a settings update', async stage => {
  let finish!: () => void;
  if (stage === 'preparation') vi.mocked(aiApi.prepareTranscription).mockReturnValueOnce(new Promise(resolve => { finish = () => resolve(preparation); }));
  else vi.mocked(aiApi.createTranscriptionQuote).mockReturnValueOnce(new Promise(resolve => { finish = () => resolve(quote); }));
  const view = renderHook(({ model }) => useTranscriptionRequest(scope, model, 'Recording'), { initialProps: { model: transcribe }, wrapper: PreparationSessionsProvider });
  const callbacks = options();
  let pending!: ReturnType<typeof view.result.current.estimate>;
  await act(async () => { pending = view.result.current.estimate(callbacks); });
  view.rerender({ model: subtitles });
  view.rerender({ model: transcribe });
  await act(async () => { finish(); expect(await pending).toBeUndefined(); });
  expect(callbacks.persistQuote).not.toHaveBeenCalled();
  if (stage === 'preparation') {
    expect(callbacks.onPrepared).not.toHaveBeenCalled();
    expect(aiApi.createTranscriptionQuote).not.toHaveBeenCalled();
  }
});

it.each(['preparation', 'quote'] as const)('ignores a delayed %s failure after a local mode roundtrip', async stage => {
  let fail!: (error: Error) => void;
  if (stage === 'preparation') vi.mocked(aiApi.prepareTranscription).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
  else vi.mocked(aiApi.createTranscriptionQuote).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
  const view = renderHook(({ model }) => useTranscriptionRequest(scope, model, 'Recording'), { initialProps: { model: transcribe }, wrapper: PreparationSessionsProvider });
  const callbacks = options();
  let pending!: ReturnType<typeof view.result.current.estimate>;
  await act(async () => { pending = view.result.current.estimate(callbacks); });
  view.rerender({ model: subtitles });
  view.rerender({ model: transcribe });
  await act(async () => { fail(new Error('Old mode request failed')); expect(await pending).toBeUndefined(); });
  expect(callbacks.persistQuote).not.toHaveBeenCalled();
});
