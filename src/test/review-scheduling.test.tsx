// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { ReviewPage } from '../features/cards/ReviewPage';
import { cardsApi } from '../features/cards/api';
import type { StudyCard } from '../shared/contracts/cards';

let cards: StudyCard[];
let surfaceHidden = false;
const motion = vi.hoisted(() => ({ reduced: true }));

vi.mock('../shared/motion', async (importOriginal) => ({
  ...await importOriginal<typeof import('../shared/motion')>(),
  useAppMotion: () => ({ reducedMotion: motion.reduced }),
}));

vi.mock('../features/cards/api', () => ({ cardsApi: { rateCard: vi.fn() } }));

vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock('../app/runtime', () => {
  const useFixture = () => ({
    mutate: (action: () => Promise<unknown>) => action(),
    data: { cards, media: [] },
    surfaceHidden,
    locale: 'en',
    t: (_ja: string, en: string) => en,
    report: async (action: () => Promise<unknown>) => {
      try {
        return await action();
      } catch {
        return undefined;
      }
    },
  });
  return {
    useSnapshot: useFixture,
    useDataActions: useFixture,
    useAppearance: useFixture,
    useNotifications: useFixture,
    useSurface: useFixture,
  };
});

beforeEach(() => {
  surfaceHidden = false;
  motion.reduced = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
  cards = [
    {
      id: 'card',
      mediaId: 'media',
      segmentId: 'cue',
      term: 'look into',
      meaning: 'investigate',
      example: 'We will look into this.',
      language: 'en',
      dueAt: new Date(Date.now() - 1).toISOString(),
      createdAt: new Date().toISOString(),
      reviewCount: 0,
      suspended: false,
    },
  ];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function rateAgain() {
  fireEvent.click(screen.getByRole('button', { name: /Reveal meaning/ }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Again/ }));
  });
}

it('returns an Again card at its new due time without leaving the page, with its answer concealed', async () => {
  vi.mocked(cardsApi.rateCard).mockImplementation(async () => {
    cards = [
      {
        ...cards[0],
        reviewCount: cards[0].reviewCount + 1,
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
  });
  render(<ReviewPage />);
  await rateAgain();
  expect(screen.queryByText('look into')).not.toBeInTheDocument();
  await act(async () => {
    vi.advanceTimersByTime(59_999);
  });
  expect(screen.queryByText('look into')).not.toBeInTheDocument();
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(screen.getByText('look into')).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: /Reveal meaning/ }),
  ).toBeInTheDocument();
  expect(screen.queryByText('investigate')).not.toBeInTheDocument();
  expect(cardsApi.rateCard).toHaveBeenCalledExactlyOnceWith('card', 'again');
});

it('does not resubmit a successfully rated stale schedule while awaiting a fresh snapshot', async () => {
  vi.mocked(cardsApi.rateCard).mockResolvedValue(undefined);
  const view = render(<ReviewPage />);
  await rateAgain();
  await act(async () => {
    vi.advanceTimersByTime(120_000);
  });
  view.rerender(<ReviewPage />);
  expect(screen.queryByText('look into')).not.toBeInTheDocument();
  expect(cardsApi.rateCard).toHaveBeenCalledOnce();
});

it('keeps a failed rating available and excludes a subsequently suspended schedule', async () => {
  vi.mocked(cardsApi.rateCard).mockRejectedValue(
    new Error('Store unavailable'),
  );
  const view = render(<ReviewPage />);
  await rateAgain();
  expect(screen.getByText('investigate')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Again/ })).toBeEnabled();
  cards = [{ ...cards[0], suspended: true }];
  view.rerender(<ReviewPage />);
  expect(screen.queryByText('look into')).not.toBeInTheDocument();
});

