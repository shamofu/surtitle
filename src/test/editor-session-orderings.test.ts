// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { EditingSession, type EditState } from '../shared/editing/session';
import type { DraftKind, UiDraft } from '../shared/contracts/editing';
import { acquireEditorDraft, clearEditorDraftSessions, EditorDraftSession, flushEditorDrafts } from '../features/study/editor-drafts/session';
import { editorDraftApi, type EditorDraft, type EditorDraftInput } from '../features/study/editor-drafts/api';
import { controlled, legalOrders, settle } from './legal-orderings';

vi.mock('../features/study/editor-drafts/api', () => ({ editorDraftApi: { list: vi.fn(), save: vi.fn(), discard: vi.fn(), rebind: vi.fn() } }));
afterEach(() => { clearEditorDraftSessions(); vi.clearAllTimers(); vi.useRealTimers(); vi.resetAllMocks(); });

function editingFixture(entity: string) {
  let state: EditState = { fields: { term: 'source', meaning: 'meaning' }, revision: 'one' };
  let record: UiDraft | null = null;
  const archives: UiDraft[] = [];
  const drafts = {
    get: vi.fn(async () => record),
    save: vi.fn(async (kind: DraftKind, entityId: string, expected: number, fields: Record<string, string>) => {
      if (expected !== (record?.revision ?? 0)) throw Error('draft conflict');
      return record = { kind, entityId, fields: { ...fields }, revision: expected + 1, stale: false, updatedAt: '' };
    }),
    remove: vi.fn(async (_kind: DraftKind, _entity: string, expected: number) => {
      if (expected !== record?.revision) throw Error('draft conflict'); record = null;
    }),
    archive: vi.fn(async (kind: DraftKind, entityId: string, fields: Record<string, string>) => {
      const archived = { kind, entityId, fields: { ...fields }, revision: archives.length + 1, stale: true, updatedAt: '', archiveId: String(archives.length) }; archives.push(archived); return archived;
    }),
  };
  const adapter = {
    read: vi.fn(async () => structuredClone(state)),
    save: vi.fn(async (fields: Record<string, string>, previous: EditState) => {
      if (previous.revision !== state.revision) throw Error('source conflict');
      const applied = Object.keys(fields).filter(key => fields[key].trim() && fields[key] !== state.fields[key]);
      state = { revision: `${state.revision}+`, fields: { ...state.fields, ...Object.fromEntries(applied.map(key => [key, fields[key]])) } };
      return { ...structuredClone(state), applied };
    }),
  };
  return { adapter, drafts, archives, get record() { return record; }, get state() { return state; }, restore: (next: EditState) => { state = next; }, create: () => new EditingSession('card', entity, adapter, drafts) };
}

// Input is raw and deliberately incomplete; neither a save result nor refresh may erase it.
function hasRaw(editor: EditingSession, raw: string) {
  const view = editor.getSnapshot();
  expect([view.fields.term, view.recovery?.term]).toContain(raw);
}

it('preserves newer raw input through legal old commit/external revision/refresh completion orders', async () => {
  const orders = legalOrders({ external: [], refresh: ['external'], newer: [], finish: ['external'] } as const);
  expect(orders).toHaveLength(8);
  let explored = 0;
  for (const entity of ['a', 'b']) for (const outcome of ['success', 'conflict', 'failure'] as const) for (const order of orders) {
    vi.useFakeTimers(); const f = editingFixture(entity); const editor = f.create(); await editor.load();
    const completion = controlled<EditState & { applied: string[] }>();
    const save = f.adapter.save.getMockImplementation()!;
    f.adapter.save.mockImplementationOnce(() => completion.promise);
    editor.change({ term: 'first' }); const flushing = editor.flush(); await settle();
    expect(f.adapter.save).toHaveBeenCalledOnce();
    // A successful response can have been captured before an external revision, but delivered afterward.
    const captured = { fields: { term: 'first', meaning: 'meaning' }, revision: 'old-committed', applied: ['term'] };
    let raw = 'first', refresh: Promise<void> | undefined, restored = false, finished = false;
    for (const action of order) {
      if (action === 'external') { restored = true; f.restore({ fields: { term: 'restored', meaning: 'meaning' }, revision: 'two' }); }
      if (action === 'refresh') refresh = editor.refresh();
      if (action === 'newer') { raw = '00:'; editor.change({ term: raw }); }
      if (action === 'finish') {
        finished = true;
        if (outcome === 'success') completion.resolve(captured);
        else completion.reject(Error(outcome === 'conflict' ? 'source conflict' : 'disk full'));
      }
      await settle();
      if (raw === '00:' || outcome !== 'success' || !finished) hasRaw(editor, raw);
      if (restored) expect(f.state.fields.term).toBe('restored');
    }
    await flushing; await refresh;
    hasRaw(editor, '00:'); expect(f.state.fields.term).toBe('restored');
    // Explicit recovery and a healthy retry are the only action that may publish conflicted text.
    if (editor.getSnapshot().fields.term !== '00:' && editor.getSnapshot().recovery) editor.recover();
    f.adapter.save.mockImplementation(save);
    expect(await editor.flush()).toBe(true);
    expect(f.state.fields.term).toBe('00:');
    // An earlier conflict can coexist with subsequent typing; saving the latter
    // must retain the earlier recovery until the user explicitly chooses it.
    if (editor.getSnapshot().recovery) expect(f.record?.fields.recovery).toBe(JSON.stringify(editor.getSnapshot().recovery));
    else expect(f.record).toBeNull();
    vi.clearAllTimers(); explored++;
  }
  expect(explored).toBe(48);
});

