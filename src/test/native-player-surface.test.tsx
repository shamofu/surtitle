// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NativePlayer } from '../features/study/playback/NativePlayer';
import { playerApi } from '../features/study/playback/api';
import type { Media } from '../shared/contracts/media';
import type { PlayerState } from '../shared/contracts/player';

const fixture = vi.hoisted(() => ({
  hidden: false, notify: vi.fn(), ready: vi.fn(), position: vi.fn(),
  listeners: new Set<(event: { payload: PlayerState }) => void>(),
  surfaceListeners: new Set<(event: { payload: void }) => void>(),
}));
vi.mock('../features/study/playback/api', () => ({ playerApi: { loadMedia: vi.fn(), playerState: vi.fn(), player: vi.fn() } }));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../shared/native/events', () => ({
  subscribeNative: (event: string, listener: (event: { payload: unknown }) => void) => {
    if (event === 'player-surface-click') {
      fixture.surfaceListeners.add(listener);
      return () => fixture.surfaceListeners.delete(listener);
    }
    if (event === 'player-state') {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    }
    return () => {};
  },
}));
vi.mock('../app/runtime', () => ({
  useAppearance: () => ({ t: (_ja: string, en: string) => en }),
  useNotifications: () => ({ notify: fixture.notify }),
  useDataActions: () => ({ refresh: async () => {} }),
  useSurface: () => ({ surfaceHidden: fixture.hidden, registerModal: () => () => {} }),
}));
const media: Media = { id: 'video', title: 'Video', path: 'C:/video.mkv', kind: 'video', durationMs: 10000, learningLanguage: 'en', explanationLanguage: 'ja', createdAt: '', lastPositionMs: 0, segmentCount: 0, cardCount: 0, status: 'ready' };
const playerState: PlayerState = { revision: 10, ready: true, positionMs: 0, durationMs: 10000, paused: true, rate: 1, volume: 80, tracks: [{ id: 1, kind: 'sub', title: 'English', selected: true, ffIndex: 4 }] };
function player(extra = {}) {
  return <NativePlayer media={media} selectionRevision={0} onReady={fixture.ready} onPosition={fixture.position} {...extra} />;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function emitPosition(positionMs: number, revision: number) {
  act(() => {
    fixture.listeners.forEach(listener => listener({ payload: { ...playerState, paused: false, positionMs, revision } }));
  });
}
function clickSurface(source: 'native' | 'DOM') {
  if (source === 'native') {
    act(() => fixture.surfaceListeners.forEach(listener => listener({ payload: undefined })));
  } else {
    fireEvent.click(screen.getByRole('button', { name: /^(Play|Pause) video$/ }));
  }
}
function toggleRequests() {
  return vi.mocked(playerApi.player).mock.calls.map(([request]) => request).filter(request => request.action === 'toggle-pause');
}
async function renderPlaying() {
  vi.mocked(playerApi.playerState).mockResolvedValue({ ...playerState, paused: false, positionMs: 1000 });
  render(player());
  const seek = screen.getByRole('slider', { name: 'Playback position' });
  Object.defineProperty(seek, 'setPointerCapture', { value: vi.fn() });
  await waitFor(() => expect(seek).toBeEnabled());
  expect(seek).toHaveValue('1000');
  return seek;
}
function seekRequests() {
  return vi.mocked(playerApi.player).mock.calls.map(([request]) => request).filter(request => request.action === 'seek');
}
beforeEach(() => {
  fixture.hidden = false;
  fixture.listeners.clear();
  fixture.surfaceListeners.clear();
  vi.mocked(playerApi.loadMedia).mockResolvedValue();
  vi.mocked(playerApi.player).mockResolvedValue();
  vi.mocked(playerApi.playerState).mockResolvedValue(playerState);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, width: 320, height: 200, bottom: 200, right: 320, toJSON: () => ({}) });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

it.each(['native', 'DOM'] as const)('toggles playback exactly once for a %s video click and focuses the video control', async source => {
  render(player());
  const surface = await screen.findByRole('button', { name: 'Play video' });
  vi.mocked(playerApi.player).mockClear();
  clickSurface(source);
  expect(toggleRequests()).toEqual([{ action: 'toggle-pause' }]);
  expect(surface).toHaveFocus();
  expect(vi.mocked(playerApi.player).mock.calls.some(([request]) => request.action === 'play' || request.action === 'pause')).toBe(false);

  emitPosition(500, 11);
  expect(screen.getByRole('button', { name: 'Pause video' })).toBe(surface);
  clickSurface(source);
  expect(toggleRequests()).toEqual([{ action: 'toggle-pause' }, { action: 'toggle-pause' }]);
});

it.each(['native', 'DOM'] as const)('sends every rapid %s video click to the native toggle without waiting for a state snapshot', async source => {
  const pending = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'toggle-pause' ? pending.promise : Promise.resolve());
  render(player());
  await screen.findByRole('button', { name: 'Play video' });
  clickSurface(source);
  clickSurface(source);
  clickSurface(source);
  expect(toggleRequests()).toEqual(Array.from({ length: 3 }, () => ({ action: 'toggle-pause' })));
  expect(screen.getByRole('button', { name: 'Play video' })).toBeEnabled();
  await act(async () => pending.resolve());
});

