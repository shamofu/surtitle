// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../shared/native/transport';
import type {
  RestorePreview,
  ExportFormat,
} from '../../shared/contracts/transfer';

export const transferApi = {
  exportLearning: (format: ExportFormat, mediaId?: string) =>
    call<string>('export_learning', { format, mediaId }),
  previewRestore: () => call<RestorePreview | null>('preview_restore'),
  discardRestorePreview: (token: string) =>
    call<void>('discard_restore_preview', { token }),
  restoreLearning: (token: string) => call<void>('restore_learning', { token }),
};
