// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { VirtualItem } from '@tanstack/react-virtual';
import {
  AudioLines,
  BookmarkPlus,
  Crosshair,
  Edit3,
  Languages,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Subtitles,
  TriangleAlert,
  X
} from 'lucide-react';
import type { Media, SubtitleSegment } from '../../shared/contracts/media';
import { subtitleUsable } from '../../shared/contracts/media';
import type { VocabularyCandidate } from '../../shared/contracts/cards';
import type { SelectedContext } from './source-selection';
import { resolveSourceSelection } from './source-selection';
import { useAppearance } from '../../app/runtime';
import { timestamp } from '../../shared/format';
import { Button, EmptyState, IconButton } from '../../shared/ui/index';
import { AnimatedDetails } from '../../shared/ui/AnimatedDetails';
import { AnimatedValue, MotionRegion, MotionSwap, useAppMotion } from '../../shared/motion';
import { SelectionIndicator } from '../../shared/motion/SelectionIndicator';
import { DraftStudyPanel } from './drafts/DraftStudyPanel';
import type { PlayRange } from './drafts/lifecycle';
import { StudyRegion } from './StudyPresence';
export type TranscriptTab = 'transcript' | 'transcription' | 'vocabulary' | 'draft';
export interface TranscriptViewState {
  search: string;
  following: boolean;
  showTranslations: boolean;
  scrollOffset: number;
  measurementCache?: {
    search: string;
    showTranslations: boolean;
    markedOnly?: boolean;
    width: number;
    items: VirtualItem[];
  };
}

const isMarked = (cue: SubtitleSegment) => cue.status === 'generated_review' ||
  cue.timingPrecision === 'source_block' || !!cue.reviewIssues?.length;

function TranscriptStatus({ error, label, retryLabel, onRetry }: {
  error?: Error | null;
  label: string;
  retryLabel: string;
  onRetry?: () => void;
}) {
  return <div className="transcript-status-slot">
    <span className="sr-only" role="status">{error ? label : ''}</span>
    {error && <AnimatedDetails className="transcript-status" data-motion-geometry="stable" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }} onKeyDown={event => {
      if (event.key !== 'Escape' || !event.currentTarget.open) return;
      event.preventDefault(); event.stopPropagation();
      event.currentTarget.querySelector('summary')?.focus({ preventScroll: true });
      event.currentTarget.open = false;
    }}>
      <summary aria-label={label} title={label}><TriangleAlert size={16} /></summary>
      <div className="transcript-status-panel">
        <p>{error.message}</p>
        {onRetry && <Button onClick={event => {
          const disclosure = event.currentTarget.closest('details');
          if (disclosure) disclosure.open = false;
          onRetry();
        }}>{retryLabel}</Button>}
      </div>
    </AnimatedDetails>}
  </div>;
}

