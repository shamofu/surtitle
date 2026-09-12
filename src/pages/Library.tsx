// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Check, Clock3, FileVideo2, FolderOpen, Headphones, Layers3, Link2, Play, Plus, Search, Sparkles, Upload, X } from 'lucide-react';
import { api } from '../api';
import type { Media } from '../api';
import { useApp } from '../context';
import { dueCards, languageName, timestamp } from '../utils';
import { Badge, Button, EmptyState, Field, Modal, PageTitle } from '../components/ui';
import { TransferDialog } from '../components/TransferDialog';
import { DownloadJobs } from '../components/MediaManagement';

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { t, data, run } = useApp();
  const [mode, setMode] = useState<'local' | 'url'>('local');
  const [paths, setPaths] = useState<string[]>([]);
  const [url, setUrl] = useState('');
  const [learningLanguage, setLearningLanguage] = useState(data?.settings.learningLanguage || 'en');
  const [explanationLanguage, setExplanationLanguage] = useState(data?.settings.explanationLanguage || 'ja');
  const [busy, setBusy] = useState(false);
  const validUrl = (() => { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } })();
  async function selectFiles() { const selected = await run(api.selectMediaFiles); if (selected?.length) setPaths(selected); }
  async function submit() {
    setBusy(true);
    const success = await run(async () => {
      if (mode === 'url') await api.startUrlImport({ kind: 'url', pathOrUrl: url.trim(), learningLanguage, explanationLanguage });
      else for (const pathOrUrl of paths) await api.importMedia({ kind: 'local', pathOrUrl, learningLanguage, explanationLanguage });
      return true;
    }, mode === 'url' ? t('ダウンロードを開始しました。ライブラリで進捗を確認できます。', 'Download started. Follow its progress in the library.') : t('ライブラリに追加しました。', 'Added to your library.'));
    setBusy(false);
    if (success) onClose();
  }
  return <Modal title={t('新しい学びを追加', 'Add something worth learning')} eyebrow="BRING WHAT YOU LOVE" onClose={() => { if (!busy) onClose(); }}>
    <div className="segmented-control"><button className={mode === 'local' ? 'selected' : ''} onClick={() => setMode('local')}><FolderOpen size={16} />{t('ファイル', 'Local file')}</button><button className={mode === 'url' ? 'selected' : ''} onClick={() => setMode('url')}><Link2 size={16} />URL</button></div>
    {mode === 'local' ? <button className={`import-drop ${paths.length ? 'has-files' : ''}`} onClick={() => void selectFiles()} disabled={busy}><div className="drop-icon"><Upload size={26} strokeWidth={1.5} /></div><strong>{paths.length ? t(`${paths.length} 件のファイルを選択中`, `${paths.length} file${paths.length > 1 ? 's' : ''} selected`) : t('動画・音声ファイルを選択', 'Choose a video or audio file')}</strong><span>{paths.length ? paths.map(path => path.split(/[\\/]/).pop()).join(' · ') : t('映画、ポッドキャスト、講義。好きなものから始めましょう。', 'A film, a podcast, a lecture. Start with what you love.')}</span><small>MP4 · MKV · MOV · WEBM · MP3 · WAV · FLAC</small></button> : <div className="url-import"><Field label={t('動画・音声の URL', 'Video or audio URL')} hint={t('公開 YouTube 動画、またはメディアファイルへの直接リンク。プレイリスト・ライブには対応しません。', 'A public YouTube video or direct media link. Playlists and live streams are not supported.')}><input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" type="url" autoFocus /></Field><p className="notice"><ArrowDownToLine size={16} />{t('ダウンロード完了後に再生できます。', 'Playback starts after the complete download.')}</p></div>}
    <div className="field-row"><Field label={t('学習する言語', 'Learning language')}><input value={learningLanguage} onChange={event => setLearningLanguage(event.target.value)} placeholder="en, fr, ko…" list="language-codes" /></Field><Field label={t('説明・翻訳の言語', 'Explanation language')}><input value={explanationLanguage} onChange={event => setExplanationLanguage(event.target.value)} placeholder="ja, en…" list="language-codes" /></Field></div>
    <datalist id="language-codes"><option value="en">English</option><option value="ja">日本語</option><option value="es">Español</option><option value="fr">Français</option><option value="de">Deutsch</option><option value="ko">한국어</option><option value="zh">中文</option></datalist>
    <p className="helper-text"><Sparkles size={13} />{t('追加だけでは AI を実行しません。使う範囲と金額を後から選べます。', 'Import does not run AI. Choose its scope and cost when you need it.')}</p>
    <footer className="modal-footer"><Button onClick={onClose} disabled={busy}>{t('キャンセル', 'Cancel')}</Button><Button variant="primary" busy={busy} onClick={() => void submit()} disabled={!learningLanguage.trim() || !explanationLanguage.trim() || (mode === 'local' ? !paths.length : !validUrl)}><Plus size={16} />{t('ライブラリに追加', 'Add to library')}</Button></footer>
  </Modal>;
}
function MediaCard({ media, index }: { media: Media; index: number }) {
  const { t, locale } = useApp();
  const progress = media.durationMs ? Math.min(100, media.lastPositionMs / media.durationMs * 100) : 0;
  return <Link to="/study/$mediaId" params={{ mediaId: media.id }} className="media-card">
    <div className={`media-art art-${index % 4}`}><div className="media-art-lines" /><span className="media-kind">{media.kind === 'audio' ? <Headphones size={14} /> : <FileVideo2 size={14} />}{media.sourceUrl ? 'ONLINE' : 'LOCAL'}</span><div className="media-art-letter">{media.title.charAt(0).toUpperCase()}</div><span className="media-play"><Play size={21} fill="currentColor" /></span><span className="media-duration">{media.durationMs ? timestamp(media.durationMs) : '—:—'}</span>{progress > 0 && <div className="media-progress"><span style={{ width: `${progress}%` }} /></div>}</div>
    <div className="media-info"><div className="media-card-meta"><span>{languageName(media.learningLanguage, locale)}</span><span>·</span><span>{media.segmentCount ? t('字幕あり', 'Subtitled') : t('字幕を追加できます', 'Add subtitles')}</span></div><h3>{media.title}</h3><div className="media-card-bottom"><span><Layers3 size={13} />{t(`${media.cardCount} フレーズ`, `${media.cardCount} phrases`)}</span>{media.status === 'missing' || media.status === 'error' ? <Badge tone="warning">{t('要確認', 'Needs attention')}</Badge> : <span className="card-arrow"><ArrowRight size={17} /></span>}</div></div>
  </Link>;
}
export function LibraryPage() {
  const { data, t, loading } = useApp();
  const [importOpen, setImportOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const media = data?.media || [];
  const filtered = media.filter(item => (filter === 'all' || item.kind === filter) && item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const due = data ? dueCards(data.cards) : [];
  const continuing = media.find(item => item.lastPositionMs > 0 && item.status === 'ready');
  return <div className="library-page page-enter">
    <PageTitle eyebrow="YOUR LEARNING LIBRARY" title={t('好きな世界から、学ぼう。', 'Learn from what moves you.')} description={t('ひとつの動画、ひとつのフレーズ。言葉との新しい出会いを。', 'One video. One phrase. A new way to make a language your own.')}><Button onClick={() => setTransferOpen(true)}><ArrowDownToLine size={16} />{t('データ管理', 'Your data')}</Button><Button variant="primary" onClick={() => setImportOpen(true)}><Plus size={18} />{t('コンテンツを追加', 'Add content')}</Button></PageTitle>
    <DownloadJobs />
    <div className="library-overview">
      <section className="welcome-panel"><div className="welcome-content"><span className="eyebrow">{continuing ? 'PICK UP WHERE YOU LEFT OFF' : 'A WORLD OF WORDS AWAITS'}</span><h2>{continuing ? continuing.title : t('いつもの「観る」を、\nもっと自分のものに。', 'Go beyond watching.\nMake every word yours.')}</h2><p>{continuing ? t(`${timestamp(continuing.lastPositionMs)} から、前回の続きを。`, `Continue from ${timestamp(continuing.lastPositionMs)}.`) : t('気になった表現を見つけて、聴いて、覚える。\nあなたのための、小さな語学スタジオ。', 'Notice a phrase. Hear it in context. Make it stick.\nYour own little language studio.')}</p>{continuing ? <Link className="button primary" to="/study/$mediaId" params={{ mediaId: continuing.id }}><Play size={15} fill="currentColor" />{t('続きを学ぶ', 'Continue learning')}</Link> : <Button variant="primary" onClick={() => setImportOpen(true)}><Play size={15} />{t('最初のコンテンツを追加', 'Add your first content')}</Button>}</div><div className="welcome-illustration" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="floating-caption caption-one"><span className="caption-dot" /><i /><i /></div><div className="floating-play"><Play size={35} fill="currentColor" strokeWidth={1.3} /></div><div className="floating-caption caption-two"><span>Aa</span><div><i /><i /></div><Check size={17} /></div><div className="sparkle-dot one" /><div className="sparkle-dot two" /></div></section>
      <Link to="/review" className="review-overview"><div className="overview-top"><span className="eyebrow">DAILY PRACTICE</span><BookOpen size={19} /></div><div><strong>{data ? due.length : '—'}<span>{t('フレーズ', 'phrases')}</span></strong><h3>{t('今日の復習', 'Ready to revisit')}</h3><p>{due.length ? t('忘れる前に、もう一度。\n少しの時間が、確かな記憶に。', 'A little practice, right on time.\nHelp your words find a home.') : t('保存したフレーズを、\nちょうどよいタイミングで。', 'Your saved phrases,\nat just the right moment.')}</p></div><div className="review-overview-bottom"><span>{t('復習を開く', 'Open review')}</span><span className="round-arrow"><ArrowUpRight size={18} /></span></div></Link>
    </div>
    <div className="library-toolbar"><div className="section-heading"><h2>{t('マイライブラリ', 'My library')}</h2><span className="count-pill">{data ? media.length : '—'}</span></div><div className="library-tools"><div className="filter-tabs" aria-label={t('コンテンツの種類', 'Content type')}>{[['all', t('すべて', 'All')], ['video', t('動画', 'Video')], ['audio', t('音声', 'Audio')]].map(([key, label]) => <button key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div><div className="search-box"><Search size={16} /><input placeholder={t('ライブラリを検索', 'Search your library')} value={search} onChange={event => setSearch(event.target.value)} aria-label={t('ライブラリを検索', 'Search your library')} />{search && <button aria-label={t('検索をクリア', 'Clear search')} onClick={() => setSearch('')}><X size={14} /></button>}</div></div></div>
    {loading ? <div className="media-grid" aria-label={t('読み込み中', 'Loading')}>{[0, 1, 2].map(item => <div className="skeleton media-skeleton" key={item} />)}</div> : filtered.length ? <div className="media-grid">{filtered.map((item, index) => <MediaCard key={item.id} media={item} index={index} />)}</div> : <div className="library-empty"><EmptyState icon={<LibraryIllustration />} title={search || filter !== 'all' ? t('コンテンツが見つかりません', 'No matching content') : t('あなただけのライブラリをつくろう', 'Build a library that feels like you')} description={search || filter !== 'all' ? t('検索条件を変えて、もう一度お試しください。', 'Try another search or filter.') : t('好きな動画や音声を追加すると、ここに並びます。字幕がある教材なら、すぐに学習を始められます。', 'Add your favourite videos or audio. Bring subtitles and you can start learning right away.')}><Button onClick={() => search || filter !== 'all' ? (setSearch(''), setFilter('all')) : setImportOpen(true)}>{search || filter !== 'all' ? t('条件をリセット', 'Reset filters') : <><Plus size={16} />{t('コンテンツを追加', 'Add content')}</>}</Button></EmptyState></div>}
    <div className="library-footnotes"><span><Clock3 size={14} />{t('長い動画も、そのまま。学びたい区間を選べます。', 'Long videos welcome. Choose the moments you want to learn.')}</span><span><Layers3 size={14} />{t('字幕から、あなただけのフレーズ帳へ。', 'From subtitles to your own phrase collection.')}</span></div>
    {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}{transferOpen && <TransferDialog onClose={() => setTransferOpen(false)} />}
  </div>;
}
function LibraryIllustration() { return <svg width="47" height="43" viewBox="0 0 47 43" fill="none"><rect x="6" y="7" width="29" height="29" rx="5" stroke="currentColor" strokeWidth="1.3" opacity=".4" transform="rotate(-8 6 7)" /><rect x="12" y="9" width="29" height="29" rx="5" fill="var(--surface)" stroke="currentColor" strokeWidth="1.3" /><path d="m24 18 8 5-8 5z" fill="currentColor" opacity=".8" /></svg>; }
