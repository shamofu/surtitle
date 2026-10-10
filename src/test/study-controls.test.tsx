// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrentCaption } from '../features/study/CurrentCaption';
import { StudyTranscript } from '../features/study/StudyTranscript';
import type { TranscriptTab, TranscriptViewState } from '../features/study/StudyTranscript';
import { NativePlayer } from '../features/study/playback/NativePlayer';
import { playerApi } from '../features/study/playback/api';
import type { Media, SubtitleSegment } from '../shared/contracts/media';
import type { PlayerState } from '../shared/contracts/player';

const fixture = vi.hoisted(() => ({
  notify: vi.fn(), refresh: vi.fn(), onReady: vi.fn(), onPosition: vi.fn(),
  scrollToIndex: vi.fn(), scrollToOffset: vi.fn(), measure: vi.fn(),
  listeners: [] as ((event: { payload: PlayerState }) => void)[],
  errors: [] as ((error: unknown) => void)[],
  stops: [] as (() => void)[],
}));

vi.mock('../features/study/playback/api', () => ({
  playerApi: { loadMedia: vi.fn(), playerState: vi.fn(), player: vi.fn() },
}));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../shared/native/events', () => ({
  subscribeNative: (_event: string, callback: typeof fixture.listeners[number], error: typeof fixture.errors[number]) => {
    fixture.listeners.push(callback);
    fixture.errors.push(error);
    const stop = vi.fn();
    fixture.stops.push(stop);
    return stop;
  },
}));
vi.mock('../app/runtime', () => ({
  useAppearance: () => ({ t: (_ja: string, en: string) => en }),
  useNotifications: () => ({ notify: fixture.notify }),
  useDataActions: () => ({ refresh: fixture.refresh }),
  useSurface: () => ({ surfaceHidden: false, registerModal: () => () => {} }),
}));
vi.mock('../features/study/drafts/DraftStudyPanel', () => ({ DraftStudyPanel: () => <div>Draft panel</div> }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, getScrollElement }: { count: number; getScrollElement: () => HTMLElement | null }) => ({
    measure: fixture.measure,
    takeSnapshot: () => [],
    scrollToIndex: fixture.scrollToIndex,
    scrollToOffset: (value: number, options: unknown) => {
      fixture.scrollToOffset(value, options);
      const node = getScrollElement();
      if (node) node.scrollTop = value;
    },
    getTotalSize: () => count * 126,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 126 })),
    measureElement: () => {},
  }),
}));

const media: Media = {
  id: 'media', path: 'C:/media.mp4', title: 'Media', kind: 'video',
  durationMs: 8000, lastPositionMs: 0, learningLanguage: 'en', explanationLanguage: 'ja',
  status: 'ready', createdAt: '2026-01-01', segmentCount: 2, cardCount: 0,
};
const cues: SubtitleSegment[] = [
  { id: 'a', mediaId: 'media', text: 'First subtitle', translation: '最初の字幕', startMs: 0, endMs: 1000 },
  { id: 'b', mediaId: 'media', text: 'Second subtitle', translation: '次の字幕', startMs: 2000, endMs: 3000 },
];
const playerState: PlayerState = {
  ready: true, positionMs: 0, durationMs: 8000, paused: true, rate: 1, volume: 80, tracks: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function player(selectedMedia = media, selectionRevision = 0) {
  return <NativePlayer media={selectedMedia} selected={cues[0]} selectionRevision={selectionRevision}
    onReady={fixture.onReady} onPosition={fixture.onPosition} draftMode />;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.mocked(playerApi.loadMedia).mockResolvedValue();
  vi.mocked(playerApi.playerState).mockResolvedValue(playerState);
  vi.mocked(playerApi.player).mockResolvedValue();
});
afterEach(() => {
  cleanup();
  fixture.listeners.length = 0;
  fixture.errors.length = 0;
  fixture.stops.length = 0;
  vi.resetAllMocks();
});

