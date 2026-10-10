// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Mic2, RefreshCw } from 'lucide-react';
import { useAppearance, useDataActions, useNotifications, useSnapshot } from '../../../app/runtime';
import type { AiModelPreference, AiQuote, JobSummary, TranscriptionPreparation } from '../../../shared/contracts/ai';
import type { Media, MediaStream } from '../../../shared/contracts/media';
import type { TranscriptReview } from '../../../shared/contracts/transcript';
import { parseTimestamp, timestamp } from '../../../shared/format';
import { Button, Field } from '../../../shared/ui';
import { aiApi } from '../../ai/api';
import { continuationApi, type AiContinuation } from '../../ai/continuations';
import { ModelEditor, emptyModel } from '../../ai/ModelEditor';
import { QuoteApproval } from '../../ai/QuoteApproval';
import { JobActions } from '../../ai/JobActions';
import { currentTranscriptionJob, JobProcessingDetails, JobStatusMessage } from '../../ai/JobStatus';
import { studyApi } from '../api';
import { libraryApi } from '../../library/api';
import { useActivities } from '../../../app/providers/Activities';
import { ProgressStatus } from '../../../shared/ui/ProgressStatus';
import { preparedSourceMatches, usePreparationSession } from '../../ai/PreparationSessions';
import { PreparationProgress } from '../../ai/PreparationProgress';
import './transcription-workspace.css';

export type TranscriptionRequest = { id: string; range?: { startMs: number; endMs: number }; continuation?: AiContinuation };

