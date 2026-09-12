// SPDX-License-Identifier: GPL-3.0-or-later
import { Link, Outlet } from '@tanstack/react-router';
import { ArrowUpRight, BookOpen, Check, CircleHelp, HardDrive, Layers3, LibraryBig, Moon, RefreshCw, Settings2, ShieldCheck, Sun } from 'lucide-react';
import { useApp } from './context';
import { nativeAvailable } from './api';
import { dueCards, money } from './utils';
import { IconButton } from './components/ui';
import { version } from '../package.json';

export function AppShell() {
  const { data, error, t, theme, toggleTheme, locale, setLocale, refresh } = useApp();
  const due = data ? dueCards(data.cards).length : null;
  const running = data?.jobs.filter(job => job.status === 'running' || job.status === 'queued') || [];
  return <div className="app-shell">
    <aside className="sidebar">
      <Link to="/" className="brand" aria-label="Surtitle home"><span className="brand-mark"><span /><span /><span /></span><span>surtitle<span className="brand-period">.</span></span></Link>
      <div className="workspace-label"><span className="status-dot" />{t('パーソナルスペース', 'PERSONAL SPACE')}</div>
      <nav aria-label={t('メインナビゲーション', 'Main navigation')} className="main-nav">
        <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: 'active' }}><LibraryBig size={19} /><span>{t('ライブラリ', 'Library')}</span>{data && <span className="nav-count">{data.media.length}</span>}</Link>
        <Link to="/cards" activeProps={{ className: 'active' }}><Layers3 size={19} /><span>{t('マイフレーズ', 'My phrases')}</span></Link>
        <Link to="/review" activeProps={{ className: 'active' }}><BookOpen size={19} /><span>{t('今日の復習', 'Review')}</span>{due !== null && due > 0 && <span className="nav-count accent-count">{due}</span>}</Link>
      </nav>
      <div className="sidebar-note"><span className="eyebrow">A LITTLE, EVERY DAY.</span><p>{t('好きなコンテンツが、\n自分の言葉になる。', 'Turn the things you love\ninto words you own.')}</p><div className="note-lines"><span /><span /><span /><span /><span /><span /><span /></div></div>
      <div className="sidebar-bottom">
        <Link className="settings-link" to="/settings" activeProps={{ className: 'active' }}><Settings2 size={19} /><span>{t('設定とツール', 'Settings & tools')}</span></Link>
        <div className="budget-mini"><div><ShieldCheck size={15} /><span>{t('今月の AI 算定額', "This month's calculated AI usage")}</span></div><strong>{data ? money(data.budget.spentUsd) : '—'}<small> / {data ? money(data.budget.limitUsd) : '—'}</small></strong><p>{data?.budget.monetaryTotalsComplete === false ? t('料金未算定の要求が別にあります。請求総額ではありません。', 'Unpriced requests are excluded. This is not your total bill.') : t('実行する範囲と予約額を、そのつど確認。', 'Every paid job needs your approval.')}</p></div>
        <div className="local-status"><HardDrive size={13} /><span>{t('学習データはこのデバイスに保存', 'Learning stays on this device')}</span></div>
      </div>
    </aside>
    <div className="app-main">
      <header className="topbar"><div className="topbar-label"><span className="mini-mark">S</span><span>{t('学びのある時間を。', 'Make time meaningful.')}</span></div><div className="topbar-actions">{running.length > 0 && <span className="running-label"><RefreshCw size={13} className="spin" />{t(`${running.length} 件を処理中`, `${running.length} running`)}</span>}<button className="locale-button" onClick={() => setLocale(locale === 'ja' ? 'en' : 'ja')} aria-label={t('Switch to English', '日本語に切り替える')}>{locale === 'ja' ? 'EN' : '日本語'}</button><span className="topbar-divider" /><IconButton label={t('テーマを切り替える', 'Toggle theme')} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</IconButton><Link to="/settings" className="avatar" aria-label={t('設定を開く', 'Open settings')}>S</Link></div></header>
      {!nativeAvailable() && <div className="preview-banner"><CircleHelp size={15} /><span>{t('ブラウザーで UI をプレビュー中です。動画の読み込み・AI・保存はデスクトップアプリで利用できます。', 'Browser UI preview. Import, AI, and persistence are available in the desktop app.')}</span></div>}
      {error && <div className="error-banner" role="alert"><span>{error.message}</span><button onClick={() => void refresh()}>{t('再試行', 'Retry')}<RefreshCw size={14} /></button></div>}
      <main className="page-content"><Outlet /></main>
      <footer className="app-footer"><span><Check size={12} />{t('あなたのペースで、一つずつ。', 'One phrase at a time. At your own pace.')}</span><Link to="/settings">Surtitle {version} <ArrowUpRight size={12} /></Link></footer>
    </div>
  </div>;
}

