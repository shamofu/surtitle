// SPDX-License-Identifier: GPL-3.0-or-later
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StudyPage } from '../features/study/StudyPage';
import { studyApi } from '../features/study/api';
import { playerApi } from '../features/study/playback/api';
import { settingsApi } from '../features/settings/api';
import { aiApi } from '../features/ai/api';
import { cardsApi } from '../features/cards/api';
import type { PlayerState } from '../shared/contracts/player';
import type { SubtitleSegment } from '../shared/contracts/media';

const fixture = vi.hoisted(() => ({
  hasMedia: true,
  blockerStatus: 'idle',
  resetBlocker: vi.fn(),
  media: {
    id: 'media',
    title: 'Study fixture',
    path: 'C:/fixture.mkv',
    audioStreamIndex: undefined as number | undefined,
    kind: 'video',
    durationMs: 4000,
    learningLanguage: 'en',
    explanationLanguage: 'ja',
    status: 'ready',
    lastPositionMs: 0,
    createdAt: '2026-01-01T00:00:00Z',
    segmentCount: 3,
    cardCount: 0,
  },
  notify: vi.fn(),
  refresh: vi.fn(),
  scroll: vi.fn(),
  scrollOffset: vi.fn(),
  registerModal: () => () => {},
  listener: undefined as
    | undefined
    | ((event: { payload: PlayerState }) => void),
}));

vi.mock('../features/study/api', () => ({
  studyApi: { segments: vi.fn(), candidates: vi.fn() },
}));
vi.mock('../features/study/playback/api', () => ({
  playerApi: {
    loadMedia: vi.fn(),
    playerState: vi.fn(),
    player: vi.fn(),
    playSourceRange: vi.fn(),
  },
}));
vi.mock('../features/cards/api', () => ({ cardsApi: { saveCard: vi.fn() } }));
vi.mock('../features/ai/api', () => ({ aiApi: { createQuote: vi.fn() } }));
vi.mock('../features/settings/api', () => ({
  settingsApi: { updateSettings: vi.fn() },
}));

vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../shared/native/window', () => ({ subscribeWindowClose: () => () => {}, closeWindow: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, listener: typeof fixture.listener) => {
    fixture.listener = listener;
    return () => {};
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ mediaId: 'media' }),
  useNavigate: () => vi.fn(),
  useBlocker: () => ({ status: fixture.blockerStatus, reset: fixture.resetBlocker, proceed: vi.fn() }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    scrollToIndex: fixture.scroll,
    scrollToOffset: fixture.scrollOffset,
    measure: () => {},
    takeSnapshot: () => [],
    getTotalSize: () => count * 118,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 118,
      })),
    measureElement: () => {},
  }),
}));
vi.mock('../app/runtime', () => {
  const t = (_ja: string, en: string) => en;
  const report = async (action: () => Promise<unknown>) => {
    try {
      const result = await action();
      await fixture.refresh();
      return result;
    } catch (error) {
      fixture.notify(String(error), 'error');
      return undefined;
    }
  };
  const useFixture = () => ({
    mutate: (action: () => Promise<unknown>) => action(),
    data: { media: fixture.hasMedia ? [fixture.media] : [], cards: [], jobs: [] },
    locale: 'en',
    t,
    notify: fixture.notify,
    refresh: fixture.refresh,
    report,
    surfaceHidden: false,
    registerModal: fixture.registerModal,
  });
  return {
    useSnapshot: useFixture,
    useDataActions: useFixture,
    useAppearance: useFixture,
    useNotifications: useFixture,
    useSurface: useFixture,
  };
});
vi.mock('../features/ai/AiDialog', () => ({ AiDialog: () => null }));
vi.mock('../features/transfer/TransferDialog', () => ({
  TransferDialog: () => null,
}));
vi.mock('../features/library/MediaManagement', () => ({
  RemoveMediaDialog: () => null,
  SubtitleSourceDialog: () => null,
}));
vi.mock('../features/ai/JobActions', () => ({ JobActions: () => null }));

