// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowDownToLine, ArrowLeft, ArrowRight, AudioLines, BookOpen, Check, ChevronRight, Clock3, Eye, Layers3, Search, Sparkles, Volume2 } from 'lucide-react';
import { api } from '../api';
import type { StudyCard } from '../api';
import { useApp } from '../context';
import { dueCards, languageName } from '../utils';
import { Badge, Button, EmptyState, IconButton, PageTitle } from '../components/ui';
import { TransferDialog } from '../components/TransferDialog';
import { EditCardDialog, DeleteCardDialog } from '../components/CardManagement';

export function CardsPage() {
  const { data, t, locale, run } = useApp();
  const [search, setSearch] = useState('');
  const [language, setLanguage] = useState('all');
  const [transfer, setTransfer] = useState(false);
  const [edit, setEdit] = useState<StudyCard>();
  const [deleting, setDeleting] = useState<StudyCard>();
  const [busyCard, setBusyCard] = useState<string>();
  async function suspend(card: StudyCard) { setBusyCard(card.id); await run(() => api.suspendCard(card.id, !card.suspended)); setBusyCard(undefined); }
  const cards = data?.cards || [];
  const languages = [...new Set(cards.map(card => card.language))];
  const filtered = cards.filter(card => (language === 'all' || card.language === language) && `${card.term} ${card.meaning} ${card.example}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const due = dueCards(cards);
  return <div className="page-enter">
    <PageTitle eyebrow="WORDS YOU WANT TO KEEP" title={t('出会った言葉を、自分の言葉に。', 'Good words deserve a home.')} description={t('文脈と音声を添えた、あなただけのフレーズ帳。', 'Your own collection of phrases, with the context that makes them yours.')}><Button onClick={() => setTransfer(true)}><ArrowDownToLine size={16} />{t('書き出す', 'Export')}</Button><Link to="/review" className="button primary"><BookOpen size={17} />{t('復習する', 'Start review')}{due.length > 0 && <span className="button-count">{due.length}</span>}</Link></PageTitle>
    <div className="phrase-stats"><div><Layers3 size={19} /><span><strong>{data ? cards.length : '—'}</strong>{t('保存したフレーズ', 'saved phrases')}</span></div><div><Clock3 size={19} /><span><strong>{data ? due.length : '—'}</strong>{t('いま復習できる', 'ready to review')}</span></div><div><Sparkles size={19} /><span><strong>{data ? cards.reduce((sum, card) => sum + card.reviewCount, 0) : '—'}</strong>{t('積み重ねた復習', 'reviews completed')}</span></div></div>
    <div className="library-toolbar"><div className="section-heading"><h2>{t('マイフレーズ', 'My phrases')}</h2><span className="count-pill">{filtered.length}</span></div><div className="library-tools"><select className="compact-select" aria-label={t('学習言語で絞り込む', 'Filter by learning language')} value={language} onChange={event => setLanguage(event.target.value)}><option value="all">{t('すべての言語', 'All languages')}</option>{languages.map(code => <option key={code} value={code}>{languageName(code, locale)}</option>)}</select><div className="search-box"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('フレーズを検索', 'Search your phrases')} aria-label={t('フレーズを検索', 'Search your phrases')} /></div></div></div>
    {!filtered.length ? <div className="library-empty"><EmptyState icon={<Layers3 size={33} strokeWidth={1.4} />} title={cards.length ? t('一致するフレーズはありません', 'No matching phrases') : t('最初の「覚えておきたい」を見つけよう', 'Find your first keeper')} description={t('動画の字幕から気になる表現を保存すると、文脈と一緒にここに集まります。', 'Save a phrase from your subtitles and its original context will come with it.')}><Link to="/" className="button primary">{t('ライブラリへ', 'Explore your library')}<ArrowRight size={16} /></Link></EmptyState></div> : <div className="phrase-grid">{filtered.map(card => { const media = data?.media.find(item => item.id === card.mediaId); const isDue = due.some(item => item.id === card.id); return <article className="phrase-card" key={card.id}><header><Badge tone={isDue ? 'accent' : 'neutral'}>{card.suspended ? t('復習を停止中', 'Reviews suspended') : isDue ? t('復習の時間', 'Ready to review') : languageName(card.language, locale)}</Badge><IconButton label={t('元の音声を聴く', 'Listen to source audio')} disabled={!card.audioPath} onClick={() => void run(() => api.playCardAudio(card.id))}><Volume2 size={18} /></IconButton></header><h3>{card.term}</h3><p className="phrase-meaning">{card.meaning}</p><blockquote>{card.example}</blockquote><div className="card-management"><Button onClick={() => setEdit(card)}>{t('編集', 'Edit')}</Button><Button busy={busyCard === card.id} onClick={() => void suspend(card)}>{card.suspended ? t('復習を再開', 'Resume reviews') : t('復習を停止', 'Suspend reviews')}</Button><Button variant="danger" onClick={() => setDeleting(card)}>{t('削除', 'Delete')}</Button></div><footer>{media ? <Link to="/study/$mediaId" params={{ mediaId: card.mediaId }}><BookOpen size={13} /><span>{media.title}</span><ChevronRight size={13} /></Link> : <span>{card.sourceTitle || t('除外した教材の文脈', 'Context from removed media')}</span>}<span>{t(`${card.reviewCount} 回復習`, `${card.reviewCount} reviews`)}</span></footer></article>; })}</div>}
    {transfer && <TransferDialog onClose={() => setTransfer(false)} />}
    {edit && <EditCardDialog card={edit} onClose={() => setEdit(undefined)} />}
    {deleting && <DeleteCardDialog card={deleting} onClose={() => setDeleting(undefined)} />}
  </div>;
}

type Rating = 'again' | 'hard' | 'good' | 'easy';
function ReviewCard({ card, onRated }: { card: StudyCard; onRated: () => void }) {
  const { data, t, locale, run } = useApp();
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const media = data?.media.find(item => item.id === card.mediaId);
  const choices: { id: Rating; title: string; detail: string }[] = [
    { id: 'again', title: t('もう一度', 'Again'), detail: t('思い出せなかった', 'Could not recall') },
    { id: 'hard', title: t('難しい', 'Hard'), detail: t('少し迷った', 'Took some effort') },
    { id: 'good', title: t('覚えていた', 'Good'), detail: t('思い出せた', 'Recalled it') },
    { id: 'easy', title: t('簡単', 'Easy'), detail: t('すぐにわかった', 'Knew it instantly') },
  ];
  async function rate(rating: Rating) {
    if (!revealed || busy) return;
    setBusy(true);
    const result = await run(async () => { await api.rateCard(card.id, rating); return true; });
    if (result) onRated();
    setBusy(false);
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT'].includes(event.target.tagName)) return;
      if (event.code === 'Space') { event.preventDefault(); setRevealed(true); }
      const index = Number(event.key) - 1;
      if (revealed && index >= 0 && index < 4) { event.preventDefault(); void rate(choices[index].id); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [revealed, busy, card.id]);
  return <>
    <article className={`review-card ${revealed ? 'revealed' : ''}`}>
      <div className="review-card-top"><Badge>{languageName(card.language, locale)}</Badge><span className="eyebrow">{t('この表現の意味は？', 'DO YOU REMEMBER?')}</span><IconButton label={t('音声を再生', 'Play audio')} disabled={!card.audioPath} onClick={() => void run(() => api.playCardAudio(card.id))}><Volume2 size={20} /></IconButton></div>
      <div className="review-prompt"><h2>{card.term}</h2><p>{card.example}</p>{card.audioPath && <Button variant="ghost" onClick={() => void run(() => api.playCardAudio(card.id))}><AudioLines size={17} />{t('文脈を聴く', 'Listen in context')}</Button>}</div>
      {revealed ? <div className="review-answer"><span className="eyebrow">{t('意味', 'MEANING')}</span><p>{card.meaning}</p>{card.translation && <p className="review-translation">{card.translation}</p>}{card.explanation && <p className="review-explanation">{card.explanation}</p>}</div> : <div className="review-answer concealed"><Button variant="primary" onClick={() => setRevealed(true)}><Eye size={17} />{t('意味を確認する', 'Reveal meaning')}<kbd>Space</kbd></Button></div>}
      <footer><BookOpen size={14} /><span>{media?.title || t('保存した文脈', 'Saved context')}</span><span className="review-card-reps">{t(`${card.reviewCount} 回の復習`, `${card.reviewCount} reviews`)}</span></footer>
    </article>
    <div className={`rating-area ${revealed ? '' : 'waiting'}`}><p>{revealed ? t('どれくらい思い出せましたか？', 'How well did you remember?') : t('まずは自分の言葉で意味を思い浮かべて。', 'Take a moment to recall the meaning in your own words.')}</p><div className="rating-buttons">{choices.map((choice, index) => <button key={choice.id} className={`rating-button ${choice.id}`} disabled={!revealed || busy} onClick={() => void rate(choice.id)}><span className="rating-key">{index + 1}</span><strong>{choice.title}</strong><small>{choice.detail}</small></button>)}</div><small>{t('思い出しやすさに合わせて、次の復習時刻が調整されます。', 'Your next review is scheduled from how well you recalled this phrase.')}</small></div>
  </>;
}
export function ReviewPage() {
  const { data, t } = useApp();
  const [reviewed, setReviewed] = useState<string[]>([]);
  const [clock, setClock] = useState(Date.now);
  const revision = (card: StudyCard) => JSON.stringify([card.id, card.reviewCount, card.dueAt]);
  useEffect(() => {
    const now = Date.now();
    const next = (data?.cards || []).reduce((next, card) => {
      const due = new Date(card.dueAt).getTime();
      return !card.suspended && due > now ? Math.min(next, due) : next;
    }, Infinity);
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(next - now, 60_000));
    return () => window.clearTimeout(timer);
  }, [data?.cards, clock]);
  // Exclude only the already-rated schedule; Again may become due in this page.
  const due = dueCards(data?.cards || []).filter(card => !reviewed.includes(revision(card)));
  const card = due[0];
  const total = reviewed.length + due.length;
  return <div className="review-page page-enter"><div className="review-page-header"><Link to="/" className="back-link"><ArrowLeft size={15} />{t('ライブラリへ', 'Back to library')}</Link><span className="eyebrow">YOUR DAILY MOMENT</span><span className="review-counter">{reviewed.length} / {total}</span></div><header className="review-title"><h1>{t('言葉に、もう一度会う。', 'Meet your words again.')}</h1><p>{t('少しずつ、でも確かに。今日の一歩を。', 'Small moments. Lasting memories. Make a little progress today.')}</p></header><div className="session-progress"><span style={{ width: `${total ? reviewed.length / total * 100 : 0}%` }} /></div>{card ? <ReviewCard key={revision(card)} card={card} onRated={() => setReviewed(items => [...items, revision(card)])} /> : <div className="review-complete"><div className="complete-orbit"><Check size={42} strokeWidth={1.5} /></div><span className="eyebrow">A LITTLE, EVERY DAY.</span><h2>{reviewed.length ? t('今日の積み重ね、できました。', 'A little progress. Well earned.') : t('いまは、ひと休み。', 'A little room to breathe.')}</h2><p>{reviewed.length ? t(`${reviewed.length} 回復習しました。\n次のタイミングも、ここでお知らせします。`, `You completed ${reviewed.length} reviews.\nWe will have the next ones ready when it is time.`) : t('今すぐ復習するフレーズはありません。\nライブラリで、新しい表現に出会いましょう。', 'There are no phrases due right now.\nYour next discovery is waiting in your library.')}</p><Link to="/" className="button primary">{t('ライブラリへ戻る', 'Back to your library')}<ArrowRight size={16} /></Link></div>}</div>;
}

