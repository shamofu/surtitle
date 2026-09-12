// SPDX-License-Identifier: GPL-3.0-or-later
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DraftStudyPanel } from '../components/DraftStudyPanel';
import { api } from '../api';
import type { AiModelPreference, AiQuote, AppSnapshot, Media, TranscriptReview } from '../api';
import { draftStudyApi, savedDraftText } from '../draft-study';
import type { DraftSelection } from '../draft-study';

const context = vi.hoisted(() => ({ data: undefined as AppSnapshot | undefined, register: () => () => {}, run: async <T,>(action: () => Promise<T>) => { try { return await action(); } catch { return undefined; } } }));
vi.mock('../context', () => ({ useApp: () => ({ data: context.data, t: (_ja: string, en: string) => en, run: context.run, registerModal: context.register }) }));
vi.mock('../api', () => ({ nativeAvailable: () => true, api: { transcriptReview: vi.fn(), transcriptResultDetail: vi.fn(), approveQuote: vi.fn() } }));
vi.mock('../draft-study', async importOriginal => {
  const actual = await importOriginal<typeof import('../draft-study')>();
  return { ...actual, draftStudyApi: { list: vi.fn(), prepare: vi.fn(), update: vi.fn(), saveCard: vi.fn(), createQuote: vi.fn(), candidates: vi.fn(), export: vi.fn(), remove: vi.fn() } };
});
vi.mock('../components/ModelEditor', () => ({
  emptyModel: () => ({ modelId: '', transcriptionMode: 'transcribe', maxOutputTokens: 4096 }),
  ModelEditor: ({ value, onChange }: { value: AiModelPreference; onChange: (value: AiModelPreference) => void }) => <input aria-label="Gemini model ID" value={value.modelId} onChange={event => onChange({ ...value, modelId: event.target.value })} />,
}));

