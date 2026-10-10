// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JobActions } from '../features/ai/JobActions';
import { aiApi } from '../features/ai/api';
import type { AiQuote, JobSummary } from '../shared/contracts/ai';

const fixture = vi.hoisted(() => ({ reduced: false, errors: [] as string[] }));
vi.mock('../shared/motion', () => ({
  motionDurations: { enter: 0.18, exit: 0.12, fast: 0.12 },
  motionEase: [0.2, 0, 0, 1],
  useAppMotion: () => ({ reducedMotion: fixture.reduced }),
}));
vi.mock('../features/ai/api', () => ({ aiApi: { createRetryQuote: vi.fn(), reapproveQuote: vi.fn() } }));
vi.mock('../app/runtime', () => {
  const useFixture = () => ({
    t: (_ja: string, en: string) => en,
    mutate: (action: () => Promise<unknown>) => action(),
    report: async (action: () => Promise<unknown>) => {
      try { return await action(); } catch (error) { fixture.errors.push(String(error)); return undefined; }
    },
  });
  return { useSnapshot: useFixture, useDataActions: useFixture, useAppearance: useFixture, useNotifications: useFixture, useSurface: useFixture };
});

const job: JobSummary = { id: 'paused', kind: 'transcribe', status: 'paused', progress: 0.5, createdAt: '2026-09-08T00:00:00Z' };
const quote: AiQuote = {
  id: 'retry', mediaId: 'media', kind: 'transcribe', startMs: 0, endMs: 2000,
  model: 'test', estimatedUsd: null, maximumUsd: null, unpriced: true,
  inputTokens: 100, maxOutputTokens: 100, expiresAt: '2099-01-01T00:00:00Z',
  warnings: [], canApprove: true, isRetry: true,
};
beforeEach(() => {
  vi.useFakeTimers();
  fixture.reduced = false;
  fixture.errors = [];
  vi.mocked(aiApi.createRetryQuote).mockResolvedValue(quote);
  vi.mocked(aiApi.reapproveQuote).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

async function openQuote() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resume remaining work' })); });
  return screen.getByRole('region', { name: 'Review remaining work' });
}

it('retains a closing inline quote while locking approval and removes it before a fresh quote can reopen', async () => {
  render(<JobActions job={job} inlineTranscription />);
  const panel = await openQuote();
  fireEvent.click(screen.getByRole('checkbox'));
  const approval = screen.getByRole('button', { name: 'Start transcription' });
  expect(approval).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(panel).toHaveAttribute('data-state', 'closing');
  expect(panel).toHaveAttribute('inert');
  expect(panel).toHaveAttribute('aria-hidden', 'true');
  expect(approval).toBeDisabled();
  fireEvent.click(approval);
  expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(119); });
  expect(panel).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(panel).not.toBeInTheDocument();
  const reopened = await openQuote();
  expect(reopened).toHaveAttribute('data-state', 'open');
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  await act(async () => { vi.advanceTimersByTime(240); });
  expect(reopened).toBeInTheDocument();
  expect(aiApi.createRetryQuote).toHaveBeenCalledTimes(2);
});

it('closes after successful approval without sending another request during exit', async () => {
  render(<JobActions job={job} inlineTranscription />);
  const panel = await openQuote();
  fireEvent.click(screen.getByRole('checkbox'));
  const approval = screen.getByRole('button', { name: 'Start transcription' });
  await act(async () => { fireEvent.click(approval); });
  expect(panel).toHaveAttribute('data-state', 'closing');
  fireEvent.click(approval);
  expect(aiApi.reapproveQuote).toHaveBeenCalledExactlyOnceWith(quote);
  await act(async () => { vi.advanceTimersByTime(120); });
  expect(panel).not.toBeInTheDocument();
});

it('keeps the same acknowledged quote available when approval fails', async () => {
  vi.mocked(aiApi.reapproveQuote).mockRejectedValueOnce(new Error('Connection failed'));
  render(<JobActions job={job} inlineTranscription />);
  const panel = await openQuote();
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start transcription' })); });
  expect(panel).toHaveAttribute('data-state', 'open');
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(screen.getByRole('button', { name: 'Start transcription' })).toBeEnabled();
  expect(fixture.errors).toEqual(['Error: Connection failed']);
});

it('removes inline quotes synchronously with reduced motion', async () => {
  fixture.reduced = true;
  render(<JobActions job={job} inlineTranscription />);
  const panel = await openQuote();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(panel).not.toBeInTheDocument();
});
