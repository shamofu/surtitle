// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MotionProvider } from '../shared/motion';
import { SelectionIndicator } from '../shared/motion/SelectionIndicator';

const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({ cancel: vi.fn(), finished: new Promise<void>(() => {}) }));
let positions: Record<string, DOMRect>;
let visibleFrame: DOMRect | null;
let onResize: ResizeObserverCallback;
beforeEach(() => {
  positions = {
    first: new DOMRect(100, 40, 100, 40),
    second: new DOMRect(220, 40, 100, 40),
    third: new DOMRect(340, 40, 100, 40),
  };
  visibleFrame = null;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { onResize = callback; }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    if (this.classList.contains('selection-indicator')) return visibleFrame || new DOMRect(
      100 + parseFloat(this.style.left || '0'), 40 + parseFloat(this.style.top || '0'),
      parseFloat(this.style.width || '0'), parseFloat(this.style.height || '0'),
    );
    return positions[this.dataset.option || ''] || new DOMRect(100, 40, 500, 40);
  });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  animate.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});

function Controls({ selected, variant = 'underline', reduced = false, translated = false }: {
  selected: string; variant?: 'underline' | 'pill'; reduced?: boolean; translated?: boolean;
}) {
  return <MotionProvider preference={reduced ? 'reduce' : 'system'}>
    <div role="tablist">
      <SelectionIndicator variant={variant} />
      {['first', 'second', 'third'].map(option => <button key={option} role="tab" data-option={option}
        aria-selected={selected === option}>{translated ? `${option} 翻訳` : option}</button>)}
    </div>
    <input aria-label="Draft" defaultValue="Saved draft" />
  </MotionProvider>;
}

it('places the initial decorative indicator immediately and stretches only after selection changes', () => {
  const view = render(<Controls selected="first" />);
  const marker = view.container.querySelector<HTMLElement>('.selection-indicator')!;
  expect(marker).toHaveAttribute('aria-hidden', 'true');
  expect(marker).not.toHaveAttribute('tabindex');
  expect(marker.style.left).toBe('0px');
  expect(marker.style.top).toBe('38px');
  expect(animate).not.toHaveBeenCalled();
  const input = screen.getByRole('textbox');
  input.focus();
  fireEvent.change(input, { target: { value: 'unfinished 日本語' } });
  fireEvent.compositionStart(input);
  view.rerender(<Controls selected="second" />);
  expect(screen.getByRole('tab', { name: 'second' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('textbox')).toBe(input);
  expect(input).toHaveFocus();
  expect(input).toHaveValue('unfinished 日本語');
  expect(marker.style.left).toBe('120px');
  expect(animate).toHaveBeenCalledWith([
    { left: '0px', top: '38px', width: '100px', height: '2px' },
    { left: '0px', top: '38px', width: '220px', height: '2px', offset: .45 },
    { left: '120px', top: '38px', width: '100px', height: '2px' },
  ], { duration: 200, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' });
});

it('reverses from the visible in-flight geometry and cancels the replaced animation', () => {
  const view = render(<Controls selected="first" variant="pill" />);
  view.rerender(<Controls selected="third" variant="pill" />);
  const replaced = animate.mock.results[0].value;
  visibleFrame = new DOMRect(130, 40, 240, 40);
  view.rerender(<Controls selected="second" variant="pill" />);
  expect(replaced.cancel).toHaveBeenCalledOnce();
  expect(animate.mock.calls.at(-1)?.[0][0]).toEqual({ left: '30px', top: '0px', width: '240px', height: '40px' });
});

it('settles on layout, text, visibility and motion preference changes', async () => {
  const view = render(<Controls selected="first" />);
  const marker = view.container.querySelector<HTMLElement>('.selection-indicator')!;
  view.rerender(<Controls selected="second" />);
  const resized = animate.mock.results.at(-1)!.value;
  positions.second = new DOMRect(240, 40, 130, 40);
  act(() => onResize([], {} as ResizeObserver));
  expect(resized.cancel).toHaveBeenCalledOnce();
  expect(marker.style.left).toBe('140px');
  expect(marker.style.width).toBe('130px');
  view.rerender(<Controls selected="third" />);
  const localized = animate.mock.results.at(-1)!.value;
  view.rerender(<Controls selected="third" translated />);
  await act(async () => {});
  expect(localized.cancel).toHaveBeenCalledOnce();
  view.rerender(<Controls selected="first" translated />);
  const hidden = animate.mock.results.at(-1)!.value;
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  fireEvent(document, new Event('visibilitychange'));
  expect(hidden.cancel).toHaveBeenCalledOnce();
  const count = animate.mock.calls.length;
  view.rerender(<Controls selected="second" translated />);
  expect(marker.style.left).toBe('140px');
  expect(animate.mock.calls).toHaveLength(count);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  view.rerender(<Controls selected="third" translated reduced />);
  expect(marker.style.left).toBe('240px');
  expect(animate.mock.calls).toHaveLength(count);
});

it('observes route-style selection changes without remounting its parent', async () => {
  const view = render(<MotionProvider><nav><SelectionIndicator /><a href="/" aria-current="page" data-option="first">Home</a><a href="/next" data-option="second">Next</a></nav></MotionProvider>);
  await act(async () => {
    screen.getByRole('link', { name: 'Home' }).removeAttribute('aria-current');
    screen.getByRole('link', { name: 'Next' }).setAttribute('aria-current', 'page');
  });
  expect(animate).toHaveBeenCalledOnce();
  expect(view.container.querySelector<HTMLElement>('.selection-indicator')!.style.left).toBe('120px');
  await act(async () => { screen.getByRole('link', { name: 'Next' }).removeAttribute('aria-current'); });
  expect(view.container.querySelector('.selection-indicator')).toHaveAttribute('hidden');
});

it('moves between wrapped rows without stretching across unrelated controls', () => {
  positions.third = new DOMRect(100, 84, 140, 40);
  const view = render(<Controls selected="first" />);
  view.rerender(<Controls selected="third" />);
  expect(animate.mock.calls[0][0]).toHaveLength(2);
  expect(animate.mock.calls[0][0][1]).toEqual({ left: '0px', top: '82px', width: '140px', height: '2px' });
});

it('keeps nested groups independent while the focused control and its selection update immediately', async () => {
  const nested = (selected: string) => <MotionProvider><div data-testid="outer" role="group">
    <SelectionIndicator variant="pill" />
    <button data-option="first" aria-pressed="true">Outer selected</button>
    <button data-option="second" aria-pressed="false">Outer other</button>
    <div role="tablist" aria-label="Inner tabs">
      <SelectionIndicator />
      <button data-option="first" role="tab" aria-selected={selected === 'first'}>Inner first</button>
      <button data-option="second" role="tab" aria-selected={selected === 'second'}>Inner second</button>
    </div>
  </div></MotionProvider>;
  const view = render(nested('first'));
  const outer = screen.getByTestId('outer');
  const outerMarker = outer.querySelector<HTMLElement>(':scope > .selection-indicator')!;
  const inner = screen.getByRole('tab', { name: 'Inner second' });
  inner.focus();
  view.rerender(nested('second'));
  await act(async () => {});
  expect(inner).toHaveFocus();
  expect(inner).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('button', { name: 'Outer selected' })).toHaveAttribute('aria-pressed', 'true');
  expect(animate).toHaveBeenCalledOnce();
  expect(outerMarker.style.left).toBe('0px');
  expect(outer.style.transform).toBe('');
  expect(outer.style.opacity).toBe('');
  expect(outer.style.width).toBe('');
});
