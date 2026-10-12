// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudyTranscript, type TranscriptViewState } from '../features/study/StudyTranscript';
import type { Media, SubtitleSegment } from '../shared/contracts/media';

vi.mock('../app/runtime', () => ({ useAppearance: () => ({ t: (_ja: string, en: string) => en }) }));
vi.mock('../features/study/drafts/DraftStudyPanel', () => ({ DraftStudyPanel: () => null }));

const media: Media = {
  id: 'media', path: 'C:/media.mp4', title: 'Media', kind: 'video', durationMs: 100_000,
  lastPositionMs: 0, learningLanguage: 'en', explanationLanguage: 'ja', status: 'ready',
  createdAt: '2026-01-01', segmentCount: 100, cardCount: 0,
};
const cues: SubtitleSegment[] = Array.from({ length: 100 }, (_, index) => ({
  id: `cue-${index}`, mediaId: media.id, text: `Subtitle ${index}`, startMs: index * 1000,
  endMs: index * 1000 + 900, status: 'confirmed',
}));
function Session({ segments = cues, activeId = cues[0].id }: { segments?: SubtitleSegment[]; activeId?: string }) {
  const [viewState, onViewStateChange] = useState<TranscriptViewState>({ search: '', following: true, showTranslations: false, scrollOffset: 0 });
  return <StudyTranscript media={media} segments={segments} candidates={[]} activeId={activeId} ready tab="transcript" onTab={() => {}}
    viewState={viewState} onViewStateChange={onViewStateChange} onInspect={() => {}} onPlayFrom={() => {}} onReplay={() => {}}
    onEdit={() => {}} onImport={() => {}} onEstimate={() => {}} onReview={() => {}} onDraftPlay={() => {}} />;
}

const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
beforeEach(() => {
  // Supply only DOM geometry and scrolling. TanStack's actual virtualizer owns
  // measurement, visible ranges, focus retention and scroll subscriptions.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('transcript-scroll') ? 378 : 126;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(378);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return Number.parseFloat(this.querySelector<HTMLElement>('.virtual-transcript')?.style.height || '378');
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions) {
    const next = options.top ?? this.scrollTop;
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    this.dispatchEvent(new Event('scroll'));
  } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (scrollToDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
});

it('keeps a focused cue mounted outside the virtual range and pauses following until requested', async () => {
  const view = render(<Session />);
  const first = await screen.findByRole('button', { name: 'Subtitle 0' });
  const list = screen.getByLabelText('Subtitle list');
  expect(screen.queryByRole('button', { name: 'Subtitle 80' })).not.toBeInTheDocument();
  act(() => first.focus());
  expect(screen.getByRole('button', { name: 'Show current subtitle' })).toBeInTheDocument();
  view.rerender(<Session activeId="cue-80" />);
  expect(list.scrollTop).toBe(0);
  expect(first).toHaveFocus();
  fireEvent.scroll(list, { target: { scrollTop: 9_000 } });
  await screen.findByRole('button', { name: 'Subtitle 72' });
  expect(screen.queryByRole('button', { name: 'Subtitle 1' })).not.toBeInTheDocument();
  expect(first).toHaveFocus();
  act(() => screen.getByRole('textbox', { name: 'Search transcript' }).focus());
  expect(first).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show current subtitle' }));
  await waitFor(() => expect(list.scrollTop).toBeGreaterThan(9_000));
  expect(screen.getByRole('button', { name: 'Subtitle 80' })).toBeInTheDocument();
});

it('remeasures a retained focused cue before centering it after playback clears a filter', async () => {
  function FilteredSession() {
    const [activeId, setActiveId] = useState(cues[0].id);
    const [viewState, onViewStateChange] = useState<TranscriptViewState>({ search: 'Subtitle 4', following: false, showTranslations: true, scrollOffset: 0 });
    return <StudyTranscript media={media} segments={cues} candidates={[]} activeId={activeId} ready tab="transcript" onTab={() => {}}
      viewState={viewState} onViewStateChange={onViewStateChange} onInspect={() => {}} onPlayFrom={cue => {
        setActiveId(cue.id);
        onViewStateChange(view => ({ ...view, search: '', following: true }));
      }} onReplay={() => {}} onEdit={() => {}} onImport={() => {}} onEstimate={() => {}} onReview={() => {}} onDraftPlay={() => {}} />;
  }
  render(<FilteredSession />);
  const play = await screen.findByRole('button', { name: 'Play from subtitle 0:40' });
  const row = play.closest<HTMLElement>('.transcript-row')!;
  const list = screen.getByLabelText('Subtitle list');
  fireEvent.scroll(list, { target: { scrollTop: 1 } });
  act(() => play.focus());
  fireEvent.click(play);
  expect(screen.getByRole('textbox', { name: 'Search transcript' })).toHaveValue('');
  expect(play).toHaveFocus();
  expect(play.closest('.transcript-row')).toBe(row);
  await waitFor(() => {
    const start = Number(/translateY\(([^p]+)/.exec(row.style.transform)?.[1]);
    expect(Math.abs(start + row.offsetHeight / 2 - list.scrollTop - list.clientHeight / 2)).toBeLessThan(1);
  });
  expect(screen.getByRole('button', { name: 'Following playback' })).toBeInTheDocument();
});

it('keeps the active marked filter clearable when the last issue is resolved', async () => {
  const marked = [{ ...cues[0], reviewIssues: [{ id: 'issue', kind: 'timing', startMs: 0, endMs: 900, alternatives: [] }] }, cues[1]];
  const view = render(<Session segments={marked} />);
  const filter = screen.getByRole('checkbox', { name: 'Show marked passages only' });
  fireEvent.click(filter);
  expect(screen.getByRole('button', { name: 'Subtitle 0' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Subtitle 1' })).not.toBeInTheDocument();
  view.rerender(<Session segments={cues.slice(0, 2)} />);
  expect(filter).toBeChecked();
  expect(screen.getByText('No matching subtitles')).toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Reset filters' }));
  expect(screen.getByRole('textbox', { name: 'Search transcript' })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Subtitle 1' })).toBeInTheDocument();
});

it('clears search and the marked filter when returning to an unmarked current cue', async () => {
  const marked = [{ ...cues[0], status: 'generated_review' as const }, ...cues.slice(1)];
  render(<Session segments={marked} activeId="cue-80" />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show marked passages only' }));
  const search = screen.getByRole('textbox', { name: 'Search transcript' });
  fireEvent.change(search, { target: { value: 'missing phrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Show current subtitle' }));
  expect(search).toHaveValue('');
  expect(screen.getByRole('checkbox', { name: 'Show marked passages only' })).not.toBeChecked();
  await screen.findByRole('button', { name: 'Subtitle 80' });
});

it('returns keyboard focus to transcript search after clearing it', async () => {
  render(<Session />);
  const user = userEvent.setup();
  const search = screen.getByRole('textbox', { name: 'Search transcript' });
  await user.type(search, 'Subtitle 4');
  await user.tab();
  expect(screen.getByRole('button', { name: 'Clear search' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(search).toHaveValue('');
  expect(search).toHaveFocus();
});
