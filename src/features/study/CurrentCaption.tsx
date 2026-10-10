// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ChevronLeft, ChevronRight, Languages, RotateCcw } from 'lucide-react';
import { useAppearance } from '../../app/runtime';
import type { SubtitleSegment } from '../../shared/contracts/media';
import { Button } from '../../shared/ui/index';
import { MotionRegion, MotionSwap, useMotionChange } from '../../shared/motion';
import { StudyRegion } from './StudyPresence';

export function CurrentCaption({
  active, language, loading, hasSubtitles, draftMode, enabled, error,
  inspectButton, onInspect, onImport, onPrevious, onNext, onReplay,
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
  const translation = useRef<HTMLParagraphElement>(null);
  const handled = useRef(false);
  const source = gestureSource || active;
  // Keep the selectable paragraph alive while changing only its presentation.
  // gestureSource deliberately freezes this key until selection is released.
  useMotionChange(caption, `${source?.id ?? ''}:${source?.text ?? ''}`, !!gestureSource);
  useMotionChange(translation, source?.translation ?? '');

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
      <MotionSwap stateKey={draftMode ? 'draft' : source ? 'caption' : loading ? 'loading' : hasSubtitles ? 'gap' : 'empty'}>
      {draftMode ? (
        <div className="caption-empty">
          <p>{t('下書きの区間を確認しています。選んだ原文は字幕パネルに表示します。', 'Checking a draft passage. Its source text is shown in the transcript panel.')}</p>
        </div>
      ) : source ? (
        <>
          <p ref={caption} className="current-caption-text" lang={language}
            onPointerDown={() => { handled.current = false; setGestureSource(source); }}
            onPointerUp={finishSelection}>
            {source.text}
          </p>
          <StudyRegion open={showTranslation} className="study-motion-inline">
            <p ref={translation} className="caption-translation">
              {source.translation || t('翻訳はまだありません。言葉を確認して翻訳を見積もれます。', 'No translation yet. Inspect this phrase to estimate one.')}
            </p>
          </StudyRegion>
          <div className="caption-actions">
            <Button variant="ghost" aria-pressed={showTranslation} onClick={() => setShowTranslation(value => !value)}>
              <Languages size={17} />
              <MotionSwap as="span" stateKey={String(showTranslation)}>{showTranslation ? t('訳を閉じる', 'Hide translation') : t('訳を表示', 'Show translation')}</MotionSwap>
            </Button>
            <button ref={inspectButton} type="button" className="button secondary" disabled={!enabled} onClick={() => onInspect(source)}>
              {t('この言葉を確認', 'Inspect this phrase')}
            </button>
          </div>
        </>
      ) : (
        <div className="caption-empty">
          <p>{loading ? t('字幕を読み込み中…', 'Loading subtitles…') : hasSubtitles
            ? t('音声に合わせて、ここに字幕を表示します。', 'Subtitles appear here as you watch.')
            : t('字幕を追加すると、気になる言葉を選んで確認できます。', 'Add subtitles to inspect a phrase while you watch.')}</p>
          {!hasSubtitles && <Button variant="ghost" onClick={onImport}>{t('字幕を用意する', 'Prepare subtitles')}</Button>}
        </div>
      )}
      </MotionSwap>
        <MotionRegion open={hasSubtitles && !draftMode} className="caption-navigation" role="group" aria-label={t('字幕の再生操作', 'Subtitle playback')}>
          <Button variant="ghost" disabled={!enabled || !hasPrevious} onClick={onPrevious}>
            <ChevronLeft size={16} />{t('前の字幕', 'Previous subtitle')}
          </Button>
          <Button variant="secondary" disabled={!enabled || !active} onClick={onReplay}>
            <RotateCcw size={16} />{t('もう一度聴く', 'Listen again')}
          </Button>
          <Button variant="ghost" disabled={!enabled || !hasNext} onClick={onNext}>
            {t('次の字幕', 'Next subtitle')}<ChevronRight size={16} />
          </Button>
        </MotionRegion>
      <MotionRegion open={!!error}>{error && <p className="notice warning" role="alert">{error.message}</p>}</MotionRegion>
    </section>
  );
}
