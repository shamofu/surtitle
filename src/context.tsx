// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { api, nativeAvailable } from './api';
import type { AppSnapshot } from './api';
import { dueCards } from './utils';

interface Toast { id: number; text: string; kind: 'success' | 'error' }
interface AppContextValue {
  data?: AppSnapshot;
  loading: boolean;
  error: Error | null;
  locale: 'ja' | 'en';
  setLocale: (locale: 'ja' | 'en') => void;
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  t: (ja: string, en: string) => string;
  notify: (text: string, kind?: Toast['kind']) => void;
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
  refresh: () => Promise<void>;
  surfaceHidden: boolean;
  registerModal: () => () => void;
}
const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['snapshot'], queryFn: api.snapshot, enabled: nativeAvailable() });
  const [locale, setLocale] = useState<'ja' | 'en'>('ja');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modalCount, setModalCount] = useState(0);
  const [reviewClock, setReviewClock] = useState(Date.now());
  const notify = useCallback((text: string, kind: Toast['kind'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(items => [...items.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts(items => items.filter(item => item.id !== id)), 6500);
  }, []);
  const refresh = useCallback(async () => { await client.invalidateQueries(); }, [client]);
  const run = useCallback(async <T,>(action: () => Promise<T>, success?: string): Promise<T | undefined> => {
    try {
      const result = await action();
      await refresh();
      if (success) notify(success);
      return result;
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); return undefined; }
  }, [notify, refresh]);
  const registerModal = useCallback(() => {
    setModalCount(value => value + 1);
    return () => setModalCount(value => Math.max(0, value - 1));
  }, []);
  const changeLocale = useCallback((value: 'ja' | 'en') => {
    if (!nativeAvailable()) { setLocale(value); return; }
    void run(async () => { await api.updateAppearance({ locale: value }); setLocale(value); });
  }, [run]);
  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    if (!nativeAvailable()) { setTheme(next); return; }
    void run(async () => { await api.updateAppearance({ theme: next }); setTheme(next); });
  }, [run, theme]);
  useEffect(() => {
    if (!query.data) return;
    setLocale(query.data.settings.locale);
    const requestedTheme = query.data.settings.theme;
    setTheme(requestedTheme === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : requestedTheme);
  }, [query.data?.settings.locale, query.data?.settings.theme]); // Only backend preference changes reset local preview controls.
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.lang = locale; }, [theme, locale]);
  useEffect(() => { const timer = window.setInterval(() => setReviewClock(Date.now()), 60000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!query.data || !nativeAvailable()) return;
    const due = dueCards(query.data.cards, reviewClock).length;
    if (!due) return;
    const day = new Date(reviewClock).toLocaleDateString('en-CA');
    try {
      if (localStorage.getItem('surtitle-review-notified-day') === day) return;
      localStorage.setItem('surtitle-review-notified-day', day);
    } catch { return; }
    notify(query.data.settings.locale === 'ja' ? `${due} 個のフレーズが復習の時間です。サイドバーの「今日の復習」から始められます。` : `${due} phrases are ready to revisit. Open Review in the sidebar when you have a moment.`);
  }, [query.data?.cards, reviewClock, notify]);
  useEffect(() => {
    if (!nativeAvailable()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen('app-changed', () => { void refresh(); }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop?.(); };
  }, [refresh]);
  const value = useMemo<AppContextValue>(() => ({
    data: query.data, loading: query.isLoading, error: query.error, locale, setLocale: changeLocale, theme,
    toggleTheme,
    t: (ja, en) => locale === 'ja' ? ja : en, notify, run, refresh, surfaceHidden: modalCount > 0, registerModal,
  }), [query.data, query.isLoading, query.error, locale, theme, changeLocale, toggleTheme, notify, run, refresh, modalCount, registerModal, reviewClock]);
  return <AppContext.Provider value={value}>
    {children}
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map(toast => <button key={toast.id} className={`toast ${toast.kind}`} onClick={() => setToasts(items => items.filter(item => item.id !== toast.id))}>{toast.text}</button>)}
    </div>
  </AppContext.Provider>;
}
export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('AppProvider missing');
  return context;
}
