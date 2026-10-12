// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrentCaption } from '../features/study/CurrentCaption';
import { MotionProvider } from '../shared/motion';
import type { SubtitleSegment } from '../shared/contracts/media';

vi.mock('../app/runtime', () => ({ useAppearance: () => ({ t: (_ja: string, en: string) => en }) }));

const first: SubtitleSegment = { id: 'first', mediaId: 'media', text: 'First subtitle', translation: '最初の字幕', startMs: 0, endMs: 1000 };
const second: SubtitleSegment = { ...first, id: 'second', text: 'Second subtitle', translation: '次の字幕', startMs: 2000, endMs: 3000 };
const third: SubtitleSegment = { ...first, id: 'third', text: 'Third subtitle', translation: '三番目の字幕', startMs: 4000, endMs: 5000 };
const animations: { node: HTMLElement; frames: Keyframe[]; duration: number; cancel: ReturnType<typeof vi.fn> }[] = [];
const inspect = vi.fn();
const save = vi.fn();
const replay = vi.fn();
const previous = vi.fn();
const next = vi.fn();
const openTranscript = vi.fn();
const importSubtitles = vi.fn();
const animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');

function caption(active?: SubtitleSegment, options: Partial<ComponentProps<typeof CurrentCaption>> & { reduced?: boolean } = {}) {
  const { reduced, ...props } = options;
  return <MotionProvider preference={reduced ? 'reduce' : 'system'}>
    <CurrentCaption active={active} language="en" loading={false} hasSubtitles hasTimedSubtitles gapMode="review" draftMode={false} enabled
      inspectButton={createRef()} onInspect={inspect} onSave={save} onImport={importSubtitles} onOpenTranscript={openTranscript}
      onPrevious={previous} onNext={next} onReplay={replay} hasPrevious hasNext {...props} />
  </MotionProvider>;
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn(function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
    const cancel = vi.fn();
    if (this.matches('.current-caption-text, .caption-translation')) animations.push({ node: this, frames, duration: Number(options.duration), cancel });
    return { cancel, finished: new Promise(() => {}) } as unknown as Animation;
  }) });
});