export function StudyTranscript({
  media,
  segments,
  candidates,
  activeId,
  selectedId,
  ready,
  tab,
  onTab,
  viewState,
  onViewStateChange,
  error,
  candidatesError,
  onRetryTranscript,
  onRetryCandidates,
  onInspect,
  onPlayFrom,
  onReplay,
  onEdit,
  onImport,
  onEstimate,
  onReview,
  onDraftPlay,
  transcriptionWorkspace,
  active = true,
  onTranscribeRange,
}: {
  media: Media;
  segments: SubtitleSegment[];
  candidates: VocabularyCandidate[];
  activeId?: string;
  selectedId?: string;
  ready: boolean;
  tab: TranscriptTab;
  onTab: (tab: TranscriptTab) => void;
  viewState: TranscriptViewState;
  onViewStateChange: (state: TranscriptViewState) => void;
  error?: Error | null;
  candidatesError?: Error | null;
  onRetryTranscript?: () => void;
  onRetryCandidates?: () => void;
  onInspect: (
    segment: SelectedContext,
    term?: string,
    candidate?: VocabularyCandidate,
    save?: boolean
  ) => void;
  onPlayFrom: (segment: SubtitleSegment) => void;
  onReplay: (segment: SelectedContext) => void;
  onEdit: (segment: SubtitleSegment) => void;
  onImport: () => void;
  onEstimate: (kind: 'transcribe' | 'vocabulary') => void;
  onReview: (jobId: string) => void;
  onDraftPlay: PlayRange;
  transcriptionWorkspace?: ReactNode;
  active?: boolean;
  onTranscribeRange?: (range: { startMs: number; endMs: number }) => void;
}) {
  const { t } = useAppearance();
  const { reducedMotion } = useAppMotion();
  const tabsId = useId();
  const visibleTab = tab === 'draft' ? 'transcription' : tab;
  const tabs = [
    ['transcript', t('字幕', 'Transcript')],
    ...(transcriptionWorkspace ? [['transcription', t('文字起こし', 'Transcription')]] : []),
    ['vocabulary', t('AI の提案', 'Suggestions')],
    ...(!transcriptionWorkspace ? [['draft', t('下書きから学ぶ', 'Study a draft')]] : []),
  ] as [TranscriptTab, string][];
  const tabIndex = tabs.findIndex(([id]) => id === (transcriptionWorkspace ? visibleTab : tab));
  const previousTabIndex = useRef(tabIndex);
  const direction = tabIndex < previousTabIndex.current ? -1 : 1;
  useLayoutEffect(() => { previousTabIndex.current = tabIndex; }, [tabIndex]);
  const { search, following, showTranslations } = viewState;
  const [markedOnly, setMarkedOnly] = useState(false);
  const [focusedCue, setFocusedCue] = useState<string>();
  const [openMenu, setOpenMenu] = useState<string>();
  const activeMenu = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    if (!openMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !activeMenu.current?.contains(event.target)) setOpenMenu(undefined);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [openMenu]);
  function closeMenu(element: HTMLElement) {
    setOpenMenu(undefined);
    element.closest('details')?.querySelector('summary')?.focus({ preventScroll: true });
  }
  function placeMenu(menu: HTMLDetailsElement) {
    const panel = menu.querySelector<HTMLElement>('.segment-options-panel');
    const summary = menu.querySelector('summary');
    const viewport = scrollRef.current?.getBoundingClientRect();
    if (!menu.open || !panel || !summary || !viewport) return;
    const anchor = summary.getBoundingClientRect();
    const height = panel.getBoundingClientRect().height;
    // An edge row can have less room above its actions than the menu needs.
    // Clamp the overlay inside the reading viewport without resizing the row.
    const top = Math.max(viewport.top + 4, Math.min(anchor.top - height - 4, viewport.bottom - height - 4));
    panel.style.bottom = 'auto';
    panel.style.top = `${top - anchor.top}px`;
  }
  const searchInput = useRef<HTMLInputElement>(null);
  const suggestionsActions = useRef<HTMLDivElement>(null);
  function retryTranscript() {
    searchInput.current?.focus({ preventScroll: true });
    onRetryTranscript?.();
  }
  function retrySuggestions() {
    suggestionsActions.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    onRetryCandidates?.();
  }
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const updateView = useCallback((patch: Partial<TranscriptViewState>) => {
    const next = { ...viewStateRef.current, ...patch };
    viewStateRef.current = next;
    onViewStateChange(next);
  }, [onViewStateChange]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followedSubtitle = useRef<string | undefined>(undefined);
  const filtered = useMemo(() => {
    const query = search.toLocaleLowerCase();
    return segments.filter(item => (!markedOnly || isMarked(item)) &&
      (!query || `${item.text} ${item.translation || ''}`.toLocaleLowerCase().includes(query)));
  }, [segments, markedOnly, search]);
  const cached = viewState.measurementCache;
  const initialMeasurements = cached?.search === search && cached.showTranslations === showTranslations && (cached.markedOnly ?? false) === markedOnly ? cached : undefined;
  const previousLayout = useRef({ search, showTranslations, markedOnly, width: initialMeasurements?.width });
  const virtualizer = useVirtualizer({
    // Scroll restoration and dynamic row measurements also run in layout effects.
    // Let React 19 batch these updates instead of re-entering a commit via flushSync.
    useFlushSync: false,
    // The transcript is retained behind the inspector. Hidden rows report zero
    // height; retaining their cache avoids moving a manually browsed position.
    useCachedMeasurements: !active || tab !== 'transcript',
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => filtered[index].id,
    initialOffset: viewState.scrollOffset,
    initialMeasurementsCache: initialMeasurements?.items,
    estimateSize: () => showTranslations ? 156 : 126,
    overscan: 6,
    rangeExtractor: range => {
      const retained = [focusedCue, openMenu].map(id => filtered.findIndex(cue => cue.id === id)).filter(index => index >= 0);
      return [...new Set([...defaultRangeExtractor(range), ...retained])].sort((a, b) => a - b);
    },
  });
  const viewportWidth = virtualizer.scrollRect?.width ?? 0;
  const viewportHeight = virtualizer.scrollRect?.height ?? 0;
  const activeIndex = filtered.findIndex(item => item.id === activeId);
  const measuredActive = virtualizer.getVirtualItems().find(item => item.index === activeIndex);

  useLayoutEffect(() => {
    if (!active || tab !== 'transcript' || !scrollRef.current) return;
    const width = scrollRef.current.clientWidth;
    const previous = previousLayout.current;
    // Keep measured heights when returning from the inspector. Replacing them
    // with estimates would cause the virtualizer to shift the restored offset.
    if (previous.search !== search || previous.showTranslations !== showTranslations || previous.markedOnly !== markedOnly ||
        (previous.width !== undefined && previous.width !== width)) {
      virtualizer.measure();
      // Retained focused rows keep their DOM node and dimensions, so neither
      // refs nor ResizeObserver remeasure them after the cache is cleared.
      virtualizer.getVirtualItems();
      scrollRef.current.querySelectorAll<HTMLElement>('.transcript-row').forEach(row => {
        // Force the current size even while user-scroll measurement is deferred.
        virtualizer.resizeItem(Number(row.dataset.index), row.offsetHeight);
      });
    }
    previousLayout.current = { search, showTranslations, markedOnly, width };
    if (!following || search || markedOnly) {
      virtualizer.scrollToOffset(viewStateRef.current.scrollOffset, { behavior: 'auto' });
    }
  }, [active, tab, search, showTranslations, markedOnly, filtered.length, viewportWidth, viewportHeight]);

  useLayoutEffect(
    () => {
      if (!active || !following || search || markedOnly || tab !== 'transcript') {
        followedSubtitle.current = undefined;
        return;
      }
      // A retained panel can still have the hidden viewport's zero-height
      // measurement when it opens. Align after ResizeObserver reports its size.
      if (activeIndex < 0 || viewportHeight <= 0) return;
      const scroll = scrollRef.current;
      const smooth = !reducedMotion && followedSubtitle.current !== undefined &&
        followedSubtitle.current !== activeId;
      followedSubtitle.current = activeId;
      virtualizer.scrollToIndex(activeIndex, { align: 'center', behavior: smooth ? 'smooth' : 'auto' });
      return () => {
        // Interrupt an in-flight follow before manual scrolling, hiding the
        // panel, changing motion preferences, or following another subtitle.
        if (scroll) virtualizer.scrollToOffset(scroll.scrollTop, { behavior: 'auto' });
      };
    },
    [active, activeId, activeIndex, measuredActive?.start, measuredActive?.size, following, search, markedOnly, tab, filtered.length, showTranslations, reducedMotion, viewportWidth, viewportHeight]
  );

  return (
    <>
      <div
        className="transcript-tabs"
        role="tablist"
        aria-label={t('字幕の表示内容', 'Transcript content')}
      >
        <SelectionIndicator />
        {tabs.map(([id, label], index) => (
          <button
            key={id}
            id={`${tabsId}-${id}-tab`}
            role="tab"
            type="button"
            aria-selected={(transcriptionWorkspace ? visibleTab : tab) === id}
            aria-controls={`${tabsId}-${id === 'transcription' && tab === 'draft' ? 'draft' : id}-panel`}
            tabIndex={(transcriptionWorkspace ? visibleTab : tab) === id ? 0 : -1}
            className={(transcriptionWorkspace ? visibleTab : tab) === id ? 'active' : ''}
            onClick={() => onTab(id)}
            onKeyDown={event => {
              if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
              onTab(tabs[next][0]);
              document.getElementById(`${tabsId}-${tabs[next][0]}-tab`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="transcript-tab-content" data-motion-direction={direction}>
      {transcriptionWorkspace && <StudyRegion open={tab === 'transcription'} keepMounted freezeOnExit={false}><div
        className="transcription-view"
        role="tabpanel"
        id={`${tabsId}-transcription-panel`}
        aria-labelledby={`${tabsId}-transcription-tab`}
      >{transcriptionWorkspace}</div></StudyRegion>}
      <StudyRegion open={tab === 'draft'}>
          <div className="transcript-draft-view" role="tabpanel" id={`${tabsId}-draft-panel`} aria-labelledby={`${tabsId}-${transcriptionWorkspace ? 'transcription' : 'draft'}-tab`}>
          {transcriptionWorkspace && <Button variant="ghost" onClick={() => {
            onTab('transcription');
            document.getElementById(`${tabsId}-transcription-tab`)?.focus();
          }}>{t('文字起こしの履歴へ戻る', 'Back to transcription history')}</Button>}
          <DraftStudyPanel
            media={media}
            playbackReady={ready}
            onReview={onReview}
            onPlay={onDraftPlay}
            onAddSubtitles={onImport}
            onEstimate={() => onEstimate('transcribe')}
          />
          </div>
      </StudyRegion>
      <StudyRegion open={tab === 'vocabulary'}>
            <div className="suggestions-panel" role="tabpanel" id={`${tabsId}-vocabulary-panel`} aria-labelledby={`${tabsId}-vocabulary-tab`}>
              <div className="suggestions-actions" ref={suggestionsActions}>
                <Button onClick={() => onEstimate('vocabulary')}>
                  <Sparkles size={16} />
                  {t('AIで語彙・表現を調べる', 'Explore words with AI')}
                </Button>
                <TranscriptStatus error={candidates.length ? candidatesError : null}
                  label={t('提案を更新できませんでした', 'Suggestions could not be updated')}
                  retryLabel={t('提案の読み込みを再試行', 'Retry loading suggestions')} onRetry={onRetryCandidates ? retrySuggestions : undefined} />
              </div>
              {!candidates.length
                ? (
                  <EmptyState
                    icon={<Sparkles size={26} />}
                    title={candidatesError ? t('提案を読み込めませんでした', 'Suggestions could not be loaded') : t('提案はまだありません', 'No suggestions yet')}
                    description={candidatesError?.message ?? t(
                      '区間を選んで、表現の解説や語彙の提案を見積もれます。',
                      'Choose a passage to estimate explanations or vocabulary suggestions.'
                    )}
                  >{candidatesError && onRetryCandidates && <Button onClick={retrySuggestions}>{t('提案の読み込みを再試行', 'Retry loading suggestions')}</Button>}</EmptyState>
                )
                : candidates.map(candidate => {
                  const ids = candidate.sourceCueIds?.length ? candidate.sourceCueIds : [candidate.segmentId];
                  const { selected: source } = resolveSourceSelection(segments, media.id, ids[0], ids);
                  return (
                    <article
                      className="suggestion-card"
                      key={candidate.id}
                    >
                      <h3>{candidate.term}</h3>
                      <p>{candidate.meaning}</p>
                      <blockquote>{candidate.example}</blockquote>
                      <div className="inline-actions">
                        <Button
                          disabled={!ready || !source}
                          onClick={() => source && onReplay({ ...source, sourceCueIds: ids })}
                        >
                          <Play size={15} />
                          {t('出典を聴く', 'Listen to source')}
                        </Button>
                        <Button
                          disabled={!ready || !source || !subtitleUsable(source)}
                          onClick={() => source &&
                            onInspect({ ...source, sourceCueIds: ids }, candidate.term, candidate, true)}
                        >
                          <BookmarkPlus size={15} />
                          {t('内容を確認して保存', 'Review and save')}
                        </Button>
                      </div>
                    </article>
                  );
                })}
            </div>
      </StudyRegion>
      <StudyRegion open={tab === 'transcript'}>
            <div className="transcript-view" role="tabpanel" id={`${tabsId}-transcript-panel`} aria-labelledby={`${tabsId}-transcript-tab`}>
              <div className="transcript-tools">
                <div className="search-box">
                  <Search size={16} />
                  <input
                    ref={searchInput}
                    aria-label={t('字幕を検索', 'Search transcript')}
                    placeholder={t('字幕を検索', 'Search transcript')}
                    value={search}
                    onChange={event => updateView({ search: event.target.value, scrollOffset: 0 })}
                  />
                  <MotionRegion mode="status" as="span" open={!!search}>{search &&
                    <IconButton
                      label={t('検索をクリア', 'Clear search')}
                      onClick={() => { updateView({ search: '', scrollOffset: 0 }); searchInput.current?.focus(); }}
                    >
                      <X size={14} />
                    </IconButton>}</MotionRegion>
                </div>
              </div>
              <div className="transcript-actions">
                <Button variant="ghost" onClick={onImport}>
                  <Subtitles size={16} />
                  {t('字幕を追加・切り替え', 'Add or switch subtitles')}
                </Button>
                <Button
                  variant="ghost"
                  aria-pressed={showTranslations}
                  onClick={() => updateView({ showTranslations: !showTranslations })}
                >
                  <Languages size={16} />
                  {showTranslations ? t('訳を隠す', 'Hide translations') : t('訳を表示', 'Show translations')}
                </Button>
              </div>
              <div className="transcript-filter-bar">
              <label className="transcript-marked-filter"><input type="checkbox" checked={markedOnly} disabled={!markedOnly && !segments.some(isMarked)} onChange={event => {
                setMarkedOnly(event.target.checked);
                updateView({ scrollOffset: 0, following: false });
              }} /><span>{t('注意のある箇所だけ表示', 'Show marked passages only')}</span></label>
              <TranscriptStatus error={segments.length ? error : null}
                label={t('字幕を更新できませんでした', 'Subtitles could not be updated')}
                retryLabel={t('字幕の読み込みを再試行', 'Retry loading subtitles')} onRetry={onRetryTranscript ? retryTranscript : undefined} />
              </div>
              {!segments.length
                ? (
                  <EmptyState
                    icon={<Subtitles size={26} />}
                    title={error ? t('字幕を読み込めませんでした', 'Subtitles could not be loaded') : t('字幕を追加できます', 'Add subtitles')}
                    description={error?.message ?? t(
                      '字幕ファイルや埋め込み字幕を使うと、言葉を選んで確認できます。',
                      'Import subtitles to inspect a phrase while you watch.'
                    )}
                  >
                    {error && onRetryTranscript ? <Button onClick={retryTranscript}>{t('字幕の読み込みを再試行', 'Retry loading subtitles')}</Button>
                      : <Button onClick={() => onEstimate('transcribe')}>{t('音声から字幕を作成', 'Create subtitles from audio')}</Button>}
                  </EmptyState>
                )
                : !filtered.length
                  ? (
                    <EmptyState
                      icon={<Search size={24} />}
                      title={t('一致する字幕はありません', 'No matching subtitles')}
                      description={t('検索語や注意のある箇所の絞り込みを変えてください。', 'Try another search or change the marked-passage filter.')}
                    >
                      <Button onClick={() => {
                        setMarkedOnly(false);
                        updateView({ search: '', scrollOffset: 0 });
                        searchInput.current?.focus();
                      }}>{t('絞り込みをリセット', 'Reset filters')}</Button>
                    </EmptyState>
                  )
                  : (
                    <div
                      ref={scrollRef}
                      className="transcript-scroll"
                      tabIndex={0}
                      aria-label={t('字幕一覧', 'Subtitle list')}
                      onScroll={event => { if (!active || tab !== 'transcript') return; updateView({
                        scrollOffset: event.currentTarget.scrollTop,
                        measurementCache: { search, showTranslations, markedOnly, width: event.currentTarget.clientWidth, items: virtualizer.takeSnapshot() },
                      }); }}
                      onWheel={() => updateView({ following: false })}
                      onTouchMove={() => updateView({ following: false })}
                      onPointerDown={event => {
                        if (event.target === event.currentTarget) updateView({ following: false });
                      }}
                      onKeyDown={event => {
                        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) updateView({ following: false });
                      }}
                    >
                      <div
                        className="virtual-transcript"
                        style={{ height: virtualizer.getTotalSize() }}
                      >
                        {virtualizer.getVirtualItems().map(item => {
                          const segment = filtered[item.index];
                          return (
                            <article
                              key={segment.id}
                              data-index={item.index}
                              ref={virtualizer.measureElement}
                              className={`transcript-row ${activeId === segment.id ? 'playing' : ''} ${selectedId === segment.id ? 'selected' : ''}`}
                              style={{ transform: `translateY(${item.start}px)` }}
                              onFocusCapture={() => { setFocusedCue(segment.id); updateView({ following: false }); }}
                              onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedCue(undefined); }}
                            >
                              <button
                                type="button"
                                className="segment-time"
                                disabled={!ready}
                                aria-label={`${segment.timingPrecision === 'source_block' ? t('取得元の音声範囲から再生', 'Play from source audio range') : t('この字幕から再生', 'Play from subtitle')} ${timestamp(segment.startMs)}`}
                                title={t('ここから再生を続ける', 'Continue playing from here')}
                                onClick={() => onPlayFrom(segment)}
                              >
                                <MotionSwap as="span" stateKey={activeId === segment.id ? 'playing' : 'idle'}>{activeId === segment.id ? <AudioLines size={16} /> : <Play size={15} />}</MotionSwap>
                                <AnimatedValue value={timestamp(segment.startMs)} />
                              </button>
                              <div className="segment-content">
                                <button
                                  type="button"
                                  className="segment-text"
                                  disabled={!ready}
                                  onClick={event => {
                                    const selection = window.getSelection();
                                    const term = selection?.anchorNode && selection.focusNode &&
                                      event.currentTarget.contains(selection.anchorNode) &&
                                      event.currentTarget.contains(selection.focusNode)
                                      ? selection.toString().trim()
                                      : '';
                                    onInspect(segment, term);
                                  }}
                                >
                                  {segment.text}
                                </button>
                                {showTranslations && segment.translation &&
                                  <p className="segment-translation">{segment.translation}</p>}
                                <div className="segment-actions">
                                  <span className="segment-review-slot">
                                    {(isMarked(segment) || !subtitleUsable(segment)) && <span
                                      className="segment-review-mark" title={t('要確認', 'Needs review')} aria-label={t('要確認', 'Needs review')} role="note"
                                    ><TriangleAlert size={16} /></span>}
                                  </span>
                                  <IconButton
                                    className="segment-save"
                                    label={t('フレーズを確認・保存', 'Review and save phrase')}
                                    disabled={!ready || !subtitleUsable(segment)}
                                    onClick={() => onInspect(segment, '', undefined, true)}
                                  >
                                    <BookmarkPlus size={16} aria-hidden="true" />
                                  </IconButton>
                                  <AnimatedDetails className="segment-options" data-motion-geometry="stable" open={openMenu === segment.id}
                                    onToggle={event => placeMenu(event.currentTarget)}
                                    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpenMenu(undefined); }}
                                    onKeyDown={event => {
                                      if (event.key !== 'Escape' || !event.currentTarget.open) return;
                                      event.preventDefault(); event.stopPropagation(); closeMenu(event.currentTarget);
                                    }}>
                                    <summary aria-label={t(`${timestamp(segment.startMs)}の字幕の操作`, `Subtitle actions at ${timestamp(segment.startMs)}`)} onClick={event => {
                                      event.preventDefault();
                                      activeMenu.current = event.currentTarget.closest('details');
                                      setOpenMenu(current => current === segment.id ? undefined : segment.id);
                                    }}><MoreHorizontal size={18} /></summary>
                                    <div className="segment-options-panel">
                                      <Button variant="ghost" aria-label={t('字幕を編集', 'Edit subtitle')} onClick={event => {
                                        closeMenu(event.currentTarget); onEdit(segment);
                                      }}><Edit3 size={16} />{t('編集', 'Edit')}</Button>
                                      {onTranscribeRange && <Button variant="ghost" aria-label={t('この区間を再文字起こし', 'Retranscribe this range')} onClick={event => {
                                        closeMenu(event.currentTarget); onTranscribeRange({ startMs: segment.startMs, endMs: segment.endMs });
                                      }}><RefreshCw size={15} />{t('再文字起こし', 'Retranscribe')}</Button>}
                                    </div>
                                  </AnimatedDetails>
                                </div>
                                {segment.timingPrecision === 'source_block' && <p className="source-block-note">{t('本文は取得済み・字幕の時刻は未確定', 'Text received · subtitle timing unavailable')}<br />{t('取得元の音声範囲', 'Source audio range')}: {timestamp(segment.startMs)}–{timestamp(segment.endMs)}</p>}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  )}
              <footer className="transcript-footer">
                <AnimatedValue value={search
                  ? t(`${filtered.length} 件の一致`, `${filtered.length} matches`)
                  : t('本文で確認、時刻から再生', 'Select text to inspect; play from timestamp')} />
                <button
                  type="button"
                  className={following && !search && !markedOnly ? 'following' : ''}
                  onClick={() => {
                    setMarkedOnly(false);
                    updateView({ search: '', following: true });
                  }}
                >
                  <Crosshair size={15} />
                  <MotionSwap as="span" stateKey={following && !search && !markedOnly ? 'following' : 'manual'}>{following && !search && !markedOnly
                    ? t('自動追従中', 'Following playback')
                    : t('再生中の字幕へ', 'Show current subtitle')}</MotionSwap>
                </button>
              </footer>
            </div>
      </StudyRegion>
      </div>
    </>
  );
}
