// SPDX-License-Identifier: GPL-3.0-or-later
import { StrictMode, useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnimatedValue, MotionProvider, MotionRegion, MotionSwap, useMotionChange, useMotionEntrance } from '../shared/motion';
import { animateEntrance } from '../shared/motion/surfaces';
import { AnimatedDetails, openAnimatedDetails } from '../shared/ui/AnimatedDetails';

let reduce: (next: boolean) => void;
const { animate } = vi.hoisted(() => ({ animate: vi.fn((_value: { get(): number; set(value: number): void }, _to: number, _options: unknown) => ({ stop: vi.fn(), finished: new Promise<void>(() => {}) })) }));
vi.mock('motion', async importActual => ({ ...await importActual<typeof import('motion')>(), animate }));
beforeEach(() => {
  vi.useFakeTimers();
  let reduced = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced; }, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }));
  reduce = next => act(() => { reduced = next; listeners.forEach(listener => listener()); });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  animate.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (HTMLElement.prototype as Partial<HTMLElement>).animate; });

it('keeps changed content opaque without cloning, remounting inputs or losing composition', () => {
  const action = vi.fn();
  const pane = (key: string) => <MotionProvider><MotionSwap stateKey={key}><label htmlFor="entry">Entry</label><input id="entry" defaultValue="draft" /><button onClick={action}>{key}</button></MotionSwap></MotionProvider>;
  const view = render(pane('first'));
  const input = screen.getByLabelText('Entry') as HTMLInputElement;
  const clone = vi.spyOn(view.container.querySelector('.motion-swap-live')!, 'cloneNode');
  input.focus();
  fireEvent.change(input, { target: { value: 'unfinished 日本語' } });
  input.setSelectionRange(1, 4);
  fireEvent.compositionStart(input);
  view.rerender(pane('first'));
  expect(animate).not.toHaveBeenCalled();
  view.rerender(pane('second'));
  expect(clone).not.toHaveBeenCalled();
  expect(animate).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Entry')).toBe(input);
  expect(input).toHaveFocus();
  expect(input).toHaveValue('unfinished 日本語');
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
  expect(document.querySelectorAll('#entry')).toHaveLength(1);
  expect(document.querySelector('[data-motion-snapshot]')).toBeNull();
  expect(screen.queryByRole('button', { name: 'first' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'second' }));
  expect(action).toHaveBeenCalledOnce();
});

it('updates numbers and opted-out lists immediately with no animation or old value', () => {
  const value = (number: number) => <MotionProvider><AnimatedValue value={number + '%'} /><MotionSwap disabled stateKey={number}><button>{'Result ' + number}</button></MotionSwap></MotionProvider>;
  const view = render(value(0));
  const number = view.container.querySelector('.animated-value');
  for (let next = 1; next <= 20; next++) view.rerender(value(next));
  expect(view.container.querySelector('.animated-value')).toBe(number);
  expect(number).toHaveTextContent('20%');
  expect(screen.getByRole('button')).toHaveTextContent('Result 20');
  expect(animate).not.toHaveBeenCalled();
  expect(document.querySelector('[data-motion-snapshot]')).toBeNull();
});

it('reverses disclosure height from the current frame and preserves its live form', () => {
  const region = (open: boolean) => <MotionProvider><MotionRegion open={open} keepMounted><input aria-label="Draft" defaultValue="saved locally" /></MotionRegion></MotionProvider>;
  const view = render(region(true));
  const input = screen.getByLabelText('Draft');
  const host = input.parentElement!;
  const bounds = vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 240));
  view.rerender(region(false));
  expect(host).toHaveAttribute('inert');
  expect(host).not.toHaveAttribute('hidden');
  expect(animate.mock.calls.at(-1)![0].get()).toBe(240);
  expect(animate).toHaveBeenLastCalledWith(expect.anything(), 0, expect.objectContaining({ duration: .26 }));
  bounds.mockReturnValueOnce(new DOMRect(0, 0, 300, 80));
  view.rerender(region(true));
  expect(animate.mock.calls.at(-1)![0].get()).toBe(80);
  expect(animate).toHaveBeenLastCalledWith(expect.anything(), 240, expect.objectContaining({ duration: .34 }));
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByLabelText('Draft')).toBe(input);
  expect(host).not.toHaveAttribute('hidden');
  expect(host.style.overflow).toBe('');
  view.rerender(region(false));
  reduce(true);
  expect(host).toHaveAttribute('hidden');
  expect(input).toBeInTheDocument();
});

