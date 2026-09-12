// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StudyPage } from '../pages/Study';
import { api } from '../api';
import type { AppSnapshot, Media, PlayerState, TranscriptReview } from '../api';
import { draftStudyApi } from '../draft-study';
import type { DraftSelection } from '../draft-study';

const fixture = vi.hoisted(() => ({
  data: undefined as AppSnapshot | undefined,
  notify: vi.fn(), refresh: vi.fn(), register: () => () => {},
  listener: undefined as undefined | ((event: { payload: PlayerState }) => void),
}));
vi.mock('../api', () => ({ nativeAvailable: () => true, api: { segments: vi.fn(), candidates: vi.fn(), transcriptReview: vi.fn(), transcriptResultDetail: vi.fn(), loadMedia: vi.fn(), playerState: vi.fn(), player: vi.fn(), playSourceRange: vi.fn(), saveCard: vi.fn(), updateSettings: vi.fn(), createQuote: vi.fn(), approveQuote: vi.fn() } }));
vi.mock('../draft-study', async importOriginal => {
  const actual = await importOriginal<typeof import('../draft-study')>();
  return { ...actual, draftStudyApi: { list: vi.fn(), prepare: vi.fn(), update: vi.fn(), candidates: vi.fn(), saveCard: vi.fn(), createQuote: vi.fn(), export: vi.fn(), remove: vi.fn() } };
});
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_name: string, listener: typeof fixture.listener) => { fixture.listener = listener; return () => {}; }) }));
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ mediaId: 'media' }), useNavigate: () => vi.fn(), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: ({ count }: { count: number }) => ({ scrollToIndex: vi.fn(), getTotalSize: () => count * 100, getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 100 })), measureElement: () => {} }) }));
vi.mock('../context', () => ({ useApp: () => ({ data: fixture.data, locale: 'en', t: (_ja: string, en: string) => en, notify: fixture.notify, refresh: fixture.refresh, surfaceHidden: false, registerModal: fixture.register, run: async <T,>(action: () => Promise<T>) => { try { return await action(); } catch (error) { fixture.notify(String(error), 'error'); return undefined; } } }) }));
vi.mock('../components/AiDialog', () => ({ AiDialog: () => null, QuoteApproval: () => null }));
vi.mock('../components/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('../components/TranscriptReview', () => ({ TranscriptReviewDialog: () => null }));
vi.mock('../components/MediaManagement', () => ({ RemoveMediaDialog: () => null, SubtitleSourceDialog: () => null }));
vi.mock('../components/JobActions', () => ({ JobActions: () => null }));

const media: Media = { id: 'media', title: 'Two independent text sources', path: 'fixture.wav', kind: 'audio', durationMs: 8000, learningLanguage: 'en', explanationLanguage: 'ja', status: 'ready', lastPositionMs: 0, createdAt: '2026-09-12', segmentCount: 1, cardCount: 0 };
const canonical = { id: 'canonical-cue', mediaId: media.id, startMs: 0, endMs: 2000, text: 'Previously adopted caption.', status: 'confirmed' as const };
const draftCue = { id: 'draft-cue', startMs: 3000, endMs: 4000, text: 'A different unadopted excerpt.', status: 'provisional' as const };
const review: TranscriptReview = { jobId: 'job', mediaId: media.id, applied: false, canApply: false, repairAlternatives: [], draft: { id: 'draft', mediaId: media.id, sourceSha256: 'source', sourceRevision: 'revision', digest: 'draft-digest', startMs: 0, endMs: 8000, canAdopt: false, segments: [draftCue], chunks: [{ ordinal: 0, coreStartMs: 0, coreEndMs: 8000, requestStartMs: 0, requestEndMs: 8000, status: 'received', source: 'provider', segments: [draftCue] }], conflicts: [], pendingRanges: [{ startMs: 6000, endMs: 8000 }] } };
const bookmark: DraftSelection = { id: 'bookmark', mediaId: media.id, jobId: 'job', version: 0, text: draftCue.text, startMs: 3000, endMs: 4000, sourceStartMs: 0, sourceEndMs: 8000, cueIds: [draftCue.id], origin: 'ai', timing: 'cue', confirmed: false, stale: false, canConfirm: true, blockingReasons: [], createdAt: '2026-09-12', updatedAt: '2026-09-12' };
let state: PlayerState;
let bookmarks: DraftSelection[];
let rejectSourcePlayback: boolean;
const clients: QueryClient[] = [];

beforeAll(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
beforeEach(() => {
  state = { ready: true, positionMs: 0, durationMs: 8000, paused: true, rate: 1, volume: 80, tracks: [], sentencePause: true };
  bookmarks = [];
  rejectSourcePlayback = false;
  fixture.data = { media: [media], cards: [], tools: [], jobs: [{ id: 'job', mediaId: media.id, kind: 'transcribe', status: 'paused', progress: 0.5, transcriptReview: true, createdAt: '2026-09-12' }], settings: { theme: 'dark', locale: 'en', learningLanguage: 'en', explanationLanguage: 'ja', dailyBudgetUsd: 0, vertexProject: '', vertexLocation: 'global', credentialConfigured: false, retention: 0.9, sentencePause: true }, budget: { spentUsd: 0, reservedUsd: 0, limitUsd: 0 } };
  vi.mocked(api.segments).mockResolvedValue([canonical]);
  vi.mocked(api.candidates).mockResolvedValue([]);
  vi.mocked(api.transcriptReview).mockResolvedValue(review);
  vi.mocked(api.loadMedia).mockResolvedValue(undefined);
  vi.mocked(api.playerState).mockImplementation(async () => state);
  vi.mocked(api.player).mockImplementation(async request => {
    if (rejectSourcePlayback && request.action === 'source-seek') throw new Error('Draft source playback rejected');
  });
  vi.mocked(draftStudyApi.list).mockImplementation(async () => bookmarks);
  vi.mocked(draftStudyApi.prepare).mockImplementation(async () => { bookmarks = [bookmark]; return bookmark; });
  vi.mocked(draftStudyApi.candidates).mockResolvedValue([]);
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); fixture.listener = undefined; vi.resetAllMocks(); });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><StudyPage /></QueryClientProvider>);
}

