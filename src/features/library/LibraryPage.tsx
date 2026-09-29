// SPDX-License-Identifier: GPL-3.0-or-later
import { ImportDialog } from './ImportDialog';
import type { DroppedMediaFiles } from './ImportDialog';
import { useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowDownToLine, FileVideo2, Headphones, Play, Plus, Search, Upload, X } from 'lucide-react';
import type { Media } from '../../shared/contracts/media';
import { useAppearance, useNotifications, useSnapshot } from '../../app/runtime';
import { nativeAvailable } from '../../shared/native/transport';
import { languageName, timestamp } from '../../shared/format';
import { Badge, Button, EmptyState, PageTitle } from '../../shared/ui/index';
import { TransferDialog } from '../transfer/TransferDialog';
import { DownloadJobs } from './MediaManagement';
import { useLibraryDrop } from './useLibraryDrop';

function MediaRow({ media }: { media: Media }) {
  const { t, locale } = useAppearance();
  const position = Math.max(0, media.lastPositionMs);
  const duration = media.durationMs > 0 ? media.durationMs : null;
  const status = {
    ready: null,
    importing: t('読み込み中', 'Importing'),
    missing: t('ファイルが見つかりません', 'File not found'),
    error: t('読み込みエラー', 'Import error'),
  }[media.status];
  return (
    <Link to="/study/$mediaId" params={{ mediaId: media.id }} className="media-card media-row">
      <div className="media-row-title">
        <span className="media-type-icon" aria-hidden="true">
          {media.kind === 'audio' ? <Headphones size={21} /> : <FileVideo2 size={21} />}
        </span>
        <div>
          <h3>{media.title}</h3>
          <p className="media-row-source">
            <span>{media.kind === 'audio' ? t('音声', 'Audio') : t('動画', 'Video')}</span>
            <span>{media.sourceUrl ? t('URL から追加', 'Imported from URL') : t('ローカルファイル', 'Local file')}</span>
            {status && <Badge tone={media.status === 'importing' ? 'neutral' : 'warning'}>{status}</Badge>}
          </p>
        </div>
      </div>
      <div className="media-row-language">
        <span className="media-mobile-label">{t('学習言語', 'Language')}</span>
        {languageName(media.learningLanguage, locale)}
      </div>
      <div className="media-row-subtitles">
        <span className="media-mobile-label">{t('字幕', 'Subtitles')}</span>
        {media.segmentCount > 0 ? t(`${media.segmentCount} 行`, `${media.segmentCount} lines`) : t('字幕なし', 'No subtitles')}
      </div>
      <div className="media-row-phrases">
        <span className="media-mobile-label">{t('フレーズ', 'Phrases')}</span>
        {t(`${media.cardCount} 件`, `${media.cardCount} saved`)}
      </div>
      <div className="media-row-position">
        <span className="media-mobile-label">{t('再生位置 / 長さ', 'Position / duration')}</span>
        <span>{timestamp(position)} <span className="muted">/ {duration ? timestamp(duration) : '—'}</span></span>
        {duration !== null && (
          <span className="media-progress" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (position / duration) * 100)}%` }} />
          </span>
        )}
      </div>
    </Link>
  );
}

export function LibraryPage() {
  const { data, loading } = useSnapshot();
  const { t, locale } = useAppearance();
  const { notify } = useNotifications();
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const importPending = useRef(false);
  const [droppedFiles, setDroppedFiles] = useState<DroppedMediaFiles>();
  const dropRevision = useRef(0);
  const [transferOpen, setTransferOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const dragging = useLibraryDrop({
    blocked: importBusy || transferOpen,
    // Inspect open dialogs at delivery time so a just-closed modal cannot
    // reject the next drop while its surface-count cleanup is settling.
    canDrop: () => !document.querySelector('dialog[open]:not(:has(.media-import))'),
    onDrop: paths => {
      if (importPending.current) return;
      importPending.current = true;
      setImportBusy(true);
      setDroppedFiles({ revision: ++dropRevision.current, paths });
      setImportOpen(true);
    },
    onError: error => notify(String(error), 'error'),
  });
  function closeImport() {
    setImportOpen(false);
    setImportBusy(false);
    importPending.current = false;
    setDroppedFiles(undefined);
  }
  const media = data?.media || [];
  const filtered = media.filter(
    (item) => (filter === 'all' || item.kind === filter) &&
      item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const continuing = media.filter(
    (item) => item.lastPositionMs > 0 && item.status === 'ready' &&
      (!item.durationMs || item.lastPositionMs < item.durationMs),
  ).slice(0, 3);
  const filtering = !!search || filter !== 'all';

  return (
    <div className="library-page" onDragOver={event => {
      if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
    }} onDrop={event => {
      if (!Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault();
      if (!nativeAvailable()) notify(t('この操作には Surtitle デスクトップアプリが必要です。', 'Open Surtitle desktop to use this feature.'), 'error');
    }}>
      <PageTitle title={t('ライブラリ', 'Library')} description={t('好きな作品を観ながら、気になる言葉を確かめる。', 'Watch something you enjoy. Take a closer look at the words that catch your attention.')}>
        <Button variant="ghost" onClick={() => setTransferOpen(true)}>
          <ArrowDownToLine size={17} />
          {t('データ管理', 'Your data')}
        </Button>
        <Button variant="primary" onClick={() => setImportOpen(true)}>
          <Plus size={18} />
          {t('動画・音声を追加する', 'Add video or audio')}
        </Button>
      </PageTitle>
      <p className="library-drop-hint"><Upload size={15} aria-hidden="true" />{t('動画・音声ファイルをここへドロップして追加できます。', 'Drop video or audio files here to add them.')}</p>
      {dragging && !importOpen && <div className="library-drop-overlay" role="status"><div><Upload size={34} aria-hidden="true" /><strong>{t('ドロップして教材を追加', 'Drop to add your materials')}</strong><p>{t('ファイルと言語を確認してから、ライブラリに追加します。', 'Review the files and languages before adding them to your library.')}</p></div></div>}
      <DownloadJobs />
      {continuing.length > 0 && (
        <section className="continue-section" aria-labelledby="continue-title">
          <h2 id="continue-title">{t('視聴途中', 'Continue watching')}</h2>
          <div className="continue-list">
            {continuing.map((item) => (
              <Link key={item.id} className="continue-row" to="/study/$mediaId" params={{ mediaId: item.id }}>
                <span className="continue-play" aria-hidden="true"><Play size={19} fill="currentColor" /></span>
                <div className="continue-copy">
                  <h3>{item.title}</h3>
                  <p>{languageName(item.learningLanguage, locale)}<span>{t(`${timestamp(item.lastPositionMs)} から再開`, `Resume at ${timestamp(item.lastPositionMs)}`)}</span></p>
                </div>
                <span className="continue-action">{item.kind === 'audio' ? t('続きを聴く', 'Continue listening') : t('続きを観る', 'Continue watching')}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
      <section aria-labelledby="library-list-title">
        <div className="library-toolbar">
          <div className="section-heading">
            <h2 id="library-list-title">{t('教材一覧', 'Your materials')}</h2>
            {data && <span className="count-pill">{media.length}</span>}
          </div>
          <div className="library-tools">
            <div className="filter-tabs" role="group" aria-label={t('コンテンツの種類', 'Content type')}>
              {[
                ['all', t('すべて', 'All')],
                ['video', t('動画', 'Video')],
                ['audio', t('音声', 'Audio')],
              ].map(([key, label]) => (
                <button key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
              ))}
            </div>
            <div className="search-box">
              <Search size={17} aria-hidden="true" />
              <input placeholder={t('タイトルで検索', 'Search titles')} value={search} onChange={(event) => setSearch(event.target.value)} aria-label={t('ライブラリを検索', 'Search your library')} />
              {search && <button aria-label={t('検索をクリア', 'Clear search')} onClick={() => setSearch('')}><X size={16} /></button>}
            </div>
          </div>
        </div>
        {loading ? (
          <div className="media-list" aria-label={t('読み込み中', 'Loading')} aria-busy="true">
            {[0, 1, 2].map((item) => <div className="skeleton media-skeleton" key={item} />)}
          </div>
        ) : filtered.length ? (
          <div className="media-list">
            <div className="media-list-head" aria-hidden="true">
              <span>{t('タイトル', 'Title')}</span>
              <span>{t('学習言語', 'Language')}</span>
              <span>{t('字幕', 'Subtitles')}</span>
              <span>{t('フレーズ', 'Phrases')}</span>
              <span>{t('再生位置 / 長さ', 'Position / duration')}</span>
            </div>
            {filtered.map((item) => <MediaRow key={item.id} media={item} />)}
          </div>
        ) : (
          <div className="library-empty">
            <EmptyState
              icon={<Headphones size={29} strokeWidth={1.6} aria-hidden="true" />}
              title={filtering ? t('教材が見つかりません', 'No matching materials') : t('最初の教材を追加する', 'Add your first material')}
              description={filtering ? t('タイトルや種類の条件を変えて検索してください。', 'Try another title or content type.') : t('好きな動画や音声を追加してください。字幕のある教材なら、原文を読みながらすぐに聴き始められます。', 'Add a video or audio recording. With subtitles, you can start listening and reading right away.')}
            >
              <Button variant={filtering ? 'secondary' : 'primary'} onClick={() => {
                if (filtering) { setSearch(''); setFilter('all'); }
                else setImportOpen(true);
              }}>
                {filtering ? t('条件をリセット', 'Reset filters') : <><Plus size={17} />{t('動画・音声を追加する', 'Add video or audio')}</>}
              </Button>
            </EmptyState>
          </div>
        )}
      </section>
      {importOpen && <ImportDialog droppedFiles={droppedFiles} dragging={dragging} onBusyChange={busy => {
        importPending.current = busy;
        setImportBusy(busy);
      }} onClose={closeImport} onReturnToLibrary={() => {
        setSearch('');
        setFilter('all');
        closeImport();
      }} />}
      {transferOpen && <TransferDialog onClose={() => setTransferOpen(false)} />}
    </div>
  );
}
