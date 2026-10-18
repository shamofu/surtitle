// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { ImportWorkspace } from '../features/library/import-workspace';
import { uiDraftApi } from '../shared/editing/drafts';
import type { UiDraft } from '../shared/contracts/editing';
vi.mock('../shared/editing/drafts', () => ({ uiDraftApi: { get: vi.fn(), save: vi.fn(), archive: vi.fn() } }));
afterEach(() => vi.resetAllMocks());
const stored: UiDraft = { kind: 'import', entityId: 'default', revision: 7, updatedAt: '', stale: false,
  fields: { learningLanguage: 'fr', explanationLanguage: 'ja', rows: '[]' } };
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
  workspace.change({ learningLanguage: 'de' });
  const flush = workspace.flush();
  expect(uiDraftApi.save).not.toHaveBeenCalled();
  finish(stored); await initialization; await flush;
  expect(workspace.getSnapshot()).toMatchObject({ ready: true, learningLanguage: 'de' });
  expect(uiDraftApi.save).toHaveBeenCalledExactlyOnceWith('import', 'default', 7, expect.objectContaining({ learningLanguage: 'de' }));
  expect(workspace.pending).toBe(false);
});
it('preserves early input through a failed initial read and offers a retry using the actual revision', async () => {
  vi.mocked(uiDraftApi.get).mockRejectedValue(Error('Temporarily unavailable'));
  saving();
  const workspace = new ImportWorkspace();
  const initialization = workspace.initialize('en', 'ja');
  workspace.change({ learningLanguage: 'es' });
  await initialization;
  await expect(workspace.flush()).rejects.toThrow('Temporarily unavailable');
  expect(workspace.getSnapshot()).toMatchObject({ ready: false, learningLanguage: 'es' });
  expect(uiDraftApi.save).not.toHaveBeenCalled();
  vi.mocked(uiDraftApi.get).mockResolvedValue(stored);
  await workspace.flush();
  expect(workspace.getSnapshot()).toMatchObject({ ready: true, learningLanguage: 'es', error: undefined });
  expect(uiDraftApi.save).toHaveBeenCalledExactlyOnceWith('import', 'default', 7, expect.objectContaining({ learningLanguage: 'es' }));
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
  active = { ...active, revision: 8, fields: { ...active.fields, learningLanguage: 'it' } };
  workspace.change({ learningLanguage: 'es' }); await workspace.flush();
  expect(workspace.pending).toBe(false);
  expect(workspace.getSnapshot().learningLanguage).toBe('es');
  expect(active.fields.learningLanguage).toBe('it');
  expect(archives[0].fields.learningLanguage).toBe('es');
  workspace.change({ learningLanguage: 'de' }); await workspace.flush();
  expect(archives[1].fields.learningLanguage).toBe('it');
  expect(active.fields.learningLanguage).toBe('de');
});
