// SPDX-License-Identifier: GPL-3.0-or-later
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StudyPage } from '../features/study/StudyPage';
import { studyApi } from '../features/study/api';
import { playerApi } from '../features/study/playback/api';
import { settingsApi } from '../features/settings/api';
import { aiApi } from '../features/ai/api';
import { continuationApi } from '../features/ai/continuations';
import type { AiContinuation } from '../features/ai/continuations';
import { editorDraftApi } from '../features/study/editor-drafts/api';
import type { EditorDraft } from '../features/study/editor-drafts/api';
import { clearEditorDraftSessions, flushEditorDrafts } from '../features/study/editor-drafts/session';
import { cardsApi } from '../features/cards/api';
import { queryKeys } from '../shared/query/keys';
import type { PlayerState } from '../shared/contracts/player';
import type { SubtitleSegment } from '../shared/contracts/media';
import type { AppSettings } from '../shared/contracts/settings';
import { uiDraftApi } from '../shared/editing/drafts';
vi.mock('../app/providers/Activities', () => import('./activity-fixture'));
vi.mock('../shared/editing/drafts', () => import('./editing-mocks'));
vi.mock('../shared/editing/session', async importOriginal => {
  const actual = await importOriginal<typeof import('../shared/editing/session')>();
  return { ...actual, editingSession: (kind: import('../shared/contracts/editing').DraftKind, id: string, adapter: import('../shared/editing/session').EditAdapter) => {
    const key = `${kind}:${id}`;
    let session = fixture.editingSessions.get(key);
    if (!session) { session = new actual.EditingSession(kind, id, adapter); fixture.editingSessions.set(key, session); }
    return session;
  } };
});

const fixture = vi.hoisted(() => ({
  settings: {} as AppSettings,
  settingsRevision: 0,
  editingSessions: new Map<string, import('../shared/editing/session').EditingSession>(),
  resumeId: undefined as string | undefined,
  aiDialogProps: undefined as undefined | { continuation?: AiContinuation; sourceInvalid?: boolean; sourceContext?: { sourceCueIds: string[]; sourceRevision: string }; onReselectSource?: (item: AiContinuation) => void },
  hasMedia: true,
  snapshotAvailable: true,
  snapshotLoading: false,
  snapshotError: null as Error | null,
  blockerStatus: 'idle',
  resetBlocker: vi.fn(),
  media: {
    id: 'media',
    title: 'Study fixture',
    path: 'C:/fixture.mkv',
    audioStreamIndex: undefined as number | undefined,
    kind: 'video',
    durationMs: 4000,
    learningLanguage: 'en',
    explanationLanguage: 'ja',
    status: 'ready',
    lastPositionMs: 0,
    createdAt: '2026-01-01T00:00:00Z',
    segmentCount: 3,
    cardCount: 0,
  },
  notify: vi.fn(),
  refresh: vi.fn(),
  scroll: vi.fn(),
  scrollOffset: vi.fn(),
  registerModal: () => () => {},
  listener: undefined as
    | undefined
    | ((event: { payload: PlayerState }) => void),
}));

vi.mock('../features/study/api', () => ({
  studyApi: { segments: vi.fn(), candidates: vi.fn(), transcriptIssues: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../features/study/playback/api', () => ({
  playerApi: {
    loadMedia: vi.fn(),
    playerState: vi.fn(),
    player: vi.fn(),
    playSourceRange: vi.fn(),
  },
}));
vi.mock('../features/cards/api', () => ({ cardsApi: { saveCard: vi.fn() } }));
vi.mock('../features/ai/api', () => ({ aiApi: { createQuote: vi.fn() } }));
vi.mock('../features/settings/api', () => ({
  settingsApi: { updateSettings: vi.fn(), state: vi.fn(), patch: vi.fn() },
}));

vi.mock('../features/ai/continuations', () => ({ continuationApi: { list: vi.fn().mockResolvedValue([]), save: vi.fn(), discard: vi.fn() } }));
vi.mock('../features/study/editor-drafts/api', () => ({
  editorSourceKey: (cues: {id:string}[]) => JSON.stringify(cues.map(cue => cue.id)),
  editorDraftApi: {
    list: vi.fn().mockResolvedValue([]),
    save: vi.fn(async (request) => ({ ...request, version: request.expectedVersion + 1, stale: false, bindingVerified: true, sourceMediaSignature: '', createdAt: '', updatedAt: '' })),
    discard: vi.fn().mockResolvedValue(undefined), rebind: vi.fn(), commitSubtitle: vi.fn(),
    savePhrase: vi.fn(async (_reference, request) => cardsApi.saveCard(request)),
  },
}));
vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
vi.mock('../shared/native/window', () => ({ registerCloseTask: () => () => {}, subscribeWindowClose: () => () => {}, closeWindow: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, listener: typeof fixture.listener) => {
    if (name === 'player-state') fixture.listener = listener;
    return () => {};
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ mediaId: 'media' }),
  useSearch: () => ({ resume: fixture.resumeId }),
  useNavigate: () => vi.fn(),
  useBlocker: () => ({ status: fixture.blockerStatus, reset: fixture.resetBlocker, proceed: vi.fn() }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    scrollRect: { width: 400, height: 600 },
    scrollToIndex: fixture.scroll,
    scrollToOffset: fixture.scrollOffset,
    measure: () => {},
    resizeItem: () => {},
    takeSnapshot: () => [],
    getTotalSize: () => count * 118,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 118,
      })),
    measureElement: () => {},
  }),
}));
vi.mock('../app/runtime', () => {
  const t = (_ja: string, en: string) => en;
  const report = async (action: () => Promise<unknown>) => {
    try {
      const result = await action();
      await fixture.refresh();
      return result;
    } catch (error) {
      fixture.notify(String(error), 'error');
      return undefined;
    }
  };
  const useFixture = () => ({
    mutate: (action: () => Promise<unknown>) => action(),
    data: fixture.snapshotAvailable ? { settings: fixture.settings, media: fixture.hasMedia ? [fixture.media] : [], cards: [], jobs: [] } : undefined,
    loading: fixture.snapshotLoading,
    error: fixture.snapshotError,
    locale: 'en',
    t,
    notify: fixture.notify,
    refresh: fixture.refresh,
    report,
    surfaceHidden: false,
    registerModal: fixture.registerModal,
  });
  return {
    useSnapshot: useFixture,
    useDataActions: useFixture,
    useAppearance: useFixture,
    useNotifications: useFixture,
    useSurface: useFixture,
  };
});
vi.mock('../features/ai/AiDialog', () => ({ AiDialog: (props: NonNullable<typeof fixture.aiDialogProps>) => {
  fixture.aiDialogProps = props;
  return props.sourceInvalid && props.continuation ? <button onClick={() => props.onReselectSource?.(props.continuation!)}>Select subtitles again</button> : null;
} }));
vi.mock('../features/transfer/TransferDialog', () => ({
  TransferDialog: () => null,
}));
vi.mock('../features/library/MediaManagement', () => ({
  RemoveMediaDialog: () => null,
  SubtitleSourceDialog: () => null,
}));
vi.mock('../features/ai/JobActions', () => ({ JobActions: () => null }));

