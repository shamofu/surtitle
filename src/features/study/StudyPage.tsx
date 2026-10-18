// SPDX-License-Identifier: GPL-3.0-or-later
import { AnimatedDetails } from '../../shared/ui/AnimatedDetails';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  BookmarkPlus,
  ChevronDown,
  Edit3,
  FolderOpen,
  Play,
  Sparkles,
  Subtitles,
  Trash2,
  X
} from 'lucide-react';
import { queryKeys } from '../../shared/query/keys';
import type { AiQuote } from '../../shared/contracts/ai';
import type { SubtitleSegment } from '../../shared/contracts/media';
import { subtitleUsable } from '../../shared/contracts/media';
import type { VocabularyCandidate } from '../../shared/contracts/cards';
import {
  useAppearance,
  useDataActions,
  useNotifications,
  useSnapshot,
  useSurface
} from '../../app/runtime';
import { shouldIgnoreShortcut } from '../../shared/keyboard';
import { activeSegment, languageName, timestamp } from '../../shared/format';
import { AnimatedCheck, AnimatedValue, MotionRegion } from '../../shared/motion';
import { nativeAvailable } from '../../shared/native/transport';
import { Button, EmptyState, IconButton, Modal, MotionButton, useModalExit } from '../../shared/ui/index';
import { ProgressStatus } from '../../shared/ui/ProgressStatus';
import { libraryApi } from '../library/api';
import { RemoveMediaDialog, SubtitleSourceDialog } from '../library/MediaManagement';
import { AiDialog } from '../ai/AiDialog';
import { continuationApi, type AiContinuation } from '../ai/continuations';
import { editorDraftApi, flushEditorDrafts } from './editor-drafts/useEditorDraft';
import { JobActions } from '../ai/JobActions';
import { AiRuntime, JobOutcome } from '../ai/AiRuntime';
import type { CaptionGapMode } from '../../shared/contracts/settings';
import { useEditingSession } from '../../shared/editing/useEditingSession';
import { settingsEditor } from '../settings/editing';
import { TransferDialog } from '../transfer/TransferDialog';
import { studyApi } from './api';
import { playerApi } from './playback/api';
import { NativePlayer } from './playback/NativePlayer';
import { useCaptionPosition } from './playback/useCaptionPosition';
import { EditDialog, SaveCardForm, phraseFormValues } from './StudyDialogs';
import type { PhraseFormValues } from './StudyDialogs';
import { StudyTranscript } from './StudyTranscript';
import { CurrentCaption } from './CurrentCaption';
import type { TranscriptTab, TranscriptViewState } from './StudyTranscript';
import { TranscriptReviewDialog } from './transcript/TranscriptReview';
import { TranscriptionWorkspace, type TranscriptionRequest } from './transcript/TranscriptionWorkspace';
import { resolveSourceSelection } from './source-selection';
import type { SelectedContext } from './source-selection';
import { useStudyExitGuard } from './useStudyExitGuard';
import { StudyRegion, useStudyPresence } from './StudyPresence';

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
  const exit = useModalExit(guard.open);
  if (!guard.open) return null;
  const leave = (action: () => Promise<boolean>) => void exit.close(async () => { if (!await action()) exit.reopen(); });
  return <Modal {...exit.modalProps} title={t('入力途中のフレーズがあります', 'You have unfinished phrases')} closeDisabled={guard.closing || exit.exiting} onClose={() => void exit.close(guard.keepEditing)}>
    <p>{saving ? t('保存が終わるまでお待ちください。', 'Wait for the save to finish.') : !guard.canDiscard ? t(
      '入力の保存を完了できませんでした。内容は保持しています。編集を続けるか、保存を再試行してください。',
      'Your input could not be saved and is still here. Keep editing or retry saving.',
    ) : t(
      '下書きの保存を完了できませんでした。再試行するか、保存していない変更を破棄して進めます。',
      'Your latest changes could not be saved. Retry, or discard unsaved changes to continue.',
    )}</p>
    {guard.error && <p className="notice warning" role="alert">{guard.error}</p>}
    <footer className="modal-footer">
      <Button variant="primary" disabled={guard.closing || exit.exiting} onClick={() => void exit.close(guard.keepEditing)}>{t('編集を続ける', 'Keep editing')}</Button>
      {guard.error && <Button disabled={saving || exit.exiting} busy={guard.closing} onClick={() => leave(guard.retry)}>{t('保存して進む', 'Retry saving and continue')}</Button>}
      {guard.canDiscard && <Button variant="danger" disabled={saving || exit.exiting} busy={guard.closing} onClick={() => leave(guard.discard)}>{t('破棄して進む', 'Discard and continue')}</Button>}
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
    source.timingPrecision,
  ]);
}

