// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from '../pages/Settings';
import { api } from '../api';
import type { AppSnapshot } from '../api';

const context = vi.hoisted(() => ({ data: undefined as AppSnapshot | undefined }));
vi.mock('../api', () => ({ nativeAvailable: () => true, api: { updateSettings: vi.fn().mockResolvedValue(undefined), scanExternalTools: vi.fn().mockResolvedValue([]) } }));
vi.mock('../context', () => ({ useApp: () => ({ data: context.data, t: (_ja: string, en: string) => en, run: (action: () => Promise<unknown>) => action() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); context.data = undefined; });

function mount(replayContextMs?: number) {
  context.data = {
    settings: { locale: 'en', theme: 'dark', learningLanguage: 'en', explanationLanguage: 'ja', proficiency: 'B1', retention: .9, replayContextMs, dailyBudgetUsd: 0, vertexProject: '', vertexLocation: 'global', credentialConfigured: false, ytDlpChannel: 'nightly', aiModels: {} },
    media: [], cards: [], tools: [], jobs: [], budget: { spentUsd: 0, reservedUsd: 0, limitUsd: 0 },
  };
  return render(<SettingsPage />);
}
const input = () => screen.getByRole('spinbutton', { name: /Playback context on each side/ });
const save = () => screen.getAllByRole('button', { name: 'Save changes' })[0];

describe('source playback context settings', () => {
  it('shows the 150 ms default when the optional preference is absent', () => {
    mount();
    expect(input()).toHaveValue(150);
    expect(input()).toHaveAttribute('min', '0');
    expect(input()).toHaveAttribute('max', '1000');
    expect(input()).toHaveAttribute('step', '1');
    expect(screen.getByText('Applies to source playback, repeat and newly saved audio. Subtitle times and existing card audio stay unchanged.')).toBeVisible();
  });
  it.each([0, 150, 1000])('saves %i ms without changing unrelated settings', async value => {
    mount(150);
    const before = structuredClone(context.data!.settings);
    fireEvent.change(input(), { target: { value: String(value) } });
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledExactlyOnceWith({ ...before, replayContextMs: value }));
  });
  it.each(['-1', '1001', '0.5', ''])('blocks invalid context %j before invoking native settings', value => {
    mount(150);
    fireEvent.change(input(), { target: { value } });
    expect(save()).toBeDisabled();
    fireEvent.click(save());
    expect(api.updateSettings).not.toHaveBeenCalled();
    fireEvent.change(input(), { target: { value: '0' } });
    expect(input()).toHaveValue(0);
    expect(save()).toBeEnabled();
  });
});
