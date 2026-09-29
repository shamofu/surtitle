// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  DownloadJobs,
  RemoveMediaDialog,
  SubtitleSourceDialog,
} from '../features/library/MediaManagement';
import {
  DeleteCardDialog,
  EditCardDialog,
} from '../features/cards/CardManagement';
import { CardsPage } from '../features/cards/CardsPage';
import { libraryApi } from '../features/library/api';
import { cardsApi } from '../features/cards/api';
import type { Media } from '../shared/contracts/media';
import type { StudyCard } from '../shared/contracts/cards';

const context = vi.hoisted(() => ({
  data: undefined as { media: Media[]; cards: StudyCard[] } | undefined,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) =>
    <a href={to} className={className}>{children}</a>,
}));

vi.mock('../features/library/api', () => ({
  libraryApi: {
    mediaStreams: vi.fn(),
    subtitleVersions: vi.fn(),
    extractEmbeddedSubtitles: vi.fn(),
    importSubtitles: vi.fn(),
    restoreSubtitleVersion: vi.fn(),
    downloadJobs: vi.fn(),
    cancelDownload: vi.fn(),
    startUrlImport: vi.fn(),
    removeMedia: vi.fn(),
  },
}));

vi.mock('../features/cards/api', () => ({
  cardsApi: { editCard: vi.fn(), deleteCard: vi.fn() },
}));

vi.mock('../shared/native/transport', () => ({ nativeAvailable: () => true }));
const registerModal = () => () => {};
vi.mock('../app/runtime', () => {
  const useFixture = () => ({
    data: context.data,
    mutate: (action: () => Promise<unknown>) => action(),
    t: (_ja: string, en: string) => en,
    registerModal,
    report: async (action: () => Promise<unknown>) => action(),
  });
  return {
    useSnapshot: useFixture,
    useDataActions: useFixture,
    useAppearance: useFixture,
    useNotifications: useFixture,
    useSurface: useFixture,
  };
});
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
const clients: QueryClient[] = [];
function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.resetAllMocks();
  context.data = undefined;
});
const media: Media = {
  id: 'media',
  title: 'Original media',
  path: 'C:/media.mkv',
  kind: 'video',
  durationMs: 10000,
  learningLanguage: 'en',
  explanationLanguage: 'ja',
  createdAt: '2026-01-01T00:00:00Z',
  lastPositionMs: 0,
  segmentCount: 1,
  cardCount: 1,
  status: 'ready',
};
const card: StudyCard = {
  id: 'card',
  mediaId: media.id,
  segmentId: 'cue',
  term: 'Original',
  meaning: 'Meaning',
  example: 'Original example',
  language: 'en',
  dueAt: '2030-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  reviewCount: 7,
  audioPath: 'C:/saved.wav',
  audioStreamIndex: 4,
  suspended: false,
};

