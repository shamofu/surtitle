// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityProvider, mergeOperationProgress, useActivities } from '../app/providers/Activities';
import { ActivityButton } from '../app/ActivityModal';
import { SurfaceProvider, useSurface } from '../app/providers/Surface';
import { ProgressStatus } from '../shared/ui/ProgressStatus';
import { recentActivities, type Activity, type ActivityUpdate, type OperationProgress } from '../shared/contracts/activity';
import { queryKeys } from '../shared/query/keys';
import { aiApi } from '../features/ai/api';

const fixture = vi.hoisted(() => ({ native: false, downloads: [] as unknown[], operations: [] as unknown[], snapshot: { jobs: [] as unknown[], media: [] as unknown[] } }));
vi.mock('../app/providers/Appearance', () => ({ useAppearance: () => ({ t: (_ja: string, en: string) => en }) }));
vi.mock('../app/providers/Snapshot', () => ({ useSnapshot: () => ({ data: fixture.snapshot }) }));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => fixture.native, call: vi.fn(async () => fixture.operations) }));
vi.mock('../features/library/api', () => ({ libraryApi: { downloadJobs: vi.fn(async () => fixture.downloads), cancelDownload: vi.fn(async () => {}) } }));
vi.mock('../features/ai/api', () => ({ aiApi: { cancelAiJob: vi.fn(async () => {}), cancelPreparation: vi.fn(async () => {}) } }));
vi.mock('../app/runtime', async () => ({
  useAppearance: () => ({ t: (_ja: string, en: string) => en }),
  useSurface: (await import('../app/providers/Surface')).useSurface,
  useNotifications: () => ({ report: (action: () => Promise<unknown>) => action() }),
  useDataActions: () => ({ mutate: (action: () => Promise<unknown>) => action() }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => async () => {}, Link: ({ children, onClick, to, params }: { children: React.ReactNode; onClick?: () => void; to: string; params?: { mediaId: string } }) => <a href={to.replace('$mediaId', params?.mediaId ?? '')} onClick={onClick}>{children}</a> }));

let clients: QueryClient[] = [];
beforeEach(() => {
  fixture.native = false;
  fixture.downloads = [];
  fixture.operations = [];
  fixture.snapshot = { jobs: [], media: [] };
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients = []; vi.clearAllMocks(); });
function mount(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const result = render(<QueryClientProvider client={client}><SurfaceProvider><ActivityProvider>{children}</ActivityProvider></SurfaceProvider></QueryClientProvider>);
  return { ...result, client };
}
function Overview() {
  const { activities, runningCount } = useActivities();
  const { surfaceHidden } = useSurface();
  return <><output data-testid="count">{runningCount}</output><output data-testid="activities">{JSON.stringify(activities)}</output><output>{surfaceHidden ? 'Video hidden' : 'Video visible'}</output><ActivityButton /></>;
}

describe('shared operation lifecycle', () => {
  it('continues tracking after the initiating screen unmounts and keeps partial failure counts', async () => {
    let finish!: () => void;
    let update!: (patch: ActivityUpdate) => void;
    function Caller() {
      const { runTracked } = useActivities();
      return <button onClick={() => void runTracked({ label: 'Import files', kind: 'import', total: 3, completed: 0, unit: 'items' }, async publish => {
        update = publish; await new Promise<void>(resolve => { finish = resolve; });
      })}>Import</button>;
    }
    function Host() { const [show, setShow] = useState(true); return <><button onClick={() => setShow(false)}>Navigate</button>{show && <Caller />}<Overview /></>; }
    mount(<Host />);
    fireEvent.click(screen.getByText('Import'));
    fireEvent.click(screen.getByText('Navigate'));
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    await act(async () => { update({ completed: 3, status: 'failed', error: 'One file could not be imported' }); finish(); });
    expect(screen.getByTestId('count')).toHaveTextContent('0');
    fireEvent.click(screen.getByRole('button', { name: 'Open activity' }));
    expect(screen.getByText('One file could not be imported')).toBeVisible();
    expect(screen.getByText('3 / 3')).toBeVisible();
    expect(screen.getByText('Video hidden')).toBeVisible();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Video visible')).toBeVisible();
  });

  it('classifies picker cancellation and ignores late updates after completion', async () => {
    let update!: (patch: ActivityUpdate) => void;
    function Caller() { const { runTracked } = useActivities(); return <button onClick={() => void runTracked({ label: 'Backup', kind: 'export' }, async publish => { update = publish; return []; }, { classifyResult: paths => ({ status: paths.length ? 'completed' : 'cancelled' }) })}>Export</button>; }
    mount(<><Caller /><Overview /></>);
    await act(async () => { fireEvent.click(screen.getByText('Export')); });
    act(() => update({ status: 'running', completed: 10 }));
    expect(screen.getByTestId('activities')).toHaveTextContent('"status":"cancelled"');
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });

  it('does not let an older call overwrite a newer operation with the same descriptor id', async () => {
    const finish: (() => void)[] = [];
    let sequence = 0;
    function Caller() { const { runTracked } = useActivities(); return <button onClick={() => void runTracked({ id: 'same', label: `Call ${++sequence}`, kind: 'import' }, () => new Promise<void>(resolve => { finish.push(resolve); }))}>Start</button>; }
    mount(<><Caller /><Overview /></>);
    fireEvent.click(screen.getByText('Start'));
    fireEvent.click(screen.getByText('Start'));
    await act(async () => finish[0]());
    expect(screen.getByTestId('activities')).toHaveTextContent('Call 2');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    await act(async () => finish[1]());
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });

  it('excludes historic results, captures downloads completed between polls, and keeps queued AI out of the running count', async () => {
    fixture.native = true;
    const old = { id: 'old', request: { pathOrUrl: 'Old download' }, status: 'completed', phase: 'completed', storedBytes: 12, updatedAt: '2020-01-01T00:00:00Z' };
    fixture.downloads = [old];
    fixture.snapshot.jobs = [{ id: 'quote', kind: 'transcribe', status: 'queued', progress: 0, createdAt: '2020-01-01T00:00:00Z' }];
    const { client } = mount(<Overview />);
    await act(async () => { await client.refetchQueries({ queryKey: queryKeys.downloads }); });
    await waitFor(() => expect(screen.getByTestId('activities')).toHaveTextContent('ai:quote'));
    expect(screen.getByTestId('activities')).not.toHaveTextContent('Old download');
    expect(screen.getByTestId('count')).toHaveTextContent('0');
    fixture.downloads = [old, { ...old, id: 'new', request: { pathOrUrl: 'New download' } }];
    await act(async () => { await client.refetchQueries({ queryKey: queryKeys.downloads }); });
    await waitFor(() => expect(screen.getByTestId('activities')).toHaveTextContent('New download'));
    fireEvent.click(screen.getByRole('button', { name: 'Open activity' }));
    expect(screen.getByText('Awaiting approval')).toBeVisible();
  });
});

describe('progress presentation', () => {
  it('renders measured, clamped progress and makes an unknown total indeterminate', () => {
    const view = render(<ProgressStatus label="Download" phase="downloading" completed={120} total={100} unit="bytes" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '100');
    expect(screen.getByRole('progressbar')).toHaveAttribute('max', '100');
    view.rerender(<ProgressStatus label="Download" phase="downloading" completed={120} total={0} unit="bytes" />);
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('value');
    expect(screen.getByText(/Stored size/)).toBeVisible();
  });

  it('retains native children for inline lookup while showing a single grouped running count', async () => {
    fixture.native = true;
    const base = { status: 'running', phase: 'preparing', updatedAt: new Date().toISOString() };
    fixture.operations = [{ ...base, id: 'prepare', kind: 'preparation', label: 'Audio preparation' }, { ...base, id: 'ffmpeg', kind: 'tool', parentId: 'prepare', label: 'FFmpeg' }];
    mount(<Overview />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    expect(screen.getByTestId('activities')).toHaveTextContent('ffmpeg');
    fireEvent.click(screen.getByRole('button', { name: 'Open activity' }));
    expect(screen.getByText('FFmpeg')).toBeVisible();
    expect(document.querySelectorAll('.activity-item')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(aiApi.cancelPreparation).toHaveBeenCalledExactlyOnceWith('prepare'));
  });

  it('rejects older native snapshots and does not revive a completed operation', () => {
    const completed: OperationProgress = { id: 'op', kind: 'tool', status: 'completed', phase: 'completed', label: 'Tool', updatedAt: '2026-10-10T00:00:02Z' };
    const current = { op: completed };
    const incoming: OperationProgress = { ...completed, status: 'running', phase: 'downloading', updatedAt: '2026-10-10T00:00:01Z' };
    expect(mergeOperationProgress(current, [incoming]).op).toEqual(completed);
    expect(mergeOperationProgress(current, [{ ...incoming, updatedAt: '2026-10-10T00:00:03Z' }]).op).toEqual(completed);
  });

  it('groups automatic tool setup under a download using its native parent id', async () => {
    fixture.native = true;
    const updatedAt = new Date().toISOString();
    fixture.downloads = [{ id: 'download-id', request: { pathOrUrl: 'A video' }, status: 'running', phase: 'preparing_tools', storedBytes: 0, updatedAt }];
    fixture.operations = [{ id: 'tool-id', parentId: 'download-id', kind: 'tool', label: 'yt-dlp', status: 'running', phase: 'downloading', updatedAt }];
    mount(<Overview />);
    await waitFor(() => expect(screen.getByTestId('activities')).toHaveTextContent('"parentId":"download:download-id"'));
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('keeps all active operations ahead of only the newest twenty terminal results', () => {
    const results: Activity[] = Array.from({ length: 24 }, (_, index) => ({ id: `result-${index}`, source: 'local', kind: 'export', label: 'Export', status: 'completed', updatedAt: new Date(index * 1000).toISOString() }));
    const active: Activity = { id: 'active', source: 'local', kind: 'export', label: 'Export', status: 'running', updatedAt: new Date(0).toISOString() };
    const visible = recentActivities([active, ...results]);
    expect(visible).toHaveLength(21);
    expect(visible[0]).toEqual(active);
    expect(visible[1].id).toBe('result-23');
    expect(visible.at(-1)?.id).toBe('result-4');
  });

  it('lists running work before newer approval waits and paused work', () => {
    const base: Activity = { id: 'running', source: 'local', kind: 'export', label: 'Export', status: 'running', updatedAt: '2026-01-01T00:00:00Z' };
    const visible = recentActivities([base,
      { ...base, id: 'waiting', status: 'waiting', updatedAt: '2026-01-01T00:00:03Z' },
      { ...base, id: 'paused', status: 'paused', updatedAt: '2026-01-01T00:00:02Z' },
      { ...base, id: 'done', status: 'completed', updatedAt: '2026-01-01T00:00:04Z' },
    ]);
    expect(visible.map(activity => activity.id)).toEqual(['running', 'waiting', 'paused', 'done']);
  });

  it('links local operations to settings, library, or their specific media', async () => {
    const settings = ['tool_check', 'models', 'tool_scan', 'tool_updates'];
    const library = ['import_check', 'import', 'restore', 'restore_preview', 'export'];
    function Caller() {
      const { runTracked } = useActivities();
      return <button onClick={() => void Promise.all([
        ...[...settings, ...library].map(kind => runTracked({ id: kind, kind, label: kind }, async () => true)),
        runTracked({ id: 'media-export', kind: 'export', label: 'Media export', mediaId: 'movie' }, async () => true),
      ])}>Run operations</button>;
    }
    mount(<><Caller /><Overview /></>);
    await act(async () => { fireEvent.click(screen.getByText('Run operations')); });
    fireEvent.click(screen.getByRole('button', { name: 'Open activity' }));
    for (const kind of settings) expect(within(document.querySelector(`[data-activity-id="${kind}"]`)! as HTMLElement).getByRole('link')).toHaveAttribute('href', '/settings');
    for (const kind of library) expect(within(document.querySelector(`[data-activity-id="${kind}"]`)! as HTMLElement).getByRole('link')).toHaveAttribute('href', '/');
    expect(within(document.querySelector('[data-activity-id="media-export"]')! as HTMLElement).getByRole('link')).toHaveAttribute('href', '/study/movie');
  });
});
