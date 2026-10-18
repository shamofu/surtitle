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
