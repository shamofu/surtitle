// SPDX-License-Identifier: GPL-3.0-or-later
vi.mock('../app/providers/Activities', () => import('./activity-fixture'));
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { listen } from '@tauri-apps/api/event';
import { importWorkspace } from '../features/library/import-workspace';
vi.mock('../shared/editing/drafts', () => import('./editing-mocks'));
import { ImportDialog } from '../features/library/ImportDialog';
import { LibraryPage } from '../features/library/LibraryPage';
import { libraryApi } from '../features/library/api';

const fixture = vi.hoisted(() => ({ native: true, notify: vi.fn(), surfaceHidden: false }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => fixture.native }));
vi.mock('../features/library/api', () => ({ libraryApi: {
  selectMediaFiles: vi.fn(), validateMediaFiles: vi.fn(), importLocalMedia: vi.fn(), startUrlImport: vi.fn(),
} }));
vi.mock('../features/library/MediaManagement', () => ({ DownloadJobsDialog: ({ onClose }: { onClose: () => void }) => <div role="dialog" data-app-modal aria-label="Downloads"><button onClick={onClose}>Close downloads</button></div> }));
vi.mock('../features/transfer/TransferDialog', () => ({ TransferDialog: ({ onClose }: { onClose: () => void }) => <div role="dialog" data-app-modal aria-label="Your data"><button onClick={onClose}>Close data</button></div> }));
vi.mock('@tanstack/react-router', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-router')>(),
  useNavigate: () => async () => {},
  Link: ({ children, to, params, ...props }: { children: ReactNode; to: string; params?: { mediaId: string }; className?: string }) => <a href={params ? `/study/${params.mediaId}` : to} {...props}>{children}</a>,
  createLink: (Component: ComponentType<AnchorHTMLAttributes<HTMLAnchorElement>>) =>
    ({ to, params, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; params?: { mediaId: string } }) =>
      <Component {...props} href={to.replace('$mediaId', params?.mediaId ?? '')} />,
}));
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
  importWorkspace.clear(); importWorkspace.change({ mode: 'local', url: '', learningLanguage: 'en', explanationLanguage: 'ja' });
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

