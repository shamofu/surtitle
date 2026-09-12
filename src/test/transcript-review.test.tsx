// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TranscriptReviewDialog } from '../components/TranscriptReview';
import { api } from '../api';
import type { PlayerState, TranscriptReview } from '../api';

vi.mock('../api', () => ({ api: { transcriptReview: vi.fn(), transcriptResultDetail: vi.fn(), reparseTranscriptEvidence: vi.fn(), selectTranscriptReparse: vi.fn(), saveManualTranscriptRange: vi.fn(), selectTranscriptRangeSource: vi.fn(), pauseAiJob: vi.fn(), resolveTranscriptBoundary: vi.fn(), acknowledgeTranscriptWarning: vi.fn(), applyTranscriptReview: vi.fn(), prepareBoundaryRepair: vi.fn(), approveQuote: vi.fn(), loadMedia: vi.fn(), playerState: vi.fn(), player: vi.fn() }, nativeAvailable: () => true }));
const registerModal = () => () => {};
const runAction = async (action: () => Promise<unknown>) => { try { return await action(); } catch { return undefined; } };
vi.mock('../context', () => ({ useApp: () => ({ t: (_ja: string, en: string) => en, run: runAction, registerModal }) }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
const source = { startMs: 1000, endMs: 2000, text: 'I said no, no.' };
const received: TranscriptReview = {
  jobId: 'job-1', mediaId: 'media-1', applied: false, canApply: false, repairAlternatives: [],
  draft: { id: 'draft-1', mediaId: 'media-1', sourceSha256: 'source', sourceRevision: 'revision', digest: 'digest-original', startMs: 0, endMs: 4000, canAdopt: false,
    segments: [{ ...source, id: 'cue-1', status: 'provisional' }], chunks: [], pendingRanges: [],
    conflicts: [{ id: 'boundary-1', atMs: 2000, startMs: 1000, endMs: 3000, leftOrdinal: 0, rightOrdinal: 1, leftAlternative: [source], rightAlternative: [{ ...source, text: 'I said go.' }], resolution: null }],
  },
};
const resolved: TranscriptReview = { ...received, canApply: true, draft: { ...received.draft, digest: 'digest-reviewed', canAdopt: true, conflicts: [{ ...received.draft.conflicts[0], resolution: { kind: 'left' } }], segments: [{ ...source, id: 'cue-1', status: 'confirmed' }] } };

describe('transcript review and local adoption', () => {
  it('distinguishes an invalid response from missing and empty results and displays only escaped evidence', async () => {
    const evidence = { attemptId: 'attempt', jobId: 'job-1', ordinal: 0, inputSha256: 'input', requestSha256: 'request', taskSha256: 'task', modelId: 'model', parserRevision: 'v1', complete: true, state: 'invalid' as const, reason: 'reversed_time' as const };
    const invalid = { ordinal: 0, state: 'invalid' as const, reason: 'reversed_time' as const, evidenceSha256: 'evidence', evidence, reparses: [] };
    const view: TranscriptReview = { ...received, results: [invalid, { ordinal: 1, state: 'pending', reason: 'not_received', reparses: [] }, { ordinal: 2, state: 'empty', reason: null, reparses: [] }], draft: { ...received.draft, pendingRanges: [{ startMs: 0, endMs: 2000 }] } };
    vi.mocked(api.transcriptReview).mockResolvedValue(view);
    vi.mocked(api.transcriptResultDetail).mockResolvedValue({ ...invalid, evidence: { ...evidence, response: { text: '<img src=x onerror=alert(1)>' } } });
    vi.mocked(api.reparseTranscriptEvidence).mockResolvedValue(view);
    render(<TranscriptReviewDialog jobId="job-1" onClose={() => {}} />);
    await screen.findByText(/ranges have no validated subtitles/);
    fireEvent.click(screen.getByText('Saved response validation status'));
    expect(screen.getByText('Received, invalid')).toBeVisible();
    expect(screen.getByText('Not received')).toBeVisible();
    expect(screen.getByText('Valid empty result')).toBeVisible();
    expect(screen.getByText('An end time precedes its start time.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Show saved response and derived candidates' }));
    fireEvent.click(await screen.findByText('Original saved response'));
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
    expect(api.transcriptResultDetail).toHaveBeenCalledExactlyOnceWith('job-1', 0);
    fireEvent.click(screen.getByRole('button', { name: 'Reparse saved response locally' }));
    await waitFor(() => expect(api.reparseTranscriptEvidence).toHaveBeenCalledExactlyOnceWith('job-1', 0, 'evidence'));
    expect(api.approveQuote).not.toHaveBeenCalled();
    expect(api.applyTranscriptReview).not.toHaveBeenCalled();
    expect(api.selectTranscriptReparse).not.toHaveBeenCalled();
  });

  it('requires viewing and explicitly selecting a valid local candidate without adopting or paying', async () => {
    const result = { ordinal: 0, state: 'invalid' as const, reason: 'invalid_word_timing' as const, attemptState: 'settled', evidenceSha256: 'evidence', evidence: { attemptId: 'attempt', jobId: 'job-1', ordinal: 0, inputSha256: 'input', requestSha256: 'request', taskSha256: 'task', modelId: 'model', parserRevision: 'old', complete: true, state: 'invalid' as const, reason: 'invalid_word_timing' as const }, reparses: [{ id: 'derived', evidenceSha256: 'evidence', parserRevision: 'new', state: 'received' as const, reason: null, selected: false }] };
    vi.mocked(api.transcriptReview).mockResolvedValue({ ...received, results: [result] });
    vi.mocked(api.transcriptResultDetail).mockResolvedValue({ ...result, reparses: [{ ...result.reparses[0], output: { kind: 'transcript', cues: [{ startMs: 1000, endMs: 2000, text: 'Exact retained words.' }] } }] });
    vi.mocked(api.selectTranscriptReparse).mockResolvedValue(resolved);
    render(<TranscriptReviewDialog jobId="job-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByText('Saved response validation status'));
    expect(screen.queryByRole('button', { name: 'Select this candidate for preview' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show saved response and derived candidates' }));
    expect(await screen.findByText('Exact retained words.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Select this candidate for preview' }));
    await waitFor(() => expect(api.selectTranscriptReparse).toHaveBeenCalledExactlyOnceWith('job-1', 0, 'derived', 'digest-original'));
    expect(api.applyTranscriptReview).not.toHaveBeenCalled();
    expect(api.approveQuote).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Adopt these subtitles' })).toBeDisabled();
  });
  it('shows a joined sentence with both exact original groups and repetitions without adopting or sending', async () => {
    const joined = { startMs: 1000, endMs: 3900, text: 'I said no, no. Please wait. I really said no, no.' };
    const earlier = [
      { startMs: 0, endMs: 900, text: 'Unrelated earlier sentence.' },
      { startMs: 1000, endMs: 1800, text: 'I said no, no.' },
      { startMs: 1900, endMs: 2600, text: 'Please wait.' },
    ];
    const later = [
      { startMs: 1900, endMs: 2100, text: 'Please' },
      { startMs: 2100, endMs: 3900, text: 'wait. I really said no, no.' },
      { startMs: 3900, endMs: 4000, text: 'Unrelated later sentence.' },
    ];
    vi.mocked(api.transcriptReview).mockResolvedValue({ ...resolved, draft: { ...resolved.draft, conflicts: [], segments: [{ ...joined, id: 'joined-cue', status: 'confirmed' }],
      chunks: [
        { ordinal: 7, coreStartMs: 2000, coreEndMs: 4000, requestStartMs: 1000, requestEndMs: 4000, status: 'received', segments: later },
        { ordinal: 6, coreStartMs: 0, coreEndMs: 2000, requestStartMs: 0, requestEndMs: 3000, status: 'received', segments: earlier },
      ],
      edgeGroupJoins: [{ id: 'internal-join-id', method: 'exact_transport_edge_group_v1', anchorKind: 'observed_cue_intervals', leftOrdinal: 6, rightOrdinal: 7, leftSegmentIndices: [1, 2], rightSegmentIndices: [0, 1], overlapUnits: 2, joined }],
    } });
    vi.mocked(api.playerState).mockResolvedValue({ ready: true, positionMs: 0, durationMs: 4000, paused: true, rate: 1, volume: 0, tracks: [] });
    render(<TranscriptReviewDialog jobId="job-1" onClose={() => {}} />);
    const summary = await screen.findByText('Review automatically joined subtitles (1)');
    const details = summary.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText(joined.text)).not.toBeVisible();
    fireEvent.click(summary);
    expect(within(details).getByText(joined.text)).toBeVisible();
    const earlierSection = within(details).getByRole('heading', { name: 'Original subtitles from the earlier audio' }).closest('section')!;
    const laterSection = within(details).getByRole('heading', { name: 'Original subtitles from the later audio' }).closest('section')!;
    expect(within(earlierSection).getByText('I said no, no.')).toBeVisible();
    expect(within(earlierSection).getByText('Please wait.')).toBeVisible();
    expect(within(laterSection).getByText('Please')).toBeVisible();
    expect(within(laterSection).getByText('wait. I really said no, no.')).toBeVisible();
    expect(within(details).queryByText(/Unrelated/)).not.toBeInTheDocument();
    expect(details).not.toHaveTextContent('internal-join-id');
    expect(details).not.toHaveTextContent('exact_transport_edge_group_v1');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Adopt these subtitles' })).toBeDisabled();
    const joinedSection = within(details).getByRole('heading', { name: 'Joined subtitle' }).closest('section')!;
    fireEvent.click(within(joinedSection).getByRole('button'));
    await waitFor(() => expect(api.player).toHaveBeenCalledExactlyOnceWith({ action: 'seek', startMs: 1000, endMs: 3900 }));
    expect(api.loadMedia).toHaveBeenCalledExactlyOnceWith('media-1');
    expect(vi.mocked(api.playerState).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.player).mock.invocationCallOrder[0]);
    expect(api.applyTranscriptReview).not.toHaveBeenCalled();
    expect(api.resolveTranscriptBoundary).not.toHaveBeenCalled();
    expect(api.prepareBoundaryRepair).not.toHaveBeenCalled();
    expect(api.approveQuote).not.toHaveBeenCalled();
  });

  it('waits for the loaded player before seeking to the reviewed boundary', async () => {
    const loading: PlayerState = { ready: false, positionMs: 7000, durationMs: 8000, paused: true, rate: 1, volume: 0, tracks: [] };
    let finish!: (state: PlayerState) => void;
    vi.mocked(api.transcriptReview).mockResolvedValue(received);
    vi.mocked(api.playerState).mockResolvedValueOnce(loading).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<TranscriptReviewDialog jobId="job-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Play boundary audio' }));
    await waitFor(() => expect(api.playerState).toHaveBeenCalledTimes(2));
    expect(api.player).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Refresh saved results' })).toBeDisabled();
    finish({ ...loading, ready: true });
    await waitFor(() => expect(api.player).toHaveBeenCalledExactlyOnceWith({ action: 'seek', startMs: 1000, endMs: 3000 }));
    expect(vi.mocked(api.loadMedia).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.playerState).mock.invocationCallOrder[0]);
    expect(vi.mocked(api.playerState).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(api.player).mock.invocationCallOrder[0]);
  });
  it('does not seek or acknowledge a VAD warning when native loading fails', async () => {
    const warning = { id: 'silence-load', kind: 'speech_in_vad_no_speech_range' as const, ordinal: 0, startMs: 0, endMs: 4000, acknowledged: false };
    vi.mocked(api.transcriptReview).mockResolvedValue({ ...received, draft: { ...received.draft, warnings: [warning] } });
    vi.mocked(api.playerState).mockResolvedValue({ ready: false, error: 'Native decoder failed', positionMs: 0, durationMs: 0, paused: true, rate: 1, volume: 0, tracks: [] });
    render(<TranscriptReviewDialog jobId="job-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Listen to this range' }));
    await waitFor(() => expect(api.playerState).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Listen to this range' })).not.toBeDisabled());
    expect(api.player).not.toHaveBeenCalled();
    expect(api.acknowledgeTranscriptWarning).not.toHaveBeenCalled();
  });
  it('times out a player that never becomes ready without seeking and releases the UI', async () => {
    vi.mocked(api.transcriptReview).mockResolvedValue(received);
    vi.mocked(api.playerState).mockResolvedValue({ ready: false, positionMs: 0, durationMs: 0, paused: true, rate: 1, volume: 0, tracks: [] });
    render(<TranscriptReviewDialog jobId="job-1" onClose={() => {}} />);
    const play = await screen.findByRole('button', { name: 'Play boundary audio' });
    vi.useFakeTimers();
    fireEvent.click(play);
    await act(async () => { await vi.advanceTimersByTimeAsync(15100); });
    expect(api.playerState).toHaveBeenCalled();
    expect(api.player).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Refresh saved results' })).not.toBeDisabled();
  });
  it('requires explicit review of speech generated in a VAD no-speech range before separate adoption', async () => {
    const warning = { id: 'silence-1', kind: 'speech_in_vad_no_speech_range' as const, ordinal: 0, startMs: 0, endMs: 4000, acknowledged: false };
    const flagged: TranscriptReview = { ...received, draft: { ...received.draft, conflicts: [], warnings: [warning] } };
    const checked: TranscriptReview = { ...flagged, canApply: true, draft: { ...flagged.draft, digest: 'checked-silence', canAdopt: true, warnings: [{ ...warning, acknowledged: true }] } };
    vi.mocked(api.transcriptReview).mockResolvedValue(flagged);
    vi.mocked(api.acknowledgeTranscriptWarning).mockResolvedValue(checked);
    render(<TranscriptReviewDialog jobId="job-1" onClose={() => {}} />);
    await screen.findByText(/AI generated subtitles in a range where no speech was detected/);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'I checked the audio and subtitles' }));
    await waitFor(() => expect(api.acknowledgeTranscriptWarning).toHaveBeenCalledExactlyOnceWith('job-1', 'digest-original', 'silence-1'));
    await screen.findByRole('button', { name: 'Reviewed' });
    expect(screen.getByRole('button', { name: 'Adopt these subtitles' })).toBeDisabled();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(api.applyTranscriptReview).not.toHaveBeenCalled();
    expect(api.approveQuote).not.toHaveBeenCalled();
  });
  it('does not label an unreceived repair as a silent response', async () => {
    vi.mocked(api.transcriptReview).mockResolvedValue({ ...received, repairAlternatives: [{ jobId: 'repair-1', boundaryId: 'boundary-1', draft: { ...received.draft, segments: [], conflicts: [], pendingRanges: [{ startMs: 0, endMs: 4000 }] } }] });
    render(<TranscriptReviewDialog jobId="job-1" onClose={() => {}} />);
    await screen.findByText(/The repair result has not been received/);
    expect(screen.queryByText('No speech in this result.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy repair into manual editor' })).not.toBeInTheDocument();
  });
  it('shows a VAD-estimated pause with preserved text and requires explicit review after local playback', async () => {
    const warning = { id: 'pause-1', kind: 'speech_in_vad_pause_range' as const, ordinal: 0, startMs: 1274, endMs: 3750, acknowledged: false };
    const original = { startMs: 1500, endMs: 2500, text: 'Again, again.' };
    const flagged: TranscriptReview = { ...received, draft: { ...received.draft, conflicts: [], warnings: [warning],
      segments: [{ ...original, id: 'cue-pause', status: 'provisional' }],
      chunks: [{ ordinal: 0, coreStartMs: 0, coreEndMs: 4000, requestStartMs: 0, requestEndMs: 4000, status: 'received', segments: [original],
        vadPauseEvidence: { policy: 'silero-low-posterior-0.35-2s-250ms-v1', modelSha256: 'model', runtimeSha256: 'runtime', sampleRate: 16000, sourceStartSample: 0, sourceEndSample: 64000, minimumPauseMs: 2000, boundaryGuardMs: 250, pauses: [{ start_sample: 16384, end_sample: 64000 }] },
      }],
    } };
    const checked: TranscriptReview = { ...flagged, canApply: true, draft: { ...flagged.draft, digest: 'checked-pause', canAdopt: true, warnings: [{ ...warning, acknowledged: true }] } };
    vi.mocked(api.transcriptReview).mockResolvedValue(flagged);
    vi.mocked(api.acknowledgeTranscriptWarning).mockResolvedValue(checked);
    vi.mocked(api.playerState).mockResolvedValue({ ready: true, positionMs: 0, durationMs: 4000, paused: true, rate: 1, volume: 0, tracks: [] });
    render(<TranscriptReviewDialog jobId="job-1" onClose={() => {}} />);
    await screen.findByText(/AI returned speech inside a VAD-estimated pause/);
    expect(screen.getByText(/It is not proof of silence/)).toBeVisible();
    fireEvent.click(screen.getByText('Original audio ranges and preview status'));
    fireEvent.click(screen.getByText('Show subtitles for this range'));
    expect(screen.getByText(original.text)).toBeVisible();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Listen to this range' }));
    await waitFor(() => expect(api.player).toHaveBeenCalledExactlyOnceWith({ action: 'seek', startMs: 1274, endMs: 3750 }));
    expect(api.acknowledgeTranscriptWarning).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'I checked the audio and subtitles' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'I checked the audio and subtitles' }));
    await waitFor(() => expect(api.acknowledgeTranscriptWarning).toHaveBeenCalledExactlyOnceWith('job-1', 'digest-original', 'pause-1'));
    expect(screen.getByRole('button', { name: 'Adopt these subtitles' })).toBeDisabled();
    expect(api.applyTranscriptReview).not.toHaveBeenCalled();
    expect(api.approveQuote).not.toHaveBeenCalled();
  });
  it('keeps both original alternatives and requires a separate adoption acknowledgement', async () => {
    vi.mocked(api.transcriptReview).mockResolvedValue(received);
    vi.mocked(api.resolveTranscriptBoundary).mockResolvedValue(resolved);
    vi.mocked(api.applyTranscriptReview).mockResolvedValue({ ...resolved, applied: true, canApply: false });
    render(<TranscriptReviewDialog jobId="job-1" onClose={() => {}} />);
    await screen.findByText('I said go.');
    expect(screen.getByRole('button', { name: 'Adopt these subtitles' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Use earlier result' }));
    await waitFor(() => expect(api.resolveTranscriptBoundary).toHaveBeenCalledExactlyOnceWith('job-1', 'digest-original', 'boundary-1', { kind: 'left' }));
    expect(api.applyTranscriptReview).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Adopt these subtitles' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Adopt these subtitles' }));
    expect(await screen.findByRole('button', { name: 'Adopted' })).toBeDisabled();
    expect(api.applyTranscriptReview).toHaveBeenCalledExactlyOnceWith('job-1', 'digest-reviewed');
    expect(api.approveQuote).not.toHaveBeenCalled();
  });

  it('shows missing ranges without treating received fragments as complete', async () => {
    vi.mocked(api.transcriptReview).mockResolvedValue({ ...received, draft: { ...received.draft, conflicts: [], pendingRanges: [{ startMs: 2000, endMs: 4000 }] } });
    render(<TranscriptReviewDialog jobId="job-1" onClose={() => {}} />);
    await screen.findByText(/ranges have no validated subtitles/);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Adopt these subtitles' })).toBeDisabled();
    expect(api.applyTranscriptReview).not.toHaveBeenCalled();
  });

  it('requests a bounded repair quote without granting a paid execution', async () => {
    vi.mocked(api.transcriptReview).mockResolvedValue(received);
    vi.mocked(api.prepareBoundaryRepair).mockResolvedValue({ id: 'repair-job', mediaId: 'media-1', kind: 'transcribe', startMs: 0, endMs: 4000, model: 'test-preview', estimatedUsd: .1, maximumUsd: .2, inputTokens: 10, maxOutputTokens: 100, expiresAt: '2099-01-01T00:00:00Z', warnings: [], canApprove: false, blockedReason: 'Audio model remains unqualified.' });
    render(<TranscriptReviewDialog jobId="job-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Estimate repair, up to 30 seconds' }));
    await screen.findByRole('dialog', { name: 'Boundary repair estimate' });
    expect(api.prepareBoundaryRepair).toHaveBeenCalledExactlyOnceWith('job-1', 'digest-original', 'boundary-1');
    expect(screen.getByRole('button', { name: 'Approve this job' })).toBeDisabled();
    expect(api.approveQuote).not.toHaveBeenCalled();
  });

  it('rejects manual times outside the retained boundary in the editor', async () => {
    vi.mocked(api.transcriptReview).mockResolvedValue(received);
    render(<TranscriptReviewDialog jobId="job-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit manually' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '00:00:00.500' } });
    expect(screen.getByRole('button', { name: 'Confirm edited boundary' })).toBeDisabled();
    expect(api.resolveTranscriptBoundary).not.toHaveBeenCalled();
  });
});
