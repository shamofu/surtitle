// SPDX-License-Identifier: GPL-3.0-or-later
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TransferDialog } from '../components/TransferDialog';
import { api } from '../api';

const modal = vi.hoisted(() => ({ register: () => () => {} }));
vi.mock('../api', () => ({ api: { previewRestore: vi.fn(), discardRestorePreview: vi.fn().mockResolvedValue(undefined), restoreLearning: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('../context', () => ({ useApp: () => ({ registerModal: modal.register, t: (_ja: string, en: string) => en, run: (action: () => Promise<unknown>) => action() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
});
afterAll(() => { Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close'); });
const preview = (token: string) => ({ token, mediaCount: 1, cardCount: 1, reviewCount: 1, audioCount: 1, warnings: ['Reviewed local backup'] });

it('releases only the selected preview token when its dialog is unmounted', async () => {
  vi.mocked(api.previewRestore).mockResolvedValue(preview('owned-preview'));
  const component = render(<TransferDialog onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose backup' }));
  await screen.findByText('Reviewed local backup');
  expect(api.discardRestorePreview).not.toHaveBeenCalled();
  component.unmount();
  expect(api.discardRestorePreview).toHaveBeenCalledExactlyOnceWith('owned-preview');
  expect(api.restoreLearning).not.toHaveBeenCalled();
});

it('discards replaced previews, retains a cancelled picker selection and requires confirmation', async () => {
  vi.mocked(api.previewRestore).mockResolvedValueOnce(preview('first')).mockResolvedValueOnce(preview('second')).mockResolvedValueOnce(null);
  render(<TransferDialog onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose backup' }));
  await screen.findByText('Reviewed local backup');
  fireEvent.click(screen.getByRole('button', { name: 'Choose another' }));
  await waitFor(() => expect(api.discardRestorePreview).toHaveBeenCalledExactlyOnceWith('first'));
  fireEvent.click(screen.getByRole('button', { name: 'Choose another' }));
  await waitFor(() => expect(api.previewRestore).toHaveBeenCalledTimes(3));
  expect(api.discardRestorePreview).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Restore backup' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Restore backup' }));
  await waitFor(() => expect(api.restoreLearning).toHaveBeenCalledExactlyOnceWith('second'));
});

it('discards a native preview that arrives after the dialog was unmounted', async () => {
  let complete!: (value: ReturnType<typeof preview>) => void;
  vi.mocked(api.previewRestore).mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const component = render(<TransferDialog onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose backup' }));
  component.unmount();
  complete(preview('late-native-token'));
  await waitFor(() => expect(api.discardRestorePreview).toHaveBeenCalledExactlyOnceWith('late-native-token'));
  expect(api.restoreLearning).not.toHaveBeenCalled();
});
