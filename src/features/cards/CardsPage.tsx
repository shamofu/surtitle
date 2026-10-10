// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  ChevronRight,
  Layers3,
  MoreHorizontal,
  Search,
  Volume2,
  X,
} from 'lucide-react';
import { cardsApi } from './api';
import { playerApi } from '../study/playback/api';
import type { StudyCard } from '../../shared/contracts/cards';
import {
  useDataActions,
  useSnapshot,
  useAppearance,
  useNotifications,
} from '../../app/runtime';
import { dueCards, languageName } from '../../shared/format';
import {
  Badge,
  Button,
  EmptyState,
  PageTitle,
  IconButton,
} from '../../shared/ui/index';
import { TransferDialog } from '../transfer/TransferDialog';
import { EditCardDialog, DeleteCardDialog } from './CardManagement';
import { AnimatedDetails } from '../../shared/ui/AnimatedDetails';
import { AnimatedValue, MotionRegion, MotionSwap } from '../../shared/motion';

function closePhraseMenu(element: HTMLElement, restoreFocus = true) {
  const menu = element.closest('details');
  if (!menu) return;
  if (restoreFocus) menu.querySelector('summary')?.focus({ preventScroll: true });
}

export function CardsPage() {
  const { mutate, refresh } = useDataActions();
  const { data, loading, error } = useSnapshot();
  const { t, locale } = useAppearance();
  const { report } = useNotifications();
  const [search, setSearch] = useState('');
  const [language, setLanguage] = useState('all');
  const [transfer, setTransfer] = useState(false);
  const [edit, setEdit] = useState<StudyCard>();
  const [deleting, setDeleting] = useState<StudyCard>();
  const [busyCard, setBusyCard] = useState<string>();
  const [openMenu, setOpenMenu] = useState<string>();
  const activeMenu = useRef<HTMLDetailsElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !activeMenu.current?.contains(event.target)) {
        setOpenMenu(undefined);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [openMenu]);
  function closeMenu(element: HTMLElement) {
    setOpenMenu(undefined);
    closePhraseMenu(element);
  }
  async function suspend(card: StudyCard) {
    setBusyCard(card.id);
    await report(() =>
      mutate(() => cardsApi.suspendCard(card.id, !card.suspended), {
        kind: 'snapshot',
      }),
    );
    setBusyCard(undefined);
  }
  const cards = data?.cards || [];
  const languages = [...new Set(cards.map((card) => card.language))];
  const filtered = cards.filter(
    (card) =>
      (language === 'all' || card.language === language) &&
      `${card.term} ${card.meaning} ${card.example}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  const due = dueCards(cards);
  return (
    <div className="phrases-page page-enter">
      <PageTitle
        title={t('フレーズ帳', 'Phrases')}
        description={t(
          '作品で出会った表現を、音声と文脈から振り返る。',
          'Return to the phrases you saved, with their original audio and context.',
        )}
      >
        <Button onClick={() => setTransfer(true)}>
          <ArrowDownToLine size={16} />
          {t('書き出す', 'Export')}
        </Button>
        <Link to="/review" className="button primary">
          <BookOpen size={17} />
          {t('復習する', 'Start review')}
          <MotionRegion open={due.length > 0} as="span"><span className="button-count"><AnimatedValue value={due.length} /></span></MotionRegion>
        </Link>
      </PageTitle>
      <div className="library-toolbar">
        <div className="section-heading">
          <h2>{t('保存した表現', 'Saved phrases')}</h2>
          <span className="count-pill"><AnimatedValue value={filtered.length} /></span>
        </div>
        <div className="library-tools">
          <select
            className="compact-select"
            aria-label={t('学習言語で絞り込む', 'Filter by learning language')}
            value={language}
            onChange={(event) => { setLanguage(event.target.value); setOpenMenu(undefined); }}
          >
            <option value="all">{t('すべての言語', 'All languages')}</option>
            {languages.map((code) => (
              <option key={code} value={code}>
                {languageName(code, locale)}
              </option>
            ))}
          </select>
          <div className="search-box">
            <Search size={16} />
            <input
              ref={searchInput}
              value={search}
              onChange={(event) => { setSearch(event.target.value); setOpenMenu(undefined); }}
              placeholder={t('フレーズを検索', 'Search your phrases')}
              aria-label={t('フレーズを検索', 'Search your phrases')}
            />
            <MotionRegion open={!!search} as="span"><IconButton label={t('検索をクリア', 'Clear search')} onClick={() => {
              setSearch(''); searchInput.current?.focus();
            }}><X size={15} /></IconButton></MotionRegion>
          </div>
        </div>
      </div>
      <MotionSwap stateKey={!data && loading ? 'loading' : !data && error ? 'error' : `${language}:${filtered.map(card => card.id).join('|')}`}>
      {!data && loading ? <p role="status">{t('フレーズを読み込み中…', 'Loading your phrases…')}</p>
      : !data && error ? <div className="notice warning" role="alert">
        <span>{t('フレーズを読み込めませんでした。', 'Could not load your phrases.')} {error.message}</span>
        <Button onClick={() => void report(() => refresh())}>{t('再試行', 'Retry')}</Button>
      </div>
      : !filtered.length ? (
        <div className="library-empty">
          <EmptyState
            icon={<Layers3 size={33} strokeWidth={1.4} />}
            title={
              cards.length
                ? t('一致するフレーズはありません', 'No matching phrases')
                : t(
                    '保存したフレーズはまだありません',
                    'No saved phrases yet',
                  )
            }
            description={cards.length
              ? t('検索語や言語の絞り込みを変えてください。', 'Try another search or language filter.')
              : t(
                  '作品を観ながら気になる表現を保存すると、ここで原音を聴き直せます。',
                  'Save a phrase while watching, then listen to its original audio here.',
                )}
          >
            {cards.length ? <Button variant="primary" onClick={() => {
              setSearch(''); setLanguage('all'); searchInput.current?.focus();
            }}>{t('絞り込みをリセット', 'Reset filters')}</Button> : <Link to="/" className="button primary">
              {t('作品を選ぶ', 'Choose something to watch')}
              <ArrowRight size={16} />
            </Link>}
          </EmptyState>
        </div>
      ) : (
        <div className="phrase-list">
          {filtered.map((card) => {
            const media = data?.media.find((item) => item.id === card.mediaId);
            const isDue = due.some((item) => item.id === card.id);
            return (
              <article className="phrase-card" key={card.id}>
                <header>
                  <h3><MotionSwap as="span" stateKey={card.term}>{card.term}</MotionSwap></h3>
                  <div className="phrase-controls">
                    <Button
                      variant="ghost"
                      disabled={!card.audioPath}
                      aria-label={t(`${card.term}の原音を聴く`, `Listen to ${card.term}`)}
                      onClick={() =>
                        void report(() => playerApi.playCardAudio(card.id))
                      }
                    >
                      <Volume2 size={18} />
                      {t('原音を聴く', 'Listen')}
                    </Button>
                    <AnimatedDetails
                      className="phrase-options"
                      open={openMenu === card.id}
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget)) setOpenMenu(undefined);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape' || !event.currentTarget.open) return;
                        event.preventDefault();
                        event.stopPropagation();
                        closeMenu(event.currentTarget);
                      }}
                    >
                      <summary aria-label={t(`${card.term}の操作`, `Actions for ${card.term}`)} onClick={(event) => {
                        event.preventDefault();
                        activeMenu.current = event.currentTarget.closest('details');
                        setOpenMenu(current => current === card.id ? undefined : card.id);
                      }}>
                        <MoreHorizontal size={20} />
                      </summary>
                      <div className="phrase-options-panel">
                        <Button onClick={(event) => {
                          closeMenu(event.currentTarget);
                          setEdit(card);
                        }}>
                          {t('編集', 'Edit')}
                        </Button>
                        <Button
                          busy={busyCard === card.id}
                          onClick={(event) => { closeMenu(event.currentTarget); void suspend(card); }}
                        >
                          {card.suspended
                            ? t('復習を再開', 'Resume reviews')
                            : t('復習を停止', 'Suspend reviews')}
                        </Button>
                        <Button variant="danger" onClick={(event) => {
                          closeMenu(event.currentTarget);
                          setDeleting(card);
                        }}>
                          {t('削除', 'Delete')}
                        </Button>
                      </div>
                    </AnimatedDetails>
                  </div>
                </header>
                <p className="phrase-meaning"><MotionSwap as="span" stateKey={card.meaning}>{card.meaning}</MotionSwap></p>
                <blockquote><MotionSwap as="span" stateKey={card.example}>{card.example}</MotionSwap></blockquote>
                <footer>
                  {media ? (
                    <Link
                      to="/study/$mediaId"
                      params={{ mediaId: card.mediaId }}
                    >
                      <BookOpen size={15} />
                      <span>{media.title}</span>
                      <ChevronRight size={15} />
                    </Link>
                  ) : (
                    <span>
                      {card.sourceTitle ||
                        t('除外した教材の文脈', 'Context from removed media')}
                    </span>
                  )}
                  <MotionSwap as="span" stateKey={`${card.suspended}:${isDue}:${card.language}`}><Badge tone={isDue ? 'accent' : 'neutral'}>
                    {card.suspended
                      ? t('復習を停止中', 'Reviews suspended')
                      : isDue
                        ? t('復習の時間', 'Ready to review')
                        : languageName(card.language, locale)}
                  </Badge></MotionSwap>
                </footer>
              </article>
            );
          })}
        </div>
      )}
      </MotionSwap>
      {transfer && <TransferDialog onClose={() => setTransfer(false)} />}
      {edit && (
        <EditCardDialog card={edit} onClose={() => setEdit(undefined)} />
      )}
      {deleting && (
        <DeleteCardDialog
          card={deleting}
          onClose={() => setDeleting(undefined)}
        />
      )}
    </div>
  );
}