function StudySession({ mediaId }: { mediaId: string }) {
  const navigate = useNavigate();
  const { resume: resumeId } = useSearch({ from: '/study/$mediaId' });
  const { mutate, refresh } = useDataActions();
  const { data, loading, error: snapshotError } = useSnapshot();
  const { t, locale } = useAppearance();
  const { report } = useNotifications();
  const { surfaceHidden } = useSurface();
  const client = useQueryClient();
  const [preferences] = useState(() => settingsEditor(client));
  const preferenceEditing = useEditingSession(preferences);
  const requestedGapMode = useRef<CaptionGapMode | undefined>(undefined);
  const gapMode: CaptionGapMode = (preferenceEditing.ready
    ? preferenceEditing.fields.captionGapMode
    : data?.settings?.captionGapMode) === 'preview' ? 'preview' : 'review';
  function changeGapMode(mode: CaptionGapMode) {
    requestedGapMode.current = mode;
    preferences.change({ captionGapMode: mode });
    void preferences.flush();
  }
  function retryGapMode() {
    const requested = requestedGapMode.current;
    if (requested && preferences.getSnapshot().recovery?.captionGapMode === requested) {
      preferences.change({ captionGapMode: requested });
    }
    void preferences.flush();
  }
  const media = data?.media.find(item => item.id === mediaId);
  const mediaSignature = JSON.stringify([media?.path, media?.audioStreamIndex]);
  const aiMediaSignature = JSON.stringify([media?.path, media?.audioStreamIndex, media?.learningLanguage, media?.explanationLanguage]);
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
  const transcriptIssuesQuery = useQuery({ queryKey: queryKeys.transcriptIssues(mediaId), queryFn: () => studyApi.transcriptIssues(mediaId), enabled: nativeAvailable() });
  const continuationsQuery = useQuery({ queryKey: ['ai-continuations'], queryFn: continuationApi.list, enabled: nativeAvailable() });
  const draftsQuery = useQuery({ queryKey: ['editor-drafts', mediaId], queryFn: () => editorDraftApi.list(mediaId), enabled: nativeAvailable() });
  const segments = segmentsQuery.data || [];
  const emptyRangeIssues = (transcriptIssuesQuery.data || []).filter(issue =>
    !segments.some(cue => cue.startMs < issue.endMs && cue.endMs > issue.startMs),
  );
  const latestSource = useRef({ segments, mediaSignature });
  latestSource.current = { segments, mediaSignature };
  const [positionMs, setPositionMs] = useCaptionPosition(segments, media?.lastPositionMs ?? 0);
  const [inspection, setInspection] = useState<Inspection>();
  const [invalidated, setInvalidated] = useState(false);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [panel, setPanel] = useState<'transcript' | 'phrase' | 'activity' | null>(() =>
    window.innerWidth >= 1000 && window.innerHeight >= 681 ? 'transcript' : null);
  const initialTranscript = useRef(panel === 'transcript');
  const companion = useStudyPresence(panel !== null, !!media);
  const companionContents = useRef<HTMLDivElement>(null);
  const previousPanel = useRef(panel);
  useLayoutEffect(() => { if (panel) previousPanel.current = panel; }, [panel]);
  const presentedPanel = panel || previousPanel.current;
  const [tab, setTab] = useState<TranscriptTab>('transcript');
  const [transcriptView, setTranscriptView] = useState<TranscriptViewState>({
    search: '', following: true, showTranslations: false, scrollOffset: 0,
  });
  const [fromTranscript, setFromTranscript] = useState(false);
  const [phraseDrafts, setPhraseDrafts] = useState<Record<string, PhraseDraft>>({});

  const [showMeaning, setShowMeaning] = useState(false);
  const [meaningRequest, setMeaningRequest] = useState<{ key: string; term: string }>();
  const [showSave, setShowSave] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const commandPending = useRef(false);
  const alive = useRef(true);
  const returnPosition = useRef<number | undefined>(undefined);
  const inspectButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const revealPlayback = useRef(false);
  const panelTitle = useRef<HTMLHeadingElement>(null);
  const transcriptToggle = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const [repeatTarget, setRepeatTarget] = useState<HTMLDivElement | null>(null);

  const [playbackSettings, setPlaybackSettings] = useState(false);
  const [jobHistoryOpen, setJobHistoryOpen] = useState(false);
  const [draftReview, setDraftReview] = useState<string>();
  const [draftPlayback, setDraftPlayback] = useState<SubtitleSegment>();
  const [edit, setEdit] = useState<SubtitleSegment>();
  const [aiKind, setAiKind] = useState<AiQuote['kind']>();
  const [transcriptionRequest, setTranscriptionRequest] = useState<TranscriptionRequest>();
  const [aiContinuation, setAiContinuation] = useState<AiContinuation>();
  const [aiRebind, setAiRebind] = useState<AiContinuation>();
  const [transfer, setTransfer] = useState(false);
  const [subtitleSource, setSubtitleSource] = useState<'choose' | 'embedded' | 'file' | 'versions' | 'transcribe'>();
  const [subtitleStreamIndex, setSubtitleStreamIndex] = useState<number>();
  const [removing, setRemoving] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const timedSegments = useMemo(() => segments.filter(segment => segment.timingPrecision !== 'source_block'), [segments]);
  const activeId = activeSegment(timedSegments, positionMs);
  const active = segments.find(item => item.id === activeId);
  const activeIndex = timedSegments.findIndex(item => item.id === activeId);
  const previousCaption = activeIndex >= 0 ? timedSegments[activeIndex - 1]
    : timedSegments.filter(item => item.endMs <= positionMs).at(-1);
  const nextCaption = activeIndex >= 0 ? timedSegments[activeIndex + 1]
    : timedSegments.find(item => item.startMs > positionMs);
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
  const meaningTerm = inspection?.term.trim() || selected?.text || '';
  const matchingCandidate = candidatesQuery.data?.find(candidate =>
    candidate.segmentId === selected?.id && candidate.term === meaningTerm &&
    (!candidate.sourceCueIds?.length || JSON.stringify(candidate.sourceCueIds) === formKey),
  ) || inspection?.candidate;
  const hasMeaning = !!(matchingCandidate?.meaning || matchingCandidate?.explanation || selected?.translation);
  useEffect(() => {
    if (meaningRequest && meaningRequest.key === formKey && meaningRequest.term === meaningTerm && hasMeaning && !selectionInvalid) {
      setShowMeaning(true);
      setMeaningRequest(undefined);
    }
  }, [meaningRequest, formKey, meaningTerm, hasMeaning, selectionInvalid]);
  const dirtyDrafts = Object.entries(phraseDrafts).filter(([, draft]) => draftHasChanges(draft));
  const exitGuard = useStudyExitGuard(dirtyDrafts.length > 0, saveBusy, () => setPhraseDrafts({}), flushEditorDrafts);
  const resumed = useRef<string | undefined>(undefined);
  function continuationSource(item: AiContinuation) {
    const sourceIds = item.sourceCueIds || [];
    if (!segmentsQuery.isSuccess || !sourceIds.length || !item.sourceRevision || item.sourceMediaSignature !== aiMediaSignature) return undefined;
    const source = resolveSourceSelection(segments, mediaId, sourceIds[0], sourceIds).selected;
    return source && sourceFingerprint(segments, sourceIds) === item.sourceRevision
      && sourceIds.every(id => segments.some(cue => cue.id === id && subtitleUsable(cue))) ? source : undefined;
  }
  const aiSourceInvalid = !!aiContinuation && aiContinuation.kind !== 'transcribe' && !continuationSource(aiContinuation);
  function resumeAi(item: AiContinuation) {
    if (!segmentsQuery.isSuccess) return;
    rememberTrigger();
    if (item.kind === 'transcribe') {
      setAiKind(undefined); setPanel('transcript'); setTab('transcription');
      setTranscriptionRequest({ id: item.id, continuation: item });
      return;
    }
    setAiRebind(undefined);
    setAiContinuation(item);
    setAiKind(item.kind);
    const source = continuationSource(item);
    setInspection(undefined); setInvalidated(false); setMeaningRequest(undefined); setShowMeaning(false);
    if (source) {
      const restoredIds = source.sourceCueIds?.length ? source.sourceCueIds : [source.id];
      setInspection({ source, fingerprint: item.sourceRevision || sourceFingerprint(segments, restoredIds), mediaSignature, term: item.focusTerm });
      setInvalidated(false); setPanel('phrase');
      setMeaningRequest({ key: phraseKey(source), term: item.focusTerm.trim() || source.text });
    }
  }
  useEffect(() => {
    const item = continuationsQuery.data?.find(value => value.id === resumeId && value.mediaId === mediaId);
    if (!segmentsQuery.isSuccess) return;
    if (item && resumed.current !== item.id) { resumed.current = item.id; resumeAi(item); }
  }, [resumeId, continuationsQuery.data, mediaId, segmentsQuery.isSuccess]);
  useEffect(() => {
    if (!media || !draftsQuery.data) return;
    setPhraseDrafts(current => {
      const next = { ...current };
      for (const draft of draftsQuery.data.filter(item => item.kind === 'phrase')) {
        if (next[draft.sourceKey]) continue;
        const ids = draft.sourceCues.map(cue => cue.id);
        const source = { ...draft.sourceCues[0], sourceCueIds: ids,
          endMs: Math.max(...draft.sourceCues.map(cue => cue.endMs)),
          text: draft.sourceCues.map(cue => cue.text).join('\n') };
        if (!source.id) continue;
        const value: PhraseFormValues = { term: draft.fields.term || '', meaning: draft.fields.meaning || '', example: draft.fields.example || '', explanation: draft.fields.explanation || '', ...(draft.fields.audioStart ? { audioStart: draft.fields.audioStart, audioEnd: draft.fields.audioEnd } : {}) };
        next[draft.sourceKey] = { inspection: { source, fingerprint: sourceFingerprint(draft.sourceCues, ids), mediaSignature, term: value.term }, value,
          initial: { term: '', meaning: '', example: '', explanation: '' }, invalidated: draft.stale || !draft.bindingVerified };
      }
      return next;
    });
  }, [draftsQuery.data, media?.id]);

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

  useLayoutEffect(
    () => {
      if (panel && companion.ready) {
        // A wide-screen companion is part of the initial layout, not a focus
        // navigation request. Resizing must not turn it into one either.
        if (initialTranscript.current) return;
        // A disclosure toggle keeps its place and keyboard focus on narrow
        // screens. Inspecting a phrase or starting setup is explicit navigation.
        if (window.innerWidth < 1000 && panel === 'transcript' && trigger.current === transcriptToggle.current) {
          // Presence scrolled the stationary dock before native placement acknowledgement.
          return;
        }
        // Opening may finish after the user has already focused an input or
        // another control. Only transfer focus while it still belongs to the
        // opener (or was lost with the previous panel), never interrupt typing.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused !== document.body && focused !== trigger.current &&
          !focused.closest('[inert], [hidden]')) return;
        panelTitle.current?.focus({ preventScroll: true });
      }
    },
    [panel, companion.ready]
  );

  function restorePanelFocus() {
    if (!surfaceHidden) {
      const element = trigger.current;
      const preventScroll = window.innerWidth >= 1000;
      if (element?.isConnected && element !== document.body) element.focus({ preventScroll });
      else transcriptToggle.current?.focus({ preventScroll });
    }
  }
  useLayoutEffect(() => {
    // The close transaction re-enables the opener in this render. Focusing it
    // before that commit would fail while the playback command still marks it busy.
    if (!panel && !busy && !surfaceHidden && restoreFocus.current) {
      restoreFocus.current = false;
      restorePanelFocus();
    }
    if (!companion.moving && !busy && !surfaceHidden && revealPlayback.current) {
      revealPlayback.current = false;
      if (window.innerWidth < 1000) inspectButton.current?.closest('.study-left')?.scrollIntoView({ block: 'nearest' });
    }
  }, [panel, companion.visible, companion.moving, busy, surfaceHidden]);

  async function run(action: () => Promise<void>) {
    if (commandPending.current || saveBusy) return;
    commandPending.current = true;
    setBusy(true);
    try {
      await report(async () => { await flushEditorDrafts(); await action(); });
    }
    finally {
      commandPending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function rememberTrigger() {
    initialTranscript.current = false;
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

  async function discardDraft(key: string) {
    const success = await report(async () => {
      await flushEditorDrafts();
      const stored = (await editorDraftApi.list(mediaId)).find(draft => draft.kind === 'phrase' && draft.sourceKey === key);
      if (stored) await editorDraftApi.discard(stored);
      return true;
    });
    if (!success) return;
    setPhraseDrafts(current => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (formKey === key) setShowSave(false);
    void draftsQuery.refetch();
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

      setSelectionRevision(value => value + 1);
    });
  }

  async function setContext(
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
    setShowMeaning(true);
    setShowSave(openSave);
    if (openSave) prepareForm(context);
    setFromTranscript(panel === 'transcript' || (panel === 'phrase' && fromTranscript));
    setSaved(false);
    setPanel('phrase');
    setSelectionRevision(value => value + 1);
    if (aiRebind && !stale) {
      const rebound: AiContinuation = { ...aiRebind, sourceCueIds: sourceIds,
        sourceMediaSignature: aiMediaSignature,
        sourceRevision: sourceFingerprint(segments, sourceIds), start: timestamp(source.startMs, true),
        end: timestamp(source.endMs, true), quoteId: undefined, preparationId: undefined };
      const persisted = await continuationApi.save(rebound);
      if (!alive.current) return;
      setInspection({ ...context, term: persisted.focusTerm, candidate: undefined });
      setAiContinuation(persisted); setAiRebind(undefined); setAiKind(persisted.kind);
    }
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
      await setContext(source, term, candidate, openSave);
    });
  }

  async function playSource(source: SelectedContext, mode: 'continue' | 'range') {
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
      if (mode === 'continue') {
        // A plain seek clears a previous range stop/loop without setting a new end.
        await playerApi.player({ action: 'seek', value: source.startMs });
        if (!alive.current) return;
        await playerApi.player({ action: 'play' });
        if (!alive.current) return;
        // Resume follow at the selected cue before delayed native position events
        // arrive, and clear search so subsequent subtitles can remain in view.
        setPositionMs(source.startMs);
        setTranscriptView(view => ({ ...view, search: '', following: true }));
        returnPosition.current = undefined;
        setInspection(undefined);
        setInvalidated(false);
        setDraftPlayback(undefined);
        setShowSave(false);
        setSelectionRevision(value => value + 1);
        return;
      }
      if (source.sourceCueIds?.length || source.timingPrecision === 'source_block') await playerApi.playSourceRange(mediaId, source.sourceCueIds?.length ? source.sourceCueIds : [source.id]);
      else await playerApi.player({ action: 'source-seek', startMs: source.startMs, endMs: source.endMs });
      if (!alive.current) return;
      returnPosition.current = position;
      if (selected === source) setSelectionRevision(value => value + 1);
      else await setContext(source);
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

  async function closePanel(resume = false, destination: 'transcript' | 'activity' | null = null, destinationTab?: TranscriptTab) {
    initialTranscript.current = false;
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
      revealPlayback.current = resume;
      setPanel(destination);
      if (destinationTab) setTab(destinationTab);
      setInspection(undefined);
      setInvalidated(false);
      setDraftPlayback(undefined);
      setSelectionRevision(value => value + 1);
      setShowSave(false);
      setFromTranscript(false);
      returnPosition.current = undefined;
    });
  }

  useEffect(
    () => {
      const escape = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
          event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        const target = event.target instanceof Element ? event.target : null;
        // Panel buttons and tabs may dismiss the panel; text fields and selects
        // keep their own Escape behavior, as do controls outside the companion.
        const panelControl = target?.closest('button, [role="tab"]')?.closest('.study-companion, .study-transcript-toggle');
        if ((!shouldIgnoreShortcut(event) || panelControl) && panel && !surfaceHidden && !busy && !saveBusy) {
          event.preventDefault();
          void closePanel();
        }
      };
      window.addEventListener('keydown', escape);
      return () => window.removeEventListener('keydown', escape);
    },
    [panel, surfaceHidden, busy, saveBusy, inspection, draftMode, draftPlayback, playerReady]
  );

  if (!data && loading) return <div className="empty-state" role="status" aria-busy="true">
    <p>{t('教材を読み込み中…', 'Loading your material…')}</p>
  </div>;
  if (!data && snapshotError) return <div className="notice warning" role="alert">
    <span>{t('教材を読み込めませんでした。', 'Could not load your material.')} {snapshotError.message}</span>
    <Button onClick={() => void report(() => refresh())}>{t('再試行', 'Retry')}</Button>
  </div>;
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
  const jobs = data?.jobs.filter(job => job.mediaId === mediaId && job.kind !== 'transcribe' && !job.automaticTranscript &&
    (job.status !== 'completed' || (job.pendingResults || 0) > 0 || job.needsAttention)) ||
    [];
  const needsAttention = jobs.some(job => ['failed', 'unknown', 'paused'].includes(job.status) || (job.pendingResults || 0) > 0 ||
    !!job.needsAttention);
  const completedJobs = data?.jobs.filter(job => job.mediaId === mediaId && job.kind !== 'transcribe' && !job.automaticTranscript && job.status === 'completed' && !job.needsAttention && !(job.pendingResults || 0)) || [];
  function openTranscription(range?: { startMs: number; endMs: number }) {
    rememberTrigger();
    setPanel('transcript'); setTab('transcription'); setAiKind(undefined);
    const running = data?.jobs.some(job => job.mediaId === mediaId && (job.kind === 'transcribe' || job.automaticTranscript) && ['running', 'paused', 'queued'].includes(job.status));
    if (range || (!running && !transcriptionRequest)) setTranscriptionRequest({ id: crypto.randomUUID(), range });
  }
  function openAi(kind: AiQuote['kind']) {
    if (kind === 'transcribe') { openTranscription(); return; }
    setAiContinuation(undefined);
    setAiKind(kind);
    if (kind === 'vocabulary' && formKey && selected) setMeaningRequest({ key: formKey, term: meaningTerm });
  }

  return (
    <div className={`study-page ${companion.visible ? 'has-companion' : ''}`}>
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
          <span>{languageName(media.learningLanguage, locale)} / <AnimatedValue value={timestamp(media.durationMs)} /></span>
        </div>
        <div className="study-top-actions">
          <MotionButton
            ref={transcriptToggle}
            type="button"
            className="button secondary study-transcript-toggle"
            hoverMotion={false}
            aria-expanded={panel === 'transcript'}
            aria-controls="study-companion"
            title={panel === 'transcript' ? t('字幕パネルを閉じる', 'Close transcript panel') : t('字幕パネルを開く', 'Open transcript panel')}
            disabled={busy || saveBusy}
            onClick={() => {
              initialTranscript.current = false;
              trigger.current = transcriptToggle.current;
              if (panel === 'transcript') void closePanel();
              else if (panel === 'phrase') void closePanel(false, 'transcript', 'transcript');
              else setPanel('transcript');
            }}
          >
            <Subtitles size={17} aria-hidden="true" />
            <span>{t('字幕一覧', 'Transcript')}</span>
          </MotionButton>
          <MotionRegion mode="status" open={dirtyDrafts.length > 0}>{dirtyDrafts.length > 0 && <Button
            aria-expanded={panel === 'activity'}
            disabled={busy || saveBusy}
            onClick={() => { rememberTrigger(); setPanel('activity'); }}
          >
            <BookmarkPlus size={17} />
            <AnimatedValue value={t(`入力途中のフレーズ (${dirtyDrafts.length})`, `Unfinished phrases (${dirtyDrafts.length})`)} />
          </Button>}</MotionRegion>
          <Button
            aria-expanded={panel === 'activity'}
            aria-controls="study-management"
            onClick={() => panel === 'activity' ? void closePanel() : void closePanel(false, 'activity')}
          >
            {t('処理・管理', 'Activity & tools')}
            <ChevronDown size={15} />
          </Button>
        </div>
      </header>
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
            onSettingsOpen={() => setPlaybackSettings(true)}
            onSettingsClose={() => setPlaybackSettings(false)}
            onUseStudySubtitles={streamIndex => { setSubtitleStreamIndex(streamIndex); setSubtitleSource('embedded'); }}
            interactionsDisabled={busy || saveBusy}
            gapMode={gapMode}
            onGapModeChange={changeGapMode}
            gapModeReady={preferenceEditing.ready}
            gapModeSaving={preferenceEditing.saving}
            gapModeError={preferenceEditing.error}
            onGapModeRetry={retryGapMode}
            onPreferencesChanged={() => preferences.refresh()}
          />
          <CurrentCaption
            active={active}
            language={media.learningLanguage}
            loading={segmentsQuery.isLoading}
            hasSubtitles={segments.length > 0}
            hasTimedSubtitles={timedSegments.length > 0}
            previous={previousCaption}
            next={nextCaption}
            gapMode={gapMode}
            draftMode={draftMode}
            enabled={playerReady && !busy && !saveBusy && !surfaceHidden}
            error={segmentsQuery.error}
            inspectButton={inspectButton}
            onInspect={(source, term) => void inspect(source, term)}
            onSave={source => void inspect(source, '', undefined, true)}
            onImport={() => setSubtitleSource('choose')}
            onTranscribe={() => openTranscription()}
            onOpenTranscript={() => { rememberTrigger(); setPanel('transcript'); setTab('transcript'); }}
            hasPrevious={!!previousCaption}
            hasNext={!!nextCaption}
            onPrevious={() => void moveCaption(previousCaption)}
            onNext={() => void moveCaption(nextCaption)}
            onReplay={source => void moveCaption(source, true)}
          />
        </div>
        <div className="study-companion-dock" {...companion.dockProps}>
          {/* Keep setup and estimates alive while inspecting a phrase or closing the panel. */}
          <aside
            ref={companion.panelRef}
            id="study-companion"
            hidden={!companion.visible}
            inert={!panel || !companion.ready}
            aria-disabled={!panel || !companion.ready || undefined}
            aria-hidden={!panel || !companion.ready || undefined}
            className={`study-companion transcript-panel ${presentedPanel === 'phrase' ? 'phrase-panel' : ''}`}
            aria-label={presentedPanel === 'phrase' ? t('意味とフレーズ', 'Meaning and phrases') : presentedPanel === 'activity' ? t('処理・管理', 'Activity & tools') : t('字幕パネル', 'Transcript panel')}
          >
            <header className="companion-heading">
              <h2
                ref={panelTitle}
                tabIndex={-1}
              >
                {presentedPanel === 'phrase' ? t('意味とフレーズ', 'Meaning and phrases') : presentedPanel === 'activity' ? t('処理・管理', 'Activity & tools') : t('字幕', 'Transcript')}
              </h2>
              {panel !== null && <IconButton
                label={t('パネルを閉じる', 'Close panel')}
                disabled={busy || saveBusy}
                onClick={() => void closePanel()}
              >
                <X size={19} />
              </IconButton>}
            </header>
            <div className="study-companion-body" ref={companionContents}>
      <div className="study-auxiliary" hidden={panel !== 'activity'}>
      {emptyRangeIssues.length > 0 && <AnimatedDetails className="notice warning">
        <summary><AnimatedValue value={t(`字幕がない要確認区間 (${emptyRangeIssues.length})`, `Passages without subtitles to check (${emptyRangeIssues.length})`)} /></summary>
        <p>{t('発話なしと判定された区間などです。再生して確認できます。学習はそのまま続けられます。', 'These include passages detected as having no speech. Play them to check; you can continue studying.')}</p>
        {emptyRangeIssues.map(issue => <div key={issue.id}>
          <Button variant="ghost" disabled={!playerReady || busy || saveBusy} onClick={() => void run(async () => { await playerApi.player({ action: 'seek', value: issue.startMs }); await playerApi.player({ action: 'play' }); })}>
            <Play size={15} />{timestamp(issue.startMs)}–{timestamp(issue.endMs)}
          </Button>
          <span>{issue.kind === 'no_speech' ? t('発話なしの判定を確認', 'Check the no-speech result') : t('音声・区切りを確認', 'Check the audio or boundary')}</span>
          {issue.alternatives.map((alternative, index) => <p key={index}>{timestamp(alternative.startMs)}–{timestamp(alternative.endMs)} {alternative.text}</p>)}
        </div>)}
      </AnimatedDetails>}
      {(continuationsQuery.data || []).filter(item => item.mediaId === mediaId && item.kind !== 'transcribe').map(item => <div className="notice" key={item.id}>
        <span>{t('途中のAI依頼があります。', 'You have an unfinished AI request.')}</span>
        <Button disabled={busy || saveBusy || !segmentsQuery.isSuccess} onClick={() => resumeAi(item)}>{t('続きから再開', 'Continue your request')}</Button>
        <Button variant="ghost" disabled={busy || saveBusy} onClick={() => void report(async () => { await continuationApi.discard(item.id); await continuationsQuery.refetch(); })}>{t('依頼の入力を破棄', 'Discard request input')}</Button>
      </div>)}
      <MotionRegion mode="status" open={!!aiRebind}><p className="notice" role="status">{t('字幕を選ぶと、入力した依頼とモデルを保持して再開します。', 'Select a subtitle to continue with your saved request and model choices.')}</p></MotionRegion>
      <StudyRegion open={dirtyDrafts.length > 0} className="study-motion-inline"><section className="study-phrase-drafts" aria-label={t('入力途中のフレーズ', 'Unfinished phrases')}>
        {dirtyDrafts.map(([key, draft]) => <div className="study-phrase-draft" key={key}>
          <Button variant="ghost" disabled={busy || saveBusy} onClick={() => void resumeDraft(draft)}>
            <span className="study-draft-label">{draft.value.term || draft.inspection.source.text}</span>
            <span className="study-draft-time">{timestamp(draft.inspection.source.startMs)}</span>
          </Button>
          {draft.invalidated && <span>{t('出典を要確認', 'Source changed')}</span>}
          <IconButton label={t('この入力を破棄', 'Discard this draft')} disabled={busy || saveBusy} onClick={() => discardDraft(key)}>
            <Trash2 size={16} />
          </IconButton>
        </div>)}
      </section></StudyRegion>
      <StudyRegion open={true} className="study-motion-inline">
        <div className="study-secondary-tools" id="study-management">
          <div>
            <Button aria-describedby="study-export-description" onClick={() => setTransfer(true)}>{t('字幕・学習データを書き出す', 'Export subtitles and learning data')}</Button>
            <p id="study-export-description">{t('この教材の字幕、または全教材の学習データを書き出します。バックアップの復元もできます。', 'Export subtitles for this media or learning data from all media. You can also restore a backup.')}</p>
          </div>
          <div>
            <Button variant="ghost" aria-describedby="study-remove-description" onClick={() => setRemoving(true)}>
              {t('ライブラリから除外', 'Remove from library')}
            </Button>
            <p id="study-remove-description">{t('元のファイルと保存したフレーズは残ります。', 'Your original file and saved phrases are kept.')}</p>
          </div>
        </div></StudyRegion>
      {jobs.length > 0 &&
        <AnimatedDetails open={true} className={`study-jobs ${needsAttention ? 'needs-attention' : ''}`}>
          <summary>
            <AnimatedValue value={needsAttention
              ? t('確認が必要な処理があります', 'Some tasks need attention')
              : t(`${jobs.length} 件の処理`, `${jobs.length} tasks`)} />
            <ChevronDown size={15} />
          </summary>
          <div>{jobs.map(job => <div
            className={`job-status ${job.status === 'failed' || job.status === 'unknown' ? 'warning' : ''}`}
            key={job.id}
          >
            <ProgressStatus label={job.kind} phase={job.message} status={job.status === 'queued' ? 'waiting' : job.status} completed={job.progress} total={1} />
            {panel === 'activity' ? <AiRuntime job={job} compact /> : <JobOutcome job={job} />}
            {job.resultState === 'applied_with_warnings' && <span>{t('完了・注意箇所あり', 'Complete · marked passages')}</span>}
            <JobActions
              job={job}
              onReviewTranscript={setDraftReview}
            />
          </div>)}</div>
        </AnimatedDetails>}
      {completedJobs.length > 0 && <AnimatedDetails className="study-jobs" onToggle={event => setJobHistoryOpen(event.currentTarget.open)}><summary>{t('処理履歴', 'Job history')} (<AnimatedValue value={completedJobs.length} />)</summary><div>{completedJobs.map(job => <div className="job-status" key={job.id}><span>{job.resultState === 'applied_with_warnings' ? t('完了・注意箇所あり', 'Complete · marked passages') : job.message || job.kind}</span>{panel === 'activity' && jobHistoryOpen ? <AiRuntime job={job} compact /> : <JobOutcome job={job} />}<JobActions job={job} onReviewTranscript={setDraftReview} /></div>)}</div></AnimatedDetails>}
      <MotionRegion mode="status" open={media.status === 'missing' || media.status === 'error'}>
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
        </div></MotionRegion>
      </div>

            <StudyRegion className="study-transcript" open={panel === 'transcript'} retain={!panel && companion.visible && presentedPanel === 'transcript'} animate={!companion.moving} keepMounted freezeOnExit={false}>
              <StudyTranscript
                active={panel === 'transcript'}
                transcriptionWorkspace={<TranscriptionWorkspace media={media} request={transcriptionRequest} onRequest={openTranscription} continuations={continuationsQuery.data} onResume={resumeAi} active={panel === 'transcript' && tab === 'transcription'} onOpenEarlierDrafts={() => setTab('draft')} onDone={() => { setTranscriptionRequest(undefined); void continuationsQuery.refetch(); }} onStarted={() => { setTranscriptionRequest(undefined); setTab('transcript'); void continuationsQuery.refetch(); }} />}
                onTranscribeRange={openTranscription}
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
                onRetryTranscript={() => void segmentsQuery.refetch()}
                onRetryCandidates={() => void candidatesQuery.refetch()}
                onInspect={(...args) => void inspect(...args)}
                onPlayFrom={source => void playSource(source, 'continue')}
                onReplay={source => void playSource(source, 'range')}
                onEdit={setEdit}
                onImport={() => { setSubtitleStreamIndex(undefined); setSubtitleSource('choose'); }}
                onEstimate={openAi}
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
            </StudyRegion>
            <StudyRegion open={panel === 'phrase'} retain={!panel && companion.visible && presentedPanel === 'phrase'} animate={!companion.moving}>
            {panel === 'phrase' && <div className="phrase-inspector">
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
                    <p className="context-sentence">{selected.text}</p>
                    {inspection?.term && <p className="inspected-term">{inspection.term}</p>}
                    {hasMeaning && <Button
                      variant="ghost"
                      aria-expanded={showMeaning}
                      onClick={() => setShowMeaning(value => !value)}
                    >
                      {showMeaning ? t('意味を閉じる', 'Hide meaning') : t('意味を見る', 'Show meaning')}
                    </Button>}
                    <StudyRegion open={showMeaning} className="study-motion-inline">
                      <div className="context-meaning">
                        {matchingCandidate?.meaning && <p>{matchingCandidate.meaning}</p>}
                        {selected.translation && <p className="context-translation">{selected.translation}</p>}
                        {matchingCandidate?.explanation && <p>{matchingCandidate.explanation}</p>}
                        {!selected.translation && !matchingCandidate?.meaning &&
                          <p>{t(
                            '訳や解説はまだありません。意味を入力して保存するか、AIへの依頼を見積もれます。',
                            'No meaning or explanation yet. Enter a meaning to save, or request an AI estimate.'
                          )}</p>}
                      </div>
                    </StudyRegion>
                  </>}
                <div className="context-actions">
                  <Button
                    disabled={!selected || !playerReady || busy || saveBusy}
                    onClick={() => selected && void playSource(selected, 'range')}
                    title={t('この区間だけ再生', 'Play only this passage')}
                  >
                    <Play size={16} />
                    {t('この区間を再生', 'Play this passage')}
                  </Button>
                  {selected && <span className="context-time">{timestamp(selected.startMs)}–{timestamp(selected.endMs)}</span>}
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
                        onClick={() => openAi('vocabulary')}
                      >
                        <Sparkles size={16} />
                        {t('意味を調べる', 'Explain this phrase')}
                      </Button>
                      {!selected.translation &&
                        <Button
                          variant="ghost"
                          disabled={busy || saveBusy}
                          onClick={() => openAi('translate')}
                        >
                          {t('翻訳する', 'Translate')}
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
                    {!subtitleUsable(selected) &&
                      <p className="notice warning">{t(
                        '未確認の字幕です。編集画面で内容を確認すると保存できます。',
                        'Confirm this subtitle in the editor before saving a phrase.'
                      )}</p>}
                  </>}
                <Button
                  className="phrase-save-toggle"
                  variant={showSave ? 'secondary' : 'primary'}
                  aria-expanded={showSave}
                  aria-controls="phrase-save-form"
                  disabled={!selected || !subtitleUsable(selected) || busy || saveBusy}
                  onClick={() => showSave ? setShowSave(false) : inspection && prepareForm({ ...inspection, candidate: matchingCandidate })}
                >
                  <BookmarkPlus size={17} />
                  {t('フレーズを保存', 'Save phrase')}
                </Button>
                <MotionRegion id="phrase-save-form" open={!!(showSave && inspection && formDraft && formKey)} keepMounted>
                  {inspection && formDraft && formKey && <SaveCardForm
                    key={formKey}
                    segment={formDraft.inspection.source}
                    candidate={matchingCandidate}
                    initialTerm={inspection?.term || ''}
                    value={formDraft.value}
                    onChange={value => setPhraseDrafts(current => ({
                      ...current,
                      [formKey]: { ...formDraft, value },
                    }))}
                    sourceInvalid={selectionInvalid || formDraft.invalidated}
                    sourceCues={(JSON.parse(formDraft.inspection.fingerprint) as (SubtitleSegment | null)[]).filter((cue): cue is SubtitleSegment => !!cue)}
                    onDraftSaved={() => void draftsQuery.refetch()}
                    onSourceRebound={cues => {
                      const source: SelectedContext = { ...cues[0], sourceCueIds: cues.map(cue => cue.id), endMs: Math.max(...cues.map(cue => cue.endMs)), text: cues.map(cue => cue.text).join('\n') };
                      const next = { ...formDraft.inspection, source, candidate: undefined, fingerprint: sourceFingerprint(cues, cues.map(cue => cue.id)), mediaSignature };
                      setInspection(next); setInvalidated(false);
                      setPhraseDrafts(current => { const result = { ...current }; delete result[formKey]; result[phraseKey(source)] = { ...formDraft, inspection: next, invalidated: false }; return result; });
                    }}
                    onDiscard={() => discardDraft(formKey)}
                    onBusyChange={setSaveBusy}
                    onClose={() => setShowSave(false)}
                    onSaved={() => {
                      discardDraft(formKey);
                      setShowSave(false);
                      setSaved(true);
                    }}
                  />}
                </MotionRegion>
                <div className="phrase-saved-slot">
                {saved &&
                  <p
                    className="phrase-saved"
                    role="status"
                  >
                    <AnimatedCheck size={16} />
                    {t('フレーズ帳に保存しました', 'Saved to your phrases')}
                  </p>}
                </div>
                <Button
                  className="return-to-watching"
                  disabled={!playerReady || busy || saveBusy}
                  onClick={() => void closePanel(true, fromTranscript ? 'transcript' : null)}
                >
                  <Play size={17} />
                  {t('元の位置から再生を再開', 'Resume from original position')}
                </Button>
              </div>}
            </StudyRegion>
            </div>
          </aside>
        </div>
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
          initialStreamIndex={subtitleStreamIndex}
          onTranscribe={() => { setSubtitleSource(undefined); openAi('transcribe'); }}
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
        onRetranscribe={range => { setEdit(undefined); openTranscription(range); }}
        onClose={() => setEdit(undefined)}
      />}
      {aiKind &&
        <AiDialog
          media={media}
          initialKind={aiKind}
          initialRange={selected}
          initialTerm={inspection?.term || selected?.text}
          continuation={aiContinuation}
          sourceContext={inspection ? { sourceCueIds: ids, sourceRevision: inspection.fingerprint } : undefined}
          sourceInvalid={aiSourceInvalid}
          onReselectSource={item => {
            rememberTrigger();
            setAiRebind(item); setAiKind(undefined); setInspection(undefined); setInvalidated(false);
            setMeaningRequest(undefined); setShowMeaning(false); setShowSave(false);
            setPanel('transcript'); setTab('transcript');
          }}
          onApproved={(kind, term) => {
            if (kind === 'vocabulary' && selected && formKey) {
              const requestedTerm = term || selected.text;
              setInspection(current => current && { ...current, term: requestedTerm });
              setMeaningRequest({ key: formKey, term: requestedTerm });
            }
          }}
          onClose={() => { setAiKind(undefined); void continuationsQuery.refetch(); void candidatesQuery.refetch(); }}
        />}
      {transfer && <TransferDialog
        mediaId={mediaId}
        onClose={() => setTransfer(false)}
      />}
    </div>
  );
}