it('ignores native and viewport clicks until the player is loaded', async () => {
  const loading = deferred<void>();
  vi.mocked(playerApi.loadMedia).mockReturnValue(loading.promise);
  render(player());
  expect(screen.queryByRole('button', { name: 'Play video' })).not.toBeInTheDocument();
  expect(fixture.surfaceListeners.size).toBe(1);
  clickSurface('native');
  fireEvent.click(screen.getByTestId('native-player-viewport'));
  expect(toggleRequests()).toEqual([]);
  await act(async () => loading.resolve());
  await screen.findByRole('button', { name: 'Play video' });
  clickSurface('native');
  expect(toggleRequests()).toEqual([{ action: 'toggle-pause' }]);
});

it.each(['disabled', 'modal', 'settings'] as const)('blocks both video click paths while %s and accepts them again after reopening', async guard => {
  const view = render(player());
  await screen.findByRole('button', { name: 'Play video' });
  fixture.hidden = guard === 'modal';
  view.rerender(player({ interactionsDisabled: guard === 'disabled', settingsOpen: guard === 'settings' }));
  expect(screen.getByRole('button', { name: 'Play video' })).toBeDisabled();
  clickSurface('native');
  clickSurface('DOM');
  expect(toggleRequests()).toEqual([]);

  fixture.hidden = false;
  view.rerender(player());
  expect(screen.getByRole('button', { name: 'Play video' })).toBeEnabled();
  clickSurface('native');
  clickSurface('DOM');
  expect(toggleRequests()).toEqual([{ action: 'toggle-pause' }, { action: 'toggle-pause' }]);
});

it('ignores native and viewport clicks after playback fails', async () => {
  render(player());
  await screen.findByRole('button', { name: 'Play video' });
  act(() => fixture.listeners.forEach(listener => listener({ payload: { ...playerState, revision: 11, error: 'Player disconnected' } })));
  expect(await screen.findByRole('alert')).toHaveTextContent('Player disconnected');
  expect(screen.queryByRole('button', { name: 'Play video' })).not.toBeInTheDocument();
  clickSurface('native');
  fireEvent.click(screen.getByTestId('native-player-viewport'));
  expect(toggleRequests()).toEqual([]);
});

it('unsubscribes native video clicks when the player unmounts', async () => {
  const view = render(player());
  await screen.findByRole('button', { name: 'Play video' });
  expect(fixture.surfaceListeners.size).toBe(1);
  view.unmount();
  expect(fixture.surfaceListeners.size).toBe(0);
  clickSurface('native');
  expect(toggleRequests()).toEqual([]);
});

