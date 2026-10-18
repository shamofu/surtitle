// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../native/transport';
import type { DraftKind, EditFields } from '../contracts/editing';

export const uiDraftApi = {
  get: (kind: DraftKind, entityId: string) => call('get_ui_draft', { kind, entityId }),
  save: (kind: DraftKind, entityId: string, expectedRevision: number, fields: EditFields) =>
    call('save_ui_draft', { request: { kind, entityId, expectedRevision, fields } }),
  remove: (kind: DraftKind, entityId: string, expectedRevision: number) =>
    call('delete_ui_draft', { kind, entityId, expectedRevision }),
  archive: (kind: DraftKind, entityId: string, fields: EditFields) =>
    call('archive_ui_draft', { request: { kind, entityId, fields } }),
};
