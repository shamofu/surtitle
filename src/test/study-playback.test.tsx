// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StudyPage } from '../pages/Study';
import { api } from '../api';
import type { PlayerState, SubtitleSegment } from '../api';

const fixture = vi.hoisted(() => ({
  media: { id: 'media', title: 'Study fixture', path: 'C:/fixture.mkv', kind: 'video', durationMs: 4000, learningLanguage: 'en', explanationLanguage: 'ja', status: 'ready', lastPositionMs: 0, createdAt: '2026-01-01T00:00:00Z', segmentCount: 3, cardCount: 0 },
  notify: vi.fn(), refresh: vi.fn(), scroll: vi.fn(), listener: undefined as undefined | ((event: { payload: PlayerState }) => void),
}));
vi.mock('../api', () => ({ nativeAvailable: () => true, api: { segments: vi.fn(), candidates: vi.fn(), loadMedia: vi.fn(), playerState: vi.fn(), player: vi.fn(), playSourceRange: vi.fn(), saveCard: vi.fn(), updateSettings: vi.fn(), createQuote: vi.fn() } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_name: string, listener: typeof fixture.listener) => { fixture.listener = listener; return () => {}; }) }));
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ mediaId: 'media' }), useNavigate: () => vi.fn(), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: ({ count }: { count: number }) => ({ scrollToIndex: fixture.scroll, getTotalSize: () => count * 118, getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 118 })), measureElement: () => {} }) }));
vi.mock('../context', () => {
  const t = (_ja: string, en: string) => en;
  const run = async (action: () => Promise<unknown>) => { try { const result = await action(); await fixture.refresh(); return result; } catch (error) { fixture.notify(String(error), 'error'); return undefined; } };
  return { useApp: () => ({ data: { media: [fixture.media], cards: [], jobs: [] }, locale: 'en', t, notify: fixture.notify, refresh: fixture.refresh, run, surfaceHidden: false }) };
});
vi.mock('../components/AiDialog', () => ({ AiDialog: () => null }));
vi.mock('../components/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('../components/MediaManagement', () => ({ RemoveMediaDialog: () => null, SubtitleSourceDialog: () => null }));
vi.mock('../components/JobActions', () => ({ JobActions: () => null }));

const cues: SubtitleSegment[] = [
  { id: 'a', mediaId: 'media', startMs: 0, endMs: 1000, text: 'I would like', status: 'confirmed' },
  { id: 'b', mediaId: 'media', startMs: 1000, endMs: 2000, text: 'to go home.', status: 'confirmed' },
  { id: 'c', mediaId: 'media', startMs: 2500, endMs: 3200, text: 'Next sentence.', status: 'confirmed' },
];
let state: PlayerState;
const clients: QueryClient[] = [];
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client); render(<QueryClientProvider client={client}><StudyPage /></QueryClientProvider>); return client; }
async function emit(patch: Partial<PlayerState>) { state = { ...state, ...patch }; await act(async () => { fixture.listener?.({ payload: state }); }); }
beforeAll(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
beforeEach(() => {
  state = { ready: true, positionMs: 0, durationMs: 4000, paused: true, rate: 1, volume: 80, tracks: [], sentencePause: false };
  vi.mocked(api.segments).mockResolvedValue(cues);
  vi.mocked(api.candidates).mockResolvedValue([{ id: 'candidate', mediaId: 'media', segmentId: 'a', sourceCueIds: ['a', 'b'], term: 'go home', meaning: 'Return home', example: 'I would like to go home.', startMs: 0, endMs: 2000 }]);
  vi.mocked(api.loadMedia).mockResolvedValue();
  vi.mocked(api.playerState).mockImplementation(async () => state);
  vi.mocked(api.player).mockImplementation(async request => { if (request.action === 'sentence-pause') state = { ...state, sentencePause: request.value === 1 }; });
  vi.mocked(api.playSourceRange).mockResolvedValue();
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); fixture.listener = undefined; vi.resetAllMocks(); });

