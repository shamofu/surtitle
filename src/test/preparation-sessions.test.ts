// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { createPreparationSessions, type PreparationScope } from '../features/ai/PreparationSessions';
import type { AiModelPreference, AiQuote, TranscriptionPreparation } from '../shared/contracts/ai';

const scope: PreparationScope = { mediaId: 'media', sourceSignature: 'source', startMs: 0, endMs: 1000, wholeMedia: true };
const preparation: TranscriptionPreparation = { id: 'prepared', mediaId: 'media', startMs: 0, endMs: 1000, wholeMedia: true, coreDurationMs: 1000, sendDurationMs: 1000, chunkCount: 1 };
const model: AiModelPreference = { modelId: 'model', transcriptionMode: 'transcribe', maxOutputTokens: 1000 };
const quote: AiQuote = { id: 'quote', mediaId: 'media', kind: 'transcribe', startMs: 0, endMs: 1000, model: 'model', estimatedUsd: 1, maximumUsd: 2, inputTokens: 100, maxOutputTokens: 1000, expiresAt: '2099-01-01T00:00:00Z', warnings: [], canApprove: true };

it('clears prepared audio and quotes on restore even when the same source signature remains', async () => {
  const sessions = createPreparationSessions();
  const prepare = vi.fn(async () => preparation);
  const estimate = vi.fn(async () => quote);
  await sessions.prepare(scope, prepare);
  await sessions.estimate(scope, model, estimate);
  await sessions.prepare(scope, prepare);
  await sessions.estimate(scope, model, estimate);
  expect(prepare).toHaveBeenCalledOnce();
  expect(estimate).toHaveBeenCalledOnce();
  sessions.clear();
  expect(sessions.get(scope)).toBeUndefined();
  await sessions.prepare(scope, prepare);
  await sessions.estimate(scope, model, estimate);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(estimate).toHaveBeenCalledTimes(2);
});

it('invalidates pending requests and refuses late completions after restoring data', async () => {
  const sessions = createPreparationSessions();
  let completeOld!: (value: TranscriptionPreparation) => void;
  let completeQuote!: (value: AiQuote) => void;
  const pendingPreparation = sessions.prepare(scope, () => new Promise(resolve => { completeOld = resolve; }));
  const pendingQuote = sessions.estimate(scope, model, () => new Promise(resolve => { completeQuote = resolve; }));
  await Promise.resolve();
  const preparationRejected = expect(pendingPreparation).rejects.toThrow('invalidated');
  const estimateRejected = expect(pendingQuote).rejects.toThrow('invalidated');
  sessions.clear();
  await Promise.all([preparationRejected, estimateRejected]);
  let completeNew!: (value: TranscriptionPreparation) => void;
  const replacement = sessions.prepare(scope, () => new Promise(resolve => { completeNew = resolve; }));
  const newOperationId = sessions.get(scope)?.operationId;
  completeOld(preparation); completeQuote(quote);
  await Promise.resolve();
  expect(sessions.get(scope)).toMatchObject({ operationId: newOperationId, status: 'running' });
  completeNew({ ...preparation, id: 'replacement' });
  await expect(replacement).resolves.toMatchObject({ id: 'replacement' });
  const estimate = vi.fn(async () => ({ ...quote, id: 'replacement-quote' }));
  await expect(sessions.estimate(scope, model, estimate)).resolves.toMatchObject({ id: 'replacement-quote' });
  expect(estimate).toHaveBeenCalledOnce();
});

it('retains at most twenty completed estimates while keeping the latest reusable', async () => {
  const sessions = createPreparationSessions();
  const estimate = vi.fn(async () => quote);
  for (let index = 0; index < 21; index++) await sessions.estimate(scope, { ...model, modelId: `model-${index}` }, estimate);
  await sessions.estimate(scope, { ...model, modelId: 'model-20' }, estimate);
  expect(estimate).toHaveBeenCalledTimes(21);
  await sessions.estimate(scope, { ...model, modelId: 'model-0' }, estimate);
  expect(estimate).toHaveBeenCalledTimes(22);
});

it.each([2, 4])('waits for an automatic choice before deciding whether selected stream %s needs new audio', async selected => {
  const sessions = createPreparationSessions();
  const automatic = { ...scope, sourceSignature: JSON.stringify(['audio.wav', null, 'en', 'ja']) };
  const resolved = { ...scope, sourceSignature: JSON.stringify(['audio.wav', selected, 'en', 'ja']) };
  let finish!: (value: TranscriptionPreparation) => void;
  const first = sessions.prepare(automatic, () => new Promise(resolve => { finish = resolve; }));
  const next = vi.fn(async () => ({ ...preparation, id: 'new-choice', audioStreamIndex: selected }));
  const reopened = sessions.prepare(resolved, next);
  expect(next).not.toHaveBeenCalled();
  expect(sessions.get(resolved)?.operationId).toBe(sessions.get(automatic)?.operationId);
  finish({ ...preparation, audioStreamIndex: 2 });
  await first;
  await expect(reopened).resolves.toMatchObject({ id: selected === 2 ? 'prepared' : 'new-choice', audioStreamIndex: selected });
  expect(next).toHaveBeenCalledTimes(selected === 2 ? 0 : 1);
});

it('reuses confirmed audio and quotes under the signature containing the resolved stream', async () => {
  const sessions = createPreparationSessions();
  const automatic = { ...scope, sourceSignature: JSON.stringify(['audio.wav', null, 'en', 'ja']) };
  const resolved = { ...scope, sourceSignature: JSON.stringify(['audio.wav', 2, 'en', 'ja']) };
  const prepare = vi.fn(async () => ({ ...preparation, audioStreamIndex: 2 }));
  const estimate = vi.fn(async () => quote);
  await sessions.prepare(automatic, prepare);
  await sessions.estimate(automatic, model, estimate);
  await sessions.prepare(resolved, prepare);
  await sessions.estimate(resolved, model, estimate);
  expect(prepare).toHaveBeenCalledOnce();
  expect(estimate).toHaveBeenCalledOnce();
});