it('returns focus to library search when clearing or resetting its filters', async () => {
  render(<LibraryPage />);
  const user = userEvent.setup();
  const search = screen.getByRole('textbox', { name: 'Search your library' });
  await user.type(search, 'missing title');
  await user.tab();
  expect(screen.getByRole('button', { name: 'Clear search' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(search).toHaveValue('');
  expect(search).toHaveFocus();
  await user.type(search, 'another title');
  await user.click(screen.getByRole('button', { name: 'Reset filters' }));
  expect(search).toHaveFocus();
  expect(search).toHaveValue('');
});

describe('automatic local import', () => {
  it('starts on drop and shows completed counts while the next file is importing', async () => {
    let finish!: (result: { mediaId: string; created: boolean }) => void;
    vi.mocked(libraryApi.importLocalMedia).mockResolvedValueOnce({ mediaId: 'first', created: true }).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<ImportDialog onClose={() => {}} droppedFiles={{ revision: 1, paths: ['C:/a.mp4', 'C:/b.mp4'] }} />);
    await waitFor(() => expect(libraryApi.importLocalMedia).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('progressbar', { name: 'Importing files' })).toHaveAttribute('value', '1');
    expect(screen.queryByRole('button', { name: /Add.*files to library/ })).not.toBeInTheDocument();
    await act(async () => finish({ mediaId: 'second', created: true }));
    await screen.findByRole('link', { name: 'Open b.mp4' });
  });
  it('deduplicates canonical paths and reports invalid files without an extra start', async () => {
    vi.mocked(libraryApi.validateMediaFiles).mockImplementation(async paths => paths.map(inputPath => inputPath.endsWith('.txt')
      ? { inputPath, status: 'invalid', reason: 'unsupported' } : { inputPath, status: 'ready', canonicalPath: 'C:/video.mp4' }));
    render(<LibraryPage />);
    await emit('tauri://drag-drop', { paths: ['C:/VIDEO.MP4', 'C:/video.mp4', 'C:/notes.txt'] });
    await screen.findByText('Added'); expect(libraryApi.importLocalMedia).toHaveBeenCalledOnce();
    expect(within(files()).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('This file cannot be imported')).toBeVisible();
  });
  it('keeps importing after panel unmount and exposes the finished links on reopening', async () => {
    let finish!: (result: { mediaId: string; created: boolean }) => void;
    vi.mocked(libraryApi.importLocalMedia).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<ImportDialog onClose={() => {}} droppedFiles={{ revision: 1, paths: ['C:/a.mp4', 'C:/b.mp4'] }} />);
    await waitFor(() => expect(libraryApi.importLocalMedia).toHaveBeenCalledOnce()); view.unmount();
    await act(async () => finish({ mediaId: 'first', created: true }));
    await waitFor(() => expect(importWorkspace.getSnapshot().busy).toBe(false));
    expect(libraryApi.importLocalMedia).toHaveBeenCalledTimes(2);
    render(<ImportDialog onClose={() => {}} />); await screen.findByRole('link', { name: 'Open b.mp4' });
  });
  it('continues after a failed item and retries only failed paths', async () => {
    vi.mocked(libraryApi.importLocalMedia).mockRejectedValueOnce(Error('Cannot read a')).mockResolvedValueOnce({ mediaId: 'b', created: true });
    render(<ImportDialog onClose={() => {}} droppedFiles={{ revision: 1, paths: ['C:/a.mp4', 'C:/b.mp4'] }} />);
    await screen.findByRole('link', { name: 'Open b.mp4' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed files' }));
    await screen.findByRole('link', { name: 'Open a.mp4' }); expect(libraryApi.importLocalMedia).toHaveBeenCalledTimes(3);
  });
  it('starts selected files immediately and retains URL input when switching sources', async () => {
    vi.mocked(libraryApi.selectMediaFiles).mockResolvedValue(['C:/picked.mp4']);
    render(<ImportDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'URL' }));
    fireEvent.change(screen.getByLabelText(/^Video or audio URL/), { target: { value: 'https://example.com/a.mp4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Local file' }));
    fireEvent.click(screen.getByRole('button', { name: /Choose a video or audio file/ }));
    await screen.findByRole('link', { name: 'Open picked.mp4' });
    fireEvent.click(screen.getByRole('button', { name: 'URL' })); expect(screen.getByLabelText(/^Video or audio URL/)).toHaveValue('https://example.com/a.mp4');
    expect(libraryApi.importLocalMedia).toHaveBeenCalledOnce();
  });
  it('allows importing the same path with another explicit language pair', async () => {
    render(<ImportDialog onClose={() => {}} droppedFiles={{ revision: 1, paths: ['C:/a.mp4'] }} />);
    await screen.findByRole('link', { name: 'Open a.mp4' });
    fireEvent.change(screen.getByLabelText('Learning language'), { target: { value: 'fr' } });
    vi.mocked(libraryApi.selectMediaFiles).mockResolvedValue(['C:/a.mp4']);
    fireEvent.click(screen.getByRole('button', { name: /Choose a video or audio file/ }));
    await waitFor(() => expect(libraryApi.importLocalMedia).toHaveBeenCalledTimes(2));
    expect(vi.mocked(libraryApi.importLocalMedia).mock.calls[1][0].learningLanguage).toBe('fr');
  });
  it('does not deliver drops through a different open dialog', async () => {
    render(<LibraryPage />); fireEvent.click(screen.getByRole('button', { name: 'Your data' }));
    await emit('tauri://drag-drop', { paths: ['C:/ignored.mp4'] }); expect(libraryApi.validateMediaFiles).not.toHaveBeenCalled();
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