afterEach(() => {
  cleanup();
  animations.length = 0;
  window.getSelection()?.removeAllRanges();
  if (animateDescriptor) Object.defineProperty(HTMLElement.prototype, 'animate', animateDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe('current caption transitions', () => {
  it('commits loaded and restored cues immediately while animating independently of player readiness', () => {
    const view = render(caption(undefined, { enabled: false }));
    view.rerender(caption(first, { enabled: false }));
    const paragraph = screen.getByText(first.text);
    expect(animations).toHaveLength(1);
    view.rerender(caption(first));
    expect(animations).toHaveLength(1);
    view.rerender(caption(second));
    expect(screen.getByText(second.text)).toBe(paragraph);
    view.rerender(caption(third, { enabled: false }));
    view.rerender(caption(first));
    expect(screen.getByText(first.text)).toBe(paragraph);
    expect(animations).toHaveLength(4);
    for (const animation of animations) {
      expect(animation.duration).toBe(140);
      expect(animation.frames).toEqual([{ opacity: .35 }, { opacity: 1 }]);
    }
  });

  it.each([false, true])('keeps one live node through rapid cues, edits, media changes and replay (reduced=%s)', reduced => {
    const view = render(caption(first, { reduced }));
    const paragraph = screen.getByText(first.text);
    const updates = [second, third, { ...third, text: 'Edited current subtitle' }, { ...first, mediaId: 'other-media' }];
    for (const [index, cue] of updates.entries()) {
      view.rerender(caption(cue, { reduced }));
      expect(screen.getByText(cue.text)).toBe(paragraph);
      expect(paragraph).toBeVisible();
      expect(document.querySelectorAll('.current-caption-text')).toHaveLength(1);
      expect(animations).toHaveLength(reduced ? 0 : index + 1);
      if (!reduced && index > 0) expect(animations[index - 1].cancel).toHaveBeenCalledOnce();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Replay this subtitle' }));
    expect(replay).toHaveBeenCalledExactlyOnceWith(updates.at(-1));
    expect(animations).toHaveLength(reduced ? 0 : updates.length);
  });

  it('animates source and visible translation together without replaying fades on disclosure changes', () => {
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
    expect(animations.map(animation => animation.node.className)).toEqual(['current-caption-text', 'caption-translation']);
    view.rerender(caption({ ...second, translation: 'Updated translation' }));
    expect(animations).toHaveLength(3);
    expect(animations[2].node).toBe(translation);
    fireEvent.click(screen.getByRole('button', { name: 'Hide translation' }));
    expect(region).toHaveAttribute('inert');
    expect(region).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    expect(screen.getByText('Updated translation')).toBe(translation);
    expect(animations).toHaveLength(3);
  });

  it('cancels motion on pointer-down and freezes source and translation until the selection is inspected', () => {
    const view = render(caption(first));
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    view.rerender(caption(second));
    const paragraph = screen.getByText(second.text);
    const translation = screen.getByText(second.translation!);
    fireEvent.pointerDown(paragraph);
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    view.rerender(caption(third));
    expect(screen.getByText(second.text)).toBe(paragraph);
    expect(screen.getByText(second.translation!)).toBe(translation);
    expect(animations).toHaveLength(2);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.addRange(range);
    fireEvent.pointerUp(paragraph);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(second, second.text);
    expect(screen.getByText(third.text)).toBe(paragraph);
    expect(screen.getByText(third.translation!)).toBe(translation);
    expect(animations).toHaveLength(4);
  });

  it.each(['pointercancel', 'blur', 'pointerup'])('shows the latest cue after window %s releases a selection', event => {
    const view = render(caption(first));
    const paragraph = screen.getByText(first.text);
    fireEvent.pointerDown(paragraph);
    view.rerender(caption(second));
    expect(screen.getByText(first.text)).toBe(paragraph);
    act(() => window.dispatchEvent(new Event(event)));
    expect(screen.getByText(second.text)).toBe(paragraph);
    expect(inspect).not.toHaveBeenCalled();
    expect(animations).toHaveLength(1);
  });

  it('freezes preview timing and its first-cue label when playback crosses the selected cue', () => {
    const view = render(caption(undefined, { next: second, gapMode: 'preview', hasPrevious: false }));
    const paragraph = screen.getByText(second.text);
    expect(screen.getByText('First subtitle 0:02')).toBeVisible();
    fireEvent.pointerDown(paragraph);
    view.rerender(caption(second, { previous: first, next: third, gapMode: 'preview' }));
    expect(screen.getByText(second.text)).toBe(paragraph);
    expect(screen.getByText('First subtitle 0:02')).toBeVisible();
    expect(screen.queryByText('Next subtitle 0:04')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play this subtitle' })).toBeEnabled();
    act(() => window.dispatchEvent(new Event('pointercancel')));
    expect(screen.getByText(second.text)).toBe(paragraph);
    expect(screen.queryByText('First subtitle 0:02')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replay this subtitle' })).toBeEnabled();
  });

  it('settles on resize, reduced motion and hidden document without delaying the latest cue', () => {
    const view = render(caption(first));
    const paragraph = screen.getByText(first.text);
    view.rerender(caption(second));
    act(() => window.dispatchEvent(new Event('resize')));
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    view.rerender(caption(third));
    view.rerender(caption(third, { reduced: true }));
    expect(animations[1].cancel).toHaveBeenCalledOnce();
    view.rerender(caption(first, { reduced: true }));
    expect(screen.getByText(first.text)).toBe(paragraph);
    view.rerender(caption(second));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(animations[2].cancel).toHaveBeenCalledOnce();
    view.rerender(caption(third));
    expect(screen.getByText(third.text)).toBe(paragraph);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(animations).toHaveLength(3);
  });

  it('resets independent scroll positions only when the displayed cue identity changes', () => {
    const view = render(caption(first));
    const source = screen.getByRole('region', { name: 'Subtitle source' });
    const translation = document.querySelector('.caption-translation-scroll')!;
    source.scrollTop = 80;
    translation.scrollTop = 60;
    view.rerender(caption(undefined, { previous: first, next: second }));
    expect(source.scrollTop).toBe(80);
    expect(translation.scrollTop).toBe(60);
    view.rerender(caption(undefined, { previous: { ...first, text: 'Edited first cue' }, next: second }));
    expect(source.scrollTop).toBe(80);
    view.rerender(caption(second));
    expect(source.scrollTop).toBe(0);
    expect(translation.scrollTop).toBe(0);
  });
});

describe('caption gap learning', () => {
  it.each(['review', 'preview'] as const)('uses the displayed %s cue for meaning, save, translation and replay', gapMode => {
    const target = gapMode === 'review' ? first : second;
    render(caption(undefined, { previous: first, next: second, gapMode }));
    expect(screen.getByText(target.text)).toBeVisible();
    expect(screen.getByText(gapMode === 'review' ? 'Review the previous subtitle' : 'Preview the next subtitle')).toBeVisible();
    expect(screen.getByText('Next subtitle 0:02')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    expect(screen.getByText(target.translation!)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Explore meaning' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save phrase' }));
    fireEvent.click(screen.getByRole('button', { name: gapMode === 'preview' ? 'Play this subtitle' : 'Replay this subtitle' }));
    expect(inspect).toHaveBeenCalledExactlyOnceWith(target);
    expect(save).toHaveBeenCalledExactlyOnceWith(target);
    expect(replay).toHaveBeenCalledExactlyOnceWith(target);
    fireEvent.click(screen.getByRole('button', { name: 'Previous subtitle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next subtitle' }));
    expect(previous).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it.each(['review', 'preview'] as const)('always gives an active cue priority in %s mode', gapMode => {
    render(caption(second, { previous: first, next: third, gapMode }));
    expect(screen.getByText(second.text)).toBeVisible();
    expect(screen.queryByText(/the (previous|next) subtitle/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replay this subtitle' }));
    expect(replay).toHaveBeenCalledExactlyOnceWith(second);
  });

  it('shows the first start time in review mode without silently switching to preview', () => {
    const view = render(caption(undefined, { next: second, hasPrevious: false }));
    expect(screen.getByText('The first subtitle starts at 0:02')).toBeVisible();
    expect(screen.queryByText(second.text)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replay this subtitle' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Go to first subtitle' }));
    expect(next).toHaveBeenCalledOnce();
    view.rerender(caption(undefined, { next: second, hasPrevious: false, gapMode: 'preview' }));
    expect(screen.getByText(second.text)).toBeVisible();
    expect(screen.getByText('First subtitle 0:02')).toBeVisible();
  });

  it('keeps the last cue for review but shows a previous action when preview has no next cue', () => {
    const view = render(caption(undefined, { previous: third, hasNext: false }));
    expect(screen.getByText(third.text)).toBeVisible();
    expect(screen.getByText('No further subtitles yet')).toBeVisible();
    view.rerender(caption(undefined, { previous: third, hasNext: false, gapMode: 'preview' }));
    expect(screen.queryByText(third.text)).not.toBeInTheDocument();
    expect(screen.getByText('No further subtitles yet')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Go to previous subtitle' }));
    expect(previous).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Replay this subtitle' })).toBeDisabled();
  });

  it('preserves the live cue node from playback through review and into the next active cue', () => {
    const view = render(caption(first));
    const paragraph = screen.getByText(first.text);
    view.rerender(caption(undefined, { previous: first, next: second }));
    expect(screen.getByText(first.text)).toBe(paragraph);
    expect(animations).toHaveLength(0);
    view.rerender(caption(second, { previous: first, next: third }));
    expect(screen.getByText(second.text)).toBe(paragraph);
    expect(animations).toHaveLength(1);
  });

  it('directs untimed source text to the transcript instead of implying playback has ended', () => {
    render(caption(undefined, { hasTimedSubtitles: false }));
    expect(screen.getByText('This text has no synchronized subtitle timing. Read it in the transcript.')).toBeVisible();
    expect(screen.queryByText('No further subtitles yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Subtitle playback' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open transcript' }));
    expect(openTranscript).toHaveBeenCalledOnce();
  });

  it('keeps loading, missing subtitle and draft modes distinct from caption gaps', () => {
    const view = render(caption(undefined, { loading: true, hasSubtitles: false, hasTimedSubtitles: false }));
    expect(screen.getByText('Loading subtitles…')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create subtitles from audio' })).not.toBeInTheDocument();
    view.rerender(caption(undefined, { hasSubtitles: false, hasTimedSubtitles: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Create subtitles from audio' }));
    expect(importSubtitles).toHaveBeenCalledOnce();
    view.rerender(caption(first, { draftMode: true, previous: second, next: third }));
    expect(screen.getByText('Checking a draft passage. Its source text is shown in the transcript panel.')).toBeVisible();
    expect(screen.queryByText(first.text)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replay this subtitle' })).not.toBeInTheDocument();
  });
});