const cues: SubtitleSegment[] = [
  {
    id: 'a',
    mediaId: 'media',
    startMs: 0,
    endMs: 1000,
    text: 'I would like',
    status: 'confirmed',
  },
  {
    id: 'b',
    mediaId: 'media',
    startMs: 1000,
    endMs: 2000,
    text: 'to go home.',
    status: 'confirmed',
  },
  {
    id: 'c',
    mediaId: 'media',
    startMs: 2500,
    endMs: 3200,
    text: 'Next sentence.',
    status: 'confirmed',
  },
];
let state: PlayerState;
const clients: QueryClient[] = [];
const initialViewport = { width: window.innerWidth, height: window.innerHeight };
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <StudyPage />
    </QueryClientProvider>,
  );
  return client;
}
async function emit(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  await act(async () => {
    fixture.listener?.({ payload: state });
  });
}
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
beforeEach(() => {
  // These interaction cases explicitly open their panel in a compact workarea.
  // Wide-screen automatic disclosure is covered separately below.
  window.innerWidth = 1024;
  window.innerHeight = 680;
  fixture.editingSessions.clear();
  fixture.settingsRevision = 0;
  fixture.settings = { theme: 'dark', locale: 'en', learningLanguage: 'en', explanationLanguage: 'ja', dailyBudgetUsd: 0,
    vertexProject: '', vertexLocation: 'global', credentialConfigured: false, retention: .9, captionGapMode: 'review' };
  vi.mocked(settingsApi.state).mockImplementation(async () => ({ settings: structuredClone(fixture.settings), revision: String(fixture.settingsRevision) }));
  vi.mocked(settingsApi.patch).mockImplementation(async (revision, patch) => {
    if (revision !== String(fixture.settingsRevision)) throw Error('Settings changed; reload before saving');
    const { budgets, ...normal } = patch;
    Object.assign(fixture.settings, normal, budgets ?? {});
    return { settings: structuredClone(fixture.settings), revision: String(++fixture.settingsRevision) };
  });
  vi.mocked(uiDraftApi.get).mockResolvedValue(null);
  vi.mocked(uiDraftApi.remove).mockResolvedValue(undefined);
  vi.mocked(uiDraftApi.save).mockImplementation(async (kind, entityId, revision, fields) => ({ kind, entityId, revision: revision + 1, fields, updatedAt: '', stale: false }));
  fixture.snapshotAvailable = true;
  fixture.snapshotLoading = false;
  fixture.snapshotError = null;
  fixture.resumeId = undefined;
  fixture.aiDialogProps = undefined;
  vi.mocked(continuationApi.list).mockResolvedValue([]);
  vi.mocked(continuationApi.save).mockImplementation(async item => item);
  vi.mocked(editorDraftApi.list).mockResolvedValue([]);
  vi.mocked(editorDraftApi.save).mockImplementation(async request => ({ ...request, version: request.expectedVersion + 1, stale: false, bindingVerified: true, sourceMediaSignature: '', createdAt: '', updatedAt: '' }));
  vi.mocked(editorDraftApi.discard).mockResolvedValue(undefined);
  vi.mocked(editorDraftApi.savePhrase).mockImplementation(async (_reference, request) => cardsApi.saveCard(request));

  state = {
    ready: true,
    positionMs: 0,
    durationMs: 4000,
    paused: true,
    rate: 1,
    volume: 80,
    tracks: [],
    sentencePause: false,
  };
  vi.mocked(studyApi.segments).mockResolvedValue(cues);
  vi.mocked(studyApi.transcriptIssues).mockResolvedValue([]);
  vi.mocked(studyApi.candidates).mockResolvedValue([
    {
      id: 'candidate',
      mediaId: 'media',
      segmentId: 'a',
      sourceCueIds: ['a', 'b'],
      term: 'go home',
      meaning: 'Return home',
      example: 'I would like to go home.',
      startMs: 0,
      endMs: 2000,
    },
  ]);
  vi.mocked(playerApi.loadMedia).mockResolvedValue();
  vi.mocked(playerApi.playerState).mockImplementation(async () => state);
  vi.mocked(playerApi.player).mockImplementation(async (request) => {
    if (request.action === 'pause') state = { ...state, paused: true };
    if (request.action === 'play') state = { ...state, paused: false };
    if (request.action === 'sentence-pause') {
      state = { ...state, sentencePause: request.value === 1 };
      fixture.settings.sentencePause = state.sentencePause;
      fixture.settingsRevision++;
    }
  });
  vi.mocked(playerApi.playSourceRange).mockResolvedValue();
});
afterEach(async () => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  await Promise.all([...fixture.editingSessions.values()].map(session => session.flush()));
  await flushEditorDrafts().catch(() => {});
  clearEditorDraftSessions();
  clients.splice(0).forEach((client) => client.clear());
  fixture.listener = undefined;
  fixture.media.path = 'C:/fixture.mkv';
  fixture.media.audioStreamIndex = undefined;
  fixture.media.learningLanguage = 'en';
  fixture.media.explanationLanguage = 'ja';
  fixture.media.durationMs = 4000;
  fixture.hasMedia = true;
  fixture.blockerStatus = 'idle';
  vi.resetAllMocks();
  window.innerWidth = initialViewport.width;
  window.innerHeight = initialViewport.height;
});

const inspectButton = () => screen.getByRole('button', { name: 'Explore meaning' });
const phraseSaveToggle = () => within(document.querySelector('.phrase-inspector') as HTMLElement).getByRole('button', { name: 'Save phrase', expanded: false });
const savePhrase = () => within(document.getElementById('phrase-save-form')!).getByRole('button', { name: 'Save phrase' });
const inspectReplay = () => within(document.querySelector('.phrase-inspector') as HTMLElement).getByRole('button', { name: 'Play this passage' });
async function ready() {
  await waitFor(() => expect(inspectButton()).toBeEnabled());
}
async function openTranscript() {
  fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Transcript' })).toHaveAttribute('aria-expanded', 'true'));
}
function openPlaybackSettings() {
  fireEvent.click(screen.getByRole('button', { name: 'Playback settings' }));
}
async function inspectCurrent() {
  await ready();
  fireEvent.click(inspectButton());
  await screen.findByRole('button', { name: 'Resume from original position' });
}

it.each([
  [1440, 900, true], [1000, 681, true], [1000, 680, false], [999, 900, false],
])('chooses the initial transcript layout at %i × %i without stealing focus', async (width, height, open) => {
  window.innerWidth = width;
  window.innerHeight = height;
  const before = document.createElement('button');
  document.body.append(before);
  before.focus();
  try {
    mount();
    await ready();
    expect(screen.getByRole('button', { name: 'Transcript' })).toHaveAttribute('aria-expanded', String(open));
    expect(before).toHaveFocus();
    const toggle = screen.getByRole('button', { name: 'Transcript' });
    expect(toggle.closest('.study-top')).not.toBeNull();
  } finally { before.remove(); }
});

it('keeps a chosen transcript state when the workarea changes', async () => {
  window.innerWidth = 1440;
  window.innerHeight = 900;
  mount();
  await ready();
  const toggle = screen.getByRole('button', { name: 'Transcript' });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
  window.innerWidth = 1024;
  window.innerHeight = 700;
  fireEvent.resize(window);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
  window.innerHeight = 600;
  fireEvent.resize(window);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
});

it('marks a visible opening panel disabled until native placement accepts input, then retains search and focus', async () => {
  mount();
  await ready();
  const viewport = document.querySelector<HTMLElement>('.native-player-viewport')!;
  const holdPlacement = (event: Event) => {
    if (event instanceof CustomEvent && event.detail?.immediate) viewport.dataset.nativePlacement = 'pending';
  };
  window.addEventListener('surtitle-player-layout', holdPlacement);
  try {
    await openTranscript();
    const panel = document.querySelector<HTMLElement>('.study-companion')!;
    const search = screen.getByLabelText('Search transcript');
    expect(panel).toBeVisible();
    expect(panel).toHaveAttribute('inert');
    // Inert prevents actual focus; explicit disabled semantics also tell input
    // automation and accessibility clients that a visible field is not ready.
    expect(search.closest('[aria-disabled="true"]')).toBe(panel);
    await act(async () => { viewport.dataset.nativePlacement = 'ready'; });
    expect(panel).not.toHaveAttribute('inert');
    expect(panel).not.toHaveAttribute('aria-disabled');
    search.focus();
    fireEvent.change(search, { target: { value: 'coast' } });
    fireEvent.resize(window);
    expect(search).toHaveFocus();
    expect(search).toHaveValue('coast');
    expect(panel).not.toHaveAttribute('aria-disabled');
    fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
    await waitFor(() => expect(panel).toHaveAttribute('aria-disabled', 'true'));
    await openTranscript();
    await act(async () => { viewport.dataset.nativePlacement = 'ready'; });
    expect(screen.getByLabelText('Search transcript')).toBe(search);
    expect(search).toHaveValue('coast');
    expect(panel).not.toHaveAttribute('aria-disabled');
  } finally { window.removeEventListener('surtitle-player-layout', holdPlacement); }
});

it('distinguishes initial study loading, failure, and a genuinely missing material', async () => {
  fixture.snapshotAvailable = false;
  fixture.snapshotLoading = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const content = () => <QueryClientProvider client={client}><StudyPage /></QueryClientProvider>;
  const view = render(content());
  expect(screen.getByRole('status')).toHaveTextContent('Loading your material');
  expect(screen.queryByText('Choose something to study')).not.toBeInTheDocument();
  fixture.snapshotLoading = false;
  fixture.snapshotError = new Error('Store unavailable');
  view.rerender(content());
  expect(screen.getByRole('alert')).toHaveTextContent('Store unavailable');
  expect(screen.queryByText('Choose something to study')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(fixture.refresh).toHaveBeenCalled());
  fixture.snapshotAvailable = true;
  fixture.snapshotError = null;
  fixture.hasMedia = false;
  view.rerender(content());
  expect(screen.getByText('Choose something to study')).toBeInTheDocument();
  expect(screen.getByText('Open library')).toBeInTheDocument();
});

it('preserves an available study session during a background snapshot failure', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const content = () => <QueryClientProvider client={client}><StudyPage /></QueryClientProvider>;
  const view = render(content());
  await ready();
  const heading = screen.getByRole('heading', { name: 'Study fixture' });
  const loads = vi.mocked(playerApi.loadMedia).mock.calls.length;
  fixture.snapshotError = new Error('Refresh unavailable');
  view.rerender(content());
  expect(screen.getByRole('heading', { name: 'Study fixture' })).toBe(heading);
  expect(inspectButton()).toBeEnabled();
  expect(playerApi.loadMedia).toHaveBeenCalledTimes(loads);
  expect(screen.queryByText('Could not load your material.')).not.toBeInTheDocument();
});

