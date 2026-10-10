// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent, render as renderView, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TranscriptionStatus, TranscriptionWorkspace } from '../features/study/transcript/TranscriptionWorkspace';
import { aiApi } from '../features/ai/api';
import { continuationApi } from '../features/ai/continuations';
import { studyApi } from '../features/study/api';
import { libraryApi } from '../features/library/api';
import type { TranscriptReview } from '../shared/contracts/transcript';
import type { AiQuote, JobSummary } from '../shared/contracts/ai';
import type { Media } from '../shared/contracts/media';
import type { Activity } from '../shared/contracts/activity';
import { PreparationSessionsProvider, useClearPreparationSessions } from '../features/ai/PreparationSessions';

const render = (ui: ReactElement) => renderView(ui, { wrapper: PreparationSessionsProvider });
function RestoreData() { const clear = useClearPreparationSessions(); return <button onClick={clear}>Restore data</button>; }
const fixture = vi.hoisted(() => ({ configured: true, jobs: [] as JobSummary[], activities: [] as Activity[], navigate: vi.fn(), locale: 'en' as 'ja' | 'en' }));
vi.mock('../app/providers/Activities', () => {
  const runTracked = async (_descriptor: unknown, action: () => Promise<unknown>) => action();
  return { useActivities: () => ({ activities: fixture.activities, runTracked }) };
});
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => fixture.navigate }));
vi.mock('../features/ai/ModelEditor', () => ({ emptyModel: () => ({ modelId: '', transcriptionMode: 'transcribe', maxOutputTokens: 12288 }), ModelEditor: () => <div>Model settings</div> }));
vi.mock('../features/ai/api', () => ({ aiApi: {
  prepareTranscription: vi.fn(), createTranscriptionQuote: vi.fn(), approveQuote: vi.fn(), reapproveQuote: vi.fn(),
  reviewAiJob: vi.fn(), cancelPreparation: vi.fn(), createRetryQuote: vi.fn(), pauseAiJob: vi.fn(), cancelAiJob: vi.fn(),
} }));
vi.mock('../features/ai/continuations', () => ({ continuationApi: { save: vi.fn(), discard: vi.fn() } }));
vi.mock('../features/library/api', () => ({ libraryApi: { mediaStreams: vi.fn() } }));
vi.mock('../features/study/api', () => ({ studyApi: { transcriptReview: vi.fn(), transcriptResultDetail: vi.fn(), applyTranscriptReview: vi.fn() } }));
vi.mock('../app/runtime', () => {
  const t = (ja: string, en: string) => fixture.locale === 'ja' ? ja : en;
  const report = async (action: () => Promise<unknown>) => { try { return await action(); } catch { return undefined; } };
  const runtime = () => ({ t, report, mutate: (action: () => Promise<unknown>) => action(),
    data: { settings: { credentialConfigured: fixture.configured, vertexProject: 'project', vertexLocation: 'global', aiModels: {
      transcription: { modelId: 'gemini-transcribe', transcriptionMode: 'transcribe', maxOutputTokens: 12288 },
    } }, jobs: fixture.jobs, budget: { unknownAttempts: [] } } });
  return { useAppearance: runtime, useSnapshot: runtime, useDataActions: runtime, useNotifications: runtime };
});
const media: Media = { id: 'media', title: 'Recording', path: 'C:/audio.wav', kind: 'audio', durationMs: 300000, learningLanguage: 'en', explanationLanguage: 'ja', createdAt: '', lastPositionMs: 0, segmentCount: 0, cardCount: 0, status: 'ready' };
const preparation = { id: 'prepared', mediaId: 'media', startMs: 0, endMs: 300000, wholeMedia: true, coreDurationMs: 300000, sendDurationMs: 306000, chunkCount: 3 };
const quote: AiQuote = { id: 'quote', mediaId: 'media', kind: 'transcribe', startMs: 0, endMs: 300000, model: 'gemini-transcribe', estimatedUsd: .1, maximumUsd: .2, inputTokens: 100, maxOutputTokens: 12288, expiresAt: '2099-01-01T00:00:00Z', warnings: [], canApprove: true, applyPolicy: 'auto' };
beforeEach(() => {
  fixture.configured = true; fixture.jobs = []; fixture.activities = []; fixture.locale = 'en';
  vi.mocked(libraryApi.mediaStreams).mockResolvedValue([]);
  vi.mocked(aiApi.prepareTranscription).mockResolvedValue(preparation);
  vi.mocked(aiApi.createTranscriptionQuote).mockResolvedValue(quote);
  vi.mocked(aiApi.approveQuote).mockResolvedValue(undefined);
  vi.mocked(aiApi.reapproveQuote).mockResolvedValue(undefined);
  vi.mocked(continuationApi.save).mockImplementation(async request => request);
  vi.mocked(continuationApi.discard).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

it('prepares and estimates on entry, then starts only after one explicit priced action', async () => {
  const done = vi.fn();
  render(<TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={done} />);
  const start = await screen.findByRole('button', { name: 'Start transcription' });
  expect(aiApi.prepareTranscription).toHaveBeenCalledExactlyOnceWith('media', 0, 300000, true, expect.any(String));
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: /approve this job/i })).not.toBeInTheDocument();
  expect(screen.getByText('Model settings')).not.toBeVisible();
  fireEvent.click(start);
  await waitFor(() => expect(aiApi.approveQuote).toHaveBeenCalledExactlyOnceWith(quote));
  expect(done).toHaveBeenCalledOnce();
});

