// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { EditingSession, type EditState } from '../shared/editing/session';
import type { UiDraft, DraftKind } from '../shared/contracts/editing';

afterEach(() => vi.useRealTimers());
function fixture() {
  let record: UiDraft | null = null;
  let state: EditState = { fields: { term: 'original', meaning: 'meaning' }, revision: '1' };
  const drafts = { get: vi.fn(async () => record), archive: vi.fn(async (kind: DraftKind, entityId: string, fields: Record<string, string>): Promise<UiDraft> => ({ kind, entityId, fields, revision: 1, stale: true, updatedAt: '', archiveId: 'archive' })), remove: vi.fn(async (_kind: string, _id: string, revision: number) => {
    if (revision !== record?.revision) throw Error('draft conflict');
    record = null;
  }),
    save: vi.fn(async (kind: DraftKind, entityId: string, expectedRevision: number, fields: Record<string, string>) => {
      if (expectedRevision !== (record?.revision ?? 0)) throw Error('draft conflict');
      record = { kind, entityId, fields: { ...fields }, revision: expectedRevision + 1, stale: false, updatedAt: '' }; return record;
    }) };
  const adapter = { read: vi.fn(async () => state), save: vi.fn(async (fields: Record<string, string>, previous: EditState) => {
    if (previous.revision !== state.revision) throw Error('edit conflict');
    const applied = Object.keys(fields).filter(key => fields[key].trim() && fields[key] !== state.fields[key]);
    state = { fields: { ...state.fields, ...Object.fromEntries(applied.map(key => [key, fields[key]])) }, revision: String(Number(state.revision) + (applied.length ? 1 : 0)) };
    return { ...state, applied };
  }) };
  return { adapter, drafts, create: () => new EditingSession('card', 'card', adapter, drafts), state: () => state, draft: () => record };
}
it('saves after 500ms and flushes without an editor mounted', async () => {
  vi.useFakeTimers(); const f = fixture(); const editor = f.create(); await editor.load();
  editor.change({ term: 'new' }); await vi.advanceTimersByTimeAsync(499);
  expect(f.adapter.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(f.state().fields.term).toBe('new');
  editor.change({ meaning: 'changed after navigation' }); await editor.flush();
  expect(f.state().fields.meaning).toBe('changed after navigation');
});
it('restores invalid raw input while independently committing a valid field', async () => {
  const f = fixture(); const editor = f.create(); await editor.load();
  editor.change({ term: '', meaning: 'valid' }); await editor.flush();
  expect(f.state().fields).toEqual({ term: 'original', meaning: 'valid' });
  expect(f.draft()?.fields.term).toBe('');
  expect(f.draft()?.fields.meaning).toBeUndefined();
  const reopened = f.create(); await reopened.load();
  expect(reopened.getSnapshot().fields).toEqual({ term: '', meaning: 'valid' }); await reopened.flush();
});
it('retains input on a draft write failure and retries without a false saved status', async () => {
  const f = fixture(); const editor = f.create(); await editor.load();
  f.drafts.save.mockRejectedValueOnce(Error('disk full'));
  editor.change({ term: 'keep me' });
  await vi.waitFor(() => expect(editor.getSnapshot().error).toContain('disk full'));
  expect(editor.getSnapshot().fields.term).toBe('keep me');
  expect(editor.getSnapshot().dirty).toBe(true);
  await editor.flush(); expect(f.state().fields.term).toBe('keep me');
});
it('does not overwrite new typing when a previous commit finishes later', async () => {
  const f = fixture(); const editor = f.create(); await editor.load();
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const save = f.adapter.save.getMockImplementation()!;
  f.adapter.save.mockImplementationOnce(async (...args) => { await wait; return save(...args); });
  editor.change({ term: 'first' }); const flushing = editor.flush();
  await vi.waitFor(() => expect(f.adapter.save).toHaveBeenCalled());
  editor.change({ term: 'second' }); release(); await flushing;
  expect(editor.getSnapshot().fields.term).toBe('second');
  await editor.flush(); expect(f.state().fields.term).toBe('second');
});
it('holds an old draft for recovery when the committed revision changes', async () => {
  const f = fixture(); await f.drafts.save('card', 'card', 0, { term: 'old unfinished', baseRevision: 'obsolete' });
  const editor = f.create(); await editor.load();
  expect(editor.getSnapshot().fields.term).toBe('original');
  expect(editor.getSnapshot().recovery?.term).toBe('old unfinished');
  expect(f.adapter.save).not.toHaveBeenCalled();
});

it('refreshes a clean editor on reopening without reviving previous committed fields', async () => {
  const f = fixture(); const editor = f.create(); await editor.load();
  editor.change({ term: 'saved' }); await editor.flush();
  const external = f.state();
  await f.adapter.save({ ...external.fields, meaning: 'changed elsewhere' }, external);
  await editor.refresh();
  expect(editor.getSnapshot().fields).toEqual({ term: 'saved', meaning: 'changed elsewhere' });
  expect(editor.getSnapshot().recovery).toBeUndefined();
});

it('retains stale input across subsequent edits and another restart until explicitly recovered', async () => {
  const f = fixture(); await f.drafts.save('card', 'card', 0, { term: 'recover this', baseRevision: 'obsolete' });
  const editor = f.create(); await editor.load(); editor.change({ meaning: 'new content' }); await editor.flush();
  const reopened = f.create(); await reopened.load();
  expect(reopened.getSnapshot().recovery?.term).toBe('recover this');
  expect(reopened.getSnapshot().fields.term).toBe('original');
  reopened.recover(); await reopened.flush(); expect(f.state().fields.term).toBe('recover this');
});

it('does not replace typing or its revision when a refresh returns late', async () => {
  const f = fixture(); const editor = f.create(); await editor.load();
  let release!: (state: EditState) => void;
  f.adapter.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const refresh = editor.refresh();
  await vi.waitFor(() => expect(f.adapter.read).toHaveBeenCalledTimes(2));
  editor.change({ term: 'typed while reopening' });
  release(f.state()); await refresh; await editor.flush();
  expect(editor.getSnapshot().fields.term).toBe('typed while reopening');
  expect(f.state().fields.term).toBe('typed while reopening');
});

it('recovers revision-conflicted input without overwriting another writer', async () => {
  const f = fixture(); const editor = f.create(); await editor.load();
  editor.change({ term: 'local' });
  await f.adapter.save({ ...f.state().fields, term: 'external' }, f.state());
  expect(await editor.flush()).toBe(false);
  expect(f.state().fields.term).toBe('external');
  expect(editor.getSnapshot().fields.term).toBe('external');
  expect(editor.getSnapshot().recovery?.term).toBe('local');
  const reopened = f.create(); await reopened.load();
  expect(reopened.getSnapshot().recovery?.term).toBe('local');
  reopened.recover(); await reopened.flush();
  expect(f.state().fields.term).toBe('local');
});

it('removes fully saved drafts instead of accumulating an empty record per card', async () => {
  const f = fixture(); const editor = f.create(); await editor.load();
  editor.change({ term: 'saved' }); await editor.flush();
  expect(f.draft()).toBeNull();
  editor.change({ term: 'saved again' }); await editor.flush();
  expect(f.state().fields.term).toBe('saved again');
  expect(f.draft()).toBeNull();
});
it('archives older recovery before a second source conflict replaces the same raw field', async () => {
  const f = fixture();
  await f.drafts.save('card', 'card', 0, { term: 'earlier recovery', baseRevision: 'obsolete' });
  const editor = f.create(); await editor.load();
  editor.change({ term: 'new unfinished input' });
  await f.adapter.save({ ...f.state().fields, term: 'new authoritative content' }, f.state());
  expect(await editor.flush()).toBe(false);
  expect(f.drafts.archive).toHaveBeenCalledExactlyOnceWith('card', 'card', expect.objectContaining({ term: 'earlier recovery' }));
  const reopened = f.create(); await reopened.load();
  expect(reopened.getSnapshot().recovery?.term).toBe('new unfinished input');
  expect(reopened.getSnapshot().fields.term).toBe('new authoritative content');
});

it('persists draft-only forms without submitting and consumes them after explicit creation', async () => {
  const f = fixture(); const editor = new EditingSession('card', 'card', { ...f.adapter, draftOnly: ['term', 'meaning'] }, f.drafts);
  await editor.load(); editor.change({ term: 'unfinished new card' }); await editor.flush();
  expect(f.adapter.save).not.toHaveBeenCalled();
  expect(f.draft()?.fields.term).toBe('unfinished new card');
  await editor.resetDraft();
  expect(f.draft()).toBeNull();
  expect(editor.getSnapshot().fields.term).toBe('original');
});
