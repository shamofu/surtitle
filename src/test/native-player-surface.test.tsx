// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NativePlayer } from '../features/study/playback/NativePlayer';
import { playerApi } from '../features/study/playback/api';
import type { Media } from '../shared/contracts/media';
import type { PlayerState } from '../shared/contracts/player';
import { nativeDockInset } from '../features/study/playback/surfaceFootprint';

const fixture = vi.hoisted(() => ({
  hidden: false, notify: vi.fn(), ready: vi.fn(), position: vi.fn(),
  viewportWidth: 320,
  viewportTop: 0,
  occludingElements: [] as HTMLElement[],
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
  useSurface: () => ({ surfaceHidden: fixture.hidden, activeModal: fixture.occludingElements.at(-1) ?? null, occludingElements: fixture.occludingElements, registerModal: () => () => {} }),
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
    fireEvent.click(screen.getByRole('button', { name: /^(Play|Pause) video$/, hidden: true }));
  }
}
function toggleRequests() {
  return vi.mocked(playerApi.player).mock.calls.map(([request]) => request).filter(request => request.action === 'toggle-pause');
}
function placementRequests() {
  return vi.mocked(playerApi.player).mock.calls.map(([request]) => request)
    .filter(request => request.action === 'bounds' || request.action === 'hide');
}
async function resizeSurface(width: number) {
  fixture.viewportWidth = width;
  await act(async () => {
    fireEvent.resize(window);
    await new Promise(requestAnimationFrame);
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
  fixture.viewportWidth = 320;
  fixture.viewportTop = 0;
  fixture.occludingElements = [];
  fixture.listeners.clear();
  fixture.surfaceListeners.clear();
  vi.mocked(playerApi.loadMedia).mockResolvedValue();
  vi.mocked(playerApi.player).mockResolvedValue();
  vi.mocked(playerApi.playerState).mockResolvedValue(playerState);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: fixture.viewportTop, top: fixture.viewportTop, left: 0, width: fixture.viewportWidth, height: 200, bottom: fixture.viewportTop + 200, right: fixture.viewportWidth, toJSON: () => ({}) }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); fixture.occludingElements.forEach(element => element.remove()); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

it('reads fresh native rate after a widget adjustment and keeps the widget open', async () => {
  render(player());
  await waitFor(() => expect(screen.getByRole('slider', { name: 'Playback position' })).toBeEnabled());
  vi.mocked(playerApi.playerState).mockClear();
  vi.mocked(playerApi.playerState).mockResolvedValue({ ...playerState, rate: .75, revision: 11 });
  fireEvent.click(screen.getByRole('button', { name: 'Playback speed' }));
  fireEvent.click(screen.getByRole('button', { name: '0.75' }));
  await waitFor(() => expect(screen.getByRole('slider', { name: 'Playback speed' })).toHaveValue('0.75'));
  expect(playerApi.player).toHaveBeenCalledWith({ action: 'rate', value: .75 });
  expect(playerApi.playerState).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '0.75' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('dialog', { name: 'Playback speed' })).toBeInTheDocument();
});

it('ignores a previous media rate acknowledgement after loading another media', async () => {
  const delayedState = deferred<PlayerState>();
  const view = render(player());
  await waitFor(() => expect(screen.getByRole('slider', { name: 'Playback position' })).toBeEnabled());
  vi.mocked(playerApi.playerState).mockClear();
  vi.mocked(playerApi.playerState).mockReturnValueOnce(delayedState.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Playback speed' }));
  fireEvent.click(screen.getByRole('button', { name: '3.0' }));
  await waitFor(() => expect(playerApi.playerState).toHaveBeenCalledTimes(1));
  vi.mocked(playerApi.playerState).mockResolvedValue({ ...playerState, rate: 1.25, revision: 1 });
  view.rerender(player({ media: { ...media, id: 'other-video', path: 'C:/other.mkv' } }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Playback speed' })).toHaveTextContent('1.25×'));
  await act(async () => delayedState.resolve({ ...playerState, rate: 3, revision: 99 }));
  expect(screen.getByRole('button', { name: 'Playback speed' })).toHaveTextContent('1.25×');
  expect(screen.queryByRole('dialog', { name: 'Playback speed' })).not.toBeInTheDocument();
});

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
  expect(screen.getByRole('button', { name: 'Play video', hidden: true })).toBeDisabled();
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

it('reveals an overlapping card after failed clipping has hidden the native surface', async () => {
  const view = render(player());
  await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
  const clipping = deferred<void>();
  const recovery = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'bounds'
    ? clipping.promise : request.action === 'hide' ? recovery.promise : Promise.resolve());
  const card = document.createElement('section');
  document.body.append(card);
  fixture.occludingElements = [card];
  fixture.hidden = true;
  view.rerender(player());
  expect(card.dataset.nativeOcclusion).toBe('pending');

  await act(async () => clipping.reject(new Error('Clipping rejected')));
  await waitFor(() => expect(placementRequests().at(-1)?.action).toBe('hide'));
  expect(card.dataset.nativeOcclusion).toBe('pending');
  await act(async () => recovery.resolve());
  expect(card).not.toHaveAttribute('data-native-occlusion');
  expect(screen.getByText(/Clipping rejected/)).toBeInTheDocument();
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

it('keeps video bounds visible while modal input is blocked', async () => {
  const view = render(player());
  await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith(expect.objectContaining({ action: 'bounds' })));
  vi.mocked(playerApi.player).mockClear();
  fixture.hidden = true;
  view.rerender(player());
  await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith(expect.objectContaining({ action: 'bounds', bounds: expect.objectContaining({ width: 320, height: 200, inputBlocked: true }) })));
  expect(placementRequests().some(request => request.action === 'hide')).toBe(false);
  vi.mocked(playerApi.player).mockClear();
  fixture.hidden = false;
  view.rerender(player());
  await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith(expect.objectContaining({ action: 'bounds' })));
});

it('keeps the full video geometry and clips only its portion outside the page', async () => {
  fixture.viewportTop = -30;
  render(player());
  await waitFor(() => expect(placementRequests().at(-1)).toEqual(expect.objectContaining({
    action: 'bounds', bounds: expect.objectContaining({ y: -30, width: 320, height: 200,
      clip: { x: 0, y: 0, width: 320, height: 170 } }),
  })));
});

it('withholds an overlapping opaque card until its native clipping acknowledgement', async () => {
  const view = render(player());
  await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
  const pending = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'bounds' ? pending.promise : Promise.resolve());
  const card = document.createElement('section');
  document.body.append(card);
  Object.defineProperty(card, 'getBoundingClientRect', { value: () => ({ x: 200, y: 20, width: 200, height: 100,
    left: 200, right: 400, top: 20, bottom: 120, toJSON: () => ({}) }) });
  fixture.occludingElements = [card];
  fixture.hidden = true;
  view.rerender(player());
  expect(card.dataset.nativeOcclusion).toBe('pending');
  expect(placementRequests().at(-1)?.bounds).toEqual(expect.objectContaining({
    width: 320, height: 200, inputBlocked: true,
    occlusions: [{ x: 200, y: 20, width: 200, height: 100 }],
  }));
  await act(async () => pending.resolve());
  expect(card).not.toHaveAttribute('data-native-occlusion');
  expect(placementRequests().at(-1)?.action).toBe('bounds');
});

it.each(['input', 'disabled input', 'removed input', 'dialog'] as const)(
  'restores focus lost while clipping is pending to the %s or active dialog fallback', async target => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const view = render(player());
    await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
    const pending = deferred<void>();
    vi.mocked(playerApi.player).mockImplementation(request => request.action === 'bounds' ? pending.promise : Promise.resolve());
    const card = document.createElement('section');
    card.tabIndex = -1;
    const input = document.createElement('input');
    input.value = 'keep this phrase';
    card.append(input);
    document.body.append(card);
    (target === 'dialog' ? card : input).focus();
    input.setSelectionRange(5, 9);
    fixture.occludingElements = [card];
    fixture.hidden = true;
    view.rerender(player());
    expect(card.dataset.nativeOcclusion).toBe('pending');
    // jsdom does not implement CSS visibility focus loss. Reproduce the BODY
    // state observed in real WebView2 while the clipping acknowledgement waits.
    (document.activeElement as HTMLElement).blur();
    if (target === 'disabled input') input.disabled = true;
    if (target === 'removed input') input.remove();
    expect(document.body).toHaveFocus();
    await act(async () => pending.resolve());
    expect(card).not.toHaveAttribute('data-native-occlusion');
    expect(target === 'input' ? input : card).toHaveFocus();
    if (target === 'input') expect([input.selectionStart, input.selectionEnd]).toEqual([5, 9]);
  },
);

