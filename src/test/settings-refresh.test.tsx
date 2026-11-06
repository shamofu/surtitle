// SPDX-License-Identifier: GPL-3.0-or-later
vi.mock('../app/providers/Activities', () => import('./activity-fixture'));
vi.mock('../shared/editing/drafts', () => import('./editing-mocks'));
vi.mock('../shared/editing/session', async importOriginal => {
  const actual = await importOriginal<typeof import('../shared/editing/session')>();
  return { ...actual, editingSession: (kind: 'settings', id: string, adapter: import('../shared/editing/session').EditAdapter) => new actual.EditingSession(kind, id, adapter) };
});
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsPage } from '../features/settings/SettingsPage';
import { settingsApi } from '../features/settings/api';
import { settingsEditor } from '../features/settings/editing';
import { aiApi } from '../features/ai/api';
import type { AppSettings } from '../shared/contracts/settings';
import type { AppSnapshot } from '../shared/contracts/snapshot';
const context = vi.hoisted(() => ({ data: undefined as AppSnapshot | undefined, error: null as Error | null, loading: false, native: true, refresh: vi.fn(async () => {}), notify: vi.fn(), navigate: vi.fn(), hash: '', resume: undefined as string | undefined, revision: 0 }));
vi.mock('../features/settings/api', () => ({ settingsApi: { state: vi.fn(), patch: vi.fn(), scanExternalTools: vi.fn(), setToolProvider: vi.fn(), importCredential: vi.fn(), setWindowSizePreset: vi.fn(), saveOpenaiApiKey: vi.fn(), removeOpenaiApiKey: vi.fn() } }));
vi.mock('../features/ai/api', () => ({ aiApi: { vertexModels: vi.fn(), vertexPrice: vi.fn(), openaiModels: vi.fn() } }));
vi.mock('../features/ai/continuations', () => ({ continuationApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => context.native }));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => ({ resume: context.resume }), useLocation: ({ select }: { select: (location: { hash: string }) => unknown }) => select({ hash: context.hash }), useNavigate: () => context.navigate }));
vi.mock('../app/runtime', () => {
  const useFixture = () => ({ data: context.data, error: context.error, loading: context.loading, refresh: context.refresh, t: (_ja: string, en: string) => en, locale: 'en',
    mutate: (action: () => Promise<unknown>) => action(), report: (action: () => Promise<unknown>) => action().catch(() => undefined),
    notify: context.notify, registerModal: () => () => {} });
  return { useSnapshot: useFixture, useDataActions: useFixture, useAppearance: useFixture, useNotifications: useFixture, useSurface: useFixture };
});
const settings = (): AppSettings => ({ activeProvider: 'vertex', aiConfigurationGeneration: 0, openai: { credentialConfigured: false, dailyBudgetUsd: 0, aiModels: {} }, theme: 'dark', locale: 'en', learningLanguage: 'en', explanationLanguage: 'ja', dailyBudgetUsd: 0,
  vertexProject: 'original-project', vertexLocation: 'global', credentialConfigured: false, retention: .9, proficiency: 'B1', aiModels: {} });
