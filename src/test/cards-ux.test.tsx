// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as baseRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from 'react';
import { CardsPage } from '../features/cards/CardsPage';
import { EditCardDialog } from '../features/cards/CardManagement';
import { cardsApi } from '../features/cards/api';
import type { StudyCard } from '../shared/contracts/cards';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { uiDraftApi } from '../shared/editing/drafts';
import { MotionProvider } from '../shared/motion';

const fixture = vi.hoisted(() => ({
  data: undefined as { cards: StudyCard[]; media: [] } | undefined,
  loading: false,
  error: null as Error | null,
  refresh: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a href={to} className={className}>{children}</a>,
  createLink: (Component: ComponentType<AnchorHTMLAttributes<HTMLAnchorElement>>) =>
    ({ to, params, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; params?: { mediaId: string } }) =>
      <Component {...props} href={to.replace('$mediaId', params?.mediaId ?? '')} />,
}));
vi.mock('../features/cards/api', () => ({ cardsApi: { editCard: vi.fn(), editState: vi.fn(), saveEdit: vi.fn(), suspendCard: vi.fn() } }));
vi.mock('../app/runtime', () => {
  const registerModal = () => () => {};
  const useFixture = () => ({
    ...fixture,
    locale: 'en',
    t: (_ja: string, en: string) => en,
    registerModal,
    mutate: (action: () => Promise<unknown>) => action(),
    report: async (action: () => Promise<unknown>) => { try { return await action(); } catch { return undefined; } },
  });
  return { useSnapshot: useFixture, useDataActions: useFixture, useAppearance: useFixture, useNotifications: useFixture, useSurface: useFixture };
});

