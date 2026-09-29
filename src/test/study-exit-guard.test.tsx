// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStudyExitGuard } from '../features/study/useStudyExitGuard';
import { closeWindow } from '../shared/native/window';

const fixture = vi.hoisted(() => ({
  options: undefined as undefined | {
    shouldBlockFn: (locations: { current: { pathname: string }; next: { pathname: string } }) => boolean;
    enableBeforeUnload: boolean; disabled: boolean;
  },
  status: 'idle',
  proceed: vi.fn(), reset: vi.fn(), discard: vi.fn(), notify: vi.fn(), stop: vi.fn(),
  closeRequested: undefined as undefined | (() => boolean),
}));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: (options: typeof fixture.options) => {
    fixture.options = options;
    return { status: fixture.status, proceed: fixture.proceed, reset: fixture.reset };
  },
}));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../shared/native/window', () => ({
  closeWindow: vi.fn(),
  subscribeWindowClose: (callback: () => boolean) => {
    fixture.closeRequested = callback;
    return fixture.stop;
  },
}));
vi.mock('../app/runtime', () => ({ useNotifications: () => ({ notify: fixture.notify }) }));
beforeEach(() => { fixture.status = 'idle'; });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('protects dirty navigation and native close, while clean sessions and same-material navigation pass', () => {
  const { result, rerender, unmount } = renderHook(({ dirty }) => useStudyExitGuard(dirty, false, fixture.discard), { initialProps: { dirty: false } });
  expect(fixture.options?.disabled).toBe(true);
  expect(fixture.closeRequested?.()).toBe(false);
  rerender({ dirty: true });
  expect(fixture.options?.enableBeforeUnload).toBe(true);
  expect(fixture.options?.shouldBlockFn({ current: { pathname: '/study/a' }, next: { pathname: '/cards' } })).toBe(true);
  expect(fixture.options?.shouldBlockFn({ current: { pathname: '/study/a' }, next: { pathname: '/study/a' } })).toBe(false);
  act(() => { expect(fixture.closeRequested?.()).toBe(true); });
  expect(result.current.open).toBe(true);
  act(() => result.current.keepEditing());
  expect(result.current.open).toBe(false);
  expect(closeWindow).not.toHaveBeenCalled();
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

it('does not discard during a pending save', async () => {
  fixture.status = 'blocked';
  const { result } = renderHook(() => useStudyExitGuard(false, true, fixture.discard));
  await act(() => result.current.discard());
  expect(fixture.discard).not.toHaveBeenCalled();
  expect(fixture.proceed).not.toHaveBeenCalled();
  expect(closeWindow).not.toHaveBeenCalled();
});

it('keeps drafts and reports native close failures, and coalesces duplicate confirmations', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(closeWindow).mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  const { result } = renderHook(() => useStudyExitGuard(true, false, fixture.discard));
  act(() => { fixture.closeRequested?.(); });
  act(() => { void result.current.discard(); void result.current.discard(); });
  expect(closeWindow).toHaveBeenCalledOnce();
  await act(async () => reject(new Error('Could not close')));
  await waitFor(() => expect(result.current.error).toBe('Could not close'));
  expect(fixture.discard).not.toHaveBeenCalled();
  expect(result.current.open).toBe(true);
});