const snapshot = (value: AppSettings): AppSnapshot => ({ settings: value, media: [], cards: [], tools: [], jobs: [], budgets: { vertex: { spentUsd: 0, reservedUsd: 0, limitUsd: 0 }, openai: { spentUsd: 0, reservedUsd: 0, limitUsd: 0 } } });
const clients: QueryClient[] = [];
function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  return render(<QueryClientProvider client={client}><SettingsPage /></QueryClientProvider>);
}
function selectCategory(name: 'Learning' | 'Appearance' | 'AI' | 'Tools' | 'Data') {
  fireEvent.click(screen.getByRole('button', { name }));
}
async function mount(category: 'Learning' | 'Appearance' | 'AI' | 'Tools' | 'Data' = 'Learning') {
  const view = renderSettings();
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Learning language' })).toBeEnabled());
  if (category !== 'Learning') selectCategory(category);
  return view;
}
beforeEach(() => {
  context.data = snapshot(settings()); context.revision = 0; context.error = null; context.loading = false; context.native = true;
  context.hash = ''; context.resume = undefined;
  context.refresh.mockImplementation(async () => {});
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.mocked(settingsApi.state).mockImplementation(async () => ({ settings: context.data!.settings, revision: String(context.revision) }));
  vi.mocked(settingsApi.patch).mockImplementation(async (revision, patch) => {
    if (revision !== String(context.revision)) throw Error('Revision conflict');
    const { budgets, openaiModels, ...normal } = patch as Record<string, unknown>;
    const caps = budgets as { provider?: string; dailyBudgetUsd?: number; monthlyBudgetUsd?: number; perJobBudgetUsd?: number } | undefined;
    const { provider: _provider, ...limits } = caps ?? {};
    context.data = { ...context.data!, settings: { ...context.data!.settings, ...normal,
      ...(caps?.provider === 'openai' ? {} : limits),
      openai: { ...context.data!.settings.openai, ...(openaiModels ? { aiModels: openaiModels as AppSettings['aiModels'] } : {}), ...(caps?.provider === 'openai' ? limits : {}) },
    } };
    return { settings: context.data.settings, revision: String(++context.revision) };
  });
  vi.mocked(settingsApi.scanExternalTools).mockResolvedValue([]);
  vi.mocked(settingsApi.importCredential).mockResolvedValue(true);
  vi.mocked(settingsApi.setWindowSizePreset).mockResolvedValue(undefined);
  vi.mocked(aiApi.vertexModels).mockResolvedValue([]);
});
afterEach(async () => { cleanup(); await act(async () => {}); clients.splice(0).forEach(client => client.clear()); vi.clearAllMocks(); });

it('keeps disabled settings readable in the browser preview without inventing persisted values', async () => {
  context.native = false;
  context.data = undefined;
  vi.mocked(settingsApi.state).mockRejectedValueOnce(new Error('Open Surtitle desktop to use this feature.'));
  renderSettings();
  await screen.findByText(/Open Surtitle desktop to use this feature/);
  expect(screen.getByRole('combobox', { name: 'Learning language' })).toBeDisabled();
  selectCategory('AI');
  expect(screen.getByRole('textbox', { name: /Monthly AI budget/ })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: /Monthly AI budget/ })).toHaveValue('');
  selectCategory('Appearance');
  expect(screen.getByRole('button', { name: '1600 × 900 (Default)' })).toBeDisabled();
  expect(screen.queryByText(/Could not load settings/)).not.toBeInTheDocument();
  expect(settingsApi.patch).not.toHaveBeenCalled();
});

it('applies each window preset independently of unfinished settings and prevents duplicate requests', async () => {
  await mount();
  const input = screen.getByRole('textbox', { name: /Playback context on each side/ });
  fireEvent.change(input, { target: { value: '-' } });
  selectCategory('Appearance');
  let finish!: () => void;
  vi.mocked(settingsApi.setWindowSizePreset).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const standard = screen.getByRole('button', { name: '1600 × 900 (Default)' });
  fireEvent.click(standard);
  fireEvent.click(standard);
  expect(settingsApi.setWindowSizePreset).toHaveBeenCalledExactlyOnceWith('standard');
  expect(standard).toBeDisabled();
  expect(screen.getByRole('button', { name: '1280 × 720 (HD)' })).toBeDisabled();
  await act(async () => finish());
  expect(standard).toBeEnabled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '1280 × 720 (HD)' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '1920 × 1080 (Full HD)' })); });
  expect(vi.mocked(settingsApi.setWindowSizePreset).mock.calls).toEqual([['standard'], ['hd'], ['full-hd']]);
  expect(input).toHaveValue('-');
  expect(settingsApi.patch).not.toHaveBeenCalled();
});

it('reports a failed window resize and allows retry', async () => {
  await mount('Appearance');
  vi.mocked(settingsApi.setWindowSizePreset).mockRejectedValueOnce(new Error('Window resize failed'));
  const button = screen.getByRole('button', { name: '1600 × 900 (Default)' });
  await act(async () => { fireEvent.click(button); });
  expect(context.notify).toHaveBeenCalledWith('Error: Window resize failed', 'error');
  expect(button).toBeEnabled();
  await act(async () => { fireEvent.click(button); });
  expect(settingsApi.setWindowSizePreset).toHaveBeenCalledTimes(2);
});

