// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditDialog } from '../features/study/StudyDialogs';
import { studyApi } from '../features/study/api';
import type { SubtitleSegment } from '../shared/contracts/media';

vi.mock('../features/study/api', () => ({
  studyApi: { editSegment: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../app/runtime', () => {
  const registerModal = () => () => {};
  return {
    useAppearance: () => ({ t: (_ja: string, en: string) => en }),
    useNotifications: () => ({
      report: (action: () => Promise<unknown>) => action(),
    }),
    useDataActions: () => ({
      mutate: (action: () => Promise<unknown>) => action(),
    }),
    useSurface: () => ({ registerModal }),
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

it('explains a forced audio boundary while retaining the original repeated subtitle', async () => {
  const segment: SubtitleSegment = { id: 'cue', mediaId: 'media', startMs: 125, endMs: 875,
    text: 'Again, again.', status: 'generated_review', reviewIssues: [{ id: 'forced', kind: 'forced_chunk_boundary',
      startMs: 500, endMs: 1500, alternatives: [] }] };
  render(<EditDialog segment={segment} onClose={vi.fn()} />);
  await userEvent.setup().click(screen.getByText('Automatic subtitle notes and alternatives'));
  expect(screen.getByText(/Audio was split without a detected pause/)).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Subtitle' })).toHaveValue('Again, again.');
  expect(studyApi.editSegment).not.toHaveBeenCalled();
});

it('replaces controlled subtitle text without appending or rounding the persisted interval', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const segment: SubtitleSegment = {
    id: 'cue',
    mediaId: 'media',
    startMs: 125,
    endMs: 875,
    text: 'Milliseconds matter.',
    translation: 'Original translation.',
    status: 'confirmed',
  };
  render(<EditDialog segment={segment} onClose={onClose} />);
  const input = screen.getByRole('textbox', { name: 'Subtitle' });
  await user.clear(input);
  expect(input).toHaveValue('');
  await user.type(input, 'Milliseconds survive a text-only edit.');
  expect(input).toHaveValue('Milliseconds survive a text-only edit.');
  await user.click(screen.getByRole('button', { name: 'Confirm and save' }));
  expect(studyApi.editSegment).toHaveBeenCalledExactlyOnceWith({
    ...segment,
    text: 'Milliseconds survive a text-only edit.',
  });
  expect(onClose).toHaveBeenCalledExactlyOnceWith();
});
