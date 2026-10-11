// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnimatedValue, MotionProvider, MotionRegion, MotionSwap, useMotionChange } from '../shared/motion';
import { AnimatedDetails, openAnimatedDetails } from '../shared/ui/AnimatedDetails';

let reduce: (next: boolean) => void;
const animate = vi.fn(() => ({ cancel: vi.fn(), finished: new Promise<void>(() => {}) }));
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

it('enters only current content without cloning, remounting inputs or losing composition', () => {
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
  expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.objectContaining({ duration: 100 }));
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
  expect(animate).toHaveBeenLastCalledWith([{ height: '240px' }, { height: '0px' }], expect.objectContaining({ duration: 180 }));
  bounds.mockReturnValueOnce(new DOMRect(0, 0, 300, 80));
  view.rerender(region(true));
  expect(animate).toHaveBeenLastCalledWith([{ height: '80px' }, { height: '240px' }], expect.objectContaining({ duration: 180 }));
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
  expect(animate).toHaveBeenLastCalledWith([{ height: '40px' }, { height: '240px' }], expect.objectContaining({ duration: 180 }));
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
  closing.cancel.mockImplementation(() => { openAtRelease.push(details.open); });
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
  expect(animate).toHaveBeenCalledOnce();
  view.rerender(content('third', true));
  expect(animate).toHaveBeenCalledOnce();
});