it('recovers an initial snapshot failure without replacing the loaded editing session', async () => {
  const available = snapshot(settings());
  context.data = undefined;
  context.error = new Error('Snapshot unavailable');
  vi.mocked(settingsApi.state).mockResolvedValueOnce({ settings: available.settings, revision: '0' });
  renderSettings();
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load settings. Snapshot unavailable');
  expect(screen.queryByRole('combobox', { name: 'Learning language' })).not.toBeInTheDocument();
  await act(async () => {});
  context.refresh.mockImplementationOnce(async () => { context.data = available; context.error = null; });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Learning language' })).toBeEnabled());
  expect(settingsApi.state).toHaveBeenCalledOnce();
  expect(context.refresh).toHaveBeenCalledOnce();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('retries an initial settings-editor read instead of attempting to save unavailable fields', async () => {
  vi.mocked(settingsApi.state).mockRejectedValueOnce(new Error('Settings store unavailable'));
  renderSettings();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Settings store unavailable'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Learning language' })).toBeEnabled());
  expect(settingsApi.state).toHaveBeenCalledTimes(2);
  expect(settingsApi.patch).not.toHaveBeenCalled();
  expect(context.refresh).not.toHaveBeenCalled();
});

it('keeps the loaded settings subtree and unfinished focused input during a snapshot refresh failure', async () => {
  const view = await mount();
  const input = screen.getByRole('textbox', { name: /Playback context on each side/ }) as HTMLInputElement;
  input.focus();
  fireEvent.change(input, { target: { value: '-' } });
  input.setSelectionRange(0, 1);
  context.error = new Error('Background snapshot failed');
  view.rerender(<QueryClientProvider client={clients.at(-1)!}><SettingsPage /></QueryClientProvider>);
  expect(screen.getByRole('textbox', { name: /Playback context on each side/ })).toBe(input);
  expect(input).toHaveFocus();
  expect(input).toHaveValue('-');
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 1]);
  expect(screen.queryByText(/Background snapshot failed/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Could not load settings/)).not.toBeInTheDocument();
});

it('persists the caption gap mode through a partial patch while retaining unfinished settings input', async () => {
  const client = new QueryClient(); clients.push(client);
  const session = settingsEditor(client);
  await session.load();
  expect(session.getSnapshot().fields.captionGapMode).toBe('review');
  session.change({ replayContextMs: '', captionGapMode: 'preview' });
  expect(session.getSnapshot().fields.captionGapMode).toBe('preview');
  expect(await session.flush()).toBe(true);
  expect(settingsApi.patch).toHaveBeenCalledExactlyOnceWith('0', { captionGapMode: 'preview' });
  expect(session.getSnapshot().fields.replayContextMs).toBe('');
  expect(context.data!.settings.captionGapMode).toBe('preview');
  const reopened = settingsEditor(client);
  await reopened.load();
  expect(reopened.getSnapshot().fields.captionGapMode).toBe('preview');
});

it('retains an invalid caption gap mode without sending it to settings', async () => {
  const client = new QueryClient(); clients.push(client);
  const session = settingsEditor(client);
  await session.load();
  session.change({ captionGapMode: 'current' });
  await session.flush();
  expect(settingsApi.patch).not.toHaveBeenCalled();
  expect(session.getSnapshot().fields.captionGapMode).toBe('current');
});

