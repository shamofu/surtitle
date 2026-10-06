// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NativePlayer } from '../features/study/playback/NativePlayer';
import { playerApi } from '../features/study/playback/api';
import type { Media } from '../shared/contracts/media';

const fixture = vi.hoisted(() => ({ hidden: false, notify: vi.fn(), ready: vi.fn(), position: vi.fn() }));
vi.mock('../features/study/playback/api', () => ({ playerApi: { loadMedia: vi.fn(), playerState: vi.fn(), player: vi.fn() } }));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../shared/native/events', () => ({ subscribeNative: () => () => {} }));
vi.mock('../app/runtime', () => ({
  useAppearance: () => ({ t: (_ja: string, en: string) => en }),
  useNotifications: () => ({ notify: fixture.notify }),
  useDataActions: () => ({ refresh: async () => {} }),
  useSurface: () => ({ surfaceHidden: fixture.hidden, registerModal: () => () => {} }),
}));
const media: Media = { id: 'video', title: 'Video', path: 'C:/video.mkv', kind: 'video', durationMs: 10000, learningLanguage: 'en', explanationLanguage: 'ja', createdAt: '', lastPositionMs: 0, segmentCount: 0, cardCount: 0, status: 'ready' };
function player(extra = {}) {
  return <NativePlayer media={media} selectionRevision={0} onReady={fixture.ready} onPosition={fixture.position} {...extra} />;
}
beforeEach(() => {
  fixture.hidden = false;
  vi.mocked(playerApi.loadMedia).mockResolvedValue();
  vi.mocked(playerApi.player).mockResolvedValue();
  vi.mocked(playerApi.playerState).mockResolvedValue({ ready: true, positionMs: 0, durationMs: 10000, paused: true, rate: 1, volume: 80, tracks: [{ id: 1, kind: 'sub', title: 'English', selected: true, ffIndex: 4 }] });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, width: 320, height: 200, bottom: 200, right: 320, toJSON: () => ({}) });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
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
