// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PlaybackRateControl } from '../features/study/playback/PlaybackRateControl';
import { SurfaceProvider, useSurface } from '../app/providers/Surface';

vi.mock('../app/runtime', async () => ({ useSurface: (await import('../app/providers/Surface')).useSurface }));

const changeRate = vi.fn<(rate: number) => Promise<void>>();
function RegisteredModal() {
  const dialog = useRef<HTMLDivElement>(null), host = useRef<HTMLDivElement>(null);
  const { registerModal } = useSurface();
  useLayoutEffect(() => registerModal(dialog.current!, host.current!), [registerModal]);
  return <div ref={dialog} data-testid="modal-shell"><div ref={host} /></div>;
}
interface SessionProps { disabled?: boolean; initialRate?: number }
function Session({ disabled = false, initialRate = 1 }: SessionProps) {
  const [rate, setRate] = useState(initialRate);
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const surface = useSurface();
  return <>
    <PlaybackRateControl label="Playback speed" decreaseLabel="Decrease speed" increaseLabel="Increase speed" closeLabel="Close speed settings"
      value={rate} disabled={disabled} isOpen={open} onOpenChange={setOpen} triggerRef={trigger}
      onChange={async rate => { await changeRate(rate); setRate(rate); }} />
    <button onClick={() => setModal(value => !value)}>Toggle modal</button>
    {modal && <RegisteredModal />}
    <output data-testid="reported-rate">{rate}</output>
    <output data-testid="surface-state">{JSON.stringify({ blocked: surface.surfaceHidden, occlusions: surface.occludingElements.length, modal: !!surface.activeModal })}</output>
  </>;
}
const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => {
  changeRate.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('PointerEvent', MouseEvent);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});
function session(props: SessionProps = {}) { return <SurfaceProvider><Session {...props} /></SurfaceProvider>; }
function renderSession(props: SessionProps = {}) { return render(session(props)); }
function trigger() { return screen.getByRole('button', { name: 'Playback speed' }); }
function slider() { return screen.getByRole('slider', { name: 'Playback speed' }); }
function preset(name: string) { return within(screen.getByRole('group', { name: 'Playback speed' })).getByRole('button', { name }); }
function displayedRate() { return document.querySelector('.playback-rate-value'); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle(request: ReturnType<typeof deferred>) { await act(async () => { request.resolve(); await request.promise; }); }

it('opens an adjustable speed widget with slow presets and a 3× preset while keeping adjustments open', async () => {
  renderSession();
  const user = userEvent.setup();
  const button = trigger();
  expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  expect(button).toHaveAccessibleDescription('1×');
  expect(document.querySelector('select, .lucide-chevron-down')).toBeNull();
  await user.click(button);
  expect(screen.getByRole('dialog', { name: 'Playback speed' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Playback speed' })).toBeInTheDocument();
  expect(slider()).toHaveFocus();
  expect(slider()).toHaveAttribute('min', '0.25');
  expect(slider()).toHaveAttribute('max', '3');
  expect(slider()).toHaveAttribute('step', '0.05');
  expect(slider()).toHaveAttribute('aria-valuetext', '1.00×');
  expect(displayedRate()).toHaveTextContent('1.00×');
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: 'Playback speed' })).getAllByRole('button').map(button => button.textContent))
    .toEqual(['0.5', '0.75', '1.0', '1.25', '1.5', '2.0', '3.0']);
  expect(preset('1.0')).toHaveAttribute('aria-pressed', 'true');
  await user.click(preset('0.5'));
  await waitFor(() => expect(screen.getByTestId('reported-rate')).toHaveTextContent(/^0\.5$/));
  expect(slider()).toHaveValue('0.5');
  expect(displayedRate()).toHaveTextContent('0.50×');
  expect(preset('0.5')).toHaveAttribute('aria-pressed', 'true');
  expect(preset('1.0')).toHaveAttribute('aria-pressed', 'false');
  await user.click(preset('0.75'));
  await user.click(preset('3.0'));
  await waitFor(() => expect(screen.getByTestId('reported-rate')).toHaveTextContent(/^3$/));
  expect(slider()).toHaveValue('3');
  expect(displayedRate()).toHaveTextContent('3.00×');
  expect(preset('3.0')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('dialog', { name: 'Playback speed' })).toBeInTheDocument();
  expect(changeRate.mock.calls.map(([rate]) => rate)).toEqual([0.5, 0.75, 3]);
});