it('autosaves a valid field without a save button and leaves typing enabled', async () => {
  await mount('Appearance');
  fireEvent.change(screen.getByRole('combobox', { name: 'Animations' }), { target: { value: 'reduce' } });
  expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  await waitFor(() => expect(settingsApi.patch).toHaveBeenCalledWith('0', { motionPreference: 'reduce' }));
  expect(screen.getByRole('combobox', { name: 'Animations' })).toBeEnabled();
});
it('commits valid learning input while retaining an unfinished context value', async () => {
  await mount();
  const contextInput = screen.getByRole('textbox', { name: /Playback context on each side/ });
  fireEvent.change(contextInput, { target: { value: '' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Learning language' }), { target: { value: 'fr' } });
  fireEvent.blur(contextInput);
  await waitFor(() => expect(settingsApi.patch).toHaveBeenCalledWith('0', { learningLanguage: 'fr' }));
  expect(contextInput).toHaveValue('');
  expect(context.data!.settings.replayContextMs).toBeUndefined();
});
it.each([0, 150, 1000])('saves playback context %i with a partial update', async value => {
  context.data!.settings.replayContextMs = value === 150 ? 0 : 150;
  await mount(); const input = screen.getByRole('textbox', { name: /Playback context on each side/ });
  fireEvent.change(input, { target: { value: String(value) } }); fireEvent.blur(input);
  await waitFor(() => expect(settingsApi.patch).toHaveBeenCalledWith('0', { replayContextMs: value }));
});
it.each(['-', '-1', '1001', '0.5', '1e', ''])('retains invalid playback context %s without committing it', async value => {
  await mount(); const input = screen.getByRole('textbox', { name: /Playback context on each side/ });
  fireEvent.change(input, { target: { value } }); fireEvent.blur(input); await act(async () => {});
  expect(settingsApi.patch).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '0' } }); fireEvent.blur(input);
  await waitFor(() => expect(settingsApi.patch).toHaveBeenCalledWith('0', { replayContextMs: 0 }));
});
it('keeps failed input editable and retries from inline status', async () => {
  vi.mocked(settingsApi.patch).mockRejectedValueOnce(Error('Disk full'));
  await mount(); const input = screen.getByRole('combobox', { name: 'Learning language' });
  fireEvent.change(input, { target: { value: 'fr' } }); fireEvent.blur(input);
  await screen.findByText(/Disk full/); expect(input).toHaveValue('French'); expect(input).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(context.data!.settings.learningLanguage).toBe('fr'));
});
it('saves budget caps only through the budget patch', async () => {
  await mount('AI'); const input = screen.getByRole('textbox', { name: /Monthly AI budget/ });
  fireEvent.change(input, { target: { value: '5' } }); fireEvent.blur(input);
  await waitFor(() => expect(settingsApi.patch).toHaveBeenCalledWith('0', { budgets: { provider: 'vertex', dailyBudgetUsd: 5, monthlyBudgetUsd: 5, perJobBudgetUsd: 5 } }));
});
it('keeps an unfinished input mounted across categories and reveals it from the persistent error action', async () => {
  await mount();
  const input = screen.getByRole('textbox', { name: /Playback context on each side/ });
  fireEvent.change(input, { target: { value: '-' } });
  selectCategory('Appearance');
  expect(input).toBeInTheDocument();
  expect(input).not.toBeVisible();
  expect(screen.queryByRole('textbox', { name: /Playback context on each side/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Appearance' })).toHaveAttribute('aria-pressed', 'true');
  expect(context.navigate).toHaveBeenCalledWith(expect.objectContaining({ hash: 'appearance', resetScroll: false }));
  fireEvent.click(screen.getByRole('button', { name: 'Review errors' }));
  expect(screen.getByRole('button', { name: 'Learning' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('textbox', { name: /Playback context on each side/ })).toBe(input);
  expect(input).toHaveValue('-');
  expect(input).toHaveFocus();
  expect(settingsApi.state).toHaveBeenCalledOnce();
  expect(settingsApi.patch).not.toHaveBeenCalled();
});
it('reveals a hidden AI category and closed budget disclosure before focusing an invalid field', async () => {
  await mount('AI');
  fireEvent.click(screen.getByText('Adjust daily and per-job limits'));
  const input = screen.getByRole('textbox', { name: 'Daily limit (USD)' });
  fireEvent.change(input, { target: { value: '-' } });
  fireEvent.click(screen.getByText('Adjust daily and per-job limits'));
  selectCategory('Data');
  fireEvent.click(screen.getByRole('button', { name: 'Review errors' }));
  expect(screen.getByRole('button', { name: 'AI' })).toHaveAttribute('aria-pressed', 'true');
  expect(input.closest('details')).toHaveAttribute('open');
  expect(input).toBeVisible();
  expect(input).toHaveFocus();
  expect(input).toHaveValue('-');
});
it.each(['vertex', 'ai-models', 'budget'])('opens the AI category for the existing #%s anchor', async hash => {
  context.hash = hash;
  const view = renderSettings();
  await waitFor(() => expect(screen.getByRole('textbox', { name: /Monthly AI budget/ })).toBeEnabled());
  expect(screen.getByRole('button', { name: 'AI' })).toHaveAttribute('aria-pressed', 'true');
  expect(view.container.querySelector('#learning')).not.toBeVisible();
});
it('follows hash changes without replacing the shared editing session', async () => {
  const view = await mount();
  const input = screen.getByRole('textbox', { name: /Playback context on each side/ });
  fireEvent.change(input, { target: { value: '-' } });
  context.hash = 'budget';
  view.rerender(<QueryClientProvider client={clients.at(-1)!}><SettingsPage /></QueryClientProvider>);
  expect(screen.getByRole('button', { name: 'AI' })).toHaveAttribute('aria-pressed', 'true');
  context.hash = '';
  view.rerender(<QueryClientProvider client={clients.at(-1)!}><SettingsPage /></QueryClientProvider>);
  expect(screen.getByRole('textbox', { name: /Playback context on each side/ })).toBe(input);
  expect(input).toHaveValue('-');
  expect(settingsApi.state).toHaveBeenCalledOnce();
});
it('uses a continuation for initial AI selection without taking over a later category choice', async () => {
  context.resume = 'request-one';
  const view = renderSettings();
  await waitFor(() => expect(screen.getByRole('textbox', { name: /Monthly AI budget/ })).toBeEnabled());
  selectCategory('Tools');
  context.resume = 'request-two';
  view.rerender(<QueryClientProvider client={clients.at(-1)!}><SettingsPage /></QueryClientProvider>);
  expect(screen.getByRole('button', { name: 'Tools' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByRole('textbox', { name: /Monthly AI budget/ })).not.toBeInTheDocument();
});
it('preserves external-tool input, focus and composition through unrelated refreshes', async () => {
  context.data!.tools = [{ id: 'ffmpeg', name: 'FFmpeg', provider: 'managed', status: 'ready', version: '2.0', canRollback: false }];
  const view = await mount('Tools'); fireEvent.click(screen.getByRole('button', { name: 'External' }));
  const input = screen.getByRole('textbox', { name: 'Absolute executable path' }) as HTMLInputElement;
  input.focus(); fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: 'C:/作業中/ffmpeg.exe' } }); input.setSelectionRange(3, 6);
  context.data = { ...context.data!, tools: [{ ...context.data!.tools[0], version: '2.1' }] };
  view.rerender(<QueryClientProvider client={clients.at(-1)!}><SettingsPage /></QueryClientProvider>);
  expect(input).toHaveFocus(); expect(input).toHaveValue('C:/作業中/ffmpeg.exe'); expect([input.selectionStart, input.selectionEnd]).toEqual([3, 6]);
  fireEvent.compositionEnd(input); expect(settingsApi.setToolProvider).not.toHaveBeenCalled();
});
describe('shared model catalogue', () => {
  it('fetches once for all four purposes without changing selected model IDs', async () => {
    context.data = snapshot({ ...settings(), credentialConfigured: true });
    vi.mocked(aiApi.vertexModels).mockResolvedValue([{ id: 'gemini-shared', displayName: 'Shared model' }]);
    const { container } = await mount('AI');
    fireEvent.click(screen.getByText('Detailed settings by purpose'));
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
    const { container } = await mount('AI');
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
    const { container } = await mount('AI');
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
    const { container } = await mount('AI');
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
    await mount('AI');
    fireEvent.click(screen.getByText('Detailed settings by purpose'));
    fireEvent.click(screen.getByRole('button', { name: /Fetch Vertex model/ }));
    await screen.findByText(/Could not fetch candidates/);
    const modelId = screen.getAllByRole('combobox', { name: /Gemini model ID/ })[1];
    expect(modelId).toBeEnabled();
    fireEvent.change(modelId, { target: { value: 'gemini-manual' } });
    expect(modelId).toHaveValue('gemini-manual');
  });

});

it('keeps provider profiles and budgets separate when switching and editing', async () => {
  context.data!.settings.openai = { credentialConfigured: true, dailyBudgetUsd: 3, monthlyBudgetUsd: 3, perJobBudgetUsd: 3, aiModels: { transcription: { modelId: 'gpt-transcribe', transcriptionMode: 'transcribe', maxOutputTokens: 12288 } } };
  context.data!.budgets.vertex.spentUsd = 1.25;
  context.data!.budgets.openai.spentUsd = 2.50;
  await mount('AI');
  expect(screen.getByLabelText('Vertex AI budget')).toHaveTextContent('$1.25');
  expect(screen.getByLabelText('OpenAI budget')).toHaveTextContent('$2.50');
  fireEvent.change(screen.getByRole('combobox', { name: /^AI provider/ }), { target: { value: 'openai' } });
  const monthly = screen.getByRole('textbox', { name: /Monthly AI budget/ });
  expect(monthly).toHaveValue('3');
  fireEvent.change(monthly, { target: { value: '7' } }); fireEvent.blur(monthly);
  await waitFor(() => expect(context.data!.settings.openai.monthlyBudgetUsd).toBe(7));
  expect(context.data!.settings.dailyBudgetUsd).toBe(0);
  expect(context.data!.settings.openai.perJobBudgetUsd).toBe(7);
  expect(settingsApi.patch).toHaveBeenCalledWith(expect.any(String), { budgets: { provider: 'openai', dailyBudgetUsd: 7, monthlyBudgetUsd: 7, perJobBudgetUsd: 7 } });
});
it('clears the password input after saving an OpenAI key without adding it to setting drafts', async () => {
  context.data!.settings.activeProvider = 'openai';
  vi.mocked(settingsApi.saveOpenaiApiKey).mockResolvedValue(undefined);
  await mount('AI');
  const key = screen.getByLabelText('OpenAI API key');
  fireEvent.change(key, { target: { value: 'test-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save API key' }));
  await waitFor(() => expect(settingsApi.saveOpenaiApiKey).toHaveBeenCalledWith('test-secret'));
  expect(key).toHaveValue('');
  expect(vi.mocked(settingsApi.patch).mock.calls.flat().some(value => JSON.stringify(value).includes('test-secret'))).toBe(false);
});

it('saves a valid OpenAI cap while retaining an invalid cap in the draft', async () => {
  context.data!.settings.activeProvider = 'openai';
  await mount('AI');
  fireEvent.click(screen.getByText('Adjust daily and per-job limits'));
  const daily = screen.getByRole('textbox', { name: /Daily limit/ });
  fireEvent.change(daily, { target: { value: '-1' } });
  const monthly = screen.getByRole('textbox', { name: /Monthly AI budget/ });
  fireEvent.change(monthly, { target: { value: '4' } }); fireEvent.blur(monthly);
  await waitFor(() => expect(settingsApi.patch).toHaveBeenCalledWith(expect.any(String), { budgets: { provider: 'openai', dailyBudgetUsd: 0, monthlyBudgetUsd: 4, perJobBudgetUsd: 4 } }));
  expect(daily).toHaveValue('-1');
});

it('continues editing settings after its own key mutation changes only server-owned fields', async () => {
  context.data!.settings.activeProvider = 'openai';
  vi.mocked(settingsApi.saveOpenaiApiKey).mockImplementation(async () => {
    context.data!.settings.openai.credentialConfigured = true;
    context.data!.settings.aiConfigurationGeneration += 1;
    context.revision += 1;
  });
  await mount('AI');
  fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'fixture-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save API key' }));
  await screen.findByText('API key configured');
  const monthly = screen.getByRole('textbox', { name: /Monthly AI budget/ });
  fireEvent.change(monthly, { target: { value: '6' } }); fireEvent.blur(monthly);
  await waitFor(() => expect(context.data!.settings.openai.monthlyBudgetUsd).toBe(6));
  expect(screen.queryByRole('textbox', { name: 'Previous input' })).not.toBeInTheDocument();
});

it('edits the inactive provider budget without switching the provider or its models', async () => {
  const models = { vocabulary: { modelId: 'vertex-text', transcriptionMode: 'subtitles' as const, maxOutputTokens: 8192 } };
  context.data!.settings.aiModels = models;
  await mount('AI');
  fireEvent.change(screen.getByRole('combobox', { name: /^Budget provider/ }), { target: { value: 'openai' } });
  const monthly = screen.getByRole('textbox', { name: /Monthly AI budget/ });
  fireEvent.change(monthly, { target: { value: '9' } }); fireEvent.blur(monthly);
  await waitFor(() => expect(context.data!.settings.openai.monthlyBudgetUsd).toBe(9));
  expect(context.data!.settings.activeProvider).toBe('vertex');
  expect(context.data!.settings.aiModels).toEqual(models);
  expect(context.data!.settings.dailyBudgetUsd).toBe(0);
  expect(vi.mocked(settingsApi.patch).mock.calls.some(([, patch]) => 'activeProvider' in patch || 'aiModels' in patch)).toBe(false);
});
