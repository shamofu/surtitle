// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { subscribeNative } from '../shared/native/events';
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

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
    const dispose = subscribeNative('data-changed', vi.fn(), report);
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledWith(failure);
    dispose();
  });
  it('shares a listener, rejects malformed events, and reconnects once for all subscribers', async () => {
    vi.useFakeTimers();
    const stop = vi.fn(), first = vi.fn(), second = vi.fn(), report = vi.fn(), ready = vi.fn();
    vi.mocked(listen).mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce(stop);
    const disposeFirst = subscribeNative('data-changed', first, report, ready);
    const disposeSecond = subscribeNative('data-changed', second, report, ready);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listen).toHaveBeenCalledTimes(2); // one initial registration, one shared retry
    expect(ready).toHaveBeenCalledTimes(2);
    const receive = vi.mocked(listen).mock.calls.at(-1)![1];
    receive({ event: 'data-changed', id: 1, payload: { version: 8 } });
    expect(first).not.toHaveBeenCalled();
    const event = { event: 'data-changed', id: 1, payload: { version: 1, epoch: 'session', revision: 1, domain: 'cards' } };
    receive(event);
    expect(first).toHaveBeenCalledExactlyOnceWith(event);
    expect(second).toHaveBeenCalledExactlyOnceWith(event);
    disposeFirst();
    expect(stop).not.toHaveBeenCalled();
    disposeSecond();
    expect(stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(2);
  });
});
