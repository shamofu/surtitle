// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent, render as renderView, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AiDialog } from '../features/ai/AiDialog';
import { JobActions } from '../features/ai/JobActions';
import { aiApi } from '../features/ai/api';
import { continuationApi } from '../features/ai/continuations';
import type { AiQuote, AiModelPreference, TranscriptionPreparation } from '../shared/contracts/ai';
import type { Media } from '../shared/contracts/media';
import { PreparationSessionsProvider, useClearPreparationSessions } from '../features/ai/PreparationSessions';

const render = (ui: ReactElement) => renderView(ui, { wrapper: PreparationSessionsProvider });
function RestoreData() { const clear = useClearPreparationSessions(); return <button onClick={clear}>Restore data</button>; }
const fixture = vi.hoisted(() => ({ credentialConfigured: true, navigate: vi.fn(), errors: [] as unknown[] }));
vi.mock('../app/providers/Activities', () => {
  const runTracked = async (_descriptor: unknown, action: () => Promise<unknown>) => action();
  return { useActivities: () => ({ activities: [], runTracked }) };
});
vi.mock('../features/ai/api', () => ({ aiApi: {
  transcriptionPreparations: vi.fn(), prepareTranscription: vi.fn(), createTranscriptionQuote: vi.fn(), createQuote: vi.fn(),
  approveQuote: vi.fn(), reapproveQuote: vi.fn(), reviewAiJob: vi.fn(), createRetryQuote: vi.fn(),
  vertexModels: vi.fn(), vertexPrice: vi.fn(), cancelPreparation: vi.fn(),
} }));
vi.mock('../features/ai/continuations', () => ({ continuationApi: { save: vi.fn(), discard: vi.fn() } }));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../shared/native/events', () => ({ subscribeNative: () => () => {} }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => fixture.navigate }));
vi.mock('../app/runtime', () => {
  const t = (_ja: string, en: string) => en;
  const report = async (action: () => Promise<unknown>) => {
    try { return await action(); } catch (error) { fixture.errors.push(error); return undefined; }
  };
  const registerModal = () => () => {};
  const useFixture = () => ({
    t, report, registerModal, mutate: (action: () => Promise<unknown>) => action(),
    data: {
      settings: { credentialConfigured: fixture.credentialConfigured, vertexProject: 'test-project', vertexLocation: 'global', aiModels: {
        transcription: { modelId: 'gemini-test-transcribe', transcriptionMode: 'transcribe', maxOutputTokens: 12288 },
        vocabulary: { modelId: 'gemini-test-flash', transcriptionMode: 'subtitles', maxOutputTokens: 8192 },
      } },
      budget: { unknownAttempts: [] },
    },
  });
  return { useDataActions: useFixture, useAppearance: useFixture, useSnapshot: useFixture, useNotifications: useFixture, useSurface: useFixture };
});
const model: AiModelPreference = { modelId: 'gemini-test-transcribe', transcriptionMode: 'transcribe', maxOutputTokens: 12288 };
const media: Media = { id: 'video', title: 'Full media', path: 'C:/video.mkv', kind: 'video', durationMs: 2161234, learningLanguage: 'en', explanationLanguage: 'ja', createdAt: '', lastPositionMs: 123456, segmentCount: 2, cardCount: 0, status: 'ready' };
const mediaSignature = JSON.stringify([media.path, media.audioStreamIndex, media.learningLanguage, media.explanationLanguage]);
const preparation: TranscriptionPreparation = { id: 'prepared', mediaId: media.id, startMs: 0, endMs: media.durationMs, coreDurationMs: media.durationMs, sendDurationMs: media.durationMs + 2000, chunkCount: 8, wholeMedia: true };
const quote: AiQuote = { id: 'quote', mediaId: media.id, kind: 'transcribe', startMs: 0, endMs: media.durationMs, model: model.modelId, estimatedUsd: 0.1, maximumUsd: 0.2, inputTokens: 100, maxOutputTokens: model.maxOutputTokens, expiresAt: '2099-01-01T00:00:00Z', warnings: [], canApprove: true, applyPolicy: 'auto' };
const estimate = () => screen.getByRole('button', { name: 'Prepare and review the complete estimate' });
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
beforeEach(() => {
  fixture.credentialConfigured = true;
  fixture.errors = [];
  vi.mocked(aiApi.transcriptionPreparations).mockResolvedValue([]);
  vi.mocked(aiApi.prepareTranscription).mockResolvedValue(preparation);
  vi.mocked(aiApi.createTranscriptionQuote).mockResolvedValue(quote);
  vi.mocked(aiApi.reviewAiJob).mockResolvedValue(quote);
  vi.mocked(aiApi.approveQuote).mockResolvedValue(undefined);
  vi.mocked(aiApi.reapproveQuote).mockResolvedValue(undefined);
  vi.mocked(continuationApi.save).mockImplementation(async value => value);
  vi.mocked(continuationApi.discard).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('uses the exact complete video despite a selected cue and prepares then estimates in one action', async () => {
  let finish!: (value: TranscriptionPreparation) => void;
  vi.mocked(aiApi.prepareTranscription).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const close = vi.fn();
  render(<AiDialog media={media} initialRange={{ startMs: 1234, endMs: 3456 }} sourceContext={{ sourceCueIds: ['a', 'b'], sourceRevision: 'frozen source' }} onClose={close} />);
  expect(screen.queryByLabelText(/^From/)).not.toBeInTheDocument();
  fireEvent.click(estimate());
  await waitFor(() => expect(aiApi.prepareTranscription).toHaveBeenCalledExactlyOnceWith(media.id, 0, 2161234, true, expect.any(String)));
  expect(aiApi.createTranscriptionQuote).not.toHaveBeenCalled();
  expect(estimate()).toBeDisabled();
  await act(async () => finish(preparation));
  await screen.findByText('Apply subtitles automatically');
  expect(aiApi.createTranscriptionQuote).toHaveBeenCalledExactlyOnceWith('prepared', model);
  expect(continuationApi.save).toHaveBeenCalledWith(expect.objectContaining({ sourceCueIds: ['a', 'b'], sourceRevision: 'frozen source' }));
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Approve this job' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Approve this job' }));
  await waitFor(() => expect(aiApi.approveQuote).toHaveBeenCalledExactlyOnceWith(quote));
  expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it('waits for a real duration and then uses its exact milliseconds without a guessed first minute', async () => {
  const view = render(<AiDialog media={{ ...media, durationMs: 0 }} initialRange={{ startMs: 1234, endMs: 3456 }} onClose={() => {}} />);
  expect(screen.getByText('Waiting for the video duration before estimating.')).toBeVisible();
  expect(estimate()).toBeDisabled();
  fireEvent.click(estimate());
  expect(aiApi.prepareTranscription).not.toHaveBeenCalled();
  view.rerender(<AiDialog media={{ ...media, durationMs: 7200123 }} initialRange={{ startMs: 1234, endMs: 3456 }} onClose={() => {}} />);
  fireEvent.click(estimate());
  await waitFor(() => expect(aiApi.prepareTranscription).toHaveBeenCalledExactlyOnceWith(media.id, 0, 7200123, true, expect.any(String)));
});

it('uses the selected cue only after explicitly choosing a range', async () => {
  vi.mocked(aiApi.prepareTranscription).mockResolvedValue({ ...preparation, startMs: 1234, endMs: 3456, wholeMedia: false });
  render(<AiDialog media={media} initialRange={{ startMs: 1234, endMs: 3456 }} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose a range' }));
  expect(screen.getByLabelText(/^From/)).toHaveValue('0:01.234');
  expect(screen.getByLabelText(/^To/)).toHaveValue('0:03.456');
  fireEvent.click(estimate());
  await waitFor(() => expect(aiApi.prepareTranscription).toHaveBeenCalledExactlyOnceWith(media.id, 1234, 3456, false, expect.any(String)));
});

it('does not create a quote or send a job after local preparation fails', async () => {
  vi.mocked(aiApi.prepareTranscription).mockRejectedValue(new Error('Audio extraction failed'));
  render(<AiDialog media={media} onClose={() => {}} />);
  fireEvent.click(estimate());
  await waitFor(() => expect(estimate()).toBeEnabled());
  expect(fixture.errors).toHaveLength(1);
  expect(aiApi.createTranscriptionQuote).not.toHaveBeenCalled();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
});

it('reuses completed preparation after reopening without approving or preparing again', async () => {
  let finish!: (value: TranscriptionPreparation) => void;
  vi.mocked(aiApi.prepareTranscription).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = render(<AiDialog media={media} onClose={() => {}} />);
  fireEvent.click(estimate());
  await waitFor(() => expect(aiApi.prepareTranscription).toHaveBeenCalledOnce());
  view.rerender(<p>Another page</p>);
  await act(async () => finish(preparation));
  expect(aiApi.createTranscriptionQuote).not.toHaveBeenCalled();
  view.rerender(<AiDialog media={media} onClose={() => {}} />);
  fireEvent.click(estimate());
  await screen.findByRole('button', { name: 'Approve this job' });
  expect(aiApi.prepareTranscription).toHaveBeenCalledOnce();
  expect(aiApi.createTranscriptionQuote).toHaveBeenCalledOnce();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
});

it('ignores a preparation completed after its audio source changed', async () => {
  let finish!: (value: TranscriptionPreparation) => void;
  vi.mocked(aiApi.prepareTranscription).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue(preparation);
  const view = render(<AiDialog media={media} onClose={() => {}} />);
  fireEvent.click(estimate());
  await waitFor(() => expect(aiApi.prepareTranscription).toHaveBeenCalledOnce());
  view.rerender(<AiDialog media={{ ...media, audioStreamIndex: 4 }} onClose={() => {}} />);
  await act(async () => finish(preparation));
  expect(aiApi.createTranscriptionQuote).not.toHaveBeenCalled();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  fireEvent.click(estimate());
  await screen.findByRole('button', { name: 'Approve this job' });
  expect(aiApi.prepareTranscription).toHaveBeenCalledTimes(2);
});

it('continues the first estimate when the preparation confirms its automatic audio choice', async () => {
  let finish!: (value: TranscriptionPreparation) => void;
  vi.mocked(aiApi.prepareTranscription).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const view = render(<AiDialog media={media} onClose={() => {}} />);
  fireEvent.click(estimate());
  await waitFor(() => expect(aiApi.prepareTranscription).toHaveBeenCalledOnce());
  view.rerender(<AiDialog media={{ ...media, audioStreamIndex: 2 }} onClose={() => {}} />);
  await act(async () => finish({ ...preparation, audioStreamIndex: 2 }));
  await screen.findByRole('button', { name: 'Approve this job' });
  expect(aiApi.prepareTranscription).toHaveBeenCalledOnce();
  expect(aiApi.createTranscriptionQuote).toHaveBeenCalledOnce();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  expect(continuationApi.save).toHaveBeenCalledWith(expect.objectContaining({ quoteId: quote.id, sourceMediaSignature: JSON.stringify([media.path, 2, media.learningLanguage, media.explanationLanguage]) }));
});

it('finishes successful approval even if cleaning up the saved request fails', async () => {
  const close = vi.fn();
  vi.mocked(continuationApi.discard).mockRejectedValueOnce(new Error('Local cleanup failed'));
  render(<AiDialog media={media} onClose={close} />);
  fireEvent.click(estimate());
  await screen.findByRole('button', { name: 'Approve this job' });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Approve this job' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(aiApi.approveQuote).toHaveBeenCalledExactlyOnceWith(quote);
  expect(fixture.errors).toHaveLength(1);
});

it('discards the visible approval on restore and requires a fresh explicit estimate', async () => {
  render(<><AiDialog media={media} onClose={() => {}} /><RestoreData /></>);
  fireEvent.click(estimate());
  await screen.findByRole('button', { name: 'Approve this job' });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Restore data' }));
  expect(screen.queryByRole('button', { name: 'Approve this job' })).not.toBeInTheDocument();
  expect(screen.getByText('Data was restored. Check the source and prepare a new estimate.')).toBeVisible();
  expect(aiApi.createTranscriptionQuote).toHaveBeenCalledOnce();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  fireEvent.click(estimate());
  await screen.findByRole('button', { name: 'Approve this job' });
  expect(aiApi.prepareTranscription).toHaveBeenCalledTimes(2);
});

it('keeps the chosen range and model override when navigating to setup', async () => {
  fixture.credentialConfigured = false;
  const close = vi.fn();
  render(<AiDialog media={media} initialRange={{ startMs: 1234, endMs: 3456 }} sourceContext={{ sourceCueIds: ['a', 'b'], sourceRevision: 'frozen source' }} onClose={close} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose a range' }));
  fireEvent.click(screen.getByText(`Model: ${model.modelId}`));
  fireEvent.change(screen.getByLabelText(/Gemini model ID/), { target: { value: 'gemini-custom-flash' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set up and return here' }));
  await waitFor(() => expect(fixture.navigate).toHaveBeenCalled());
  const saved = vi.mocked(continuationApi.save).mock.calls[0][0];
  expect(saved).toMatchObject({ sourceCueIds: ['a', 'b'], sourceRevision: 'frozen source' });
  expect(saved).toMatchObject({ mediaId: media.id, kind: 'transcribe', start: '0:01.234', end: '0:03.456', wholeMedia: false, models: { transcription: { modelId: 'gemini-custom-flash', transcriptionMode: 'subtitles' } } });
  expect(fixture.navigate).toHaveBeenCalledWith({ to: '/settings', search: { resume: saved.id } });
  expect(close).toHaveBeenCalledOnce();
});

it.each([false, true])('opens a queued estimate and uses the recorded retry status (%s) for approval', async isRetry => {
  const reviewed = { ...quote, isRetry };
  vi.mocked(aiApi.reviewAiJob).mockResolvedValue(reviewed);
  render(<JobActions job={{ id: quote.id, mediaId: media.id, kind: 'transcribe', status: 'queued', progress: 0, createdAt: '' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open estimate' }));
  await screen.findByRole('button', { name: 'Approve this job' });
  expect(aiApi.reviewAiJob).toHaveBeenCalledExactlyOnceWith(quote.id);
  expect(aiApi.createRetryQuote).not.toHaveBeenCalled();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Approve this job' }));
  await waitFor(() => expect(isRetry ? aiApi.reapproveQuote : aiApi.approveQuote).toHaveBeenCalledExactlyOnceWith(reviewed));
  expect(isRetry ? aiApi.approveQuote : aiApi.reapproveQuote).not.toHaveBeenCalled();
});

it('keeps stale-source input and prevents estimating until subtitles are explicitly selected again', async () => {
  const reselect = vi.fn();
  const continuation = { id: 'resume', mediaId: media.id, kind: 'vocabulary' as const, start: '0:01.234', end: '0:03.456',
    wholeMedia: false, focusTerm: 'original phrase', models: { explanation: { ...model, modelId: 'custom-model', transcriptionMode: 'subtitles' as const } },
    sourceCueIds: ['gone'], sourceRevision: 'old source' };
  render(<AiDialog media={media} continuation={continuation} sourceInvalid onReselectSource={reselect} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText(/A specific phrase to explain/), { target: { value: 'kept edited phrase' } });
  expect(screen.getByRole('button', { name: 'Review estimate' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Select subtitles again' }));
  await waitFor(() => expect(reselect).toHaveBeenCalledOnce());
  expect(reselect.mock.calls[0][0]).toMatchObject({ ...continuation, focusTerm: 'kept edited phrase' });
  expect(aiApi.createQuote).not.toHaveBeenCalled();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
});

it('blocks even a previously acknowledged quote when its restored source becomes invalid', async () => {
  const textQuote = { ...quote, kind: 'vocabulary' as const, applyPolicy: 'manual' as const };
  vi.mocked(aiApi.reviewAiJob).mockResolvedValue(textQuote);
  const continuation = { id: 'resume', mediaId: media.id, kind: 'vocabulary' as const, start: '0:00', end: '0:01',
    wholeMedia: false, focusTerm: 'phrase', models: {}, quoteId: quote.id, sourceMediaSignature: mediaSignature };
  const view = render(<AiDialog media={media} continuation={continuation} onClose={() => {}} />);
  const approve = await screen.findByRole('button', { name: 'Approve this job' });
  fireEvent.click(screen.getByRole('checkbox'));
  expect(approve).toBeEnabled();
  view.rerender(<AiDialog media={media} continuation={continuation} sourceInvalid onClose={() => {}} />);
  expect(approve).toBeDisabled();
  fireEvent.click(approve);
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
});

it('re-estimates remaining paused work and requires a fresh approval', async () => {
  const retry = { ...quote, isRetry: true };
  vi.mocked(aiApi.createRetryQuote).mockResolvedValue(retry);
  render(<JobActions job={{ id: quote.id, mediaId: media.id, kind: 'transcribe', status: 'paused', progress: 0.5, createdAt: '' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Estimate remaining work' }));
  await screen.findByRole('button', { name: 'Approve this job' });
  expect(aiApi.createRetryQuote).toHaveBeenCalledExactlyOnceWith(quote.id);
  expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Approve this job' }));
  await waitFor(() => expect(aiApi.reapproveQuote).toHaveBeenCalledExactlyOnceWith(retry));
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
});

it.each([undefined, '["C:/old-video.mkv",2,"fr","de"]'])('invalidates old whole-video preparation and quote when the saved media signature is %s', async sourceMediaSignature => {
  vi.mocked(aiApi.transcriptionPreparations).mockResolvedValue([preparation]);
  const continuation = { id: 'resume', mediaId: media.id, kind: 'transcribe' as const, start: '0:00', end: '0:01',
    wholeMedia: true, focusTerm: '', models: { transcription: model }, quoteId: 'old-quote', preparationId: preparation.id, sourceMediaSignature };
  render(<AiDialog media={media} continuation={continuation} onClose={() => {}} />);
  expect(screen.getByRole('alert')).toHaveTextContent(media.path);
  expect(screen.getByRole('alert')).toHaveTextContent('en → ja');
  expect(aiApi.reviewAiJob).not.toHaveBeenCalled();
  expect(aiApi.prepareTranscription).not.toHaveBeenCalled();
  fireEvent.click(estimate());
  await screen.findByRole('button', { name: 'Approve this job' });
  expect(aiApi.prepareTranscription).toHaveBeenCalledExactlyOnceWith(media.id, 0, media.durationMs, true, expect.any(String));
  expect(continuationApi.save).toHaveBeenCalledWith(expect.objectContaining({ sourceMediaSignature: mediaSignature, quoteId: quote.id }));
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
});