it('updates the range and steps by exact 0.05 increments without crossing either boundary or losing step focus', async () => {
  renderSession({ initialRate: 0.25 });
  const user = userEvent.setup();
  await user.click(trigger());
  const decrease = screen.getByRole('button', { name: 'Decrease speed' });
  const increase = screen.getByRole('button', { name: 'Increase speed' });
  expect(decrease).toHaveAttribute('aria-disabled', 'true');
  await user.click(decrease);
  expect(decrease).toHaveFocus();
  expect(changeRate).not.toHaveBeenCalled();
  await user.click(increase);
  await user.click(increase);
  await user.click(increase);
  expect(slider()).toHaveValue('0.4');
  expect(changeRate.mock.calls.map(([rate]) => rate)).toEqual([0.3, 0.35, 0.4]);
  fireEvent.change(slider(), { target: { value: '1.35' } });
  await waitFor(() => expect(screen.getByTestId('reported-rate')).toHaveTextContent(/^1\.35$/));
  expect(displayedRate()).toHaveTextContent('1.35×');
  await user.click(increase);
  expect(slider()).toHaveValue('1.4');
  await user.click(decrease);
  expect(slider()).toHaveValue('1.35');
  fireEvent.change(slider(), { target: { value: '3' } });
  await waitFor(() => expect(screen.getByTestId('reported-rate')).toHaveTextContent(/^3$/));
  expect(increase).toHaveAttribute('aria-disabled', 'true');
  await user.click(increase);
  expect(increase).toHaveFocus();
  await user.click(decrease);
  expect(slider()).toHaveValue('2.95');
  await user.click(increase);
  expect(slider()).toHaveValue('3');
  expect(increase).toHaveFocus();
  expect(changeRate.mock.calls.map(([rate]) => rate)).toEqual([0.3, 0.35, 0.4, 1.35, 1.4, 1.35, 3, 2.95, 3]);
});

it('keeps the selected preset open without a redundant rate request and restores focus on close or Escape', async () => {
  renderSession();
  const user = userEvent.setup();
  const button = trigger();
  await user.click(button);
  await user.click(preset('1.0'));
  await user.keyboard(' ');
  expect(changeRate).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'Playback speed' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Close speed settings' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Playback speed' })).not.toBeInTheDocument());
  expect(button).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(slider()).toHaveFocus();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Playback speed' })).not.toBeInTheDocument());
  expect(button).toHaveFocus();
  expect(changeRate).not.toHaveBeenCalled();
});

