// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JobActions } from '../components/JobActions';
import { api } from '../api';
import type { AiQuote, JobSummary } from '../api';

const quote: AiQuote = { id: 'fresh-retry', mediaId: 'media', kind: 'translate', startMs: 1000, endMs: 2000, model: 'test-model', estimatedUsd: .02, maximumUsd: .03, inputTokens: 100, maxOutputTokens: 100, expiresAt: '2099-01-01T00:00:00Z', warnings: ['A previous request may already have incurred a charge.'], canApprove: true, isRetry: true };
vi.mock('../api', () => ({ api: { createRetryQuote: vi.fn(), reapproveQuote: vi.fn().mockResolvedValue(undefined), approveQuote: vi.fn(), resolveUnknownAttempt: vi.fn(), pauseAiJob: vi.fn(), cancelAiJob: vi.fn() }, nativeAvailable: () => true }));
const registerModal = () => () => {};
vi.mock('../context', () => ({ useApp: () => ({ t: (_ja: string, en: string) => en, run: (action: () => Promise<unknown>) => action(), registerModal }) }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('fresh approval for remaining AI work', () => {
  const job: JobSummary = { id: 'paused-job', kind: 'translate', status: 'paused', progress: .5, createdAt: '2026-09-08T00:00:00Z' };
  it('only requests a quote at first, then requires its explicit checkbox to retry', async () => {
    vi.mocked(api.createRetryQuote).mockResolvedValue(quote);
    render(<JobActions job={job} />);
    fireEvent.click(screen.getByRole('button', { name: 'Estimate remaining work' }));
    await screen.findByRole('dialog');
    expect(api.createRetryQuote).toHaveBeenCalledWith('paused-job');
    expect(api.reapproveQuote).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Approve this job' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve this job' }));
    await waitFor(() => expect(api.reapproveQuote).toHaveBeenCalledWith(quote));
    expect(api.approveQuote).not.toHaveBeenCalled();
    expect(api.resolveUnknownAttempt).not.toHaveBeenCalled();
  });
  it('does not offer a retry for a finally cancelled job', () => {
    render(<JobActions job={{ ...job, status: 'cancelled' }} />);
    expect(screen.queryByRole('button', { name: 'Estimate remaining work' })).not.toBeInTheDocument();
  });
});
