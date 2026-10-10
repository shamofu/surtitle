// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeft,
  AudioLines,
  BookOpen,
  Check,
  Eye,
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
import { Badge, Button } from '../../shared/ui/index';

export type Rating = 'again' | 'hard' | 'good' | 'easy';

export function ReviewCard({
  card,
  onRated,
}: {
  card: StudyCard;
  onRated: () => void;
}) {
  const { mutate } = useDataActions();
  const { data } = useSnapshot();
  const { t, locale } = useAppearance();
  const { report } = useNotifications();
  const { surfaceHidden } = useSurface();
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
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
    if (!revealed || busy) return;
    setBusy(true);
    const result = await report(async () => {
      await mutate(() => cardsApi.rateCard(card.id, rating), {
        kind: 'snapshot',
      });
      return true;
    });
    if (result) onRated();
    setBusy(false);
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (surfaceHidden || busy || event.repeat || shouldIgnoreShortcut(event)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        setRevealed(true);
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
      <article className={`review-card ${revealed ? 'revealed' : ''}`}>
        <div className="review-card-top">
          <Badge>{languageName(card.language, locale)}</Badge>
          <span className="review-question">
            {t('この表現の意味を思い出す', 'Recall the meaning of this phrase')}
          </span>
        </div>
        <div className="review-prompt">
          <h2>{card.term}</h2>
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
        {revealed ? (
          <div className="review-answer">
            <span className="review-answer-label">{t('意味', 'Meaning')}</span>
            <p>{card.meaning}</p>
            {card.translation && (
              <p className="review-translation">{card.translation}</p>
            )}
            {card.explanation && (
              <p className="review-explanation">{card.explanation}</p>
            )}
          </div>
        ) : (
          <div className="review-answer concealed">
            <Button variant="primary" onClick={() => setRevealed(true)}>
              <Eye size={17} />
              {t('意味を確認する', 'Reveal meaning')}
              <kbd>Space</kbd>
            </Button>
          </div>
        )}
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
            {t(`${card.reviewCount} 回の復習`, `${card.reviewCount} reviews`)}
          </span>
        </footer>
      </article>
      <div className={`rating-area ${revealed ? '' : 'waiting'}`}>
        <p>
          {revealed
            ? t('どれくらい思い出せましたか？', 'How well did you remember?')
            : t(
                'まずは自分の言葉で意味を思い浮かべて。',
                'Take a moment to recall the meaning in your own words.',
              )}
        </p>
        <div className="rating-buttons">
          {choices.map((choice, index) => (
            <button
              key={choice.id}
              className={`rating-button ${choice.id}`}
              disabled={!revealed || busy}
              onClick={() => void rate(choice.id)}
            >
              <span className="rating-key">{index + 1}</span>
              <strong>{choice.title}</strong>
              <small>{choice.detail}</small>
            </button>
          ))}
        </div>
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

export function ReviewPage() {
  const { data } = useSnapshot();
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
  return (
    <div className="review-page page-enter">
      <div className="review-page-header">
        <Link to="/" className="back-link">
          <ArrowLeft size={15} />
          {t('作品に戻る', 'Back to watching')}
        </Link>
        <span className="review-counter" aria-live="polite">
          {t(`${reviewed.length} / ${total} 件`, `${reviewed.length} of ${total} reviewed`)}
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
        <span
          style={{ width: `${total ? (reviewed.length / total) * 100 : 0}%` }}
        />
      </div>
      {card ? (
        <ReviewCard
          key={revision(card)}
          card={card}
          onRated={() => setReviewed((items) => [...items, revision(card)])}
        />
      ) : (
        <div className="review-complete">
          <div className="review-complete-icon">
            <Check size={28} strokeWidth={1.7} />
          </div>
          <h2>
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
            <Link to="/" className="button primary">
              {t('作品に戻る', 'Back to watching')}
            </Link>
            <Link to="/cards" className="button secondary">
              {t('フレーズ帳を開く', 'Open phrases')}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
