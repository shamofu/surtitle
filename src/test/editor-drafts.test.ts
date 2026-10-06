// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorDraftSession, acquireEditorDraft, clearEditorDraftSessions, flushEditorDrafts } from '../features/study/editor-drafts/session';
import { editorDraftApi, type EditorDraft, type EditorDraftInput } from '../features/study/editor-drafts/api';

vi.mock('../features/study/editor-drafts/api', () => ({ editorDraftApi: {
  list: vi.fn(), save: vi.fn(), discard: vi.fn(), rebind: vi.fn(),
} }));
const cue = { id: 'cue', mediaId: 'media', startMs: 1, endMs: 100, text: 'Hello', status: 'confirmed' as const };
const options = () => ({ mediaId: 'media', kind: 'subtitle' as const, sourceKey: '["cue"]', sourceCues: [cue],
  initialValue: { start: '00:00.001', end: '00:00.100', text: 'Hello', translation: '' } });
const saved = (request: EditorDraftInput): EditorDraft => ({ ...request, version: request.expectedVersion + 1,
  fields: { ...request.fields }, bindingVerified: true, stale: false, sourceMediaSignature: 'source', createdAt: '', updatedAt: '' });
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(editorDraftApi.list).mockResolvedValue([]);
  vi.mocked(editorDraftApi.save).mockImplementation(async request => saved(request));
  vi.mocked(editorDraftApi.discard).mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it('restores raw incomplete input and serializes edits arriving during an in-flight save', async () => {
  let complete!: (value: EditorDraft) => void;
  const session = new EditorDraftSession(options());
  await session.flush();
  session.setValue({ ...session.value, start: '00:', text: 'first' });
  vi.mocked(editorDraftApi.save).mockImplementationOnce(request => new Promise(resolve => { complete = () => resolve(saved(request)); }));
  const pending = session.flush();
  await Promise.resolve();
  session.setValue({ ...session.value, text: 'second' });
  complete({} as EditorDraft);
  await pending;
  expect(editorDraftApi.save).toHaveBeenCalledTimes(2);
  const requests = vi.mocked(editorDraftApi.save).mock.calls.map(([request]) => request);
  expect(requests.map(request => request.expectedVersion)).toEqual([0, 1]);
  expect(requests[1].fields).toMatchObject({ start: '00:', text: 'second' });
  expect(requests[0]).not.toHaveProperty('initialValue');
  vi.mocked(editorDraftApi.list).mockResolvedValue([session.draft!]);
  const resumed = new EditorDraftSession(options());
  await resumed.flush();
  expect(resumed.value).toEqual(session.value);
  expect(editorDraftApi.save).toHaveBeenCalledTimes(2);
});

it('flushes before a closed editor is released and retains failed writes for retry', async () => {
  const handle = acquireEditorDraft(options());
  await handle.session.flush();
  handle.session.setValue({ ...handle.session.value, text: 'recover me' });
  vi.mocked(editorDraftApi.save).mockRejectedValue(new Error('disk full'));
  await expect(flushEditorDrafts()).rejects.toThrow('disk full');
  expect(handle.session.value.text).toBe('recover me');
  expect(handle.session.status).toBe('error');
  vi.mocked(editorDraftApi.save).mockImplementation(async request => saved(request));
  await flushEditorDrafts();
  expect(handle.session.draft?.fields.text).toBe('recover me');
  handle.session.consume();
  handle.release();
  await flushEditorDrafts();
});

it('does not recreate a draft after its final save consumes it', async () => {
  const session = new EditorDraftSession(options());
  session.setValue({ ...session.value, text: 'finished' });
  await session.flush(true);
  session.consume();
  await vi.runAllTimersAsync();
  await session.flush(true);
  expect(editorDraftApi.save).toHaveBeenCalledTimes(1);
  expect(session.draft).toBeUndefined();
});

it('reconnects a removed source while keeping the edited fields and next CAS version', async () => {
  const session = new EditorDraftSession(options());
  session.setValue({ ...session.value, text: 'keep this' });
  await session.flush();
  const replacement = { ...cue, id: 'replacement' };
  vi.mocked(editorDraftApi.rebind).mockResolvedValue({ ...session.draft!, version: 2, sourceKey: '["replacement"]', sourceCues: [replacement] });
  await session.rebind([replacement]);
  session.setValue({ ...session.value, translation: 'continue' });
  await session.flush();
  expect(vi.mocked(editorDraftApi.save).mock.lastCall?.[0]).toMatchObject({
    sourceKey: '["replacement"]', expectedVersion: 2, fields: { text: 'keep this', translation: 'continue' },
  });
});

it('invalidates old editors after restore without deleting or overwriting imported drafts', async () => {
  const handle = acquireEditorDraft(options());
  handle.session.setValue({ ...handle.session.value, text: 'before restore' });
  await flushEditorDrafts();
  clearEditorDraftSessions();
  await expect(handle.session.flush(true)).rejects.toThrow('backup was restored');
  await expect(handle.session.discard()).rejects.toThrow('backup was restored');
  handle.release();
  await flushEditorDrafts();
  expect(editorDraftApi.discard).not.toHaveBeenCalled();
  expect(editorDraftApi.save).toHaveBeenCalledTimes(1);
});

it('persists an initially prefilled phrase even when the user leaves without typing', async () => {
  const session = new EditorDraftSession({ ...options(), kind: 'phrase', initialValue: {
    term: 'hello', meaning: 'greeting', example: 'Hello', explanation: '',
  } });
  await session.flush();
  expect(session.draft?.fields).toEqual({ term: 'hello', meaning: 'greeting', example: 'Hello', explanation: '' });
  expect(editorDraftApi.save).toHaveBeenCalledOnce();
});