const cues: SubtitleSegment[] = [
  {
    id: 'a',
    mediaId: 'media',
    startMs: 0,
    endMs: 1000,
    text: 'I would like',
    status: 'confirmed',
  },
  {
    id: 'b',
    mediaId: 'media',
    startMs: 1000,
    endMs: 2000,
    text: 'to go home.',
    status: 'confirmed',
  },
  {
    id: 'c',
    mediaId: 'media',
    startMs: 2500,
    endMs: 3200,
    text: 'Next sentence.',
    status: 'confirmed',
  },
];
let state: PlayerState;
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <StudyPage />
    </QueryClientProvider>,
  );
  return client;
}
async function emit(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  await act(async () => {
    fixture.listener?.({ payload: state });
  });
}
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
beforeEach(() => {
  state = {
    ready: true,
    positionMs: 0,
    durationMs: 4000,
    paused: true,
    rate: 1,
    volume: 80,
    tracks: [],
    sentencePause: false,
  };
  vi.mocked(studyApi.segments).mockResolvedValue(cues);
  vi.mocked(studyApi.candidates).mockResolvedValue([
    {
      id: 'candidate',
      mediaId: 'media',
      segmentId: 'a',
      sourceCueIds: ['a', 'b'],
      term: 'go home',
      meaning: 'Return home',
      example: 'I would like to go home.',
      startMs: 0,
      endMs: 2000,
    },
  ]);
  vi.mocked(playerApi.loadMedia).mockResolvedValue();
  vi.mocked(playerApi.playerState).mockImplementation(async () => state);
  vi.mocked(playerApi.player).mockImplementation(async (request) => {
    if (request.action === 'pause') state = { ...state, paused: true };
    if (request.action === 'play') state = { ...state, paused: false };
    if (request.action === 'sentence-pause')
      state = { ...state, sentencePause: request.value === 1 };
  });
  vi.mocked(playerApi.playSourceRange).mockResolvedValue();
});
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  fixture.listener = undefined;
  fixture.media.path = 'C:/fixture.mkv';
  fixture.media.audioStreamIndex = undefined;
  fixture.hasMedia = true;
  fixture.blockerStatus = 'idle';
  vi.resetAllMocks();
});

const inspectButton = () => screen.getByRole('button', { name: 'Inspect this phrase' });
const inspectReplay = () => within(document.querySelector('.phrase-inspector') as HTMLElement).getByRole('button', { name: 'Listen again' });
async function ready() {
  await waitFor(() => expect(inspectButton()).toBeEnabled());
}
function openTranscript() {
  fireEvent.click(within(document.querySelector('.study-top') as HTMLElement).getByRole('button', { name: 'Transcript' }));
}
function openPlaybackSettings() {
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  fireEvent.click(screen.getByRole('button', { name: 'Playback settings' }));
}
async function inspectCurrent() {
  await ready();
  fireEvent.click(inspectButton());
  await screen.findByRole('button', { name: 'Return to watching' });
}

