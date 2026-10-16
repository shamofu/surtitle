// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { closeWindow } from '../shared/native/window';
import { useStudyExitGuard } from '../features/study/useStudyExitGuard';
import { EditingProvider } from '../app/providers/Editing';
import { acquireEditorDraft, clearEditorDraftSessions } from '../features/study/editor-drafts/session';
import { editorDraftApi } from '../features/study/editor-drafts/api';

const fixture = vi.hoisted(() => ({ destroy: vi.fn(), notify: vi.fn(), close: vi.fn(),
  nativeClose: undefined as undefined | ((event: { preventDefault: () => void }) => void),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  onCloseRequested: async (callback: typeof fixture.nativeClose) => {
    fixture.nativeClose = callback;
    return () => { fixture.nativeClose = undefined; };
  }, destroy: fixture.destroy, close: fixture.close,
}) }));
vi.mock('@tanstack/react-router', () => ({ useBlocker: () => ({ status: 'idle' }) }));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../app/runtime', () => ({ useNotifications: () => ({ notify: fixture.notify }) }));
vi.mock('../app/providers/Notifications', () => ({ useNotifications: () => ({ notify: fixture.notify }) }));
vi.mock('../app/providers/Appearance', () => ({ useAppearance: () => ({ t: (_ja: string, en: string) => en }) }));
vi.mock('../shared/editing/session', () => ({ flushEdits: async () => true, pendingEdits: () => false }));
vi.mock('../features/library/import-workspace', () => ({ importWorkspace: { flush: async () => {}, pending: false } }));
vi.mock('../features/study/editor-drafts/api', () => ({ editorDraftApi: { list: vi.fn(), save: vi.fn() } }));
afterEach(() => { cleanup(); clearEditorDraftSessions(); vi.resetAllMocks(); });

it('a detached card close cannot bypass a mounted Study save or failed phrase flush', async () => {
  const failure = new Error('phrase storage unavailable');
  const flush = vi.fn().mockRejectedValue(failure);
  const { rerender } = renderHook(({ saving }) => useStudyExitGuard(true, saving, vi.fn(), flush),
    { initialProps: { saving: true } });
  // Direct close requests must wait for Study's in-flight card save.
  const closing = closeWindow();
  const rejected = expect(closing).rejects.toThrow(failure.message);
  await act(async () => { await Promise.resolve(); });
  expect(flush).not.toHaveBeenCalled(); expect(fixture.destroy).not.toHaveBeenCalled();
  rerender({ saving: false });
  await rejected;
  expect(flush).toHaveBeenCalledOnce(); expect(fixture.destroy).not.toHaveBeenCalled();
});

it('does not let direct closure bypass a dirty guard without a persistence handler', async () => {
  renderHook(() => useStudyExitGuard(true, false, vi.fn()));
  await expect(closeWindow()).rejects.toThrow('Save unfinished input');
  expect(fixture.destroy).not.toHaveBeenCalled();
});

it('coordinates application and Study persistence through one native attempt and retry', async () => {
  render(<EditingProvider><span>Study</span></EditingProvider>);
  const flush = vi.fn().mockRejectedValueOnce(new Error('phrase storage unavailable')).mockResolvedValue(undefined);
  const { result, rerender } = renderHook(({ saving }) => useStudyExitGuard(true, saving, vi.fn(), flush),
    { initialProps: { saving: true } });
  const event = { preventDefault: vi.fn() };
  act(() => { fixture.nativeClose?.(event); fixture.nativeClose?.(event); });
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(result.current.open).toBe(false); expect(flush).not.toHaveBeenCalled();
  expect(fixture.destroy).not.toHaveBeenCalled();
  rerender({ saving: false });
  await waitFor(() => expect(result.current.open).toBe(true));
  expect(result.current.error).toBe('phrase storage unavailable');
  expect(result.current.canDiscard).toBe(false); expect(flush).toHaveBeenCalledOnce();
  expect(fixture.notify).toHaveBeenCalledOnce(); expect(fixture.destroy).not.toHaveBeenCalled();
  await act(async () => { fixture.nativeClose?.({ preventDefault: vi.fn() }); });
  expect(flush).toHaveBeenCalledTimes(2); expect(fixture.destroy).toHaveBeenCalledOnce();
  expect(fixture.close).not.toHaveBeenCalled();
});

it('keeps a failed phrase draft protected after the Study editor unmounts', async () => {
  vi.mocked(editorDraftApi.list).mockResolvedValue([]);
  vi.mocked(editorDraftApi.save).mockRejectedValue(new Error('disk full'));
  render(<EditingProvider><span>Library</span></EditingProvider>);
  const handle = acquireEditorDraft({ mediaId: 'media', kind: 'subtitle', sourceKey: 'cue', sourceCues: [], initialValue: { text: 'before' } });
  await handle.session.flush();
  handle.session.setValue({ text: 'unfinished phrase' });
  handle.release();
  await waitFor(() => expect(handle.session.status).toBe('error'));
  await expect(closeWindow()).rejects.toThrow('disk full');
  expect(fixture.destroy).not.toHaveBeenCalled();
  expect(handle.session.value.text).toBe('unfinished phrase');
  vi.mocked(editorDraftApi.save).mockImplementation(async request => ({ ...request, version: request.expectedVersion + 1,
    bindingVerified: true, stale: false, sourceMediaSignature: 'source', createdAt: '', updatedAt: '' }));
  await closeWindow();
  expect(handle.session.draft?.fields.text).toBe('unfinished phrase');
  expect(fixture.destroy).toHaveBeenCalledOnce();
});
