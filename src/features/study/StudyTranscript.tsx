// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { VirtualItem } from '@tanstack/react-virtual';
import {
  AudioLines,
  BookmarkPlus,
  Crosshair,
  Edit3,
  Languages,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Subtitles,
  X
} from 'lucide-react';
import type { Media, SubtitleSegment } from '../../shared/contracts/media';
import { subtitleUsable } from '../../shared/contracts/media';
import type { VocabularyCandidate } from '../../shared/contracts/cards';
import type { SelectedContext } from './source-selection';
import { resolveSourceSelection } from './source-selection';
import { useAppearance } from '../../app/runtime';
import { timestamp } from '../../shared/format';
import { Badge, Button, EmptyState, IconButton } from '../../shared/ui/index';
import { AnimatedValue, MotionRegion, MotionSwap, useAppMotion, useMotionChange } from '../../shared/motion';
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
    width: number;
    items: VirtualItem[];
  };
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
  onInspect,
  onReplay,
  onEdit,
  onImport,
  onEstimate,
  onReview,
  onDraftPlay,
  transcriptionWorkspace,
  transcriptionStatus,
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
  onInspect: (
    segment: SelectedContext,
    term?: string,
    candidate?: VocabularyCandidate,
    save?: boolean
  ) => void;
  onReplay: (segment: SelectedContext) => void;
  onEdit: (segment: SubtitleSegment) => void;
  onImport: () => void;
  onEstimate: (kind: 'transcribe' | 'vocabulary') => void;
  onReview: (jobId: string) => void;
  onDraftPlay: PlayRange;
  transcriptionWorkspace?: ReactNode;
  transcriptionStatus?: ReactNode;
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
  const { search, following, showTranslations } = viewState;
  const [markedOnly, setMarkedOnly] = useState(false);
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const updateView = useCallback((patch: Partial<TranscriptViewState>) => {
    const next = { ...viewStateRef.current, ...patch };
    viewStateRef.current = next;
    onViewStateChange(next);
  }, [onViewStateChange]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const suggestions = useRef<HTMLDivElement>(null);
  const followedSubtitle = useRef<string | undefined>(undefined);
  const filtered = segments.filter(item => (!markedOnly || item.status === 'generated_review' || item.timingPrecision === 'source_block' || !!item.reviewIssues?.length) && `${item.text} ${item.translation || ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  // Fade semantic filtering/list changes without cloning a virtual viewport or
  // replaying entrance effects when scrolling recycles rows.
  useMotionChange(scrollRef, filtered.map(segment => segment.id).join(','));
  useMotionChange(suggestions, JSON.stringify(candidates.map(candidate => [candidate.id, candidate.term, candidate.meaning, candidate.example])));
  const cached = viewState.measurementCache;
  const initialMeasurements = cached?.search === search && cached.showTranslations === showTranslations ? cached : undefined;
  const previousLayout = useRef({ search, showTranslations, width: initialMeasurements?.width });
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => filtered[index].id,
    initialOffset: viewState.scrollOffset,
    initialMeasurementsCache: initialMeasurements?.items,
    estimateSize: () => showTranslations ? 156 : 126,
    overscan: 6,
  });
  const viewportWidth = virtualizer.scrollRect?.width ?? 0;
  const viewportHeight = virtualizer.scrollRect?.height ?? 0;

  useLayoutEffect(() => {
    if (!active || tab !== 'transcript' || !scrollRef.current) return;
    const width = scrollRef.current.clientWidth;
    const previous = previousLayout.current;
    // Keep measured heights when returning from the inspector. Replacing them
    // with estimates would cause the virtualizer to shift the restored offset.
    if (previous.search !== search || previous.showTranslations !== showTranslations ||
        (previous.width !== undefined && previous.width !== width)) virtualizer.measure();
    previousLayout.current = { search, showTranslations, width };
    if (!following || search) {
      virtualizer.scrollToOffset(viewStateRef.current.scrollOffset, { behavior: 'auto' });
    }
  }, [active, tab, search, showTranslations, filtered.length, viewportWidth, viewportHeight]);

  useLayoutEffect(
    () => {
      if (!active || !following || search || tab !== 'transcript') {
        followedSubtitle.current = undefined;
        return;
      }
      const index = filtered.findIndex(item => item.id === activeId);
      // A retained panel can still have the hidden viewport's zero-height
      // measurement when it opens. Align after ResizeObserver reports its size.
      if (index < 0 || viewportHeight <= 0) return;
      const scroll = scrollRef.current;
      const smooth = !reducedMotion && followedSubtitle.current !== undefined &&
        followedSubtitle.current !== activeId;
      followedSubtitle.current = activeId;
      virtualizer.scrollToIndex(index, { align: 'center', behavior: smooth ? 'smooth' : 'auto' });
      return () => {
        // Interrupt an in-flight follow before manual scrolling, hiding the
        // panel, changing motion preferences, or following another subtitle.
        if (scroll) virtualizer.scrollToOffset(scroll.scrollTop, { behavior: 'auto' });
      };
    },
    [active, activeId, following, search, tab, filtered.length, showTranslations, reducedMotion, viewportWidth, viewportHeight]
  );

  return (
    <>
      <div
        className="transcript-tabs"
        role="tablist"
        aria-label={t('字幕の表示内容', 'Transcript content')}
      >
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
      <div className="transcript-tab-content">
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
            <div ref={suggestions} className="suggestions-panel" role="tabpanel" id={`${tabsId}-vocabulary-panel`} aria-labelledby={`${tabsId}-vocabulary-tab`}>
              <MotionRegion open={!!candidatesError}>{candidatesError &&
                <p
                  className="notice warning"
                  role="alert"
                >
                  {candidatesError.message}
                </p>}</MotionRegion>
              {!candidates.length
                ? (
                  <EmptyState
                    icon={<Sparkles size={26} />}
                    title={t('提案はまだありません', 'No suggestions yet')}
                    description={t(
                      '区間を選んで、表現の解説や語彙の提案を見積もれます。',
                      'Choose a passage to estimate explanations or vocabulary suggestions.'
                    )}
                  >
                    <Button onClick={() => onEstimate('vocabulary')}>{t('区間を選んで見積もる', 'Choose a range')}</Button>
                  </EmptyState>
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
              {transcriptionStatus}
              <div className="transcript-tools">
                <div className="search-box">
                  <Search size={16} />
                  <input
                    aria-label={t('字幕を検索', 'Search transcript')}
                    placeholder={t('字幕を検索', 'Search transcript')}
                    value={search}
                    onChange={event => updateView({ search: event.target.value, scrollOffset: 0 })}
                  />
                  <MotionRegion as="span" open={!!search}>{search &&
                    <IconButton
                      label={t('検索をクリア', 'Clear search')}
                      onClick={() => updateView({ search: '', scrollOffset: 0 })}
                    >
                      <X size={14} />
                    </IconButton>}</MotionRegion>
                </div>
                <IconButton
                  label={t('翻訳を表示・非表示', 'Toggle translations')}
                  aria-pressed={showTranslations}
                  onClick={() => updateView({ showTranslations: !showTranslations })}
                >
                  <Languages size={18} />
                </IconButton>
              </div>
              {segments.some(cue => cue.status === 'generated_review' || cue.timingPrecision === 'source_block') && <label className="check-field source-block-note"><input type="checkbox" checked={markedOnly} onChange={event => setMarkedOnly(event.target.checked)} />{t('注意のある箇所だけ表示', 'Show marked passages only')}</label>}
              <MotionRegion open={!!error}>{error && <p
                className="notice warning"
                role="alert"
              >
                {error.message}
              </p>}</MotionRegion>
              {!segments.length
                ? (
                  <EmptyState
                    icon={<Subtitles size={26} />}
                    title={t('字幕を追加できます', 'Add subtitles')}
                    description={t(
                      '字幕ファイルや埋め込み字幕を使うと、言葉を選んで確認できます。',
                      'Import subtitles to inspect a phrase while you watch.'
                    )}
                  >
                    <Button onClick={() => onEstimate('transcribe')}>{t('字幕を作成', 'Create subtitles')}</Button>
                    <Button
                      variant="ghost"
                      onClick={onImport}
                    >
                      {t('字幕を読み込む', 'Import subtitles')}
                    </Button>
                  </EmptyState>
                )
                : !filtered.length
                  ? (
                    <EmptyState
                      icon={<Search size={24} />}
                      title={t('一致する字幕はありません', 'No matching subtitles')}
                      description={t('別の単語で検索してください。', 'Try another word.')}
                    />
                  )
                  : (
                    <div
                      ref={scrollRef}
                      className="transcript-scroll"
                      tabIndex={0}
                      aria-label={t('字幕一覧', 'Subtitle list')}
                      onScroll={event => updateView({
                        scrollOffset: event.currentTarget.scrollTop,
                        measurementCache: { search, showTranslations, width: event.currentTarget.clientWidth, items: virtualizer.takeSnapshot() },
                      })}
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
                            >
                              <button
                                type="button"
                                className="segment-time"
                                disabled={!ready}
                                aria-label={`${segment.timingPrecision === 'source_block' ? t('取得元の音声範囲を再生', 'Play source audio range') : t('この字幕を再生', 'Play subtitle')} ${timestamp(segment.startMs)}`}
                                onClick={() => onReplay(segment)}
                              >
                                <MotionSwap as="span" stateKey={activeId === segment.id ? 'playing' : 'idle'}>{activeId === segment.id ? <AudioLines size={16} /> : <Play size={15} />}</MotionSwap>
                                <AnimatedValue value={timestamp(segment.startMs)} />
                              </button>
                              <TranscriptContent stateKey={JSON.stringify([segment.text, showTranslations && segment.translation, segment.timingPrecision, segment.status])}>
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
                                {segment.timingPrecision === 'source_block' && <p className="source-block-note">{t('本文は取得済み・字幕の時刻は未確定', 'Text received · subtitle timing unavailable')}<br />{t('取得元の音声範囲', 'Source audio range')}: {timestamp(segment.startMs)}–{timestamp(segment.endMs)}</p>}
                                {(segment.status === 'generated_review' || !subtitleUsable(segment)) &&
                                  <Badge tone="warning">{t('要確認', 'Needs review')}</Badge>}
                                <div className="segment-actions">
                                  {onTranscribeRange && <IconButton label={t('この区間を再文字起こし', 'Transcribe this range again')} onClick={() => onTranscribeRange({ startMs: segment.startMs, endMs: segment.endMs })}><RefreshCw size={15} /></IconButton>}
                                  <IconButton
                                    label={t('字幕を編集', 'Edit subtitle')}
                                    onClick={() => onEdit(segment)}
                                  >
                                    <Edit3 size={16} />
                                  </IconButton>
                                  <IconButton
                                    label={t('フレーズを保存', 'Save phrase')}
                                    disabled={!ready || !subtitleUsable(segment)}
                                    onClick={() => onInspect(segment, '', undefined, true)}
                                  >
                                    <BookmarkPlus size={16} />
                                  </IconButton>
                                </div>
                              </TranscriptContent>
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  )}
              <footer className="transcript-footer">
                <AnimatedValue value={search
                  ? t(`${filtered.length} 件の一致`, `${filtered.length} matches`)
                  : t('本文で確認、時刻で再生', 'Select text to inspect; time to replay')} />
                <button
                  type="button"
                  className={following && !search ? 'following' : ''}
                  onClick={() => {
                    updateView({ search: '', following: true });
                  }}
                >
                  <Crosshair size={15} />
                  <MotionSwap as="span" stateKey={following && !search ? 'following' : 'manual'}>{following && !search
                    ? t('再生に追従中', 'Following playback')
                    : t('再生に戻る', 'Follow playback')}</MotionSwap>
                </button>
              </footer>
            </div>
      </StudyRegion>
      </div>
    </>
  );
}

/** Virtual rows appear without an entrance animation; only their content changes fade. */
function TranscriptContent({ stateKey, children }: { stateKey: string; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  useMotionChange(content, stateKey);
  return <div ref={content} className="segment-content">{children}</div>;
}
