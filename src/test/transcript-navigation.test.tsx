// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudyTranscript, type TranscriptTab, type TranscriptViewState } from '../features/study/StudyTranscript';
import type { Media, SubtitleSegment } from '../shared/contracts/media';
import type { VocabularyCandidate } from '../shared/contracts/cards';

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
function Session({ segments = cues, activeId = cues[0].id, error, onRetryTranscript, onEdit = () => {}, onTranscribeRange,
  candidates = [], candidatesError, onRetryCandidates, tab = 'transcript' }: {
  segments?: SubtitleSegment[];
  activeId?: string;
  error?: Error | null;
  onRetryTranscript?: () => void;
  onEdit?: (cue: SubtitleSegment) => void;
  onTranscribeRange?: (range: { startMs: number; endMs: number }) => void;
  candidates?: VocabularyCandidate[];
  candidatesError?: Error | null;
  onRetryCandidates?: () => void;
  tab?: TranscriptTab;
}) {
  const [viewState, onViewStateChange] = useState<TranscriptViewState>({ search: '', following: true, showTranslations: false, scrollOffset: 0 });
  return <StudyTranscript media={media} segments={segments} candidates={candidates} activeId={activeId} ready tab={tab} onTab={() => {}}
    viewState={viewState} onViewStateChange={onViewStateChange} onInspect={() => {}} onPlayFrom={() => {}} onReplay={() => {}}
    onEdit={onEdit} onImport={() => {}} onEstimate={() => {}} onReview={() => {}} onDraftPlay={() => {}}
    error={error} onRetryTranscript={onRetryTranscript} onTranscribeRange={onTranscribeRange}
    candidatesError={candidatesError} onRetryCandidates={onRetryCandidates} />;
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
  expect(filter).toBeEnabled();
  expect(screen.getByText('No matching subtitles')).toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Reset filters' }));
  expect(screen.getByRole('textbox', { name: 'Search transcript' })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Subtitle 1' })).toBeInTheDocument();
  expect(filter).toBeDisabled();
});

it('keeps the same filter control present when issues arrive and clear', () => {
  const view = render(<Session segments={cues.slice(0, 2)} />);
  const filter = screen.getByRole('checkbox', { name: 'Show marked passages only' });
  expect(filter).toBeDisabled();
  view.rerender(<Session segments={[{ ...cues[0], status: 'generated_review' }, cues[1]]} />);
  expect(screen.getByRole('checkbox', { name: 'Show marked passages only' })).toBe(filter);
  expect(filter).toBeEnabled();
  view.rerender(<Session segments={cues.slice(0, 2)} />);
  expect(screen.getByRole('checkbox', { name: 'Show marked passages only' })).toBe(filter);
  expect(filter).toBeDisabled();
});

it('keeps reading state during a failed refresh and exposes retry through the status disclosure', async () => {
  const retry = vi.fn();
  const view = render(<Session onRetryTranscript={retry} />);
  const first = await screen.findByRole('button', { name: 'Subtitle 0' });
  const list = screen.getByLabelText('Subtitle list');
  act(() => first.focus());
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(first);
  selection.removeAllRanges(); selection.addRange(range);
  fireEvent.scroll(list, { target: { scrollTop: 9_000 } });
  view.rerender(<Session error={new Error('Offline while refreshing')} onRetryTranscript={retry} />);
  expect(screen.getByLabelText('Subtitle list')).toBe(list);
  expect(list.scrollTop).toBe(9_000);
  expect(first).toHaveFocus();
  expect(selection.toString()).toBe('Subtitle 0');
  expect(screen.getByRole('button', { name: 'Retry loading subtitles' })).not.toBeVisible();
  const user = userEvent.setup();
  await user.click(screen.getByLabelText('Subtitles could not be updated'));
  expect(screen.getByText('Offline while refreshing')).toBeVisible();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Retry loading subtitles' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.getByLabelText('Subtitles could not be updated')).toHaveFocus();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry loading subtitles' })).not.toBeVisible());
  await user.keyboard('{Enter}{Tab}{Enter}');
  expect(retry).toHaveBeenCalledOnce();
  const search = screen.getByRole('textbox', { name: 'Search transcript' });
  expect(search).toHaveFocus();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry loading subtitles' })).not.toBeVisible());
  view.rerender(<Session onRetryTranscript={retry} />);
  expect(screen.queryByLabelText('Subtitles could not be updated')).not.toBeInTheDocument();
  expect(search).toHaveFocus();
});

it('shows a recovery action when the initial subtitle load fails', async () => {
  const retry = vi.fn();
  render(<Session segments={[]} error={new Error('Cannot read subtitles')} onRetryTranscript={retry} />);
  expect(screen.getByText('Subtitles could not be loaded')).toBeVisible();
  expect(screen.getByText('Cannot read subtitles')).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry loading subtitles' }));
  expect(retry).toHaveBeenCalledOnce();
  expect(screen.getByRole('textbox', { name: 'Search transcript' })).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Create subtitles from audio' })).not.toBeInTheDocument();
});

it.each([false, true])('restores the suggestions trigger after retry (retained data: %s)', async retained => {
  const retry = vi.fn();
  const candidates = retained ? [{ id: 'suggestion', mediaId: media.id, segmentId: cues[0].id, term: 'Subtitle', meaning: 'A caption', example: cues[0].text }] : [];
  const view = render(<Session tab="vocabulary" candidates={candidates} candidatesError={new Error('Suggestions offline')} onRetryCandidates={retry} />);
  const user = userEvent.setup();
  if (retained) await user.click(screen.getByLabelText('Suggestions could not be updated'));
  await user.click(screen.getByRole('button', { name: 'Retry loading suggestions' }));
  expect(retry).toHaveBeenCalledOnce();
  const trigger = screen.getByRole('button', { name: 'Explore words with AI' });
  expect(trigger).toHaveFocus();
  view.rerender(<Session tab="vocabulary" candidates={candidates} onRetryCandidates={retry} />);
  expect(screen.queryByLabelText('Suggestions could not be updated')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it('retains a secondary menu during virtual scrolling and restores focus when it closes', async () => {
  const edit = vi.fn(); const retranscribe = vi.fn();
  render(<Session onEdit={edit} onTranscribeRange={retranscribe} />);
  const user = userEvent.setup();
  const actions = await screen.findByLabelText('Subtitle actions at 0:00');
  const menu = within(actions.closest('details')!);
  expect(menu.getByRole('button', { name: 'Edit subtitle' })).not.toBeVisible();
  await user.click(actions);
  await user.tab();
  expect(menu.getByRole('button', { name: 'Edit subtitle' })).toHaveFocus();
  fireEvent.scroll(screen.getByLabelText('Subtitle list'), { target: { scrollTop: 9_000 } });
  await screen.findByRole('button', { name: 'Subtitle 72' });
  expect(menu.getByRole('button', { name: 'Edit subtitle' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(actions).toHaveFocus();
  await waitFor(() => expect(menu.getByRole('button', { name: 'Edit subtitle' })).not.toBeVisible());
  await user.click(actions);
  await user.click(menu.getByRole('button', { name: 'Edit subtitle' }));
  expect(edit).toHaveBeenCalledExactlyOnceWith(cues[0]);
  expect(actions).toHaveFocus();
  await user.click(actions);
  await user.click(menu.getByRole('button', { name: 'Retranscribe this range' }));
  expect(retranscribe).toHaveBeenCalledExactlyOnceWith({ startMs: 0, endMs: 900 });
  expect(actions).toHaveFocus();
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