const media: Media = { id: 'media', title: 'A test conversation', path: 'fixture.wav', kind: 'audio', durationMs: 6000, learningLanguage: 'en', explanationLanguage: 'ja', createdAt: '2026-09-12', lastPositionMs: 0, segmentCount: 0, cardCount: 0, status: 'ready' };
const review: TranscriptReview = {
  jobId: 'job', mediaId: media.id, applied: false, canApply: false, repairAlternatives: [],
  draft: { id: 'draft', mediaId: media.id, sourceSha256: 'source', sourceRevision: 'revision', digest: 'draft-digest', startMs: 0, endMs: 6000, canAdopt: false,
    segments: [{ id: 'cue-1', startMs: 1000, endMs: 2500, text: 'Blue, blue beagle.', status: 'provisional' }],
    chunks: [{ ordinal: 0, coreStartMs: 0, coreEndMs: 3000, requestStartMs: 0, requestEndMs: 5000, status: 'received', source: 'provider', segments: [{ startMs: 1000, endMs: 2500, text: 'Blue, blue beagle.' }] }, { ordinal: 1, coreStartMs: 3000, coreEndMs: 6000, requestStartMs: 2000, requestEndMs: 6000, status: 'pending', source: 'unresolved', segments: [] }],
    conflicts: [{ id: 'conflict', atMs: 2000, startMs: 2000, endMs: 3000, leftOrdinal: 0, rightOrdinal: 1, leftAlternative: [], rightAlternative: [], resolution: null }],
    pendingRanges: [{ startMs: 3000, endMs: 6000 }],
  },
};
const selection: DraftSelection = { id: 'selection', mediaId: media.id, jobId: 'job', version: 0, text: 'Blue, blue beagle.', startMs: 1000, endMs: 2500, sourceStartMs: 0, sourceEndMs: 5000, cueIds: ['cue-1'], origin: 'ai', timing: 'cue', confirmed: false, stale: false, blockingReasons: [], canConfirm: true, createdAt: '2026-09-12', updatedAt: '2026-09-12' };
let bookmarks: DraftSelection[];
const model: AiModelPreference = { modelId: 'arbitrary-model', transcriptionMode: 'transcribe', maxOutputTokens: 4096 };

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
});
afterAll(() => { Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close'); });
beforeEach(() => {
  bookmarks = [];
  context.data = { media: [media], cards: [], tools: [], jobs: [{ id: 'job', mediaId: media.id, kind: 'transcribe', status: 'paused', progress: 0.5, createdAt: '2026-09-12', transcriptReview: true }], settings: { theme: 'dark', locale: 'en', learningLanguage: 'en', explanationLanguage: 'ja', dailyBudgetUsd: 0, vertexProject: '', vertexLocation: 'global', credentialConfigured: false, retention: 0.9, aiModels: { vocabulary: model, explanation: model } }, budget: { spentUsd: 0, reservedUsd: 0, limitUsd: 0 } };
  vi.mocked(api.transcriptReview).mockResolvedValue(review);
  vi.mocked(api.approveQuote).mockResolvedValue(undefined);
  vi.mocked(draftStudyApi.list).mockImplementation(async () => bookmarks);
  vi.mocked(draftStudyApi.prepare).mockImplementation(async () => { bookmarks = [{ ...selection }]; return bookmarks[0]; });
  vi.mocked(draftStudyApi.update).mockImplementation(async request => { bookmarks = [{ ...selection, ...request, version: request.version + 1, confirmed: request.confirm }]; return bookmarks[0]; });
  vi.mocked(draftStudyApi.candidates).mockResolvedValue([]);
  vi.mocked(draftStudyApi.saveCard).mockResolvedValue(undefined);
  vi.mocked(draftStudyApi.export).mockResolvedValue(undefined);
  vi.mocked(draftStudyApi.remove).mockImplementation(async () => { bookmarks = []; });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

async function openSelection(overrides: Partial<DraftSelection> = {}) {
  const value = { ...selection, ...overrides };
  vi.mocked(draftStudyApi.prepare).mockImplementation(async () => { bookmarks = [value]; return value; });
  const onPlay = vi.fn().mockResolvedValue(undefined);
  const onReview = vi.fn();
  const component = render(<DraftStudyPanel media={media} playbackReady onPlay={onPlay} onReview={onReview} />);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Select subtitle: Blue, blue beagle.' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep selected subtitles for later' }));
  const editor = within(await screen.findByRole('region', { name: 'Check selected phrase' }));
  return { ...component, editor, onPlay, onReview };
}

describe('study from independently saved draft excerpts', () => {
  it('offers received cues while adoption is blocked and creates only a local bookmark', async () => {
    const { editor, onReview } = await openSelection();
    expect(screen.getByText(/Some ranges are pending or need review/)).toBeVisible();
    expect(screen.getByText('Conflicting alternatives')).toBeVisible();
    expect(draftStudyApi.prepare).toHaveBeenCalledExactlyOnceWith({ jobId: 'job', cueIds: ['cue-1'] });
    expect(editor.getByRole('button', { name: 'Create an audio card' })).toBeDisabled();
    expect(editor.getByRole('button', { name: 'AI help for this phrase' })).toBeDisabled();
    expect(draftStudyApi.saveCard).not.toHaveBeenCalled();
    expect(draftStudyApi.createQuote).not.toHaveBeenCalled();
    expect(api.approveQuote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review or adopt the full result' }));
    expect(onReview).toHaveBeenCalledExactlyOnceWith('job');
  });

  it('requires current audio replay and explicit confirmation; editing invalidates both', async () => {
    const { editor, onPlay } = await openSelection();
    const acknowledge = editor.getByRole('checkbox');
    expect(acknowledge).toBeDisabled();
    fireEvent.click(editor.getByRole('button', { name: 'Play audio for this text' }));
    await waitFor(() => expect(acknowledge).toBeEnabled());
    expect(onPlay).toHaveBeenCalledExactlyOnceWith({ startMs: 1000, endMs: 2500 });
    fireEvent.click(acknowledge);
    expect(editor.getByRole('button', { name: 'Confirm this text and audio' })).toBeEnabled();
    fireEvent.change(editor.getByLabelText('Text to learn'), { target: { value: 'Blue beagle.' } });
    expect(acknowledge).not.toBeChecked();
    expect(acknowledge).toBeDisabled();
    fireEvent.click(editor.getByRole('button', { name: 'Play audio for this text' }));
    await waitFor(() => expect(acknowledge).toBeEnabled());
    fireEvent.click(acknowledge);
    fireEvent.click(editor.getByRole('button', { name: 'Confirm this text and audio' }));
    await waitFor(() => expect(draftStudyApi.update).toHaveBeenCalledExactlyOnceWith({ id: selection.id, version: 0, text: 'Blue beagle.', startMs: 1000, endMs: 2500, confirm: true }));
    expect(await screen.findByRole('button', { name: 'Create an audio card' })).toBeEnabled();
    expect(api.approveQuote).not.toHaveBeenCalled();
  });

  it('retains invalid-timing raw text as source-block text without word or cue synchronization', async () => {
    vi.mocked(api.transcriptResultDetail).mockResolvedValue({ ordinal: 1, state: 'invalid', reason: 'reversed_time', reparses: [], evidence: { attemptId: 'attempt', jobId: 'job', ordinal: 1, inputSha256: 'input', requestSha256: 'request', taskSha256: 'task', modelId: 'model', parserRevision: 'v1', complete: true, state: 'invalid', reason: 'reversed_time', response: { candidates: [{ content: { parts: [{ audioTranscription: { text: 'No, no. <script>repeat</script>', words: [{ word: 'No', startOffset: '8s', endOffset: '1s' }] } }] } }] } } });
    const onPlay = vi.fn();
    render(<DraftStudyPanel media={media} playbackReady onPlay={onPlay} onReview={() => {}} />);
    fireEvent.click(await screen.findByText('Source audio ranges and saved text'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Show saved text' })[1]);
    expect(await screen.findByText('No, no. <script>repeat</script>')).toBeVisible();
    expect(screen.getByText('AI text · no verified text timing')).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /No, no/ })).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Play source block' })[1]);
    await waitFor(() => expect(onPlay).toHaveBeenCalledExactlyOnceWith({ startMs: 2000, endMs: 6000 }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Keep this source block for later' })[1]);
    await waitFor(() => expect(draftStudyApi.prepare).toHaveBeenCalledExactlyOnceWith({ jobId: 'job', ordinal: 1 }));
  });

  it('saves a postponed revision without enabling card or AI actions', async () => {
    const { editor } = await openSelection();
    fireEvent.change(editor.getByLabelText('Text to learn'), { target: { value: 'Check this later.' } });
    fireEvent.click(editor.getByRole('button', { name: 'Save unchecked for later' }));
    await waitFor(() => expect(draftStudyApi.update).toHaveBeenCalledExactlyOnceWith({ id: selection.id, version: 0, text: 'Check this later.', startMs: 1000, endMs: 2500, confirm: false }));
    expect(screen.getByRole('button', { name: 'Create an audio card' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'AI help for this phrase' })).toBeDisabled();
  });

  it('keeps replay times within source bounds and does not accept reversed or empty ranges', async () => {
    const { editor, onPlay } = await openSelection();
    for (const value of ['0:00.500', '0:01', '0:06', 'garbage']) {
      fireEvent.change(editor.getByLabelText('Replay to'), { target: { value } });
      expect(editor.getByRole('button', { name: 'Play audio for this text' })).toBeDisabled();
      expect(editor.getByRole('button', { name: 'Save unchecked for later' })).toBeDisabled();
    }
    expect(onPlay).not.toHaveBeenCalled();
    expect(draftStudyApi.update).not.toHaveBeenCalled();
  });

  it('does not mark a failed player command as listened', async () => {
    const { editor, onPlay } = await openSelection();
    onPlay.mockRejectedValue(new Error('player source changed'));
    fireEvent.click(editor.getByRole('button', { name: 'Play audio for this text' }));
    await waitFor(() => expect(onPlay).toHaveBeenCalledTimes(1));
    expect(editor.getByRole('checkbox')).toBeDisabled();
    expect(editor.getByRole('button', { name: 'Confirm this text and audio' })).toBeDisabled();
  });

  it('blocks stale learning actions while retaining JSON export and removal', async () => {
    const { editor } = await openSelection({ stale: true, confirmed: true, canConfirm: false, blockingReasons: ['The source changed. Prepare a fresh selection.'] });
    expect(editor.getByText('The source changed. Prepare a fresh selection.')).toBeVisible();
    expect(editor.getByRole('button', { name: 'Create an audio card' })).toBeDisabled();
    expect(editor.getByRole('button', { name: 'AI help for this phrase' })).toBeDisabled();
    fireEvent.click(editor.getByText('Export or remove this draft'));
    expect(editor.getByRole('option', { name: 'SRT' })).toBeDisabled();
    fireEvent.click(editor.getByRole('button', { name: 'Export this draft' }));
    await waitFor(() => expect(draftStudyApi.export).toHaveBeenCalledExactlyOnceWith({ id: 'selection', version: 0, format: 'json' }));
    fireEvent.click(editor.getByRole('button', { name: 'Remove from kept drafts' }));
    await waitFor(() => expect(draftStudyApi.remove).toHaveBeenCalledExactlyOnceWith({ id: 'selection', version: 0 }));
    expect(screen.queryByRole('region', { name: 'Check selected phrase' })).toBeNull();
  });

  it('requires form review and saves cards only from the confirmed selection identity', async () => {
    const { editor } = await openSelection({ confirmed: true, version: 3 });
    fireEvent.click(editor.getByRole('button', { name: 'Create an audio card' }));
    const card = within(screen.getByRole('dialog', { name: 'Keep this phrase' }));
    expect(card.getByRole('button', { name: 'Save card and audio' })).toBeDisabled();
    fireEvent.change(card.getByLabelText('Phrase to remember'), { target: { value: 'beagle' } });
    fireEvent.change(card.getByLabelText('Meaning'), { target: { value: 'A type of dog.' } });
    fireEvent.click(card.getByRole('button', { name: 'Save card and audio' }));
    await waitFor(() => expect(draftStudyApi.saveCard).toHaveBeenCalledExactlyOnceWith({ selectionId: 'selection', version: 3, term: 'beagle', meaning: 'A type of dog.', explanation: undefined, translation: undefined }));
    expect(draftStudyApi.createQuote).not.toHaveBeenCalled();
    expect(api.approveQuote).not.toHaveBeenCalled();
  });

  it('estimates only checked text and requires the existing separate quote approval', async () => {
    const quote: AiQuote = { id: 'quote', mediaId: media.id, kind: 'vocabulary', startMs: 1000, endMs: 2500, model: 'arbitrary-model', estimatedUsd: 0.01, maximumUsd: 0.02, inputTokens: 200, maxOutputTokens: 4096, expiresAt: new Date(Date.now() + 60000).toISOString(), warnings: ['AI suggestions require review.'], canApprove: true, digest: 'quote-digest' };
    vi.mocked(draftStudyApi.createQuote).mockResolvedValue(quote);
    const { editor } = await openSelection({ confirmed: true, version: 2 });
    fireEvent.click(editor.getByRole('button', { name: 'AI help for this phrase' }));
    const dialog = within(screen.getByRole('dialog', { name: 'AI for this phrase' }));
    fireEvent.change(dialog.getByLabelText('Phrase to explain (leave blank for suggestions)'), { target: { value: 'beagle' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Estimate using this checked text' }));
    await waitFor(() => expect(draftStudyApi.createQuote).toHaveBeenCalledExactlyOnceWith({ selectionId: 'selection', version: 2, focusTerm: 'beagle', model }));
    expect(api.approveQuote).not.toHaveBeenCalled();
    const approve = await dialog.findByRole('button', { name: 'Approve this job' });
    expect(approve).toBeDisabled();
    fireEvent.click(dialog.getByRole('checkbox'));
    fireEvent.click(approve);
    await waitFor(() => expect(api.approveQuote).toHaveBeenCalledExactlyOnceWith(quote));
  });

  it('shows only selection-bound AI results and opens them for manual card review', async () => {
    vi.mocked(draftStudyApi.candidates).mockResolvedValue([{ id: 'candidate', mediaId: media.id, segmentId: 'private-selection-source', term: 'beagle', meaning: 'A small hound.', example: 'A model-generated example must not replace the checked excerpt.', explanation: 'Dog breed.', translation: 'ビーグル' }]);
    await openSelection({ confirmed: true, version: 4 });
    fireEvent.click(await screen.findByRole('button', { name: 'Review and save this suggestion' }));
    const card = within(screen.getByRole('dialog', { name: 'Keep this phrase' }));
    expect(draftStudyApi.candidates).toHaveBeenCalledWith({ id: 'selection', version: 4 });
    expect(card.getByLabelText('Meaning')).toHaveValue('A small hound.');
    expect(card.getByText('Blue, blue beagle.')).toBeVisible();
    expect(card.queryByText(/model-generated example/)).toBeNull();
    expect(draftStudyApi.saveCard).not.toHaveBeenCalled();
    fireEvent.change(card.getByLabelText('Meaning'), { target: { value: 'A breed of small hound.' } });
    fireEvent.click(card.getByRole('button', { name: 'Save card and audio' }));
    await waitFor(() => expect(draftStudyApi.saveCard).toHaveBeenCalledExactlyOnceWith({ selectionId: 'selection', version: 4, term: 'beagle', meaning: 'A breed of small hound.', explanation: 'Dog breed.', translation: 'ビーグル' }));
  });

  it('does not overwrite active edits when new draft results arrive', async () => {
    const { editor } = await openSelection();
    fireEvent.change(editor.getByLabelText('Text to learn'), { target: { value: 'My checked wording in progress.' } });
    vi.mocked(api.transcriptReview).mockResolvedValue({ ...review, draft: { ...review.draft, digest: 'later', segments: [{ ...review.draft.segments[0], text: 'A late provider version.' }] } });
    await screen.findByText('A late provider version.', {}, { timeout: 3500 });
    expect(editor.getByLabelText('Text to learn')).toHaveValue('My checked wording in progress.');
    expect(draftStudyApi.update).not.toHaveBeenCalled();
  });

  it('ignores late review and preparation results after changing media', async () => {
    let complete!: (value: DraftSelection) => void;
    vi.mocked(draftStudyApi.prepare).mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const component = render(<DraftStudyPanel media={media} playbackReady onPlay={() => {}} onReview={() => {}} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select subtitle: Blue, blue beagle.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep selected subtitles for later' }));
    context.data = { ...context.data!, jobs: [] };
    component.rerender(<DraftStudyPanel media={{ ...media, id: 'another-media' }} playbackReady onPlay={() => {}} onReview={() => {}} />);
    await act(async () => { complete(selection); });
    expect(screen.queryByRole('region', { name: 'Check selected phrase' })).toBeNull();
    expect(screen.queryByText('Blue, blue beagle.')).toBeNull();
    expect(draftStudyApi.saveCard).not.toHaveBeenCalled();
  });

  it('serializes polling and stops scheduling reads after unmount', async () => {
    vi.useFakeTimers();
    let finish!: (value: TranscriptReview) => void;
    vi.mocked(api.transcriptReview).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const component = render(<DraftStudyPanel media={media} playbackReady onPlay={() => {}} onReview={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(api.transcriptReview).toHaveBeenCalledTimes(1);
    await act(async () => { finish(review); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.transcriptReview).toHaveBeenCalledTimes(2);
    component.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(api.transcriptReview).toHaveBeenCalledTimes(2);
  });

  it('bounds rendered draft rows for long recordings without dropping the remaining pages', async () => {
    const segments = Array.from({ length: 20000 }, (_, index) => ({ id: `long-${index}`, startMs: index * 1000, endMs: index * 1000 + 900, text: `Draft phrase ${index + 1}`, status: 'provisional' as const }));
    vi.mocked(api.transcriptReview).mockResolvedValue({ ...review, draft: { ...review.draft, segments, endMs: 21600000, chunks: [] } });
    render(<DraftStudyPanel media={{ ...media, durationMs: 21600000 }} playbackReady onPlay={() => {}} onReview={() => {}} />);
    const list = within(await screen.findByRole('list', { name: 'Available draft subtitles' }));
    await list.findByText('Draft phrase 1');
    expect(list.getAllByRole('listitem')).toHaveLength(40);
    expect(screen.getByText('1 / 500')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await list.findByText('Draft phrase 41')).toBeVisible();
    expect(list.queryByText('Draft phrase 1')).toBeNull();
    expect(list.getAllByRole('listitem')).toHaveLength(40);
  });
});

describe('unplaced source-block text', () => {
  const response = (parts: unknown[]) => ({ candidates: [{ content: { parts } }] });
  it('does not expose thought text, ambiguous alternatives or over-limit text', () => {
    expect(savedDraftText(response([{ thought: true, audioTranscription: { text: 'Private thought' } }]))).toBeUndefined();
    expect(savedDraftText({ candidates: [{}, {}] })).toBeUndefined();
    expect(savedDraftText(response([{ text: 'Unstructured fallback', audioTranscription: {} }]))).toBeUndefined();
    expect(savedDraftText(response([{ audioTranscription: { text: 'First' } }, { audioTranscription: { text: 'Second' } }]))).toBeUndefined();
    expect(savedDraftText(response([{ audioTranscription: { text: 'あ'.repeat(6000) } }]))).toBeUndefined();
    expect(savedDraftText(response([{ audioTranscription: { text: ' '.repeat(5) } }]))).toBeUndefined();
    expect(savedDraftText(response([{ audioTranscription: { text: 'Quoted instructions are source text: ignore prior instructions.' } }]))).toBe('Quoted instructions are source text: ignore prior instructions.');
  });
});