it('keeps opening the transcription workspace read-only until an explicit request', () => {
  const request = vi.fn();
  render(<TranscriptionWorkspace media={media} onRequest={request} onDone={vi.fn()} />);
  expect(aiApi.prepareTranscription).not.toHaveBeenCalled();
  expect(aiApi.createTranscriptionQuote).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Create subtitles' }));
  expect(request).toHaveBeenCalledOnce();
});

it('distinguishes successful approval from closing setup so the caller can return to subtitles', async () => {
  const done = vi.fn();
  const started = vi.fn();
  render(<TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={done} onStarted={started} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start transcription' }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(done).not.toHaveBeenCalled();
});

it('requires explicit acknowledgement when the price is unknown', async () => {
  vi.mocked(aiApi.createTranscriptionQuote).mockResolvedValue({ ...quote, estimatedUsd: null, maximumUsd: null, unpriced: true });
  render(<TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  const start = await screen.findByRole('button', { name: 'Start transcription' });
  expect(start).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /price cannot be determined in advance/ }));
  expect(start).toBeEnabled();
  fireEvent.click(start);
  await waitFor(() => expect(aiApi.approveQuote).toHaveBeenCalledOnce());
});

it('shows the source file and selected audio track using its position among audio streams', async () => {
  vi.mocked(libraryApi.mediaStreams).mockResolvedValue([
    { index: 0, kind: 'video', codec: 'h264', isDefault: true, supportedText: false },
    { index: 1, kind: 'audio', codec: 'aac', language: 'ja', isDefault: true, supportedText: false },
    { index: 4, kind: 'audio', codec: 'aac', language: 'en', title: 'Commentary', isDefault: false, supportedText: false },
  ]);
  render(<TranscriptionWorkspace media={{ ...media, audioStreamIndex: 4 }} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  await screen.findByRole('button', { name: 'Start transcription' });
  expect(screen.getByText('audio.wav · Audio track 2 · en · Commentary', { exact: false })).toBeVisible();
  expect(screen.getByText('Recording')).toBeVisible();
});

it('prepares a selected repair range without a boundary-review or adoption step', async () => {
  render(<TranscriptionWorkspace media={media} request={{ id: 'repair', range: { startMs: 30000, endMs: 55000 } }} onRequest={vi.fn()} onDone={vi.fn()} />);
  await screen.findByRole('button', { name: 'Start transcription' });
  expect(aiApi.prepareTranscription).toHaveBeenCalledExactlyOnceWith('media', 30000, 55000, false, expect.any(String));
  expect(screen.queryByRole('button', { name: 'Adopt these subtitles' })).not.toBeInTheDocument();
});

it('keeps a preparation failure local and offers retry without creating or approving a quote', async () => {
  vi.mocked(aiApi.prepareTranscription).mockRejectedValue(new Error('Cannot extract audio'));
  render(<TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('Cannot extract audio');
  expect(screen.getByRole('button', { name: 'Prepare estimate' })).toBeEnabled();
  expect(aiApi.createTranscriptionQuote).not.toHaveBeenCalled();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
});

it('keeps the exact range in a continuation when setup is needed', async () => {
  fixture.configured = false;
  render(<TranscriptionWorkspace media={media} request={{ id: 'new', range: { startMs: 1234, endMs: 5678 } }} onRequest={vi.fn()} onDone={vi.fn()} />);
  expect(aiApi.prepareTranscription).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Set up and return' }));
  await waitFor(() => expect(fixture.navigate).toHaveBeenCalledWith({ to: '/settings', search: { resume: 'new' } }));
  expect(continuationApi.save).toHaveBeenCalledWith(expect.objectContaining({ wholeMedia: false, start: '0:01.234', end: '0:05.678', kind: 'transcribe' }));
});

it('shows ongoing received and failed ranges without requiring a draft review', () => {
  fixture.jobs = [{ id: 'running', mediaId: 'media', kind: 'transcribe', status: 'running', createdAt: '', progress: .5,
    message: 'Subtitles are appearing as results arrive', automaticTranscript: true,
    transcriptionRanges: [{ startMs: 0, endMs: 100000, state: 'received' }, { startMs: 100000, endMs: 200000, state: 'failed' }, { startMs: 200000, endMs: 300000, state: 'pending' }] }];
  const request = vi.fn();
  render(<TranscriptionWorkspace media={media} onRequest={request} onDone={vi.fn()} />);
  expect(screen.getByRole('progressbar', { name: 'Transcription progress' })).toHaveAttribute('value', '0.5');
  expect(screen.getByText('50%')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Transcribe this range again/ }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ startMs: 100000, endMs: 200000 }));
  expect(aiApi.prepareTranscription).not.toHaveBeenCalled();
});

