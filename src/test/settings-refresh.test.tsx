// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPage, mergeSettingsRefresh } from '../pages/Settings';
import { emptyModel } from '../components/ModelEditor';
import { api } from '../api';
import type { AiModelPreference, AppSettings, AppSnapshot } from '../api';

const context = vi.hoisted(() => ({ data: undefined as AppSnapshot | undefined }));
vi.mock('../api', () => ({ nativeAvailable: () => true, api: { updateSettings: vi.fn().mockResolvedValue(undefined), scanExternalTools: vi.fn().mockResolvedValue([]), setToolProvider: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('../context', () => ({ useApp: () => ({ data: context.data, t: (_ja: string, en: string) => en, run: (action: () => Promise<unknown>) => action() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.mocked(api.scanExternalTools).mockResolvedValue([]); context.data = undefined; });

const settings = (): AppSettings => ({ theme: 'dark', locale: 'en', learningLanguage: 'en', explanationLanguage: 'ja', dailyBudgetUsd: 0, vertexProject: 'original-project', vertexLocation: 'global', credentialConfigured: false, retention: .9, proficiency: 'B1', ytDlpChannel: 'nightly', aiModels: {} });
const model = (id = 'gemini-original'): AiModelPreference => ({ ...emptyModel('vocabulary'), modelId: id });
const price = (id: string) => ({ id, source: 'user', observedAtMs: 1, inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 2 });
function snapshot(value: AppSettings): AppSnapshot { return { settings: value, media: [], cards: [], tools: [], jobs: [], budget: { spentUsd: 0, reservedUsd: 0, limitUsd: 0 } }; }

describe('settings refresh preserves unrelated unsaved edits', () => {
  it('shows unverified startup candidates without adopting them and rescans only on request', async () => {
    const first = { toolId: 'deno' as const, path: 'C:\\first\\deno.exe', selectable: true, verification: 'unverified' as const, reason: null };
    const second = { ...first, path: 'C:\\second\\deno.exe' };
    vi.mocked(api.scanExternalTools).mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
    context.data = { ...snapshot(settings()), tools: [{ id: 'deno', name: 'Deno', provider: 'managed', status: 'missing', canRollback: false }] };
    render(<SettingsPage />);
    await waitFor(() => expect(api.scanExternalTools).toHaveBeenCalledWith(false));
    fireEvent.click(screen.getByRole('button', { name: 'External' }));
    fireEvent.click(await screen.findByRole('button', { name: /C:\\first\\deno.exe/ }));
    expect(screen.getByText('Unverified; capabilities are checked when selected.')).toBeVisible();
    expect(api.setToolProvider).not.toHaveBeenCalled();
    expect(api.scanExternalTools).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Rescan PATH' }));
    await screen.findByRole('button', { name: /C:\\second\\deno.exe/ });
    expect(api.scanExternalTools).toHaveBeenLastCalledWith(true);
    expect(api.setToolProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /C:\\second\\deno.exe/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify and use this path' }));
    await waitFor(() => expect(api.setToolProvider).toHaveBeenCalledWith({ toolId: 'deno', provider: 'external', path: second.path }));
  });
  it('keeps typed models and learning edits through appearance and credential refreshes, then saves the fresh backend fields', async () => {
    const initial = settings(); context.data = snapshot(initial);
    const { rerender } = render(<SettingsPage />);
    fireEvent.change(screen.getAllByRole('combobox', { name: /Gemini model ID/ })[1], { target: { value: 'gemini-future-model' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Learning language/ }), { target: { value: 'fr' } });
    const appearance = { ...initial, theme: 'light' as const, locale: 'ja' as const };
    context.data = snapshot(appearance); rerender(<SettingsPage />);
    expect(screen.getAllByRole('combobox', { name: /Gemini model ID/ })[1]).toHaveValue('gemini-future-model');
    expect(screen.getByRole('textbox', { name: /Learning language/ })).toHaveValue('fr');
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('light');
    const credential = { ...appearance, credentialConfigured: true, vertexProject: 'imported-project' };
    context.data = snapshot(credential); rerender(<SettingsPage />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[0]);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledOnce());
    expect(vi.mocked(api.updateSettings).mock.calls[0][0]).toMatchObject({ theme: 'light', locale: 'ja', credentialConfigured: true, vertexProject: 'imported-project', learningLanguage: 'fr', aiModels: { vocabulary: { modelId: 'gemini-future-model' } } });
  });

  it('accepts a saved same-field change without erasing edits in another model', () => {
    const before = { ...settings(), aiModels: { vocabulary: model(), translation: model('gemini-translation') } };
    const current = { ...before, vertexProject: 'unsaved-project', aiModels: { ...before.aiModels, translation: { ...before.aiModels.translation, maxOutputTokens: 1234 } } };
    const next = { ...before, vertexProject: 'new-imported-project', aiModels: { ...before.aiModels, vocabulary: model('gemini-saved') } };
    const merged = mergeSettingsRefresh(before, current, next);
    expect(merged.vertexProject).toBe('new-imported-project');
    expect(merged.aiModels?.vocabulary?.modelId).toBe('gemini-saved');
    expect(merged.aiModels?.translation?.maxOutputTokens).toBe(1234);
  });

  it('does not carry a dirty price across a remotely changed model or location', () => {
    const before = { ...settings(), aiModels: { vocabulary: model() } };
    const current = { ...before, aiModels: { vocabulary: { ...model(), price: price('local-old-identity'), maxOutputTokens: 1234 } } };
    for (const next of [
      { ...before, vertexLocation: 'us-central1' },
      { ...before, aiModels: { vocabulary: model('gemini-saved') } },
    ]) {
      const merged = mergeSettingsRefresh(before, current, next);
      expect(merged.aiModels?.vocabulary?.price).toBeNull();
      expect(merged.aiModels?.vocabulary?.maxOutputTokens).toBe(1234);
    }
    expect(current.aiModels.vocabulary.price.id).toBe('local-old-identity');
  });

  it('does not attach a refreshed old-model price to a locally changed model', () => {
    const before = { ...settings(), aiModels: { vocabulary: model() } };
    const current = { ...before, aiModels: { vocabulary: model('gemini-unsaved') } };
    const next = { ...before, aiModels: { vocabulary: { ...model(), price: price('saved-original-model') } } };
    expect(mergeSettingsRefresh(before, current, next).aiModels?.vocabulary).toMatchObject({ modelId: 'gemini-unsaved', price: null });
  });

  it('keeps thinking level and budget exclusive when saved settings change concurrently', () => {
    const before = { ...settings(), aiModels: { vocabulary: model() } };
    const current = { ...before, aiModels: { vocabulary: { ...model(), thinkingLevel: 'LOW' } } };
    const next = { ...before, aiModels: { vocabulary: { ...model(), thinkingBudget: 2048 } } };
    expect(mergeSettingsRefresh(before, current, next).aiModels?.vocabulary).toMatchObject({ thinkingLevel: null, thinkingBudget: 2048 });
  });

  it('uses a successful save as the next baseline instead of reviving older values', () => {
    const before = settings();
    const saved = { ...before, learningLanguage: 'fr', aiModels: { vocabulary: model('gemini-saved') } };
    const acknowledged = mergeSettingsRefresh(before, saved, saved);
    const next = { ...saved, learningLanguage: 'de', locale: 'ja' as const };
    expect(mergeSettingsRefresh(saved, acknowledged, next)).toEqual(next);
  });
});