vi.mock('../shared/editing/drafts', () => import('./editing-mocks'));
vi.mock('../shared/editing/session', async importOriginal => {
  const actual = await importOriginal<typeof import('../shared/editing/session')>();
  return { ...actual, editingSession: (kind: 'card', id: string, adapter: import('../shared/editing/session').EditAdapter) => new actual.EditingSession(kind, id, adapter) };
});
const clients: QueryClient[] = [];
function render(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const view = baseRender(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  return { ...view, rerender: (next: ReactNode) => view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>) };
}
let revision = 0;
let saved: StudyCard;
const card: StudyCard = {
  id: 'english', mediaId: 'media', segmentId: 'cue', term: 'look into', meaning: 'investigate', example: 'Look into this.',
  language: 'en', dueAt: '2030-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', reviewCount: 0, suspended: false,
};
beforeEach(() => {
  fixture.data = { cards: [card, { ...card, id: 'japanese', term: '調べる', language: 'ja' }], media: [] };
  saved = { ...card }; revision = 0;
  vi.mocked(cardsApi.editState).mockImplementation(async () => ({ card: saved, revision: String(revision) }));
  vi.mocked(cardsApi.saveEdit).mockImplementation(async (request, expected) => {
    expect(expected).toBe(String(revision)); saved = { ...saved, ...request };
    return { card: saved, revision: String(++revision) };
  });
  fixture.loading = false;
  fixture.error = null;
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(async () => { cleanup(); await act(async () => {}); clients.splice(0).forEach(client => client.clear()); vi.clearAllMocks(); });

it('opens one phrase menu, dismisses outside without swallowing the action, and restores focus only for Escape', async () => {
  const user = userEvent.setup();
  render(<CardsPage />);
  const english = screen.getByLabelText('Actions for look into');
  const japanese = screen.getByLabelText('Actions for 調べる');
  await user.click(english);
  expect(english.closest('details')).toHaveAttribute('open');
  await user.click(japanese);
  expect(english.closest('details')).not.toHaveAttribute('open');
  expect(japanese.closest('details')).toHaveAttribute('open');
  await user.click(screen.getByRole('textbox', { name: 'Search your phrases' }));
  expect(japanese.closest('details')).not.toHaveAttribute('open');
  expect(screen.getByRole('textbox', { name: 'Search your phrases' })).toHaveFocus();
  await user.click(english);
  await user.tab();
  expect(within(english.closest('details')!).getByRole('button', { name: 'Suspend reviews' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(english.closest('details')).not.toHaveAttribute('open');
  expect(english).toHaveFocus();
  await user.click(english);
  await user.tab();
  await user.tab();
  await user.tab();
  await user.tab();
  expect(english.closest('details')).not.toHaveAttribute('open');
});

it('distinguishes loading, load failure, no saved phrases, and filters with no matches', async () => {
  fixture.data = undefined;
  fixture.loading = true;
  const view = render(<CardsPage />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading your phrases');
  expect(screen.queryByText('No saved phrases yet')).not.toBeInTheDocument();
  fixture.loading = false;
  fixture.error = new Error('Store unavailable');
  view.rerender(<CardsPage />);
  expect(screen.getByRole('alert')).toHaveTextContent('Store unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(fixture.refresh).toHaveBeenCalledOnce();
  fixture.error = null;
  fixture.data = { cards: [], media: [] };
  view.rerender(<CardsPage />);
  expect(screen.getByText('No saved phrases yet')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Choose something to watch' })).toBeInTheDocument();
  fixture.data = { cards: [card], media: [] };
  view.rerender(<CardsPage />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Search your phrases' }), { target: { value: 'missing' } });
  expect(screen.getByText('No matching phrases')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reset filters' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Choose something to watch' })).not.toBeInTheDocument();
});

it('clears just the query and resets both filters from the empty results state', () => {
  render(<CardsPage />);
  const search = screen.getByRole('textbox', { name: 'Search your phrases' });
  const language = screen.getByRole('combobox', { name: 'Filter by learning language' });
  fireEvent.change(language, { target: { value: 'ja' } });
  fireEvent.change(search, { target: { value: 'look into' } });
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(language).toHaveValue('ja');
  expect(search).toHaveValue('');
  expect(search).toHaveFocus();
  expect(screen.getByRole('heading', { name: '調べる' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'look into' })).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: 'missing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
  expect(search).toHaveValue('');
  expect(language).toHaveValue('all');
  expect(screen.getByRole('heading', { name: 'look into' })).toBeInTheDocument();
});

it('reads stored translations and notes one phrase at a time without creating an edit session or writing', async () => {
  fixture.data!.cards = [
    { ...card, translation: 'この件を調べて。', explanation: 'A request to investigate a topic.' },
    { ...card, id: 'second', term: 'follow up', translation: '続けて確認する。' },
  ];
  const user = userEvent.setup();
  render(<CardsPage />);
  const first = screen.getByRole('button', { name: 'Translation and notes for look into' });
  const second = screen.getByRole('button', { name: 'Translation and notes for follow up' });
  const firstRow = first.closest('article');
  expect(first).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByText('この件を調べて。')).not.toBeVisible();
  await user.click(first);
  expect(first).toHaveFocus();
  expect(first).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('この件を調べて。')).toBeVisible();
  expect(screen.getByText('A request to investigate a topic.')).toBeVisible();
  await user.click(second);
  expect(first).toHaveAttribute('aria-expanded', 'false');
  expect(second).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('この件を調べて。')).not.toBeVisible();
  expect(screen.getByText('続けて確認する。')).toBeVisible();
  expect(first.closest('article')).toBe(firstRow);
  await user.keyboard('{Enter}');
  expect(second).toHaveAttribute('aria-expanded', 'false');
  expect(cardsApi.editState).not.toHaveBeenCalled();
  expect(cardsApi.saveEdit).not.toHaveBeenCalled();
  expect(cardsApi.suspendCard).not.toHaveBeenCalled();
  expect(uiDraftApi.save).not.toHaveBeenCalled();
});

it('finds translation and explanation matches, reveals why they matched, and clears expansion after exclusion or deletion', () => {
  fixture.data!.cards = [
    { ...card, translation: 'この件を調べて。', explanation: 'Used when investigating an unresolved issue.' },
    { ...card, id: 'second', term: 'follow up', translation: undefined, explanation: undefined },
  ];
  const view = render(<CardsPage />);
  const search = screen.getByRole('textbox', { name: 'Search your phrases' });
  fireEvent.change(search, { target: { value: 'UNRESOLVED' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByText('Explanation or notes match:')).toBeVisible();
  expect(document.querySelector('.phrase-search-matches')).toHaveTextContent('unresolved issue');
  const details = screen.getByRole('button', { name: 'Translation and notes for look into' });
  fireEvent.click(details);
  expect(screen.getByText('Used when investigating an unresolved issue.')).toBeVisible();
  fireEvent.change(search, { target: { value: 'follow up' } });
  expect(screen.queryByRole('heading', { name: 'look into' })).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: '調べて' } });
  expect(screen.getByText('Translation match:')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Translation and notes for look into' })).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Translation and notes for look into' }));
  const removed = fixture.data!.cards.shift()!;
  view.rerender(<CardsPage />);
  fixture.data!.cards.push(removed);
  view.rerender(<CardsPage />);
  expect(screen.getByRole('button', { name: 'Translation and notes for look into' })).toHaveAttribute('aria-expanded', 'false');
  fireEvent.change(search, { target: { value: 'undefined' } });
  expect(screen.getByText('No matching phrases')).toBeInTheDocument();
});

it('keeps IME input and retained rows in place while filters remove stale actions immediately', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => ({ cancel: () => {}, finished: new Promise<void>(() => {}) }) });
  try {
    render(<MotionProvider><CardsPage /></MotionProvider>);
    const search = screen.getByRole('textbox', { name: 'Search your phrases' });
    const japaneseRow = screen.getByRole('heading', { name: '調べる' }).closest('article');
    fireEvent.click(screen.getByLabelText('Actions for look into'));
    search.focus();
    fireEvent.compositionStart(search);
    fireEvent.change(search, { target: { value: '調' } });
    expect(screen.getByRole('textbox', { name: 'Search your phrases' })).toBe(search);
    expect(search).toHaveFocus();
    expect(search).toHaveValue('調');
    expect(screen.getByRole('heading', { name: '調べる' }).closest('article')).toBe(japaneseRow);
    expect(screen.queryByRole('heading', { name: 'look into' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-motion-snapshot]')).toBeNull();
    expect(screen.queryByLabelText('Actions for look into')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Edit phrase' })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: '調べる' } });
    fireEvent.compositionEnd(search);
    expect(search).toHaveValue('調べる');
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(search).toHaveFocus();
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  }
});

it.each(['Close', 'Escape', 'backdrop'])('flushes dirty phrase edits when dismissed with %s without confirmation', async method => {
  const close = vi.fn(), user = userEvent.setup();
  render(<EditCardDialog card={card} onClose={close} />);
  await waitFor(() => expect(screen.getByLabelText('Meaning')).toBeEnabled());
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'new meaning' } });
  if (method === 'Escape') await user.keyboard('{Escape}');
  else if (method === 'backdrop') await user.click(document.querySelector('.modal-overlay')!);
  else await user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(screen.queryByRole('dialog', { name: 'Save your changes?' })).not.toBeInTheDocument();
  await waitFor(() => expect(cardsApi.saveEdit).toHaveBeenCalledWith(expect.objectContaining({ id: card.id, meaning: 'new meaning' }), '0'));
  expect(uiDraftApi.save).toHaveBeenCalled();
});

it('keeps inputs editable during save, retains failed changes, and retries inline', async () => {
  const close = vi.fn();
  let fail!: (error: Error) => void;
  vi.mocked(cardsApi.saveEdit).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  render(<EditCardDialog card={card} onClose={close} />);
  await waitFor(() => expect(screen.getByLabelText('Meaning')).toBeEnabled());
  const meaning = screen.getByLabelText('Meaning');
  fireEvent.change(meaning, { target: { value: 'changed meaning' } });
  fireEvent.blur(meaning);
  await waitFor(() => expect(cardsApi.saveEdit).toHaveBeenCalledOnce());
  screen.getAllByRole('textbox').forEach(input => expect(input).toBeEnabled());
  fireEvent.change(meaning, { target: { value: 'newer meaning while saving' } });
  await act(async () => fail(new Error('Save unavailable')));
  expect(await screen.findByRole('alert')).toHaveTextContent('Save unavailable');
  expect(meaning).toHaveValue('newer meaning while saving');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(saved.meaning).toBe('newer meaning while saving'));
  expect(cardsApi.saveEdit).toHaveBeenLastCalledWith(expect.objectContaining({ id: card.id, meaning: 'newer meaning while saving' }), '0');
  expect(close).not.toHaveBeenCalled();
});
