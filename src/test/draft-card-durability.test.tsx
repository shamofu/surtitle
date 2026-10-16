// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DraftCardDialog } from '../features/study/drafts/DraftDialogs';
import { draftStudyApi, type DraftSelection } from '../features/study/drafts/api';
import { uiDraftApi } from '../shared/editing/drafts';
import type { UiDraft } from '../shared/contracts/editing';
import { hasPendingCloseTasks, subscribeWindowClose } from '../shared/native/window';

const fixture = vi.hoisted(() => ({ records: new Map<string, UiDraft>(), serial: 0, destroy: vi.fn(), close: undefined as (() => boolean) | undefined }));
vi.mock('../app/providers/Activities', () => import('./activity-fixture'));
vi.mock('../app/runtime', () => ({
  useDataActions: () => ({ mutate: (action: () => Promise<unknown>) => action() }),
  useAppearance: () => ({ t: (_ja: string, en: string) => en }),
  useNotifications: () => ({ report: async <T,>(action: () => Promise<T>) => { try { return await action(); } catch { return undefined; } } }),
  useSnapshot: () => ({}), useSurface: () => ({ registerModal: () => () => {} }),
}));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  destroy: fixture.destroy,
  onCloseRequested: async (callback: (event: { preventDefault: () => void }) => void) => {
    fixture.close = () => {
      let prevented = false;
      callback({ preventDefault: () => { prevented = true; } });
      return prevented;
    };
    return () => { fixture.close = undefined; };
  },
}) }));
vi.mock('../shared/editing/drafts', () => ({ uiDraftApi: {
  get: vi.fn(async (_kind: string, id: string) => fixture.records.get(id) ?? null),
  save: vi.fn(async (kind: UiDraft['kind'], entityId: string, revision: number, fields: Record<string,string>) => {
    if ((fixture.records.get(entityId)?.revision ?? 0) !== revision) throw Error('draft conflict');
    const next = { kind, entityId, fields: { ...fields }, revision: ++fixture.serial, updatedAt: '', stale: false };
    fixture.records.set(entityId,next); return next;
  }),
  remove: vi.fn(async (_kind: string, id: string, revision: number) => {
    if (fixture.records.get(id)?.revision !== revision) throw Error('draft conflict'); fixture.records.delete(id);
  }),
} }));
vi.mock('../features/study/drafts/api', () => ({ draftStudyApi: { saveCard: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
let identity = 0;
function selection(): DraftSelection {
  return { id: `card-durability-${++identity}`, version: 1, mediaId: 'media', text: 'A preserved source.', startMs: 1000, endMs: 2000,
    sourceStartMs: 0, sourceEndMs: 3000, jobId: null, cueIds: [], origin: 'manual', timing: 'manual', confirmed: true,
    stale: false, blockingReasons: [], canConfirm: true, createdAt: '', updatedAt: '' };
}
async function ready() { await waitFor(() => expect(screen.getByLabelText('Phrase to remember')).toBeEnabled()); }
function fill() {
  fireEvent.change(screen.getByLabelText('Phrase to remember'), { target: { value: 'phrase' } });
  fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'meaning' } });
}

it('keeps incomplete input across close and reopen without creating a card', async () => {
  const source = selection(), onClose = vi.fn();
  const first = render(<DraftCardDialog selection={source} onClose={onClose} />); await ready();
  fireEvent.change(screen.getByLabelText('Phrase to remember'), { target: { value: ' unfinished ' } });
  fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: '   ' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[1]);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(fixture.records.get(source.id)?.fields).toMatchObject({ term: ' unfinished ', meaning: '   ', baseRevision: '1' });
  first.unmount(); render(<DraftCardDialog selection={source} onClose={vi.fn()} />); await ready();
  expect(screen.getByLabelText('Phrase to remember')).toHaveValue(' unfinished ');
  expect(screen.getByLabelText('Meaning')).toHaveValue('   ');
  expect(screen.getByRole('button', { name: 'Save card and audio' })).toBeDisabled();
  expect(draftStudyApi.saveCard).not.toHaveBeenCalled();
});

it('offers input from an older selection for explicit recovery without applying it', async () => {
  const source = selection();
  fixture.records.set(source.id, { kind: 'draft_card', entityId: source.id, revision: ++fixture.serial,
    fields: { term: 'older phrase', meaning: 'old meaning', baseRevision: '1' }, stale: true, updatedAt: '' });
  render(<DraftCardDialog selection={{ ...source, version: 2 }} onClose={vi.fn()} />); await ready();
  expect(screen.getByLabelText('Phrase to remember')).toHaveValue('');
  expect(screen.getByLabelText('Previous input')).toHaveValue('older phrase\n\nold meaning');
  expect(draftStudyApi.saveCard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Continue editing this input' }));
  expect(screen.getByLabelText('Phrase to remember')).toHaveValue('older phrase');
  await waitFor(() => expect(fixture.records.get(source.id)?.fields.baseRevision).toBe('2'));
});

it('waits for explicit card save before closing and consumes only its durable input', async () => {
  const source = selection(), onClose = vi.fn(); let finish!: () => void;
  vi.mocked(draftStudyApi.saveCard).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as never); }));
  render(<DraftCardDialog selection={source} onClose={onClose} />); await ready(); fill();
  fireEvent.click(screen.getByRole('button', { name: 'Save card and audio' }));
  await waitFor(() => expect(draftStudyApi.saveCard).toHaveBeenCalledOnce());
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[1]);
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => finish());
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(fixture.records.has(source.id)).toBe(false);
});

it('retains failed card input while a pending native close waits even after unmount', async () => {
  const stop = subscribeWindowClose(hasPendingCloseTasks, { onError: vi.fn() });
  const source = selection(); let fail!: (cause: Error) => void;
  vi.mocked(draftStudyApi.saveCard).mockImplementationOnce(() => new Promise((_resolve,reject) => { fail = reject; }));
  const view = render(<DraftCardDialog selection={source} onClose={vi.fn()} />); await ready(); fill();
  fireEvent.click(screen.getByRole('button', { name: 'Save card and audio' }));
  await waitFor(() => expect(draftStudyApi.saveCard).toHaveBeenCalledOnce());
  expect(fixture.close?.()).toBe(true); expect(fixture.close?.()).toBe(true);
  view.unmount(); expect(fixture.destroy).not.toHaveBeenCalled();
  await act(async () => fail(Error('audio unavailable')));
  await waitFor(() => expect(fixture.destroy).toHaveBeenCalledOnce());
  expect(fixture.records.get(source.id)?.fields.meaning).toBe('meaning');
  stop();
});

it('keeps the editor open when durable storage fails', async () => {
  const onClose = vi.fn();
  render(<DraftCardDialog selection={selection()} onClose={onClose} />); await ready();
  vi.mocked(uiDraftApi.save).mockRejectedValueOnce(Error('disk full')).mockRejectedValueOnce(Error('disk full'));
  fireEvent.change(screen.getByLabelText('Phrase to remember'), { target: { value: 'keep me' } });
  await screen.findByRole('alert');
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[1]);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('disk full'));
  expect(onClose).not.toHaveBeenCalled(); expect(screen.getByLabelText('Phrase to remember')).toHaveValue('keep me');
});
