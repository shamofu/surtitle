// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useNavigate } from '@tanstack/react-router';
import { SettingsPage } from '../features/settings/SettingsPage';
import { emptyModel } from '../features/ai/ModelEditor';
import { settingsApi } from '../features/settings/api';
import { aiApi } from '../features/ai/api';
import type { AppSnapshot } from '../shared/contracts/snapshot';

const fixture = vi.hoisted(() => ({
  data: undefined as AppSnapshot | undefined,
  notify: vi.fn(),
  close: vi.fn<() => Promise<void>>(),
  onClose: undefined as undefined | (() => boolean),
  registerModal: () => () => {},
}));
vi.mock('../features/settings/api', () => ({ settingsApi: {
  updateSettings: vi.fn(), scanExternalTools: vi.fn().mockResolvedValue([]),
} }));
vi.mock('../features/ai/api', () => ({ aiApi: { vertexPrice: vi.fn() } }));
vi.mock('../features/ai/continuations', () => ({ continuationApi: { list: vi.fn().mockResolvedValue([{
  id: 'request', mediaId: 'media', kind: 'transcription', start: '0', end: '10', wholeMedia: false, focusTerm: '', models: {},
}]) } }));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../shared/native/window', () => ({
  subscribeWindowClose: (callback: () => boolean) => { fixture.onClose = callback; return () => { fixture.onClose = undefined; }; },
  closeWindow: () => fixture.close(),
}));
vi.mock('../app/runtime', () => {
  const useFixture = () => ({
    data: fixture.data,
    t: (_ja: string, en: string) => en,
    mutate: (action: () => Promise<unknown>) => action(),
    report: (action: () => Promise<unknown>) => action().catch(() => undefined),
    notify: fixture.notify,
    registerModal: fixture.registerModal,
  });
  return { useSnapshot: useFixture, useDataActions: useFixture, useAppearance: useFixture, useNotifications: useFixture, useSurface: useFixture };
});

type PriceResult = Awaited<ReturnType<typeof aiApi.vertexPrice>>;
function result(id: string): PriceResult {
  return { price: { id, source: 'user', observedAtMs: 1, inputMicrousdPerMillion: 100, outputMicrousdPerMillion: 200 }, candidates: [], observedAtMs: 1, complete: true };
}
function Root() {
  const navigate = useNavigate();
  return <><button onClick={() => void navigate({ to: '/' })}>Go to library</button><Outlet /></>;
}
async function mount() {
  const root = createRootRoute({ component: Root });
  const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsPage });
  const library = createRoute({ getParentRoute: () => root, path: '/', component: () => <h1>Library</h1> });
  const study = createRoute({ getParentRoute: () => root, path: '/study/$mediaId', component: () => <h1>Study</h1> });
  const router = createRouter({ routeTree: root.addChildren([settings, library, study]), history: createMemoryHistory({ initialEntries: ['/settings'] }) });
  render(<RouterProvider router={router} />);
  await screen.findByRole('button', { name: 'Save and return to your request' });
  fireEvent.click(screen.getByText('Detailed settings by purpose'));
  screen.getAllByText('Output, thinking, and pricing').forEach(button => fireEvent.click(button));
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  fixture.data = {
    settings: {
      theme: 'dark', locale: 'en', learningLanguage: 'en', explanationLanguage: 'ja', dailyBudgetUsd: 0,
      vertexProject: 'project', vertexLocation: 'global', credentialConfigured: true, retention: 0.9,
      proficiency: 'B1', ytDlpChannel: 'nightly', aiModels: {
        vocabulary: { ...emptyModel('vocabulary'), modelId: 'vocabulary-model' },
        translation: { ...emptyModel('translation'), modelId: 'translation-model' },
      },
    },
    media: [], cards: [], tools: [], jobs: [], budget: { spentUsd: 0, reservedUsd: 0, limitUsd: 0 },
  };
  vi.mocked(settingsApi.updateSettings).mockResolvedValue(undefined);
  fixture.close.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each(['route', 'native'] as const)('saves every in-flight price before completing a %s exit', async destination => {
  const completions = new Map<string, (value: PriceResult) => void>();
  vi.mocked(aiApi.vertexPrice).mockImplementation(id => new Promise(resolve => { completions.set(id, resolve); }));
  await mount();
  fireEvent.click(screen.getAllByRole('button', { name: 'Retrieve public prices' })[1]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Retrieve public prices' })[3]);
  if (destination === 'route') {
    fireEvent.change(screen.getByRole('combobox', { name: 'Learning language' }), { target: { value: 'fr' } });
  }
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save and return to your request' })).toBeDisabled();
  if (destination === 'route') fireEvent.click(screen.getByRole('button', { name: 'Go to library' }));
  else act(() => { expect(fixture.onClose?.()).toBe(true); });
  await screen.findByRole('dialog');
  const saveAndLeave = screen.getByRole('button', { name: 'Save and leave' });
  expect(saveAndLeave).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Keep editing' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Discard and leave' })).toBeEnabled();
  fireEvent.click(saveAndLeave);
  expect(settingsApi.updateSettings).not.toHaveBeenCalled();
  await act(async () => { completions.get('vocabulary-model')!(result('vocabulary-price')); });
  expect(saveAndLeave).toBeDisabled();
  await act(async () => { completions.get('translation-model')!(result('translation-price')); });
  expect(saveAndLeave).toBeEnabled();
  fireEvent.click(saveAndLeave);
  await waitFor(() => expect(settingsApi.updateSettings).toHaveBeenCalledOnce());
  expect(vi.mocked(settingsApi.updateSettings).mock.calls[0][0]).toMatchObject({
    learningLanguage: destination === 'route' ? 'fr' : 'en',
    aiModels: { vocabulary: { price: result('vocabulary-price').price }, translation: { price: result('translation-price').price } },
  });
  if (destination === 'route') await screen.findByRole('heading', { name: 'Library' });
  else await waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
});

it('unlocks saving after a failed price request and preserves other edits', async () => {
  let fail!: (error: Error) => void;
  vi.mocked(aiApi.vertexPrice).mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  await mount();
  fireEvent.click(screen.getAllByRole('button', { name: 'Retrieve public prices' })[1]);
  fireEvent.change(screen.getByRole('combobox', { name: 'Learning language' }), { target: { value: 'fr' } });
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await act(async () => { fail(new Error('Price unavailable')); });
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save and return to your request' }));
  await screen.findByRole('heading', { name: 'Study' });
  expect(vi.mocked(settingsApi.updateSettings).mock.calls[0][0]).toMatchObject({ learningLanguage: 'fr', aiModels: { vocabulary: { price: null } } });
});

it('allows cancelling navigation or discarding while prices are pending without saving a late result', async () => {
  let complete!: (value: PriceResult) => void;
  vi.mocked(aiApi.vertexPrice).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  await mount();
  fireEvent.click(screen.getAllByRole('button', { name: 'Retrieve public prices' })[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Go to library' }));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Go to library' }));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
  await screen.findByRole('heading', { name: 'Library' });
  await act(async () => { complete(result('late-price')); });
  expect(settingsApi.updateSettings).not.toHaveBeenCalled();
});