it('preserves focus and selection moved to another descendant before the clipping acknowledgement', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const view = render(player());
  await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
  const pending = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'bounds' ? pending.promise : Promise.resolve());
  const card = document.createElement('section');
  card.tabIndex = -1;
  const previous = document.createElement('input');
  const current = document.createElement('input');
  current.value = 'new selection';
  card.append(previous, current);
  document.body.append(card);
  previous.focus();
  fixture.occludingElements = [card];
  fixture.hidden = true;
  view.rerender(player());
  previous.blur();
  current.focus();
  current.setSelectionRange(4, 9);
  await act(async () => pending.resolve());
  expect(current).toHaveFocus();
  expect([current.selectionStart, current.selectionEnd]).toEqual([4, 9]);
});

it('does not restore an older modal during cleanup or a stale acknowledgement after a nested modal opens', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const view = render(player());
  await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
  const pending = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'bounds' ? pending.promise : Promise.resolve());
  const outer = document.createElement('section');
  outer.tabIndex = -1;
  const previous = document.createElement('input');
  outer.append(previous);
  document.body.append(outer);
  previous.focus();
  fixture.occludingElements = [outer];
  fixture.hidden = true;
  view.rerender(player());
  previous.blur();
  const inner = document.createElement('section');
  inner.tabIndex = -1;
  const current = document.createElement('input');
  inner.append(current);
  document.body.append(inner);
  fixture.occludingElements = [outer, inner];
  view.rerender(player());
  expect(document.body).toHaveFocus();
  expect(inner.dataset.nativeOcclusion).toBe('pending');
  current.focus();
  await act(async () => pending.resolve());
  expect(current).toHaveFocus();
  expect(inner).not.toHaveAttribute('data-native-occlusion');
});