it('settles disclosure on resize and hidden-window changes without waiting for frames', () => {
  const region = (open: boolean) => <MotionProvider><MotionRegion open={open} keepMounted><input aria-label="Range" /></MotionRegion></MotionProvider>;
  const view = render(region(true));
  const host = screen.getByLabelText('Range').parentElement!;
  view.rerender(region(false));
  fireEvent(window, new Event('resize'));
  expect(host).toHaveAttribute('hidden');
  view.rerender(region(true));
  view.rerender(region(false));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  fireEvent(document, new Event('visibilitychange'));
  expect(host).toHaveAttribute('hidden');
  expect(document.documentElement).toHaveAttribute('data-visibility', 'hidden');
});

it('lazy mounts disclosures and changes status visibility immediately', () => {
  const content = (open: boolean) => <MotionProvider><MotionRegion open={open} keepMounted><input aria-label="Range" /></MotionRegion><MotionRegion open={open} mode="status"><p role="status">Saving</p></MotionRegion></MotionProvider>;
  const view = render(content(false));
  expect(screen.queryByLabelText('Range')).not.toBeInTheDocument();
  view.rerender(content(true));
  expect(screen.getByLabelText('Range')).toBeVisible();
  const count = animate.mock.calls.length;
  view.rerender(content(false));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(animate.mock.calls).toHaveLength(count + 1);
  reduce(true);
  expect(screen.getByLabelText('Range')).not.toBeVisible();
});

it('reveals measured native details and allows synchronous validation during an exit', () => {
  render(<MotionProvider><AnimatedDetails><summary>Details</summary><div><input aria-label="Required field" /></div></AnimatedDetails></MotionProvider>);
  const summary = screen.getByText('Details');
  const details = summary.parentElement as HTMLDetailsElement;
  vi.spyOn(details, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 300, details.open ? 240 : 40));
  fireEvent.click(summary);
  expect(animate.mock.calls.at(-1)![0].get()).toBe(40);
  expect(animate).toHaveBeenLastCalledWith(expect.anything(), 240, expect.objectContaining({ duration: .34 }));
  const input = screen.getByLabelText('Required field');
  input.focus();
  fireEvent.click(summary);
  expect(input.parentElement).toHaveAttribute('inert');
  expect(summary).toHaveFocus();
  act(() => { openAnimatedDetails(details); input.focus(); });
  expect(details.open).toBe(true);
  expect(input.parentElement).not.toHaveAttribute('inert');
  expect(input).toHaveFocus();
  act(() => vi.advanceTimersByTime(1000));
  expect(details.open).toBe(true);
  fireEvent.click(summary);
  reduce(true);
  expect(details.open).toBe(false);
});

it('commits closed disclosure state before releasing its final animated height', () => {
  render(<MotionProvider><AnimatedDetails open><summary>Details</summary><div>Contents</div></AnimatedDetails></MotionProvider>);
  const summary = screen.getByText('Details');
  const details = summary.parentElement as HTMLDetailsElement;
  vi.spyOn(details, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 300, details.open ? 240 : 40));
  fireEvent.click(summary);
  const closing = animate.mock.results.at(-1)!.value;
  const openAtRelease: boolean[] = [];
  closing.stop.mockImplementation(() => { openAtRelease.push(details.open); });
  act(() => vi.advanceTimersByTime(1000));
  expect(openAtRelease.length).toBeGreaterThan(0);
  expect(openAtRelease.every(open => !open)).toBe(true);
  expect(details.open).toBe(false);
});

it('does not animate unrelated content renders or opted-out updates', () => {
  function Text({ value, selected = false }: { value: string; selected?: boolean }) {
    const ref = useRef<HTMLParagraphElement>(null);
    useMotionChange(ref, value, selected);
    return <p ref={ref}>{value}</p>;
  }
  const content = (value: string, selected = false) => <MotionProvider><Text value={value} selected={selected} /></MotionProvider>;
  const view = render(content('first'));
  const paragraph = screen.getByText('first');
  view.rerender(content('first'));
  expect(animate).not.toHaveBeenCalled();
  view.rerender(content('second'));
  expect(screen.getByText('second')).toBe(paragraph);
  expect(animate).not.toHaveBeenCalled();
  view.rerender(content('third', true));
  expect(animate).not.toHaveBeenCalled();
});

