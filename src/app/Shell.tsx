// SPDX-License-Identifier: GPL-3.0-or-later
import { Link, Outlet } from '@tanstack/react-router';
import { BookOpen, CircleHelp, Layers3, LibraryBig, Moon, RefreshCw, Settings2, Sun } from 'lucide-react';
import { useSnapshot, useAppearance, useDataActions } from './runtime';
import { nativeAvailable } from '../shared/native/transport';
import { dueCards } from '../shared/format';
import { IconButton } from '../shared/ui/index';
import { NotificationRegion } from './providers/Notifications';

export function AppShell() {
  const { data, error } = useSnapshot();
  const { t, theme, toggleTheme, locale, setLocale } = useAppearance();
  const { refresh } = useDataActions();
  const due = data ? dueCards(data.cards).length : null;
  const running = data?.jobs.filter((job) => job.status === 'running' || job.status === 'queued') || [];
  return (
    <div className="app-shell">
      <div className="app-main">
        <header className="topbar">
          <Link to="/" className="brand" aria-label={t('Surtitle ホーム', 'Surtitle home')}>
            <img src="/surtitle.svg" alt="" width={28} height={28} />
            surtitle
          </Link>
          <nav aria-label={t('メインナビゲーション', 'Main navigation')} className="main-nav">
            <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: 'active', 'aria-current': 'page' }}>
              <LibraryBig size={18} aria-hidden="true" />
              <span>{t('ライブラリ', 'Library')}</span>
            </Link>
            <Link to="/cards" activeProps={{ className: 'active', 'aria-current': 'page' }}>
              <Layers3 size={18} aria-hidden="true" />
              <span>{t('フレーズ帳', 'Phrases')}</span>
            </Link>
            <Link to="/review" activeProps={{ className: 'active', 'aria-current': 'page' }}>
              <BookOpen size={18} aria-hidden="true" />
              <span>{t('復習', 'Review')}</span>
              {due !== null && due > 0 && <span className="nav-count">{due}</span>}
            </Link>
            <Link to="/settings" activeProps={{ className: 'active', 'aria-current': 'page' }}>
              <Settings2 size={18} aria-hidden="true" />
              <span>{t('設定', 'Settings')}</span>
            </Link>
          </nav>
          <div className="topbar-actions">
            {running.length > 0 && (
              <span className="running-label" role="status">
                <RefreshCw size={14} className="spin" aria-hidden="true" />
                {t(`${running.length} 件を処理中`, `${running.length} running`)}
              </span>
            )}
            <button className="locale-button" onClick={() => setLocale(locale === 'ja' ? 'en' : 'ja')} aria-label={t('Switch to English', '日本語に切り替える')}>
              {locale === 'ja' ? 'EN' : '日本語'}
            </button>
            <IconButton label={t('テーマを切り替える', 'Toggle theme')} onClick={toggleTheme}>
              {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
            </IconButton>
          </div>
        </header>
        {!nativeAvailable() && (
          <div className="preview-banner">
            <CircleHelp size={16} aria-hidden="true" />
            <span>{t('ブラウザーで UI をプレビュー中です。動画の読み込み・AI・保存はデスクトップアプリで利用できます。', 'Browser UI preview. Import, AI, and persistence are available in the desktop app.')}</span>
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error.message}</span>
            <button onClick={() => void refresh()}>{t('再試行', 'Retry')}<RefreshCw size={14} aria-hidden="true" /></button>
          </div>
        )}
        <NotificationRegion />
        <main className="page-content"><Outlet /></main>
      </div>
    </div>
  );
}
