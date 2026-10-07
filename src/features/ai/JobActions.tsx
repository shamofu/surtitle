// SPDX-License-Identifier: GPL-3.0-or-later
import { useState, type ReactNode } from 'react';
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
import { Button, Modal } from '../../shared/ui/index';
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
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    await report(action);
    setBusy(false);
  }
  async function estimateRetry() {
    setBusy(true);
    const result = await report(() =>
      mutate(() => aiApi.createRetryQuote(job.id), { kind: 'snapshot' }),
    );
    if (result) setQuote(result);
    setBusy(false);
  }
  async function openQuote() {
    setBusy(true);
    const result = await report(() => mutate(() => aiApi.reviewAiJob(job.id), { kind: 'snapshot' }));
    if (result) setQuote(result);
    setBusy(false);
  }
  async function approve() {
    if (!quote) return;
    setBusy(true);
    const success = await report(async () => {
      await mutate(() => quote.isRetry ? aiApi.reapproveQuote(quote) : aiApi.approveQuote(quote), { kind: 'snapshot' });
      return true;
    });
    setBusy(false);
    if (success) setQuote(undefined);
  }
  async function openSaved() {
    setBusy(true);
    const results = await report(() => aiApi.savedAiResults(job.id));
    if (results) setSaved(results);
    setBusy(false);
  }
  async function applySaved(result: SavedAiResult) {
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
      <div className="inline-actions job-actions">
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
            {t('次の送信前に一時停止', 'Pause before next request')}
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
      </div>
      {saved && (
        <Modal
          title={t('保存済み翻訳を確認', 'Review saved translations')}
          eyebrow="SAVED ON THIS DEVICE"
          onClose={() => {
            if (!busy) setSaved(undefined);
          }}
        >
          <p className="notice">
            {t(
              '受信済みの結果を教材へ適用します。API送信も追加課金も行いません。すでに適用した結果は、後の手動編集を上書きしません。',
              'Apply received results to your subtitles without sending an API request or adding a charge. Applying a result again preserves later manual edits.',
            )}
          </p>
          {saved.map((result) => (
            <section className="saved-ai-result" key={result.ordinal}>
              <div className="saved-translations">
                {result.translations.map((translation, index) => (
                  <div className="saved-translation" key={index}>
                    <small>
                      {timestamp(translation.startMs)} –{' '}
                      {timestamp(translation.endMs)}
                    </small>
                    <p>{translation.source}</p>
                    <p>{translation.translation}</p>
                  </div>
                ))}
              </div>
              {result.blockedReason && (
                <p className="notice warning" role="status">
                  {result.blockedReason}
                </p>
              )}
              <Button
                variant={result.applied ? 'secondary' : 'primary'}
                disabled={busy || !result.canApply}
                onClick={() => void applySaved(result)}
              >
                {result.applied ? (
                  <>
                    <Check size={14} />
                    {t('適用済み', 'Applied')}
                  </>
                ) : (
                  t('この翻訳を適用', 'Apply this translation')
                )}
              </Button>
            </section>
          ))}
        </Modal>
      )}
      {quote && (
        <JobQuoteSurface
          inline={inlineTranscription}
          title={quote.isRetry ? t('残りの処理を確認', 'Review remaining work') : t('実行の見積もり', 'Job estimate')}
          onClose={() => {
            if (!busy) setQuote(undefined);
          }}
        >
          {quote.isRetry && <p className="notice">
            {t(
              '未完了の処理だけを新しく承認します。結果不明の送信は、利用額の確認を済ませるまで再実行できません。',
              'This new approval covers unfinished work only. Unknown attempts must be accounted for before retrying.',
            )}
          </p>}
          {(data?.budget.unknownAttempts || []).map(attempt => <div key={attempt.id}>
            {attempt.jobId !== job.id && <p>{t('別の処理の結果確認が必要です。', 'Another job has an unknown outcome to acknowledge.')}</p>}
            <UnknownAttempt attempt={attempt} onResolved={() => void openQuote()} />
          </div>)}
          <Button variant="ghost" busy={busy} onClick={() => void openQuote()}>{t('見積もりを更新', 'Refresh estimate')}</Button>
          <QuoteApproval
            key={quote.id}
            quote={quote}
            busy={busy}
            transcription={inlineTranscription}
            onApprove={() => void approve()}
          />
        </JobQuoteSurface>
      )}
    </>
  );
}

function JobQuoteSurface({ inline, title, onClose, children }: { inline: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useAppearance();
  return inline ? <section aria-label={title}><h4>{title}</h4>{children}<Button variant="ghost" onClick={onClose}>{t('閉じる', 'Close')}</Button></section>
    : <Modal title={title} eyebrow="A NEW QUOTE, A NEW DECISION" onClose={onClose}>{children}</Modal>;
}