it('coalesces animated bounds while one placement is pending and sends the final width', async () => {
  const pending = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'bounds' ? pending.promise : Promise.resolve());
  render(player());
  await waitFor(() => expect(placementRequests().filter(request => request.action === 'bounds')).toHaveLength(1));
  await resizeSurface(280);
  await resizeSurface(240);
  expect(placementRequests().filter(request => request.action === 'bounds')).toHaveLength(1);
  await act(async () => pending.resolve());
  await waitFor(() => expect(placementRequests().filter(request => request.action === 'bounds').map(request => request.bounds?.width)).toEqual([320, 240]));
});

it('protects confirmed and in-flight native pixels until shrink, expansion and hide acknowledge', async () => {
  const view = render(player());
  await waitFor(() => expect(document.querySelector('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready'));
  const dock = { x: 200, y: 0, width: 240, height: 400 };
  expect(nativeDockInset(dock, 1)).toBe(120);
  const shrink = deferred<void>();
  const expand = deferred<void>();
  const hide = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'hide' ? hide.promise
    : request.action === 'bounds' ? request.bounds!.width === 240 ? shrink.promise : expand.promise : Promise.resolve());
  await resizeSurface(240);
  expect(nativeDockInset(dock, 1)).toBe(120);
  await act(async () => shrink.resolve());
  expect(nativeDockInset(dock, 1)).toBe(40);
  await resizeSurface(400);
  // Expansion is protected before its response can arrive.
  expect(nativeDockInset(dock, 1)).toBe(200);
  await act(async () => expand.resolve());
  view.unmount();
  expect(nativeDockInset(dock, 1)).toBe(200);
  await act(async () => hide.resolve());
  expect(nativeDockInset(dock, 1)).toBe(0);
});