describe('player loading and recovery', () => {
  it('shows a load failure inline and retries only once while pending', async () => {
    const retry = deferred<void>();
    vi.mocked(playerApi.loadMedia).mockRejectedValueOnce(new Error('Cannot open media')).mockReturnValueOnce(retry.promise);
    render(player());
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot open media');
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    const button = screen.getByRole('button', { name: 'Retry player' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(playerApi.loadMedia).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('Preparing your player');
    await act(async () => retry.resolve());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fixture.onReady).toHaveBeenLastCalledWith(true);
    expect(fixture.stops[0]).toHaveBeenCalledOnce();
  });

  it('ignores a previous media load resolving after the next media is ready', async () => {
    const old = deferred<void>();
    vi.mocked(playerApi.loadMedia).mockReturnValueOnce(old.promise);
    const view = render(player());
    view.rerender(player({ ...media, id: 'new', path: 'C:/new.mp4' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
    await act(async () => old.resolve());
    expect(playerApi.playerState).toHaveBeenCalledTimes(1);
    expect(fixture.onReady).toHaveBeenLastCalledWith(true);
  });

  it('ignores a failed retry after switching media', async () => {
    const retry = deferred<void>();
    vi.mocked(playerApi.loadMedia).mockRejectedValueOnce(new Error('Initial failure')).mockReturnValueOnce(retry.promise);
    const view = render(player());
    fireEvent.click(await screen.findByRole('button', { name: 'Retry player' }));
    view.rerender(player({ ...media, id: 'new', path: 'C:/new.mp4' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
    await act(async () => retry.reject(new Error('Old failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
  });

  it('keeps a newer player event when the initial snapshot arrives late', async () => {
    const snapshot = deferred<PlayerState>();
    vi.mocked(playerApi.playerState).mockReturnValueOnce(snapshot.promise);
    render(player());
    await waitFor(() => expect(playerApi.playerState).toHaveBeenCalledOnce());
    act(() => fixture.listeners[0]({ payload: { ...playerState, positionMs: 2000, paused: false } }));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    await act(async () => snapshot.resolve(playerState));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(fixture.onPosition).toHaveBeenLastCalledWith(2000);
  });

  it('retains event subscription errors until retry and reports playback errors inline', async () => {
    const load = deferred<void>();
    vi.mocked(playerApi.loadMedia).mockReturnValueOnce(load.promise);
    render(player());
    act(() => fixture.errors[0](new Error('Events unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('Events unavailable');
    expect(screen.getByRole('button', { name: 'Retry player' })).toBeDisabled();
    await act(async () => load.resolve());
    expect(screen.getByRole('alert')).toHaveTextContent('Events unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry player' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
    act(() => fixture.listeners[1]({ payload: { ...playerState, error: 'Playback disconnected' } }));
    expect(screen.getByRole('alert')).toHaveTextContent('Playback disconnected');
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
  });

  it('clears repeat feedback when external subtitle navigation changes revision', async () => {
    const view = render(player());
    const repeat = await screen.findByRole('button', { name: 'Repeat selected segment' });
    await waitFor(() => expect(repeat).toBeEnabled());
    fireEvent.click(repeat);
    await waitFor(() => expect(repeat).toHaveAttribute('aria-pressed', 'true'));
    view.rerender(player(media, 1));
    expect(repeat).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('current subtitle controls', () => {
  it('keeps neighboring subtitle controls available in a gap and disables replay', () => {
    const previous = vi.fn(); const next = vi.fn();
    const view = render(<CurrentCaption language="en" loading={false} hasSubtitles draftMode={false} enabled
      inspectButton={createRef()} onInspect={vi.fn()} onImport={vi.fn()} onPrevious={previous} onNext={next}
      onReplay={vi.fn()} hasPrevious hasNext />);
    fireEvent.click(screen.getByRole('button', { name: 'Previous subtitle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next subtitle' }));
    expect(previous).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Listen again' })).toBeDisabled();
    view.rerender(<CurrentCaption language="en" active={cues[0]} loading={false} hasSubtitles draftMode enabled
      inspectButton={createRef()} onInspect={vi.fn()} onImport={vi.fn()} onPrevious={previous} onNext={next}
      onReplay={vi.fn()} hasPrevious hasNext />);
    expect(screen.queryByRole('button', { name: 'Next subtitle' })).not.toBeInTheDocument();
  });
});

describe('transcript session state', () => {
  it('restores search, translation, following and offset after inspecting and switching tabs', () => {
    function Session() {
      const [visible, setVisible] = useState(true);
      const [tab, setTab] = useState<TranscriptTab>('transcript');
      const [viewState, onViewStateChange] = useState<TranscriptViewState>({ search: '', following: true, showTranslations: false, scrollOffset: 0 });
      return <><button onClick={() => setVisible(value => !value)}>Toggle inspector</button>{visible &&
        <StudyTranscript media={media} segments={cues} candidates={[]} activeId="a" ready tab={tab} onTab={setTab}
          viewState={viewState} onViewStateChange={onViewStateChange} onInspect={vi.fn()} onReplay={vi.fn()}
          onEdit={vi.fn()} onImport={vi.fn()} onEstimate={vi.fn()} onReview={vi.fn()} onDraftPlay={vi.fn()} />}</>;
    }
    render(<Session />);
    fireEvent.wheel(screen.getByRole('generic', { name: 'Subtitle list' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search transcript' }), { target: { value: 'subtitle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle translations' }));
    fireEvent.scroll(screen.getByRole('generic', { name: 'Subtitle list' }), { target: { scrollTop: 180 } });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle inspector' }));
    fixture.scrollToOffset.mockClear();
    fixture.scrollToIndex.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle inspector' }));
    expect(screen.getByRole('textbox', { name: 'Search transcript' })).toHaveValue('subtitle');
    expect(screen.getByRole('button', { name: 'Toggle translations' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('最初の字幕')).toBeInTheDocument();
    expect(fixture.scrollToOffset).toHaveBeenLastCalledWith(180, { behavior: 'auto' });
    expect(fixture.scrollToIndex).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Transcript' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Suggestions' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Suggestions' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Suggestions' }), { key: 'ArrowRight', ctrlKey: true });
    expect(screen.getByRole('tab', { name: 'Suggestions' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    expect(fixture.scrollToOffset).toHaveBeenLastCalledWith(180, { behavior: 'auto' });
    fireEvent.click(screen.getByRole('button', { name: 'Follow playback' }));
    expect(screen.getByRole('textbox', { name: 'Search transcript' })).toHaveValue('');
    expect(fixture.scrollToIndex).toHaveBeenLastCalledWith(0, { align: 'center', behavior: 'auto' });
  });
});
