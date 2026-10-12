// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrentCaption } from '../features/study/CurrentCaption';
import { MotionProvider } from '../shared/motion';
import type { SubtitleSegment } from '../shared/contracts/media';

vi.mock('../app/runtime', () => ({ useAppearance: () => ({ t: (_ja: string, en: string) => en }) }));

const first: SubtitleSegment = { id: 'first', mediaId: 'media', text: 'First subtitle', translation: '最初の字幕', startMs: 0, endMs: 1000 };
const second: SubtitleSegment = { ...first, id: 'second', text: 'Second subtitle', translation: '次の字幕', startMs: 2000, endMs: 3000 };
const third: SubtitleSegment = { ...first, id: 'third', text: 'Third subtitle', startMs: 4000, endMs: 5000 };
const animatedCaptionNodes: HTMLElement[] = [];
const inspect = vi.fn();
const replay = vi.fn();
const animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');

function caption(active: SubtitleSegment | undefined, reduced = false, draftMode = false, enabled = true) {
  return <MotionProvider preference={reduced ? 'reduce' : 'system'}>
    <CurrentCaption active={active} language="en" loading={false} hasSubtitles draftMode={draftMode} enabled={enabled}
      inspectButton={createRef()} onInspect={inspect} onImport={vi.fn()} onPrevious={vi.fn()} onNext={vi.fn()}
      onReplay={replay} hasPrevious hasNext />
  </MotionProvider>;
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn(function (this: HTMLElement) {
    if (this.matches('.current-caption-text, .caption-translation')) animatedCaptionNodes.push(this);
    return { cancel: vi.fn(), finished: new Promise(() => {}) } as unknown as Animation;
  }) });
});
afterEach(() => {
  cleanup();
  animatedCaptionNodes.length = 0;
  window.getSelection()?.removeAllRanges();
  if (animateDescriptor) Object.defineProperty(HTMLElement.prototype, 'animate', animateDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe('immediate current captions', () => {
  it('shows asynchronously loaded and restored cues immediately through player readiness changes', () => {
    const view = render(caption(undefined, false, false, false));
    view.rerender(caption(first, false, false, false));
    const paragraph = screen.getByText(first.text);
    view.rerender(caption(second));
    expect(screen.getByText(second.text)).toBe(paragraph);
    view.rerender(caption(third, false, false, false));
    view.rerender(caption(first));
    expect(screen.getByText(first.text)).toBe(paragraph);
    expect(animatedCaptionNodes).toHaveLength(0);
  });

  it.each([false, true])('retains one live text node through rapid cue, edit, replay and media changes (reduced=%s)', reduced => {
    const view = render(caption(first, reduced));
    const paragraph = screen.getByText(first.text);
    for (const cue of [second, third, { ...third, text: 'Edited current subtitle' }, { ...first, mediaId: 'other-media' }]) {
      view.rerender(caption(cue, reduced));
      expect(screen.getByText(cue.text)).toBe(paragraph);
      expect(paragraph).toBeVisible();
      expect(document.querySelectorAll('.current-caption-text')).toHaveLength(1);
      expect(animatedCaptionNodes).toHaveLength(0);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Replay this subtitle' }));
    expect(replay).toHaveBeenCalledOnce();
    expect(animatedCaptionNodes).toHaveLength(0);
  });

  it('updates the visible translation with its source and preserves disclosure semantics', () => {
    const view = render(caption(first));
    const region = document.querySelector('.caption-translation-region')!;
    expect(region).toHaveAttribute('inert');
    expect(region).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    expect(region).not.toHaveAttribute('inert');
    expect(region).toHaveAttribute('aria-hidden', 'false');
    const translation = screen.getByText(first.translation!);
    view.rerender(caption(second));
    expect(screen.getByText(second.translation!)).toBe(translation);
    expect(screen.getByText(second.text)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Hide translation' }));
    expect(region).toHaveAttribute('inert');
    expect(region).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    expect(screen.getByText(second.translation!)).toBe(translation);
    expect(animatedCaptionNodes).toHaveLength(0);
  });

  it('removes a gap immediately and displays its following cue without stale text', () => {
    const view = render(caption(first));
    view.rerender(caption(second));
    view.rerender(caption(third));
    view.rerender(caption(undefined));
    expect(screen.queryByText(third.text)).not.toBeInTheDocument();
    expect(screen.getByText('Subtitles appear here as you watch.')).toBeVisible();
    view.rerender(caption(third));
    expect(screen.getByText(third.text)).toBeVisible();
    expect(document.querySelectorAll('.current-caption-text')).toHaveLength(1);
    expect(animatedCaptionNodes).toHaveLength(0);
  });

  it('freezes selected source and translation, inspects the frozen term, then shows the latest cue on release', () => {
    const view = render(caption(second));
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    const paragraph = screen.getByText(second.text);
    const translation = screen.getByText(second.translation!);
    fireEvent.pointerDown(paragraph);
    view.rerender(caption(third));
    expect(screen.getByText(second.text)).toBe(paragraph);
    expect(screen.getByText(second.translation!)).toBe(translation);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.addRange(range);
    fireEvent.pointerUp(paragraph);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(second, second.text);
    expect(screen.getByText(third.text)).toBe(paragraph);
    expect(screen.getByText(third.translation!)).toBe(translation);
    expect(animatedCaptionNodes).toHaveLength(0);
  });

  it.each(['pointercancel', 'blur', 'pointerup'])('releases a frozen cue immediately on window %s', event => {
    const view = render(caption(first));
    const paragraph = screen.getByText(first.text);
    fireEvent.pointerDown(paragraph);
    view.rerender(caption(second));
    expect(screen.getByText(first.text)).toBe(paragraph);
    act(() => window.dispatchEvent(new Event(event)));
    expect(screen.getByText(second.text)).toBe(paragraph);
    expect(inspect).not.toHaveBeenCalled();
    expect(animatedCaptionNodes).toHaveLength(0);
  });

  it('keeps the latest cue through resize, motion-preference and visibility changes', () => {
    const view = render(caption(first));
    const paragraph = screen.getByText(first.text);
    view.rerender(caption(second));
    act(() => window.dispatchEvent(new Event('resize')));
    view.rerender(caption(third, true));
    expect(screen.getByText(third.text)).toBe(paragraph);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    view.rerender(caption(first));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByText(first.text)).toBe(paragraph);
    expect(animatedCaptionNodes).toHaveLength(0);
  });
});