function TranscriptionSetup({ media, request, onDone, onStarted }: { media: Media; request: TranscriptionRequest; onDone: () => void; onStarted?: () => void }) {
  const { t } = useAppearance();
  const { data } = useSnapshot();
  const { report } = useNotifications();
  const { mutate } = useDataActions();
  const { runTracked } = useActivities();
  const navigate = useNavigate();
  const continuation = request.continuation;
  const [modelOverride, setModel] = useState<AiModelPreference | undefined>(continuation?.models.transcription);
  const model = modelOverride ?? data?.settings.aiModels?.transcription ?? emptyModel('transcription');
  const [whole, setWhole] = useState(continuation?.wholeMedia ?? !request.range);
  const [start, setStart] = useState(continuation?.start ?? timestamp(request.range?.startMs ?? 0, true));
  const [end, setEnd] = useState(continuation?.end ?? timestamp(request.range?.endMs ?? media.durationMs, true));
  const [quote, setQuote] = useState<AiQuote>();
  const [preparation, setPreparation] = useState<TranscriptionPreparation>();
  const [phase, setPhase] = useState<'preparing' | 'estimating' | 'starting' | 'setup'>();
  const [problem, setProblem] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [audioStreams, setAudioStreams] = useState<MediaStream[]>([]);
  const [automaticAttempted, setAutomaticAttempted] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const signature = JSON.stringify([media.path, media.audioStreamIndex, media.learningLanguage, media.explanationLanguage]);
  const selectedAudioIndex = audioStreams.findIndex(stream => stream.index === media.audioStreamIndex);
  const selectedAudio = audioStreams[selectedAudioIndex];
  const audioLabel = selectedAudio
    ? [t(`音声トラック ${selectedAudioIndex + 1}`, `Audio track ${selectedAudioIndex + 1}`), selectedAudio.language, selectedAudio.title].filter(Boolean).join(' · ')
    : media.audioStreamIndex != null ? t(`音声ストリーム #${media.audioStreamIndex}`, `Audio stream #${media.audioStreamIndex}`) : t('音声を自動選択', 'Automatic audio selection');
  const currentSignature = useRef(signature);
  currentSignature.current = signature;
  const [boundSignature, setBoundSignature] = useState(signature);
  const from = whole ? 0 : parseTimestamp(start);
  const to = whole ? media.durationMs : parseTimestamp(end);
  const valid = from !== null && to !== null && from >= 0 && to > from && to <= media.durationMs;
  const preparationSession = usePreparationSession({ mediaId: media.id, sourceSignature: signature, startMs: from ?? 0, endMs: to ?? 0, wholeMedia: whole });
  const preparedAudio = preparationSession.session?.result ?? preparation;
  const preparationOperationId = preparationSession.session?.operationId;
  useEffect(() => {
    let active = true;
    setAudioStreams([]);
    // Preparation already owns any required tool installation. Loading labels here
    // avoids racing a second standalone install when the workspace first opens.
    if (preparedAudio) void libraryApi.mediaStreams(media.id, preparationOperationId).then(streams => { if (active) setAudioStreams(streams.filter(stream => stream.kind === 'audio')); }).catch(() => {});
    return () => { active = false; };
  }, [media.id, signature, preparedAudio?.id, preparationOperationId]);
  const revision = preparationSession.revision;
  const currentRevision = useRef(revision);
  currentRevision.current = revision;
  const [boundRevision, setBoundRevision] = useState(revision);
  const configured = !!data?.settings.credentialConfigured && !!data.settings.vertexProject && !!model.modelId.trim() && model.maxOutputTokens > 0;
  const busy = !!phase;
  useEffect(() => {
    if (revision === boundRevision) return;
    setBoundRevision(revision); setQuote(undefined); setPreparation(undefined); setPhase(undefined);
    pending.current = false; setAutomaticAttempted(true);
    setProblem(t('データを復元しました。対象を確認してから見積もりを準備してください。', 'Data was restored. Check the source and prepare a new estimate.'));
  }, [revision, boundRevision, t]);
  useEffect(() => {
    if (signature !== boundSignature) {
      setQuote(undefined); setPreparation(undefined); setAutomaticAttempted(false); setBoundSignature(signature);
    }
  }, [signature, boundSignature]);
  function savedRequest(quoteId = quote?.id, preparationId = preparation?.id, sourceSignature = signature): AiContinuation {
    return { id: continuation?.id ?? request.id, mediaId: media.id, kind: 'transcribe', start, end, wholeMedia: whole,
      focusTerm: '', models: { transcription: model }, quoteId, preparationId, sourceMediaSignature: sourceSignature };
  }
  async function estimate(fresh = false) {
    if (pending.current || !configured || !valid) return;
    pending.current = true; setPhase('preparing'); setProblem(''); setQuote(undefined);
    try {
      await report(() => continuationApi.save({ ...savedRequest(), quoteId: undefined, preparationId: undefined }));
      if (currentRevision.current !== revision) return;
      const prepared = preparation?.startMs === from && preparation.endMs === to && preparation.wholeMedia === whole
        ? preparation : await preparationSession.prepare(operationId => mutate(() => aiApi.prepareTranscription(media.id, from, to, whole, operationId), { kind: 'snapshot' }));
      const preparedSignature = currentSignature.current;
      if (!mounted.current || !preparedSourceMatches(signature, preparedSignature, prepared) || currentRevision.current !== revision) return;
      setBoundSignature(preparedSignature); setAutomaticAttempted(true); setPreparation(prepared); setPhase('estimating');
      const result = await preparationSession.estimate(model, () => runTracked({ kind: 'estimate', label: media.title, phase: 'estimating', mediaId: media.id },
        () => mutate(() => aiApi.createTranscriptionQuote(prepared.id, model), { kind: 'snapshot' })), fresh);
      if (currentSignature.current !== preparedSignature || currentRevision.current !== revision) return;
      await continuationApi.save(savedRequest(result.id, prepared.id, preparedSignature));
      if (mounted.current && currentRevision.current === revision) setQuote(result);
    } catch (error) { if (mounted.current && currentRevision.current === revision) setProblem(error instanceof Error ? error.message : String(error)); }
    finally { if (currentRevision.current === revision) { pending.current = false; if (mounted.current) setPhase(undefined); } }
  }
  useEffect(() => {
    if (revision !== boundRevision || automaticAttempted || !configured || !valid || busy || pending.current) return;
    setAutomaticAttempted(true);
    if (continuation?.quoteId && continuation.sourceMediaSignature === signature) {
      setPhase('estimating'); pending.current = true;
      void runTracked({ kind: 'estimate', label: media.title, phase: 'estimating', mediaId: media.id }, () => aiApi.reviewAiJob(continuation.quoteId!)).then(result => { if (mounted.current && currentSignature.current === signature && currentRevision.current === revision) setQuote(result); })
        .catch(error => { if (mounted.current && currentRevision.current === revision) setProblem(String(error)); })
        .finally(() => { if (currentRevision.current === revision) { pending.current = false; if (mounted.current) setPhase(undefined); } });
    } else void estimate();
  }, [automaticAttempted, configured, valid, busy, signature, revision, boundRevision]);
  async function startJob() {
    if (!quote || pending.current || revision !== boundRevision) return;
    pending.current = true; setPhase('starting'); setProblem('');
    const result = await report(async () => {
      await mutate(() => quote.isRetry ? aiApi.reapproveQuote(quote) : aiApi.approveQuote(quote), { kind: 'snapshot' });
      return true;
    });
    if (result) {
      preparationSession.forgetEstimate();
      await report(() => continuationApi.discard(continuation?.id ?? request.id));
      if (mounted.current) (onStarted ?? onDone)();
    }
    pending.current = false; if (mounted.current) setPhase(undefined);
  }
  async function setup() {
    if (pending.current) return;
    pending.current = true; setPhase('setup');
    const saved = await report(() => continuationApi.save(savedRequest()));
    pending.current = false; if (mounted.current) setPhase(undefined);
    if (saved) void navigate({ to: '/settings', search: { resume: saved.id } });
  }
  function changeScope(action: () => void) { action(); setQuote(undefined); setPreparation(undefined); }
  return <section className="transcription-setup" aria-label={t('文字起こしの設定', 'Transcription setup')}>
    <p className="transcription-source"><strong>{media.title}</strong><br />{media.path.split(/[\\/]/).pop()} · {audioLabel}</p>
    {!quote && <><p>{t('Transcribeの本文を使い、届いた部分から字幕を表示します。気になる箇所はあとから修正できます。', 'Use Transcribe text as subtitles as each part arrives. You can correct any passage later.')}</p>
    <p className="transcription-scope"><strong>{whole ? t('全編', 'Full media') : t('選択した区間', 'Selected range')}</strong> · {timestamp(from ?? 0)}–{timestamp(to ?? 0)} · {media.learningLanguage}</p></>}
    {!configured && <div className="notice"><p>{t('最初に文字起こし用のモデルと認証を設定してください。戻るとこの範囲から続けられます。', 'Set up a transcription model and credentials. This scope will be kept when you return.')}</p><Button onClick={() => void setup()} busy={phase === 'setup'}>{t('設定して戻る', 'Set up and return')}</Button></div>}
    <details open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
      <summary>{t('範囲・モデルを変更', 'Change range or model')}</summary>
      <label className="check-field"><input type="checkbox" checked={whole} disabled={busy} onChange={event => changeScope(() => setWhole(event.target.checked))} />{t('全編を文字起こし', 'Transcribe the whole media')}</label>
      {!whole && <div className="field-row"><Field label={t('開始', 'From')}><input value={start} disabled={busy} onChange={event => changeScope(() => setStart(event.target.value))} /></Field><Field label={t('終了', 'To')}><input value={end} disabled={busy} onChange={event => changeScope(() => setEnd(event.target.value))} /></Field></div>}
      <ModelEditor purpose="transcription" value={model} location={data?.settings.vertexLocation || 'global'} disabled={busy} onChange={value => { setModel(value); setQuote(undefined); }} />
      <Button disabled={busy || !configured || !valid} onClick={() => void estimate(true)}>{t('見積もりを更新', 'Update estimate')}</Button>
    </details>
    {!valid && <p role="status">{media.durationMs ? t('作品内の開始・終了時刻を指定してください。', 'Choose a valid range within the media.') : t('作品の長さを確認しています…', 'Checking media duration…')}</p>}
    {phase === 'preparing' ? <PreparationProgress operationId={preparationSession.session?.operationId} label={media.title} /> : busy && <ProgressStatus label={media.title} phase={phase} status="running" />}
    {problem && <p className="notice warning" role="alert">{problem}</p>}
    {quote && <QuoteApproval quote={quote} busy={busy} transcription onApprove={() => void startJob()} />}
    {!quote && !busy && configured && valid && automaticAttempted && <Button onClick={() => void estimate()}><RefreshCw size={14} />{t('見積もりを準備', 'Prepare estimate')}</Button>}
    {phase === 'preparing' ? <Button variant="ghost" disabled={!preparationSession.session?.operationId} onClick={() => void report(() => aiApi.cancelPreparation(preparationSession.session?.operationId))}>{t('準備を中止', 'Cancel preparation')}</Button> : <Button variant="ghost" disabled={busy} onClick={onDone}>{t('閉じる', 'Close')}</Button>}
  </section>;
}

