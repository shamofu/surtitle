// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  BookmarkPlus,
  Check,
  ChevronDown,
  Edit3,
  FolderOpen,
  Play,
  Settings2,
  Sparkles,
  Subtitles,
  Trash2,
  X
} from 'lucide-react';
import { queryKeys } from '../../shared/query/keys';
import type { AiQuote } from '../../shared/contracts/ai';
import type { SubtitleSegment } from '../../shared/contracts/media';
import type { VocabularyCandidate } from '../../shared/contracts/cards';
import {
  useAppearance,
  useDataActions,
  useNotifications,
  useSnapshot
} from '../../app/runtime';
import { activeSegment, languageName, timestamp } from '../../shared/format';
import { nativeAvailable } from '../../shared/native/transport';
import { Button, EmptyState, IconButton, Modal } from '../../shared/ui/index';
import { libraryApi } from '../library/api';
import { RemoveMediaDialog, SubtitleSourceDialog } from '../library/MediaManagement';
import { AiDialog } from '../ai/AiDialog';
import { JobActions } from '../ai/JobActions';
import { TransferDialog } from '../transfer/TransferDialog';
import { studyApi } from './api';
import { playerApi } from './playback/api';
import { NativePlayer } from './playback/NativePlayer';
import { EditDialog, SaveCardForm, phraseFormValues } from './StudyDialogs';
import type { PhraseFormValues } from './StudyDialogs';
import { StudyTranscript } from './StudyTranscript';
import { CurrentCaption } from './CurrentCaption';
import type { TranscriptTab, TranscriptViewState } from './StudyTranscript';
import { TranscriptReviewDialog } from './transcript/TranscriptReview';
import { resolveSourceSelection } from './source-selection';
import type { SelectedContext } from './source-selection';
import { useStudyExitGuard } from './useStudyExitGuard';

export function StudyPage() {
  const { mediaId } = useParams({ from: '/study/$mediaId' });
  return <StudySession
    key={mediaId}
    mediaId={mediaId}
  />;
}

type Inspection = {
  source: SelectedContext;
  fingerprint: string;
  mediaSignature: string;
  term: string;
  candidate?: VocabularyCandidate
};

type PhraseDraft = {
  inspection: Inspection;
  initial: PhraseFormValues;
  value: PhraseFormValues;
  invalidated: boolean;
};

function draftHasChanges(draft: PhraseDraft) {
  return JSON.stringify(draft.value) !== JSON.stringify(draft.initial);
}

function StudyExitDialog({ guard, saving }: { guard: ReturnType<typeof useStudyExitGuard>; saving: boolean }) {
  const { t } = useAppearance();
  if (!guard.open) return null;
  return <Modal title={t('入力途中のフレーズがあります', 'You have unfinished phrases')} onClose={guard.keepEditing}>
    <p>{saving ? t('保存が終わるまでお待ちください。', 'Wait for the save to finish.') : t(
      'この教材を離れると、保存していない入力は消えます。',
      'Leaving this material will discard your unsaved input.',
    )}</p>
    {guard.error && <p className="notice warning" role="alert">{guard.error}</p>}
    <footer className="modal-footer">
      <Button variant="primary" disabled={guard.closing} onClick={guard.keepEditing}>{t('編集を続ける', 'Keep editing')}</Button>
      <Button variant="danger" disabled={saving} busy={guard.closing} onClick={() => void guard.discard()}>{t('破棄して進む', 'Discard and continue')}</Button>
    </footer>
  </Modal>;
}

function phraseKey(source: SelectedContext) {
  return JSON.stringify(source.sourceCueIds?.length ? source.sourceCueIds : [source.id]);
}

function inspectionIsStale(inspection: Inspection, segments: SubtitleSegment[], mediaSignature: string) {
  const source = inspection.source;
  const ids = source.sourceCueIds?.length ? source.sourceCueIds : [source.id];
  return resolveSourceSelection(segments, source.mediaId, source.id, ids).missingOrReorderedSelection ||
    sourceFingerprint(segments, ids) !== inspection.fingerprint || mediaSignature !== inspection.mediaSignature;
}

