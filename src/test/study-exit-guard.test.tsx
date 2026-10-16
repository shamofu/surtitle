// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStudyExitGuard } from '../features/study/useStudyExitGuard';

const fixture = vi.hoisted(() => ({
  options: undefined as undefined | {
    shouldBlockFn: (locations: { current: { pathname: string }; next: { pathname: string } }) => boolean | Promise<boolean>;
    enableBeforeUnload: boolean; disabled: boolean;
  },
  status: 'idle',
  proceed: vi.fn(), reset: vi.fn(), discard: vi.fn(), notify: vi.fn(), stop: vi.fn(), destroy: vi.fn(),
  closeRequested: undefined as undefined | (() => boolean),
}));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: (options: typeof fixture.options) => {
    fixture.options = options;
    return { status: fixture.status, proceed: fixture.proceed, reset: fixture.reset };
  },
}));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  destroy: fixture.destroy,
  onCloseRequested: async (callback: (event: { preventDefault: () => void }) => void) => {
    fixture.closeRequested = () => {
      let prevented = false;
      callback({ preventDefault: () => { prevented = true; } });
      return prevented;
    };
    return fixture.stop;
  },
}) }));
vi.mock('../app/runtime', () => ({ useNotifications: () => ({ notify: fixture.notify }) }));
beforeEach(() => { fixture.status = 'idle'; });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('protects dirty navigation and native close, while clean sessions and same-material navigation pass', async () => {
  const { result, rerender, unmount } = renderHook(({ dirty }) => useStudyExitGuard(dirty, false, fixture.discard), { initialProps: { dirty: false } });
  expect(fixture.options?.disabled).toBe(true);
  expect(fixture.closeRequested?.()).toBe(false);
  rerender({ dirty: true });
  expect(fixture.options?.enableBeforeUnload).toBe(true);
  expect(fixture.options?.shouldBlockFn({ current: { pathname: '/study/a' }, next: { pathname: '/cards' } })).toBe(true);
  expect(fixture.options?.shouldBlockFn({ current: { pathname: '/study/a' }, next: { pathname: '/study/a' } })).toBe(false);
  await act(async () => { expect(fixture.closeRequested?.()).toBe(true); });
  expect(result.current.open).toBe(true);
  act(() => result.current.keepEditing());
  expect(result.current.open).toBe(false);
  expect(fixture.destroy).not.toHaveBeenCalled();
  unmount();
  expect(fixture.stop).toHaveBeenCalledOnce();
});

it('resolves blocked navigation only on an explicit discard', async () => {
  fixture.status = 'blocked';
  const { result } = renderHook(() => useStudyExitGuard(true, false, fixture.discard));
  act(() => result.current.keepEditing());
  expect(fixture.reset).toHaveBeenCalledOnce();
  expect(fixture.discard).not.toHaveBeenCalled();
  await act(() => result.current.discard());
  expect(fixture.discard).toHaveBeenCalledOnce();
  expect(fixture.proceed).toHaveBeenCalledOnce();
});

it('does not discard or open a confirmation during a pending save', async () => {
  fixture.status = 'blocked';
  const { result } = renderHook(() => useStudyExitGuard(false, true, fixture.discard));
  expect(result.current.open).toBe(false);
  await act(async () => expect(await result.current.discard()).toBe(false));
  expect(fixture.discard).not.toHaveBeenCalled();
  expect(fixture.proceed).not.toHaveBeenCalled();
  expect(fixture.destroy).not.toHaveBeenCalled();
});

it('does not offer or execute a misleading discard during a blocked native close', async () => {
  const { result } = renderHook(() => useStudyExitGuard(true, false, fixture.discard));
  await act(async () => { fixture.closeRequested?.(); });
  expect(result.current.canDiscard).toBe(false);
  await act(async () => expect(await result.current.discard()).toBe(false));
  expect(fixture.destroy).not.toHaveBeenCalled();
  expect(fixture.discard).not.toHaveBeenCalled();
  expect(result.current.open).toBe(true);
});