it('keeps raw input retryable after ordinary save failure and accepts successful unchanged-revision writes', async () => {
  let explored = 0;
  for (const entity of ['a', 'b']) for (const outcome of ['success', 'failure'] as const) {
    vi.useFakeTimers(); const f = editingFixture(entity); const editor = f.create(); await editor.load();
    const completion = controlled<EditState & { applied: string[] }>();
    f.adapter.save.mockImplementationOnce(() => completion.promise);
    editor.change({ term: '00:' }); const flush = editor.flush(); await settle();
    // No external revision change: ordinary I/O failure retains retryable fields.
    if (outcome === 'failure') completion.reject(Error('disk full'));
    else { f.restore({ fields: { term: '00:', meaning: 'meaning' }, revision: 'one+' }); completion.resolve({ ...f.state, applied: ['term'] }); }
    expect(await flush).toBe(outcome === 'success');
    hasRaw(editor, '00:'); expect(editor.getSnapshot().recovery).toBeUndefined();
    if (outcome === 'failure') { expect(f.record?.fields.term).toBe('00:'); expect(await editor.flush()).toBe(true); }
    expect(f.state.fields.term).toBe('00:'); vi.clearAllTimers(); explored++;
  }
  expect(explored).toBe(4);
});

it('does not adopt a stale refresh snapshot or draft token over newer typing', async () => {
  const orders = legalOrders({ newer: [], finishRead: [] } as const);
  expect(orders).toHaveLength(2);
  let explored = 0;
  for (const entity of ['a', 'b']) for (const order of orders) {
    vi.useFakeTimers(); const f = editingFixture(entity); const editor = f.create(); await editor.load();
    f.restore({ fields: { term: 'external', meaning: 'meaning' }, revision: 'two' });
    const read = controlled<EditState>(); const captured = structuredClone(f.state);
    f.adapter.read.mockReturnValueOnce(read.promise);
    const refreshing = editor.refresh(); await settle();
    expect(f.adapter.read).toHaveBeenCalledTimes(2);
    let expected = 'source';
    for (const action of order) {
      if (action === 'newer') { expected = '00:'; editor.change({ term: expected }); }
      if (action === 'finishRead') { read.resolve(captured); if (expected !== '00:') expected = 'external'; }
      await settle(); expect(editor.getSnapshot().fields.term).toBe(expected);
    }
    await refreshing; await editor.flush(); hasRaw(editor, '00:');
    if (editor.getSnapshot().fields.term !== '00:') editor.recover();
    expect(await editor.flush()).toBe(true); expect(f.state.fields.term).toBe('00:');
    vi.clearAllTimers(); explored++;
  }
  expect(explored).toBe(4);
});

const cue = { id: 'cue', mediaId: 'media', startMs: 1, endMs: 100, text: 'source', status: 'confirmed' as const };
const draftOptions = (mediaId: string) => ({ mediaId, kind: 'subtitle' as const, sourceKey: '["cue"]', sourceCues: [{ ...cue, mediaId }], initialValue: { start: '1', end: '100', text: 'source' } });
const savedDraft = (request: EditorDraftInput): EditorDraft => ({ ...request, version: request.expectedVersion + 1, fields: { ...request.fields }, bindingVerified: true, stale: false, sourceMediaSignature: 'source', createdAt: '', updatedAt: '' });

it('serializes newer draft input around old save success, conflict and failure without consuming it', async () => {
  const orders = legalOrders({ newer: [], finish: [] } as const);
  expect(orders).toHaveLength(2);
  let explored = 0;
  for (const entity of ['a', 'b']) for (const outcome of ['success', 'conflict', 'failure'] as const) for (const order of orders) {
    vi.useFakeTimers();
    vi.mocked(editorDraftApi.list).mockResolvedValue([]);
    const completion = controlled<EditorDraft>();
    const requests: EditorDraftInput[] = [];
    vi.mocked(editorDraftApi.save).mockImplementation(async request => { requests.push(structuredClone(request)); return requests.length === 1 ? completion.promise : savedDraft(request); });
    const editor = new EditorDraftSession(draftOptions(entity)); await editor.flush();
    editor.setValue({ ...editor.value, text: 'first' });
    const flush = editor.flush().then(() => true, () => false); await settle();
    expect(requests).toHaveLength(1);
    let expected = 'first';
    for (const action of order) {
      if (action === 'newer') { expected = '00:'; editor.setValue({ ...editor.value, text: expected }); }
      if (action === 'finish') {
        if (outcome === 'success') completion.resolve(savedDraft(requests[0]));
        else completion.reject(Error(outcome === 'conflict' ? 'draft conflict' : 'disk full'));
      }
      await settle(); expect(editor.value.text).toBe(expected);
      expect(editorDraftApi.discard).not.toHaveBeenCalled();
    }
    expect(await flush).toBe(outcome === 'success');
    if (outcome !== 'success') { expect(['error', 'saving']).toContain(editor.status); expect(editor.pending).toBe(true); }
    await editor.flush();
    expect(editor.draft?.fields.text).toBe('00:'); expect(editor.pending).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1].expectedVersion).toBe(outcome === 'success' ? 1 : 0);
    vi.clearAllTimers(); vi.mocked(editorDraftApi.save).mockClear(); explored++;
  }
  expect(explored).toBe(12);
});