describe('watching and inspecting phrases', () => {
  it('starts with the current caption, hidden translation and closed transcript, without an AI request', async () => {
    vi.mocked(studyApi.segments).mockResolvedValue([{ ...cues[0], translation: 'お願いします。' }, ...cues.slice(1)]);
    mount();
    await ready();
    expect(document.querySelector('.current-caption-text')).toHaveTextContent(cues[0].text);
    expect(screen.queryByLabelText('Search transcript')).not.toBeInTheDocument();
    expect(screen.queryByText('お願いします。')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    expect(screen.getByText('お願いします。')).toBeVisible();
    await emit({ positionMs: 2600 });
    expect(document.querySelector('.current-caption-text')).toHaveTextContent(cues[2].text);
    expect(aiApi.createQuote).not.toHaveBeenCalled();
  });

  it('pauses and freezes the inspected source while playback moves to a different caption', async () => {
    state = { ...state, paused: false, positionMs: 300 };
    mount();
    await inspectCurrent();
    expect(playerApi.player).toHaveBeenCalledWith({ action: 'pause' });
    const original = document.querySelector('.phrase-panel .context-sentence');
    expect(original).toHaveTextContent(cues[0].text);
    await emit({ positionMs: 2600 });
    expect(original).toHaveTextContent(cues[0].text);
    expect(aiApi.createQuote).not.toHaveBeenCalled();
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
  });

  it('saves the selected text explicitly even after the DOM selection has cleared', async () => {
    mount();
    await ready();
    const caption = document.querySelector('.current-caption-text')!;
    const range = document.createRange();
    range.setStart(caption.firstChild!, 2);
    range.setEnd(caption.firstChild!, 12);
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(caption);
    await screen.findByRole('button', { name: 'Return to watching' });
    window.getSelection()!.removeAllRanges();
    fireEvent.click(screen.getByRole('button', { name: 'Save a phrase' }));
    expect(screen.getByLabelText('Word or phrase')).toHaveValue('would like');
    fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'want politely' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save phrase' }));
    await waitFor(() => expect(cardsApi.saveCard).toHaveBeenCalledWith(expect.objectContaining({
      mediaId: 'media', segmentId: 'a', term: 'would like', meaning: 'want politely', example: cues[0].text,
    })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('preserves the source under a text-selection gesture while playback crosses a caption boundary', async () => {
    mount();
    await ready();
    const caption = document.querySelector('.current-caption-text')!;
    fireEvent.pointerDown(caption);
    await emit({ positionMs: 2600 });
    expect(caption).toHaveTextContent(cues[0].text);
    const range = document.createRange();
    range.setStart(caption.firstChild!, 2);
    range.setEnd(caption.firstChild!, 12);
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(caption);
    await screen.findByRole('button', { name: 'Return to watching' });
    expect(document.querySelector('.phrase-panel .context-sentence')).toHaveTextContent(cues[0].text);
    expect(document.querySelector('.current-caption-text')).toHaveTextContent(cues[2].text);
    fireEvent.click(screen.getByRole('button', { name: 'Save a phrase' }));
    expect(screen.getByLabelText('Word or phrase')).toHaveValue('would like');
  });

  it('invalidates text selected from a caption that was edited during the selection gesture', async () => {
    const client = mount();
    await ready();
    const caption = document.querySelector('.current-caption-text')!;
    fireEvent.pointerDown(caption);
    await act(async () => client.setQueryData(['media', 'media', 'segments'], [{ ...cues[0], text: 'This source has changed.' }, ...cues.slice(1)]));
    expect(caption).toHaveTextContent(cues[0].text);
    const range = document.createRange();
    range.setStart(caption.firstChild!, 2);
    range.setEnd(caption.firstChild!, 12);
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(caption);
    await screen.findByRole('button', { name: 'Return to watching' });
    expect(screen.getByText('The source subtitles changed. Select the subtitles or phrase again.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save a phrase' })).toBeDisabled();
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
  });

  it.each(['file', 'audio track'])('invalidates inspected source after the media %s changes', async source => {
    mount();
    await inspectCurrent();
    if (source === 'file') fixture.media.path = 'C:/replacement.mkv';
    else fixture.media.audioStreamIndex = 2;
    await emit({ positionMs: 2600 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save a phrase' })).toBeDisabled());
    expect(inspectReplay()).toBeDisabled();
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
  });

  it('keeps the inline form and user text after a failed save', async () => {
    vi.mocked(cardsApi.saveCard).mockRejectedValue(new Error('Could not save audio'));
    mount();
    await inspectCurrent();
    fireEvent.click(screen.getByRole('button', { name: 'Save a phrase' }));
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'would like' } });
    fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'want politely' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save phrase' }));
    await waitFor(() => expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining('Could not save audio'), 'error'));
    expect(screen.getByLabelText('Word or phrase')).toHaveValue('would like');
    expect(screen.getByRole('button', { name: 'Save phrase' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save audio');
    expect(playerApi.player).not.toHaveBeenCalledWith({ action: 'play' });
  });

  it('returns to the position where inspection began and clears the explicit range before playing', async () => {
    state = { ...state, positionMs: 400 };
    mount();
    await inspectCurrent();
    await emit({ positionMs: 2600 });
    vi.mocked(playerApi.player).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Return to watching' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'play' }));
    const requests = vi.mocked(playerApi.player).mock.calls.map(([request]) => request).filter(request => ['pause', 'seek', 'play'].includes(request.action));
    expect(requests).toEqual([{ action: 'pause' }, { action: 'seek', value: 400 }, { action: 'play' }]);
  });

  it('does not resume or discard the inspected phrase when returning fails', async () => {
    mount();
    await inspectCurrent();
    vi.mocked(playerApi.player).mockImplementation(async request => { if (request.action === 'seek') throw new Error('Seek failed'); });
    fireEvent.click(screen.getByRole('button', { name: 'Return to watching' }));
    await waitFor(() => expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining('Seek failed'), 'error'));
    expect(playerApi.player).not.toHaveBeenCalledWith({ action: 'play' });
    expect(screen.getByRole('button', { name: 'Return to watching' })).toBeVisible();
  });

  it('does not offer saving a provisional subtitle', async () => {
    vi.mocked(studyApi.segments).mockResolvedValue([{ ...cues[0], status: 'provisional' }]);
    mount();
    await inspectCurrent();
    expect(screen.getByRole('button', { name: 'Save a phrase' })).toBeDisabled();
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
  });

  it('closes the phrase panel without resuming playback and restores keyboard focus', async () => {
    mount();
    await ready();
    inspectButton().focus();
    await inspectCurrent();
    vi.mocked(playerApi.player).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Return to watching' })).not.toBeInTheDocument());
    expect(playerApi.player).not.toHaveBeenCalledWith({ action: 'play' });
    expect(inspectButton()).toHaveFocus();
  });

  it('leaves empty subtitles actionable without fabricating a current phrase or requesting AI', async () => {
    vi.mocked(studyApi.segments).mockResolvedValue([]);
    mount();
    await screen.findByRole('button', { name: 'Add subtitles' });
    expect(screen.queryByRole('button', { name: 'Inspect this phrase' })).not.toBeInTheDocument();
    openTranscript();
    expect(screen.getByRole('button', { name: 'Import subtitles' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Estimate transcription' })).toBeEnabled();
    expect(aiApi.createQuote).not.toHaveBeenCalled();
  });

  it('does not issue stale seek or play commands after leaving during a pending pause', async () => {
    let releasePause!: () => void;
    const paused = new Promise<void>(resolve => { releasePause = resolve; });
    vi.mocked(playerApi.player).mockImplementation(async request => {
      if (request.action === 'pause') await paused;
    });
    mount();
    await ready();
    fireEvent.click(inspectButton());
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'pause' }));
    cleanup();
    await act(async () => { releasePause(); await paused; });
    expect(playerApi.player).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'seek' }));
    expect(playerApi.player).not.toHaveBeenCalledWith({ action: 'play' });
  });
});

describe('study navigation and unfinished phrases', () => {
  it.each([true, false])('preserves paused=%s when moving to the next caption without inspecting it', async paused => {
    state = { ...state, paused, positionMs: 300 };
    mount();
    await ready();
    vi.mocked(playerApi.player).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Next subtitle' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'seek', value: 1000 }));
    expect(state.paused).toBe(paused);
    expect(playerApi.player).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'play' }));
    expect(playerApi.player).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'pause' }));
    expect(document.querySelector('.phrase-panel')).toBeNull();
    expect(aiApi.createQuote).not.toHaveBeenCalled();
  });

  it('finds adjacent captions in a gap and disables direct replay without an active caption', async () => {
    mount();
    await ready();
    await emit({ positionMs: 2100 });
    const actions = within(screen.getByRole('group', { name: 'Subtitle playback' }));
    expect(actions.getByRole('button', { name: 'Listen again' })).toBeDisabled();
    fireEvent.click(actions.getByRole('button', { name: 'Previous subtitle' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'seek', value: 1000 }));
    await waitFor(() => expect(actions.getByRole('button', { name: 'Next subtitle' })).toBeEnabled());
    fireEvent.click(actions.getByRole('button', { name: 'Next subtitle' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'seek', value: 2500 }));
    await emit({ positionMs: 3000 });
    expect(actions.getByRole('button', { name: 'Next subtitle' })).toBeDisabled();
  });

  it('direct caption replay retains the inspected source and unsaved form', async () => {
    mount();
    await inspectCurrent();
    fireEvent.click(screen.getByRole('button', { name: 'Save a phrase' }));
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'my phrase' } });
    await emit({ positionMs: 2600 });
    fireEvent.click(within(screen.getByRole('group', { name: 'Subtitle playback' })).getByRole('button', { name: 'Listen again' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'source-seek', startMs: 2500, endMs: 3200 }));
    expect(screen.getByLabelText('Word or phrase')).toHaveValue('my phrase');
    expect(document.querySelector('.context-sentence')).toHaveTextContent(cues[0].text);
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
    expect(aiApi.createQuote).not.toHaveBeenCalled();
  });

  it('restores searched transcript settings and offset after inspecting a result', async () => {
    mount();
    await ready();
    openTranscript();
    fireEvent.change(screen.getByLabelText('Search transcript'), { target: { value: 'like' } });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle translations' }));
    const list = screen.getByLabelText('Subtitle list');
    fireEvent.wheel(list);
    fireEvent.scroll(list, { target: { scrollTop: 120 } });
    fireEvent.click(screen.getByRole('button', { name: cues[0].text }));
    await screen.findByRole('button', { name: 'Back to transcript' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to transcript' }));
    expect(await screen.findByLabelText('Search transcript')).toHaveValue('like');
    expect(screen.getByRole('button', { name: 'Toggle translations' })).toHaveAttribute('aria-pressed', 'true');
    expect(fixture.scrollOffset).toHaveBeenLastCalledWith(120, { behavior: 'auto' });
    expect(screen.getByRole('button', { name: 'Follow playback' })).toBeVisible();
  });

  it('retains separate source drafts after Escape and clears only the saved draft', async () => {
    mount();
    await inspectCurrent();
    fireEvent.click(screen.getByRole('button', { name: 'Save a phrase' }));
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'first phrase' } });
    fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'first meaning' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Word or phrase')).not.toBeInTheDocument());
    await emit({ positionMs: 2600 });
    await inspectCurrent();
    fireEvent.click(screen.getByRole('button', { name: 'Save a phrase' }));
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'second phrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unfinished phrases (2)' }));
    fireEvent.click(screen.getByRole('button', { name: /first phrase 0:00/ }));
    await waitFor(() => expect(screen.getByLabelText('Word or phrase')).toHaveValue('first phrase'));
    expect(screen.getByLabelText('Meaning')).toHaveValue('first meaning');
    vi.mocked(cardsApi.saveCard).mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Save phrase' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unfinished phrases (1)' })).toBeVisible());
    expect(cardsApi.saveCard).toHaveBeenCalledWith(expect.objectContaining({ segmentId: 'a', term: 'first phrase' }));
  });

  it('retains edited text but blocks saving after the source changes', async () => {
    const client = mount();
    await inspectCurrent();
    fireEvent.click(screen.getByRole('button', { name: 'Save a phrase' }));
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'do not lose me' } });
    fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'a meaning' } });
    await act(async () => client.setQueryData(['media', 'media', 'segments'], [{ ...cues[0], text: 'Changed' }, ...cues.slice(1)]));
    expect(screen.getByLabelText('Word or phrase')).toHaveValue('do not lose me');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save phrase' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Continue later' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unfinished phrases (1)' }));
    fireEvent.click(screen.getByRole('button', { name: /do not lose me 0:00/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save phrase' })).toBeDisabled());
    expect(screen.getByLabelText('Meaning')).toHaveValue('a meaning');
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(screen.queryByRole('button', { name: 'Unfinished phrases (1)' })).not.toBeInTheDocument();
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
  });

  it.each(['button', 'Escape'])('can close an unfinished form with %s after player failure without losing its input', async close => {
    mount();
    await inspectCurrent();
    fireEvent.click(screen.getByRole('button', { name: 'Save a phrase' }));
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'keep after failure' } });
    await emit({ ready: false, error: 'Player failed' });
    vi.mocked(playerApi.player).mockClear();
    if (close === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    else fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    await waitFor(() => expect(screen.queryByLabelText('Word or phrase')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Unfinished phrases (1)' })).toBeVisible();
    expect(playerApi.player).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'seek' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unfinished phrases (1)' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Unfinished phrases (1)' }));
    fireEvent.click(screen.getByRole('button', { name: /keep after failure 0:00/ }));
    await waitFor(() => expect(screen.getByLabelText('Word or phrase')).toHaveValue('keep after failure'));
  });

  it('keeps notes and the exit confirmation accessible if the material disappears', async () => {
    mount();
    await inspectCurrent();
    fireEvent.click(screen.getByRole('button', { name: 'Save a phrase' }));
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'orphan notes' } });
    fixture.hasMedia = false;
    fixture.blockerStatus = 'blocked';
    await emit({ positionMs: 250 });
    expect((await screen.findByLabelText('Unfinished notes') as HTMLTextAreaElement).value).toContain('orphan notes');
    expect(screen.getByRole('dialog', { name: 'You have unfinished phrases' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(fixture.resetBlocker).toHaveBeenCalledOnce();
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
  });
});