describe('watching and inspecting phrases', () => {
  it('continues from a source block in the list and replays its range only from details', async () => {
    const block: SubtitleSegment = { ...cues[0], endMs: 4000, text: 'Text without word timing', status: 'generated_review', timingPrecision: 'source_block' };
    vi.mocked(studyApi.segments).mockResolvedValue([block]);
    mount();
    await openTranscript();
    const play = await screen.findByRole('button', { name: 'Play from source audio range 0:00' });
    await waitFor(() => expect(play).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Explore meaning' })).not.toBeInTheDocument();
    expect(screen.getByText(/Text received · subtitle timing unavailable/)).toBeVisible();
    fireEvent.click(play);
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'play' }));
    expect(playerApi.player).toHaveBeenCalledWith({ action: 'seek', value: 0 });
    expect(playerApi.playSourceRange).not.toHaveBeenCalled();
    expect(document.querySelector('.phrase-panel')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: block.text })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: block.text }));
    await screen.findByRole('button', { name: 'Resume from original position' });
    fireEvent.click(inspectReplay());
    await waitFor(() => expect(playerApi.playSourceRange).toHaveBeenCalledWith('media', ['a']));
    expect(screen.getByRole('button', { name: 'Explain this phrase' })).toBeEnabled();
    expect(phraseSaveToggle()).toBeEnabled();
  });

  it('trims a long source-block recording in the normal card form and keeps the exact chosen range', async () => {
    fixture.media.durationMs = 186000;
    state.durationMs = 186000;
    const block: SubtitleSegment = { ...cues[0], endMs: 186000, text: 'Long source text', status: 'generated', timingPrecision: 'source_block' };
    vi.mocked(studyApi.segments).mockResolvedValue([block]);
    mount();
    await openTranscript();
    const save = await screen.findByRole('button', { name: 'Review and save phrase' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await screen.findByLabelText('Audio from');
    expect(screen.getByLabelText('Audio to')).toHaveValue('3:00');
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'source' } });
    fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'origin' } });
    fireEvent.change(screen.getByLabelText('Audio to'), { target: { value: '3:06.000' } });
    expect(savePhrase()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Audio from'), { target: { value: '0:10.123' } });
    fireEvent.change(screen.getByLabelText('Audio to'), { target: { value: '0:40.456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play selected audio range' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'source-seek', startMs: 10123, endMs: 40456 }));
    await waitFor(() => expect(savePhrase()).toBeEnabled());
    fireEvent.click(savePhrase());
    await waitFor(() => expect(cardsApi.saveCard).toHaveBeenCalledWith(expect.objectContaining({ segmentId: 'a', sourceRange: { startMs: 10123, endMs: 40456 } })));
    expect(editorDraftApi.commitSubtitle).not.toHaveBeenCalled();
  });

  it('keeps the current phrase form usable when another generated range arrives', async () => {
    vi.mocked(studyApi.segments).mockResolvedValue([{ ...cues[0], status: 'generated' }]);
    const client = mount();
    await inspectCurrent();
    fireEvent.click(phraseSaveToggle());
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'would like' } });
    fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'want politely' } });
    await act(async () => client.setQueryData(queryKeys.segments('media'), [{ ...cues[0], status: 'generated' }, { ...cues[1], status: 'generated' }]));
    expect(screen.getByLabelText('Meaning')).toHaveValue('want politely');
    await waitFor(() => expect(savePhrase()).toBeEnabled());
    expect(screen.queryByText('The source subtitles or audio changed. Select the passage again.')).not.toBeInTheDocument();
  });

  it('waits for subtitle loading before restoring an AI request and its exact source context', async () => {
    const item: AiContinuation = { id: 'return', mediaId: 'media', kind: 'vocabulary', start: '0:00', end: '0:01', wholeMedia: false,
      focusTerm: 'would like', models: {}, sourceCueIds: ['a'], sourceRevision: JSON.stringify([cues[0]]),
      sourceMediaSignature: JSON.stringify([fixture.media.path, fixture.media.audioStreamIndex, fixture.media.learningLanguage, fixture.media.explanationLanguage]) };
    fixture.resumeId = item.id;
    vi.mocked(continuationApi.list).mockResolvedValue([item]);
    let finish!: (value: SubtitleSegment[]) => void;
    vi.mocked(studyApi.segments).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mount();
    await screen.findByText('You have an unfinished AI request.');
    expect(fixture.aiDialogProps).toBeUndefined();
    await act(async () => finish(cues));
    await waitFor(() => expect(fixture.aiDialogProps?.sourceContext?.sourceCueIds).toEqual(['a']));
    expect(fixture.aiDialogProps?.sourceInvalid).toBe(false);
    expect(document.querySelector('.phrase-panel .context-sentence')).toHaveTextContent(cues[0].text);
  });

  it.each(['missing', 'changed', 'legacy', 'file', 'audio', 'learningLanguage', 'explanationLanguage', 'legacy-media'])('keeps %s AI source input until explicit reselection, without binding by old timestamps', async source => {
    const item: AiContinuation = { id: 'return', mediaId: 'media', kind: 'vocabulary', start: '0:00', end: '0:01', wholeMedia: false,
      focusTerm: 'kept phrase', models: { explanation: {modelId:'custom-model',transcriptionMode:'subtitles',maxOutputTokens:1024} },
      quoteId:'old-quote',preparationId:'old-preparation', sourceCueIds: source === 'legacy' ? [] : [source === 'missing' ? 'removed' : 'a'],
      sourceRevision: source === 'changed' ? 'old content' : JSON.stringify([cues[0]]),
      sourceMediaSignature: source === 'legacy-media' ? undefined : JSON.stringify([fixture.media.path, fixture.media.audioStreamIndex, fixture.media.learningLanguage, fixture.media.explanationLanguage]) };
    if (source === 'file') fixture.media.path = 'C:/replacement.mkv';
    if (source === 'audio') fixture.media.audioStreamIndex = 2;
    if (source === 'learningLanguage') fixture.media.learningLanguage = 'fr';
    if (source === 'explanationLanguage') fixture.media.explanationLanguage = 'de';
    fixture.resumeId = item.id;
    vi.mocked(continuationApi.list).mockResolvedValue([item]);
    mount();
    const select = await screen.findByRole('button', { name: 'Select subtitles again' });
    expect(fixture.aiDialogProps?.sourceInvalid).toBe(true);
    expect(fixture.aiDialogProps?.sourceContext).toBeUndefined();
    fireEvent.click(select);
    await ready();
    fireEvent.click(await screen.findByRole('button', { name: cues[1].text }));
    await waitFor(() => expect(fixture.aiDialogProps?.sourceInvalid).toBe(false));
    expect(continuationApi.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id:item.id,focusTerm:item.focusTerm,models:item.models,sourceCueIds:['b'],sourceRevision:JSON.stringify([cues[1]]),
      start:'0:01',end:'0:02',quoteId:undefined,preparationId:undefined,
      sourceMediaSignature: JSON.stringify([fixture.media.path, fixture.media.audioStreamIndex, fixture.media.learningLanguage, fixture.media.explanationLanguage]),
    }));
    expect(fixture.aiDialogProps?.sourceContext?.sourceCueIds).toEqual(['b']);
    expect(aiApi.createQuote).not.toHaveBeenCalled();
  });
  it('starts with the current caption, hidden translation and closed transcript, without an AI request', async () => {
    vi.mocked(studyApi.segments).mockResolvedValue([{ ...cues[0], translation: 'お願いします。' }, ...cues.slice(1)]);
    mount();
    await ready();
    expect(document.querySelector('.current-caption-text')).toHaveTextContent(cues[0].text);
    expect(screen.getByLabelText('Search transcript')).not.toBeVisible();
    expect(screen.getByText('お願いします。').closest('.caption-translation-region')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('region', { name: 'Subtitle translation' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    expect(screen.getByText('お願いします。')).toBeVisible();
    await emit({ positionMs: 2600 });
    expect(document.querySelector('.current-caption-text')).toHaveTextContent(cues[2].text);
    expect(aiApi.createQuote).not.toHaveBeenCalled();
  });

  it('keeps the subtitle toggle outside the hidden panel and restores focus and transcript state on Escape', async () => {
    mount();
    await ready();
    const toggle = screen.getByRole('button', { name: 'Transcript' });
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(toggle).toHaveAttribute('type', 'button');
    expect(toggle).not.toHaveAttribute('role', 'tab');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(panel).not.toContainElement(toggle);
    expect(toggle.closest('[inert], [hidden], [aria-hidden="true"]')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Close panel' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('Search transcript'), { target: { value: 'like' } });
    screen.getByLabelText('Search transcript').focus();
    fireEvent.keyDown(screen.getByLabelText('Search transcript'), { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Search transcript')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Show translations' }));
    fireEvent.wheel(screen.getByLabelText('Subtitle list'));
    fireEvent.scroll(screen.getByLabelText('Subtitle list'), { target: { scrollTop: 120 } });
    const suggestions = screen.getByRole('tab', { name: 'Suggestions' });
    fireEvent.click(suggestions);
    suggestions.focus();
    fireEvent.keyDown(suggestions, { key: 'Escape' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    await waitFor(() => expect(toggle).toHaveFocus());
    expect(toggle.closest('[inert], [hidden], [aria-hidden="true"]')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('tab', { name: 'Suggestions' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    expect(screen.getByLabelText('Search transcript')).toHaveValue('like');
    expect(screen.getByRole('button', { name: 'Hide translations' })).toHaveAttribute('aria-pressed', 'true');
    expect(fixture.scrollOffset).toHaveBeenLastCalledWith(120, { behavior: 'auto' });
  });

  it('pauses and freezes the inspected source while playback moves to a different caption', async () => {
    state = { ...state, paused: false, positionMs: 300 };
    mount();
    await inspectCurrent();
    expect(playerApi.player).toHaveBeenCalledWith({ action: 'pause' });
    const original = document.querySelector('.phrase-panel .context-sentence');
    expect(original).toHaveTextContent(cues[0].text);
    await emit({ positionMs: 2600 });
    expect(original).toHaveTextContent(cues[0].text);
    expect(aiApi.createQuote).not.toHaveBeenCalled();
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
  });

  it('saves the selected text explicitly even after the DOM selection has cleared', async () => {
    mount();
    await ready();
    const caption = document.querySelector('.current-caption-text')!;
    const range = document.createRange();
    range.setStart(caption.firstChild!, 2);
    range.setEnd(caption.firstChild!, 12);
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(caption);
    await screen.findByRole('button', { name: 'Resume from original position' });
    window.getSelection()!.removeAllRanges();
    fireEvent.click(phraseSaveToggle());
    expect(screen.getByLabelText('Word or phrase')).toHaveValue('would like');
    fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'want politely' } });
    fireEvent.click(savePhrase());
    await waitFor(() => expect(cardsApi.saveCard).toHaveBeenCalledWith(expect.objectContaining({
      mediaId: 'media', segmentId: 'a', term: 'would like', meaning: 'want politely', example: cues[0].text,
    })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('preserves the source under a text-selection gesture while playback crosses a caption boundary', async () => {
    mount();
    await ready();
    const caption = document.querySelector('.current-caption-text')!;
    fireEvent.pointerDown(caption);
    await emit({ positionMs: 2600 });
    expect(caption).toHaveTextContent(cues[0].text);
    const range = document.createRange();
    range.setStart(caption.firstChild!, 2);
    range.setEnd(caption.firstChild!, 12);
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(caption);
    await screen.findByRole('button', { name: 'Resume from original position' });
    expect(document.querySelector('.phrase-panel .context-sentence')).toHaveTextContent(cues[0].text);
    expect(document.querySelector('.current-caption-text')).toHaveTextContent(cues[2].text);
      expect(document.querySelector('.current-caption-text')).toBe(caption);
    fireEvent.click(phraseSaveToggle());
    expect(screen.getByLabelText('Word or phrase')).toHaveValue('would like');
  });

  it('invalidates text selected from a caption that was edited during the selection gesture', async () => {
    const client = mount();
    await ready();
    const caption = document.querySelector('.current-caption-text')!;
    fireEvent.pointerDown(caption);
    await act(async () => client.setQueryData(['media', 'media', 'segments'], [{ ...cues[0], text: 'This source has changed.' }, ...cues.slice(1)]));
    expect(caption).toHaveTextContent(cues[0].text);
    const range = document.createRange();
    range.setStart(caption.firstChild!, 2);
    range.setEnd(caption.firstChild!, 12);
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(caption);
    await screen.findByRole('button', { name: 'Resume from original position' });
    expect(screen.getByText('The source subtitles changed. Select the subtitles or phrase again.')).toBeVisible();
    expect(phraseSaveToggle()).toBeDisabled();
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
  });

  it.each(['file', 'audio track'])('invalidates inspected source after the media %s changes', async source => {
    mount();
    await inspectCurrent();
    if (source === 'file') fixture.media.path = 'C:/replacement.mkv';
    else fixture.media.audioStreamIndex = 2;
    await emit({ positionMs: 2600 });
    await waitFor(() => expect(phraseSaveToggle()).toBeDisabled());
    expect(inspectReplay()).toBeDisabled();
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
  });

  it('keeps the inline form and user text after a failed save', async () => {
    vi.mocked(cardsApi.saveCard).mockRejectedValue(new Error('Could not save audio'));
    mount();
    await inspectCurrent();
    fireEvent.click(phraseSaveToggle());
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'would like' } });
    fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'want politely' } });
    fireEvent.click(savePhrase());
    await waitFor(() => expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining('Could not save audio'), 'error'));
    expect(screen.getByLabelText('Word or phrase')).toHaveValue('would like');
    expect(savePhrase()).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save audio');
    expect(playerApi.player).not.toHaveBeenCalledWith({ action: 'play' });
  });

  it('returns to the position where inspection began and clears the explicit range before playing', async () => {
    state = { ...state, positionMs: 400 };
    mount();
    await inspectCurrent();
    await emit({ positionMs: 2600 });
    vi.mocked(playerApi.player).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Resume from original position' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'play' }));
    const requests = vi.mocked(playerApi.player).mock.calls.map(([request]) => request).filter(request => ['pause', 'seek', 'play'].includes(request.action));
    expect(requests).toEqual([{ action: 'pause' }, { action: 'seek', value: 400 }, { action: 'play' }]);
  });

  it('does not resume or discard the inspected phrase when returning fails', async () => {
    mount();
    await inspectCurrent();
    vi.mocked(playerApi.player).mockImplementation(async request => { if (request.action === 'seek') throw new Error('Seek failed'); });
    fireEvent.click(screen.getByRole('button', { name: 'Resume from original position' }));
    await waitFor(() => expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining('Seek failed'), 'error'));
    expect(playerApi.player).not.toHaveBeenCalledWith({ action: 'play' });
    expect(screen.getByRole('button', { name: 'Resume from original position' })).toBeVisible();
  });

  it('does not offer saving a provisional subtitle', async () => {
    vi.mocked(studyApi.segments).mockResolvedValue([{ ...cues[0], status: 'provisional' }]);
    mount();
    await inspectCurrent();
    expect(phraseSaveToggle()).toBeDisabled();
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
  });

  it('shows the requested meaning in the same phrase panel when its matching result arrives', async () => {
    vi.mocked(studyApi.candidates).mockResolvedValue([]);
    const client = mount();
    await inspectCurrent();
    fireEvent.click(screen.getByRole('button', { name: 'Explain this phrase' }));
    const requested = { id: 'new-meaning', mediaId: 'media', segmentId: 'a', sourceCueIds: ['a'],
      term: cues[0].text, meaning: 'A polite way of saying what you want', example: cues[0].text,
      explanation: 'Use this to make a courteous request.', startMs: 0, endMs: 1000 };
    await act(async () => client.setQueryData(queryKeys.candidates('media'), [{ ...requested, sourceCueIds: ['a', 'b'], meaning: 'Different selected source' }]));
    expect(screen.queryByText('Different selected source')).not.toBeInTheDocument();
    await act(async () => client.setQueryData(queryKeys.candidates('media'), [requested]));
    expect(await screen.findByText(requested.meaning)).toBeVisible();
    expect(screen.getByText(requested.explanation)).toBeVisible();
    expect(document.querySelector('.phrase-panel .context-sentence')).toHaveTextContent(cues[0].text);
    expect(screen.getByRole('button', { name: 'Hide meaning' })).toBeVisible();
    fireEvent.click(phraseSaveToggle());
    expect(screen.getByLabelText('Meaning')).toHaveValue(requested.meaning);
    expect(screen.getByLabelText('Explanation or notes (optional)')).toHaveValue(requested.explanation);
  });

  it('closes the phrase panel without resuming playback and restores keyboard focus', async () => {
    mount();
    await ready();
    inspectButton().focus();
    await inspectCurrent();
    vi.mocked(playerApi.player).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume from original position' })).not.toBeInTheDocument());
    expect(playerApi.player).not.toHaveBeenCalledWith({ action: 'play' });
    expect(inspectButton()).toHaveFocus();
  });

  it('leaves empty subtitles actionable without fabricating a current phrase or requesting AI', async () => {
    vi.mocked(studyApi.segments).mockResolvedValue([]);
    mount();
    await screen.findByRole('button', { name: 'Create subtitles from audio' });
    expect(screen.queryByRole('button', { name: 'Explore meaning' })).not.toBeInTheDocument();
    await openTranscript();
    expect(within(document.querySelector('.study-transcript') as HTMLElement).getByRole('button', { name: 'Add or switch subtitles' })).toBeEnabled();
    expect(within(document.querySelector('.study-transcript') as HTMLElement).getByRole('button', { name: 'Create subtitles from audio' })).toBeEnabled();
    expect(aiApi.createQuote).not.toHaveBeenCalled();
  });

  it('keeps a valid empty transcription visible as a nonblocking audio passage to check', async () => {
    vi.mocked(studyApi.segments).mockResolvedValue([]);
    vi.mocked(studyApi.transcriptIssues).mockResolvedValue([{ id: 'silent', mediaId: 'media', sourceId: 'preparation', kind: 'no_speech', startMs: 0, endMs: 4000, alternatives: [] }]);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Activity & tools' }));
    await screen.findByText('Passages without subtitles to check (1)');
    fireEvent.click(screen.getByText('Passages without subtitles to check (1)'));
    await waitFor(() => expect(screen.getByRole('button', { name: '0:00–0:04' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Explore meaning' })).not.toBeInTheDocument();
    vi.mocked(playerApi.player).mockClear();
    fireEvent.click(screen.getByRole('button', { name: '0:00–0:04' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'play' }));
    expect(playerApi.player).toHaveBeenCalledWith({ action: 'seek', value: 0 });
    expect(aiApi.createQuote).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create subtitles from audio' })).toBeEnabled();
  });

  it('does not issue stale seek or play commands after leaving during a pending pause', async () => {
    let releasePause!: () => void;
    const paused = new Promise<void>(resolve => { releasePause = resolve; });
    vi.mocked(playerApi.player).mockImplementation(async request => {
      if (request.action === 'pause') await paused;
    });
    mount();
    await ready();
    fireEvent.click(inspectButton());
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'pause' }));
    cleanup();
    await act(async () => { releasePause(); await paused; });
    expect(playerApi.player).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'seek' }));
    expect(playerApi.player).not.toHaveBeenCalledWith({ action: 'play' });
  });
});