describe('study sentence and source playback', () => {
  it('waits for native readiness and changes only the saved sentence-pause preference', async () => {
    state.ready = false;
    mount();
    await waitFor(() => expect(api.playerState).toHaveBeenCalled());
    expect(screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Suggestions' }));
    expect(await screen.findByRole('button', { name: 'Listen to source' })).toBeDisabled();
    expect(api.playSourceRange).not.toHaveBeenCalled();
    await emit({ ready: true });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' })).toBeChecked());
    expect(api.player).toHaveBeenCalledWith({ action: 'sentence-pause', value: 1 });
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(api.createQuote).not.toHaveBeenCalled();
    expect(screen.getByText(/Selected ranges and repeat take priority/)).toBeVisible();
  });
  it('plays a whole source group by IDs and repeats its complete cue range without saving or sending', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Listen to source' }));
    await waitFor(() => expect(api.playSourceRange).toHaveBeenCalledExactlyOnceWith('media', ['a', 'b']));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Repeat selected segment' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Repeat selected segment' }));
    expect(api.player).toHaveBeenCalledWith({ action: 'source-loop', startMs: 0, endMs: 2000 });
    expect(document.querySelector('.context-sentence')?.textContent).toBe('I would like\nto go home.');
    fireEvent.click(screen.getByRole('button', { name: 'Listen again' }));
    await waitFor(() => expect(api.playSourceRange).toHaveBeenCalledTimes(2));
    expect(api.saveCard).not.toHaveBeenCalled();
    expect(api.createQuote).not.toHaveBeenCalled();
  });
  it('keeps direct subtitle replay as an explicit range and suspends follow for keyboard scrolling', async () => {
    mount();
    const button = await screen.findByRole('button', { name: 'Play subtitle 0:00' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(api.player).toHaveBeenCalledWith({ action: 'source-seek', startMs: 0, endMs: 1000 }));
    expect(api.playSourceRange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('Subtitle list'), { key: 'ArrowDown' });
    const previous = fixture.scroll.mock.calls.length;
    await emit({ positionMs: 2600 });
    expect(fixture.scroll).toHaveBeenCalledTimes(previous);
    fireEvent.click(screen.getByRole('button', { name: 'Follow playback' }));
    await waitFor(() => expect(fixture.scroll.mock.calls.length).toBeGreaterThan(previous));
  });
  it('does not change context or start a loop after source validation fails', async () => {
    vi.mocked(api.playSourceRange).mockRejectedValue(new Error('Source subtitles are no longer adjacent'));
    mount();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Listen to source' }));
    await waitFor(() => expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining('no longer adjacent'), 'error'));
    expect(screen.getByRole('button', { name: 'Repeat selected segment' })).toBeDisabled();
    expect(document.querySelector('.context-sentence')).toBeNull();
  });
  it.each([
    ['removed cue', [cues[0], cues[2]]],
    ['reordered cues', [{ ...cues[1], startMs: 0, endMs: 500 }, { ...cues[0], startMs: 600, endMs: 900 }, cues[2]]],
    ['inserted cue', [cues[0], { ...cues[0], id: 'inserted', startMs: 500, endMs: 750 }, cues[1], cues[2]]],
  ])('invalidates a selected source group after %s and clears a running native loop until explicit reselection', async (_name, changedCues) => {
    const client = mount();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Listen to source' }));
    const repeat = screen.getByRole('button', { name: 'Repeat selected segment' });
    await waitFor(() => expect(repeat).toBeEnabled());
    fireEvent.click(repeat);
    expect(api.player).toHaveBeenCalledWith({ action: 'source-loop', startMs: 0, endMs: 2000 });
    await waitFor(() => expect(repeat).toHaveAttribute('aria-pressed', 'true'));
    vi.mocked(api.player).mockClear();
    vi.mocked(api.playSourceRange).mockClear();
    await act(async () => { client.setQueryData(['segments', 'media'], changedCues); });
    await waitFor(() => expect(repeat).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Listen again' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save a phrase' })).toBeDisabled();
    expect(screen.getByText('The source subtitles changed. Select the subtitles or phrase again.')).toBeVisible();
    expect(document.querySelector('.context-sentence')).toBeNull();
    // Disabled controls render before the passive effect clears the native loop.
    await waitFor(() => expect(api.player).toHaveBeenCalledExactlyOnceWith({ action: 'loop' }));
    expect(api.playSourceRange).not.toHaveBeenCalled();
    // Restoring the same IDs does not silently resume the old selection.
    await act(async () => { client.setQueryData(['segments', 'media'], cues); });
    expect(repeat).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Listen to source' }));
    await waitFor(() => expect(repeat).toBeEnabled());
    expect(api.playSourceRange).toHaveBeenCalledExactlyOnceWith('media', ['a', 'b']);
  });
  it('clears an old loop when source timing changes without clearing a newly requested replay range', async () => {
    const client = mount();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Listen to source' }));
    const repeat = screen.getByRole('button', { name: 'Repeat selected segment' });
    await waitFor(() => expect(repeat).toBeEnabled());
    fireEvent.click(repeat);
    vi.mocked(api.player).mockClear();
    await act(async () => { client.setQueryData(['segments', 'media'], [cues[0], { ...cues[1], endMs: 2200 }, cues[2]]); });
    await waitFor(() => expect(api.player).toHaveBeenCalledExactlyOnceWith({ action: 'loop' }));
    expect(repeat).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(repeat);
    expect(api.player).toHaveBeenCalledWith({ action: 'source-loop', startMs: 0, endMs: 2200 });
    vi.mocked(api.player).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Listen again' }));
    await waitFor(() => expect(api.playSourceRange).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(repeat).toHaveAttribute('aria-pressed', 'false'));
    expect(api.player).not.toHaveBeenCalledWith({ action: 'loop' });
  });
});