it('retains uncertain native pixels after a failed resize until recovery hide acknowledges', async () => {
  render(player());
  await waitFor(() => expect(document.querySelector('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready'));
  const resize = deferred<void>(), hide = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'bounds' ? resize.promise
    : request.action === 'hide' ? hide.promise : Promise.resolve());
  await resizeSurface(240);
  await act(async () => resize.reject(new Error('Placement rejected')));
  const dock = { x: 200, y: 0, width: 240, height: 400 };
  expect(nativeDockInset(dock, 1)).toBe(120);
  await act(async () => hide.resolve());
  expect(nativeDockInset(dock, 1)).toBe(0);
});

it('deduplicates CSS widths that produce the same physical bounds and clipping', async () => {
  render(player());
  await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
  vi.mocked(playerApi.player).mockClear();
  await resizeSurface(320.1);
  await resizeSurface(320.2);
  expect(placementRequests()).toEqual([]);
  expect(document.querySelector('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
});

it('retains inward clip changes even when the rounded HWND width stays the same', async () => {
  fixture.viewportWidth = 319.6;
  render(player());
  await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
  vi.mocked(playerApi.player).mockClear();
  await resizeSurface(320.1);
  expect(placementRequests()).toEqual([expect.objectContaining({ action: 'bounds', bounds: expect.objectContaining({ width: 320.1 }) })]);
});

it('retains outward occlusion changes while deduplicating the same physical region', async () => {
  let left = 10.1;
  const card = document.createElement('section');
  document.body.append(card);
  fixture.occludingElements = [card];
  vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => new DOMRect(left, 10, 10, 10));
  render(player());
  await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
  vi.mocked(playerApi.player).mockClear();
  left = 10.2;
  await resizeSurface(320);
  expect(placementRequests()).toEqual([]);
  expect(card).not.toHaveAttribute('data-native-occlusion');
  left = 10;
  await resizeSurface(320);
  expect(placementRequests()).toHaveLength(1);
});

it('sends the rounded shell shape and updates it when only its physical corner radius changes', async () => {
  const card = document.createElement('section');
  card.style.borderTopLeftRadius = '12px';
  document.body.append(card);
  fixture.occludingElements = [card];
  vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => new DOMRect(-20, 10, 60, 40));
  render(player());
  await waitFor(() => expect(placementRequests().at(-1)?.bounds?.occlusions).toEqual([
    { x: -20, y: 10, width: 60, height: 40, borderRadius: 12 },
  ]));
  vi.mocked(playerApi.player).mockClear();
  card.style.borderTopLeftRadius = '12.1px';
  await resizeSurface(320);
  expect(placementRequests()).toEqual([]);
  card.style.borderTopLeftRadius = '8px';
  await resizeSurface(320);
  expect(placementRequests()).toHaveLength(1);
  expect(placementRequests()[0].bounds?.occlusions?.[0].borderRadius).toBe(8);
  card.style.borderTopLeftRadius = '0px';
  await resizeSurface(320);
  expect(placementRequests().at(-1)?.bounds?.occlusions).toEqual([{ x: -20, y: 10, width: 60, height: 40 }]);
});

it('matches native rounding away from zero for negative half-pixel positions', async () => {
  fixture.viewportTop = -.4;
  render(player());
  await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
  vi.mocked(playerApi.player).mockClear();
  fixture.viewportTop = -.5;
  await resizeSurface(320);
  expect(placementRequests()).toEqual([expect.objectContaining({ action: 'bounds', bounds: expect.objectContaining({ y: -.5 }) })]);
});

it('batches layout ticks and cancels the queued sample when the endpoint is measured', async () => {
  render(player());
  await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
  vi.mocked(playerApi.player).mockClear();
  fixture.viewportWidth = 280;
  await act(async () => {
    window.dispatchEvent(new Event('surtitle-player-layout'));
    window.dispatchEvent(new Event('surtitle-player-layout'));
    fixture.viewportWidth = 240;
    window.dispatchEvent(new CustomEvent('surtitle-player-layout', { detail: { immediate: true } }));
    await new Promise(requestAnimationFrame);
  });
  expect(placementRequests()).toEqual([expect.objectContaining({ action: 'bounds', bounds: expect.objectContaining({ width: 240 }) })]);
});

