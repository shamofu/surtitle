// SPDX-License-Identifier: GPL-3.0-or-later
vi.mock('../app/providers/Activities', () => import('./activity-fixture'));
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { SettingsPage } from '../features/settings/SettingsPage';
import { mergeSettingsRefresh } from '../features/settings/merge-settings';
import { emptyModel } from '../features/ai/ModelEditor';
import { settingsApi } from '../features/settings/api';
import { aiApi } from '../features/ai/api';
import type { AiModelPreference } from '../shared/contracts/ai';
import type { AppSettings } from '../shared/contracts/settings';
import type { AppSnapshot } from '../shared/contracts/snapshot';

const context = vi.hoisted(() => ({
  data: undefined as AppSnapshot | undefined,
  notify: vi.fn(),
  registerModal: () => () => {},
}));

vi.mock('../features/settings/api', () => ({
  settingsApi: {
    updateSettings: vi.fn().mockResolvedValue(undefined),
    scanExternalTools: vi.fn().mockResolvedValue([]),
    setToolProvider: vi.fn().mockResolvedValue(undefined),
    importCredential: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock('../features/ai/api', () => ({
  aiApi: { vertexModels: vi.fn().mockResolvedValue([]), vertexPrice: vi.fn() },
}));

vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => ({}), useNavigate: () => vi.fn(), useBlocker: () => ({ status: 'idle' }) }));
vi.mock('../shared/native/window', () => ({ subscribeWindowClose: () => () => {}, closeWindow: vi.fn() }));
vi.mock('../features/ai/continuations', () => ({ continuationApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock('../app/runtime', () => {
  const useFixture = () => ({
    mutate: (action: () => Promise<unknown>) => action(),
    data: context.data,
    t: (_ja: string, en: string) => en,
    report: (action: () => Promise<unknown>) => action().catch(() => undefined),
    notify: context.notify,
    registerModal: context.registerModal,
  });
  return {
    useSnapshot: useFixture,
    useDataActions: useFixture,
    useAppearance: useFixture,
    useNotifications: useFixture,
    useSurface: useFixture,
  };
});
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(settingsApi.scanExternalTools).mockResolvedValue([]);
  vi.mocked(settingsApi.updateSettings).mockResolvedValue(undefined);
  vi.mocked(settingsApi.importCredential).mockResolvedValue(true);
  vi.mocked(aiApi.vertexModels).mockResolvedValue([]);
  context.data = undefined;
});

const settings = (): AppSettings => ({
  theme: 'dark',
  locale: 'en',
  learningLanguage: 'en',
  explanationLanguage: 'ja',
  dailyBudgetUsd: 0,
  vertexProject: 'original-project',
  vertexLocation: 'global',
  credentialConfigured: false,
  retention: 0.9,
  proficiency: 'B1',
  ytDlpChannel: 'nightly',
  aiModels: {},
});
const model = (id = 'gemini-original'): AiModelPreference => ({
  ...emptyModel('vocabulary'),
  modelId: id,
});
const price = (id: string) => ({
  id,
  source: 'user',
  observedAtMs: 1,
  inputMicrousdPerMillion: 1,
  outputMicrousdPerMillion: 2,
});
function snapshot(value: AppSettings): AppSnapshot {
  return {
    settings: value,
    media: [],
    cards: [],
    tools: [],
    jobs: [],
    budget: { spentUsd: 0, reservedUsd: 0, limitUsd: 0 },
  };
}

describe('settings refresh preserves unrelated unsaved edits', () => {
  it('keeps settings saved across refreshes when no model preferences exist', () => {
    const initial = { ...settings(), aiModels: undefined };
    context.data = snapshot(initial);
    const { rerender } = render(<SettingsPage />);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    context.data = snapshot({ ...initial });
    rerender(<SettingsPage />);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByText('Settings are saved')).toBeVisible();
  });
  it('shows unverified startup candidates without adopting them and rescans only on request', async () => {
    const first = {
      toolId: 'deno' as const,
      path: 'C:\\first\\deno.exe',
      selectable: true,
      verification: 'unverified' as const,
      reason: null,
    };
    const second = { ...first, path: 'C:\\second\\deno.exe' };
    vi.mocked(settingsApi.scanExternalTools)
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second]);
    context.data = {
      ...snapshot(settings()),
      tools: [
        {
          id: 'deno',
          name: 'Deno',
          provider: 'managed',
          status: 'missing',
          canRollback: false,
        },
      ],
    };
    render(<SettingsPage />);
    await waitFor(() =>
      expect(settingsApi.scanExternalTools).toHaveBeenCalledWith(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'External' }));
    fireEvent.click(
      await screen.findByRole('button', { name: /C:\\first\\deno.exe/ }),
    );
    expect(
      screen.getByText('Unverified; capabilities are checked when selected.'),
    ).toBeVisible();
    expect(settingsApi.setToolProvider).not.toHaveBeenCalled();
    expect(settingsApi.scanExternalTools).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Rescan PATH' }));
    await screen.findByRole('button', { name: /C:\\second\\deno.exe/ });
    expect(settingsApi.scanExternalTools).toHaveBeenLastCalledWith(true);
    expect(settingsApi.setToolProvider).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: /C:\\second\\deno.exe/ }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Verify and use this path' }),
    );
    await waitFor(() =>
      expect(settingsApi.setToolProvider).toHaveBeenCalledWith({
        toolId: 'deno',
        provider: 'external',
        path: second.path,
      }),
    );
  });
  it('keeps typed models and learning edits through appearance and credential refreshes, then saves the fresh backend fields', async () => {
    const initial = settings();
    context.data = snapshot(initial);
    const { rerender } = render(<SettingsPage />);
    fireEvent.click(screen.getByText('Detailed settings by purpose'));
    fireEvent.change(
      screen.getAllByRole('combobox', { name: /Gemini model ID/ })[1],
      { target: { value: 'gemini-future-model' } },
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: /Learning language/ }),
      { target: { value: 'fr' } },
    );
    const appearance = {
      ...initial,
      theme: 'light' as const,
      locale: 'ja' as const,
    };
    context.data = snapshot(appearance);
    rerender(<SettingsPage />);
    expect(
      screen.getAllByRole('combobox', { name: /Gemini model ID/ })[1],
    ).toHaveValue('gemini-future-model');
    expect(
      screen.getByRole('combobox', { name: /Learning language/ }),
    ).toHaveValue('fr');
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue(
      'light',
    );
    const credential = {
      ...appearance,
      credentialConfigured: true,
      vertexProject: 'imported-project',
    };
    context.data = snapshot(credential);
    rerender(<SettingsPage />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[0]);
    await waitFor(() =>
      expect(settingsApi.updateSettings).toHaveBeenCalledOnce(),
    );
    expect(
      vi.mocked(settingsApi.updateSettings).mock.calls[0][0],
    ).toMatchObject({
      theme: 'light',
      locale: 'ja',
      credentialConfigured: true,
      vertexProject: 'imported-project',
      learningLanguage: 'fr',
      aiModels: { vocabulary: { modelId: 'gemini-future-model' } },
    });
  });

  it('saves language names as codes and preserves unlisted language codes', async () => {
    context.data = snapshot({ ...settings(), learningLanguage: 'tlh' });
    render(<SettingsPage />);
    const learning = screen.getByRole('combobox', { name: /Learning language/ });
    expect(learning).toHaveValue('tlh');
    const explanation = screen.getByRole('combobox', { name: 'Explanation language' });
    expect(explanation).toHaveValue('Japanese');
    fireEvent.change(learning, { target: { value: 'French' } });
    fireEvent.change(explanation, { target: { value: 'yue-Hant' } });
    fireEvent.blur(explanation);
    expect(explanation).toHaveValue('yue-Hant');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[0]);
    await waitFor(() => expect(settingsApi.updateSettings).toHaveBeenCalledOnce());
    expect(vi.mocked(settingsApi.updateSettings).mock.calls[0][0]).toMatchObject({
      learningLanguage: 'fr',
      explanationLanguage: 'yue-Hant',
    });
  });

  it('accepts a saved same-field change without erasing edits in another model', () => {
    const before = {
      ...settings(),
      aiModels: {
        vocabulary: model(),
        translation: model('gemini-translation'),
      },
    };
    const current = {
      ...before,
      vertexProject: 'unsaved-project',
      aiModels: {
        ...before.aiModels,
        translation: { ...before.aiModels.translation, maxOutputTokens: 1234 },
      },
    };
    const next = {
      ...before,
      vertexProject: 'new-imported-project',
      aiModels: { ...before.aiModels, vocabulary: model('gemini-saved') },
    };
    const merged = mergeSettingsRefresh(before, current, next);
    expect(merged.vertexProject).toBe('new-imported-project');
    expect(merged.aiModels?.vocabulary?.modelId).toBe('gemini-saved');
    expect(merged.aiModels?.translation?.maxOutputTokens).toBe(1234);
  });

  it('does not carry a dirty price across a remotely changed model or location', () => {
    const before = { ...settings(), aiModels: { vocabulary: model() } };
    const current = {
      ...before,
      aiModels: {
        vocabulary: {
          ...model(),
          price: price('local-old-identity'),
          maxOutputTokens: 1234,
        },
      },
    };
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
    const current = {
      ...before,
      aiModels: { vocabulary: model('gemini-unsaved') },
    };
    const next = {
      ...before,
      aiModels: {
        vocabulary: { ...model(), price: price('saved-original-model') },
      },
    };
    expect(
      mergeSettingsRefresh(before, current, next).aiModels?.vocabulary,
    ).toMatchObject({ modelId: 'gemini-unsaved', price: null });
  });

  it('keeps thinking level and budget exclusive when saved settings change concurrently', () => {
    const before = { ...settings(), aiModels: { vocabulary: model() } };
    const current = {
      ...before,
      aiModels: { vocabulary: { ...model(), thinkingLevel: 'LOW' } },
    };
    const next = {
      ...before,
      aiModels: { vocabulary: { ...model(), thinkingBudget: 2048 } },
    };
    expect(
      mergeSettingsRefresh(before, current, next).aiModels?.vocabulary,
    ).toMatchObject({ thinkingLevel: null, thinkingBudget: 2048 });
  });

  it('uses a successful save as the next baseline instead of reviving older values', () => {
    const before = settings();
    const saved = {
      ...before,
      learningLanguage: 'fr',
      aiModels: { vocabulary: model('gemini-saved') },
    };
    const acknowledged = mergeSettingsRefresh(before, saved, saved);
    const next = { ...saved, learningLanguage: 'de', locale: 'ja' as const };
    expect(mergeSettingsRefresh(saved, acknowledged, next)).toEqual(next);
  });
});