describe('study navigation and unfinished phrases', () => {
  it.each([true, false])('preserves paused=%s when moving to the next caption without inspecting it', async paused => {
    state = { ...state, paused, positionMs: 300 };
    mount();
    await ready();
    vi.mocked(playerApi.player).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Next subtitle' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'seek', value: 1000 }));
    expect(state.paused).toBe(paused);
    expect(playerApi.player).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'play' }));
    expect(playerApi.player).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'pause' }));
    expect(document.querySelector('.phrase-panel')).toBeNull();
    expect(aiApi.createQuote).not.toHaveBeenCalled();
  });

  it('finds adjacent captions in a gap and replays the previous caption displayed for review', async () => {
    mount();
    await ready();
    await emit({ positionMs: 2100 });
    const actions = within(screen.getByRole('group', { name: 'Subtitle playback' }));
    expect(actions.getByRole('button', { name: 'Replay this subtitle' })).toBeEnabled();
    expect(document.querySelector('.current-caption-text')).toHaveTextContent('to go home.');
    fireEvent.click(actions.getByRole('button', { name: 'Previous subtitle' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'seek', value: 1000 }));
    await waitFor(() => expect(actions.getByRole('button', { name: 'Next subtitle' })).toBeEnabled());
    fireEvent.click(actions.getByRole('button', { name: 'Next subtitle' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'seek', value: 2500 }));
    await emit({ positionMs: 3000 });
    expect(actions.getByRole('button', { name: 'Next subtitle' })).toBeDisabled();
    await emit({ positionMs: 2100 });
    fireEvent.click(actions.getByRole('button', { name: 'Replay this subtitle' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'source-seek', startMs: 1000, endMs: 2000 }));
  });

  it('switches the displayed gap caption and replay target through the saved playback preference', async () => {
    mount();
    await ready();
    await emit({ positionMs: 2100 });
    expect(document.querySelector('.current-caption-text')).toHaveTextContent('to go home.');
    openPlaybackSettings();
    const mode = screen.getByRole('combobox', { name: 'Between captions' });
    await waitFor(() => expect(mode).toBeEnabled());
    fireEvent.change(mode, { target: { value: 'preview' } });
    expect(document.querySelector('.current-caption-text')).toHaveTextContent('Next sentence.');
    await waitFor(() => expect(settingsApi.patch).toHaveBeenCalledExactlyOnceWith('0', { captionGapMode: 'preview' }));
    expect(fixture.settings.captionGapMode).toBe('preview');
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Playback settings' })).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Playback settings' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Play this subtitle' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'source-seek', startMs: 2500, endMs: 3200 }));
    expect(settingsApi.updateSettings).not.toHaveBeenCalled();
  });

  it('keeps a changed gap caption usable after save failure and retries its partial preference patch', async () => {
    mount();
    await ready();
    await emit({ positionMs: 2100 });
    vi.mocked(settingsApi.patch).mockRejectedValueOnce(Error('Disk full'));
    openPlaybackSettings();
    const mode = screen.getByRole('combobox', { name: 'Between captions' });
    await waitFor(() => expect(mode).toBeEnabled());
    fireEvent.change(mode, { target: { value: 'preview' } });
    const dialog = within(screen.getByRole('dialog', { name: 'Playback settings' }));
    await waitFor(() => expect(dialog.getByRole('alert')).toHaveTextContent('Disk full'));
    expect(mode).toHaveValue('preview');
    expect(mode).toBeEnabled();
    expect(document.querySelector('.current-caption-text')).toHaveTextContent('Next sentence.');
    expect(fixture.settings.captionGapMode).toBe('review');
    fireEvent.click(dialog.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fixture.settings.captionGapMode).toBe('preview'));
    expect(settingsApi.patch).toHaveBeenNthCalledWith(1, '0', { captionGapMode: 'preview' });
    expect(settingsApi.patch).toHaveBeenNthCalledWith(2, '0', { captionGapMode: 'preview' });
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refreshes the settings revision after sentence pause before saving a gap preference', async () => {
    mount();
    await ready();
    openPlaybackSettings();
    const mode = screen.getByRole('combobox', { name: 'Between captions' });
    await waitFor(() => expect(mode).toBeEnabled());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' }));
    expect(mode).toBeDisabled();
    await waitFor(() => expect(mode).toBeEnabled());
    expect(fixture.settings.sentencePause).toBe(true);
    fireEvent.change(mode, { target: { value: 'preview' } });
    await waitFor(() => expect(settingsApi.patch).toHaveBeenCalledExactlyOnceWith('1', { captionGapMode: 'preview' }));
    expect(fixture.settings.sentencePause).toBe(true);
    expect(fixture.settings.captionGapMode).toBe('preview');
    expect(within(screen.getByRole('dialog', { name: 'Playback settings' })).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries only the requested gap mode after a settings conflict without restoring unrelated recovered input', async () => {
    mount();
    await ready();
    await emit({ positionMs: 2100 });
    openPlaybackSettings();
    const mode = screen.getByRole('combobox', { name: 'Between captions' });
    await waitFor(() => expect(mode).toBeEnabled());
    const session = fixture.editingSessions.get('settings:default')!;
    act(() => session.change({ learningLanguage: 'fr' }));
    fixture.settings.theme = 'light';
    fixture.settingsRevision++;
    fireEvent.change(mode, { target: { value: 'preview' } });
    const dialog = within(screen.getByRole('dialog', { name: 'Playback settings' }));
    await waitFor(() => expect(dialog.getByRole('alert')).toHaveTextContent('Settings changed'));
    expect(session.getSnapshot().recovery).toMatchObject({ learningLanguage: 'fr', captionGapMode: 'preview' });
    expect(mode).toHaveValue('review');
    fireEvent.click(dialog.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fixture.settings.captionGapMode).toBe('preview'));
    expect(settingsApi.patch).toHaveBeenNthCalledWith(2, '1', { captionGapMode: 'preview' });
    expect(fixture.settings.theme).toBe('light');
    expect(fixture.settings.learningLanguage).toBe('en');
    expect(session.getSnapshot().recovery?.learningLanguage).toBe('fr');
    expect(document.querySelector('.current-caption-text')).toHaveTextContent('Next sentence.');
  });

  it('keeps the last gap mode when changed again while its first save is in flight', async () => {
    mount();
    await ready();
    await emit({ positionMs: 2100 });
    openPlaybackSettings();
    const mode = screen.getByRole('combobox', { name: 'Between captions' });
    await waitFor(() => expect(mode).toBeEnabled());
    const patch = vi.mocked(settingsApi.patch).getMockImplementation()!;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(settingsApi.patch).mockImplementationOnce(async (revision, fields) => { await pending; return patch(revision, fields); });
    fireEvent.change(mode, { target: { value: 'preview' } });
    await waitFor(() => expect(settingsApi.patch).toHaveBeenCalledTimes(1));
    fireEvent.change(mode, { target: { value: 'review' } });
    expect(document.querySelector('.current-caption-text')).toHaveTextContent('to go home.');
    await act(async () => { release(); await pending; });
    await waitFor(() => expect(settingsApi.patch).toHaveBeenNthCalledWith(2, '1', { captionGapMode: 'review' }));
    expect(fixture.settings.captionGapMode).toBe('review');
    expect(mode).toHaveValue('review');
  });

  it('direct caption replay retains the inspected source and unsaved form', async () => {
    mount();
    await inspectCurrent();
    fireEvent.click(phraseSaveToggle());
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'my phrase' } });
    await emit({ positionMs: 2600 });
    fireEvent.click(within(screen.getByRole('group', { name: 'Subtitle playback' })).getByRole('button', { name: 'Replay this subtitle' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'source-seek', startMs: 2500, endMs: 3200 }));
    expect(screen.getByLabelText('Word or phrase')).toHaveValue('my phrase');
    expect(document.querySelector('.context-sentence')).toHaveTextContent(cues[0].text);
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
    expect(aiApi.createQuote).not.toHaveBeenCalled();
  });

  it.each(['Back to transcript', 'Resume from original position'])('restores searched transcript settings and offset with %s after replaying a result', async returnAction => {
    mount();
    await ready();
    await openTranscript();
    fireEvent.change(screen.getByLabelText('Search transcript'), { target: { value: 'like' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show translations' }));
    const list = screen.getByLabelText('Subtitle list');
    fireEvent.wheel(list);
    fireEvent.scroll(list, { target: { scrollTop: 120 } });
    fireEvent.click(screen.getByRole('button', { name: cues[0].text }));
    await screen.findByRole('button', { name: 'Back to transcript' });
    fireEvent.click(inspectReplay());
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'source-seek', startMs: cues[0].startMs, endMs: cues[0].endMs }));
    await waitFor(() => expect(screen.getByRole('button', { name: returnAction })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: returnAction }));
    await waitFor(() => expect(screen.getByLabelText('Search transcript')).toBeVisible());
    expect(screen.getByLabelText('Search transcript')).toHaveValue('like');
    expect(screen.getByRole('button', { name: 'Hide translations' })).toHaveAttribute('aria-pressed', 'true');
    expect(fixture.scrollOffset).toHaveBeenLastCalledWith(120, { behavior: 'auto' });
    expect(screen.getByRole('button', { name: 'Show current subtitle' })).toBeVisible();
    if (returnAction === 'Resume from original position') expect(playerApi.player).toHaveBeenCalledWith({ action: 'play' });
  });

  it('retains separate source drafts after Escape and clears only the saved draft', async () => {
    mount();
    await inspectCurrent();
    fireEvent.click(phraseSaveToggle());
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'first phrase' } });
    fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'first meaning' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Word or phrase')).not.toBeInTheDocument());
    await emit({ positionMs: 2600 });
    await inspectCurrent();
    fireEvent.click(phraseSaveToggle());
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'second phrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unfinished phrases (2)' }));
    fireEvent.click(screen.getByRole('button', { name: /first phrase 0:00/ }));
    await waitFor(() => expect(screen.getByLabelText('Word or phrase')).toHaveValue('first phrase'));
    expect(screen.getByLabelText('Meaning')).toHaveValue('first meaning');
    vi.mocked(cardsApi.saveCard).mockResolvedValue(undefined);
    await waitFor(() => expect(savePhrase()).toBeEnabled());
    fireEvent.click(savePhrase());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unfinished phrases (1)' })).toBeVisible());
    expect(cardsApi.saveCard).toHaveBeenCalledWith(expect.objectContaining({ segmentId: 'a', term: 'first phrase' }));
  });

  it('resumes persisted phrase values after a fresh page session and consumes the restored draft on save', async () => {
    let persisted: EditorDraft[] = [];
    vi.mocked(editorDraftApi.list).mockImplementation(async () => structuredClone(persisted));
    vi.mocked(editorDraftApi.save).mockImplementation(async request => {
      const saved: EditorDraft = { ...request, version: request.expectedVersion + 1, stale: false,
        bindingVerified: true, sourceMediaSignature: 'local-signature', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
      persisted = [...persisted.filter(item => item.id !== saved.id), structuredClone(saved)];
      return saved;
    });
    vi.mocked(editorDraftApi.savePhrase).mockImplementation(async (reference, request) => {
      expect(persisted.find(item => item.id === reference.id)?.version).toBe(reference.version);
      await cardsApi.saveCard(request);
      persisted = persisted.filter(item => item.id !== reference.id);
    });
    mount();
    await inspectCurrent();
    fireEvent.click(phraseSaveToggle());
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'restart phrase' } });
    fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'meaning before restart' } });
    fireEvent.change(screen.getByLabelText('Original context'), { target: { value: 'my retained context' } });
    fireEvent.change(screen.getByLabelText('Explanation or notes (optional)'), { target: { value: 'unfinished\nnotes' } });
    await act(flushEditorDrafts);
    expect(persisted).toHaveLength(1);
    const storedId = persisted[0].id;
    cleanup();
    await flushEditorDrafts();
    clearEditorDraftSessions();
    clients.splice(0).forEach(client => client.clear());
    vi.mocked(editorDraftApi.save).mockClear();
    mount();
    await ready();
    fireEvent.click(await screen.findByRole('button', { name: 'Unfinished phrases (1)' }));
    fireEvent.click(screen.getByRole('button', { name: /restart phrase 0:00/ }));
    await waitFor(() => expect(screen.getByLabelText('Word or phrase')).toHaveValue('restart phrase'));
    expect(screen.getByLabelText('Meaning')).toHaveValue('meaning before restart');
    expect(screen.getByLabelText('Original context')).toHaveValue('my retained context');
    expect(screen.getByLabelText('Explanation or notes (optional)')).toHaveValue('unfinished\nnotes');
    await waitFor(() => expect(savePhrase()).toBeEnabled());
    expect(editorDraftApi.save).not.toHaveBeenCalled();
    fireEvent.click(savePhrase());
    await waitFor(() => expect(cardsApi.saveCard).toHaveBeenCalledWith(expect.objectContaining({
      term: 'restart phrase', meaning: 'meaning before restart', example: 'my retained context', explanation: 'unfinished\nnotes',
    })));
    expect(editorDraftApi.savePhrase).toHaveBeenCalledWith(expect.objectContaining({ id: storedId }), expect.anything(), expect.stringMatching(/^local:/));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Unfinished phrases (1)' })).not.toBeInTheDocument());
    expect(persisted).toEqual([]);
  });

  it('allows a marked generated subtitle to save a phrase and still opens normal subtitle correction with alternatives', async () => {
    const generated: SubtitleSegment = { ...cues[0], status: 'generated_review', reviewIssues: [{
      id: 'warning', kind: 'boundary_conflict', startMs: 0, endMs: 1000,
      alternatives: [{ startMs: 0, endMs: 1000, text: 'I would live' }],
    }] };
    vi.mocked(studyApi.segments).mockResolvedValue([generated, ...cues.slice(1)]);
    mount();
    await inspectCurrent();
    expect(phraseSaveToggle()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Edit subtitle' })).toBeEnabled();
    fireEvent.click(phraseSaveToggle());
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'would like' } });
    fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'want politely' } });
    await waitFor(() => expect(savePhrase()).toBeEnabled());
    fireEvent.click(savePhrase());
    await waitFor(() => expect(cardsApi.saveCard).toHaveBeenCalledWith(expect.objectContaining({ segmentId: 'a', term: 'would like' })));
    expect(editorDraftApi.commitSubtitle).not.toHaveBeenCalled();
    expect(editorDraftApi.save).toHaveBeenCalledWith(expect.objectContaining({ sourceCues: [generated] }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit subtitle' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Edit subtitle' }));
    const editor = await screen.findByRole('dialog', { name: 'Edit subtitle' });
    fireEvent.click(within(editor).getByText('Automatic subtitle notes and alternatives'));
    expect(within(editor).getByText('I would live')).toBeVisible();
    fireEvent.click(within(editor).getByRole('button', { name: 'Use this alternative' }));
    expect(within(editor).getByLabelText('Subtitle')).toHaveValue('I would live');
    fireEvent.change(within(editor).getByLabelText('Subtitle'), { target: { value: 'I would really like' } });
    await waitFor(() => expect(within(editor).getByRole('button', { name: 'Confirm and save' })).toBeEnabled());
    fireEvent.click(within(editor).getByRole('button', { name: 'Confirm and save' }));
    await waitFor(() => expect(editorDraftApi.commitSubtitle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      id: 'a', text: 'I would really like', status: 'confirmed', reviewIssues: [], startMs: 0, endMs: 1000,
    })));
  });

  it('retains edited text but blocks saving after the source changes', async () => {
    const client = mount();
    await inspectCurrent();
    fireEvent.click(phraseSaveToggle());
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'do not lose me' } });
    fireEvent.change(screen.getByLabelText('Meaning'), { target: { value: 'a meaning' } });
    await act(async () => client.setQueryData(['media', 'media', 'segments'], [{ ...cues[0], text: 'Changed' }, ...cues.slice(1)]));
    expect(screen.getByLabelText('Word or phrase')).toHaveValue('do not lose me');
    await waitFor(() => expect(savePhrase()).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Continue later' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unfinished phrases (1)' }));
    fireEvent.click(screen.getByRole('button', { name: /do not lose me 0:00/ }));
    await waitFor(() => expect(savePhrase()).toBeDisabled());
    expect(screen.getByLabelText('Meaning')).toHaveValue('a meaning');
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Unfinished phrases (1)' })).not.toBeInTheDocument());
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
  });

  it.each(['button', 'Escape'])('can close an unfinished form with %s after player failure without losing its input', async close => {
    mount();
    await inspectCurrent();
    fireEvent.click(phraseSaveToggle());
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'keep after failure' } });
    await emit({ ready: false, error: 'Player failed' });
    vi.mocked(playerApi.player).mockClear();
    if (close === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    else fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    await waitFor(() => expect(screen.queryByLabelText('Word or phrase')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Unfinished phrases (1)' })).toBeVisible();
    expect(playerApi.player).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'seek' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unfinished phrases (1)' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Unfinished phrases (1)' }));
    fireEvent.click(screen.getByRole('button', { name: /keep after failure 0:00/ }));
    await waitFor(() => expect(screen.getByLabelText('Word or phrase')).toHaveValue('keep after failure'));
  });

  it('keeps notes and the exit confirmation accessible if the material disappears', async () => {
    mount();
    await inspectCurrent();
    fireEvent.click(phraseSaveToggle());
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'orphan notes' } });
    fixture.hasMedia = false;
    fixture.blockerStatus = 'blocked';
    await emit({ positionMs: 250 });
    expect((await screen.findByLabelText('Unfinished notes') as HTMLTextAreaElement).value).toContain('orphan notes');
    expect(screen.getByRole('dialog', { name: 'You have unfinished phrases' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(fixture.resetBlocker).toHaveBeenCalledOnce();
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
  });
});

