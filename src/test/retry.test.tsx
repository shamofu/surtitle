// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { JobActions } from '../features/ai/JobActions';
import { aiApi } from '../features/ai/api';
import type { AiQuote } from '../shared/contracts/ai';
import type { JobSummary } from '../shared/contracts/ai';

const quote: AiQuote = {
  id: 'fresh-retry',
  mediaId: 'media',
  kind: 'translate',
  startMs: 1000,
  endMs: 2000,
  model: 'test-model',
  estimatedUsd: 0.02,
  maximumUsd: 0.03,
  inputTokens: 100,
  maxOutputTokens: 100,
  expiresAt: '2099-01-01T00:00:00Z',
  warnings: ['A previous request may already have incurred a charge.'],
  canApprove: true,
  isRetry: true,
};

vi.mock('../features/ai/api', () => ({
  aiApi: {
    createRetryQuote: vi.fn(),
    reapproveQuote: vi.fn().mockResolvedValue(undefined),
    approveQuote: vi.fn(),
    resolveUnknownAttempt: vi.fn(),
    pauseAiJob: vi.fn(),
    cancelAiJob: vi.fn(),
    retryAiApplication: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
const registerModal = () => () => {};
vi.mock('../app/runtime', () => {
  const useFixture = () => ({
    mutate: (action: () => Promise<unknown>) => action(),
    t: (_ja: string, en: string) => en,
    report: (action: () => Promise<unknown>) => action(),
    registerModal,
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
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('fresh approval for remaining AI work', () => {
  const job: JobSummary = {
    id: 'paused-job',
    kind: 'translate',
    status: 'paused',
    progress: 0.5,
    createdAt: '2026-09-08T00:00:00Z',
  };
  it('only requests a quote at first, then requires its explicit checkbox to retry', async () => {
    vi.mocked(aiApi.createRetryQuote).mockResolvedValue(quote);
    render(<JobActions job={job} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Estimate remaining work' }),
    );
    await screen.findByRole('dialog');
    expect(aiApi.createRetryQuote).toHaveBeenCalledWith('paused-job');
    expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Approve this job' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve this job' }));
    await waitFor(() =>
      expect(aiApi.reapproveQuote).toHaveBeenCalledWith(quote),
    );
    expect(aiApi.approveQuote).not.toHaveBeenCalled();
    expect(aiApi.resolveUnknownAttempt).not.toHaveBeenCalled();
  });
  it('does not offer a retry for a finally cancelled job', () => {
    render(<JobActions job={{ ...job, status: 'cancelled' }} />);
    expect(
      screen.queryByRole('button', { name: 'Estimate remaining work' }),
    ).not.toBeInTheDocument();
  });
  it('offers only local application when every response has already arrived', async () => {
    render(<JobActions job={{ ...job, status: 'failed', progress: 1, issue: { code: 'local_apply', phase: 'apply', occurredAt: '', nextAction: 'retry_local' } }} />);
    expect(screen.queryByRole('button', { name: 'Estimate remaining work' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry applying saved results' }));
    await waitFor(() => expect(aiApi.retryAiApplication).toHaveBeenCalledExactlyOnceWith(job.id));
    expect(aiApi.createRetryQuote).not.toHaveBeenCalled();
    expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
  });
});
