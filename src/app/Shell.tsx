// SPDX-License-Identifier: GPL-3.0-or-later
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { BookOpen, CircleHelp, Layers3, LibraryBig, Moon, Settings2, Sun } from 'lucide-react';
import { useSnapshot, useAppearance } from './runtime';
import { nativeAvailable } from '../shared/native/transport';
import { dueCards } from '../shared/format';
import { IconButton, MotionButton } from '../shared/ui/index';
import { NotificationRegion } from './providers/Notifications';
import { ActivityButton } from './ActivityModal';
import { AnimatedValue, MotionSwap } from '../shared/motion';
import { SelectionIndicator } from '../shared/motion/SelectionIndicator';

import { usePageMotion } from './pageMotion';

export function AppShell() {
  const pathname = useRouterState({ select: state => state.location.pathname });
  const { direction, transition } = usePageMotion(pathname);
  const { data } = useSnapshot();
  const { t, theme, toggleTheme, locale, setLocale } = useAppearance();
  const due = data ? dueCards(data.cards).length : null;
  return (
    <div className="app-shell">
      <div className="app-main">
        <header className="topbar">
          <Link to="/" className="brand" aria-label={t('Surtitle ホーム', 'Surtitle home')}>
            <img src="/surtitle.svg" alt="" width={28} height={28} />
            surtitle
          </Link>
          <nav aria-label={t('メインナビゲーション', 'Main navigation')} className="main-nav">
            <SelectionIndicator thickness={3} />
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
              <span className="nav-label">
                {t('復習', 'Review')}
                <span className="nav-count" aria-hidden="true" data-empty={due === null || due === 0}><AnimatedValue value={due && due > 99 ? '99+' : due ?? 0} /></span>
              </span>
              {due !== null && due > 0 && <span className="sr-only">{t(`${due} 件`, `${due} due`)}</span>}
            </Link>
            <Link to="/settings" activeProps={{ className: 'active', 'aria-current': 'page' }}>
              <Settings2 size={18} aria-hidden="true" />
              <span>{t('設定', 'Settings')}</span>
            </Link>
          </nav>
          <div className="topbar-actions">
            <ActivityButton />
            <MotionButton className="locale-button" onClick={() => setLocale(locale === 'ja' ? 'en' : 'ja')} aria-label={t('Switch to English', '日本語に切り替える')}>
              <AnimatedValue value={locale === 'ja' ? 'EN' : '日本語'} />
            </MotionButton>
            <IconButton label={t('テーマを切り替える', 'Toggle theme')} onClick={toggleTheme}>
              <MotionSwap as="span" stateKey={theme}>{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</MotionSwap>
            </IconButton>
          </div>
        </header>
        {!nativeAvailable() && (
          <div className="preview-banner">
            <CircleHelp size={16} aria-hidden="true" />
            <span>{t('ブラウザーで UI をプレビュー中です。動画の読み込み・AI・保存はデスクトップアプリで利用できます。', 'Browser UI preview. Import, AI, and persistence are available in the desktop app.')}</span>
          </div>
        )}
        <NotificationRegion />
        <main className="page-content" data-page-direction={direction} data-page-transition={transition}><Outlet /></main>
      </div>
    </div>
  );
}