describe('study playback keyboard shortcuts', () => {
  it('leaves Space on a focused summary available for opening its details', async () => {
    mount();
    await ready();
    render(<details><summary>Task details</summary></details>);
    const summary = screen.getByText('Task details');
    summary.focus();
    vi.mocked(playerApi.player).mockClear();

    const event = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    fireEvent(summary, event);

    expect(summary).toHaveFocus();
    expect(event.defaultPrevented).toBe(false);
    expect(playerApi.player).not.toHaveBeenCalled();
  });

  it('ignores a handled key event while retaining unhandled playback shortcuts', async () => {
    mount();
    await ready();
    vi.mocked(playerApi.player).mockClear();

    const handled = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      code: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    fireEvent(document.body, handled);
    expect(playerApi.player).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    expect(playerApi.player).toHaveBeenCalledExactlyOnceWith({ action: 'play' });
  });
});

describe('study sentence and source playback', () => {
  it.each(['subtitle timing', 'audio track'] as const)(
    'does not resume a stale source after %s changes during a pending position read',
    async (changedSource) => {
      const client = mount();
      await ready();
      await openTranscript();
      let releasePosition!: (value: PlayerState) => void;
      const position = new Promise<PlayerState>(resolve => {
        releasePosition = resolve;
      });
      vi.mocked(playerApi.playerState).mockReturnValueOnce(position);
      vi.mocked(playerApi.player).mockClear();

      fireEvent.click(screen.getByRole('button', { name: 'Play from subtitle 0:00' }));
      if (changedSource === 'subtitle timing') {
        await act(async () => client.setQueryData(
          ['media', 'media', 'segments'],
          [{ ...cues[0], startMs: 100, endMs: 900 }, ...cues.slice(1)],
        ));
        await within(screen.getByRole('region', { name: 'Current subtitle' }))
          .findByText('The first subtitle starts at 0:00');
      } else {
        fixture.media.audioStreamIndex = 2;
        await emit({ positionMs: 100 });
      }
      await act(async () => {
        releasePosition(state);
        await position;
      });

      expect(fixture.notify).toHaveBeenCalledWith(
        expect.stringContaining('The source subtitles or audio changed. Select the passage again.'),
        'error',
      );
      expect(playerApi.player).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'source-seek' }),
      );
      expect(playerApi.player).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'seek' }));
      expect(playerApi.player).not.toHaveBeenCalledWith({ action: 'play' });
      expect(playerApi.playSourceRange).not.toHaveBeenCalled();
      expect(document.querySelector('.phrase-panel')).toBeNull();
    },
  );

  it('waits for native readiness and changes only the saved sentence-pause preference', async () => {
    state.ready = false;
    mount();
    await waitFor(() => expect(playerApi.playerState).toHaveBeenCalled());
    expect(inspectButton()).toBeDisabled();
    await openTranscript();
    fireEvent.click(screen.getByRole('tab', { name: 'Suggestions' }));
    expect(await screen.findByRole('button', { name: 'Listen to source' })).toBeDisabled();
    openPlaybackSettings();
    const checkbox = screen.getByRole('checkbox', { name: 'Pause at the end of a caption group' });
    expect(checkbox).toBeDisabled();
    await emit({ ready: true });
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(playerApi.player).toHaveBeenCalledWith({ action: 'sentence-pause', value: 1 });
    expect(settingsApi.updateSettings).not.toHaveBeenCalled();
    expect(aiApi.createQuote).not.toHaveBeenCalled();
    expect(playerApi.playSourceRange).not.toHaveBeenCalled();
    expect(screen.getByText(/Selected ranges and repeat take priority/)).toBeVisible();
  });

  it('plays a whole source group by IDs and repeats its complete cue range without saving or sending', async () => {
    mount();
    await ready();
    await openTranscript();
    fireEvent.click(screen.getByRole('tab', { name: 'Suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Listen to source' }));
    await waitFor(() => expect(playerApi.playSourceRange).toHaveBeenCalledExactlyOnceWith('media', ['a', 'b']));
    const repeat = await screen.findByRole('button', { name: 'Repeat selected segment' });
    await waitFor(() => expect(repeat).toBeEnabled());
    fireEvent.click(repeat);
    expect(playerApi.player).toHaveBeenCalledWith({ action: 'source-loop', startMs: 0, endMs: 2000 });
    expect(document.querySelector('.phrase-panel .context-sentence')?.textContent).toBe('I would like\nto go home.');
    fireEvent.click(inspectReplay());
    await waitFor(() => expect(playerApi.playSourceRange).toHaveBeenCalledTimes(2));
    expect(cardsApi.saveCard).not.toHaveBeenCalled();
    expect(aiApi.createQuote).not.toHaveBeenCalled();
  });

  it('keeps a repeat requested as soon as the selected source becomes available', async () => {
    let finishLoop!: () => void;
    const loopResponse = new Promise<void>(resolve => { finishLoop = resolve; });
    const control = vi.mocked(playerApi.player).getMockImplementation()!;
    vi.mocked(playerApi.player).mockImplementation(request =>
      request.action === 'source-loop' ? loopResponse : control(request));
    mount();
    await ready();
    await openTranscript();
    fireEvent.click(screen.getByRole('tab', { name: 'Suggestions' }));
    const source = await screen.findByRole('button', { name: 'Listen to source' });
    let clicked = false;
    const observer = new MutationObserver(() => {
      const repeat = document.querySelector<HTMLButtonElement>('[aria-label="Repeat selected segment"]');
      if (repeat && !repeat.disabled && !clicked) { clicked = true; fireEvent.click(repeat); }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
    try {
      fireEvent.click(source);
      await waitFor(() => expect(clicked).toBe(true));
      expect(playerApi.player).toHaveBeenCalledWith({ action: 'source-loop', startMs: 0, endMs: 2000 });
      const repeat = screen.getByRole('button', { name: 'Repeat selected segment' });
      // Observing the click does not mean the native command or React update has settled.
      expect(repeat).toBeDisabled();
      expect(repeat).toHaveAttribute('aria-pressed', 'false');
      await act(async () => { finishLoop(); });
      await waitFor(() => expect(repeat).toHaveAttribute('aria-pressed', 'true'));
      expect(playerApi.player).not.toHaveBeenCalledWith({ action: 'loop' });
      fireEvent.click(repeat);
      await waitFor(() => expect(repeat).toHaveAttribute('aria-pressed', 'false'));
      expect(playerApi.player).toHaveBeenCalledWith({ action: 'loop' });
    } finally { observer.disconnect(); }
  });

  it.each([true, false])('resumes from a list timestamp with paused=%s and restores automatic follow', async paused => {
    state = { ...state, paused };
    mount();
    await ready();
    await openTranscript();
    fireEvent.change(screen.getByLabelText('Search transcript'), { target: { value: 'home' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show translations' }));
    fireEvent.wheel(screen.getByLabelText('Subtitle list'));
    vi.mocked(playerApi.player).mockClear();
    fixture.scroll.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Play from subtitle 0:01' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'play' }));
    expect(vi.mocked(playerApi.player).mock.calls.map(([request]) => request)).toEqual([
      { action: 'seek', value: 1000 }, { action: 'play' },
    ]);
    expect(state.paused).toBe(false);
    expect(screen.getByLabelText('Search transcript')).toBeVisible();
    expect(screen.getByLabelText('Search transcript')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Hide translations' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Following playback' })).toBeVisible();
    // Native position events can arrive after the command completes. Resuming
    // follow must target the clicked cue even before that notification arrives.
    expect(fixture.scroll.mock.calls.length).toBeGreaterThan(0);
    expect(fixture.scroll.mock.calls.every(([index]) => index === 1)).toBe(true);
    expect(document.querySelector('.current-caption-text')).toHaveTextContent(cues[1].text);
    await emit({ positionMs: 1000 });
    expect(fixture.scroll.mock.calls.every(([index]) => index === 1)).toBe(true);
    const followed = fixture.scroll.mock.calls.length;
    await emit({ positionMs: 2600 });
    expect(fixture.scroll.mock.calls.length).toBeGreaterThan(followed);
    expect(document.querySelector('.phrase-panel')).toBeNull();
    expect(playerApi.playSourceRange).not.toHaveBeenCalled();
    expect(aiApi.createQuote).not.toHaveBeenCalled();
  });

  it('does not start playback if the list seek fails', async () => {
    mount();
    await ready();
    await openTranscript();
    fireEvent.change(screen.getByLabelText('Search transcript'), { target: { value: 'home' } });
    fireEvent.wheel(screen.getByLabelText('Subtitle list'));
    vi.mocked(playerApi.player).mockClear();
    vi.mocked(playerApi.player).mockRejectedValueOnce(new Error('Seek failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Play from subtitle 0:01' }));
    await waitFor(() => expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining('Seek failed'), 'error'));
    expect(playerApi.player).not.toHaveBeenCalledWith({ action: 'play' });
    expect(screen.getByLabelText('Search transcript')).toBeVisible();
    expect(screen.getByLabelText('Search transcript')).toHaveValue('home');
    expect(screen.getByRole('button', { name: 'Show current subtitle' })).toBeVisible();
    expect(document.querySelector('.phrase-panel')).toBeNull();
  });

  it('clears the previous inspection when resuming from the list without discarding its draft', async () => {
    mount();
    await inspectCurrent();
    fireEvent.click(phraseSaveToggle());
    fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'unfinished wording' } });
    fireEvent.click(screen.getByRole('button', { name: 'Repeat selected segment' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Repeat selected segment' })).toHaveAttribute('aria-pressed', 'true'));
    vi.mocked(playerApi.player).mockClear();
    await openTranscript();
    expect(screen.getByRole('tab', { name: 'Transcript' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Close panel' })).toBeVisible();
    expect(playerApi.player).toHaveBeenCalledWith({ action: 'pause' });
    expect(playerApi.player).toHaveBeenCalledWith(expect.objectContaining({ action: 'seek' }));
    expect(playerApi.player).not.toHaveBeenCalledWith({ action: 'play' });
    expect(editorDraftApi.save).toHaveBeenCalledWith(expect.objectContaining({ fields: expect.objectContaining({ term: 'unfinished wording' }) }));
    vi.mocked(playerApi.player).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Play from subtitle 0:01' }));
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'play' }));
    expect(vi.mocked(playerApi.player).mock.calls.map(([request]) => request)).toEqual([
      { action: 'seek', value: 1000 }, { action: 'play' },
    ]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Transcript' })).toBeEnabled());
    vi.mocked(playerApi.player).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Transcript' })).toHaveAttribute('aria-expanded', 'false'));
    expect(playerApi.player).not.toHaveBeenCalled();
    expect(state.paused).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Unfinished phrases (1)' }));
    fireEvent.click(screen.getByRole('button', { name: /unfinished wording 0:00/ }));
    await waitFor(() => expect(screen.getByLabelText('Word or phrase')).toHaveValue('unfinished wording'));
    expect(screen.getByRole('button', { name: 'Repeat selected segment' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps timestamp continuation explicit and suspends transcript follow for keyboard scrolling', async () => {
    mount();
    await ready();
    await openTranscript();
    const play = await screen.findByRole('button', { name: 'Play from subtitle 0:00' });
    fireEvent.click(play);
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'play' }));
    expect(playerApi.player).toHaveBeenCalledWith({ action: 'seek', value: 0 });
    expect(playerApi.playSourceRange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('Subtitle list'), { key: 'ArrowDown' });
    const previous = fixture.scroll.mock.calls.length;
    await emit({ positionMs: 2600 });
    expect(fixture.scroll).toHaveBeenCalledTimes(previous);
    fireEvent.click(screen.getByRole('button', { name: 'Show current subtitle' }));
    await waitFor(() => expect(fixture.scroll.mock.calls.length).toBeGreaterThan(previous));
  });

  it('inspects transcript text without initiating range playback', async () => {
    mount();
    await ready();
    await openTranscript();
    fireEvent.click(screen.getByRole('button', { name: cues[1].text }));
    await screen.findByRole('button', { name: 'Resume from original position' });
    expect(playerApi.player).toHaveBeenCalledWith({ action: 'pause' });
    expect(playerApi.player).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'source-seek' }));
    expect(playerApi.playSourceRange).not.toHaveBeenCalled();
    expect(document.querySelector('.phrase-panel .context-sentence')).toHaveTextContent(cues[1].text);
  });

  it('does not open a new context or start a loop after source validation fails', async () => {
    vi.mocked(playerApi.playSourceRange).mockRejectedValue(new Error('Source subtitles are no longer adjacent'));
    mount();
    await ready();
    await openTranscript();
    fireEvent.click(screen.getByRole('tab', { name: 'Suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Listen to source' }));
    await waitFor(() => expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining('no longer adjacent'), 'error'));
    expect(document.querySelector('.phrase-panel')).toBeNull();
    expect(playerApi.player).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'source-loop' }));
  });

  it.each([
    ['removed cue', [cues[0], cues[2]]],
    ['reordered cues', [{ ...cues[1], startMs: 0, endMs: 500 }, { ...cues[0], startMs: 600, endMs: 900 }, cues[2]]],
    ['inserted cue', [cues[0], { ...cues[0], id: 'inserted', startMs: 500, endMs: 750 }, cues[1], cues[2]]],
    ['changed timing', [cues[0], { ...cues[1], endMs: 2200 }, cues[2]]],
    ['changed text', [{ ...cues[0], text: 'A revised source.' }, ...cues.slice(1)]],
  ])('invalidates the frozen source and clears a native loop after %s', async (_name, changedCues) => {
    const client = mount();
    await ready();
    await openTranscript();
    fireEvent.click(screen.getByRole('tab', { name: 'Suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Listen to source' }));
    const repeat = await screen.findByRole('button', { name: 'Repeat selected segment' });
    await waitFor(() => expect(repeat).toBeEnabled());
    fireEvent.click(repeat);
    await waitFor(() => expect(repeat).toHaveAttribute('aria-pressed', 'true'));
    vi.mocked(playerApi.player).mockClear();
    vi.mocked(playerApi.playSourceRange).mockClear();
    await act(async () => client.setQueryData(['media', 'media', 'segments'], changedCues));
    await waitFor(() => expect(inspectReplay()).toBeDisabled());
    expect(phraseSaveToggle()).toBeDisabled();
    expect(screen.getByText('The source subtitles changed. Select the subtitles or phrase again.')).toBeVisible();
    await waitFor(() => expect(playerApi.player).toHaveBeenCalledWith({ action: 'loop' }));
    expect(playerApi.playSourceRange).not.toHaveBeenCalled();
    await act(async () => client.setQueryData(['media', 'media', 'segments'], cues));
    expect(inspectReplay()).toBeDisabled();
    await openTranscript();
    fireEvent.click(screen.getByRole('tab', { name: 'Suggestions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Listen to source' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Repeat selected segment' })).toBeEnabled());
    expect(playerApi.playSourceRange).toHaveBeenCalledExactlyOnceWith('media', ['a', 'b']);
  });
});