function sourceFingerprint(cues: SubtitleSegment[], ids: string[]) {
  return JSON.stringify(ids.map(id => cues.find(cue => cue.id === id)));
}

function sourceSignature(source?: SelectedContext) {
  return source && JSON.stringify([
    source.id,
    source.mediaId,
    source.startMs,
    source.endMs,
    source.text,
    source.translation,
    source.status,
  ]);
}

function StudySession({ mediaId }: { mediaId: string }) {
  const navigate = useNavigate();
  const { mutate } = useDataActions();
  const { data } = useSnapshot();
  const { t, locale } = useAppearance();
  const { report } = useNotifications();
  const media = data?.media.find(item => item.id === mediaId);
  const mediaSignature = JSON.stringify([media?.path, media?.audioStreamIndex]);
  const segmentsQuery = useQuery({
    queryKey: queryKeys.segments(mediaId),
    queryFn: () => studyApi.segments(mediaId),
    enabled: nativeAvailable()
  });
  const candidatesQuery = useQuery({
    queryKey: queryKeys.candidates(mediaId),
    queryFn: () => studyApi.candidates(mediaId),
    enabled: nativeAvailable()
  });
  const segments = segmentsQuery.data || [];
  const latestSource = useRef({ segments, mediaSignature });
  latestSource.current = { segments, mediaSignature };
  const [positionMs, setPositionMs] = useState(media?.lastPositionMs ?? 0);
  const [inspection, setInspection] = useState<Inspection>();
  const [invalidated, setInvalidated] = useState(false);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [panel, setPanel] = useState<'transcript' | 'phrase' | null>(null);
  const [tab, setTab] = useState<TranscriptTab>('transcript');
  const [transcriptView, setTranscriptView] = useState<TranscriptViewState>({
    search: '', following: true, showTranslations: false, scrollOffset: 0,
  });
  const [fromTranscript, setFromTranscript] = useState(false);
  const [phraseDrafts, setPhraseDrafts] = useState<Record<string, PhraseDraft>>({});
  const [showDrafts, setShowDrafts] = useState(false);
  const [showMeaning, setShowMeaning] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const commandPending = useRef(false);
  const alive = useRef(true);
  const returnPosition = useRef<number | undefined>(undefined);
  const inspectButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const panelTitle = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const [repeatTarget, setRepeatTarget] = useState<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  const [playbackSettings, setPlaybackSettings] = useState(false);
  const [draftReview, setDraftReview] = useState<string>();
  const [draftPlayback, setDraftPlayback] = useState<SubtitleSegment>();
  const [edit, setEdit] = useState<SubtitleSegment>();
  const [aiKind, setAiKind] = useState<AiQuote['kind']>();
  const [transfer, setTransfer] = useState(false);
  const [subtitleSource, setSubtitleSource] = useState<'embedded' | 'file' | 'versions'>();
  const [removing, setRemoving] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const activeId = activeSegment(segments, positionMs);
  const active = segments.find(item => item.id === activeId);
  const activeIndex = segments.findIndex(item => item.id === activeId);
  const previousCaption = activeIndex >= 0 ? segments[activeIndex - 1]
    : segments.filter(item => item.endMs <= positionMs).at(-1);
  const nextCaption = activeIndex >= 0 ? segments[activeIndex + 1]
    : segments.find(item => item.startMs > positionMs);
  const ids = inspection?.source.sourceCueIds ?? (inspection ? [inspection.source.id] : []);
  const resolved = resolveSourceSelection(segments, mediaId, inspection?.source.id, ids);
  const sourceChanged = !!inspection && (
    resolved.missingOrReorderedSelection ||
    sourceFingerprint(segments, ids) !== inspection.fingerprint ||
    mediaSignature !== inspection.mediaSignature
  );
  const selectionInvalid = invalidated || sourceChanged;
  const selected = selectionInvalid ? undefined : inspection?.source;
  const draftMode = panel === 'transcript' && tab === 'draft';
  const formKey = inspection ? phraseKey(inspection.source) : undefined;
  const formDraft = formKey ? phraseDrafts[formKey] : undefined;
  const dirtyDrafts = Object.entries(phraseDrafts).filter(([, draft]) => draftHasChanges(draft));
  const exitGuard = useStudyExitGuard(dirtyDrafts.length > 0, saveBusy, () => setPhraseDrafts({}));

  useEffect(() => {
    if (!segmentsQuery.isSuccess) return;
    setPhraseDrafts(current => {
      let changed = false;
      const entries = Object.entries(current).map(([key, draft]) => {
        if (!draft.invalidated && inspectionIsStale(draft.inspection, segments, mediaSignature)) {
          changed = true;
          return [key, { ...draft, invalidated: true }];
        }
        return [key, draft];
      });
      return changed ? Object.fromEntries(entries) : current;
    });
  }, [segments, mediaSignature, segmentsQuery.isSuccess]);

  useEffect(() => {
    if (sourceChanged) setInvalidated(true);
  }, [sourceChanged]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(
    () => {
      if (panel) {
        panelTitle.current?.focus({ preventScroll: true });
        if (window.innerWidth < 1000) {
          panelTitle.current?.closest('.study-companion')?.scrollIntoView({ block: 'start' });
        }
      }
    },
    [panel]
  );

  useEffect(
    () => {
      if (!panel && !busy && restoreFocus.current) {
        restoreFocus.current = false;
        const element = trigger.current;
        if (element?.isConnected && element !== document.body) element.focus({ preventScroll: true });
        else inspectButton.current?.focus({ preventScroll: true });
        if (window.innerWidth < 1000) {
          const container = element?.closest('.page-content') ||
            inspectButton.current?.closest('.page-content');
          container?.scrollTo({ top: 0 });
        }
      }
    },
    [panel, busy]
  );

  async function run(action: () => Promise<void>) {
    if (commandPending.current || saveBusy) return;
    commandPending.current = true;
    setBusy(true);
    try {
      await report(action);
    }
    finally {
      commandPending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function rememberTrigger() {
    if (document.activeElement instanceof HTMLElement &&
      !document.activeElement.closest('.study-companion')) trigger.current = document.activeElement;
  }

  function prepareForm(context: Inspection) {
    const key = phraseKey(context.source);
    const existing = phraseDrafts[key];
    if (existing && draftHasChanges(existing)) {
      setInspection(existing.inspection);
      setInvalidated(existing.invalidated || inspectionIsStale(existing.inspection, segments, mediaSignature));
    } else {
      const initial = phraseFormValues(context.source, context.candidate, context.term);
      setPhraseDrafts(current => ({ ...current, [key]: {
        inspection: context, initial, value: initial,
        invalidated: inspectionIsStale(context, segments, mediaSignature),
      } }));
    }
    setShowSave(true);
  }

  function discardDraft(key: string) {
    setPhraseDrafts(current => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (formKey === key) setShowSave(false);
  }

  async function resumeDraft(draft: PhraseDraft) {
    rememberTrigger();
    await run(async () => {
      if (playerReady && media) {
        const state = await playerApi.playerState();
        if (!alive.current) return;
        await playerApi.player({ action: 'pause' });
        if (!alive.current) return;
        await playerApi.player({ action: 'seek', value: state.positionMs });
        if (!alive.current) return;
        returnPosition.current ??= state.positionMs;
      }
      setFromTranscript(panel === 'transcript');
      setInspection(draft.inspection);
      setInvalidated(draft.invalidated || inspectionIsStale(draft.inspection, segments, mediaSignature));
      setShowSave(true);
      setShowMeaning(false);
      setSaved(false);
      setPanel('phrase');
      setShowDrafts(false);
      setSelectionRevision(value => value + 1);
    });
  }

  function setContext(
    source: SelectedContext,
    term = '',
    candidate?: VocabularyCandidate,
    openSave = false
  ) {
    const sourceIds = source.sourceCueIds?.length ? source.sourceCueIds : [source.id];
    const current = resolveSourceSelection(segments, mediaId, source.id, sourceIds);
    const stale = current.missingOrReorderedSelection ||
      sourceSignature(source) !== sourceSignature(current.selected);
    const context: Inspection = {
      source: { ...source },
      fingerprint: sourceFingerprint(segments, sourceIds),
      mediaSignature,
      term,
      candidate
    };
    setInspection(context);
    setInvalidated(stale);
    setShowMeaning(false);
    setShowSave(openSave);
    if (openSave) prepareForm(context);
    setFromTranscript(panel === 'transcript' || (panel === 'phrase' && fromTranscript));
    setSaved(false);
    setPanel('phrase');
    setSelectionRevision(value => value + 1);
  }

  async function inspect(
    source: SelectedContext,
    term = '',
    candidate?: VocabularyCandidate,
    openSave = false
  ) {
    if (!playerReady) return;
    rememberTrigger();
    await run(async () => {
      const state = await playerApi.playerState();
      if (!alive.current) return;
      await playerApi.player({ action: 'pause' });
      if (!alive.current) return;
      await playerApi.player({ action: 'seek', value: state.positionMs });
      if (!alive.current) return;
      returnPosition.current ??= state.positionMs;
      setContext(source, term, candidate, openSave);
    });
  }

  async function replay(source: SelectedContext) {
    if (!playerReady) return;
    rememberTrigger();
    await run(async () => {
      const position = returnPosition.current ?? (await playerApi.playerState()).positionMs;
      if (!alive.current) return;
      const current = latestSource.current;
      const sourceIds = source.sourceCueIds?.length ? source.sourceCueIds : [source.id];
      const resolvedSource = resolveSourceSelection(
        current.segments,
        mediaId,
        source.id,
        sourceIds,
      );
      if (
        current.mediaSignature !== mediaSignature ||
        resolvedSource.missingOrReorderedSelection ||
        sourceSignature(source) !== sourceSignature(resolvedSource.selected)
      ) {
        throw new Error(t(
          '出典の字幕または音声が変わりました。区間を選び直してください。',
          'The source subtitles or audio changed. Select the passage again.',
        ));
      }
      if (source.sourceCueIds?.length) await playerApi.playSourceRange(mediaId, source.sourceCueIds);
      else await playerApi.player({ action: 'source-seek', startMs: source.startMs, endMs: source.endMs });
      if (!alive.current) return;
      returnPosition.current = position;
      if (selected === source) setSelectionRevision(value => value + 1);
      else setContext(source);
    });
  }

  async function moveCaption(source: SubtitleSegment | undefined, repeat = false) {
    if (!source || !playerReady || draftMode) return;
    await run(async () => {
      const current = latestSource.current;
      if (current.mediaSignature !== mediaSignature ||
          sourceSignature(current.segments.find(item => item.id === source.id)) !== sourceSignature(source)) {
        throw new Error(t('字幕が変わりました。もう一度選んでください。', 'The subtitles changed. Select the passage again.'));
      }
      await playerApi.player(repeat
        ? { action: 'source-seek', startMs: source.startMs, endMs: source.endMs }
        : { action: 'seek', value: source.startMs });
      if (!alive.current) return;
      setSelectionRevision(value => value + 1);
      // Ordinary seek preserves paused/playing in the native player. Neither
      // action changes the inspected source, saved return position, or form.
      const state = await playerApi.playerState();
      if (alive.current) setPositionMs(state.positionMs);
    });
  }

  async function closePanel(resume = false, destination: 'transcript' | null = null) {
    await run(async () => {
      if (playerReady && (inspection || draftPlayback || returnPosition.current !== undefined)) {
        const state = await playerApi.playerState();
        if (!alive.current) return;
        await playerApi.player({ action: 'pause' });
        if (!alive.current) return;
        await playerApi.player({
          action: 'seek',
          value: resume ? (returnPosition.current ?? state.positionMs) : state.positionMs
        });
        if (!alive.current) return;
        if (resume) await playerApi.player({ action: 'play' });
      }
      if (!alive.current) return;
      restoreFocus.current = destination === null;
      setPanel(destination);
      setInspection(undefined);
      setInvalidated(false);
      setDraftPlayback(undefined);
      setSelectionRevision(value => value + 1);
      setShowSave(false);
      setFromTranscript(false);
      returnPosition.current = undefined;
    });
  }

  const modalOpen = !!(edit || aiKind || draftReview || subtitleSource || removing || transfer ||
    playbackSettings || exitGuard.open);

  useEffect(
    () => {
      const escape = (event: KeyboardEvent) => {
        if (!event.defaultPrevented && event.key === 'Escape' && panel && !modalOpen && !busy && !saveBusy) {
          event.preventDefault();
          void closePanel();
        }
      };
      window.addEventListener('keydown', escape);
      return () => window.removeEventListener('keydown', escape);
    },
    [panel, modalOpen, busy, saveBusy, inspection, draftMode, draftPlayback, playerReady]
  );

  if (!media) return <>
    <EmptyState
    icon={<Subtitles size={28} />}
    title={t('教材を選んでください', 'Choose something to study')}
    description={t('ライブラリから動画や音声を開いてください。', 'Open a video or audio file from your library.')}
  >
    <Link
      to="/"
      className="button primary"
    >
      {t('ライブラリを開く', 'Open library')}
    </Link>
    </EmptyState>
    {dirtyDrafts.length > 0 && <section className="orphan-phrase-drafts" aria-label={t('入力途中のフレーズ', 'Unfinished phrases')}>
      <p>{t('教材が見つかりません。保存前の入力をコピーして残せます。', 'This material is unavailable. You can copy your unfinished notes before leaving.')}</p>
      {dirtyDrafts.map(([key, draft]) => <div key={key}>
        <textarea aria-label={t('保存前の入力', 'Unfinished notes')} readOnly rows={6} value={Object.values(draft.value).filter(Boolean).join('\n\n')} />
        <Button variant="ghost" onClick={() => discardDraft(key)}>{t('この入力を破棄', 'Discard this draft')}</Button>
      </div>)}
    </section>}
    <StudyExitDialog guard={exitGuard} saving={saveBusy} />
  </>;
  const jobs = data?.jobs.filter(job => job.mediaId === mediaId &&
    (job.status !== 'completed' || (job.pendingResults || 0) > 0 || job.transcriptReview)) ||
    [];
  const needsAttention = jobs.some(job => ['failed', 'unknown', 'paused'].includes(job.status) || (job.pendingResults || 0) > 0 ||
    !!job.transcriptReview);
  const matchingCandidate = inspection?.candidate ||
    candidatesQuery.data?.find(candidate => candidate.segmentId === selected?.id && candidate.term === inspection?.term);

  return (
    <div className={`study-page ${panel ? 'has-companion' : ''}`}>
      <header className="study-top">
        <Link
          to="/"
          className="back-link"
          aria-label={t('ライブラリへ', 'Back to library')}
        >
          <ArrowLeft size={19} />
        </Link>
        <div className="study-heading">
          <h1>{media.title}</h1>
          <span>{languageName(media.learningLanguage, locale)} / {timestamp(media.durationMs)}</span>
        </div>
        <div className="study-top-actions">
          {dirtyDrafts.length > 0 && <Button
            aria-expanded={showDrafts}
            disabled={busy || saveBusy}
            onClick={() => setShowDrafts(value => !value)}
          >
            <BookmarkPlus size={17} />
            {t(`入力途中のフレーズ (${dirtyDrafts.length})`, `Unfinished phrases (${dirtyDrafts.length})`)}
          </Button>}
          <Button
            aria-expanded={panel === 'transcript'}
            disabled={busy || saveBusy}
            onClick={() => {
              if (panel === 'transcript') void closePanel(); else {
                rememberTrigger();
                setPanel('transcript');
              }
            }}
          >
            <Subtitles size={17} />
            {t('字幕一覧', 'Transcript')}
          </Button>
          <Button
            aria-expanded={more}
            onClick={() => setMore(value => !value)}
          >
            {t('その他', 'More')}
            <ChevronDown size={15} />
          </Button>
        </div>
      </header>
      {showDrafts && dirtyDrafts.length > 0 && <section className="study-phrase-drafts" aria-label={t('入力途中のフレーズ', 'Unfinished phrases')}>
        {dirtyDrafts.map(([key, draft]) => <div className="study-phrase-draft" key={key}>
          <Button variant="ghost" disabled={busy || saveBusy} onClick={() => void resumeDraft(draft)}>
            {draft.value.term || draft.inspection.source.text}
            <span>{timestamp(draft.inspection.source.startMs)}</span>
          </Button>
          {draft.invalidated && <span>{t('出典を要確認', 'Source changed')}</span>}
          <IconButton label={t('この入力を破棄', 'Discard this draft')} disabled={busy || saveBusy} onClick={() => discardDraft(key)}>
            <Trash2 size={16} />
          </IconButton>
        </div>)}
      </section>}
      {more &&
        <div className="study-secondary-tools">
          <Button onClick={() => setPlaybackSettings(true)}>
            <Settings2 size={16} />
            {t('再生設定', 'Playback settings')}
          </Button>
          <Button onClick={() => setSubtitleSource('file')}>{t('字幕を読み込む', 'Import subtitles')}</Button>
          <Button onClick={() => setSubtitleSource('embedded')}>{t('埋め込み字幕を抽出', 'Extract embedded subtitles')}</Button>
          <Button onClick={() => setSubtitleSource('versions')}>{t('旧版', 'Versions')}</Button>
          <Button onClick={() => setAiKind(segments.length ? 'vocabulary' : 'transcribe')}>
            <Sparkles size={16} />
            {t('AI で学ぶ', 'Learn with AI')}
          </Button>
          <Button onClick={() => setTransfer(true)}>{t('書き出す', 'Export')}</Button>
          <Button
            variant="ghost"
            onClick={() => setRemoving(true)}
          >
            {t('ライブラリから除外', 'Remove from library')}
          </Button>
        </div>}
      {jobs.length > 0 &&
        <details className={`study-jobs ${needsAttention ? 'needs-attention' : ''}`}>
          <summary>
            {needsAttention
              ? t('確認が必要な処理があります', 'Some tasks need attention')
              : t(`${jobs.length} 件の処理`, `${jobs.length} tasks`)}
            <ChevronDown size={15} />
          </summary>
          <div>{jobs.map(job => <div
            className={`job-status ${job.status === 'failed' || job.status === 'unknown' ? 'warning' : ''}`}
            key={job.id}
          >
            <span>{job.message || job.kind}</span>
            {job.status === 'running' && <progress
              value={job.progress}
              max={1}
            />}
            <JobActions
              job={job}
              onReviewTranscript={setDraftReview}
            />
          </div>)}</div>
        </details>}
      {(media.status === 'missing' || media.status === 'error') &&
        <div
          className="job-status warning"
          role="alert"
        >
          <FolderOpen size={18} />
          <span>{media.error ||
            t(
              '元のメディアが見つかりません。場所を指定してください。',
              'The source media is missing. Locate the file to reconnect it.'
            )}</span>
          <Button
            onClick={() => void report(() => mutate(() => libraryApi.relinkMedia(mediaId), { kind: 'media', mediaId }))}
          >
            {t('ファイルを指定', 'Locate file')}
          </Button>
        </div>}
      <div className="study-grid">
        <div className="study-left">
          <NativePlayer
            media={media}
            selected={draftMode ? draftPlayback : selected}
            selectionRevision={selectionRevision}
            onPosition={setPositionMs}
            onReady={setPlayerReady}
            draftMode={draftMode}
            repeatTarget={repeatTarget}
            settingsOpen={playbackSettings}
            onSettingsClose={() => setPlaybackSettings(false)}
            interactionsDisabled={busy || saveBusy}
          />
          <CurrentCaption
            active={active}
            language={media.learningLanguage}
            loading={segmentsQuery.isLoading}
            hasSubtitles={segments.length > 0}
            draftMode={draftMode}
            enabled={playerReady && !busy && !saveBusy && !modalOpen}
            error={segmentsQuery.error}
            inspectButton={inspectButton}
            onInspect={(source, term) => void inspect(source, term)}
            onImport={() => setSubtitleSource('file')}
            hasPrevious={!!previousCaption}
            hasNext={!!nextCaption}
            onPrevious={() => void moveCaption(previousCaption)}
            onNext={() => void moveCaption(nextCaption)}
            onReplay={() => void moveCaption(active, true)}
          />
        </div>
        {panel &&
          <aside
            className={`study-companion transcript-panel ${panel === 'phrase' ? 'phrase-panel' : ''}`}
            aria-label={panel === 'phrase' ? t('言葉を確認', 'Inspect phrase') : t('字幕パネル', 'Transcript panel')}
          >
            <header className="companion-heading">
              <h2
                ref={panelTitle}
                tabIndex={-1}
              >
                {panel === 'phrase' ? t('言葉を確認', 'Inspect phrase') : t('字幕', 'Transcript')}
              </h2>
              <IconButton
                label={t('パネルを閉じる', 'Close panel')}
                disabled={busy || saveBusy}
                onClick={() => void closePanel()}
              >
                <X size={19} />
              </IconButton>
            </header>
            {panel === 'transcript'
              ? <StudyTranscript
                media={media}
                segments={segments}
                candidates={candidatesQuery.data || []}
                activeId={activeId}
                selectedId={selected?.id}
                ready={playerReady && !busy && !saveBusy}
                tab={tab}
                viewState={transcriptView}
                onViewStateChange={setTranscriptView}
                onTab={value => {
                  if (!commandPending.current && !saveBusy) setTab(value);
                }}
                error={segmentsQuery.error}
                candidatesError={candidatesQuery.error}
                onInspect={(...args) => void inspect(...args)}
                onReplay={source => void replay(source)}
                onEdit={setEdit}
                onImport={() => setSubtitleSource('file')}
                onEstimate={setAiKind}
                onReview={setDraftReview}
                onDraftPlay={async range => {
                  if (commandPending.current || saveBusy) throw new Error(t('再生操作が完了するまでお待ちください。', 'Wait for playback to finish updating.'));
                  commandPending.current = true;
                  setBusy(true);
                  try {
                    const state = await playerApi.playerState();
                    if (!alive.current) throw new Error('Study session closed');
                    await playerApi.player({ action: 'source-seek', ...range });
                    if (!alive.current) throw new Error('Study session closed');
                    returnPosition.current ??= state.positionMs;
                    setDraftPlayback({ id: 'draft-playback', mediaId, ...range, text: '', status: 'provisional' });
                    setSelectionRevision(value => value + 1);
                  } finally {
                    commandPending.current = false;
                    if (alive.current) setBusy(false);
                  }
                }}
              />
              : <div className="phrase-inspector">
                {fromTranscript && <Button
                  variant="ghost"
                  disabled={busy || saveBusy}
                  onClick={() => void closePanel(false, 'transcript')}
                >
                  <ArrowLeft size={16} />
                  {t('字幕一覧へ戻る', 'Back to transcript')}
                </Button>}
                {selectionInvalid
                  ? <p
                    className="notice warning"
                    role="alert"
                  >
                    {t(
                      '出典の字幕が変わりました。字幕や表現を選び直してください。',
                      'The source subtitles changed. Select the subtitles or phrase again.'
                    )}
                  </p>
                  : selected &&
                  <>
                    <p className="context-time">{timestamp(selected.startMs)}–{timestamp(selected.endMs)}</p>
                    <p className="context-sentence">{selected.text}</p>
                    {inspection?.term && <p className="inspected-term">{inspection.term}</p>}
                    <Button
                      variant="ghost"
                      aria-expanded={showMeaning}
                      onClick={() => setShowMeaning(value => !value)}
                    >
                      {showMeaning ? t('意味を閉じる', 'Hide meaning') : t('意味を見る', 'Show meaning')}
                    </Button>
                    {showMeaning &&
                      <div className="context-meaning">
                        {matchingCandidate?.meaning && <p>{matchingCandidate.meaning}</p>}
                        {selected.translation && <p className="context-translation">{selected.translation}</p>}
                        {matchingCandidate?.explanation && <p>{matchingCandidate.explanation}</p>}
                        {!selected.translation && !matchingCandidate?.meaning &&
                          <p>{t(
                            '訳や解説はまだありません。意味を入力して保存するか、AIへの依頼を見積もれます。',
                            'No meaning or explanation yet. Enter a meaning to save, or request an AI estimate.'
                          )}</p>}
                      </div>}
                  </>}
                <div className="context-actions">
                  <Button
                    disabled={!selected || !playerReady || busy || saveBusy}
                    onClick={() => selected && void replay(selected)}
                  >
                    <Play size={16} />
                    {t('もう一度聴く', 'Listen again')}
                  </Button>
                  <div
                    className="repeat-slot"
                    ref={setRepeatTarget}
                  />
                </div>
                {selected &&
                  <>
                    <div className="context-ai-actions">
                      <Button
                        variant="ghost"
                        disabled={busy || saveBusy}
                        onClick={() => setAiKind('vocabulary')}
                      >
                        <Sparkles size={16} />
                        {t('解説を見積もる', 'Estimate explanation')}
                      </Button>
                      {!selected.translation &&
                        <Button
                          variant="ghost"
                          disabled={busy || saveBusy}
                          onClick={() => setAiKind('translate')}
                        >
                          {t('翻訳を見積もる', 'Estimate translation')}
                        </Button>}
                      <Button
                        variant="ghost"
                        disabled={saveBusy}
                        onClick={() => setEdit(segments.find(cue => cue.id === selected.id))}
                      >
                        <Edit3 size={15} />
                        {t('字幕を編集', 'Edit subtitle')}
                      </Button>
                    </div>
                    {!!selected.status && selected.status !== 'confirmed' &&
                      <p className="notice warning">{t(
                        '未確認の字幕です。編集画面で内容を確認すると保存できます。',
                        'Confirm this subtitle in the editor before saving a phrase.'
                      )}</p>}
                  </>}
                {showSave && inspection && formDraft && formKey
                  ? <SaveCardForm
                    key={formKey}
                    segment={formDraft.inspection.source}
                    candidate={inspection?.candidate}
                    initialTerm={inspection?.term || ''}
                    value={formDraft.value}
                    onChange={value => setPhraseDrafts(current => ({
                      ...current,
                      [formKey]: { ...formDraft, value },
                    }))}
                    sourceInvalid={selectionInvalid || formDraft.invalidated}
                    onDiscard={() => discardDraft(formKey)}
                    onBusyChange={setSaveBusy}
                    onClose={() => setShowSave(false)}
                    onSaved={() => {
                      discardDraft(formKey);
                      setShowSave(false);
                      setSaved(true);
                    }}
                  />
                  : <Button
                    variant="primary"
                    disabled={!selected || (!!selected.status && selected.status !== 'confirmed') || busy ||
                      saveBusy}
                    onClick={() => inspection && prepareForm(inspection)}
                  >
                    <BookmarkPlus size={17} />
                    {t('フレーズを保存', 'Save a phrase')}
                  </Button>}
                {saved &&
                  <p
                    className="phrase-saved"
                    role="status"
                  >
                    <Check size={16} />
                    {t('フレーズ帳に保存しました', 'Saved to your phrases')}
                  </p>}
                <Button
                  className="return-to-watching"
                  disabled={!playerReady || busy || saveBusy}
                  onClick={() => void closePanel(true)}
                >
                  <Play size={17} />
                  {t('視聴に戻る', 'Return to watching')}
                </Button>
              </div>}
          </aside>}
      </div>
      <StudyExitDialog guard={exitGuard} saving={saveBusy} />
      {draftReview &&
        <TranscriptReviewDialog
          jobId={draftReview}
          onClose={() => setDraftReview(undefined)}
        />}
      {subtitleSource &&
        <SubtitleSourceDialog
          media={media}
          initialMode={subtitleSource}
          onClose={() => setSubtitleSource(undefined)}
        />}
      {removing &&
        <RemoveMediaDialog
          media={media}
          onClose={() => setRemoving(false)}
          onRemoved={() => {
            setRemoving(false);
            void navigate({ to: '/' });
          }}
        />}
      {edit && <EditDialog
        segment={edit}
        onClose={() => setEdit(undefined)}
      />}
      {aiKind &&
        <AiDialog
          media={media}
          initialKind={aiKind}
          initialRange={selected}
          initialTerm={inspection?.term || selected?.text}
          onClose={() => setAiKind(undefined)}
        />}
      {transfer && <TransferDialog
        mediaId={mediaId}
        onClose={() => setTransfer(false)}
      />}
    </div>
  );
}
