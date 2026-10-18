// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../shared/native/transport';
import type { ExportFormat } from '../../shared/contracts/transfer';

export const transferApi = {
  exportLearning: (format: ExportFormat, mediaId?: string) =>
    call('export_learning', { format, mediaId }),
  revealExportFile: (path: string) => call('reveal_export_file', { path }),
  previewRestore: () => call('preview_restore'),
  discardRestorePreview: (token: string) =>
    call('discard_restore_preview', { token }),
  restoreLearning: (token: string) => call('restore_learning', { token }),
};