describe('draft study in the real study page', () => {
  it('hides the previous caption context and suppresses its pause behavior without changing the saved preference', async () => {
    mount();
    const play = await screen.findByRole('button', { name: 'Play subtitle 0:00' });
    await waitFor(() => expect(play).toBeEnabled());
    fireEvent.click(play);
    await waitFor(() => expect(document.querySelector('.context-sentence')).toHaveTextContent(canonical.text));
    vi.mocked(api.player).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Study a draft' }));
    await screen.findByRole('list', { name: 'Available draft subtitles' });
    await waitFor(() => expect(api.player).toHaveBeenCalledWith({ action: 'draft-mode', value: 1 }));
    expect(document.querySelector('.context-sentence')).toBeNull();
    expect(screen.queryByText(canonical.text)).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' })).not.toBeChecked();
    // Entering draft view must not use the command that persists a new preference.
    expect(api.player).not.toHaveBeenCalledWith({ action: 'sentence-pause', value: 0 });
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(fixture.data?.settings.sentencePause).toBe(true);
    expect(screen.getByRole('button', { name: 'Repeat selected segment' })).toBeDisabled();
    vi.mocked(api.player).mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Transcript/ }));
    await waitFor(() => expect(api.player).toHaveBeenCalledWith({ action: 'draft-mode', value: 0 }));
    expect(screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' })).toBeEnabled();
    expect(api.player).not.toHaveBeenCalledWith({ action: 'sentence-pause', value: 1 });
  });

  it('propagates source-playback rejection to the draft confirmation gate', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Study a draft' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: `Select subtitle: ${draftCue.text}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep selected subtitles for later' }));
    const editor = within(await screen.findByRole('region', { name: 'Check selected phrase' }));
    rejectSourcePlayback = true;
    fireEvent.click(editor.getByRole('button', { name: 'Play audio for this text' }));
    await waitFor(() => expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining('Draft source playback rejected'), 'error'));
    expect(editor.getByRole('checkbox')).toBeDisabled();
    expect(editor.getByRole('button', { name: 'Confirm this text and audio' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Repeat selected segment' })).toBeDisabled();
    expect(draftStudyApi.update).not.toHaveBeenCalled();
    expect(draftStudyApi.createQuote).not.toHaveBeenCalled();
    expect(api.approveQuote).not.toHaveBeenCalled();
    rejectSourcePlayback = false;
    fireEvent.click(editor.getByRole('button', { name: 'Play audio for this text' }));
    await waitFor(() => expect(editor.getByRole('checkbox')).toBeEnabled());
    expect(api.player).toHaveBeenCalledWith({ action: 'source-seek', startMs: 3000, endMs: 4000 });
    expect(screen.getByRole('button', { name: 'Repeat selected segment' })).toBeEnabled();
    expect(document.querySelector('.context-sentence')).toBeNull();
  });
});