function TranscriptHistory({ jobId }: { jobId: string }) {
  const { t } = useAppearance();
  const { mutate } = useDataActions();
  const [view, setView] = useState<TranscriptReview>();
  const [problem, setProblem] = useState('');
  const [applying, setApplying] = useState(false);
  useEffect(() => { let active = true; void studyApi.transcriptReview(jobId).then(result => { if (active) setView(result); }).catch(error => { if (active) setProblem(String(error)); }); return () => { active = false; }; }, [jobId]);
  async function useSavedResults() {
    if (!view || applying) return;
    setApplying(true); setProblem('');
    try {
      setView(await mutate(() => studyApi.applyTranscriptReview(jobId, view.draft.digest), { kind: 'media', mediaId: view.mediaId }));
    } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
    finally { setApplying(false); }
  }
  return <div className="transcription-history-result">
    {problem && <p role="alert">{problem}</p>}
    {!view && !problem && <p role="status">{t('保存した結果を読み込み中…', 'Loading saved results…')}</p>}
    {view && <><p>{t('文字起こし時の記録です。現在の字幕は一覧から編集できます。', 'This is the original transcription record. Edit current subtitles in the list.')}</p>
      {!view.applied && view.canApply && <Button busy={applying} onClick={() => void useSavedResults()}>{t('保存済みの結果を使う', 'Use saved results')}</Button>}
      {view.draft.conflicts.length > 0 && <details><summary>{t('保存された境界の候補', 'Saved boundary alternatives')}</summary>
        <p>{t('候補を使う場合は、字幕一覧の該当行を編集して選べます。', 'To use an alternative, open the corresponding subtitle row for editing.')}</p>
        {view.draft.conflicts.map(conflict => <div key={conflict.id}>
          <p>{timestamp(conflict.startMs)}–{timestamp(conflict.endMs)}</p>
          {[conflict.leftAlternative, conflict.rightAlternative].map((cues, index) => <blockquote key={index}>
            {cues.map((cue, cueIndex) => <p key={cueIndex}><small>{timestamp(cue.startMs)}–{timestamp(cue.endMs)}</small> {cue.text}</p>)}
          </blockquote>)}
        </div>)}
      </details>}
      {view.draft.chunks.map(chunk => <details key={chunk.ordinal}><summary>{timestamp(chunk.coreStartMs)}–{timestamp(chunk.coreEndMs)} · {chunk.status === 'pending' ? t('未取得', 'Not received') : t('受信済み', 'Received')}</summary>
        {chunk.segments.map((cue, index) => <p key={index}>{cue.text}</p>)}
        <StoredResponse jobId={jobId} ordinal={chunk.ordinal} />
      </details>)}</>}
  </div>;
}
function StoredResponse({ jobId, ordinal }: { jobId: string; ordinal: number }) {
  const { t } = useAppearance();
  const { report } = useNotifications();
  const [evidence, setEvidence] = useState<string>();
  return <>{evidence === undefined ? <Button variant="ghost" onClick={() => void report(() => studyApi.transcriptResultDetail(jobId, ordinal)).then(result => { if (result) setEvidence(JSON.stringify(result.evidence?.response ?? result, null, 2)); })}>{t('元の応答を表示', 'Show original response')}</Button> : <pre>{evidence}</pre>}</>;
}