describe('guided settings and shared model catalogue', () => {
  it('keeps custom retention through unrelated edits and offers workload presets', async () => {
    context.data = snapshot({ ...settings(), retention: 0.912 });
    render(<SettingsPage />);
    expect(screen.getByRole('combobox', { name: /Review frequency/ })).toHaveValue('custom');
    expect(screen.getByRole('spinbutton', { name: /Target retention/ })).toHaveValue(91.2);
    expect(screen.getByRole('option', { name: /B1.*Explain experiences/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: /Learning language/ }), { target: { value: 'French' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(settingsApi.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ retention: 0.912 })));
    fireEvent.change(screen.getByRole('combobox', { name: /Review frequency/ }), { target: { value: '0.95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(settingsApi.updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ retention: 0.95 })));
  });

  it('sets all standard caps when the first monthly budget is entered', async () => {
    context.data = snapshot(settings());
    render(<SettingsPage />);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.change(screen.getByRole('spinbutton', { name: /Monthly AI budget/ }), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(settingsApi.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ monthlyBudgetUsd: 5, dailyBudgetUsd: 5, perJobBudgetUsd: 5 })));
    expect(screen.getByText('Settings are saved')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('preserves independent caps and can restore monthly-following defaults', async () => {
    context.data = snapshot({ ...settings(), monthlyBudgetUsd: 10, dailyBudgetUsd: 2, perJobBudgetUsd: 1 });
    render(<SettingsPage />);
    fireEvent.change(screen.getByRole('spinbutton', { name: /Monthly AI budget/ }), { target: { value: '20' } });
    expect(screen.getByText(/Advanced limits:/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(settingsApi.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ monthlyBudgetUsd: 20, dailyBudgetUsd: 2, perJobBudgetUsd: 1 })));
    fireEvent.click(screen.getByText('Adjust daily and per-job limits'));
    screen.getAllByRole('button', { name: 'Match the monthly budget' }).forEach((button) => fireEvent.click(button));
    fireEvent.change(screen.getByRole('spinbutton', { name: /Monthly AI budget/ }), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(settingsApi.updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ monthlyBudgetUsd: 30, dailyBudgetUsd: 30, perJobBudgetUsd: 30 })));
  });

  it('blocks a blank budget and preserves unsaved edits after a failed save', async () => {
    context.data = snapshot(settings());
    render(<SettingsPage />);
    const budget = screen.getByRole('spinbutton', { name: /Monthly AI budget/ });
    fireEvent.change(budget, { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByText('Check the entered values.')).toBeVisible();
    for (const button of screen.getAllByRole('button', { name: 'Match the monthly budget', hidden: true })) expect(button).toBeDisabled();
    fireEvent.change(budget, { target: { value: '4' } });
    vi.mocked(settingsApi.updateSettings).mockRejectedValueOnce(new Error('write failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
    expect(budget).toHaveValue(4);
    expect(screen.getByText('You have unsaved changes')).toBeVisible();
  });

  it('associates validation with language and wrapped budget inputs and focuses the first error', () => {
    context.data = snapshot(settings());
    render(<SettingsPage />);
    const language = screen.getByRole('combobox', { name: 'Learning language' });
    const budget = screen.getByRole('spinbutton', { name: 'Monthly AI budget (USD)' });
    fireEvent.change(language, { target: { value: '' } });
    fireEvent.change(budget, { target: { value: '1001' } });
    expect(language).toHaveAttribute('aria-invalid', 'true');
    expect(language).toHaveAccessibleDescription(/Choose a learning language/);
    expect(budget).toHaveAttribute('aria-invalid', 'true');
    expect(budget).toHaveAccessibleDescription(/Enter an amount between 0 and 1,000 USD/);
    fireEvent.click(screen.getByRole('button', { name: 'Review errors' }));
    expect(language).toHaveFocus();
    fireEvent.change(language, { target: { value: 'French' } });
    fireEvent.change(budget, { target: { value: '4' } });
    expect(screen.queryByRole('button', { name: 'Review errors' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('opens collapsed budget and model details to focus the invalid setting', () => {
    context.data = snapshot({ ...settings(), dailyBudgetUsd: -1, monthlyBudgetUsd: 0, perJobBudgetUsd: 0 });
    const view = render(<SettingsPage />);
    const daily = screen.getByLabelText('Daily limit (USD)');
    const budgetDetails = daily.closest('details')!;
    expect(budgetDetails.open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Review errors' }));
    expect(budgetDetails.open).toBe(true);
    expect(daily).toHaveFocus();
    view.unmount();

    context.data = snapshot({ ...settings(), aiModels: { vocabulary: { ...model(), maxOutputTokens: 0 } } });
    render(<SettingsPage />);
    const tokens = screen.getByLabelText('Maximum output tokens per request');
    const modelDetails = tokens.closest('details')!;
    expect(modelDetails.open).toBe(false);
    expect(tokens).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Review errors' }));
    expect(modelDetails.open).toBe(true);
    expect(tokens).toHaveFocus();
    fireEvent.change(tokens, { target: { value: '' } });
    expect(tokens).toHaveValue(null);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.change(tokens, { target: { value: '8000' } });
    expect(tokens).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('identifies out-of-range retention and non-integer playback context', () => {
    context.data = snapshot({ ...settings(), retention: 0.5, replayContextMs: 1.5 });
    render(<SettingsPage />);
    const retention = screen.getByRole('spinbutton', { name: 'Target retention (%)' });
    const contextInput = screen.getByRole('spinbutton', { name: 'Playback context on each side (ms)' });
    expect(retention).toHaveAccessibleDescription(/between 70% and 97%/);
    expect(contextInput).toHaveAccessibleDescription(/whole number between 0 and 1,000 ms/);
    fireEvent.change(retention, { target: { value: '90' } });
    fireEvent.change(contextInput, { target: { value: '150' } });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('locks editable settings during an in-flight save and retains them on failure', async () => {
    context.data = snapshot({ ...settings(), aiModels: { vocabulary: model() } });
    let reject!: (error: Error) => void;
    vi.mocked(settingsApi.updateSettings).mockReturnValueOnce(new Promise((_resolve, rejectSave) => { reject = rejectSave; }));
    render(<SettingsPage />);
    const language = screen.getByRole('combobox', { name: 'Learning language' });
    fireEvent.change(language, { target: { value: 'French' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(language).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Monthly AI budget (USD)' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'yt-dlp update channel' })).toBeDisabled();
    expect(screen.getAllByRole('combobox', { name: 'Gemini model ID' }).every(input => input.hasAttribute('disabled'))).toBe(true);
    await act(async () => { reject(new Error('write failed')); });
    expect(language).toBeEnabled();
    expect(language).toHaveValue('French');
    expect(screen.getByText('You have unsaved changes')).toBeVisible();
  });

  it('fetches once for all four purposes without changing selected model IDs', async () => {
    context.data = snapshot({ ...settings(), credentialConfigured: true });
    vi.mocked(aiApi.vertexModels).mockResolvedValue([{ id: 'gemini-shared', displayName: 'Shared model' }]);
    const { container } = render(<SettingsPage />);
    const buttons = screen.getAllByRole('button', { name: /Fetch Vertex/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await screen.findByText(/1 candidate is available for every purpose/);
    expect(container.querySelectorAll('datalist option[value="gemini-shared"]')).toHaveLength(4);
    expect(screen.getAllByRole('combobox', { name: /Gemini model ID/ }).every((input) => (input as HTMLInputElement).value === '')).toBe(true);
    expect(aiApi.vertexModels).toHaveBeenCalledExactlyOnceWith('global');
    const project = screen.getByRole('textbox', { name: /Project ID/ });
    expect(project).toHaveAttribute('readonly');
    expect(project).toHaveValue('original-project');
  });

  it('discards a delayed catalogue after the location changes and changes back', async () => {
    let complete!: (models: Awaited<ReturnType<typeof aiApi.vertexModels>>) => void;
    vi.mocked(aiApi.vertexModels).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    context.data = snapshot({ ...settings(), credentialConfigured: true });
    const { container } = render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Fetch Vertex model/ }));
    const location = screen.getByRole('textbox', { name: 'Location' });
    fireEvent.change(location, { target: { value: 'us-central1' } });
    fireEvent.change(location, { target: { value: 'global' } });
    await act(async () => complete([{ id: 'gemini-old', displayName: 'Stale' }]));
    expect(container.querySelectorAll('datalist option[value="gemini-old"]')).toHaveLength(0);
    expect(screen.queryByText(/1 candidate is available/)).not.toBeInTheDocument();
  });

  it('invalidates the catalogue after importing another key for the same project', async () => {
    context.data = snapshot({ ...settings(), credentialConfigured: true });
    vi.mocked(aiApi.vertexModels).mockResolvedValue([{ id: 'gemini-shared', displayName: 'Shared' }]);
    const { container } = render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Fetch Vertex model/ }));
    await screen.findByText(/1 candidate is available/);
    fireEvent.click(screen.getByRole('button', { name: 'Import JSON' }));
    await waitFor(() => expect(container.querySelectorAll('datalist option[value="gemini-shared"]')).toHaveLength(0));
    expect(screen.getByRole('textbox', { name: /Project ID/ })).toHaveValue('original-project');
    expect(context.notify).toHaveBeenCalledWith('Credential saved.');
  });

  it('keeps the catalogue and skips success notification when JSON selection is cancelled', async () => {
    context.data = snapshot({ ...settings(), credentialConfigured: true });
    vi.mocked(aiApi.vertexModels).mockResolvedValue([{ id: 'gemini-shared', displayName: 'Shared' }]);
    vi.mocked(settingsApi.importCredential).mockResolvedValueOnce(false);
    const { container } = render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Fetch Vertex model/ }));
    await screen.findByText(/1 candidate is available/);
    fireEvent.click(screen.getByRole('button', { name: 'Import JSON' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import JSON' })).toBeEnabled());
    expect(container.querySelectorAll('datalist option[value="gemini-shared"]')).toHaveLength(4);
    expect(context.notify).not.toHaveBeenCalled();
  });

  it('keeps direct model entry available after candidate discovery fails', async () => {
    context.data = snapshot({ ...settings(), credentialConfigured: true });
    vi.mocked(aiApi.vertexModels).mockRejectedValueOnce(new Error('denied'));
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Fetch Vertex model/ }));
    await screen.findByText(/Could not fetch candidates/);
    const modelId = screen.getAllByRole('combobox', { name: /Gemini model ID/ })[1];
    expect(modelId).toBeEnabled();
    fireEvent.change(modelId, { target: { value: 'gemini-manual' } });
    expect(modelId).toHaveValue('gemini-manual');
  });

  it('defaults a missing channel to stable while keeping saved nightly', () => {
    const initial = { ...settings(), ytDlpChannel: undefined };
    context.data = snapshot(initial);
    const { rerender } = render(<SettingsPage />);
    expect(screen.getByRole('combobox', { name: /yt-dlp update channel/ })).toHaveValue('stable');
    context.data = snapshot({ ...initial, ytDlpChannel: 'nightly' });
    rerender(<SettingsPage />);
    expect(screen.getByRole('combobox', { name: /yt-dlp update channel/ })).toHaveValue('nightly');
  });
});