it('flushes before restore and never consumes the imported draft through an old editor', async () => {
  const orders = legalOrders({ newer: [], finish: [], restore: ['finish'], reopen: ['restore'] } as const);
  expect(orders).toHaveLength(4);
  let explored = 0;
  for (const entity of ['a', 'b']) for (const outcome of ['success', 'conflict', 'failure'] as const) for (const order of orders) {
    vi.useFakeTimers(); vi.mocked(editorDraftApi.list).mockResolvedValue([]);
    const completion = controlled<EditorDraft>(); let request!: EditorDraftInput;
    vi.mocked(editorDraftApi.save).mockImplementation(async input => savedDraft(input));
    vi.mocked(editorDraftApi.save).mockImplementationOnce(input => { request = input; return completion.promise; });
    const handle = acquireEditorDraft(draftOptions(entity));
    const editor = handle.session; await editor.flush();
    editor.setValue({ ...editor.value, text: 'first' }); const flush = editor.flush().catch(() => undefined); await settle();
    const restored = savedDraft({ ...request, expectedVersion: 9, fields: { ...request.fields, text: 'imported' } });
    let invalidated = false, expected = 'first', reopened: EditorDraftSession | undefined;
    for (const action of order) {
      if (action === 'restore') {
        await flush; await flushEditorDrafts(); // Required public restore precondition, including retry after a failed write.
        vi.mocked(editorDraftApi.list).mockResolvedValue([restored]); invalidated = true; clearEditorDraftSessions();
      }
      if (action === 'reopen') { reopened = new EditorDraftSession(draftOptions(entity)); await reopened.flush(); }
      if (action === 'newer') { editor.setValue({ ...editor.value, text: '00:' }); if (!invalidated) expected = '00:'; }
      if (action === 'finish') {
        if (outcome === 'success') completion.resolve(savedDraft(request)); else completion.reject(Error(outcome));
      }
      await settle(); expect(editor.value.text).toBe(expected);
      expect(restored.fields.text).toBe('imported');
      if (invalidated) { expect(editor.status).toBe('error'); expect(editor.error).toContain('backup was restored'); expect(editor.pending).toBe(false); }
      if (reopened) expect(reopened.draft).toEqual(restored);
    }
    await flush;
    await expect(editor.flush()).rejects.toThrow('backup was restored');
    await expect(editor.discard()).rejects.toThrow('backup was restored');
    expect(reopened?.value.text).toBe('imported');
    expect(editorDraftApi.discard).not.toHaveBeenCalled();
    handle.release();
    vi.clearAllTimers(); vi.mocked(editorDraftApi.save).mockClear(); explored++;
  }
  expect(explored).toBe(24);
});

it('keeps newer raw input when the restored draft list snapshot finishes before or after typing', async () => {
  const orders = legalOrders({ newer: [], finishList: [] } as const);
  expect(orders).toHaveLength(2);
  let explored = 0;
  for (const entity of ['a', 'b']) for (const order of orders) {
    vi.useFakeTimers(); const list = controlled<EditorDraft[]>();
    const options = draftOptions(entity);
    const restored = savedDraft({ ...options, id: 'restored', expectedVersion: 9, fields: { ...options.initialValue, text: 'imported' } });
    vi.mocked(editorDraftApi.list).mockReturnValueOnce(list.promise);
    vi.mocked(editorDraftApi.save).mockImplementation(async input => savedDraft(input));
    const editor = new EditorDraftSession(options);
    let expected = 'source';
    for (const action of order) {
      if (action === 'newer') { expected = '00:'; editor.setValue({ ...editor.value, text: expected }); }
      if (action === 'finishList') { list.resolve([restored]); if (expected !== '00:') expected = 'imported'; }
      await settle(); expect(editor.value.text).toBe(expected);
    }
    await editor.flush();
    expect(editor.value.text).toBe('00:'); expect(editor.draft?.fields.text).toBe('00:');
    expect(vi.mocked(editorDraftApi.save).mock.lastCall?.[0]).toMatchObject({ id: 'restored', expectedVersion: 10 });
    vi.clearAllTimers(); explored++;
  }
  expect(explored).toBe(4);
});