it('lets one entrance own nested content without replacing focused inputs', () => {
  const content = (outer: number, inner: number) => <MotionProvider><MotionSwap stateKey={outer} preset="panel">
    <MotionSwap stateKey={inner} preset="panel"><input aria-label="Nested draft" defaultValue="日本語" /></MotionSwap>
  </MotionSwap></MotionProvider>;
  const view = render(content(0, 0));
  const input = screen.getByLabelText('Nested draft') as HTMLInputElement;
  input.focus(); input.setSelectionRange(0, 2);
  fireEvent.compositionStart(input);
  view.rerender(content(1, 1));
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.results[0].value.stop).toHaveBeenCalledOnce();
  expect(animate.mock.results[1].value.stop).not.toHaveBeenCalled();
  view.rerender(content(1, 2));
  expect(animate).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText('Nested draft')).toBe(input);
  expect(input).toHaveFocus();
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 2]);
  fireEvent(window, new Event('resize'));
  view.rerender(content(1, 3));
  expect(animate).toHaveBeenCalledTimes(3);
});

it('settles a page entrance on reduction and never replays it when motion returns', () => {
  function Page() {
    const ref = useRef<HTMLDivElement>(null);
    useMotionEntrance(ref);
    return <div ref={ref}>Page</div>;
  }
  render(<StrictMode><MotionProvider><Page /></MotionProvider></StrictMode>);
  // StrictMode replaces its first setup before paint; the replacement must enter.
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.results[0].value.stop).toHaveBeenCalledOnce();
  expect(animate.mock.results[1].value.stop).not.toHaveBeenCalled();
  act(() => vi.advanceTimersToNextFrame());
  expect(animate).toHaveBeenCalledWith(
    expect.anything(), 1,
    expect.objectContaining({ duration: .38 }),
  );
  const progress = animate.mock.calls.at(-1)![0];
  act(() => progress.set(.5));
  expect(screen.getByText('Page').style.opacity).toBe('0.5');
  expect(screen.getByText('Page').style.transform).toBe('translate(24px, 0px)');
  reduce(true);
  expect(animate.mock.results[1].value.stop).toHaveBeenCalledOnce();
  act(() => progress.set(.8));
  expect(screen.getByText('Page').style.opacity).toBe('');
  expect(screen.getByText('Page').style.transform).toBe('');
  reduce(false);
  expect(animate).toHaveBeenCalledTimes(2);
});

it('never animates opaque modal shells or native video ancestors', () => {
  const view = render(<><div data-app-modal="" /><div data-testid="player-parent"><div className="native-player-viewport" /></div></>);
  animateEntrance(view.container.querySelector('[data-app-modal]') as HTMLElement, 'modal');
  animateEntrance(screen.getByTestId('player-parent'), 'page');
  animateEntrance(view.container.querySelector('.native-player-viewport') as HTMLElement, 'swap');
  expect(animate).not.toHaveBeenCalled();
});

it('settles disclosures inside opaque modal geometry immediately', () => {
  const content = (open: boolean) => <MotionProvider><div data-motion-geometry="stable">
    <AnimatedDetails><summary>Options</summary><div><input aria-label="Modal draft" /></div></AnimatedDetails>
    <MotionRegion open={open} keepMounted>Conditional fields</MotionRegion>
  </div></MotionProvider>;
  const view = render(content(false));
  const summary = screen.getByText('Options');
  fireEvent.click(summary);
  expect(summary.parentElement).toHaveAttribute('open');
  const input = screen.getByLabelText('Modal draft');
  view.rerender(content(true));
  expect(screen.getByText('Conditional fields')).toBeVisible();
  view.rerender(content(false));
  expect(screen.getByText('Conditional fields')).not.toBeVisible();
  fireEvent.click(summary);
  expect(summary.parentElement).not.toHaveAttribute('open');
  expect(screen.getByLabelText('Modal draft')).toBe(input);
  expect(animate).not.toHaveBeenCalled();
});
