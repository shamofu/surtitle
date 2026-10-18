// SPDX-License-Identifier: GPL-3.0-or-later
import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppearanceProvider, useAppearance } from '../app/providers/Appearance';

const fixture = vi.hoisted(() => ({
  settings: { theme: 'system' as 'system' | 'light' | 'dark', locale: 'en' as 'en' | 'ja' },
  native: true,
  setTheme: vi.fn(),
  errors: [] as unknown[],
  report: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('../shared/query/snapshot', () => ({ useSettings: () => ({ data: fixture.settings }) }));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => fixture.native }));
vi.mock('../shared/native/window', () => ({ setWindowTheme: fixture.setTheme }));
vi.mock('../app/providers/Notifications', () => ({ useNotifications: () => ({ report: fixture.report }) }));

let dark = false;
const listeners = new Set<() => void>();
function Viewer() {
  const { theme, locale } = useAppearance();
  return <span>{theme}/{locale}</span>;
}
function App() { return <StrictMode><AppearanceProvider><Viewer /></AppearanceProvider></StrictMode>; }
function systemTheme(value: boolean) {
  act(() => { dark = value; for (const listener of listeners) listener(); });
}
beforeEach(() => {
  dark = false;
  fixture.settings = { theme: 'system', locale: 'en' };
  fixture.native = true;
  fixture.errors = [];
  fixture.setTheme.mockResolvedValue(undefined);
  fixture.report.mockImplementation(async (work: () => Promise<void>) => {
    try { await work(); } catch (error) { fixture.errors.push(error); }
  });
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() { return dark; },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  })));
});
afterEach(() => {
  cleanup();
  expect(listeners.size).toBe(0);
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('follows system theme changes and keeps one media listener across StrictMode cleanup', () => {
  render(<App />);
  expect(screen.getByText('light/en')).toBeInTheDocument();
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(listeners.size).toBe(1);
  fixture.setTheme.mockClear();
  systemTheme(true);
  expect(screen.getByText('dark/en')).toBeInTheDocument();
  expect(document.documentElement.dataset.theme).toBe('dark');
  systemTheme(false);
  expect(document.documentElement.dataset.theme).toBe('light');
  // System events never replace the persisted preference with a forced native theme.
  expect(fixture.setTheme).not.toHaveBeenCalled();
});

it('uses saved overrides, resumes system following, and does not reapply native theme for locale changes', () => {
  const { rerender } = render(<App />);
  expect(fixture.setTheme).toHaveBeenLastCalledWith('system');
  fixture.settings = { theme: 'dark', locale: 'en' };
  rerender(<App />);
  expect(fixture.setTheme).toHaveBeenLastCalledWith('dark');
  expect(listeners.size).toBe(0);
  systemTheme(false);
  expect(screen.getByText('dark/en')).toBeInTheDocument();
  fixture.setTheme.mockClear();
  fixture.settings = { theme: 'dark', locale: 'ja' };
  rerender(<App />);
  expect(document.documentElement.lang).toBe('ja');
  expect(fixture.setTheme).not.toHaveBeenCalled();
  fixture.settings = { theme: 'system', locale: 'ja' };
  rerender(<App />);
  expect(fixture.setTheme).toHaveBeenLastCalledWith('system');
  expect(screen.getByText('light/ja')).toBeInTheDocument();
  expect(listeners.size).toBe(1);
});

it('reports a native appearance failure without claiming the saved theme was lost', async () => {
  fixture.settings = { theme: 'light', locale: 'en' };
  fixture.setTheme.mockRejectedValue(new Error('window unavailable'));
  render(<AppearanceProvider><Viewer /></AppearanceProvider>);
  await waitFor(() => expect(fixture.errors).toHaveLength(1));
  expect(String(fixture.errors[0])).toContain('Your theme is saved');
  expect(String(fixture.errors[0])).toContain('window unavailable');
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(fixture.settings.theme).toBe('light');
});

it('does not call the native window API in browser preview', () => {
  fixture.native = false;
  render(<App />);
  systemTheme(true);
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(fixture.setTheme).not.toHaveBeenCalled();
});