it('waits for draft persistence before navigation and native closure', async () => {
  let complete!: () => void;
  const flush = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  renderHook(() => useStudyExitGuard(true, false, fixture.discard, flush));
  const navigation = fixture.options!.shouldBlockFn({ current: { pathname: '/study/a' }, next: { pathname: '/cards' } });
  expect(flush).toHaveBeenCalledOnce();
  complete();
  await expect(navigation).resolves.toBe(false);
  act(() => { expect(fixture.closeRequested?.()).toBe(true); });
  expect(fixture.destroy).not.toHaveBeenCalled();
  await waitFor(() => expect(flush).toHaveBeenCalledTimes(2));
  await act(async () => { complete(); });
  expect(fixture.destroy).toHaveBeenCalledOnce();
  expect(fixture.discard).not.toHaveBeenCalled();
});

it('keeps navigation blocked after failed persistence and retries without discarding', async () => {
  fixture.status = 'blocked';
  const flush = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
  const { result } = renderHook(() => useStudyExitGuard(true, false, fixture.discard, flush));
  await act(async () => {
    expect(await fixture.options!.shouldBlockFn({ current: { pathname: '/study/a' }, next: { pathname: '/cards' } })).toBe(true);
  });
  expect(result.current.error).toBe('disk full');
  expect(fixture.proceed).not.toHaveBeenCalled();
  await act(async () => expect(await result.current.retry()).toBe(true));
  expect(fixture.proceed).toHaveBeenCalledOnce();
  expect(fixture.discard).not.toHaveBeenCalled();
});

it('reports a failed retry to the dialog so its exit can be reversed', async () => {
  fixture.status = 'blocked';
  const flush = vi.fn().mockRejectedValue(new Error('still full'));
  const { result } = renderHook(() => useStudyExitGuard(true, false, fixture.discard, flush));
  await act(async () => expect(await result.current.retry()).toBe(false));
  expect(result.current.open).toBe(true);
  expect(result.current.error).toBe('still full');
  expect(fixture.proceed).not.toHaveBeenCalled();
});


it('automatically continues navigation when the pending card save finishes', async () => {
  const flush = vi.fn().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(({ saving }) => useStudyExitGuard(true, saving, fixture.discard, flush), { initialProps: { saving: true } });
  const navigating = fixture.options!.shouldBlockFn({ current: { pathname: '/study/a' }, next: { pathname: '/cards' } });
  expect(flush).not.toHaveBeenCalled();
  expect(result.current.open).toBe(false);
  rerender({ saving: false });
  await expect(navigating).resolves.toBe(false);
  expect(flush).toHaveBeenCalledOnce();
  expect(fixture.discard).not.toHaveBeenCalled();
});

it('coalesces native close requests and waits for card save without a confirmation', async () => {
  const flush = vi.fn().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(({ saving }) => useStudyExitGuard(true, saving, fixture.discard, flush), { initialProps: { saving: true } });
  act(() => { expect(fixture.closeRequested?.()).toBe(true); expect(fixture.closeRequested?.()).toBe(true); });
  expect(result.current.open).toBe(false);
  expect(fixture.destroy).not.toHaveBeenCalled();
  rerender({ saving: false });
  await waitFor(() => expect(fixture.destroy).toHaveBeenCalledOnce());
  expect(flush).toHaveBeenCalledOnce();
  expect(fixture.discard).not.toHaveBeenCalled();
});

it('retries a failed native close with one flush and keeps native discard disabled', async () => {
  const flush = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
  const { result } = renderHook(() => useStudyExitGuard(true, false, fixture.discard, flush));
  await act(async () => { fixture.closeRequested?.(); });
  expect(result.current.open).toBe(true); expect(result.current.canDiscard).toBe(false);
  expect(result.current.error).toBe('disk full'); expect(flush).toHaveBeenCalledOnce();
  expect(fixture.destroy).not.toHaveBeenCalled();
  await act(async () => expect(await result.current.retry()).toBe(true));
  expect(flush).toHaveBeenCalledTimes(2); expect(fixture.destroy).toHaveBeenCalledOnce();
  expect(fixture.discard).not.toHaveBeenCalled();
});
