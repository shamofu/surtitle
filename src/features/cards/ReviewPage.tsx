// SPDX-License-Identifier: GPL-3.0-or-later
import { MotionLink } from '../../shared/ui/MotionLink';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { animate } from 'motion';
import { m } from 'motion/react';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeft,
  AudioLines,
  BookOpen,
  Check,
  Eye,
  RefreshCw,
} from 'lucide-react';
import { cardsApi } from './api';
import { playerApi } from '../study/playback/api';
import type { StudyCard } from '../../shared/contracts/cards';
import {
  useDataActions,
  useSnapshot,
  useAppearance,
  useNotifications,
  useSurface,
} from '../../app/runtime';
import { shouldIgnoreShortcut } from '../../shared/keyboard';
import { dueCards, languageName } from '../../shared/format';
import { Badge, Button, EmptyState, MotionButton } from '../../shared/ui/index';
import { AnimatedValue, MotionRegion, MotionSpinner, motionDurations, motionEase, useAppMotion, useMotionActive, useMotionEntrance } from '../../shared/motion';

export type Rating = 'again' | 'hard' | 'good' | 'easy';

export function ReviewCard({
  card,
  onRated,
}: {
  card: StudyCard;
  onRated: (restoreFocus: boolean) => void;
}) {
  const { mutate } = useDataActions();
  const { data } = useSnapshot();
  const { t, locale } = useAppearance();
  const { report } = useNotifications();
  const { surfaceHidden } = useSurface();
  const motionActive = useMotionActive();
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const article = useRef<HTMLElement>(null);
  const answerHeading = useRef<HTMLHeadingElement>(null);
  const focusAnswer = useRef(false);
  function reveal() {
    focusAnswer.current = document.activeElement === document.body || !!article.current?.contains(document.activeElement);
    setRevealed(true);
  }
  useLayoutEffect(() => {
    if (revealed && focusAnswer.current) {
      focusAnswer.current = false;
      answerHeading.current?.focus({ preventScroll: true });
    }
  }, [revealed]);
  const media = data?.media.find((item) => item.id === card.mediaId);
  const choices: { id: Rating; title: string; detail: string }[] = [
    {
      id: 'again',
      title: t('もう一度', 'Again'),
      detail: t('思い出せなかった', 'Could not recall'),
    },
    {
      id: 'hard',
      title: t('難しい', 'Hard'),
      detail: t('少し迷った', 'Took some effort'),
    },
    {
      id: 'good',
      title: t('覚えていた', 'Good'),
      detail: t('思い出せた', 'Recalled it'),
    },
    {
      id: 'easy',
      title: t('簡単', 'Easy'),
      detail: t('すぐにわかった', 'Knew it instantly'),
    },
  ];
  async function rate(rating: Rating) {
    if (!revealed || busy || pending.current) return;
    pending.current = true;
    const owner = article.current?.closest('.review-transition');
    const ownedFocus = document.activeElement === document.body || !!owner?.contains(document.activeElement);
    setBusy(true);
    const result = await report(async () => {
      await mutate(() => cardsApi.rateCard(card.id, rating), {
        kind: 'snapshot',
      });
      return true;
    });
    if (result) {
      onRated(ownedFocus && (document.activeElement === document.body || !!owner?.contains(document.activeElement)));
      return;
    }
    setBusy(false);
    pending.current = false;
  }
  useLayoutEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (surfaceHidden || busy || event.repeat || shouldIgnoreShortcut(event)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        reveal();
      }
      const index = Number(event.key) - 1;
      if (revealed && index >= 0 && index < 4) {
        event.preventDefault();
        void rate(choices[index].id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [revealed, busy, card.id, surfaceHidden]);
  return (
    <>
      <article ref={article} className={`review-card ${revealed ? 'revealed' : ''}`} aria-busy={busy}>
        <div className="review-card-top">
          <Badge>{languageName(card.language, locale)}</Badge>
          <span className="review-question">
            {t('この表現の意味を思い出す', 'Recall the meaning of this phrase')}
          </span>
        </div>
        <div className="review-prompt">
          <h2 tabIndex={-1} data-review-focus>{card.term}</h2>
          <p>{card.example}</p>
          {card.audioPath && (
            <Button
              variant="ghost"
              onClick={() =>
                void report(() => playerApi.playCardAudio(card.id))
              }
            >
              <AudioLines size={17} />
              {t('文脈を聴く', 'Listen in context')}
            </Button>
          )}
        </div>
        <div className="review-answer-region">
        <MotionRegion open={revealed} className="review-answer-reveal">
          <div className="review-answer">
            <h3 ref={answerHeading} tabIndex={-1} className="review-answer-label">{t('意味', 'Meaning')}</h3>
            <p>{card.meaning}</p>
            {card.translation && (
              <p className="review-translation">{card.translation}</p>
            )}
            {card.explanation && (
              <p className="review-explanation">{card.explanation}</p>
            )}
          </div>
        </MotionRegion>
        {!revealed && (
          <div className="review-answer concealed">
            <Button variant="primary" onClick={reveal}>
              <Eye size={17} />
              {t('意味を確認する', 'Reveal meaning')}
              <kbd>Space</kbd>
            </Button>
          </div>
        )}
        </div>
        <footer>
          <BookOpen size={14} />
          {media ? (
            <Link to="/study/$mediaId" params={{ mediaId: card.mediaId }}>
              {media.title}
            </Link>
          ) : (
            <span>{card.sourceTitle || t('保存した文脈', 'Saved context')}</span>
          )}
          <span className="review-card-reps">
            <AnimatedValue value={t(`${card.reviewCount} 回の復習`, `${card.reviewCount} reviews`)} />
          </span>
        </footer>
      </article>
      <div className={`rating-area ${revealed ? '' : 'waiting'}`}>
        <p>
          <span>{revealed
            ? t('どれくらい思い出せましたか？', 'How well did you remember?')
            : t(
                'まずは自分の言葉で意味を思い浮かべて。',
                'Take a moment to recall the meaning in your own words.',
              )}</span>
        </p>
        <m.div className="rating-buttons" initial={false}
          animate={{ y: revealed || !motionActive ? 0 : 4 }}
          transition={{ duration: motionActive ? motionDurations.content : 0, ease: motionEase }}>
          {choices.map((choice, index) => (
            <MotionButton
              key={choice.id}
              className={`rating-button ${choice.id}`}
              disabled={!revealed || busy}
              onClick={() => void rate(choice.id)}
            >
              <span className="rating-key">{index + 1}</span>
              <strong>{choice.title}</strong>
              <small>{choice.detail}</small>
            </MotionButton>
          ))}
        </m.div>
        <small>
          {t(
            '思い出しやすさに合わせて、次の復習時刻が調整されます。',
            'Your next review is scheduled from how well you recalled this phrase.',
          )}
        </small>
      </div>
    </>
  );
}

/** Outgoing content is presentation only: no cloned inputs, rating handlers or IDs. */
function ReviewTransition({ card, stateKey, children }: { card?: StudyCard; stateKey: string; children: ReactNode }) {
  const { reducedMotion } = useAppMotion();
  const { t, locale } = useAppearance();
  const host = useRef<HTMLDivElement>(null);
  const previous = useRef({ key: stateKey, card, height: 0 });
  const [transition, setTransition] = useState<{ key: string; card?: StudyCard; height: number }>();
  useLayoutEffect(() => {
    if (previous.current.key !== stateKey) setTransition({ key: stateKey, card: previous.current.card, height: previous.current.height });
    previous.current = { key: stateKey, card, height: host.current?.querySelector('.motion-swap-live > .review-card')?.getBoundingClientRect().height || previous.current.height };
  }, [stateKey, card]);
  useLayoutEffect(() => {
    if (!transition || transition.key !== stateKey || !host.current) return;
    const incoming = [...host.current.querySelectorAll<HTMLElement>('.motion-swap-live > .review-card > *, .motion-swap-live > .review-complete')];
    const outgoing = [...host.current.querySelectorAll<HTMLElement>('.review-outgoing > .review-card > *')];
    const restore = () => {
      for (const node of incoming) animate(node, { opacity: [1, 1], transform: ['translateX(0px)', 'translateX(0px)'], clipPath: ['inset(0 0 0 0)', 'inset(0 0 0 0)'] }, { duration: 0 }).complete();
      setTransition(undefined);
    };
    if (reducedMotion || document.hidden || typeof Element.prototype.animate !== 'function') { setTransition(undefined); return; }
    // Establish masks before paint; Motion's first render can run on the next RAF.
    for (const node of incoming) { node.style.opacity = '1'; node.style.transform = 'translateX(0px)'; node.style.clipPath = 'inset(0 0 0 100%)'; }
    for (const node of outgoing) { node.style.opacity = '1'; node.style.transform = 'translateX(0px)'; node.style.clipPath = 'inset(0 0% 0 0)'; }
    const controls = [
      // Complementary masks keep dense source/answer text from double-exposing.
      // Their edges meet without a blank seam; the card and text stay stationary.
      ...incoming.map(node => animate(node, { opacity: [1, 1], clipPath: ['inset(0 0 0 100%)', 'inset(0 0 0 0%)'] }, { duration: motionDurations.review, ease: motionEase })),
      ...outgoing.map(node => animate(node, { opacity: [1, 1], clipPath: ['inset(0 0% 0 0)', 'inset(0 100% 0 0)'] }, { duration: motionDurations.review, ease: motionEase })),
    ];
    const finish = () => { controls.forEach(control => control.complete()); restore(); };
    const timer = setTimeout(finish, motionDurations.review * 1000);
    const visibility = () => { if (document.hidden) finish(); };
    window.addEventListener('resize', finish);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      clearTimeout(timer);
      controls.forEach(control => control.complete());
      window.removeEventListener('resize', finish);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [transition, stateKey, reducedMotion]);
  return <div ref={host} className="review-transition motion-swap">
    <div className="motion-swap-live">{children}</div>
    {transition?.card && <div className="review-outgoing" style={{ height: transition.height || undefined }} inert aria-hidden="true">
      <article className="review-card revealed">
        <div className="review-card-top"><Badge>{languageName(transition.card.language, locale)}</Badge><span className="review-question">{t('この表現の意味を思い出す', 'Recall the meaning of this phrase')}</span></div>
        <div className="review-prompt"><h2>{transition.card.term}</h2><p>{transition.card.example}</p>
          {transition.card.audioPath && <span className="button ghost"><AudioLines size={17} />{t('文脈を聴く', 'Listen in context')}</span>}
        </div>
        <div className="review-answer-region"><div className="review-answer"><h3 className="review-answer-label">{t('意味', 'Meaning')}</h3><p>{transition.card.meaning}</p>
          {transition.card.translation && <p className="review-translation">{transition.card.translation}</p>}
          {transition.card.explanation && <p className="review-explanation">{transition.card.explanation}</p>}
        </div></div>
        <footer><BookOpen size={14} /><span>{transition.card.sourceTitle || t('保存した文脈', 'Saved context')}</span><span className="review-card-reps">{t(`${transition.card.reviewCount} 回の復習`, `${transition.card.reviewCount} reviews`)}</span></footer>
      </article>
    </div>}
  </div>;
}

export function ReviewPage() {
  const page = useRef<HTMLDivElement>(null);
  const motionActive = useMotionActive();
  useMotionEntrance(page);
  const { data, loading, error } = useSnapshot();
  const { refresh } = useDataActions();
  const { report } = useNotifications();
  const [retrying, setRetrying] = useState(false);
  const focusNext = useRef(false);
  const { t } = useAppearance();
  const [reviewed, setReviewed] = useState<string[]>([]);
  const [clock, setClock] = useState(Date.now);
  const revision = (card: StudyCard) =>
    JSON.stringify([card.id, card.reviewCount, card.dueAt]);
  useEffect(() => {
    const now = Date.now();
    const next = (data?.cards || []).reduce((next, card) => {
      const due = new Date(card.dueAt).getTime();
      return !card.suspended && due > now ? Math.min(next, due) : next;
    }, Infinity);
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      Math.min(next - now, 60_000),
    );
    return () => window.clearTimeout(timer);
  }, [data?.cards, clock]);
  // Exclude only the already-rated schedule; Again may become due in this page.
  const due = dueCards(data?.cards || []).filter(
    (card) => !reviewed.includes(revision(card)),
  );
  const card = due[0];
  const total = reviewed.length + due.length;
  const cardKey = card ? revision(card) : 'complete';
  useLayoutEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    page.current?.querySelector<HTMLElement>('[data-review-focus]')?.focus({ preventScroll: true });
  }, [cardKey, reviewed.length]);
  if (!data) return <div className="review-page review-unavailable" ref={page}>
    <header className="review-title"><h1>{t('復習', 'Review')}</h1></header>
    {error ? <EmptyState icon={<RefreshCw size={26} />} title={t('復習を読み込めませんでした', 'Could not load your review')}
      description={t('接続や保存先を確認して、もう一度読み込んでください。', 'Check the connection or storage location, then try again.')}>
      <p className="notice warning" role="alert">{error.message}</p>
      <Button busy={retrying || loading} onClick={() => {
        setRetrying(true);
        void report(refresh).finally(() => setRetrying(false));
      }}>{t('再試行', 'Try again')}</Button>
    </EmptyState> : <div className="page-loading" role="status"><MotionSpinner size={22} />{t('復習を読み込んでいます…', 'Loading your review…')}</div>}
  </div>;
  return (
    <div className="review-page" ref={page}>
      <div className="review-page-header">
        <Link to="/" className="back-link">
          <ArrowLeft size={15} />
          {t('作品に戻る', 'Back to watching')}
        </Link>
        <span className="review-counter" aria-live="polite">
          <AnimatedValue value={t(`${reviewed.length} / ${total} 件`, `${reviewed.length} of ${total} reviewed`)} />
        </span>
      </div>
      <header className="review-title">
        <h1>{t('復習', 'Review')}</h1>
        <p>
          {t(
            '音声と文脈を手がかりに、保存した表現を思い出す。',
            'Use the audio and context to recall your saved phrases.',
          )}
        </p>
      </header>
      <div className="session-progress">
        <m.span initial={false} style={{ width: '100%', transformOrigin: 'left' }}
          animate={{ scaleX: total ? reviewed.length / total : 0 }}
          transition={{ duration: motionActive ? motionDurations.progressFollow : 0, ease: motionEase }}
        />
      </div>
      <div className="review-session">
        <ReviewTransition card={card} stateKey={cardKey}>
          {card ? (
            <ReviewCard
              key={revision(card)}
              card={card}
              onRated={restoreFocus => { focusNext.current = restoreFocus; setReviewed((items) => [...items, revision(card)]); }}
            />
          ) : (
        <div className="review-complete">
          <div className="review-complete-icon">
            <Check size={28} strokeWidth={1.7} />
          </div>
          <h2 tabIndex={-1} data-review-focus>
            {reviewed.length
              ? t(
                  '今回の復習が終わりました',
                  'Review complete',
                )
              : t('いま復習する表現はありません', 'No phrases are due right now')}
          </h2>
          <p>
            {reviewed.length
              ? t(
                  `${reviewed.length} 回復習しました。次の復習時刻になると、ここに表示されます。`,
                  `You completed ${reviewed.length} reviews. Your phrases will return when they are due.`,
                )
              : t(
                  '作品の続きを観るか、フレーズ帳で保存した表現を確認できます。',
                  'Continue watching or browse the phrases you have saved.',
                )}
          </p>
          <div className="review-complete-actions">
            <MotionLink to="/" className="button primary">
              {t('作品に戻る', 'Back to watching')}
            </MotionLink>
            <MotionLink to="/cards" className="button secondary">
              {t('フレーズ帳を開く', 'Open phrases')}
            </MotionLink>
          </div>
        </div>
          )}
        </ReviewTransition>
      </div>
    </div>
  );
}
