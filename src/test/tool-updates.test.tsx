// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { AppProvider } from '../context';
import { SettingsPage } from '../pages/Settings';
import type { AppSnapshot } from '../api';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.mocked(invoke).mockReset(); });

function mount(locale: 'ja' | 'en', check: () => Promise<void>) {
  const data: AppSnapshot = {
    settings: { theme: 'dark', locale, learningLanguage: 'en', explanationLanguage: 'ja', dailyBudgetUsd: 0, vertexProject: '', vertexLocation: 'global', credentialConfigured: false, retention: .9, proficiency: 'B1', ytDlpChannel: 'nightly', aiModels: {} },
    media: [], cards: [], jobs: [], budget: { spentUsd: 0, reservedUsd: 0, limitUsd: 0 },
    tools: [{ id: 'deno', name: 'Deno', provider: 'managed', status: 'ready', version: '2.0.0', canRollback: false }],
  };
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'get_app_snapshot') return structuredClone(data);
    if (command === 'scan_external_tools') return [];
    if (command === 'check_tool_updates') return check();
    throw new Error(`Unexpected IPC during metadata discovery: ${command}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><AppProvider><SettingsPage /></AppProvider></QueryClientProvider>);
}

function commands() { return vi.mocked(invoke).mock.calls.map(([command]) => command); }

describe('manual managed-tool update discovery', () => {
  it.each([
    { locale: 'en' as const, button: 'Check updates', rescan: 'Rescan PATH', language: 'Learning language', success: 'Update information checked.' },
    { locale: 'ja' as const, button: '更新を確認', rescan: 'PATH を再検索', language: '学習する言語', success: '更新情報を確認しました。' },
  ])('checks metadata explicitly with independent busy state in $locale', async ({ locale, button, rescan, language, success }) => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    mount(locale, () => pending);
    const checkButton = await screen.findByRole('button', { name: button });
    await waitFor(() => expect(screen.getByRole('textbox', { name: new RegExp(language) })).toHaveValue('en'));
    expect(commands()).not.toContain('check_tool_updates');
    fireEvent.change(screen.getByRole('textbox', { name: new RegExp(language) }), { target: { value: 'fr' } });
    fireEvent.click(checkButton);
    expect(checkButton).toBeDisabled();
    expect(checkButton).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(checkButton);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'check_tool_updates')).toEqual([['check_tool_updates', undefined]]);
    const scanButton = screen.getByRole('button', { name: rescan });
    expect(scanButton).toBeEnabled();
    fireEvent.click(scanButton);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('scan_external_tools', { rescan: true }));
    expect(checkButton).toBeDisabled();
    await act(async () => { finish(); });
    expect(await screen.findByText(success)).toBeVisible();
    await waitFor(() => expect(checkButton).toBeEnabled());
    expect(screen.getByRole('textbox', { name: new RegExp(language) })).toHaveValue('fr');
    for (const mutation of ['install_tool', 'update_tool', 'set_tool_provider', 'update_settings']) expect(commands()).not.toContain(mutation);
  });

  it('surfaces metadata failures through the shared error toast and enables another explicit check', async () => {
    mount('en', () => Promise.reject(new Error('Upstream metadata unavailable')));
    const button = await screen.findByRole('button', { name: 'Check updates' });
    fireEvent.click(button);
    expect(await screen.findByText('Upstream metadata unavailable')).toHaveClass('error');
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByText('Update information checked.')).not.toBeInTheDocument();
    expect(commands().filter(command => command === 'check_tool_updates')).toHaveLength(1);
    expect(commands()).not.toContain('install_tool');
    expect(commands()).not.toContain('update_tool');
  });
});
