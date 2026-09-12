// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TranscriptReviewDialog } from '../components/TranscriptReview';
import { api, type TranscriptReview } from '../api';

vi.mock('../api', () => ({ api: { transcriptReview: vi.fn(), transcriptResultDetail: vi.fn(), saveManualTranscriptRange: vi.fn(), selectTranscriptRangeSource: vi.fn(), pauseAiJob: vi.fn(), applyTranscriptReview: vi.fn(), prepareBoundaryRepair: vi.fn(), approveQuote: vi.fn(), loadMedia: vi.fn(), playerState: vi.fn(), player: vi.fn() }, nativeAvailable: () => true }));
const registerModal = () => () => {};
const runAction = async (action: () => Promise<unknown>) => { try { return await action(); } catch { return undefined; } };
vi.mock('../context', () => ({ useApp: () => ({ t: (_ja: string, en: string) => en, run: runAction, registerModal }) }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const pending: TranscriptReview = {
  jobId: 'job', mediaId: 'media', applied: false, canApply: false, repairAlternatives: [], manualEditingBlockedReason: null,
  results: [{ ordinal: 0, state: 'invalid', reason: 'invalid_word_timing', attemptState: 'unknown', reparses: [] }],
  rangeEdits: [{ ordinal: 0, version: 0, selectedRevisionId: null, latestRevision: null }],
  draft: { id: 'draft', mediaId: 'media', sourceSha256: 'source', sourceRevision: 'revision', digest: 'draft-original', startMs: 0, endMs: 5000, canAdopt: false, segments: [], conflicts: [], pendingRanges: [{ startMs: 0, endMs: 5000 }],
    chunks: [{ ordinal: 0, coreStartMs: 0, coreEndMs: 5000, requestStartMs: 0, requestEndMs: 5000, status: 'pending', source: 'unresolved', segments: [], originalSegments: [] }] },
};
async function openRange(view = pending) {
  vi.mocked(api.transcriptReview).mockResolvedValue(view);
  render(<TranscriptReviewDialog jobId="job" onClose={() => {}} />);
  fireEvent.change(await screen.findByLabelText('Audio range to correct'), { target: { value: '0' } });
  return within(screen.getByRole('region', { name: 'Correct range 1' }));
}

describe('manual recovery of invalid or missing transcript ranges', () => {
  it('requires explicit no-speech confirmation and saves without adopting or sending', async () => {
    const range = await openRange();
    const save = range.getByRole('button', { name: 'Save correction and select for preview' });
    expect(save).toBeDisabled();
    expect(range.getByText(/unresolved cost reservation is retained/)).toBeVisible();
    fireEvent.click(range.getByRole('checkbox'));
    expect(save).toBeEnabled();
    vi.mocked(api.saveManualTranscriptRange).mockRejectedValue(new Error('stale range version'));
    fireEvent.click(save);
    await waitFor(() => expect(api.saveManualTranscriptRange).toHaveBeenCalledExactlyOnceWith('job', 'draft-original', 0, 0, { kind: 'confirmed_no_speech' }));
    expect(api.applyTranscriptReview).not.toHaveBeenCalled();
    expect(api.approveQuote).not.toHaveBeenCalled();
    expect(api.prepareBoundaryRepair).not.toHaveBeenCalled();
    expect(range.getByRole('checkbox')).toBeChecked();
  });

  it('copies only text from invalid evidence and requires user-entered valid times', async () => {
    const view: TranscriptReview = { ...pending, results: [{ ...pending.results![0], evidence: { attemptId: 'attempt', jobId: 'job', ordinal: 0, inputSha256: 'input', requestSha256: 'request', taskSha256: 'task', modelId: 'model', parserRevision: 'v1', complete: true, state: 'invalid', reason: 'reversed_time' } }] };
    vi.mocked(api.transcriptResultDetail).mockResolvedValue({ ...view.results![0], evidence: { ...view.results![0].evidence!, response: { candidates: [{ content: { parts: [{ audioTranscription: { text: 'No, no. <script>stay</script>', words: [{ word: 'No', startOffset: '4s', endOffset: '1s' }] } }] } }] } } });
    const range = await openRange(view);
    fireEvent.click(range.getByRole('button', { name: 'Add text from saved response' }));
    const text = await range.findByLabelText('Text');
    expect(text).toHaveValue('No, no. <script>stay</script>');
    expect(range.getByLabelText('From')).toHaveValue('');
    expect(range.getByLabelText('To')).toHaveValue('');
    expect(document.querySelector('script')).toBeNull();
    const save = range.getByRole('button', { name: 'Save correction and select for preview' });
    expect(save).toBeDisabled();
    fireEvent.change(range.getByLabelText('From'), { target: { value: '00:00:01.000' } });
    fireEvent.change(range.getByLabelText('To'), { target: { value: '00:00:06.000' } });
    expect(save).toBeDisabled();
    fireEvent.change(range.getByLabelText('To'), { target: { value: '00:00:02.000' } });
    vi.mocked(api.saveManualTranscriptRange).mockResolvedValue(view);
    fireEvent.click(save);
    await waitFor(() => expect(api.saveManualTranscriptRange).toHaveBeenCalledExactlyOnceWith('job', 'draft-original', 0, 0, { kind: 'subtitles', segments: [{ startMs: 1000, endMs: 2000, text: 'No, no. <script>stay</script>' }] }));
  });

  it('blocks edits during sending and pauses explicitly before reloading', async () => {
    const range = await openRange({ ...pending, manualEditingBlockedReason: 'job_active' });
    expect(range.getByRole('button', { name: 'Add row' })).toBeDisabled();
    vi.mocked(api.transcriptReview).mockResolvedValue(pending);
    vi.mocked(api.pauseAiJob).mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Pause sending and check' }));
    await waitFor(() => expect(api.pauseAiJob).toHaveBeenCalledExactlyOnceWith('job'));
    await waitFor(() => expect(range.getByRole('button', { name: 'Add row' })).toBeEnabled());
    expect(api.saveManualTranscriptRange).not.toHaveBeenCalled();
  });

  it('preserves the original invalid status and selects the stored correction explicitly', async () => {
    const content = { kind: 'subtitles' as const, segments: [{ startMs: 1000, endMs: 2000, text: 'I said no, no.' }] };
    const revision = { id: 'manual-1', ordinal: 0, createdAt: '2026-09-12T00:00:00Z', content };
    const view: TranscriptReview = { ...pending, rangeEdits: [{ ordinal: 0, version: 2, selectedRevisionId: null, latestRevision: revision }] };
    const range = await openRange(view);
    expect(range.getByText('Original response: Received, invalid')).toBeVisible();
    vi.mocked(api.selectTranscriptRangeSource).mockResolvedValue({ ...view, rangeEdits: [{ ordinal: 0, version: 3, selectedRevisionId: revision.id, latestRevision: revision }], draft: { ...view.draft, digest: 'manual-digest', chunks: [{ ...view.draft.chunks[0], status: 'received', source: 'manual', segments: content.segments }] } });
    fireEvent.click(range.getByRole('button', { name: 'Reselect saved correction' }));
    await waitFor(() => expect(api.selectTranscriptRangeSource).toHaveBeenCalledExactlyOnceWith('job', 'draft-original', 0, 2, { kind: 'manual', revisionId: 'manual-1' }));
    expect(await screen.findByText('Manual correction selected')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Return to previous result' })).toBeEnabled();
    expect(api.applyTranscriptReview).not.toHaveBeenCalled();
  });
});
