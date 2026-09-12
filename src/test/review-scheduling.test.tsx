// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ReviewPage } from '../pages/Cards';
import { api } from '../api';
import type { StudyCard } from '../api';

let cards: StudyCard[];
vi.mock('../api', () => ({ api: { rateCard: vi.fn() } }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('../context', () => ({ useApp: () => ({
  data: { cards, media: [] }, locale: 'en', t: (_ja: string, en: string) => en,
  run: async (action: () => Promise<unknown>) => { try { return await action(); } catch { return undefined; } },
}) }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
  cards = [{ id: 'card', mediaId: 'media', segmentId: 'cue', term: 'look into', meaning: 'investigate',
    example: 'We will look into this.', language: 'en', dueAt: new Date(Date.now() - 1).toISOString(),
    createdAt: new Date().toISOString(), reviewCount: 0, suspended: false }];
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

async function rateAgain() {
  fireEvent.click(screen.getByRole('button', { name: /Reveal meaning/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Again/ })); });
}

it('returns an Again card at its new due time without leaving the page, with its answer concealed', async () => {
  vi.mocked(api.rateCard).mockImplementation(async () => {
    cards = [{ ...cards[0], reviewCount: cards[0].reviewCount + 1, dueAt: new Date(Date.now() + 60_000).toISOString() }];
  });
  render(<ReviewPage />);
  await rateAgain();
  expect(screen.queryByText('look into')).not.toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(59_999); });
  expect(screen.queryByText('look into')).not.toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(screen.getByText('look into')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Reveal meaning/ })).toBeInTheDocument();
  expect(screen.queryByText('investigate')).not.toBeInTheDocument();
  expect(api.rateCard).toHaveBeenCalledExactlyOnceWith('card', 'again');
});

it('does not resubmit a successfully rated stale schedule while awaiting a fresh snapshot', async () => {
  vi.mocked(api.rateCard).mockResolvedValue(undefined);
  const view = render(<ReviewPage />);
  await rateAgain();
  await act(async () => { vi.advanceTimersByTime(120_000); });
  view.rerender(<ReviewPage />);
  expect(screen.queryByText('look into')).not.toBeInTheDocument();
  expect(api.rateCard).toHaveBeenCalledOnce();
});

it('keeps a failed rating available and excludes a subsequently suspended schedule', async () => {
  vi.mocked(api.rateCard).mockRejectedValue(new Error('Store unavailable'));
  const view = render(<ReviewPage />);
  await rateAgain();
  expect(screen.getByText('investigate')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Again/ })).toBeEnabled();
  cards = [{ ...cards[0], suspended: true }];
  view.rerender(<ReviewPage />);
  expect(screen.queryByText('look into')).not.toBeInTheDocument();
});