it('surfaces placement errors and retries identical bounds without reloading media', async () => {
  let fail = true;
  vi.mocked(playerApi.player).mockImplementation(async request => {
    if (request.action === 'bounds' && fail) { fail = false; throw new Error('Placement rejected'); }
  });
  render(player());
  await screen.findByText(/Placement rejected/);
  fireEvent.click(screen.getByRole('button', { name: 'Retry video display' }));
  await waitFor(() => expect(vi.mocked(playerApi.player).mock.calls.filter(([request]) => request.action === 'bounds')).toHaveLength(2));
  await waitFor(() => expect(screen.queryByText(/Placement rejected/)).not.toBeInTheDocument());
  expect(playerApi.loadMedia).toHaveBeenCalledTimes(1);
});

it('restores the confirmed volume and reports a failed adjustment', async () => {
  const request = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(async control => {
    if (control.action === 'volume') await request.promise;
  });
  render(player());
  const volume = screen.getByRole('slider', { name: 'Volume' });
  await waitFor(() => expect(volume).toBeEnabled());
  fireEvent.wheel(volume, { deltaY: -100 });
  expect(volume).toHaveValue('85');
  expect(volume).toHaveAttribute('aria-valuetext', '85%');
  await act(async () => request.reject(new Error('Volume rejected')));
  expect(volume).toHaveValue('80');
  expect(volume).toHaveAttribute('aria-valuetext', '80%');
  expect(fixture.notify).toHaveBeenCalledWith('Error: Volume rejected', 'error');
});

it('ignores volume wheel gestures while playback interactions are disabled', async () => {
  render(player({ interactionsDisabled: true }));
  const volume = screen.getByRole('slider', { name: 'Volume' });
  await waitFor(() => expect(volume).toHaveValue('80'));
  expect(volume).toBeDisabled();
  fireEvent.wheel(volume, { deltaY: -100 });
  expect(vi.mocked(playerApi.player).mock.calls.some(([control]) => control.action === 'volume')).toBe(false);
});

it('hides video for a modal and restores the same bounds afterward', async () => {
  const view = render(player());
  await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith(expect.objectContaining({ action: 'bounds' })));
  vi.mocked(playerApi.player).mockClear();
  fixture.hidden = true;
  view.rerender(player());
  await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'hide' }));
  vi.mocked(playerApi.player).mockClear();
  fixture.hidden = false;
  view.rerender(player());
  await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith(expect.objectContaining({ action: 'bounds' })));
});

it('offers embedded tracks as study sources and explains that captions appear below the video', async () => {
  const choose = vi.fn();
  const close = vi.fn();
  render(player({ settingsOpen: true, onSettingsClose: close, onUseStudySubtitles: choose }));
  expect(await screen.findByText('Study subtitle source')).toBeInTheDocument();
  expect(screen.getByText('Captions appear below the player. You can import embedded captions here for study.')).toBeInTheDocument();
  expect(screen.queryByText('Playback captions')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Subtitle track' }), { target: { value: '0' } });
  await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'track', trackKind: 'sub', value: 0 }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Subtitle track' }), { target: { value: '1' } });
  await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'track', trackKind: 'sub', value: 1 }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use these captions for study' }));
  expect(close).toHaveBeenCalledOnce();
  expect(choose).toHaveBeenCalledExactlyOnceWith(4);
});

it('keeps browser and IME shortcuts local and does not repeat a held play toggle', async () => {
  const view = render(player());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
  vi.mocked(playerApi.player).mockClear();
  fireEvent.keyDown(document.body, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
  fireEvent.keyDown(document.body, { key: ' ', code: 'Space', isComposing: true });
  fireEvent.keyDown(document.body, { key: ' ', code: 'Space', repeat: true });
  expect(playerApi.player).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
  await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'play' }));
  vi.mocked(playerApi.player).mockClear();
  fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight' });
  await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'seek', value: 5000 }));
  fixture.hidden = true;
  view.rerender(player());
  await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'hide' }));
  vi.mocked(playerApi.player).mockClear();
  fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
  expect(playerApi.player).not.toHaveBeenCalled();
});

