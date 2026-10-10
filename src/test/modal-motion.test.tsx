// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SurfaceProvider, useSurface } from '../app/providers/Surface';
import { NotificationsProvider, useNotifications } from '../app/providers/Notifications';
import { Modal, useModalExit } from '../shared/ui';
import { motionDurations } from '../shared/motion';

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('../shared/motion', async importOriginal => ({
  ...await importOriginal<typeof import('../shared/motion')>(),
  useAppMotion: () => ({ reducedMotion: motion.reduced }),
}));
vi.mock('../app/runtime', async () => ({
  useSurface: (await import('../app/providers/Surface')).useSurface,
  useAppearance: () => ({ t: (_ja: string, en: string) => en }),
}));

beforeEach(() => {
  motion.reduced = false;
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
const exitFallbackMs = motionDurations.exit * 1000 + 100;

function Editor({ onClose, action, locked = false }: { onClose: () => void; action: () => void | Promise<void>; locked?: boolean }) {
  const exit = useModalExit();
  const { notify } = useNotifications();
  const [error, setError] = useState('');
  const [count, setCount] = useState(0);
  const close = () => void exit.close(async () => { await action(); onClose(); }).catch(() => setError('Close failed'));
  return <Modal {...exit.modalProps} title="Editor" closeDisabled={locked} onClose={close}>
    <button onClick={() => setCount(value => value + 1)}>Mutate {count}</button>
    <button onClick={close}>Accepted close</button>
    <button onClick={() => notify('Saved')}>Notify</button>
    <p>{error}</p>
  </Modal>;
}
function Harness({ action, locked }: { action: () => void | Promise<void>; locked?: boolean }) {
  const [open, setOpen] = useState(false);
  const { surfaceHidden } = useSurface();
  return <>
    <output>{surfaceHidden ? 'Video hidden' : 'Video visible'}</output>
    <button onClick={() => setOpen(true)}>Open editor</button>
    {open && <Editor action={action} locked={locked} onClose={() => setOpen(false)} />}
  </>;
}
function app(action = vi.fn(), locked = false) {
  return render(<SurfaceProvider><NotificationsProvider><Harness action={action} locked={locked} /></NotificationsProvider></SurfaceProvider>);
}

function NestedHarness({ onClosed }: { onClosed: () => void }) {
  const [outer, setOuter] = useState(true), [inner, setInner] = useState(false);
  const outerExit = useModalExit(outer), innerExit = useModalExit(inner);
  const { surfaceHidden } = useSurface();
  return <><output>{surfaceHidden ? 'Video hidden' : 'Video visible'}</output>
    {outer && <Modal {...outerExit.modalProps} title="Editor" onClose={() => setInner(true)}>
      <button onClick={() => setInner(true)}>Open confirmation</button>
      {inner && <Modal {...innerExit.modalProps} title="Confirmation" onClose={() => void innerExit.close(() => setInner(false))}>
        <button onClick={() => void innerExit.close(async () => {
          setInner(false);
          await outerExit.close(() => { setOuter(false); onClosed(); });
        })}>Close both</button>
      </Modal>}
    </Modal>}
  </>;
}

it('keeps the native surface hidden and notifications reachable through exit, then commits navigation once', async () => {
  const navigate = vi.fn();
  app(navigate);
  fireEvent.click(screen.getByText('Open editor'));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(screen.getByText('Notify'));
  fireEvent.click(screen.getByText('Accepted close'));
  expect(dialog).toHaveAttribute('open');
  expect(dialog).toHaveAttribute('data-state', 'closing');
  expect(dialog.querySelector('.modal-body')).toHaveAttribute('inert');
  expect(screen.getByText('Video hidden')).toBeInTheDocument();
  expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Mutate 0'));
  fireEvent.click(screen.getByText('Accepted close'));
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.getByText('Mutate 0')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Saved' }));
  expect(within(dialog).getByRole('button', { name: 'Saved' })).toBeDisabled();
  await act(async () => { vi.advanceTimersByTime(exitFallbackMs - 1); });
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(navigate).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByText('Video visible')).toBeInTheDocument();
});

it('keeps close requests locked but accepts a successful programmatic close while busy', async () => {
  const action = vi.fn();
  app(action, true);
  fireEvent.click(screen.getByText('Open editor'));
  const dialog = screen.getByRole('dialog');
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  fireEvent.click(dialog);
  expect(dialog).toHaveAttribute('data-state', 'open');
  expect(action).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Accepted close'));
  await act(async () => { vi.advanceTimersByTime(exitFallbackMs); });
  expect(action).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('commits after the dialog exit animation ends without waiting for the watchdog', async () => {
  const action = vi.fn();
  app(action);
  fireEvent.click(screen.getByText('Open editor'));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(screen.getByText('Accepted close'));
  const finish = (target: Element, animationName: string) => {
    fireEvent(target, Object.assign(new Event('animationend', { bubbles: true }), { animationName }));
  };
  finish(dialog.querySelector('.modal-body')!, 'modal-exit');
  finish(dialog, 'modal-backdrop-exit');
  finish(dialog, 'modal-enter');
  expect(action).not.toHaveBeenCalled();
  expect(screen.getByText('Video hidden')).toBeInTheDocument();
  await act(async () => { finish(dialog, 'modal-exit'); });
  expect(action).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByText('Video visible')).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(exitFallbackMs); });
  expect(action).toHaveBeenCalledOnce();
});

