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
import type { JobSummary } from '../shared/contracts/ai';
import type { SavedAiResult } from '../shared/contracts/ai';

vi.mock('../features/ai/api', () => ({
  aiApi: {
    savedAiResults: vi.fn(),
    applySavedAiResult: vi.fn(),
    createRetryQuote: vi.fn(),
    reapproveQuote: vi.fn(),
    approveQuote: vi.fn(),
    pauseAiJob: vi.fn(),
    cancelAiJob: vi.fn(),
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
  vi.resetAllMocks();
});

const job: JobSummary = {
  id: 'saved-job',
  kind: 'translate',
  status: 'completed',
  progress: 1,
  pendingResults: 1,
  createdAt: '2026-09-08T00:00:00Z',
};
const result: SavedAiResult = {
  jobId: job.id,
  ordinal: 0,
  applied: false,
  canApply: true,
  translations: [
    { source: 'Hello.', translation: 'こんにちは。', startMs: 0, endMs: 1000 },
  ],
};

describe('local recovery of saved AI translations', () => {
  it('previews before explicit application and never creates an approval or sends again', async () => {
    vi.mocked(aiApi.savedAiResults)
      .mockResolvedValueOnce([result])
      .mockResolvedValueOnce([{ ...result, applied: true, canApply: false }]);
    vi.mocked(aiApi.applySavedAiResult).mockResolvedValue(undefined);
    render(<JobActions job={job} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Review saved translations' }),
    );
    await screen.findByRole('dialog');
    expect(screen.getByText('Hello.')).toBeInTheDocument();
    expect(screen.getByText('こんにちは。')).toBeInTheDocument();
    expect(aiApi.applySavedAiResult).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Apply this translation' }),
    );
    await waitFor(() =>
      expect(aiApi.applySavedAiResult).toHaveBeenCalledExactlyOnceWith(
        'saved-job',
        0,
      ),
    );
    expect(
      await screen.findByRole('button', { name: 'Applied' }),
    ).toBeDisabled();
    expect(aiApi.createRetryQuote).not.toHaveBeenCalled();
    expect(aiApi.reapproveQuote).not.toHaveBeenCalled();
    expect(aiApi.approveQuote).not.toHaveBeenCalled();
  });

  it('keeps stale output readable while preventing its application', async () => {
    vi.mocked(aiApi.savedAiResults).mockResolvedValue([
      {
        ...result,
        canApply: false,
        blockedReason: 'The original subtitles changed.',
      },
    ]);
    render(<JobActions job={job} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Review saved translations' }),
    );
    await screen.findByRole('dialog');
    expect(screen.getByText('こんにちは。')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'The original subtitles changed.',
    );
    expect(
      screen.getByRole('button', { name: 'Apply this translation' }),
    ).toBeDisabled();
    expect(aiApi.applySavedAiResult).not.toHaveBeenCalled();
  });
});
