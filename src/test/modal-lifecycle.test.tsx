// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SurfaceProvider, useSurface } from '../app/providers/Surface';
import { NotificationsProvider, useNotifications } from '../app/providers/Notifications';
import { Modal, useModalExit } from '../shared/ui';

vi.mock('../app/runtime', async () => ({
  useSurface: (await import('../app/providers/Surface')).useSurface,
  useAppearance: () => ({ t: (_ja: string, en: string) => en }),
}));
afterEach(cleanup);

function Editor({ onClose, action, locked = false }: { onClose: () => void; action: () => void | Promise<void>; locked?: boolean }) {
  const exit = useModalExit();
  const { notify } = useNotifications();
  const [error, setError] = useState('');
  const [count, setCount] = useState(0);
  const close = () => void exit.close(async () => { await action(); onClose(); }).catch(() => setError('Close failed'));
  return <Modal {...exit.modalProps} title="Editor" closeDisabled={locked} onClose={close}>
    <input aria-label="Phrase" defaultValue="Keep my draft" />
    <button onClick={() => setCount(value => value + 1)}>Mutate {count}</button>
    <button onClick={close}>Accepted close</button>
    <button onClick={() => notify('Saved')}>Notify</button>
    <p>{error}</p>
  </Modal>;
}
function Harness({ action, locked }: { action: () => void | Promise<void>; locked?: boolean }) {
  const [open, setOpen] = useState(false);
  const { surfaceHidden, activeModal } = useSurface();
  return <>
    <output>{surfaceHidden ? 'Input blocked' : 'Input available'}</output>
    <output>{activeModal?.matches('[data-app-modal]') ? 'Dialog registered' : 'No dialog'}</output>
    <button onClick={() => setOpen(true)}>Open editor</button>
    {open && <Editor action={action} locked={locked} onClose={() => setOpen(false)} />}
  </>;
}
function app(action = vi.fn(), locked = false) {
  return render(<SurfaceProvider><NotificationsProvider><Harness action={action} locked={locked} /></NotificationsProvider></SurfaceProvider>);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('commits once immediately and retains the opaque surface, input block and notifications while pending', async () => {
  const pending = deferred();
  const commit = vi.fn(() => pending.promise);
  app(commit);
  fireEvent.click(screen.getByText('Open editor'));
  const dialog = screen.getByRole('dialog');
  expect(dialog.tagName).toBe('SECTION');
  expect(screen.getByText('Dialog registered')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Notify'));
  fireEvent.click(screen.getByText('Accepted close'));
  expect(commit).toHaveBeenCalledOnce();
  expect(dialog).toHaveAttribute('data-state', 'closing');
  expect(dialog.querySelector('.modal-body')).toHaveAttribute('inert');
  expect(screen.getByText('Input blocked')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Mutate 0'));
  fireEvent.click(screen.getByText('Accepted close'));
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.getByText('Mutate 0')).toBeInTheDocument();
  expect(commit).toHaveBeenCalledOnce();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Saved' }));
  await act(async () => { pending.resolve(); });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByText('Input available')).toBeInTheDocument();
});

it('locks dismissal while busy but accepts a successful programmatic close', async () => {
  const action = vi.fn();
  app(action, true);
  fireEvent.click(screen.getByText('Open editor'));
  const dialog = screen.getByRole('dialog');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  fireEvent.mouseDown(document.querySelector('.modal-overlay')!);
  fireEvent.mouseUp(document.querySelector('.modal-overlay')!);
  expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
  expect(action).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByText('Accepted close')); });
  expect(action).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('reopens the same DOM and keeps uncontrolled input after an accepted close fails', async () => {
  const action = vi.fn().mockRejectedValueOnce(new Error('Close failed')).mockResolvedValue(undefined);
  app(action);
  fireEvent.click(screen.getByText('Open editor'));
  const input = screen.getByRole('textbox', { name: 'Phrase' });
  fireEvent.change(input, { target: { value: '寄り道のメモ' } });
  fireEvent.click(screen.getByText('Mutate 0'));
  await act(async () => { fireEvent.click(screen.getByText('Accepted close')); });
  expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'open');
  expect(screen.getByRole('textbox', { name: 'Phrase' })).toBe(input);
  expect(input).toHaveValue('寄り道のメモ');
  expect(screen.getByText('Mutate 1')).toBeInTheDocument();
  expect(screen.getByText('Close failed')).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByText('Accepted close')); });
  expect(action).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('releases the native surface if the owning route unmounts during a pending commit', async () => {
  const pending = deferred();
  const action = vi.fn(() => pending.promise);
  const view = app(action);
  fireEvent.click(screen.getByText('Open editor'));
  fireEvent.click(screen.getByText('Accepted close'));
  view.unmount();
  await act(async () => { pending.resolve(); });
  expect(action).toHaveBeenCalledOnce();
  expect(document.querySelector('[data-app-modal]')).toBeNull();
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

it('cancels an uncommitted close when its owner unmounts', async () => {
  const action = vi.fn();
  const { result, unmount } = renderHook(() => useModalExit());
  let pending!: Promise<boolean>;
  act(() => { pending = result.current.close(action); });
  const finish = result.current.modalProps.onExited;
  unmount();
  act(finish);
  expect(await pending).toBe(false);
  expect(action).not.toHaveBeenCalled();
});
