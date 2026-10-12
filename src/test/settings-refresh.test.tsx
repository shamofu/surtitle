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
const context = vi.hoisted(() => ({ data: undefined as AppSnapshot | undefined, error: null as Error | null, loading: false, native: true, refresh: vi.fn(async () => {}), notify: vi.fn(), revision: 0 }));
vi.mock('../features/settings/api', () => ({ settingsApi: { state: vi.fn(), patch: vi.fn(), scanExternalTools: vi.fn(), setToolProvider: vi.fn(), importCredential: vi.fn() } }));
vi.mock('../features/ai/api', () => ({ aiApi: { vertexModels: vi.fn(), vertexPrice: vi.fn() } }));
vi.mock('../features/ai/continuations', () => ({ continuationApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => context.native }));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => ({}), useNavigate: () => vi.fn() }));
vi.mock('../app/runtime', () => {
  const useFixture = () => ({ data: context.data, error: context.error, loading: context.loading, refresh: context.refresh, t: (_ja: string, en: string) => en, locale: 'en',
    mutate: (action: () => Promise<unknown>) => action(), report: (action: () => Promise<unknown>) => action().catch(() => undefined),
    notify: context.notify, registerModal: () => () => {} });
  return { useSnapshot: useFixture, useDataActions: useFixture, useAppearance: useFixture, useNotifications: useFixture, useSurface: useFixture };
});
const settings = (): AppSettings => ({ theme: 'dark', locale: 'en', learningLanguage: 'en', explanationLanguage: 'ja', dailyBudgetUsd: 0,
  vertexProject: 'original-project', vertexLocation: 'global', credentialConfigured: false, retention: .9, proficiency: 'B1', ytDlpChannel: 'nightly', aiModels: {} });
const snapshot = (value: AppSettings): AppSnapshot => ({ settings: value, media: [], cards: [], tools: [], jobs: [], budget: { spentUsd: 0, reservedUsd: 0, limitUsd: 0 } });
const clients: QueryClient[] = [];
function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  return render(<QueryClientProvider client={client}><SettingsPage /></QueryClientProvider>);
}
async function mount() {
  const view = renderSettings();
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Learning language' })).toBeEnabled());
  return view;
}
beforeEach(() => {
  context.data = snapshot(settings()); context.revision = 0; context.error = null; context.loading = false; context.native = true;
  context.refresh.mockImplementation(async () => {});
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.mocked(settingsApi.state).mockImplementation(async () => ({ settings: context.data!.settings, revision: String(context.revision) }));
  vi.mocked(settingsApi.patch).mockImplementation(async (revision, patch) => {
    if (revision !== String(context.revision)) throw Error('Revision conflict');
    const { budgets, ...normal } = patch as Record<string, unknown>;
    context.data = { ...context.data!, settings: { ...context.data!.settings, ...normal, ...(budgets as object ?? {}) } };
    return { settings: context.data.settings, revision: String(++context.revision) };
  });
  vi.mocked(settingsApi.scanExternalTools).mockResolvedValue([]);
  vi.mocked(settingsApi.importCredential).mockResolvedValue(true);
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
  expect(screen.getByRole('textbox', { name: /Monthly AI budget/ })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: /Monthly AI budget/ })).toHaveValue('');
  expect(screen.queryByText(/Could not load settings/)).not.toBeInTheDocument();
  expect(settingsApi.patch).not.toHaveBeenCalled();
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
  await mount();
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
  await mount(); const input = screen.getByRole('textbox', { name: /Monthly AI budget/ });
  fireEvent.change(input, { target: { value: '5' } }); fireEvent.blur(input);
  await waitFor(() => expect(settingsApi.patch).toHaveBeenCalledWith('0', { budgets: { dailyBudgetUsd: 5, monthlyBudgetUsd: 5, perJobBudgetUsd: 5 } }));
});
it('preserves external-tool input, focus and composition through unrelated refreshes', async () => {
  context.data!.tools = [{ id: 'deno', name: 'Deno', provider: 'managed', status: 'ready', version: '2.0', canRollback: false }];
  const view = await mount(); fireEvent.click(screen.getByRole('button', { name: 'External' }));
  const input = screen.getByRole('textbox', { name: 'Absolute executable path' }) as HTMLInputElement;
  input.focus(); fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: 'C:/作業中/deno.exe' } }); input.setSelectionRange(3, 6);
  context.data = { ...context.data!, tools: [{ ...context.data!.tools[0], version: '2.1' }] };
  view.rerender(<QueryClientProvider client={clients.at(-1)!}><SettingsPage /></QueryClientProvider>);
  expect(input).toHaveFocus(); expect(input).toHaveValue('C:/作業中/deno.exe'); expect([input.selectionStart, input.selectionEnd]).toEqual([3, 6]);
  fireEvent.compositionEnd(input); expect(settingsApi.setToolProvider).not.toHaveBeenCalled();
});
describe('shared model catalogue', () => {
  it('fetches once for all four purposes without changing selected model IDs', async () => {
    context.data = snapshot({ ...settings(), credentialConfigured: true });
    vi.mocked(aiApi.vertexModels).mockResolvedValue([{ id: 'gemini-shared', displayName: 'Shared model' }]);
    const { container } = await mount();
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
    const { container } = await mount();
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
    const { container } = await mount();
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
    const { container } = await mount();
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
    await mount();
    fireEvent.click(screen.getByText('Detailed settings by purpose'));
    fireEvent.click(screen.getByRole('button', { name: /Fetch Vertex model/ }));
    await screen.findByText(/Could not fetch candidates/);
    const modelId = screen.getAllByRole('combobox', { name: /Gemini model ID/ })[1];
    expect(modelId).toBeEnabled();
    fireEvent.change(modelId, { target: { value: 'gemini-manual' } });
    expect(modelId).toHaveValue('gemini-manual');
  });

});