function TranscriptionProgress({ job, compact = false }: { job: JobSummary; compact?: boolean }) {
  const { t } = useAppearance();
  const progress = Number.isFinite(job.progress) ? Math.min(1, Math.max(0, job.progress)) : 0;
  return <span className={`progress-status${compact ? ' compact' : ''}`} data-status={job.status === 'queued' ? 'waiting' : job.status} aria-busy={job.status === 'running'}>
    <span className="progress-status-copy">
      {!compact && <strong>{t('文字起こしの進捗', 'Transcription progress')}</strong>}
      <span><JobStatusMessage job={job} /></span>
      {compact && <span className="progress-status-count">{Math.floor(progress * 100)}%</span>}
    </span>
    {job.status === 'running' && <progress aria-label={t('文字起こしの進捗', 'Transcription progress')} value={progress} max={1} />}
    {!compact && <span className="progress-status-count">{Math.floor(progress * 100)}%</span>}
  </span>;
}

function TranscriptionJob({ job, focused, active, history, onReview, onRequest }: {
  job: JobSummary; focused: boolean; active: boolean; history: boolean;
  onReview: (jobId: string) => void; onRequest: (range: { startMs: number; endMs: number }) => void;
}) {
  const { t } = useAppearance();
  const target = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!focused || !active) return;
    if (details.current) details.current.open = true;
    target.current?.focus({ preventScroll: true });
    target.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused, active]);
  return <div className="transcription-job" data-job-id={job.id} ref={target} tabIndex={-1}>
    <TranscriptionProgress job={job} />
    {!!job.transcriptionRanges?.length && <div className="transcription-ranges" aria-label={t('区間ごとの状態', 'Transcription ranges')}>{job.transcriptionRanges.map((range, index) => <span key={index} className={`range-${range.state}`} title={`${timestamp(range.startMs)}–${timestamp(range.endMs)} · ${range.state}`} />)}</div>}
    {(job.issue || job.retry || (job.status === 'running' && job.pacing)) && <details ref={details}>
      <summary>{t('処理の詳細', 'Processing details')}</summary>
      <JobProcessingDetails job={job} />
    </details>}
    <JobActions job={job} inlineTranscription onReviewTranscript={onReview} />
    {job.transcriptionRanges?.filter(range => range.state === 'failed').map((range, index) => <Button key={index} onClick={() => onRequest(range)}>{t('この区間を再文字起こし', 'Transcribe this range again')} · {timestamp(range.startMs)}–{timestamp(range.endMs)}</Button>)}
    {history && <TranscriptHistory jobId={job.id} />}
  </div>;
}