it('holds the chosen seek position through playback ticks until the control and fresh snapshot settle', async () => {
  const control = deferred<void>();
  const snapshot = deferred<PlayerState>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'seek' ? control.promise : Promise.resolve());
  const seek = await renderPlaying();
  vi.mocked(playerApi.playerState).mockReturnValueOnce(snapshot.promise);

  fireEvent.pointerDown(seek);
  emitPosition(1200, 11);
  expect(seek).toHaveValue('1000');
  fireEvent.change(seek, { target: { value: '7600' } });
  expect(seek).toHaveAttribute('data-motion-immediate');
  emitPosition(1400, 12);
  expect(seek).toHaveValue('7600');
  act(() => {
    fireEvent.pointerUp(seek);
    fireEvent.keyUp(seek, { key: 'ArrowRight' });
    fireEvent.blur(seek);
  });
  expect(seekRequests()).toEqual([{ action: 'seek', value: 7600 }]);
  emitPosition(1600, 13);
  expect(seek).toHaveValue('7600');

  await act(async () => control.resolve());
  await waitFor(() => expect(playerApi.playerState).toHaveBeenCalledTimes(2));
  emitPosition(1800, 14);
  expect(seek).toHaveValue('7600');
  expect(seek).toHaveAttribute('data-motion-immediate');
  await act(async () => snapshot.resolve({ ...playerState, paused: false, positionMs: 7800, revision: 20 }));
  expect(seek).toHaveValue('7800');
  expect(seek).not.toHaveAttribute('data-motion-immediate');
  expect(fixture.position).toHaveBeenLastCalledWith(7800);
  emitPosition(1900, 19);
  expect(seek).toHaveValue('7800');
  expect(fixture.position).toHaveBeenLastCalledWith(7800);
  emitPosition(8000, 21);
  expect(seek).toHaveValue('8000');
});

it('keeps the latest seek when an earlier control acknowledgement arrives last', async () => {
  const earlier = deferred<void>();
  const latest = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'seek'
    ? request.value === 4000 ? earlier.promise : latest.promise
    : Promise.resolve());
  const seek = await renderPlaying();
  vi.mocked(playerApi.playerState)
    .mockResolvedValue({ ...playerState, paused: false, positionMs: 4500, revision: 22 })
    .mockResolvedValueOnce({ ...playerState, paused: false, positionMs: 8200, revision: 20 });
  fireEvent.pointerDown(seek);
  fireEvent.change(seek, { target: { value: '4000' } });
  fireEvent.pointerUp(seek);
  fireEvent.pointerDown(seek);
  fireEvent.change(seek, { target: { value: '8000' } });
  fireEvent.pointerUp(seek);
  emitPosition(1500, 11);
  expect(seek).toHaveValue('8000');
  expect(seekRequests()).toEqual([{ action: 'seek', value: 4000 }, { action: 'seek', value: 8000 }]);

  await act(async () => latest.resolve());
  expect(seek).toHaveValue('8200');
  emitPosition(8300, 21);
  await act(async () => earlier.resolve());
  expect(seek).toHaveValue('8300');
  expect(fixture.notify).not.toHaveBeenCalled();
});

it('releases the seek preview and reports a failed control while playback keeps advancing', async () => {
  const control = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'seek' ? control.promise : Promise.resolve());
  const seek = await renderPlaying();
  fireEvent.pointerDown(seek);
  fireEvent.change(seek, { target: { value: '7000' } });
  fireEvent.pointerUp(seek);
  emitPosition(1400, 11);
  expect(seek).toHaveValue('7000');
  await act(async () => control.reject(new Error('Seek rejected')));
  expect(fixture.notify).toHaveBeenCalledExactlyOnceWith('Error: Seek rejected', 'error');
  expect(seek).toHaveValue('1400');
  emitPosition(1600, 12);
  expect(seek).toHaveValue('1600');
});

it('cancels a pointer seek without committing it on a later pointerup or blur', async () => {
  const seek = await renderPlaying();
  fireEvent.pointerDown(seek);
  fireEvent.change(seek, { target: { value: '7000' } });
  emitPosition(1400, 11);
  expect(seek).toHaveValue('7000');
  fireEvent.pointerCancel(seek);
  expect(seek).toHaveValue('1400');
  fireEvent.pointerUp(seek);
  fireEvent.blur(seek);
  expect(seekRequests()).toEqual([]);
  emitPosition(1600, 12);
  expect(seek).toHaveValue('1600');
});
