// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import type { DraftKind, UiDraft } from '../shared/contracts/editing';
import { EditingSession, type EditState } from '../shared/editing/session';

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  let record: UiDraft | null = null;
  const archives: UiDraft[] = [];
  const state: EditState = { fields: { term: 'original' }, revision: 'source-1' };
  const drafts = {
    get: vi.fn(async () => record),
    remove: vi.fn(async () => { throw Error('unexpected deletion'); }),
    archive: vi.fn(async (kind: DraftKind, entityId: string, fields: Record<string, string>) => {
      const draft = { kind, entityId, fields: structuredClone(fields), revision: archives.length + 10, stale: true, updatedAt: '', archiveId: `archive-${archives.length}` };
      archives.push(draft); return draft;
    }),
    save: vi.fn(async (kind: DraftKind, entityId: string, expectedRevision: number, fields: Record<string, string>) => {
      if (expectedRevision !== (record?.revision ?? 0)) throw Error('Draft changed; reload before saving');
      record = { kind, entityId, fields, revision: expectedRevision + 1, stale: false, updatedAt: '' };
      return record;
    }),
  };
  const adapter = { read: vi.fn(async () => state), save: vi.fn(async () => ({ ...state, applied: [] })) };
  return { drafts, adapter, archives, record: () => record };
}

it('archives a competing writer without changing the active draft and permits a safe close', async () => {
  const { drafts, adapter, archives, record } = fixture();
  const first = new EditingSession('card', 'same-card', adapter, drafts);
  const second = new EditingSession('card', 'same-card', adapter, drafts);
  await first.load(); await second.load();
  first.change({ term: 'first writer input' });
  await first.flush();
  second.change({ term: 'second writer input' });
  expect(await second.flush()).toBe(true);
  expect(second.getSnapshot().fields.term).toBe('original');
  expect(second.getSnapshot().recovery?.term).toBe('second writer input');
  await second.refresh();
  expect(second.getSnapshot().recovery?.term).toBe('second writer input');
  expect(await second.flush()).toBe(true);
  expect(second.pending).toBe(false);
  expect(record()?.fields.term).toBe('first writer input');
  expect(archives.map(draft => draft.fields.term)).toEqual(['second writer input']);
  // Explicitly reusing the local version must preserve the other writer too.
  second.recover(); await second.flush();
  expect(record()?.fields.term).toBe('second writer input');
  expect(archives.map(draft => draft.fields.term)).toEqual(['second writer input', 'first writer input']);
});

it('keeps close blocked and raw input in memory if the conflict archive cannot be written', async () => {
  const { drafts, adapter, record, archives } = fixture();
  const editor = new EditingSession('card', 'same-card', adapter, drafts); await editor.load();
  await drafts.save('card', 'same-card', 0, { term: 'external', baseRevision: 'source-1' });
  drafts.archive.mockRejectedValue(Error('disk full'));
  editor.change({ term: 'local' });
  expect(await editor.flush()).toBe(false);
  expect(editor.pending).toBe(true);
  expect(editor.getSnapshot().fields.term).toBe('local');
  expect(record()?.fields.term).toBe('external');
  expect(archives).toHaveLength(0);
});

it('preserves newer typing and a third collision during archive handoff', async () => {
  const { drafts, adapter, record, archives } = fixture();
  const editor = new EditingSession('card', 'same-card', adapter, drafts); await editor.load();
  await drafts.save('card', 'same-card', 0, { term: 'external one', baseRevision: 'source-1' });
  let release!: () => void;
  const archive = drafts.archive.getMockImplementation()!;
  drafts.archive.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return archive(...args); });
  editor.change({ term: 'local first' }); const flush = editor.flush();
  await vi.waitFor(() => expect(drafts.archive).toHaveBeenCalled());
  editor.change({ term: 'local newer' }); release(); await flush;
  expect(editor.getSnapshot().recovery?.term).toBe('local newer');
  await drafts.save('card', 'same-card', record()!.revision, { term: 'external two', baseRevision: 'source-1' });
  editor.recover(); await editor.flush();
  expect(record()?.fields.term).toBe('external two');
  expect(editor.getSnapshot().recovery?.term).toBe('local newer');
  expect(archives.map(draft => draft.fields.term)).toEqual(['local first', 'local newer', 'external one', 'local newer']);
});