it('does not use an old preparation result after the source changed while preparing', async () => {
  let finish!: (value: typeof preparation) => void;
  vi.mocked(aiApi.prepareTranscription).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockReturnValue(new Promise(() => {}));
  const view = render(<TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  await waitFor(() => expect(aiApi.prepareTranscription).toHaveBeenCalledOnce());
  view.rerender(<TranscriptionWorkspace media={{ ...media, audioStreamIndex: 2 }} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  await act(async () => finish(preparation));
  await waitFor(() => expect(aiApi.prepareTranscription).toHaveBeenCalledTimes(2));
  expect(aiApi.createTranscriptionQuote).not.toHaveBeenCalled();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
});

it('keeps the confirmed automatic audio choice and loads track labels after preparation', async () => {
  let finish!: (value: typeof preparation & { audioStreamIndex: number }) => void;
  vi.mocked(aiApi.prepareTranscription).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const view = render(<TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  await waitFor(() => expect(aiApi.prepareTranscription).toHaveBeenCalledOnce());
  expect(libraryApi.mediaStreams).not.toHaveBeenCalled();
  const operationId = vi.mocked(aiApi.prepareTranscription).mock.calls[0][4];
  view.rerender(<TranscriptionWorkspace media={{ ...media, audioStreamIndex: 2 }} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  await act(async () => finish({ ...preparation, audioStreamIndex: 2 }));
  await screen.findByRole('button', { name: 'Start transcription' });
  expect(aiApi.prepareTranscription).toHaveBeenCalledOnce();
  expect(aiApi.createTranscriptionQuote).toHaveBeenCalledOnce();
  expect(libraryApi.mediaStreams).toHaveBeenCalledWith(media.id, operationId);
  expect(continuationApi.save).toHaveBeenCalledWith(expect.objectContaining({ quoteId: quote.id, sourceMediaSignature: JSON.stringify([media.path, 2, media.learningLanguage, media.explanationLanguage]) }));
});

it.each([false, true])('reuses audio preparation across navigation whether it finishes away from the workspace (%s)', async finishWhileAway => {
  let finish!: (value: typeof preparation) => void;
  vi.mocked(aiApi.prepareTranscription).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = render(<TranscriptionWorkspace media={media} request={{ id: 'original' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  await waitFor(() => expect(aiApi.prepareTranscription).toHaveBeenCalledOnce());
  expect(continuationApi.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'original', wholeMedia: true, sourceMediaSignature: expect.any(String) }));
  view.rerender(<p>Another page</p>);
  if (finishWhileAway) await act(async () => finish(preparation));
  view.rerender(<TranscriptionWorkspace media={media} request={{ id: 'returned' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  if (!finishWhileAway) await act(async () => finish(preparation));
  await screen.findByRole('button', { name: 'Start transcription' });
  expect(aiApi.prepareTranscription).toHaveBeenCalledOnce();
  expect(aiApi.createTranscriptionQuote).toHaveBeenCalledOnce();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
});

it('reattaches an estimate already running on navigation without another quote or approval', async () => {
  let finish!: (value: AiQuote) => void;
  vi.mocked(aiApi.createTranscriptionQuote).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = render(<TranscriptionWorkspace media={media} request={{ id: 'original' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  await waitFor(() => expect(aiApi.createTranscriptionQuote).toHaveBeenCalledOnce());
  view.rerender(<p>Another page</p>);
  view.rerender(<TranscriptionWorkspace media={media} request={{ id: 'returned' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  await act(async () => finish(quote));
  await screen.findByRole('button', { name: 'Start transcription' });
  expect(aiApi.prepareTranscription).toHaveBeenCalledOnce();
  expect(aiApi.createTranscriptionQuote).toHaveBeenCalledOnce();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
});

it('shows only its correlated operation and resets the percentage when a new phase has no total', async () => {
  vi.mocked(aiApi.prepareTranscription).mockReturnValue(new Promise(() => {}));
  const view = render(<TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  await waitFor(() => expect(aiApi.prepareTranscription).toHaveBeenCalledOnce());
  const operationId = vi.mocked(aiApi.prepareTranscription).mock.calls[0][4]!;
  fixture.activities = [{ id: 'older-operation', source: 'native', kind: 'preparation', label: media.title, mediaId: media.id, phase: 'extracting_audio', status: 'running', completed: 99, total: 100, updatedAt: '' }];
  view.rerender(<TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  expect(screen.getByRole('progressbar', { name: media.title })).not.toHaveAttribute('value');
  fixture.activities = [{ ...fixture.activities[0], id: operationId, completed: 150000, total: 300000, unit: 'milliseconds' }];
  view.rerender(<TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  expect(screen.getByRole('progressbar', { name: media.title })).toHaveAttribute('value', '150000');
  expect(screen.getByText('2:30 / 5:00 · 50%')).toBeVisible();
  fixture.activities = [{ ...fixture.activities[0], phase: 'saving', completed: undefined, total: undefined, unit: undefined }];
  view.rerender(<TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  expect(screen.getByText('Saving')).toBeVisible();
  expect(screen.getByRole('progressbar', { name: media.title })).not.toHaveAttribute('value');
  expect(screen.queryByText(/50%/)).not.toBeInTheDocument();
});

it('cancels the correlated preparation and releases the pending state for retry', async () => {
  let cancel!: (error: Error) => void;
  vi.mocked(aiApi.prepareTranscription).mockReturnValueOnce(new Promise((_resolve, reject) => { cancel = reject; })).mockResolvedValue(preparation);
  vi.mocked(aiApi.cancelPreparation).mockImplementation(async () => { cancel(new Error('Audio preparation cancelled')); });
  render(<TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  await waitFor(() => expect(aiApi.prepareTranscription).toHaveBeenCalledOnce());
  const operationId = vi.mocked(aiApi.prepareTranscription).mock.calls[0][4];
  fireEvent.click(screen.getByRole('button', { name: 'Cancel preparation' }));
  const retry = await screen.findByRole('button', { name: 'Prepare estimate' });
  expect(aiApi.cancelPreparation).toHaveBeenCalledExactlyOnceWith(operationId);
  expect(aiApi.createTranscriptionQuote).not.toHaveBeenCalled();
  fireEvent.click(retry);
  await screen.findByRole('button', { name: 'Start transcription' });
  expect(aiApi.prepareTranscription).toHaveBeenCalledTimes(2);
  expect(vi.mocked(aiApi.prepareTranscription).mock.calls[1][4]).not.toBe(operationId);
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
});

it('discards a displayed quote on data restore and waits for an explicit new estimate', async () => {
  render(<><TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} /><RestoreData /></>);
  await screen.findByRole('button', { name: 'Start transcription' });
  fireEvent.click(screen.getByRole('button', { name: 'Restore data' }));
  expect(screen.queryByRole('button', { name: 'Start transcription' })).not.toBeInTheDocument();
  expect(screen.getByText('Data was restored. Check the source and prepare a new estimate.')).toBeVisible();
  expect(aiApi.createTranscriptionQuote).toHaveBeenCalledOnce();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare estimate' }));
  await screen.findByRole('button', { name: 'Start transcription' });
  expect(aiApi.prepareTranscription).toHaveBeenCalledTimes(2);
});

it('ignores a pending estimate after data restore without starting another request automatically', async () => {
  let finish!: (value: AiQuote) => void;
  vi.mocked(aiApi.createTranscriptionQuote).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<><TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} /><RestoreData /></>);
  await waitFor(() => expect(aiApi.createTranscriptionQuote).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'Restore data' }));
  await act(async () => finish(quote));
  expect(screen.queryByRole('button', { name: 'Start transcription' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prepare estimate' })).toBeEnabled();
  expect(aiApi.createTranscriptionQuote).toHaveBeenCalledOnce();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
});

it('uses compatible saved results with one local action and no new paid request', async () => {
  fixture.jobs = [{ id: 'old', mediaId: 'media', kind: 'transcribe', status: 'completed', createdAt: '', progress: 1, hasTranscriptResult: true }];
  const review: TranscriptReview = { jobId: 'old', mediaId: 'media', applied: false, canApply: true, repairAlternatives: [],
    draft: { id: 'draft', mediaId: 'media', sourceSha256: 'audio', sourceRevision: 'revision', digest: 'saved-digest', startMs: 0, endMs: 300000,
      canAdopt: true, segments: [], chunks: [], conflicts: [{ id: 'boundary', atMs: 1000, startMs: 0, endMs: 2000, leftOrdinal: 0, rightOrdinal: 1,
        leftAlternative: [{ startMs: 0, endMs: 2000, text: 'First retained candidate' }], rightAlternative: [{ startMs: 0, endMs: 2000, text: 'Second retained candidate' }], resolution: null }], pendingRanges: [] } };
  vi.mocked(studyApi.transcriptReview).mockResolvedValue(review);
  vi.mocked(studyApi.applyTranscriptReview).mockResolvedValue({ ...review, applied: true, canApply: false });
  render(<TranscriptionWorkspace media={media} onRequest={vi.fn()} onDone={vi.fn()} />);
  fireEvent.click(screen.getByText('Transcription history (1)'));
  fireEvent.click(screen.getByRole('button', { name: 'View subtitle history' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use saved results' }));
  await waitFor(() => expect(studyApi.applyTranscriptReview).toHaveBeenCalledExactlyOnceWith('old', 'saved-digest'));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Use saved results' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByText('Saved boundary alternatives'));
  expect(screen.getByText('First retained candidate', { exact: false })).toBeVisible();
  expect(screen.getByText('Second retained candidate', { exact: false })).toBeVisible();
  expect(aiApi.prepareTranscription).not.toHaveBeenCalled();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

const waitingJob: JobSummary = {
  id: 'waiting', mediaId: 'media', kind: 'transcribe', status: 'running', createdAt: '', progress: 1 / 3,
  message: 'Old generic provider message', automaticTranscript: true,
  retry: { state: 'waiting', ordinal: 1, retryNumber: 1, maxRetries: 2, nextRetryAt: '2026-10-10T00:00:30Z' },
  issue: { code: 'provider', phase: 'execute', httpStatus: 429, ordinal: 1, occurredAt: '2026-10-10T00:00:00Z', nextAction: 'resume' },
  transcriptionRanges: [{ startMs: 0, endMs: 100000, state: 'received' }, { startMs: 100000, endMs: 200000, state: 'pending' }, { startMs: 200000, endMs: 300000, state: 'pending' }],
};

it('counts down a native retry deadline without sending, then waits for the native retry state', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T00:00:00Z'));
  fixture.jobs = [waitingJob];
  const view = render(<TranscriptionWorkspace media={media} onRequest={vi.fn()} onDone={vi.fn()} />);
  expect(screen.getByText('Retrying in 30s')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Waiting to retry (1/2)');
  expect(screen.getByRole('button', { name: 'Pause automatic retry' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Resume remaining work' })).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(30000));
  expect(screen.getByText('Preparing to retry')).toBeVisible();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
  fixture.jobs = [{ ...waitingJob, retry: { ...waitingJob.retry!, state: 'retrying', nextRetryAt: undefined } }];
  view.rerender(<TranscriptionWorkspace media={media} onRequest={vi.fn()} onDone={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent('Retrying the busy audio range (1/2)');
  expect(screen.queryByText('Preparing to retry')).not.toBeInTheDocument();
});

it('opens the running job details from compact status even when a newer job failed', () => {
  fixture.jobs = [{ ...waitingJob, id: 'newer-failure', status: 'failed', retry: undefined }, waitingJob];
  const open = vi.fn();
  const view = render(<TranscriptionStatus mediaId="media" hasRequest={false} onOpen={open} />);
  fireEvent.click(screen.getByRole('button', { name: /View details/ }));
  expect(open).toHaveBeenCalledWith('waiting');
  view.unmount();
  render(<TranscriptionWorkspace media={media} onRequest={vi.fn()} onDone={vi.fn()} focusJobId="waiting" />);
  const target = document.querySelector('.transcription-job[data-job-id="waiting"]')!;
  expect(target).toHaveFocus();
  expect(target.querySelector('details')).toHaveAttribute('open');
  expect(target).toHaveTextContent('Range 2 · 1:40–3:20');
  expect(target).toHaveTextContent('HTTP 429');
  expect(target).toHaveTextContent('2026-10-10T00:00:00Z');
});

it.each([
  ['exhausted', 'Stopped after 2 automatic retries'],
  ['deferred', 'Stopped because the service requires waiting more than 5 minutes'],
] as const)('explains %s retries as stopped and retains received ranges', (state, message) => {
  fixture.jobs = [{ ...waitingJob, status: 'failed', retry: { ...waitingJob.retry!, state, retryNumber: 2 } }];
  render(<TranscriptionWorkspace media={media} onRequest={vi.fn()} onDone={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent(message);
  expect(screen.getByRole('status')).toHaveTextContent('Received subtitles are saved');
  expect(screen.getByRole('button', { name: 'Resume remaining work' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Pause automatic retry' })).not.toBeInTheDocument();
  expect(document.querySelectorAll('.range-received')).toHaveLength(1);
  expect(aiApi.createRetryQuote).not.toHaveBeenCalled();
  expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
});

it('explains saved HTTP 429 failures without replaying them or blaming settings', () => {
  fixture.jobs = [{ ...waitingJob, status: 'failed', retry: undefined }];
  render(<TranscriptionWorkspace media={media} onRequest={vi.fn()} onDone={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent('busy or rate limited (HTTP 429)');
  expect(screen.queryByText('Old generic provider message')).not.toBeInTheDocument();
  expect(aiApi.createRetryQuote).not.toHaveBeenCalled();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
});

it('keeps unknown-outcome recovery explicit when a saved job also records HTTP 429', () => {
  fixture.jobs = [{ ...waitingJob, status: 'unknown', retry: undefined }];
  render(<TranscriptionWorkspace media={media} onRequest={vi.fn()} onDone={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent('rate limit (HTTP 429)');
  expect(screen.getByRole('status')).toHaveTextContent('Review requests with an unknown outcome');
  expect(screen.queryByText(/Review an estimate to resume/)).not.toBeInTheDocument();
  expect(aiApi.createRetryQuote).not.toHaveBeenCalled();
  expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
});

it.each([
  ['en', false], ['en', true], ['ja', false], ['ja', true],
] as const)('shows %s pacing slowed=%s, details and a native-only countdown while retaining received ranges', (locale, slowed) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T00:00:00Z'));
  fixture.locale = locale;
  const seconds = slowed ? 40 : 10;
  const pacedJob: JobSummary = { ...waitingJob, retry: undefined,
    pacing: { ordinal: 1, nextSendAt: new Date(Date.now() + seconds * 1000).toISOString(), intervalMs: seconds * 1000, slowed },
  };
  fixture.jobs = [pacedJob];
  const open = vi.fn();
  const compact = render(<TranscriptionStatus mediaId="media" hasRequest={false} onOpen={open} />);
  expect(screen.getByRole('status')).toHaveTextContent(locale === 'ja'
    ? slowed ? '混雑を避けるため送信間隔を調整中' : '送信間隔を調整中'
    : slowed ? 'Spacing out requests to reduce congestion.' : 'Spacing out requests.');
  expect(screen.queryByText(/HTTP 429/)).not.toBeInTheDocument();
  expect(screen.getByText('33%')).toBeVisible();
  fireEvent.click(screen.getByRole('button'));
  expect(open).toHaveBeenCalledExactlyOnceWith(pacedJob.id);
  compact.unmount();
  const view = render(<TranscriptionWorkspace media={media} onRequest={vi.fn()} onDone={vi.fn()} focusJobId={pacedJob.id} />);
  expect(screen.getByText(locale === 'ja' ? `${seconds}秒後に次の区間を送信` : `Next request in ${seconds}s`)).toBeVisible();
  expect(screen.getByText(locale === 'ja' ? '区間 2' : 'Range 2', { exact: false })).toHaveTextContent('1:40–3:20');
  expect(screen.getByText(locale === 'ja' ? `${seconds}秒以上` : `At least ${seconds}s`)).toBeVisible();
  expect(screen.getByRole('button', { name: locale === 'ja' ? '次の送信前に一時停止' : 'Pause before next request' })).toBeEnabled();
  expect(screen.getByRole('button', { name: locale === 'ja' ? '中止' : 'Cancel' })).toBeEnabled();
  expect(document.querySelectorAll('.range-received')).toHaveLength(1);
  expect(screen.queryByText(/HTTP 429/)).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(seconds * 1000));
  expect(screen.getByText(locale === 'ja' ? '次の送信を準備中' : 'Preparing the next request')).toBeVisible();
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
  expect(aiApi.createRetryQuote).not.toHaveBeenCalled();
  fixture.jobs = [{ ...pacedJob, status: 'paused', message: 'Paused' }];
  view.rerender(<TranscriptionWorkspace media={media} onRequest={vi.fn()} onDone={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent('Paused');
  expect(screen.queryByText(locale === 'ja' ? '次の送信を準備中' : 'Preparing the next request')).not.toBeInTheDocument();
});

it('gives native retry timing precedence when a snapshot also includes pacing', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T00:00:00Z'));
  fixture.jobs = [{ ...waitingJob, pacing: { ordinal: 2, nextSendAt: '2026-10-10T00:00:10Z', intervalMs: 10000, slowed: false } }];
  render(<TranscriptionWorkspace media={media} onRequest={vi.fn()} onDone={vi.fn()} focusJobId={waitingJob.id} />);
  expect(screen.getByRole('status')).toHaveTextContent('Waiting to retry (1/2)');
  expect(screen.getByText('Retrying in 30s')).toBeVisible();
  expect(screen.getByText('Range 2', { exact: false })).toHaveTextContent('1:40–3:20');
  expect(screen.queryByText('Next request scheduled')).not.toBeInTheDocument();
  expect(screen.queryByText(/Spacing out/)).not.toBeInTheDocument();
});

it('keeps an unrepresentable pacing deadline waiting without an invented date and permits pause or cancel', async () => {
  fixture.jobs = [{ ...waitingJob, retry: undefined,
    pacing: { ordinal: 1, intervalMs: 60000, slowed: true },
  }];
  render(<TranscriptionWorkspace media={media} onRequest={vi.fn()} onDone={vi.fn()} focusJobId={waitingJob.id} />);
  expect(screen.getByRole('status')).toHaveTextContent('Spacing out requests to reduce congestion.');
  expect(screen.getByText('The next allowed send time is unavailable')).toBeVisible();
  expect(document.querySelector('time')).not.toBeInTheDocument();
  expect(document.querySelector('.retry-countdown')).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/NaN|Invalid Date|Preparing the next request/);
  fireEvent.click(screen.getByRole('button', { name: 'Pause before next request' }));
  await waitFor(() => expect(aiApi.pauseAiJob).toHaveBeenCalledExactlyOnceWith(waitingJob.id));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(aiApi.cancelAiJob).toHaveBeenCalledExactlyOnceWith(waitingJob.id));
  expect(aiApi.approveQuote).not.toHaveBeenCalled();
  expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
  expect(aiApi.createRetryQuote).not.toHaveBeenCalled();
});
