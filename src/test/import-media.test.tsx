// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ImportDialog } from '../features/library/ImportDialog';
import { LibraryPage } from '../features/library/LibraryPage';
import { libraryApi } from '../features/library/api';
import type { MediaFileValidation } from '../shared/contracts/media';

const fixture = vi.hoisted(() => ({ native: true, notify: vi.fn(), surfaceHidden: false }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => fixture.native }));
vi.mock('../features/library/api', () => ({ libraryApi: {
  selectMediaFiles: vi.fn(), validateMediaFiles: vi.fn(), importLocalMedia: vi.fn(), startUrlImport: vi.fn(),
} }));
vi.mock('../features/library/MediaManagement', () => ({ DownloadJobs: () => null }));
vi.mock('../features/transfer/TransferDialog', () => ({ TransferDialog: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="Your data"><button onClick={onClose}>Close data</button></div> }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to, params, ...props }: { children: ReactNode; to: string; params?: { mediaId: string }; className?: string }) => <a href={params ? `/study/${params.mediaId}` : to} {...props}>{children}</a> }));
const registerModal = () => () => {};
vi.mock('../app/runtime', () => ({
  useAppearance: () => ({ t: (_ja: string, en: string) => en, locale: 'en' }),
  useSnapshot: () => ({ data: { settings: { learningLanguage: 'en', explanationLanguage: 'ja' }, media: [], cards: [], jobs: [] }, loading: false }),
  useSurface: () => ({ registerModal, surfaceHidden: fixture.surfaceHidden }),
  useDataActions: () => ({ mutate: (action: () => Promise<unknown>) => action() }),
  useNotifications: () => ({ notify: fixture.notify, report: async (action: () => Promise<unknown>) => {
    try { return await action(); } catch (error) { fixture.notify(String(error), 'error'); return undefined; }
  } }),
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
beforeEach(() => {
  fixture.native = true;
  fixture.surfaceHidden = false;
  vi.mocked(listen).mockResolvedValue(() => {});
  vi.mocked(libraryApi.validateMediaFiles).mockImplementation(async paths => paths.map(inputPath => ({ inputPath, status: 'ready', canonicalPath: inputPath.toLowerCase() })));
  vi.mocked(libraryApi.selectMediaFiles).mockResolvedValue([]);
  vi.mocked(libraryApi.importLocalMedia).mockImplementation(async request => ({ mediaId: request.pathOrUrl, created: true }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
async function emit(event: string, payload: unknown = {}) {
  const handler = vi.mocked(listen).mock.calls.find(([name]) => name === event)?.[1];
  expect(handler).toBeDefined();
  await act(async () => { handler?.({ event, id: 1, payload }); });
}
function files() { return screen.getByRole('region', { name: 'Selected files' }); }

describe('local media review and import', () => {
  it('opens native drops for review, combines canonical duplicates and keeps invalid files actionable', async () => {
    vi.mocked(libraryApi.validateMediaFiles).mockImplementation(async paths => paths.map(inputPath => inputPath.endsWith('.txt')
      ? { inputPath, status: 'invalid', reason: 'unsupported' }
      : { inputPath, status: 'ready', canonicalPath: 'C:/video.mp4' }));
    render(<LibraryPage />);
    await emit('tauri://drag-enter', { paths: ['C:/VIDEO.MP4'] });
    expect(screen.getByText('Drop to add your materials')).toBeVisible();
    await emit('tauri://drag-leave');
    expect(screen.queryByText('Drop to add your materials')).not.toBeInTheDocument();
    await emit('tauri://drag-drop', { paths: ['C:/VIDEO.MP4', 'C:/video.mp4', 'C:/notes.txt'] });
    await screen.findByText('Ready to add');
    expect(within(files()).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(/Unsupported format/)).toBeVisible();
    expect(libraryApi.importLocalMedia).not.toHaveBeenCalled();
    await emit('tauri://drag-drop', { paths: ['C:/video.mp4'] });
    expect(within(files()).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt from this list' }));
    expect(within(files()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('continues after one file fails and retries only that file while retaining returned media links', async () => {
    vi.mocked(libraryApi.validateMediaFiles).mockImplementation(async paths => paths.map(inputPath => inputPath === 'C:/old.mp4'
      ? { inputPath, status: 'existing', canonicalPath: inputPath, mediaId: 'old-id' }
      : { inputPath, status: 'ready', canonicalPath: inputPath }));
    let failed = false;
    vi.mocked(libraryApi.importLocalMedia).mockImplementation(async request => {
      if (request.pathOrUrl === 'C:/b.mp4' && !failed) { failed = true; throw new Error('Could not read b.mp4'); }
      return { created: true, mediaId: request.pathOrUrl.split('/').at(-1)! };
    });
    const onClose = vi.fn();
    render(<ImportDialog onClose={onClose} droppedFiles={{ revision: 1, paths: ['C:/a.mp4', 'C:/b.mp4', 'C:/c.mp4', 'C:/old.mp4'] }} />);
    const add = await screen.findByRole('button', { name: 'Add 3 files to library' });
    fireEvent.click(add);
    await screen.findByRole('link', { name: 'Open c.mp4' });
    expect(screen.getByText('Could not read b.mp4')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open old.mp4' })).toHaveAttribute('href', '/study/old-id');
    expect(onClose).not.toHaveBeenCalled();
    expect(libraryApi.importLocalMedia).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed files' }));
    await screen.findByRole('link', { name: 'Open b.mp4' });
    expect(libraryApi.importLocalMedia).toHaveBeenCalledTimes(4);
    expect(vi.mocked(libraryApi.importLocalMedia).mock.calls.at(-1)?.[0].pathOrUrl).toBe('C:/b.mp4');
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('appends picker files and switches from URL on a drop without losing the URL', async () => {
    const onClose = vi.fn();
    const view = render(<ImportDialog onClose={onClose} droppedFiles={{ revision: 1, paths: ['C:/a.mp4'] }} />);
    await screen.findByText('Ready to add');
    vi.mocked(libraryApi.selectMediaFiles).mockResolvedValue(['C:/b.mp4']);
    fireEvent.click(screen.getByRole('button', { name: /Choose more files/ }));
    await screen.findByRole('button', { name: 'Add 2 files to library' });
    fireEvent.click(screen.getByRole('button', { name: 'URL' }));
    fireEvent.change(screen.getByLabelText(/^Video or audio URL/), { target: { value: 'https://example.com/audio.mp3' } });
    view.rerender(<ImportDialog onClose={onClose} droppedFiles={{ revision: 2, paths: ['C:/c.mp4'] }} />);
    await screen.findByRole('button', { name: 'Add 3 files to library' });
    fireEvent.click(screen.getByRole('button', { name: 'URL' }));
    expect(screen.getByLabelText(/^Video or audio URL/)).toHaveValue('https://example.com/audio.mp3');
    expect(libraryApi.importLocalMedia).not.toHaveBeenCalled();
  });

  it('rechecks an existing file against changed language settings before adding', async () => {
    vi.mocked(libraryApi.validateMediaFiles).mockImplementation(async (paths, language): Promise<MediaFileValidation[]> => paths.map(inputPath => language === 'en'
      ? { inputPath, status: 'existing', canonicalPath: inputPath, mediaId: 'english-id' }
      : { inputPath, status: 'ready', canonicalPath: inputPath }));
    render(<ImportDialog onClose={() => {}} droppedFiles={{ revision: 1, paths: ['C:/a.mp4'] }} />);
    await screen.findByText('Already in your library with these languages');
    fireEvent.change(screen.getByLabelText('Learning language'), { target: { value: 'fr' } });
    expect(screen.queryByRole('link', { name: 'Open a.mp4' })).not.toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add 1 file to library' });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    await waitFor(() => expect(libraryApi.importLocalMedia).toHaveBeenCalledWith(expect.objectContaining({ learningLanguage: 'fr' })));
  });

  it('updates ready rows for the selected languages and ignores a stale language response', async () => {
    let resolveFrench!: (result: MediaFileValidation[]) => void;
    vi.mocked(libraryApi.validateMediaFiles).mockImplementation(async (paths, language): Promise<MediaFileValidation[]> => {
      if (language === 'fr') return new Promise(resolve => { resolveFrench = resolve; });
      return paths.map(inputPath => language === 'de'
        ? { inputPath, status: 'existing', canonicalPath: inputPath, mediaId: 'german-id' }
        : { inputPath, status: 'ready', canonicalPath: inputPath });
    });
    render(<ImportDialog onClose={() => {}} droppedFiles={{ revision: 1, paths: ['C:/a.mp4'] }} />);
    await screen.findByText('Ready to add');
    fireEvent.change(screen.getByLabelText('Learning language'), { target: { value: 'fr' } });
    await waitFor(() => expect(resolveFrench).toBeDefined());
    expect(screen.getByLabelText('Learning language')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Learning language'), { target: { value: 'de' } });
    const open = await screen.findByRole('link', { name: 'Open a.mp4' });
    expect(open).toHaveAttribute('href', '/study/german-id');
    await act(async () => resolveFrench([{ inputPath: 'C:/a.mp4', status: 'ready', canonicalPath: 'C:/a.mp4' }]));
    expect(screen.getByRole('link', { name: 'Open a.mp4' })).toHaveAttribute('href', '/study/german-id');
    expect(screen.queryByRole('button', { name: 'Add 1 file to library' })).not.toBeInTheDocument();
    expect(libraryApi.importLocalMedia).not.toHaveBeenCalled();
  });

  it('ignores drops while working or another dialog is open and returns to an unfiltered library', async () => {
    let resolveImport!: (result: { created: boolean; mediaId: string }) => void;
    vi.mocked(libraryApi.importLocalMedia).mockReturnValue(new Promise(resolve => { resolveImport = resolve; }));
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Your data' }));
    await emit('tauri://drag-drop', { paths: ['C:/ignored.mp4'] });
    expect(libraryApi.validateMediaFiles).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close data' }));
    fireEvent.change(screen.getByLabelText('Search your library'), { target: { value: 'hidden' } });
    fireEvent.click(screen.getByRole('button', { name: 'Audio' }));
    await emit('tauri://drag-drop', { paths: ['C:/a.mp4'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Add 1 file to library' }));
    await waitFor(() => expect(libraryApi.importLocalMedia).toHaveBeenCalledOnce());
    const validationCount = vi.mocked(libraryApi.validateMediaFiles).mock.calls.length;
    await emit('tauri://drag-drop', { paths: ['C:/ignored.mp4'] });
    expect(libraryApi.validateMediaFiles).toHaveBeenCalledTimes(validationCount);
    expect(screen.getByRole('button', { name: 'URL' })).toBeDisabled();
    await act(async () => resolveImport({ created: true, mediaId: 'a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Return to library' }));
    expect(screen.getByLabelText('Search your library')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('cleans up all native listeners, including registration completed after unmount', async () => {
    const pending: Array<(stop: () => void) => void> = [];
    vi.mocked(listen).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const view = render(<LibraryPage />);
    expect(pending).toHaveLength(4);
    view.unmount();
    const stops = pending.map(() => vi.fn());
    await act(async () => pending.forEach((resolve, index) => resolve(stops[index])));
    stops.forEach(stop => expect(stop).toHaveBeenCalledOnce());
    await emit('tauri://drag-drop', { paths: ['C:/late.mp4'] });
    expect(libraryApi.validateMediaFiles).not.toHaveBeenCalled();
  });

  it('prevents browser file navigation and explains the desktop requirement without inventing a path', () => {
    fixture.native = false;
    const view = render(<LibraryPage />);
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [new File(['video'], 'movie.mp4')] } });
    fireEvent(view.container.querySelector('.library-page')!, event);
    expect(event.defaultPrevented).toBe(true);
    expect(fixture.notify).toHaveBeenCalledWith('Open Surtitle desktop to use this feature.', 'error');
    expect(listen).not.toHaveBeenCalled();
    expect(libraryApi.validateMediaFiles).not.toHaveBeenCalled();
    expect(libraryApi.importLocalMedia).not.toHaveBeenCalled();
  });
});