it('exits a nested confirmation before its editor without exposing the native video between them', async () => {
  const closed = vi.fn();
  render(<SurfaceProvider><NestedHarness onClosed={closed} /></SurfaceProvider>);
  fireEvent.click(screen.getByText('Open confirmation'));
  fireEvent.click(screen.getByText('Close both'));
  expect(screen.getByRole('dialog', { name: 'Editor' })).toHaveAttribute('data-state', 'open');
  await act(async () => { vi.advanceTimersByTime(exitFallbackMs); });
  expect(screen.queryByRole('dialog', { name: 'Confirmation' })).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Editor' })).toHaveAttribute('data-state', 'closing');
  expect(screen.getByText('Video hidden')).toBeInTheDocument();
  expect(closed).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(exitFallbackMs); });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByText('Video visible')).toBeInTheDocument();
  expect(closed).toHaveBeenCalledOnce();
});

it('reopens the same dialog and preserves state after native close fails', async () => {
  const action = vi.fn().mockRejectedValueOnce(new Error('Native close failed')).mockResolvedValue(undefined);
  app(action);
  fireEvent.click(screen.getByText('Open editor'));
  fireEvent.click(screen.getByText('Mutate 0'));
  fireEvent.click(screen.getByText('Accepted close'));
  await act(async () => { vi.advanceTimersByTime(exitFallbackMs); });
  expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'open');
  expect(screen.getByText('Mutate 1')).toBeInTheDocument();
  expect(screen.getByText('Close failed')).toBeInTheDocument();
  expect(screen.getByText('Video hidden')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Accepted close'));
  await act(async () => { vi.advanceTimersByTime(exitFallbackMs); });
  expect(action).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('cancels pending navigation when the owning route unmounts', async () => {
  const action = vi.fn();
  const view = app(action);
  fireEvent.click(screen.getByText('Open editor'));
  fireEvent.click(screen.getByText('Accepted close'));
  view.unmount();
  await act(async () => { vi.runAllTimers(); });
  expect(action).not.toHaveBeenCalled();
  expect(document.querySelector('dialog[open]')).toBeNull();
});

it('finishes without a timer when motion is reduced', async () => {
  motion.reduced = true;
  const action = vi.fn();
  app(action);
  fireEvent.click(screen.getByText('Open editor'));
  await act(async () => { fireEvent.click(screen.getByText('Accepted close')); });
  expect(action).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('finishes an in-flight exit immediately when the motion preference changes to reduce', async () => {
  const action = vi.fn();
  const view = app(action);
  fireEvent.click(screen.getByText('Open editor'));
  fireEvent.click(screen.getByText('Accepted close'));
  motion.reduced = true;
  await act(async () => {
    view.rerender(<SurfaceProvider><NotificationsProvider><Harness action={action} /></NotificationsProvider></SurfaceProvider>);
  });
  expect(action).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(exitFallbackMs); });
  expect(action).toHaveBeenCalledOnce();
});

it('invalidates a close when reopened and only commits the newest accepted action', async () => {
  const first = vi.fn(), second = vi.fn();
  const { result } = renderHook(() => useModalExit());
  let cancelled!: Promise<boolean>;
  act(() => { cancelled = result.current.close(first); });
  const staleCompletion = result.current.modalProps.onExited;
  act(() => { result.current.reopen(); });
  expect(await cancelled).toBe(false);
  act(() => { result.current.modalProps.onExited(); });
  expect(first).not.toHaveBeenCalled();
  let accepted!: Promise<boolean>;
  act(() => { accepted = result.current.close(second); });
  act(() => { staleCompletion(); });
  expect(second).not.toHaveBeenCalled();
  act(() => { result.current.modalProps.onExited(); result.current.modalProps.onExited(); });
  expect(await accepted).toBe(true);
  expect(second).toHaveBeenCalledOnce();
});
