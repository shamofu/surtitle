// SPDX-License-Identifier: GPL-3.0-or-later
import { vi } from 'vitest';
import type { UiDraft } from '../shared/contracts/editing';
export const uiDraftApi = {
  get: vi.fn(async () => null), remove: vi.fn(async () => {}),
  archive: vi.fn(async (kind: UiDraft['kind'], entityId: string, fields: Record<string, string>): Promise<UiDraft> =>
    ({ kind, entityId, fields, revision: 1, stale: true, updatedAt: '', archiveId: 'archive' })),
  save: vi.fn(async (kind: UiDraft['kind'], entityId: string, expectedRevision: number, fields: Record<string, string>): Promise<UiDraft> =>
    ({ kind, entityId, revision: expectedRevision + 1, fields, updatedAt: '', stale: false })),
};
