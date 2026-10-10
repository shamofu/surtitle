// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { CardsPage } from '../features/cards/CardsPage';
import { EditCardDialog } from '../features/cards/CardManagement';
import { cardsApi } from '../features/cards/api';
import type { StudyCard } from '../shared/contracts/cards';
import { MotionProvider } from '../shared/motion';

const fixture = vi.hoisted(() => ({
  data: undefined as { cards: StudyCard[]; media: [] } | undefined,
  loading: false,
  error: null as Error | null,
  refresh: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a href={to} className={className}>{children}</a>,
}));
vi.mock('../features/cards/api', () => ({ cardsApi: { editCard: vi.fn(), suspendCard: vi.fn() } }));
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

const card: StudyCard = {
  id: 'english', mediaId: 'media', segmentId: 'cue', term: 'look into', meaning: 'investigate', example: 'Look into this.',
  language: 'en', dueAt: '2030-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', reviewCount: 0, suspended: false,
};
beforeEach(() => {
  fixture.data = { cards: [card, { ...card, id: 'japanese', term: '調べる', language: 'ja' }], media: [] };
  fixture.loading = false;
  fixture.error = null;
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

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
  expect(within(english.closest('details')!).getByRole('button', { name: 'Edit' })).toHaveFocus();
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

it('keeps IME input and retained rows in place while rapid animated filters hide stale actions', () => {
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
    const outgoing = document.querySelector('[data-motion-snapshot] .phrase-options-panel button');
    expect(outgoing).not.toBeNull();
    fireEvent.click(outgoing!);
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

it.each(['Cancel', 'Close', 'Escape', 'backdrop'])('protects dirty phrase edits when dismissed with %s', async (method) => {
  const close = vi.fn();
  render(<EditCardDialog card={card} onClose={close} />);
  const editor = screen.getByRole('dialog', { name: 'Edit phrase' });
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'new meaning' } });
  if (method === 'Escape') fireEvent(editor, new Event('cancel', { cancelable: true }));
  else if (method === 'backdrop') {
    fireEvent.pointerDown(editor);
    fireEvent.pointerUp(editor);
    fireEvent.click(editor);
  } else fireEvent.click(within(editor).getByRole('button', { name: method }));
  const confirmation = screen.getByRole('dialog', { name: 'Save your changes?' });
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Keep editing' }));
  expect(screen.queryByRole('dialog', { name: 'Save your changes?' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Meaning')).toHaveValue('new meaning');
  fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(close).toHaveBeenCalledOnce();
  expect(cardsApi.editCard).not.toHaveBeenCalled();
});

it('locks all editing and dismissal during save, keeps failed changes, then saves from the close confirmation', async () => {
  const close = vi.fn();
  let fail!: (error: Error) => void;
  vi.mocked(cardsApi.editCard).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  render(<EditCardDialog card={card} onClose={close} />);
  const editor = screen.getByRole('dialog', { name: 'Edit phrase' });
  fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'changed meaning' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  screen.getAllByRole('textbox').forEach(input => expect(input).toBeDisabled());
  expect(within(editor).getByRole('button', { name: 'Close' })).toBeDisabled();
  fireEvent(editor, new Event('cancel', { cancelable: true }));
  expect(close).not.toHaveBeenCalled();
  await act(async () => fail(new Error('Save unavailable')));
  expect(screen.getByRole('alert')).toHaveTextContent('Save unavailable');
  expect(screen.getByLabelText('Meaning')).toHaveValue('changed meaning');
  expect(screen.getByLabelText('Meaning')).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  vi.mocked(cardsApi.editCard).mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Save and close' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(cardsApi.editCard).toHaveBeenLastCalledWith(expect.objectContaining({ id: card.id, meaning: 'changed meaning' }));
});
