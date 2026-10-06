// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useLayoutEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { VirtualItem } from '@tanstack/react-virtual';
import {
  AudioLines,
  BookmarkPlus,
  Crosshair,
  Edit3,
  Languages,
  Play,
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
import { DraftStudyPanel } from './drafts/DraftStudyPanel';
import type { PlayRange } from './drafts/lifecycle';
export type TranscriptTab = 'transcript' | 'vocabulary' | 'draft';
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
}) {
  const { t } = useAppearance();
  const { search, following, showTranslations } = viewState;
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const updateView = useCallback((patch: Partial<TranscriptViewState>) => {
    const next = { ...viewStateRef.current, ...patch };
    viewStateRef.current = next;
    onViewStateChange(next);
  }, [onViewStateChange]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const filtered = segments.filter(item => `${item.text} ${item.translation || ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
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

  useLayoutEffect(() => {
    if (tab !== 'transcript' || !scrollRef.current) return;
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
  }, [tab, search, showTranslations, filtered.length]);

  useLayoutEffect(
    () => {
      if (!following || search || tab !== 'transcript') return;
      const index = filtered.findIndex(item => item.id === activeId);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center', behavior: 'auto' });
    },
    [activeId, following, search, tab, filtered.length, showTranslations]
  );

  return (
    <>
      <div
        className="transcript-tabs"
        aria-label={t('字幕の表示内容', 'Transcript content')}
      >
        {([
          ['transcript', t('字幕', 'Transcript')],
          ['vocabulary', t('AI の提案', 'Suggestions')],
          ['draft', t('下書きから学ぶ', 'Study a draft')],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => onTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'draft'
        ? (
          <DraftStudyPanel
            media={media}
            playbackReady={ready}
            onReview={onReview}
            onPlay={onDraftPlay}
            onAddSubtitles={onImport}
            onEstimate={() => onEstimate('transcribe')}
          />
        )
        : tab === 'vocabulary'
          ? (
            <div className="suggestions-panel">
              {candidatesError &&
                <p
                  className="notice warning"
                  role="alert"
                >
                  {candidatesError.message}
                </p>}
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
          )
          : (
            <>
              <div className="transcript-tools">
                <div className="search-box">
                  <Search size={16} />
                  <input
                    aria-label={t('字幕を検索', 'Search transcript')}
                    placeholder={t('字幕を検索', 'Search transcript')}
                    value={search}
                    onChange={event => updateView({ search: event.target.value, scrollOffset: 0 })}
                  />
                  {search &&
                    <IconButton
                      label={t('検索をクリア', 'Clear search')}
                      onClick={() => updateView({ search: '', scrollOffset: 0 })}
                    >
                      <X size={14} />
                    </IconButton>}
                </div>
                <IconButton
                  label={t('翻訳を表示・非表示', 'Toggle translations')}
                  aria-pressed={showTranslations}
                  onClick={() => updateView({ showTranslations: !showTranslations })}
                >
                  <Languages size={18} />
                </IconButton>
              </div>
              {error && <p
                className="notice warning"
                role="alert"
              >
                {error.message}
              </p>}
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
                    <Button onClick={onImport}>{t('字幕を読み込む', 'Import subtitles')}</Button>
                    <Button
                      variant="ghost"
                      onClick={() => onEstimate('transcribe')}
                    >
                      {t('文字起こしを見積もる', 'Estimate transcription')}
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
                                aria-label={`${t('この字幕を再生', 'Play subtitle')} ${timestamp(segment.startMs)}`}
                                onClick={() => onReplay(segment)}
                              >
                                {activeId === segment.id ? <AudioLines size={16} /> : <Play size={15} />}
                                <span>{timestamp(segment.startMs)}</span>
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
                                {(segment.status === 'generated_review' || !subtitleUsable(segment)) &&
                                  <Badge tone="warning">{t('要確認', 'Needs review')}</Badge>}
                                <div className="segment-actions">
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
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  )}
              <footer className="transcript-footer">
                <span>{search
                  ? t(`${filtered.length} 件の一致`, `${filtered.length} matches`)
                  : t('本文で確認、時刻で再生', 'Select text to inspect; time to replay')}</span>
                <button
                  type="button"
                  className={following && !search ? 'following' : ''}
                  onClick={() => {
                    updateView({ search: '', following: true });
                  }}
                >
                  <Crosshair size={15} />
                  {following && !search
                    ? t('再生に追従中', 'Following playback')
                    : t('再生に戻る', 'Follow playback')}
                </button>
              </footer>
            </>
          )}
    </>
  );
}