it('leaves composing, modified, repeated, and already handled keys alone while retaining review shortcuts', async () => {
  render(<ReviewPage />);
  fireEvent.keyDown(document.body, { code: 'Space', key: ' ', ctrlKey: true });
  fireEvent.keyDown(document.body, { code: 'Space', key: ' ', isComposing: true });
  fireEvent.keyDown(document.body, { code: 'Space', key: ' ', repeat: true });
  const handled = new KeyboardEvent('keydown', { code: 'Space', key: ' ', cancelable: true, bubbles: true });
  handled.preventDefault();
  fireEvent(document.body, handled);
  expect(screen.queryByText('investigate')).not.toBeInTheDocument();
  fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
  expect(screen.getByText('investigate')).toBeInTheDocument();
  fireEvent.keyDown(document.body, { key: '1', ctrlKey: true });
  fireEvent.keyDown(document.body, { key: '1', repeat: true });
  expect(cardsApi.rateCard).not.toHaveBeenCalled();
  await act(async () => { fireEvent.keyDown(document.body, { key: '1' }); });
  expect(cardsApi.rateCard).toHaveBeenCalledExactlyOnceWith('card', 'again');
});

it('does not reveal or rate behind a modal or from focused disclosure and editable content', () => {
  surfaceHidden = true;
  const view = render(<ReviewPage />);
  fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
  expect(screen.queryByText('investigate')).not.toBeInTheDocument();
  surfaceHidden = false;
  view.rerender(<ReviewPage />);
  render(<><details><summary>Details</summary></details><div contentEditable suppressContentEditableWarning>Editable notes</div></>);
  fireEvent.keyDown(screen.getByText('Details'), { code: 'Space', key: ' ' });
  fireEvent.keyDown(screen.getByText('Editable notes'), { code: 'Space', key: ' ' });
  expect(screen.queryByText('investigate')).not.toBeInTheDocument();
  fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
  surfaceHidden = true;
  view.rerender(<ReviewPage />);
  fireEvent.keyDown(document.body, { key: '1' });
  expect(cardsApi.rateCard).not.toHaveBeenCalled();
});

it('retains an inert rated card until its bounded exit finishes, then enables only the next card', async () => {
  motion.reduced = false;
  cards.push({ ...cards[0], id: 'next', term: 'Another phrase' });
  render(<ReviewPage />);
  await rateAgain();
  const outgoing = screen.getByText('look into').closest('.review-transition');
  expect(outgoing).toHaveAttribute('inert');
  expect(outgoing).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByText('Another phrase')).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: '1' });
  expect(cardsApi.rateCard).toHaveBeenCalledOnce();
  await act(async () => { vi.advanceTimersByTime(120); });
  expect(screen.queryByText('look into')).not.toBeInTheDocument();
  expect(screen.getByText('Another phrase')).toBeInTheDocument();
  fireEvent.keyDown(window, { key: '1' });
  expect(cardsApi.rateCard).toHaveBeenCalledOnce();
  fireEvent.keyDown(window, { code: 'Space', key: ' ' });
  await act(async () => { fireEvent.keyDown(window, { key: '1' }); });
  expect(cardsApi.rateCard).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Review complete')).not.toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(120); });
  expect(screen.getByText('Review complete')).toBeInTheDocument();
});

it('finishes an active review exit immediately when motion is reduced', async () => {
  motion.reduced = false;
  const view = render(<ReviewPage />);
  await rateAgain();
  expect(screen.getByText('look into')).toBeInTheDocument();
  motion.reduced = true;
  view.rerender(<ReviewPage />);
  expect(screen.queryByText('look into')).not.toBeInTheDocument();
  expect(screen.getByText('Review complete')).toBeInTheDocument();
});

it('cancels an old exit when the same schedule becomes present again', async () => {
  motion.reduced = false;
  const original = cards;
  const view = render(<ReviewPage />);
  cards = [];
  view.rerender(<ReviewPage />);
  expect(screen.getByText('look into').closest('.review-transition')).toHaveAttribute('inert');
  cards = original;
  view.rerender(<ReviewPage />);
  await act(async () => { vi.advanceTimersByTime(120); });
  expect(screen.getByText('look into').closest('.review-transition')).not.toHaveAttribute('inert');
  fireEvent.keyDown(window, { code: 'Space', key: ' ' });
  expect(screen.getByText('investigate')).toBeInTheDocument();
  expect(screen.queryByText('Review complete')).not.toBeInTheDocument();
});
