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
}));
vi.mock('../features/study/playback/api', () => ({ playerApi: { loadMedia: vi.fn(), playerState: vi.fn(), player: vi.fn() } }));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../shared/native/events', () => ({
  subscribeNative: (_event: string, listener: (event: { payload: PlayerState }) => void) => {
    fixture.listeners.add(listener);
    return () => fixture.listeners.delete(listener);
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

it('offers the selected embedded playback track to the study subtitle chooser', async () => {
  const choose = vi.fn();
  render(player({ settingsOpen: true, onUseStudySubtitles: choose }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use these captions for study' }));
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
  await act(async () => snapshot.resolve({ ...playerState, paused: false, positionMs: 7800, revision: 20 }));
  expect(seek).toHaveValue('7800');
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
