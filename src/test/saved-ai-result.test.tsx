// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JobActions } from '../components/JobActions';
import { api } from '../api';
import type { JobSummary, SavedAiResult } from '../api';

vi.mock('../api', () => ({ api: { savedAiResults: vi.fn(), applySavedAiResult: vi.fn(), createRetryQuote: vi.fn(), reapproveQuote: vi.fn(), approveQuote: vi.fn(), pauseAiJob: vi.fn(), cancelAiJob: vi.fn() }, nativeAvailable: () => true }));
const registerModal = () => () => {};
vi.mock('../context', () => ({ useApp: () => ({ t: (_ja: string, en: string) => en, run: (action: () => Promise<unknown>) => action(), registerModal }) }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const job: JobSummary = { id: 'saved-job', kind: 'translate', status: 'completed', progress: 1, pendingResults: 1, createdAt: '2026-09-08T00:00:00Z' };
const result: SavedAiResult = { jobId: job.id, ordinal: 0, applied: false, canApply: true, translations: [{ source: 'Hello.', translation: 'こんにちは。', startMs: 0, endMs: 1000 }] };

describe('local recovery of saved AI translations', () => {
  it('previews before explicit application and never creates an approval or sends again', async () => {
    vi.mocked(api.savedAiResults).mockResolvedValueOnce([result]).mockResolvedValueOnce([{ ...result, applied: true, canApply: false }]);
    vi.mocked(api.applySavedAiResult).mockResolvedValue(undefined);
    render(<JobActions job={job} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review saved translations' }));
    await screen.findByRole('dialog');
    expect(screen.getByText('Hello.')).toBeInTheDocument();
    expect(screen.getByText('こんにちは。')).toBeInTheDocument();
    expect(api.applySavedAiResult).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply this translation' }));
    await waitFor(() => expect(api.applySavedAiResult).toHaveBeenCalledExactlyOnceWith('saved-job', 0));
    expect(await screen.findByRole('button', { name: 'Applied' })).toBeDisabled();
    expect(api.createRetryQuote).not.toHaveBeenCalled();
    expect(api.reapproveQuote).not.toHaveBeenCalled();
    expect(api.approveQuote).not.toHaveBeenCalled();
  });

  it('keeps stale output readable while preventing its application', async () => {
    vi.mocked(api.savedAiResults).mockResolvedValue([{ ...result, canApply: false, blockedReason: 'The original subtitles changed.' }]);
    render(<JobActions job={job} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review saved translations' }));
    await screen.findByRole('dialog');
    expect(screen.getByText('こんにちは。')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('The original subtitles changed.');
    expect(screen.getByRole('button', { name: 'Apply this translation' })).toBeDisabled();
    expect(api.applySavedAiResult).not.toHaveBeenCalled();
  });
});
