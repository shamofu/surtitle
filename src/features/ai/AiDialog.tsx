// SPDX-License-Identifier: GPL-3.0-or-later
import { QuoteApproval } from './QuoteApproval';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { continuationApi, type AiContinuation } from './continuations';

import {
  ArrowRight,
  Languages,
  Mic2,
  Sparkles,
} from 'lucide-react';
import { aiApi } from './api';
import { nativeAvailable } from '../../shared/native/transport';
import type { AiModelPreference } from '../../shared/contracts/ai';
import type { AiPurpose } from '../../shared/contracts/ai';
import type { AiQuote } from '../../shared/contracts/ai';
import type { Media } from '../../shared/contracts/media';
import type { TranscriptionPreparation } from '../../shared/contracts/ai';
import {
  useDataActions,
  useAppearance,
  useSnapshot,
  useNotifications,
} from '../../app/runtime';
import { parseTimestamp, timestamp } from '../../shared/format';
import { Button, Field, Modal, useModalExit } from '../../shared/ui/index';
import { AnimatedDetails } from '../../shared/ui/AnimatedDetails';
import { ModelEditor, emptyModel } from './ModelEditor';
import { useActivities } from '../../app/providers/Activities';
import { ProgressStatus } from '../../shared/ui/ProgressStatus';
import { useTranscriptionRequest } from './useTranscriptionRequest';
import { PreparationProgress } from './PreparationProgress';
import { AnimatedValue, MotionRegion } from '../../shared/motion';
import { SelectionIndicator } from '../../shared/motion/SelectionIndicator';