export function TranscriptionWorkspace({ media, request, onRequest, onDone, onStarted, onOpenEarlierDrafts, continuations = [], onResume, focusJobId, active = true }: {
  media: Media; request?: TranscriptionRequest; onRequest: (range?: { startMs: number; endMs: number }) => void; onDone: () => void;
  onStarted?: () => void;
  onOpenEarlierDrafts?: () => void; continuations?: AiContinuation[]; onResume?: (continuation: AiContinuation) => void;
  focusJobId?: string; active?: boolean;
}) {
  const { t } = useAppearance();
  const { data } = useSnapshot();
  const [history, setHistory] = useState<string>();
  const jobs = (data?.jobs ?? []).filter(job => job.mediaId === media.id && (job.kind === 'transcribe' || job.automaticTranscript));
  const current = jobs.filter(job => !['completed', 'cancelled'].includes(job.status));
  const completed = jobs.filter(job => ['completed', 'cancelled'].includes(job.status));
  const showJob = (job: JobSummary) => <TranscriptionJob key={job.id} job={job} focused={focusJobId === job.id} active={active}
    history={history === job.id} onReview={id => setHistory(value => value === id ? undefined : id)} onRequest={onRequest} />;
  return <section className="transcription-workspace" aria-label={t('文字起こし', 'Transcription')}>
    <div className="transcription-heading"><h3><Mic2 size={17} />{t('文字起こし', 'Transcription')}</h3>{!request && !current.length && <Button variant="ghost" onClick={() => onRequest()}>{media.segmentCount ? t('文字起こしを作り直す', 'Transcribe again') : t('字幕を作成', 'Create subtitles')}</Button>}</div>
    {!request && !jobs.length && <p className="transcription-intro">{t('音声から字幕を作成できます。範囲と見積もりを確認してから開始します。', 'Create subtitles from the audio. Review the range and estimate before starting.')}</p>}
    {request && <TranscriptionSetup key={request.id} media={media} request={request} onDone={onDone} onStarted={onStarted} />}
    {!request && continuations.filter(item => item.kind === 'transcribe' && item.mediaId === media.id && (!item.quoteId || !jobs.some(job => job.id === item.quoteId))).map(item => <Button key={item.id} onClick={() => onResume?.(item)}>{t('途中の文字起こしを続ける', 'Continue transcription setup')}</Button>)}
    {current.filter(job => !request || job.id === focusJobId).map(showJob)}
    {(completed.length > 0 || onOpenEarlierDrafts) && <details><summary>{t('文字起こしの履歴', 'Transcription history')}{completed.length > 0 ? ` (${completed.length})` : ''}</summary>{completed.map(showJob)}
      {onOpenEarlierDrafts && <Button variant="ghost" onClick={onOpenEarlierDrafts}>{t('以前の下書きを開く', 'Open earlier drafts')}</Button>}
    </details>}
  </section>;
}

export function TranscriptionStatus({ mediaId, hasRequest, onOpen }: { mediaId: string; hasRequest: boolean; onOpen: (jobId?: string) => void }) {
  const { data } = useSnapshot();
  const { t } = useAppearance();
  const jobs = (data?.jobs ?? []).filter(job => job.mediaId === mediaId && (job.kind === 'transcribe' || job.automaticTranscript));
  const current = currentTranscriptionJob(jobs);
  if (!current && !hasRequest) return null;
  return <button type="button" className="transcription-status" onClick={() => onOpen(current?.id)}>
    {current ? <TranscriptionProgress job={current} compact /> : <span>{t('文字起こしの設定を続ける', 'Continue transcription setup')}</span>}
    <span className="transcription-status-action">{t('詳細を開く', 'View details')}</span>
  </button>;
}
