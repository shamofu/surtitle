// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { ImportWorkspace } from '../features/library/import-workspace';
import { uiDraftApi } from '../shared/editing/drafts';
import type { UiDraft } from '../shared/contracts/editing';
vi.mock('../shared/editing/drafts', () => ({ uiDraftApi: { get: vi.fn(), save: vi.fn(), archive: vi.fn() } }));
afterEach(() => vi.resetAllMocks());
const stored: UiDraft = { kind: 'import', entityId: 'default', revision: 7, updatedAt: '', stale: false,
  fields: { mode: 'url', url: 'https://old.example/video', learningLanguage: 'fr', explanationLanguage: 'ja', rows: '[]' } };
function saving() {
  vi.mocked(uiDraftApi.save).mockImplementation(async (kind, entityId, expectedRevision, fields) => {
    expect(expectedRevision).toBe(7);
    return { kind, entityId, revision: 8, fields, updatedAt: '', stale: false };
  });
}
it('retains input typed during initialization and writes only after loading the durable revision', async () => {
  let finish!: (draft: UiDraft) => void;
  vi.mocked(uiDraftApi.get).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  saving();
  const workspace = new ImportWorkspace();
  const initialization = workspace.initialize('en', 'ja');
  workspace.change({ mode: 'url', url: 'https://new.example/lesson' });
  const flush = workspace.flush();
  expect(uiDraftApi.save).not.toHaveBeenCalled();
  finish(stored); await initialization; await flush;
  expect(workspace.getSnapshot()).toMatchObject({ ready: true, url: 'https://new.example/lesson', learningLanguage: 'fr' });
  expect(uiDraftApi.save).toHaveBeenCalledExactlyOnceWith('import', 'default', 7, expect.objectContaining({ url: 'https://new.example/lesson' }));
  expect(workspace.pending).toBe(false);
});
it('preserves early input through a failed initial read and offers a retry using the actual revision', async () => {
  vi.mocked(uiDraftApi.get).mockRejectedValue(Error('Temporarily unavailable'));
  saving();
  const workspace = new ImportWorkspace();
  const initialization = workspace.initialize('en', 'ja');
  workspace.change({ url: 'https://keep.example/lesson' });
  await initialization;
  await expect(workspace.flush()).rejects.toThrow('Temporarily unavailable');
  expect(workspace.getSnapshot()).toMatchObject({ ready: false, url: 'https://keep.example/lesson' });
  expect(uiDraftApi.save).not.toHaveBeenCalled();
  vi.mocked(uiDraftApi.get).mockResolvedValue(stored);
  await workspace.flush();
  expect(workspace.getSnapshot()).toMatchObject({ ready: true, url: 'https://keep.example/lesson', error: undefined });
  expect(uiDraftApi.save).toHaveBeenCalledExactlyOnceWith('import', 'default', 7, expect.objectContaining({ url: 'https://keep.example/lesson' }));
});
it('archives a conflicting import input without replacing the other writer or starting an import', async () => {
  let active = stored;
  const archives: UiDraft[] = [];
  vi.mocked(uiDraftApi.get).mockImplementation(async () => active);
  vi.mocked(uiDraftApi.save).mockImplementation(async (kind, entityId, revision, fields) => {
    if (revision !== active.revision) throw Error('Draft changed');
    active = { kind, entityId, revision: revision + 1, fields, updatedAt: '', stale: false }; return active;
  });
  vi.mocked(uiDraftApi.archive).mockImplementation(async (kind, entityId, fields) => {
    const archive = { kind, entityId, fields, revision: 20 + archives.length, updatedAt: '', stale: true, archiveId: String(archives.length) };
    archives.push(archive); return archive;
  });
  const workspace = new ImportWorkspace(); await workspace.initialize('en', 'ja');
  active = { ...active, revision: 8, fields: { ...active.fields, url: 'https://other.example/video' } };
  workspace.change({ url: 'https://local.example/video' }); await workspace.flush();
  expect(workspace.pending).toBe(false);
  expect(workspace.getSnapshot().url).toBe('https://local.example/video');
  expect(active.fields.url).toBe('https://other.example/video');
  expect(archives[0].fields.url).toBe('https://local.example/video');
  workspace.change({ url: 'https://local.example/next' }); await workspace.flush();
  expect(archives[1].fields.url).toBe('https://other.example/video');
  expect(active.fields.url).toBe('https://local.example/next');
});
