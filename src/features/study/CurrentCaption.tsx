// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { BookmarkPlus, ChevronLeft, ChevronRight, Languages, RotateCcw } from 'lucide-react';
import { useAppearance } from '../../app/runtime';
import type { SubtitleSegment } from '../../shared/contracts/media';
import { Button } from '../../shared/ui/index';
import { MotionRegion } from '../../shared/motion';

export function CurrentCaption({
  active, language, loading, hasSubtitles, draftMode, enabled, error,
  inspectButton, onInspect, onSave, onImport, onPrevious, onNext, onReplay,
  hasPrevious, hasNext,
}: {
  active?: SubtitleSegment;
  language: string;
  loading: boolean;
  hasSubtitles: boolean;
  draftMode: boolean;
  enabled: boolean;
  error?: Error | null;
  inspectButton: RefObject<HTMLButtonElement | null>;
  onInspect: (source: SubtitleSegment, term?: string) => void;
  onSave?: (source: SubtitleSegment) => void;
  onImport: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onReplay: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
}) {
  const { t } = useAppearance();
  const [showTranslation, setShowTranslation] = useState(false);
  const [gestureSource, setGestureSource] = useState<SubtitleSegment>();
  const caption = useRef<HTMLParagraphElement>(null);
  const sourceScroll = useRef<HTMLDivElement>(null);
  const translationScroll = useRef<HTMLDivElement>(null);
  const handled = useRef(false);
  const source = gestureSource || active;
  const translationOpen = !!source && !draftMode && showTranslation;
  const sourceKey = !draftMode && source ? JSON.stringify([source.mediaId, source.id]) : undefined;
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
      <div className="caption-body" data-translation-open={translationOpen}>
        <div ref={sourceScroll} className="caption-source-scroll" role="region" aria-label={t('字幕の原文', 'Subtitle source')} tabIndex={0}>
            {draftMode ? (
              <div className="caption-empty">
                <p>{t('下書きの区間を確認しています。選んだ原文は字幕パネルに表示します。', 'Checking a draft passage. Its source text is shown in the transcript panel.')}</p>
              </div>
            ) : source ? (
              <p ref={caption} className="current-caption-text" lang={language}
                onPointerDown={() => { handled.current = false; setGestureSource(source); }}
                onPointerUp={finishSelection}>
                {source.text}
              </p>
            ) : (
              <div className="caption-empty">
                <p>{loading ? t('字幕を読み込み中…', 'Loading subtitles…') : hasSubtitles
                  ? t('音声に合わせて、ここに字幕を表示します。', 'Subtitles appear here as you watch.')
                  : t('字幕を追加すると、気になる言葉を選んで確認できます。', 'Add subtitles to inspect a phrase while you watch.')}</p>
                {!hasSubtitles && <Button variant="ghost" onClick={onImport}>{t('音声から字幕を作成', 'Create subtitles from audio')}</Button>}
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
            <button ref={inspectButton} type="button" className="button secondary" aria-label={t('意味を調べる', 'Explore meaning')} disabled={!enabled} onClick={() => onInspect(source)}>
              <span className="caption-full-label">{t('意味を調べる', 'Explore meaning')}</span>
              <span className="caption-short-label" aria-hidden="true">{t('意味を調べる', 'Meaning')}</span>
            </button>
            {onSave && <Button variant="ghost" aria-label={t('保存', 'Save phrase')} disabled={!enabled} onClick={() => onSave(source)}><BookmarkPlus size={16} /><span className="caption-full-label">{t('保存', 'Save phrase')}</span><span className="caption-short-label" aria-hidden="true">{t('保存', 'Save')}</span></Button>}
          </>}
        </div>
        <div className="caption-navigation-slot">
          <MotionRegion mode="status" open={hasSubtitles && !draftMode} className="caption-navigation" role="group" aria-label={t('字幕の再生操作', 'Subtitle playback')}>
            <Button variant="ghost" aria-label={t('前の字幕', 'Previous subtitle')} disabled={!enabled || !hasPrevious} onClick={onPrevious}>
              <ChevronLeft size={16} /><span className="caption-full-label">{t('前の字幕', 'Previous subtitle')}</span><span className="caption-short-label" aria-hidden="true">{t('前の字幕', 'Previous')}</span>
            </Button>
            <Button variant="secondary" aria-label={t('この字幕をもう一度', 'Replay this subtitle')} disabled={!enabled || !active} onClick={onReplay}>
              <RotateCcw size={16} /><span className="caption-full-label">{t('この字幕をもう一度', 'Replay this subtitle')}</span><span className="caption-short-label" aria-hidden="true">{t('もう一度', 'Replay')}</span>
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
