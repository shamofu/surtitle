// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { subscribeNative } from '../shared/native/events';
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

describe('native event registration', () => {
  it('unsubscribes late registration and suppresses callbacks after disposal', async () => {
    let finish!: (stop: () => void) => void;
    vi.mocked(listen).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const callback = vi.fn();
    const stop = vi.fn();
    const dispose = subscribeNative('player-state', callback);
    dispose();
    finish(stop);
    await Promise.resolve();
    vi.mocked(listen).mock.calls.at(-1)![1]({
      event: 'player-state',
      id: 1,
      payload: {},
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
  });
  it('reports registration failure while mounted', async () => {
    const failure = new Error('IPC unavailable');
    vi.mocked(listen).mockRejectedValueOnce(failure);
    const report = vi.fn();
    const dispose = subscribeNative('app-changed', vi.fn(), report);
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledWith(failure);
    dispose();
  });
});
