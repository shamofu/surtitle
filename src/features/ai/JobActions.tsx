// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as m from 'motion/react-m';
import { Check, FileCheck2, Pause, RotateCw, Square } from 'lucide-react';
import { aiApi } from './api';
import type { AiQuote } from '../../shared/contracts/ai';
import type { JobSummary } from '../../shared/contracts/ai';
import type { SavedAiResult } from '../../shared/contracts/ai';
import {
  useDataActions,
  useAppearance,
  useNotifications,
  useSnapshot,
} from '../../app/runtime';
import { Button, Modal, useModalExit } from '../../shared/ui/index';
import { AnimatedValue, MotionRegion, MotionSwap, motionDurations, motionEase, useAppMotion } from '../../shared/motion';
import { QuoteApproval } from './QuoteApproval';
import { timestamp } from '../../shared/format';
import { UnknownAttempt } from '../settings/PausedJobs';

export function JobActions({
  job,
  onReviewTranscript,
  inlineTranscription = false,
}: {
  job: JobSummary;
  onReviewTranscript?: (jobId: string) => void;
  inlineTranscription?: boolean;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const { data } = useSnapshot();
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<AiQuote>();
  const [saved, setSaved] = useState<SavedAiResult[]>();
  const savedExit = useModalExit(!!saved);
  const quoteExit = useModalExit(!!quote);
  const exiting = savedExit.exiting || quoteExit.exiting;
  function closeQuote() {
    void quoteExit.close(() => setQuote(undefined));
  }
  async function perform(action: () => Promise<void>) {
    if (busy || exiting) return;
    setBusy(true);
    await report(action);
    setBusy(false);
  }
  async function estimateRetry() {
    if (busy || exiting) return;
    setBusy(true);
    const result = await report(() =>
      mutate(() => aiApi.createRetryQuote(job.id), { kind: 'snapshot' }),
    );
    if (result) setQuote(result);
    setBusy(false);
  }
  async function openQuote() {
    if (busy || exiting) return;
    setBusy(true);
    const result = await report(() => mutate(() => aiApi.reviewAiJob(job.id), { kind: 'snapshot' }));
    if (result) setQuote(result);
    setBusy(false);
  }
  async function approve() {
    if (!quote || busy || exiting) return;
    setBusy(true);
    const success = await report(async () => {
      await mutate(() => quote.isRetry ? aiApi.reapproveQuote(quote) : aiApi.approveQuote(quote), { kind: 'snapshot' });
      return true;
    });
    setBusy(false);
    if (success) closeQuote();
  }
  async function openSaved() {
    if (busy || exiting) return;
    setBusy(true);
    const results = await report(() => aiApi.savedAiResults(job.id));
    if (results) setSaved(results);
    setBusy(false);
  }
  async function applySaved(result: SavedAiResult) {
    if (busy || exiting) return;
    setBusy(true);
    const results = await report(
      async () => {
        await mutate(
          () => aiApi.applySavedAiResult(result.jobId, result.ordinal),
          { kind: 'media', mediaId: job.mediaId || '' },
        );
        return aiApi.savedAiResults(job.id);
      },
      t('保存済み翻訳を適用しました。', 'Applied the saved translation.'),
    );
    if (results) setSaved(results);
    setBusy(false);
  }
  return (
    <>
      <MotionSwap className="job-actions-motion" stateKey={`${job.status}:${job.issue?.nextAction ?? ''}:${!!(job.hasTranscriptResult ?? job.transcriptReview)}:${!!job.pendingResults}:${job.progress < 1}:${job.retry?.state ?? ''}:${job.resultState ?? ''}`}><div className="inline-actions job-actions" inert={exiting}>
        {job.issue?.nextAction === 'retry_local' && <Button busy={busy} onClick={() => void perform(() => mutate(() => aiApi.retryAiApplication(job.id), { kind: 'snapshot' }))}>{t('保存結果の反映を再試行', 'Retry applying saved results')}</Button>}
        {job.status === 'queued' && <Button busy={busy} onClick={() => void openQuote()}>{t('見積もりを開く', 'Open estimate')}</Button>}
        {(job.hasTranscriptResult ?? job.transcriptReview) && onReviewTranscript && (
          <Button
            data-testid="transcript-review-open"
            data-job-id={job.id}
            disabled={busy}
            onClick={() => onReviewTranscript?.(job.id)}
          >
            <FileCheck2 size={13} />
            {inlineTranscription || job.resultState === 'applied' || job.resultState === 'applied_with_warnings' ? t('字幕の記録を見る', 'View subtitle history') : t('文字起こしを確認', 'Review transcription')}
          </Button>
        )}
        {(job.pendingResults || 0) > 0 && (
          <Button disabled={busy} onClick={() => void openSaved()}>
            <FileCheck2 size={13} />
            {t('保存済み翻訳を確認', 'Review saved translations')}
          </Button>
        )}
        {job.status === 'running' && (
          <Button
            disabled={busy}
            onClick={() =>
              void perform(() =>
                mutate(() => aiApi.pauseAiJob(job.id), { kind: 'snapshot' }),
              )
            }
          >
            <Pause size={13} />
            {job.retry?.state === 'waiting' ? t('自動再試行を一時停止', 'Pause automatic retry') : t('次の送信前に一時停止', 'Pause before next request')}
          </Button>
        )}
        {['running', 'queued', 'paused'].includes(job.status) && (
          <Button
            disabled={busy}
            onClick={() =>
              void perform(() =>
                mutate(() => aiApi.cancelAiJob(job.id), { kind: 'snapshot' }),
              )
            }
          >
            <Square size={12} />
            {t('中止', 'Cancel')}
          </Button>
        )}
        {['paused', 'failed', 'unknown'].includes(job.status) && job.progress < 1 && (
          <Button busy={busy} onClick={() => void estimateRetry()}>
            <RotateCw size={13} />
            {inlineTranscription ? t('残りを再開', 'Resume remaining work') : t('残りを再見積もり', 'Estimate remaining work')}
          </Button>
        )}
      </div></MotionSwap>
      {saved && (
        <Modal
          {...savedExit.modalProps}
          title={t('保存済み翻訳を確認', 'Review saved translations')}
          closeDisabled={busy || exiting}
          eyebrow="SAVED ON THIS DEVICE"
          onClose={() => {
            if (!busy) void savedExit.close(() => setSaved(undefined));
          }}
        >
          <p className="notice">
            {t(
              '受信済みの結果を教材へ適用します。API送信も追加課金も行いません。すでに適用した結果は、後の手動編集を上書きしません。',
              'Apply received results to your subtitles without sending an API request or adding a charge. Applying a result again preserves later manual edits.',
            )}
          </p>
          <MotionSwap stateKey={saved.map(result => result.ordinal).join('|') || 'empty'}>{saved.map((result) => (
            <section className="saved-ai-result" key={result.ordinal}>
              <div className="saved-translations">
                {result.translations.map((translation, index) => (
                  <div className="saved-translation" key={index}>
                    <small>
                      <AnimatedValue value={`${timestamp(translation.startMs)} – ${timestamp(translation.endMs)}`} />
                    </small>
                    <p>{translation.source}</p>
                    <p>{translation.translation}</p>
                  </div>
                ))}
              </div>
              <MotionRegion open={!!result.blockedReason}><MotionSwap stateKey={result.blockedReason ?? ''}>
                <p className="notice warning" role="status">
                  {result.blockedReason}
                </p>
              </MotionSwap></MotionRegion>
              <Button
                variant={result.applied ? 'secondary' : 'primary'}
                disabled={busy || !result.canApply}
                onClick={() => void applySaved(result)}
              >
                <MotionSwap as="span" stateKey={result.applied ? 'applied' : 'pending'}>{result.applied ? (
                  <>
                    <Check size={14} />
                    {t('適用済み', 'Applied')}
                  </>
                ) : (
                  t('この翻訳を適用', 'Apply this translation')
                )}</MotionSwap>
              </Button>
            </section>
          ))}</MotionSwap>
        </Modal>
      )}
      {quote && (
        <JobQuoteSurface
          modalProps={quoteExit.modalProps}
          inline={inlineTranscription}
          busy={busy || quoteExit.exiting}
          title={quote.isRetry ? t('残りの処理を確認', 'Review remaining work') : t('実行の見積もり', 'Job estimate')}
          onClose={() => {
            if (!busy) closeQuote();
          }}
        >
          <MotionRegion open={!!quote.isRetry}><p className="notice">
            {t(
              '未完了の処理だけを新しく承認します。結果不明の送信は、利用額の確認を済ませるまで再実行できません。',
              'This new approval covers unfinished work only. Unknown attempts must be accounted for before retrying.',
            )}
          </p></MotionRegion>
          <MotionSwap stateKey={(data?.budget.unknownAttempts || []).map(attempt => attempt.id).join('|')}>{(data?.budget.unknownAttempts || []).map(attempt => <div key={attempt.id}>
            {attempt.jobId !== job.id && <p>{t('別の処理の結果確認が必要です。', 'Another job has an unknown outcome to acknowledge.')}</p>}
            <UnknownAttempt attempt={attempt} onResolved={() => void openQuote()} />
          </div>)}</MotionSwap>
          <Button variant="ghost" busy={busy} disabled={quoteExit.exiting} onClick={() => void openQuote()}>{t('見積もりを更新', 'Refresh estimate')}</Button>
          <MotionSwap stateKey={quote.id}><QuoteApproval
            quote={quote}
            busy={busy || quoteExit.exiting}
            transcription={inlineTranscription}
            onApprove={() => void approve()}
          /></MotionSwap>
        </JobQuoteSurface>
      )}
    </>
  );
}

function JobQuoteSurface({ inline, title, onClose, children, busy, modalProps }: { inline: boolean; title: string; onClose: () => void; children: ReactNode; busy: boolean; modalProps: ReturnType<typeof useModalExit>['modalProps'] }) {
  const { t } = useAppearance();
  const { reducedMotion } = useAppMotion();
  const { open, onExited } = modalProps;
  const revision = useRef(0);
  useLayoutEffect(() => {
    const generation = ++revision.current;
    if (!inline || open) return;
    const finish = () => { if (generation === revision.current) onExited(); };
    if (reducedMotion) { finish(); return; }
    // Keep completion bounded even when WebView animation frames are suspended.
    const timer = window.setTimeout(finish, motionDurations.exit * 1000 + 100);
    return () => { ++revision.current; window.clearTimeout(timer); };
  }, [inline, open, reducedMotion, onExited]);
  return inline ? <m.section aria-label={title} data-state={open ? 'open' : 'closing'} inert={!open} aria-hidden={!open || undefined}
    initial={reducedMotion ? false : 'hidden'} animate={open ? 'shown' : 'hidden'}
    variants={{ shown: { opacity: 1, y: 0 }, hidden: { opacity: 0, y: reducedMotion ? 0 : 8 } }}
    transition={{ duration: reducedMotion ? 0 : open ? motionDurations.enter : motionDurations.exit, ease: motionEase }}
    onAnimationComplete={definition => { if (definition === 'hidden' && !open) onExited(); }}
    onClickCapture={event => { if (!open) { event.preventDefault(); event.stopPropagation(); } }}
    onKeyDownCapture={event => { if (!open) { event.preventDefault(); event.stopPropagation(); } }}
  ><h4>{title}</h4>{children}<Button variant="ghost" disabled={busy || !open} onClick={onClose}>{t('閉じる', 'Close')}</Button></m.section>
    : <Modal {...modalProps} title={title} eyebrow="A NEW QUOTE, A NEW DECISION" closeDisabled={busy} onClose={onClose}>{children}</Modal>;
}