describe('study playback keyboard shortcuts', () => {
  it('leaves Space on a focused summary available for opening its details', async () => {
    mount();
    await ready();
    render(<details><summary>Task details</summary></details>);
    const summary = screen.getByText('Task details');
    summary.focus();
    vi.mocked(playerApi.player).mockClear();

    const event = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    fireEvent(summary, event);

    expect(summary).toHaveFocus();
    expect(event.defaultPrevented).toBe(false);
    expect(playerApi.player).not.toHaveBeenCalled();
  });

  it('ignores a handled key event while retaining unhandled playback shortcuts', async () => {
    mount();
    await ready();
    vi.mocked(playerApi.player).mockClear();

    const handled = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      code: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    fireEvent(document.body, handled);
    expect(playerApi.player).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    expect(playerApi.player).toHaveBeenCalledExactlyOnceWith({ action: 'play' });
  });
});

describe('study sentence and source playback', () => {
  it.each(['subtitle timing', 'audio track'] as const)(
    'does not replay a stale source after %s changes during a pending position read',
    async (changedSource) => {
      const client = mount();
      await ready();
      openTranscript();
      let releasePosition!: (value: PlayerState) => void;
      const position = new Promise<PlayerState>(resolve => {
        releasePosition = resolve;
      });
      vi.mocked(playerApi.playerState).mockReturnValueOnce(position);
      vi.mocked(playerApi.player).mockClear();

      fireEvent.click(screen.getByRole('button', { name: 'Play subtitle 0:00' }));
      if (changedSource === 'subtitle timing') {
        await act(async () => client.setQueryData(
          ['media', 'media', 'segments'],
          [{ ...cues[0], startMs: 100, endMs: 900 }, ...cues.slice(1)],
        ));
        await within(screen.getByRole('region', { name: 'Current subtitle' }))
          .findByText('Subtitles appear here as you watch.');
      } else {
        fixture.media.audioStreamIndex = 2;
        await emit({ positionMs: 100 });
      }
      await act(async () => {
        releasePosition(state);
        await position;
      });

      expect(fixture.notify).toHaveBeenCalledWith(
        expect.stringContaining('The source subtitles or audio changed. Select the passage again.'),
        'error',
      );
      expect(playerApi.player).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'source-seek' }),
      );
      expect(playerApi.playSourceRange).not.toHaveBeenCalled();
      expect(document.querySelector('.phrase-panel')).toBeNull();
    },
  );

  it('waits for native readiness and changes only the saved sentence-pause preference', async () => {
    state.ready = false;
    mount();
    await waitFor(() => expect(playerApi.playerState).toHaveBeenCalled());
    expect(inspectButton()).toBeDisabled();
    openTranscript();
    fireEvent.click(screen.getByRole('button', { name: 'Suggestions' }));
    expect(await screen.findByRole('button', { name: 'Listen to source' })).toBeDisabled();
    openPlaybackSettings();
    const checkbox = screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' });
    expect(checkbox).toBeDisabled();
    await emit({ ready: true });
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(playerApi.player).toHaveBeenCalledWith({ action: 'sentence-pause', value: 1 });
    expect(settingsApi.updateSettings).not.toHaveBeenCalled();
    expect(aiApi.createQuote).not.toHaveBeenCalled();
    expect(playerApi.playSourceRange).not.toHaveBeenCalled();
    expect(screen.getByText(/Selected ranges and repeat take priority/)).toBeVisible();
  });

  it('plays a whole source group by IDs and repeats its complete cue range without saving or sending', async () => {
    mount();
    await ready();
    openTranscript();
    fireEvent.click(screen.getByRole('button', { name: 'Suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Listen to source' }));
    await waitFor(() => expect(playerApi.playSourceRange).toHaveBeenCalledExactlyOnceWith('media', ['a', 'b']));
    const repeat = await screen.findByRole('button', { name: 'Repeat selected segment' });
    await waitFor(() => expect(repeat).toBeEnabled());
    fireEvent.click(repeat);
    expect(playerApi.player).toHaveBeenCalledWith({ action: 'source-loop', startMs: 0, endMs: 2000 });
    expect(document.querySelector('.phrase-panel .context-sentence')?.textContent).toBe('I would like\nto go home.');
    fireEvent.click(inspectReplay());
    await waitFor(() => expect(playerApi.playSourceRange).toHaveBeenCalledTimes(2));
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
    expect(aiApi.createQuote).not.toHaveBeenCalled();
  });

  it('keeps a repeat requested as soon as the selected source becomes available', async () => {
    mount();
    await ready();
    openTranscript();
    fireEvent.click(screen.getByRole('button', { name: 'Suggestions' }));
    const source = await screen.findByRole('button', { name: 'Listen to source' });
    let clicked = false;
    const observer = new MutationObserver(() => {
      const repeat = document.querySelector<HTMLButtonElement>('[aria-label="Repeat selected segment"]');
      if (repeat && !repeat.disabled && !clicked) { clicked = true; fireEvent.click(repeat); }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
    try {
      fireEvent.click(source);
      await waitFor(() => expect(clicked).toBe(true));
      expect(playerApi.player).toHaveBeenCalledWith({ action: 'source-loop', startMs: 0, endMs: 2000 });
      const repeat = screen.getByRole('button', { name: 'Repeat selected segment' });
      expect(repeat).toHaveAttribute('aria-pressed', 'true');
      expect(playerApi.player).not.toHaveBeenCalledWith({ action: 'loop' });
      fireEvent.click(repeat);
      await waitFor(() => expect(repeat).toHaveAttribute('aria-pressed', 'false'));
      expect(playerApi.player).toHaveBeenCalledWith({ action: 'loop' });
    } finally { observer.disconnect(); }
  });

  it('keeps timestamp replay explicit and suspends transcript follow for keyboard scrolling', async () => {
    mount();
    await ready();
    openTranscript();
    const play = await screen.findByRole('button', { name: 'Play subtitle 0:00' });
    fireEvent.click(play);
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'source-seek', startMs: 0, endMs: 1000 }));
    expect(playerApi.playSourceRange).not.toHaveBeenCalled();
    openTranscript();
    fireEvent.keyDown(screen.getByLabelText('Subtitle list'), { key: 'ArrowDown' });
    const previous = fixture.scroll.mock.calls.length;
    await emit({ positionMs: 2600 });
    expect(fixture.scroll).toHaveBeenCalledTimes(previous);
    fireEvent.click(screen.getByRole('button', { name: 'Follow playback' }));
    await waitFor(() => expect(fixture.scroll.mock.calls.length).toBeGreaterThan(previous));
  });

  it('inspects transcript text without initiating range playback', async () => {
    mount();
    await ready();
    openTranscript();
    fireEvent.click(screen.getByRole('button', { name: cues[1].text }));
    await screen.findByRole('button', { name: 'Return to watching' });
    expect(playerApi.player).toHaveBeenCalledWith({ action: 'pause' });
    expect(playerApi.player).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'source-seek' }));
    expect(playerApi.playSourceRange).not.toHaveBeenCalled();
    expect(document.querySelector('.phrase-panel .context-sentence')).toHaveTextContent(cues[1].text);
  });

  it('does not open a new context or start a loop after source validation fails', async () => {
    vi.mocked(playerApi.playSourceRange).mockRejectedValue(new Error('Source subtitles are no longer adjacent'));
    mount();
    await ready();
    openTranscript();
    fireEvent.click(screen.getByRole('button', { name: 'Suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Listen to source' }));
    await waitFor(() => expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining('no longer adjacent'), 'error'));
    expect(document.querySelector('.phrase-panel')).toBeNull();
    expect(playerApi.player).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'source-loop' }));
  });

  it.each([
    ['removed cue', [cues[0], cues[2]]],
    ['reordered cues', [{ ...cues[1], startMs: 0, endMs: 500 }, { ...cues[0], startMs: 600, endMs: 900 }, cues[2]]],
    ['inserted cue', [cues[0], { ...cues[0], id: 'inserted', startMs: 500, endMs: 750 }, cues[1], cues[2]]],
    ['changed timing', [cues[0], { ...cues[1], endMs: 2200 }, cues[2]]],
    ['changed text', [{ ...cues[0], text: 'A revised source.' }, ...cues.slice(1)]],
  ])('invalidates the frozen source and clears a native loop after %s', async (_name, changedCues) => {
    const client = mount();
    await ready();
    openTranscript();
    fireEvent.click(screen.getByRole('button', { name: 'Suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Listen to source' }));
    const repeat = await screen.findByRole('button', { name: 'Repeat selected segment' });
    await waitFor(() => expect(repeat).toBeEnabled());
    fireEvent.click(repeat);
    await waitFor(() => expect(repeat).toHaveAttribute('aria-pressed', 'true'));
    vi.mocked(playerApi.player).mockClear();
    vi.mocked(playerApi.playSourceRange).mockClear();
    await act(async () => client.setQueryData(['media', 'media', 'segments'], changedCues));
    await waitFor(() => expect(inspectReplay()).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Save a phrase' })).toBeDisabled();
    expect(screen.getByText('The source subtitles changed. Select the subtitles or phrase again.')).toBeVisible();
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'loop' }));
    expect(playerApi.playSourceRange).not.toHaveBeenCalled();
    await act(async () => client.setQueryData(['media', 'media', 'segments'], cues));
    expect(inspectReplay()).toBeDisabled();
    openTranscript();
    fireEvent.click(screen.getByRole('button', { name: 'Listen to source' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Repeat selected segment' })).toBeEnabled());
    expect(playerApi.playSourceRange).toHaveBeenCalledExactlyOnceWith('media', ['a', 'b']);
  });
});
