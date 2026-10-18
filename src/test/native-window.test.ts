// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { subscribeWindowClose, registerCloseTask, closeWindow, hasPendingCloseTasks, requestWindowClose, setWindowTheme } from '../shared/native/window';

const fixture = vi.hoisted(() => ({ register: vi.fn(), destroy: vi.fn(), close: vi.fn(), theme: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: fixture.register, destroy: fixture.destroy, close: fixture.close, setTheme: fixture.theme }) }));
afterEach(() => vi.resetAllMocks());

it('re-enters native close guards and releases the native theme override for system mode', async () => {
  await requestWindowClose();
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.destroy).not.toHaveBeenCalled();
  await setWindowTheme('dark');
  await setWindowTheme('light');
  await setWindowTheme('system');
  expect(fixture.theme.mock.calls).toEqual([['dark'], ['light'], [null]]);
});

it('waits for pending saves before destroying and leaves the app open after a failed write', async () => {
  let finish!: () => void;
  const remove = registerCloseTask(() => new Promise<void>(resolve => { finish = resolve; }));
  const closing = closeWindow(); expect(fixture.destroy).not.toHaveBeenCalled();
  finish(); await closing; expect(fixture.destroy).toHaveBeenCalledOnce(); remove();
  fixture.destroy.mockClear();
  const removeFailure = registerCloseTask(async () => { throw Error('Disk full'); });
  await expect(closeWindow()).rejects.toThrow('Disk full'); expect(fixture.destroy).not.toHaveBeenCalled(); removeFailure();
});

