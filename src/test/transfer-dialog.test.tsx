// SPDX-License-Identifier: GPL-3.0-or-later
vi.mock('../app/providers/Activities', () => import('./activity-fixture'));
vi.mock('../features/ai/PreparationSessions', () => ({ useClearPreparationSessions: () => () => {} }));
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { TransferDialog } from '../features/transfer/TransferDialog';
import { transferApi } from '../features/transfer/api';
import { clearEditorDraftSessions, flushEditorDrafts } from '../features/study/editor-drafts/useEditorDraft';

const modal = vi.hoisted(() => ({ register: () => () => {} }));
vi.mock('../features/study/editor-drafts/useEditorDraft', () => ({
  flushEditorDrafts: vi.fn().mockResolvedValue(undefined),
  clearEditorDraftSessions: vi.fn(),
}));

vi.mock('../features/transfer/api', () => ({
  transferApi: {
    exportLearning: vi.fn(),
    revealExportFile: vi.fn().mockResolvedValue(undefined),
    previewRestore: vi.fn(),
    discardRestorePreview: vi.fn().mockResolvedValue(undefined),
    restoreLearning: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../app/runtime', () => {
  const useFixture = () => ({
    mutate: (action: () => Promise<unknown>) => action(),
    registerModal: modal.register,
    t: (_ja: string, en: string) => en,
    report: async (action: () => Promise<unknown>) => { try { return await action(); } catch { return undefined; } },
  });
  return {
    useSnapshot: useFixture,
    useDataActions: useFixture,
    useAppearance: useFixture,
    useNotifications: useFixture,
    useSurface: useFixture,
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});
const preview = (token: string) => ({
  token,
  mediaCount: 1,
  cardCount: 1,
  reviewCount: 1,
  audioCount: 1,
  warnings: ['Reviewed local backup'],
});

it('exports this media by default and shows both original and translated output paths', async () => {
  const close = vi.fn();
  vi.mocked(transferApi.exportLearning).mockResolvedValue(['C:/exports/video.srt', 'C:/exports/video.translation.srt']);
  render(<TransferDialog mediaId="video" onClose={close} />);
  expect(screen.getByRole('button', { name: /SRT/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText(/Scope: subtitles for this media/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination' }));
  await screen.findByText('C:/exports/video.translation.srt');
  expect(transferApi.exportLearning).toHaveBeenCalledWith('srt', 'video');
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole('button', { name: 'Open containing folder' })[1]);
  expect(transferApi.revealExportFile).toHaveBeenCalledWith('C:/exports/video.translation.srt');
});

it('clearly labels all-data and all-phrase exports and retains the dialog after picker cancellation', async () => {
  vi.mocked(transferApi.exportLearning).mockResolvedValue([]);
  const close = vi.fn();
  render(<TransferDialog onClose={close} />);
  expect(screen.getByText('Scope: all learning data')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /CSV/ }));
  expect(screen.getByText('Scope: phrases from all media')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination' }));
  await waitFor(() => expect(transferApi.exportLearning).toHaveBeenCalledWith('csv', undefined));
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByText('Your export is ready.')).not.toBeInTheDocument();
});

it('waits for pending editor changes before creating a backup', async () => {
  let finish!: () => void;
  vi.mocked(flushEditorDrafts).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  vi.mocked(transferApi.exportLearning).mockResolvedValue(['C:/exports/backup.zip']);
  render(<TransferDialog onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination' }));
  expect(flushEditorDrafts).toHaveBeenCalledOnce();
  expect(transferApi.exportLearning).not.toHaveBeenCalled();
  finish();
  await screen.findByText('C:/exports/backup.zip');
  expect(clearEditorDraftSessions).not.toHaveBeenCalled();
});

it('keeps export progress visible and dismissal locked until the export settles', async () => {
  let finish!: (paths: string[]) => void;
  vi.mocked(transferApi.exportLearning).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const close = vi.fn();
  render(<TransferDialog onClose={close} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination' }));
  const bar = await screen.findByRole('progressbar', { name: 'Export learning data' });
  expect(bar).not.toHaveAttribute('value');
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(close).not.toHaveBeenCalled();
  finish(['C:/exports/backup.zip']);
  await screen.findByText('Your export is ready.');
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});

it('removes export progress and unlocks retry when writing fails', async () => {
  vi.mocked(transferApi.exportLearning).mockRejectedValueOnce(new Error('Disk full'));
  render(<TransferDialog onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose destination' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Choose destination' })).toBeEnabled());
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.queryByText('Your export is ready.')).not.toBeInTheDocument();
});

it('releases only the selected preview token when its dialog is unmounted', async () => {
  vi.mocked(transferApi.previewRestore).mockResolvedValue(
    preview('owned-preview'),
  );
  const component = render(<TransferDialog onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose backup' }));
  await screen.findByText('Reviewed local backup');
  expect(transferApi.discardRestorePreview).not.toHaveBeenCalled();
  component.unmount();
  expect(transferApi.discardRestorePreview).toHaveBeenCalledExactlyOnceWith(
    'owned-preview',
  );
  expect(transferApi.restoreLearning).not.toHaveBeenCalled();
});

it('discards replaced previews, retains a cancelled picker selection and requires confirmation', async () => {
  vi.mocked(transferApi.previewRestore)
    .mockResolvedValueOnce(preview('first'))
    .mockResolvedValueOnce(preview('second'))
    .mockResolvedValueOnce(null);
  render(<TransferDialog onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose backup' }));
  await screen.findByText('Reviewed local backup');
  fireEvent.click(screen.getByRole('button', { name: 'Choose another' }));
  await waitFor(() =>
    expect(transferApi.discardRestorePreview).toHaveBeenCalledExactlyOnceWith(
      'first',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Choose another' }));
  await waitFor(() =>
    expect(transferApi.previewRestore).toHaveBeenCalledTimes(3),
  );
  expect(transferApi.discardRestorePreview).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Restore backup' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Restore backup' }));
  await waitFor(() =>
    expect(transferApi.restoreLearning).toHaveBeenCalledExactlyOnceWith(
      'second',
    ),
  );
  expect(flushEditorDrafts).toHaveBeenCalledOnce();
  expect(clearEditorDraftSessions).toHaveBeenCalledOnce();
  expect(vi.mocked(flushEditorDrafts).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(transferApi.restoreLearning).mock.invocationCallOrder[0]);
  expect(vi.mocked(transferApi.restoreLearning).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(clearEditorDraftSessions).mock.invocationCallOrder[0]);
});

it('discards a native preview that arrives after the dialog was unmounted', async () => {
  let complete!: (value: ReturnType<typeof preview>) => void;
  vi.mocked(transferApi.previewRestore).mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const component = render(<TransferDialog onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose backup' }));
  component.unmount();
  complete(preview('late-native-token'));
  await waitFor(() =>
    expect(transferApi.discardRestorePreview).toHaveBeenCalledExactlyOnceWith(
      'late-native-token',
    ),
  );
  expect(transferApi.restoreLearning).not.toHaveBeenCalled();
});