export function AiDialog({
  media,
  initialRange,
  initialKind = 'transcribe',
  initialTerm,
  continuation,
  sourceContext,
  sourceInvalid = false,
  onReselectSource,
  onApproved,
  onClose,
}: {
  media: Media;
  initialRange?: { startMs: number; endMs: number };
  initialKind?: AiQuote['kind'];
  initialTerm?: string;
  continuation?: AiContinuation;
  sourceContext?: { sourceCueIds: string[]; sourceRevision: string };
  sourceInvalid?: boolean;
  onReselectSource?: (continuation: AiContinuation) => void;
  onApproved?: (kind: AiQuote['kind'], focusTerm: string) => void;
  onClose: () => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { data } = useSnapshot();
  const { report } = useNotifications();
  const { runTracked } = useActivities();
  const navigate = useNavigate();
  const exit = useModalExit();
  const [continuationId] = useState(() => continuation?.id || crypto.randomUUID());
  const [kind, setKind] = useState<AiQuote['kind']>(continuation?.kind || initialKind);
  const [wholeMedia, setWholeMedia] = useState(continuation?.wholeMedia ?? true);
  const [focusTerm, setFocusTerm] = useState(continuation?.focusTerm ?? initialTerm ?? '');
  const [models, setModels] = useState<
    Partial<Record<AiPurpose, AiModelPreference>>
  >(continuation?.models || {});
  const mediaSignature = JSON.stringify([media.path, media.audioStreamIndex, media.learningLanguage, media.explanationLanguage]);
  const currentSignature = useRef(mediaSignature);
  currentSignature.current = mediaSignature;
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [boundMediaSignature, setBoundMediaSignature] = useState(continuation ? continuation.sourceMediaSignature : mediaSignature);
  const mediaChanged = boundMediaSignature !== mediaSignature;
  const continuationMediaChanged = !!continuation && continuation.sourceMediaSignature !== mediaSignature;
  const purpose: AiPurpose =
    kind === 'transcribe'
      ? 'transcription'
      : kind === 'translate'
        ? 'translation'
        : focusTerm.trim()
          ? 'explanation'
          : 'vocabulary';
  const selectedModel =
    models[purpose] ||
    data?.settings.aiModels?.[purpose] ||
    emptyModel(purpose);
  const invalidSource = (sourceInvalid || mediaChanged) && kind !== 'transcribe';
  const modelValid =
    !!selectedModel.modelId.trim() &&
    Number.isInteger(selectedModel.maxOutputTokens) &&
    selectedModel.maxOutputTokens > 0;

  const [start, setStart] = useState(
    continuation?.start ?? timestamp(initialRange?.startMs || 0, true),
  );
  const [end, setEnd] = useState(
    continuation?.end ?? timestamp(initialRange?.endMs ?? media.durationMs, true),
  );
  const [quote, setQuote] = useState<AiQuote | null>(null);
  const [quoteKey, setQuoteKey] = useState('');
  const lastAttempt = useRef('');
  const [busy, setBusy] = useState(false);
  const [busyPhase, setBusyPhase] = useState('estimating');
  const [restored, setRestored] = useState(false);
  const [preparation, setPreparation] =
    useState<Awaited<ReturnType<typeof aiApi.prepareTranscription>>>();
  const [preparations, setPreparations] = useState<TranscriptionPreparation[]>(
    [],
  );
  useEffect(() => {
    if (mediaChanged) { setQuote(null); setPreparation(undefined); setPreparations([]); }
  }, [mediaSignature, mediaChanged]);
  const startMs = kind === 'transcribe' && wholeMedia ? 0 : parseTimestamp(start),
    endMs = kind === 'transcribe' && wholeMedia ? media.durationMs : parseTimestamp(end);
  const transcriptionRequest = useTranscriptionRequest({ mediaId: media.id, sourceSignature: mediaSignature, startMs: startMs ?? 0, endMs: endMs ?? 0, wholeMedia }, selectedModel, media.title);
  const revision = transcriptionRequest.revision;
  const currentRevision = useRef(revision);
  currentRevision.current = revision;
  const initialRevision = useRef(revision);
  const [boundRevision, setBoundRevision] = useState(revision);
  useEffect(() => {
    if (revision === boundRevision) return;
    setBoundRevision(revision); setQuote(null); setPreparation(undefined); setPreparations([]);
    setBusy(false); pending.current = false; setRestored(true);
  }, [revision, boundRevision]);
  useEffect(() => {
    if (kind !== 'transcribe' || mediaChanged || !nativeAvailable()) return;
    let active = true;
    void report(() => aiApi.transcriptionPreparations(media.id)).then(items => {
      if (active && items) {
        setPreparations(continuationMediaChanged ? [] : items);
        if (revision === initialRevision.current && !continuationMediaChanged && continuation?.preparationId) setPreparation(items.find(item => item.id === continuation.preparationId));
      }
    });
    return () => { active = false; };
  }, [kind, media.id, mediaSignature, mediaChanged, continuationMediaChanged, report, revision]);
  const preparing = kind === 'transcribe' && (transcriptionRequest.phase === 'preparing' || transcriptionRequest.session?.status === 'running');
  const valid =
    startMs !== null &&
    endMs !== null &&
    endMs > startMs &&
    (kind !== 'transcribe' || media.durationMs > 0) &&
    (!media.durationMs || endMs <= media.durationMs);
  useEffect(() => {
    if (transcriptionRequest.session?.result && kind === 'transcribe') setPreparation(transcriptionRequest.session.result);
  }, [transcriptionRequest.session?.result, kind]);
  const requestKey = JSON.stringify([revision, kind, startMs, endMs, wholeMedia, focusTerm.trim(), selectedModel, data?.settings.vertexLocation]);
  const inputKey = JSON.stringify([mediaSignature, requestKey]);
  const currentRequestKey = useRef(requestKey); currentRequestKey.current = requestKey;
  const currentInputKey = useRef(inputKey);
  currentInputKey.current = inputKey;
  const estimateAction = useRef(() => {});
  const configured = !!data?.settings.credentialConfigured && !!data?.settings.vertexProject;
  useEffect(() => {
    if (quoteKey !== inputKey) setQuote(null);
    if (!valid || !modelValid || invalidSource || !configured || busy || preparing || lastAttempt.current === inputKey) return;
    const timer = window.setTimeout(() => { lastAttempt.current = inputKey; estimateAction.current(); }, 350);
    return () => window.clearTimeout(timer);
  }, [inputKey, quoteKey, valid, modelValid, invalidSource, configured, busy, preparing]);
  async function estimate() {
    if (!valid || !modelValid || invalidSource || pending.current || busy || preparing || exit.exiting || !data?.settings.credentialConfigured)
      return;
    pending.current = true; setBusy(true); setBusyPhase('estimating'); setRestored(false); setQuote(null);
    try {
      if (kind === 'transcribe') {
        setBoundMediaSignature(mediaSignature);
        const reusePreparation = !mediaChanged && preparation && preparation.startMs === startMs && preparation.endMs === endMs && !!preparation.wholeMedia === wholeMedia ? preparation : undefined;
        const result = await report(() => transcriptionRequest.estimate({
          fresh: true,
          reusePreparation,
          beforePrepare: async () => {
            await report(() => saveContinuation());
            if (!reusePreparation && currentRevision.current === revision) setPreparation(undefined);
          },
          onPrepared: ({ preparation: prepared, sourceSignature }) => {
            if (reusePreparation) return;
            setBoundMediaSignature(sourceSignature);
            setPreparation(prepared);
            setPreparations(items => [prepared, ...items.filter(item => item.id !== prepared.id)]);
          },
          persistQuote: ({ quote: result, preparation: prepared, sourceSignature }) => report(() => saveContinuation(result.id, prepared.id, sourceSignature)),
        }));
        if (result && mounted.current && currentRevision.current === revision && currentRequestKey.current === requestKey) {
          const acceptedKey = JSON.stringify([result.sourceSignature, requestKey]);
          lastAttempt.current = acceptedKey; setQuote(result.quote); setQuoteKey(acceptedKey);
        }
        return;
      }
      await report(() => saveContinuation());
      if (currentRevision.current !== revision) return;
      const preparedSignature = currentSignature.current;
      if (!mounted.current || preparedSignature !== mediaSignature || currentRevision.current !== revision) return;
      const result = await report(() => runTracked({ kind: 'estimate', label: media.title, phase: 'estimating', mediaId: media.id },
        () => mutate(() => aiApi.createQuote({ mediaId: media.id, kind, startMs, endMs,
          focusTerm: kind === 'vocabulary' ? focusTerm.trim() || undefined : undefined, model: selectedModel }), { kind: 'snapshot' })));
      if (result && currentSignature.current === preparedSignature && currentRevision.current === revision) {
        await report(() => saveContinuation(result.id, undefined, preparedSignature));
        if (mounted.current && currentRevision.current === revision && currentRequestKey.current === requestKey) { const acceptedKey = JSON.stringify([preparedSignature, requestKey]); lastAttempt.current = acceptedKey; setQuote(result); setQuoteKey(acceptedKey); }
      }
    } finally {
      if (currentRevision.current === revision) { pending.current = false; if (mounted.current) setBusy(false); }
    }
  }
  estimateAction.current = () => { void estimate(); };
  async function approve() {
    if (!quote || quoteKey !== inputKey || invalidSource || busy || exit.exiting || revision !== boundRevision) return;
    setBusy(true); setBusyPhase('starting');
    const result = await report(
      async () => {
        await mutate(() => quote.isRetry ? aiApi.reapproveQuote(quote) : aiApi.approveQuote(quote), { kind: 'snapshot' });
        return true;
      },
      t('処理を開始しました。', 'Job started.'),
    );
    if (result) { transcriptionRequest.forgetEstimate(); onApproved?.(kind, focusTerm.trim()); await report(() => continuationApi.discard(continuationId)); await exit.close(onClose); }
    setBusy(false);
  }
  function saveContinuation(quoteId = quote?.id, preparationId = preparation?.id, sourceSignature = mediaSignature) {
    return continuationApi.save({ id: continuationId, mediaId: media.id, kind, start, end, wholeMedia, focusTerm, models, preparationId, quoteId,
      sourceCueIds: sourceContext?.sourceCueIds ?? continuation?.sourceCueIds,
      sourceRevision: sourceContext?.sourceRevision ?? continuation?.sourceRevision,
      sourceMediaSignature: kind === 'transcribe' ? sourceSignature : boundMediaSignature });
  }
  async function openSettings() {
    if (busy || preparing || exit.exiting) return;
    setBusy(true); setBusyPhase('setup');
    const saved = await report(() => saveContinuation());
    setBusy(false);
    if (saved) await report(() => exit.close(async () => { onClose(); await navigate({ to: '/settings', search: { resume: saved.id } }); }));
  }
  useEffect(() => {
    if (!continuation?.quoteId || continuationMediaChanged || !nativeAvailable() || revision !== initialRevision.current) return;
    let active = true;
    lastAttempt.current = inputKey;
    void report(() => runTracked({ kind: 'estimate', label: media.title, phase: 'estimating', mediaId: media.id }, () => aiApi.reviewAiJob(continuation.quoteId!))).then(result => { if (active && result && currentInputKey.current === inputKey) { setQuote(result); setQuoteKey(inputKey); } });
    return () => { active = false; };
  }, [continuation?.quoteId, continuationMediaChanged, report, runTracked, revision]);
  async function reselectSource() {
    if (busy || preparing || exit.exiting || !onReselectSource) return;
    setBusy(true); setBusyPhase('setup');
    const saved = await report(() => saveContinuation());
    setBusy(false);
    if (saved) await exit.close(() => onReselectSource(saved));
  }
  return (
    <Modal
      {...exit.modalProps}
      closeDisabled={busy || preparing || exit.exiting}
      title={t('AIで学習を補助', 'AI assistance')}
      onClose={() => {
        if (!busy && !preparing) void exit.close(onClose);
      }}
    >
      <MotionRegion mode="status" open={restored}><p className="notice" role="status">{t('データを復元しました。対象を確認してから見積もりを準備してください。', 'Data was restored. Check the source and prepare a new estimate.')}</p></MotionRegion>
      <MotionRegion mode="status" open={kind === 'transcribe' && mediaChanged}><div className="notice warning" role="alert">
        <p>{t('教材か言語設定が変わったため、以前の音声準備と見積もりを使わず、現在の対象で準備し直します。', 'The material or language settings changed. A new estimate will use the current source shown below.')}</p>
        <p>{media.title} · {media.path} · {t('音声トラック', 'Audio track')}: {media.audioStreamIndex ?? t('既定', 'Default')} · {media.learningLanguage} → {media.explanationLanguage}</p>
      </div></MotionRegion>
      <MotionRegion mode="status" open={invalidSource}><div className="notice warning" role="alert">
        <p>{t('出典の字幕が変わったか見つかりません。入力は保持しています。字幕を選び直してから見積もりを確認してください。', 'The source subtitles changed or are missing. Your input is kept. Select the subtitles again before reviewing an estimate.')}</p>
        {onReselectSource && <Button disabled={busy || preparing} onClick={() => void reselectSource()}>{t('字幕を選び直す', 'Select subtitles again')}</Button>}
      </div></MotionRegion>
      <>
          <div className="ai-kind-list">
            {[
              {
                id: 'transcribe' as const,
                icon: Mic2,
                title: t('文字起こし', 'Transcribe'),
                detail: t('音声から字幕をつくる', 'Turn speech into subtitles'),
              },
              {
                id: 'translate' as const,
                icon: Languages,
                title: t('翻訳', 'Translate'),
                detail: t('字幕の意味をつかむ', 'Understand the subtitles'),
              },
              {
                id: 'vocabulary' as const,
                icon: Sparkles,
                title: t('語彙・イディオム', 'Words & idioms'),
                detail: t(
                  '覚えたい表現を見つける',
                  'Discover useful expressions',
                ),
              },
            ].map((item) => (
              <button
                className={kind === item.id ? 'selected' : ''}
                key={item.id}
                disabled={preparing || busy}
                onClick={() => setKind(item.id)}
                aria-pressed={kind === item.id}
              >
                <item.icon size={22} />
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </button>
            ))}
          </div>
          <MotionRegion mode="status" open={!data?.settings.credentialConfigured || !modelValid || !data?.settings.vertexProject}><div className="notice warning">
            <p>{t('AIを使うための設定が必要です。入力と対象範囲を残して設定へ進めます。', 'Finish AI setup. Your input and selected scope will be kept.')}</p>
            <Button disabled={busy || preparing} onClick={() => void openSettings()}>{t('設定してこの操作に戻る', 'Set up and return here')}</Button>
          </div></MotionRegion>
          <MotionRegion open={kind === 'vocabulary'} keepMounted>
            <Field
              label={t(
                '解説してほしい表現（任意）',
                'A specific phrase to explain (optional)',
              )}
              hint={t(
                '対象字幕にある表現を指定できます。空欄なら AI が語彙・イディオムを提案します。',
                'Enter a phrase from the selected subtitles, or leave blank for vocabulary suggestions.',
              )}
            >
              <input
                value={focusTerm}
                disabled={busy || preparing}
                onChange={(event) => setFocusTerm(event.target.value)}
                placeholder={t(
                  '字幕で選んだ単語やフレーズ',
                  'A word or phrase from your subtitles',
                )}
              />
            </Field>
          </MotionRegion>
          <MotionRegion open={kind === 'vocabulary'}>
            <p className="notice">
              {t(
                '語彙・解説は試験機能です。語義や文中の意味を確認してから保存してください。',
                'Vocabulary and explanations are experimental. Check the meaning in context before saving.',
              )}
            </p>
          </MotionRegion>
          <MotionRegion open={kind === 'transcribe'}>
            <p className="helper-text">
              {t(
                '全編の字幕は完成後に自動表示します。気になる箇所には印を付け、あとから原音を聴いて修正できます。',
                'Full-video subtitles appear automatically when finished. Marked passages can be corrected later while listening.',
              )}
            </p>
          </MotionRegion>
          <div className="scope-heading">
            <h3>{t('対象', 'Scope')}</h3>
          </div>
          <MotionRegion open={kind === 'transcribe'}><div className="segmented-control" role="group" aria-label={t('文字起こしの対象', 'Transcription scope')}>
            <SelectionIndicator variant="pill" />
            <button disabled={busy || preparing} aria-pressed={wholeMedia} className={wholeMedia ? 'selected' : ''} onClick={() => { setWholeMedia(true); setPreparation(undefined); }}>{t('全編を文字起こし', 'Transcribe the whole video')}</button>
            <button disabled={busy || preparing} aria-pressed={!wholeMedia} className={!wholeMedia ? 'selected' : ''} onClick={() => { setWholeMedia(false); setPreparation(undefined); }}>{t('範囲を指定', 'Choose a range')}</button>
          </div></MotionRegion>
          <MotionRegion open={kind === 'transcribe' && wholeMedia}><p className="notice">{media.durationMs > 0
            ? t(`全編 ${timestamp(media.durationMs, true)} を一括で処理します。`, `Process the entire ${timestamp(media.durationMs, true)} video in one job.`)
            : t('動画の長さを確認しています。確認後に見積もれます。', 'Waiting for the video duration before estimating.')}</p></MotionRegion>
          <MotionRegion open={kind !== 'transcribe' || !wholeMedia} keepMounted><div className="field-row">
            <Field label={t('開始', 'From')} hint="hh:mm:ss">
              <input
                value={start}
                disabled={preparing || busy}
                onChange={(event) => {
                  setStart(event.target.value);
                  setPreparation(undefined);
                }}
                inputMode="decimal"
              />
            </Field>
            <span className="range-arrow">
              <ArrowRight size={18} />
            </span>
            <Field label={t('終了', 'To')} hint="hh:mm:ss">
              <input
                value={end}
                disabled={preparing || busy}
                onChange={(event) => {
                  setEnd(event.target.value);
                  setPreparation(undefined);
                }}
                inputMode="decimal"
              />
            </Field>
          </div></MotionRegion>
          <MotionRegion mode="status" open={!valid && !(kind === 'transcribe' && wholeMedia && !media.durationMs)}>
            <p className="field-error">
              {t(
                '動画内の有効な開始・終了時刻を入力してください。',
                'Enter a valid start and end time within the media.',
              )}
            </p>
          </MotionRegion>
          <MotionRegion open={kind === 'transcribe' && !wholeMedia && preparations.length > 0} keepMounted>
            <Field
              label={t(
                '保存済みの音声準備を使う',
                'Use previously prepared audio',
              )}
              hint={t(
                '同じ音声を再生成せずに見積もれます。',
                'Estimate from immutable prepared audio without generating it again.',
              )}
            >
              <select
                value={preparation?.id || ''}
                disabled={preparing || busy}
                onChange={(event) => {
                  const item = preparations.find(
                    (value) => value.id === event.target.value,
                  );
                  setPreparation(item);
                  if (item) {
                    setStart(timestamp(item.startMs, true));
                    setEnd(timestamp(item.endMs, true));
                  }
                }}
              >
                <option value="">
                  {t('選択してください', 'Choose a preparation')}
                </option>
                {preparations
                  .filter((item) => !item.repairParentJobId)
                  .map((item) => (
                    <option value={item.id} key={item.id}>
                      {timestamp(item.startMs, true)} –{' '}
                      {timestamp(item.endMs, true)} · {item.chunkCount}{' '}
                      {t('区間', 'chunks')}
                    </option>
                  ))}
              </select>
            </Field>
          </MotionRegion>
          <MotionRegion open={kind === 'transcribe'}>
            <div className="local-preparation">
              <p className="notice warning">
                {t(
                  '音声を準備し、この画面に料金を表示します。開始を押すと送信します。',
                  'Audio preparation and the estimate appear here. Press Start to send this scope.',
                )}
              </p>
              <MotionRegion mode="status" open={!!preparation}>{preparation && (
                <p className="notice">
                  <AnimatedValue value={t(
                    `${preparation.chunkCount} 個の音声区間を準備しました（送信予定音声 ${timestamp(preparation.sendDurationMs)}）。クラウドには送信していません。`,
                    `Prepared ${preparation.chunkCount} audio chunks (${timestamp(preparation.sendDurationMs)} of audio). Nothing was sent to the cloud.`,
                  )} />
                </p>
              )}</MotionRegion>
              <MotionRegion mode="status" open={preparing}>
                <div className="job-status">
                  <PreparationProgress operationId={transcriptionRequest.session?.operationId} label={media.title} />
                  <Button
                    disabled={!transcriptionRequest.session?.operationId}
                    onClick={() =>
                      void report(() =>
                        mutate(() => aiApi.cancelPreparation(transcriptionRequest.session?.operationId), { kind: 'snapshot' }),
                      )
                    }
                  >
                    {t('キャンセル', 'Cancel')}
                  </Button>
                </div>
              </MotionRegion>
            </div>
          </MotionRegion>
          <AnimatedDetails className="ai-model-settings" open={!modelValid}>
            <summary>{modelValid ? `${t('使用するモデル', 'Model')}: ${selectedModel.modelId}` : t('モデルを選ぶ', 'Choose a model')}</summary>
            <ModelEditor
              purpose={purpose}
              value={selectedModel}
              location={data?.settings.vertexLocation || 'global'}
              disabled={busy || preparing}
              onChange={(model) =>
                setModels((current) => ({ ...current, [purpose]: model }))
              }
            />
          </AnimatedDetails>
          <MotionRegion mode="status" open={!data?.settings.credentialConfigured && !preparing}>
            <p className="helper-text">
              {t(
                'AI を使うにはサービスアカウントの設定が必要です。',
                'Set up your service account to use AI.',
              )}{' '}
              <Button onClick={() => void openSettings()}>{t('設定を開く', 'Open settings')} →</Button>
            </p>
          </MotionRegion>
          {quote && quoteKey === inputKey && <QuoteApproval
            quote={invalidSource ? { ...quote, canApprove: false, blockedReason: t('字幕を選び直してください。', 'Select the subtitles again.') } : quote}
            busy={busy}
            onApprove={() => void approve()}
            onRefresh={invalidSource ? undefined : () => void estimate()}
          />}
          {!quote && !busy && !preparing && configured && valid && modelValid && !invalidSource && lastAttempt.current === inputKey && <Button onClick={() => void estimate()}>{t('見積もりを再試行', 'Retry estimate')}</Button>}
      </>
      <MotionRegion mode="status" open={busy && !preparing}><ProgressStatus label={media.title} phase={busyPhase} status="running" /></MotionRegion>
    </Modal>
  );
}
