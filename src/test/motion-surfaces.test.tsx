// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnimatedValue, MotionProvider, MotionRegion, MotionSwap, useMotionChange } from '../shared/motion';

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

it('crossfades without remounting an input, duplicating IDs or exposing old actions', () => {
  const action = vi.fn();
  const pane = (key: string) => <MotionProvider><MotionSwap stateKey={key}><label htmlFor="entry">Entry</label><input id="entry" defaultValue="draft" /><button onClick={action}>{key}</button></MotionSwap></MotionProvider>;
  const view = render(pane('first'));
  const input = screen.getByLabelText('Entry');
  const clone = vi.spyOn(view.container.querySelector('.motion-swap-live')!, 'cloneNode');
  input.focus();
  fireEvent.change(input, { target: { value: 'unfinished 日本語' } });
  view.rerender(pane('first'));
  expect(clone).not.toHaveBeenCalled();
  view.rerender(pane('second'));
  expect(clone).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('Entry')).toBe(input);
  expect(input).toHaveFocus();
  expect(input).toHaveValue('unfinished 日本語');
  expect(document.querySelectorAll('#entry')).toHaveLength(1);
  const snapshot = document.querySelector('[data-motion-snapshot]')!;
  expect(snapshot).toHaveAttribute('inert');
  expect(snapshot).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByRole('button', { name: 'first' })).not.toBeInTheDocument();
  fireEvent.click(snapshot.querySelector('button')!);
  expect(action).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'second' }));
  expect(action).toHaveBeenCalledOnce();
  act(() => vi.advanceTimersByTime(240));
  expect(document.querySelector('[data-motion-snapshot]')).toBeNull();
});

it('bounds rapid numeric updates to the current and previous exact formatted value', () => {
  const value = (number: number, immediate = false) => <MotionProvider><AnimatedValue value={`${number}%`} immediate={immediate} /></MotionProvider>;
  const view = render(value(0));
  for (let number = 1; number <= 20; number++) view.rerender(value(number));
  expect(document.querySelectorAll('[data-motion-snapshot]')).toHaveLength(1);
  expect(document.querySelector('[data-motion-snapshot]')).toHaveTextContent('19%');
  expect(view.container.querySelector('.motion-swap > .motion-swap-live')).toHaveTextContent('20%');
  view.rerender(value(88, true));
  expect(document.querySelector('[data-motion-snapshot]')).toBeNull();
  expect(view.container).toHaveTextContent('88%');
});

it('retains a closing region, disables it immediately, and ignores an interrupted exit', () => {
  const region = (open: boolean) => <MotionProvider><MotionRegion open={open} keepMounted><input aria-label="Draft" defaultValue="saved locally" /></MotionRegion></MotionProvider>;
  const view = render(region(true));
  const input = screen.getByLabelText('Draft');
  view.rerender(region(false));
  expect(input.parentElement).toHaveAttribute('inert');
  expect(input.parentElement).not.toHaveAttribute('hidden');
  view.rerender(region(true));
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByLabelText('Draft')).toBe(input);
  expect(input.parentElement).not.toHaveAttribute('hidden');
  view.rerender(region(false));
  reduce(true);
  expect(input.parentElement).toHaveAttribute('hidden');
  expect(input).toBeInTheDocument();
});

it('lazy mounts retained form fields and removes every decorative exit on live reduction', () => {
  const content = (open: boolean, key: string) => <MotionProvider><MotionRegion open={open} keepMounted><input aria-label="Range" /></MotionRegion><AnimatedValue value={key} /></MotionProvider>;
  const view = render(content(false, '1:00'));
  expect(screen.queryByLabelText('Range')).not.toBeInTheDocument();
  view.rerender(content(true, '1:01'));
  expect(document.querySelector('[data-motion-snapshot]')).not.toBeNull();
  reduce(true);
  expect(document.querySelector('[data-motion-snapshot]')).toBeNull();
  expect(screen.getByLabelText('Range')).toBeVisible();
});

it('fades same-node text changes without animation on mount, unrelated renders, or selection', () => {
  function Text({ value, selected = false }: { value: string; selected?: boolean }) {
    const ref = useRef<HTMLParagraphElement>(null);
    useMotionChange(ref, value, selected);
    return <p ref={ref}>{value}</p>;
  }
  const content = (value: string, selected = false) => <MotionProvider><Text value={value} selected={selected} /></MotionProvider>;
  const view = render(content('first'));
  const paragraph = screen.getByText('first');
  expect(animate).not.toHaveBeenCalled();
  view.rerender(content('first'));
  expect(animate).not.toHaveBeenCalled();
  view.rerender(content('second'));
  expect(screen.getByText('second')).toBe(paragraph);
  expect(animate).toHaveBeenCalledOnce();
  view.rerender(content('third', true));
  expect(animate).toHaveBeenCalledOnce();
});
