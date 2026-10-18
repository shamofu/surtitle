// SPDX-License-Identifier: GPL-3.0-or-later
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { settingsApi } from '../../features/settings/api';
import { nativeAvailable } from '../../shared/native/transport';
import { setWindowTheme } from '../../shared/native/window';
import { useQueryClient } from '@tanstack/react-query';
import { useSettings } from '../../shared/query/snapshot';
import { mutateData } from '../../shared/query/mutations';
import { useNotifications } from './Notifications';
interface Appearance {
  locale: 'ja' | 'en';
  setLocale: (locale: 'ja' | 'en') => void;
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  t: (ja: string, en: string) => string;
}
const Context = createContext<Appearance | null>(null);
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const { data: settings } = useSettings();
  const { report } = useNotifications();
  const [locale, setLocale] = useState<'ja' | 'en'>('ja');
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    nativeAvailable() && window.matchMedia && !window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
  const changeLocale = useCallback(
    (value: 'ja' | 'en') => {
      if (!nativeAvailable()) {
        setLocale(value);
        return;
      }
      void report(async () => {
        await mutateData(
          client,
          () => settingsApi.updateAppearance({ locale: value }),
          { kind: 'snapshot' },
        );
        setLocale(value);
      });
    },
    [client, report],
  );
  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    if (!nativeAvailable()) {
      setTheme(next);
      return;
    }
    void report(async () => {
      await mutateData(
        client,
        () => settingsApi.updateAppearance({ theme: next }),
        { kind: 'snapshot' },
      );
      setTheme(next);
    });
  }, [client, report, theme]);
  useEffect(() => {
    if (settings) setLocale(settings.locale);
  }, [settings?.locale]);
  useEffect(() => {
    if (!settings) return;
    const requested = settings.theme;
    if (requested !== 'system') { setTheme(requested); return; }
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => setTheme(query.matches ? 'dark' : 'light');
    follow();
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [settings?.theme]);
  useEffect(() => {
    if (!settings || !nativeAvailable()) return;
    const requested = settings.theme;
    void report(async () => {
      try { await setWindowTheme(requested); }
      catch (error) {
        throw new Error(`${settings.locale === 'ja'
          ? 'テーマ設定は保存されていますが、ウィンドウの配色を変更できませんでした。再起動すると再試行します。'
          : 'Your theme is saved, but the window appearance could not be updated. Restart to try again.'} ${String(error)}`);
      }
    });
  }, [settings?.theme, report]);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = locale;
  }, [theme, locale]);
  const value = useMemo<Appearance>(
    () => ({
      locale,
      setLocale: changeLocale,
      theme,
      toggleTheme,
      t: (ja, en) => (locale === 'ja' ? ja : en),
    }),
    [locale, changeLocale, theme, toggleTheme],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useAppearance() {
  const value = useContext(Context);
  if (!value) throw new Error('AppearanceProvider missing');
  return value;
}