it('prevents disposed close callbacks from overriding a newer unsaved-input guard', async () => {
  let complete!: (stop: () => void) => void;
  fixture.register.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const shouldPrevent = vi.fn(() => true);
  const dispose = subscribeWindowClose(shouldPrevent, { onError: vi.fn() });
  const callback = fixture.register.mock.calls[0][0];
  dispose();
  const event = { preventDefault: vi.fn() };
  callback(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(shouldPrevent).not.toHaveBeenCalled();
  const stop = vi.fn();
  complete(stop);
  await Promise.resolve();
  expect(stop).toHaveBeenCalledOnce();
});

it('allows clean closure and prevents protected closure', async () => {
  const stop = vi.fn();
  fixture.register.mockResolvedValue(stop);
  const predicate = vi.fn(() => false);
  let finish!: () => void;
  let pending = true;
  const unregister = registerCloseTask(() => new Promise<void>(resolve => { finish = () => { pending = false; resolve(); }; }), () => pending);
  const dispose = subscribeWindowClose(predicate, { onError: vi.fn() });
  await Promise.resolve();
  const event = { preventDefault: vi.fn() };
  fixture.register.mock.calls[0][0](event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  predicate.mockReturnValue(true);
  fixture.register.mock.calls[0][0](event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(fixture.destroy).not.toHaveBeenCalled();
  finish(); await closeWindow();
  unregister();
  dispose();
  expect(stop).toHaveBeenCalledOnce();
});

it('aggregates clean and pending editors through one native listener', async () => {
  const stop = vi.fn(); fixture.register.mockResolvedValue(stop);
  const clean = vi.fn(() => false), pending = vi.fn(() => true);
  const disposeClean = subscribeWindowClose(clean, { onError: vi.fn() });
  const disposePending = subscribeWindowClose(pending, { onError: vi.fn() });
  await Promise.resolve();
  expect(fixture.register).toHaveBeenCalledOnce();
  const event = { preventDefault: vi.fn() };
  fixture.register.mock.calls[0][0](event);
  expect(clean).toHaveBeenCalledOnce(); expect(pending).toHaveBeenCalledOnce();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  await closeWindow();
  disposeClean(); expect(stop).not.toHaveBeenCalled();
  disposePending(); expect(stop).toHaveBeenCalledOnce();
});

it('runs native and direct close requests through one task drain without another native close event', async () => {
  fixture.register.mockResolvedValue(vi.fn());
  let finish!: () => void;
  let pending = true;
  const run = vi.fn(() => new Promise<void>(resolve => { finish = () => { pending = false; resolve(); }; }));
  const remove = registerCloseTask(run, () => pending);
  const observer = { onStart: vi.fn(), onError: vi.fn(), onSettled: vi.fn() };
  const dispose = subscribeWindowClose(hasPendingCloseTasks, observer);
  try {
    const event = { preventDefault: vi.fn() };
    fixture.register.mock.calls[0][0](event);
    fixture.register.mock.calls[0][0](event);
    const direct = closeWindow();
    expect(run).toHaveBeenCalledOnce(); expect(observer.onStart).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    finish(); await direct; await Promise.resolve();
    expect(fixture.destroy).toHaveBeenCalledOnce(); expect(fixture.close).not.toHaveBeenCalled();
    expect(observer.onError).not.toHaveBeenCalled(); expect(observer.onSettled).toHaveBeenCalledOnce();
  } finally { remove(); dispose(); }
});

it('keeps native closure retryable after persistence fails', async () => {
  fixture.register.mockResolvedValue(vi.fn());
  let pending = true;
  const run = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementation(async () => { pending = false; });
  const remove = registerCloseTask(run, () => pending);
  const observer = { onError: vi.fn(), onSettled: vi.fn() };
  const dispose = subscribeWindowClose(hasPendingCloseTasks, observer);
  try {
    const request = fixture.register.mock.calls[0][0];
    request({ preventDefault: vi.fn() });
    await expect(closeWindow()).rejects.toThrow('disk full'); await Promise.resolve();
    expect(fixture.destroy).not.toHaveBeenCalled(); expect(observer.onError).toHaveBeenCalledOnce();
    request({ preventDefault: vi.fn() });
    await closeWindow();
    expect(run).toHaveBeenCalledTimes(2); expect(fixture.destroy).toHaveBeenCalledOnce();
  } finally { remove(); dispose(); }
});

it('does not execute close tasks when a native guard fails', async () => {
  fixture.register.mockResolvedValue(vi.fn());
  const run = vi.fn(async () => {}), error = new Error('guard failed');
  const remove = registerCloseTask(run);
  const observer = { onError: vi.fn() };
  const dispose = subscribeWindowClose(() => { throw error; }, observer);
  try {
    const event = { preventDefault: vi.fn() };
    fixture.register.mock.calls[0][0](event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(observer.onError).toHaveBeenCalledWith(error);
    expect(run).not.toHaveBeenCalled(); expect(fixture.destroy).not.toHaveBeenCalled();
  } finally { remove(); dispose(); }
});

it('reports a failed native listener registration and reconnects for a later subscriber', async () => {
  const failure = new Error('listener unavailable');
  fixture.register.mockRejectedValueOnce(failure).mockResolvedValue(vi.fn());
  const observer = { onError: vi.fn() };
  const removeFirst = subscribeWindowClose(() => false, observer);
  await Promise.resolve(); await Promise.resolve();
  expect(observer.onError).toHaveBeenCalledWith(failure);
  const removeSecond = subscribeWindowClose(() => false, { onError: vi.fn() });
  expect(fixture.register).toHaveBeenCalledTimes(2);
  const event = { preventDefault: vi.fn() };
  fixture.register.mock.calls[1][0](event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  removeFirst(); removeSecond();
});

it('tracks detached pending work and coalesces simultaneous close requests', async () => {
  let release!: () => void;
  let pending = true;
  const run = vi.fn(() => new Promise<void>(resolve => { release = () => { pending = false; resolve(); }; }));
  const remove = registerCloseTask(run, () => pending);
  expect(hasPendingCloseTasks()).toBe(true);
  const first = closeWindow(), second = closeWindow();
  expect(run).toHaveBeenCalledOnce(); release(); await Promise.all([first, second]);
  expect(fixture.destroy).toHaveBeenCalledOnce();
  remove(); expect(hasPendingCloseTasks()).toBe(false);
});

it('saves new input received after a faster editor flushes while another task is pending', async () => {
  let input = 'first', persisted = '', release!: () => void;
  let slowPending = true;
  const fast = vi.fn(async () => { persisted = input; });
  const removeFast = registerCloseTask(fast, () => persisted !== input);
  const removeSlow = registerCloseTask(async () => {
    if (slowPending) await new Promise<void>(resolve => { release = () => { slowPending = false; resolve(); }; });
  }, () => slowPending);
  try {
    const closing = closeWindow();
    expect(persisted).toBe('first');
    input = 'typed while audio saves';
    release(); await closing;
    expect(persisted).toBe(input); expect(fast).toHaveBeenCalledTimes(2);
    expect(fixture.destroy).toHaveBeenCalledOnce();
  } finally { removeFast(); removeSlow(); }
});

it('includes a newly registered task before destroying the window', async () => {
  let release!: () => void;
  let pending = true;
  const removeFirst = registerCloseTask(async () => {
    if (pending) await new Promise<void>(resolve => { release = () => { pending = false; resolve(); }; });
  }, () => pending);
  const closing = closeWindow();
  const failure = new Error('new draft is not durable');
  const removeNew = registerCloseTask(async () => { throw failure; });
  try {
    release(); await expect(closing).rejects.toThrow(failure.message);
    expect(fixture.destroy).not.toHaveBeenCalled();
  } finally { removeFirst(); removeNew(); }
});