describe('media and card management', () => {
  it('returns focus to the phrase menu after Escape and cancelling a delete dialog', async () => {
    context.data = { media: [media], cards: [card] };
    mount(<CardsPage />);
    const summary = screen.getByLabelText('Actions for Original');
    const menu = summary.closest('details');
    summary.focus();
    fireEvent.click(summary);
    expect(menu).toHaveAttribute('open');
    const edit = screen.getByRole('button', { name: 'Edit' });
    edit.focus();
    fireEvent.keyDown(edit, { key: 'Escape' });
    expect(menu).not.toHaveAttribute('open');
    expect(summary).toHaveFocus();

    fireEvent.click(summary);
    const remove = screen.getByRole('button', { name: 'Delete' });
    remove.focus();
    fireEvent.click(remove);
    expect(menu).not.toHaveAttribute('open');
    expect(screen.getByRole('dialog', { name: 'Delete phrase' })).toBeVisible();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.click(cancel);
    await waitFor(() => expect(summary).toHaveFocus());
    expect(cardsApi.deleteCard).not.toHaveBeenCalled();
  });

  it('requires a chosen text stream and explicit preservation before replacing edited subtitles', async () => {
    vi.mocked(libraryApi.mediaStreams).mockResolvedValue([
      {
        index: 4,
        kind: 'subtitle',
        codec: 'ass',
        language: 'jpn',
        title: 'Japanese',
        isDefault: false,
        supportedText: true,
      },
      {
        index: 5,
        kind: 'subtitle',
        codec: 'hdmv_pgs_subtitle',
        isDefault: false,
        supportedText: false,
      },
    ]);
    const close = vi.fn();
    mount(
      <SubtitleSourceDialog
        media={media}
        initialMode="embedded"
        onClose={close}
      />,
    );
    await screen.findByRole('option', { name: /Japanese/ });
    expect(
      screen.getByRole('button', { name: 'Use these subtitles' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Subtitle to extract'), {
      target: { value: '4' },
    });
    expect(libraryApi.extractEmbeddedSubtitles).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Use these subtitles' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Use these subtitles' }),
    );
    await waitFor(() =>
      expect(
        libraryApi.extractEmbeddedSubtitles,
      ).toHaveBeenCalledExactlyOnceWith('media', 4, true),
    );
    expect(close).toHaveBeenCalledOnce();
  });
  it('does not open the external subtitle picker before replacement acknowledgement', () => {
    mount(
      <SubtitleSourceDialog
        media={media}
        initialMode="file"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Choose file' })).toBeDisabled();
    expect(libraryApi.importSubtitles).not.toHaveBeenCalled();
  });
  it('sends only editable card content and keeps source audio and scheduling out of the mutation', async () => {
    mount(<EditCardDialog card={card} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Meaning'), {
      target: { value: 'Corrected meaning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(cardsApi.editCard).toHaveBeenCalledOnce());
    expect(vi.mocked(cardsApi.editCard).mock.calls[0][0]).toEqual({
      id: 'card',
      term: 'Original',
      meaning: 'Corrected meaning',
      example: 'Original example',
      translation: undefined,
      explanation: undefined,
    });
  });
  it('deletes only the chosen card after the dialog action', async () => {
    mount(<DeleteCardDialog card={card} onClose={() => {}} />);
    expect(cardsApi.deleteCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete phrase' }));
    await waitFor(() =>
      expect(cardsApi.deleteCard).toHaveBeenCalledExactlyOnceWith('card'),
    );
  });
  it('removes the library record with no original-file deletion option', async () => {
    mount(
      <RemoveMediaDialog
        media={media}
        onClose={() => {}}
        onRemoved={() => {}}
      />,
    );
    expect(
      screen.getByText(/Original files and saved phrases/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove from library' }),
    );
    await waitFor(() =>
      expect(libraryApi.removeMedia).toHaveBeenCalledExactlyOnceWith('media'),
    );
  });
  it('cancels a running job and retries interrupted work only after an explicit click', async () => {
    const request = {
      kind: 'url' as const,
      pathOrUrl: 'https://example.com/video.mp4',
      learningLanguage: 'en',
      explanationLanguage: 'ja',
    };
    vi.mocked(libraryApi.downloadJobs).mockResolvedValue([
      {
        id: 'running',
        request,
        status: 'running',
        phase: 'downloading',
        storedBytes: 1024,
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'stopped',
        request,
        status: 'interrupted',
        phase: 'downloading',
        storedBytes: 1024,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    mount(<DownloadJobs />);
    await screen.findByRole('button', { name: 'Cancel download' });
    expect(libraryApi.startUrlImport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel download' }));
    await waitFor(() =>
      expect(libraryApi.cancelDownload).toHaveBeenCalledExactlyOnceWith(
        'running',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry from start' }));
    await waitFor(() =>
      expect(libraryApi.startUrlImport).toHaveBeenCalledExactlyOnceWith(
        request,
      ),
    );
  });
});
