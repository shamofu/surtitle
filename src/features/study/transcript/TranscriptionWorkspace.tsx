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
import { studyApi } from '../api';
import { libraryApi } from '../../library/api';
import './transcription-workspace.css';

export type TranscriptionRequest = { id: string; range?: { startMs: number; endMs: number }; continuation?: AiContinuation };

function TranscriptionSetup({ media, request, onDone }: { media: Media; request: TranscriptionRequest; onDone: () => void }) {
  const { t } = useAppearance();
  const { data } = useSnapshot();
  const { report } = useNotifications();
  const { mutate } = useDataActions();
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
  useEffect(() => {
    let active = true;
    setAudioStreams([]);
    void libraryApi.mediaStreams(media.id).then(streams => { if (active) setAudioStreams(streams.filter(stream => stream.kind === 'audio')); }).catch(() => {});
    return () => { active = false; };
  }, [media.id, signature]);
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
  const configured = !!data?.settings.credentialConfigured && !!data.settings.vertexProject && !!model.modelId.trim() && model.maxOutputTokens > 0;
  const busy = !!phase;
  useEffect(() => {
    if (signature !== boundSignature) {
      setQuote(undefined); setPreparation(undefined); setAutomaticAttempted(false); setBoundSignature(signature);
    }
  }, [signature, boundSignature]);
  function savedRequest(quoteId = quote?.id, preparationId = preparation?.id): AiContinuation {
    return { id: continuation?.id ?? request.id, mediaId: media.id, kind: 'transcribe', start, end, wholeMedia: whole,
      focusTerm: '', models: { transcription: model }, quoteId, preparationId, sourceMediaSignature: signature };
  }
  async function estimate() {
    if (pending.current || !configured || !valid) return;
    pending.current = true; setPhase('preparing'); setProblem(''); setQuote(undefined);
    try {
      const prepared = preparation?.startMs === from && preparation.endMs === to && preparation.wholeMedia === whole
        ? preparation : await mutate(() => aiApi.prepareTranscription(media.id, from, to, whole), { kind: 'snapshot' });
      if (!mounted.current || currentSignature.current !== signature) return;
      setPreparation(prepared); setPhase('estimating');
      const result = await mutate(() => aiApi.createTranscriptionQuote(prepared.id, model), { kind: 'snapshot' });
      if (!mounted.current || currentSignature.current !== signature) return;
      setQuote(result);
      await continuationApi.save(savedRequest(result.id, prepared.id));
    } catch (error) { if (mounted.current) setProblem(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; if (mounted.current) setPhase(undefined); }
  }
  useEffect(() => {
    if (automaticAttempted || !configured || !valid || busy || pending.current) return;
    setAutomaticAttempted(true);
    if (continuation?.quoteId && continuation.sourceMediaSignature === signature) {
      setPhase('estimating'); pending.current = true;
      void aiApi.reviewAiJob(continuation.quoteId).then(result => { if (mounted.current && currentSignature.current === signature) setQuote(result); })
        .catch(error => { if (mounted.current) setProblem(String(error)); })
        .finally(() => { pending.current = false; if (mounted.current) setPhase(undefined); });
    } else void estimate();
  }, [automaticAttempted, configured, valid, busy, signature]);
  async function startJob() {
    if (!quote || pending.current) return;
    pending.current = true; setPhase('starting'); setProblem('');
    const result = await report(async () => {
      await mutate(() => quote.isRetry ? aiApi.reapproveQuote(quote) : aiApi.approveQuote(quote), { kind: 'snapshot' });
      return true;
    });
    if (result) {
      await report(() => continuationApi.discard(continuation?.id ?? request.id));
      if (mounted.current) onDone();
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
      <Button disabled={busy || !configured || !valid} onClick={() => void estimate()}>{t('見積もりを更新', 'Update estimate')}</Button>
    </details>
    {!valid && <p role="status">{media.durationMs ? t('作品内の開始・終了時刻を指定してください。', 'Choose a valid range within the media.') : t('作品の長さを確認しています…', 'Checking media duration…')}</p>}
    {busy && <p role="status" aria-live="polite">{phase === 'preparing' ? t('音声を準備しています…', 'Preparing audio…') : phase === 'estimating' ? t('料金を確認しています…', 'Preparing your estimate…') : phase === 'starting' ? t('文字起こしを開始しています…', 'Starting transcription…') : t('設定へ移動しています…', 'Opening settings…')}</p>}
    {problem && <p className="notice warning" role="alert">{problem}</p>}
    {quote && <QuoteApproval quote={quote} busy={busy} transcription onApprove={() => void startJob()} />}
    {!quote && !busy && configured && valid && automaticAttempted && <Button onClick={() => void estimate()}><RefreshCw size={14} />{t('見積もりを準備', 'Prepare estimate')}</Button>}
    {phase === 'preparing' ? <Button variant="ghost" onClick={() => void report(aiApi.cancelPreparation)}>{t('準備を中止', 'Cancel preparation')}</Button> : <Button variant="ghost" disabled={busy} onClick={onDone}>{t('閉じる', 'Close')}</Button>}
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

export function TranscriptionWorkspace({ media, request, onRequest, onDone, onOpenEarlierDrafts, continuations = [], onResume }: {
  media: Media; request?: TranscriptionRequest; onRequest: (range?: { startMs: number; endMs: number }) => void; onDone: () => void;
  onOpenEarlierDrafts?: () => void; continuations?: AiContinuation[]; onResume?: (continuation: AiContinuation) => void;
}) {
  const { t } = useAppearance();
  const { data } = useSnapshot();
  const [history, setHistory] = useState<string>();
  const jobs = (data?.jobs ?? []).filter(job => job.mediaId === media.id && (job.kind === 'transcribe' || job.automaticTranscript));
  const current = jobs.filter(job => !['completed', 'cancelled'].includes(job.status));
  const completed = jobs.filter(job => ['completed', 'cancelled'].includes(job.status));
  const showJob = (job: JobSummary) => <div className="transcription-job" key={job.id}>
    <p role="status">{job.message || (job.status === 'completed' ? t('字幕を表示しました', 'Subtitles are ready') : t('文字起こし中', 'Transcribing'))}</p>
    {job.status === 'running' && <progress aria-label={t('文字起こしの進捗', 'Transcription progress')} value={job.progress} max={1} />}
    {!!job.transcriptionRanges?.length && <div className="transcription-ranges" aria-label={t('区間ごとの状態', 'Transcription ranges')}>{job.transcriptionRanges.map((range, index) => <span key={index} className={`range-${range.state}`} title={`${timestamp(range.startMs)}–${timestamp(range.endMs)} · ${range.state}`} />)}</div>}
    <JobActions job={job} inlineTranscription onReviewTranscript={id => setHistory(value => value === id ? undefined : id)} />
    {job.transcriptionRanges?.filter(range => range.state === 'failed').map((range, index) => <Button key={index} onClick={() => onRequest(range)}>{t('この区間を再文字起こし', 'Transcribe this range again')} · {timestamp(range.startMs)}–{timestamp(range.endMs)}</Button>)}
    {history === job.id && <TranscriptHistory jobId={job.id} />}
  </div>;
  return <section className="transcription-workspace" aria-label={t('文字起こし', 'Transcription')}>
    <div className="transcription-heading"><h3><Mic2 size={17} />{t('文字起こし', 'Transcription')}</h3>{!request && !current.length && (media.segmentCount > 0 || jobs.length > 0) && <Button variant="ghost" onClick={() => onRequest()}>{media.segmentCount ? t('文字起こしを作り直す', 'Transcribe again') : t('字幕を作成', 'Create subtitles')}</Button>}</div>
    {request && <TranscriptionSetup key={request.id} media={media} request={request} onDone={onDone} />}
    {!request && continuations.filter(item => item.kind === 'transcribe' && item.mediaId === media.id && (!item.quoteId || !jobs.some(job => job.id === item.quoteId))).map(item => <Button key={item.id} onClick={() => onResume?.(item)}>{t('途中の文字起こしを続ける', 'Continue transcription setup')}</Button>)}
    {!request && current.map(showJob)}
    {(completed.length > 0 || onOpenEarlierDrafts) && <details><summary>{t('文字起こしの履歴', 'Transcription history')}{completed.length > 0 ? ` (${completed.length})` : ''}</summary>{completed.map(showJob)}
      {onOpenEarlierDrafts && <Button variant="ghost" onClick={onOpenEarlierDrafts}>{t('以前の下書きを開く', 'Open earlier drafts')}</Button>}
    </details>}
  </section>;
}
