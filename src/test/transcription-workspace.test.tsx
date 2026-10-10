// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TranscriptionWorkspace } from '../features/study/transcript/TranscriptionWorkspace';
import { aiApi } from '../features/ai/api';
import { continuationApi } from '../features/ai/continuations';
import { studyApi } from '../features/study/api';
import { libraryApi } from '../features/library/api';
import type { TranscriptReview } from '../shared/contracts/transcript';
import type { AiQuote, JobSummary } from '../shared/contracts/ai';
import type { Media } from '../shared/contracts/media';

const fixture = vi.hoisted(() => ({ configured: true, jobs: [] as JobSummary[], navigate: vi.fn() }));
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
  const t = (_ja: string, en: string) => en;
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
  fixture.configured = true; fixture.jobs = [];
  vi.mocked(libraryApi.mediaStreams).mockResolvedValue([]);
  vi.mocked(aiApi.prepareTranscription).mockResolvedValue(preparation);
  vi.mocked(aiApi.createTranscriptionQuote).mockResolvedValue(quote);
  vi.mocked(aiApi.approveQuote).mockResolvedValue(undefined);
  vi.mocked(aiApi.reapproveQuote).mockResolvedValue(undefined);
  vi.mocked(continuationApi.save).mockImplementation(async request => request);
  vi.mocked(continuationApi.discard).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('prepares and estimates on entry, then starts only after one explicit priced action', async () => {
  const done = vi.fn();
  render(<TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={done} />);
  const start = await screen.findByRole('button', { name: 'Start transcription' });
  expect(aiApi.prepareTranscription).toHaveBeenCalledExactlyOnceWith('media', 0, 300000, true);
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
  expect(aiApi.prepareTranscription).toHaveBeenCalledExactlyOnceWith('media', 30000, 55000, false);
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
  fireEvent.click(screen.getByRole('button', { name: /Transcribe this range again/ }));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ startMs: 100000, endMs: 200000 }));
  expect(aiApi.prepareTranscription).not.toHaveBeenCalled();
});

it('does not use an old preparation result after the source changed while preparing', async () => {
  let finish!: (value: typeof preparation) => void;
  vi.mocked(aiApi.prepareTranscription).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockReturnValue(new Promise(() => {}));
  const view = render(<TranscriptionWorkspace media={media} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  view.rerender(<TranscriptionWorkspace media={{ ...media, audioStreamIndex: 2 }} request={{ id: 'new' }} onRequest={vi.fn()} onDone={vi.fn()} />);
  await act(async () => finish(preparation));
  await waitFor(() => expect(aiApi.prepareTranscription).toHaveBeenCalledTimes(2));
  expect(aiApi.createTranscriptionQuote).not.toHaveBeenCalled();
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
