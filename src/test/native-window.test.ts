// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { subscribeWindowClose } from '../shared/native/window';

const fixture = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: fixture.register }) }));
afterEach(() => vi.resetAllMocks());

it('prevents disposed close callbacks from overriding a newer unsaved-input guard', async () => {
  let complete!: (stop: () => void) => void;
  fixture.register.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const shouldPrevent = vi.fn(() => true);
  const dispose = subscribeWindowClose(shouldPrevent, vi.fn());
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
  const dispose = subscribeWindowClose(predicate, vi.fn());
  await Promise.resolve();
  const event = { preventDefault: vi.fn() };
  fixture.register.mock.calls[0][0](event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  predicate.mockReturnValue(true);
  fixture.register.mock.calls[0][0](event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  dispose();
  expect(stop).toHaveBeenCalledOnce();
});