it('registers an opaque exclusion without blocking playback and preserves modal stacking on outside dismissal', async () => {
  renderSession();
  const user = userEvent.setup();
  await user.click(trigger());
  expect(screen.getByTestId('surface-state')).toHaveTextContent('{"blocked":false,"occlusions":1,"modal":false}');
  await user.click(screen.getByRole('button', { name: 'Toggle modal' }));
  await waitFor(() => expect(screen.getByTestId('surface-state')).toHaveTextContent('{"blocked":true,"occlusions":1,"modal":true}'));
  expect(screen.queryByRole('dialog', { name: 'Playback speed' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Toggle modal' }));
  expect(screen.getByTestId('surface-state')).toHaveTextContent('{"blocked":false,"occlusions":0,"modal":false}');
  expect(changeRate).not.toHaveBeenCalled();
});

it('keeps the unloaded or disabled player speed control unavailable', async () => {
  renderSession({ disabled: true });
  const user = userEvent.setup();
  expect(trigger()).toBeDisabled();
  await user.click(trigger());
  expect(screen.queryByRole('dialog', { name: 'Playback speed' })).not.toBeInTheDocument();
  expect(changeRate).not.toHaveBeenCalled();
});

it('serializes native requests and coalesces rapid adjustments to the latest target while masking stale reported values', async () => {
  const first = deferred(), last = deferred();
  changeRate.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => last.promise);
  renderSession();
  const user = userEvent.setup();
  await user.click(trigger());
  await user.click(screen.getByRole('button', { name: 'Increase speed' }));
  await user.click(screen.getByRole('button', { name: 'Increase speed' }));
  await user.click(screen.getByRole('button', { name: 'Increase speed' }));
  expect(changeRate).toHaveBeenCalledExactlyOnceWith(1.05);
  expect(screen.getByTestId('reported-rate')).toHaveTextContent(/^1$/);
  expect(slider()).toHaveValue('1.15');
  expect(displayedRate()).toHaveTextContent('1.15×');
  expect(trigger()).toHaveTextContent('1.15×');
  await settle(first);
  expect(changeRate.mock.calls.map(([rate]) => rate)).toEqual([1.05, 1.15]);
  expect(screen.getByTestId('reported-rate')).toHaveTextContent(/^1\.05$/);
  expect(slider()).toHaveValue('1.15');
  expect(displayedRate()).toHaveTextContent('1.15×');
  await settle(last);
  expect(screen.getByTestId('reported-rate')).toHaveTextContent(/^1\.15$/);
  expect(slider()).toHaveValue('1.15');
  expect(changeRate).toHaveBeenCalledTimes(2);
});

it('finishes the latest queued rate after the popup closes and reopens at the acknowledged value', async () => {
  const first = deferred(), last = deferred();
  changeRate.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => last.promise);
  renderSession();
  const user = userEvent.setup();
  const button = trigger();
  await user.click(button);
  fireEvent.change(slider(), { target: { value: '1.35' } });
  fireEvent.change(slider(), { target: { value: '0.75' } });
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Playback speed' })).not.toBeInTheDocument());
  expect(button).toHaveFocus();
  expect(changeRate).toHaveBeenCalledExactlyOnceWith(1.35);
  await settle(first);
  expect(changeRate.mock.calls.map(([rate]) => rate)).toEqual([1.35, 0.75]);
  expect(button).toHaveTextContent('0.75×');
  await settle(last);
  expect(screen.getByTestId('reported-rate')).toHaveTextContent(/^0\.75$/);
  await user.click(button);
  expect(slider()).toHaveValue('0.75');
  expect(preset('0.75')).toHaveAttribute('aria-pressed', 'true');
});

it('discards an unsent adjustment when disabled while allowing the in-flight request to finish', async () => {
  const first = deferred();
  changeRate.mockImplementationOnce(() => first.promise);
  const view = renderSession();
  const user = userEvent.setup();
  await user.click(trigger());
  fireEvent.change(slider(), { target: { value: '1.05' } });
  fireEvent.change(slider(), { target: { value: '2' } });
  expect(slider()).toHaveValue('2');
  view.rerender(session({ disabled: true }));
  expect(trigger()).toBeDisabled();
  expect(slider()).toBeDisabled();
  await settle(first);
  expect(changeRate).toHaveBeenCalledExactlyOnceWith(1.05);
  expect(screen.getByTestId('reported-rate')).toHaveTextContent(/^1\.05$/);
  view.rerender(session());
  expect(slider()).toHaveValue('1.05');
});

it('discards an unsent adjustment when the control unmounts', async () => {
  const first = deferred();
  changeRate.mockImplementationOnce(() => first.promise);
  const view = renderSession();
  const user = userEvent.setup();
  await user.click(trigger());
  fireEvent.change(slider(), { target: { value: '1.05' } });
  fireEvent.change(slider(), { target: { value: '2' } });
  view.unmount();
  await settle(first);
  expect(changeRate).toHaveBeenCalledExactlyOnceWith(1.05);
});
