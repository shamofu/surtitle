// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrentCaption } from '../features/study/CurrentCaption';
import { MotionProvider } from '../shared/motion';
import { animateEntrance } from '../shared/motion/surfaces';
import type { SubtitleSegment } from '../shared/contracts/media';

vi.mock('../app/runtime', () => ({ useAppearance: () => ({ t: (_ja: string, en: string) => en }) }));

const first: SubtitleSegment = { id: 'first', mediaId: 'media', text: 'First subtitle', translation: '最初の字幕', startMs: 0, endMs: 1000 };
const second: SubtitleSegment = { ...first, id: 'second', text: 'Second subtitle', translation: '次の字幕', startMs: 2000, endMs: 3000 };
const third: SubtitleSegment = { ...first, id: 'third', text: 'Third subtitle', startMs: 4000, endMs: 5000 };
const animations: { node: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn> }[] = [];
const inspect = vi.fn();
const replay = vi.fn();

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
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn(function (
    this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions,
  ) {
    const cancel = vi.fn();
    animations.push({ node: this, frames, options, cancel });
    return { cancel, finished: new Promise(() => {}) } as unknown as Animation;
  }) });
});
afterEach(() => {
  cleanup();
  animations.length = 0;
  window.getSelection()?.removeAllRanges();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('current cue motion', () => {
  it('keeps playback initialization and its restored cue immediate until the player is ready', () => {
    const view = render(caption(first, false, false, false));
    view.rerender(caption(second, false, false, false));
    view.rerender(caption(second));
    expect(animations).toHaveLength(0);
    view.rerender(caption(third));
    expect(animations).toHaveLength(1);
    view.rerender(caption(third, false, false, false));
    view.rerender(caption(first));
    expect(animations).toHaveLength(1);
    expect(screen.getByText(first.text)).toBeVisible();
  });

  it('shows the first asynchronously loaded cue immediately', () => {
    const view = render(caption(undefined));
    view.rerender(caption(first));
    expect(screen.getByText(first.text)).toBeVisible();
    expect(animations).toHaveLength(0);
    view.rerender(caption(second));
    expect(animations).toHaveLength(1);
  });

  it('shows the initial cue immediately and fades only a new media/cue identity for 90ms', () => {
    const view = render(caption(first));
    const paragraph = screen.getByText(first.text);
    expect(animations).toHaveLength(0);
    view.rerender(caption({ ...first, text: 'Edited subtitle', startMs: 20 }));
    fireEvent.click(screen.getByRole('button', { name: 'Replay this subtitle' }));
    expect(replay).toHaveBeenCalledOnce();
    expect(animations).toHaveLength(0);
    expect(screen.getByText('Edited subtitle')).toBe(paragraph);
    view.rerender(caption(second));
    expect(screen.getByText(second.text)).toBe(paragraph);
    expect(animations).toHaveLength(1);
    expect(animations[0].frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(animations[0].options.duration).toBe(90);
    view.rerender(caption({ ...second, text: 'Edited incoming subtitle' }));
    expect(animations[0].cancel).toHaveBeenCalled();
    expect(animations).toHaveLength(1);
    expect(screen.getByText('Edited incoming subtitle')).toBe(paragraph);
    view.rerender(caption({ ...second, mediaId: 'other-media' }));
    expect(animations[0].cancel).toHaveBeenCalled();
    expect(animations).toHaveLength(2);
  });

  it('fades the visible translation with the source and never starts a fade on translation toggles', () => {
    const view = render(caption(first));
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    expect(animations).toHaveLength(0);
    const translation = screen.getByText(first.translation!);
    view.rerender(caption(second));
    expect(animations).toHaveLength(2);
    expect(animations.map(animation => animation.node.className)).toEqual(['current-caption-text', 'caption-translation']);
    expect(animations.every(animation => animation.options.duration === 90)).toBe(true);
    expect(screen.getByText(second.translation!)).toBe(translation);
    fireEvent.click(screen.getByRole('button', { name: 'Hide translation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    expect(animations).toHaveLength(2);
  });

  it('shares a running ancestor entrance instead of multiplying source and translation fades', () => {
    const view = render(caption(first));
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    const paragraph = screen.getByText(first.text);
    view.rerender(caption(second));
    expect(animations).toHaveLength(2);
    const stopParent = animateEntrance(document.querySelector('.caption-body')!, 'panel');
    expect(animations[0].cancel).toHaveBeenCalled();
    expect(animations[1].cancel).toHaveBeenCalled();
    view.rerender(caption(third));
    expect(screen.getByText(third.text)).toBe(paragraph);
    expect(animations).toHaveLength(3);
    stopParent?.();
    view.rerender(caption(first));
    expect(animations).toHaveLength(5);
    expect(animations.slice(3).map(animation => animation.node.className)).toEqual(['current-caption-text', 'caption-translation']);
  });

  it('removes a gap immediately, can fade its following cue and settles rapid updates on the latest text', () => {
    const view = render(caption(first));
    view.rerender(caption(second));
    view.rerender(caption(third));
    expect(animations[0].cancel).toHaveBeenCalled();
    view.rerender(caption(undefined));
    expect(screen.queryByText(third.text)).not.toBeInTheDocument();
    expect(screen.getByText('Subtitles appear here as you watch.')).toBeVisible();
    const count = animations.length;
    expect(animations.every(animation => animation.cancel.mock.calls.length > 0)).toBe(true);
    view.rerender(caption(third));
    expect(animations).toHaveLength(count + 1);
    expect(screen.getByText(third.text)).toBeVisible();
  });

  it('cancels on pointer down, freezes selected source and shows the latest cue immediately on release', () => {
    const view = render(caption(first));
    view.rerender(caption(second));
    const paragraph = screen.getByText(second.text);
    fireEvent.pointerDown(paragraph);
    expect(animations[0].cancel).toHaveBeenCalled();
    view.rerender(caption(third));
    expect(screen.getByText(second.text)).toBe(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.addRange(range);
    fireEvent.pointerUp(paragraph);
    expect(inspect).toHaveBeenCalledWith(second, second.text);
    expect(screen.getByText(third.text)).toBe(paragraph);
    expect(animations).toHaveLength(1);
    view.rerender(caption(first));
    expect(animations).toHaveLength(2);
  });

  it.each(['pointercancel', 'blur', 'pointerup'])('releases a frozen cue without a catchup fade on window %s', event => {
    const view = render(caption(first));
    const paragraph = screen.getByText(first.text);
    fireEvent.pointerDown(paragraph);
    view.rerender(caption(second));
    act(() => window.dispatchEvent(new Event(event)));
    expect(screen.getByText(second.text)).toBe(paragraph);
    expect(animations).toHaveLength(0);
  });

  it('cancels pending motion on reduced motion, resize and hidden state without replaying it', () => {
    const view = render(caption(first));
    view.rerender(caption(second));
    act(() => window.dispatchEvent(new Event('resize')));
    expect(animations[0].cancel).toHaveBeenCalled();
    view.rerender(caption(third));
    view.rerender(caption(third, true));
    expect(animations[1].cancel).toHaveBeenCalled();
    view.rerender(caption(first, true));
    view.rerender(caption(first));
    expect(animations).toHaveLength(2);
    view.rerender(caption(second));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(animations[2].cancel).toHaveBeenCalled();
    view.rerender(caption(third));
    expect(animations).toHaveLength(3);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByText(third.text)).toBeVisible();
    expect(animations).toHaveLength(3);
  });
});