it('coalesces modal input blocking with the final geometry without hiding the video', async () => {
  const pending = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'bounds' ? pending.promise : Promise.resolve());
  const view = render(player());
  await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
  vi.mocked(playerApi.player).mockClear();
  await resizeSurface(240);
  fixture.hidden = true;
  view.rerender(player());
  expect(placementRequests()).toEqual([]);
  await act(async () => pending.resolve());
  await waitFor(() => expect(placementRequests()).toEqual([expect.objectContaining({ action: 'bounds', bounds: expect.objectContaining({ width: 240, inputBlocked: true }) })]));
  fixture.hidden = false;
  view.rerender(player());
  await waitFor(() => expect(placementRequests().at(-1)).toEqual(expect.objectContaining({ action: 'bounds', bounds: expect.objectContaining({ width: 240 }) })));
});

it('does not hide or resend identical video geometry when a modal opens and closes before placement settles', async () => {
  const pending = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'bounds' ? pending.promise : Promise.resolve());
  const view = render(player());
  await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
  vi.mocked(playerApi.player).mockClear();
  fixture.hidden = true;
  view.rerender(player());
  fixture.hidden = false;
  view.rerender(player());
  await resizeSurface(320);
  expect(placementRequests()).toEqual([]);
  await act(async () => pending.resolve());
  expect(placementRequests()).toEqual([]);
});

it('hides after an in-flight placement on unmount without sending its queued resize', async () => {
  const pending = deferred<void>();
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'bounds' ? pending.promise : Promise.resolve());
  const view = render(player());
  await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
  vi.mocked(playerApi.player).mockClear();
  await resizeSurface(240);
  view.unmount();
  await act(async () => pending.resolve());
  await waitFor(() => expect(placementRequests()).toEqual([{ action: 'hide' }]));
});

it('serializes a replacement player behind the departing surface hide', async () => {
  const pending = deferred<void>();
  let deferBounds = true;
  vi.mocked(playerApi.player).mockImplementation(request => request.action === 'bounds' && deferBounds ? pending.promise : Promise.resolve());
  const previous = render(player());
  await waitFor(() => expect(placementRequests().some(request => request.action === 'bounds')).toBe(true));
  vi.mocked(playerApi.player).mockClear();
  previous.unmount();
  fixture.viewportWidth = 210;
  render(player({ media: { ...media, id: 'replacement' } }));
  await screen.findByRole('button', { name: 'Play video' });
  await resizeSurface(210);
  expect(placementRequests()).toEqual([]);
  deferBounds = false;
  await act(async () => pending.resolve());
  await waitFor(() => expect(placementRequests().map(request => request.action)).toEqual(['hide', 'bounds']));
  expect(placementRequests().at(-1)?.bounds?.width).toBe(210);
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

it('changes the caption gap preference independently of playback readiness and offers save retry', async () => {
  const change = vi.fn();
  const retry = vi.fn();
  const view = render(player({ settingsOpen: true, onGapModeChange: change, gapModeReady: false }));
  const select = screen.getByRole('combobox', { name: 'Between captions' });
  expect(select).toBeDisabled();
  expect(select).toHaveValue('review');
  view.rerender(player({ settingsOpen: true, onGapModeChange: change, gapMode: 'preview', interactionsDisabled: true }));
  expect(select).toBeEnabled();
  expect(select).toHaveValue('preview');
  fireEvent.change(select, { target: { value: 'review' } });
  expect(change).toHaveBeenCalledExactlyOnceWith('review');
  view.rerender(player({ settingsOpen: true, onGapModeChange: change, gapModeError: 'Disk full', onGapModeRetry: retry }));
  expect(screen.getByRole('alert')).toHaveTextContent('Disk full');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(retry).toHaveBeenCalledOnce();
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
  await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith(expect.objectContaining({ action: 'bounds', bounds: expect.objectContaining({ inputBlocked: true }) })));
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
