// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { animate, motionValue } from 'motion';
import { BookmarkPlus, ChevronLeft, ChevronRight, Languages, Play, RotateCcw } from 'lucide-react';
import { useAppearance } from '../../app/runtime';
import type { SubtitleSegment } from '../../shared/contracts/media';
import { timestamp } from '../../shared/format';
import { Button, MotionButton } from '../../shared/ui/index';
import { MotionRegion, motionDurations, motionRevealEase, useAppMotion } from '../../shared/motion';

type CaptionSource = {
  cue: SubtitleSegment;
  context: 'active' | 'review' | 'preview';
  nextStartMs?: number;
  firstCaption?: boolean;
};

export function CurrentCaption({
  active, previous, next, gapMode, language, loading, hasSubtitles, hasTimedSubtitles, draftMode, enabled, error,
  inspectButton, onInspect, onSave, onImport, onOpenTranscript, onPrevious, onNext, onReplay,
  hasPrevious, hasNext,
}: {
  active?: SubtitleSegment;
  previous?: SubtitleSegment;
  next?: SubtitleSegment;
  gapMode: 'review' | 'preview';
  language: string;
  loading: boolean;
  hasSubtitles: boolean;
  hasTimedSubtitles: boolean;
  draftMode: boolean;
  enabled: boolean;
  error?: Error | null;
  inspectButton: RefObject<HTMLButtonElement | null>;
  onInspect: (source: SubtitleSegment, term?: string) => void;
  onSave?: (source: SubtitleSegment) => void;
  onImport: () => void;
  onOpenTranscript: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onReplay: (source: SubtitleSegment) => void;
  hasPrevious: boolean;
  hasNext: boolean;
}) {
  const { t } = useAppearance();
  const { reducedMotion } = useAppMotion();
  const [showTranslation, setShowTranslation] = useState(false);
  const [gestureSource, setGestureSource] = useState<CaptionSource>();
  const caption = useRef<HTMLParagraphElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [translationExtent] = useState(() => motionValue(0));
  const sourceScroll = useRef<HTMLDivElement>(null);
  const translationScroll = useRef<HTMLDivElement>(null);
  const handled = useRef(false);
  const gapSource = gapMode === 'review' ? previous : next;
  const displayed: CaptionSource | undefined = gestureSource || (active ? { cue: active, context: 'active' }
    : gapSource ? { cue: gapSource, context: gapMode, nextStartMs: next?.startMs, firstCaption: !previous } : undefined);
  const source = displayed?.cue;
  const previewing = displayed?.context === 'preview';
  const replayLabel = previewing ? t('この字幕を再生', 'Play this subtitle') : t('この字幕をもう一度', 'Replay this subtitle');
  const translationOpen = !!source && !draftMode && showTranslation;
  const sourceKey = !draftMode && source ? JSON.stringify([source.mediaId, source.id]) : undefined;
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    const endpoint = translationOpen ? 1 : 0;
    const render = (extent: number) => {
      node.style.gridTemplateRows = `minmax(0, 1fr) minmax(0, ${extent}fr)`;
      node.style.gap = `${8 * extent}px`;
    };
    const unsubscribe = translationExtent.on('change', render);
    render(translationExtent.get());
    // Cue text is always immediate. Only the user-controlled translation space
    // changes size, inside the existing caption frame and below the native video.
    if (reducedMotion || document.hidden || translationExtent.get() === endpoint) {
      translationExtent.jump(endpoint);
      render(endpoint);
      return unsubscribe;
    }
    let controls: ReturnType<typeof animate> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      controls?.stop();
      translationExtent.jump(endpoint);
      render(endpoint);
      clearTimeout(timer);
    };
    const duration = (translationOpen ? motionDurations.reveal : motionDurations.revealClose) * Math.abs(endpoint - translationExtent.get());
    controls = animate(translationExtent, endpoint, { duration, ease: motionRevealEase, onComplete: finish });
    timer = setTimeout(finish, duration * 1000 + 100);
    const visibility = () => { if (document.hidden) finish(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', finish);
    return () => {
      controls?.stop(); clearTimeout(timer); unsubscribe();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', finish);
    };
  }, [translationOpen, reducedMotion, translationExtent]);
  useLayoutEffect(() => {
    // A new subtitle starts at its beginning, but selection keeps its frozen source.
    if (sourceScroll.current) sourceScroll.current.scrollTop = 0;
    if (translationScroll.current) translationScroll.current.scrollTop = 0;
  }, [sourceKey]);

  function finishSelection() {
    if (handled.current) return;
    handled.current = true;
    const selection = window.getSelection();
    const term = selection?.anchorNode && selection.focusNode &&
      caption.current?.contains(selection.anchorNode) && caption.current.contains(selection.focusNode)
      ? selection.toString().trim() : '';
    setGestureSource(undefined);
    if (term && source && enabled && !draftMode) onInspect(source, term);
  }
  useEffect(() => {
    if (!gestureSource) return;
    const release = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !caption.current?.contains(event.target)) finishSelection();
    };
    const cancel = () => setGestureSource(undefined);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, [gestureSource, enabled, draftMode]);

  return (
    <section className="current-caption" aria-label={t('いまの字幕', 'Current subtitle')}>
      <div ref={body} className="caption-body" data-translation-open={translationOpen}>
        <div ref={sourceScroll} className="caption-source-scroll" role="region" aria-label={t('字幕の原文', 'Subtitle source')} tabIndex={0}>
            {draftMode ? (
              <div className="caption-empty">
                <p>{t('下書きの区間を確認しています。選んだ原文は字幕パネルに表示します。', 'Checking a draft passage. Its source text is shown in the transcript panel.')}</p>
              </div>
            ) : source ? (<>
              {displayed?.context !== 'active' && <div className="caption-context">
                <span className="caption-context-label">{displayed?.context === 'review'
                  ? t('前の字幕を復習', 'Review the previous subtitle')
                  : t('次の字幕を予習', 'Preview the next subtitle')}</span>
                <span className="caption-context-time">{displayed?.nextStartMs !== undefined
                  ? t(`${displayed.firstCaption ? '最初' : '次'}の字幕 ${timestamp(displayed.nextStartMs)}`, `${displayed.firstCaption ? 'First' : 'Next'} subtitle ${timestamp(displayed.nextStartMs)}`)
                  : t('この先の字幕はまだありません', 'No further subtitles yet')}</span>
              </div>}
              <p ref={caption} className="current-caption-text" lang={language}
                onPointerDown={() => { handled.current = false; setGestureSource(displayed); }}
                onPointerUp={finishSelection}>
                {source.text}
              </p>
            </>
            ) : (
              <div className="caption-empty">
                <p>{loading ? t('字幕を読み込み中…', 'Loading subtitles…') : !hasSubtitles
                  ? t('字幕を追加すると、気になる言葉を選んで確認できます。', 'Add subtitles to inspect a phrase while you watch.')
                  : !hasTimedSubtitles ? t('再生位置に対応する字幕時刻がありません。字幕一覧で原文を確認できます。', 'This text has no synchronized subtitle timing. Read it in the transcript.')
                    : next ? t(`最初の字幕は ${timestamp(next.startMs)} から`, `The first subtitle starts at ${timestamp(next.startMs)}`)
                      : t('この先の字幕はまだありません', 'No further subtitles yet')}</p>
                {!loading && (!hasSubtitles
                  ? <Button variant="ghost" onClick={onImport}>{t('音声から字幕を作成', 'Create subtitles from audio')}</Button>
                  : !hasTimedSubtitles ? <Button variant="ghost" onClick={onOpenTranscript}>{t('字幕一覧を開く', 'Open transcript')}</Button>
                    : next ? <Button variant="ghost" disabled={!enabled} onClick={onNext}>{t('最初の字幕へ', 'Go to first subtitle')}</Button>
                      : previous && <Button variant="ghost" disabled={!enabled} onClick={onPrevious}>{t('前の字幕へ', 'Go to previous subtitle')}</Button>)}
              </div>
            )}
          <MotionRegion mode="status" open={!!error}>{error && <p className="notice warning" role="alert">{error.message}</p>}</MotionRegion>
        </div>
        <div className="caption-translation-region" data-open={translationOpen} inert={!translationOpen} aria-hidden={!translationOpen}>
          <div ref={translationScroll} className="caption-translation-scroll" role="region" aria-label={t('字幕の訳', 'Subtitle translation')} tabIndex={0}>
            <p className="caption-translation">
              {source?.translation || t('翻訳はまだありません。言葉を確認して翻訳を見積もれます。', 'No translation yet. Inspect this phrase to estimate one.')}
            </p>
          </div>
        </div>
      </div>
      <div className="caption-controls">
        <div className="caption-actions">
          {source && !draftMode && <>
            <Button variant="ghost" aria-pressed={showTranslation} aria-label={showTranslation ? t('訳を隠す', 'Hide translation') : t('訳を表示', 'Show translation')} onClick={() => setShowTranslation(value => !value)}>
              <Languages size={17} />
              <span className="caption-toggle-copy caption-full-label" aria-hidden="true">
                <span style={{ visibility: showTranslation ? 'hidden' : 'visible' }}>{t('訳を表示', 'Show translation')}</span>
                <span style={{ visibility: showTranslation ? 'visible' : 'hidden' }}>{t('訳を隠す', 'Hide translation')}</span>
              </span>
              <span className="caption-short-label" aria-hidden="true">{t('訳', 'Translation')}</span>
            </Button>
            <MotionButton ref={inspectButton} type="button" className="button secondary" aria-label={t('意味を調べる', 'Explore meaning')} disabled={!enabled} onClick={() => onInspect(source)}>
              <span className="caption-full-label">{t('意味を調べる', 'Explore meaning')}</span>
              <span className="caption-short-label" aria-hidden="true">{t('意味を調べる', 'Meaning')}</span>
            </MotionButton>
            {onSave && <Button variant="ghost" aria-label={t('保存', 'Save phrase')} disabled={!enabled} onClick={() => onSave(source)}><BookmarkPlus size={16} /><span className="caption-full-label">{t('保存', 'Save phrase')}</span><span className="caption-short-label" aria-hidden="true">{t('保存', 'Save')}</span></Button>}
          </>}
        </div>
        <div className="caption-navigation-slot">
          <MotionRegion mode="status" open={hasTimedSubtitles && !draftMode} className="caption-navigation" role="group" aria-label={t('字幕の再生操作', 'Subtitle playback')}>
            <Button variant="ghost" aria-label={t('前の字幕', 'Previous subtitle')} disabled={!enabled || !hasPrevious} onClick={onPrevious}>
              <ChevronLeft size={16} /><span className="caption-full-label">{t('前の字幕', 'Previous subtitle')}</span><span className="caption-short-label" aria-hidden="true">{t('前の字幕', 'Previous')}</span>
            </Button>
            <Button variant="secondary" aria-label={replayLabel} disabled={!enabled || !source} onClick={() => source && onReplay(source)}>
              {previewing ? <Play size={16} /> : <RotateCcw size={16} />}
              <span className="caption-full-label" aria-hidden="true"><span className="caption-replay-copy">
                <span style={{ visibility: previewing ? 'visible' : 'hidden' }}>{t('この字幕を再生', 'Play this subtitle')}</span>
                <span style={{ visibility: previewing ? 'hidden' : 'visible' }}>{t('この字幕をもう一度', 'Replay this subtitle')}</span>
              </span></span>
              <span className="caption-short-label" aria-hidden="true"><span className="caption-replay-copy">
                <span style={{ visibility: previewing ? 'visible' : 'hidden' }}>{t('再生', 'Play')}</span>
                <span style={{ visibility: previewing ? 'hidden' : 'visible' }}>{t('もう一度', 'Replay')}</span>
              </span></span>
            </Button>
            <Button variant="ghost" aria-label={t('次の字幕', 'Next subtitle')} disabled={!enabled || !hasNext} onClick={onNext}>
              <span className="caption-full-label">{t('次の字幕', 'Next subtitle')}</span><span className="caption-short-label" aria-hidden="true">{t('次の字幕', 'Next')}</span><ChevronRight size={16} />
            </Button>
          </MotionRegion>
        </div>
      </div>
    </section>
  );
}
