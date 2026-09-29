// SPDX-License-Identifier: GPL-3.0-or-later
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

const modal = vi.hoisted(() => ({ register: () => () => {} }));

vi.mock('../features/transfer/api', () => ({
  transferApi: {
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
    report: (action: () => Promise<unknown>) => action(),
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
