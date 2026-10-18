// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useState } from 'react';

import { Play, CircleDollarSign } from 'lucide-react';

import type { AiQuote } from '../../shared/contracts/ai';

import { useAppearance } from '../../app/runtime';
import { money, quoteCanBeApproved, timestamp } from '../../shared/format';
import { Button } from '../../shared/ui/index';
import { AnimatedDetails } from '../../shared/ui/AnimatedDetails';
import { AnimatedValue, MotionRegion, MotionSwap } from '../../shared/motion';

export function QuoteApproval({
  quote,
  busy,
  onApprove,
  onRefresh,
}: {
  quote: AiQuote;
  busy: boolean;
  onApprove: () => void;
  onRefresh?: () => void;
  transcription?: boolean;
}) {
  const { t } = useAppearance();
  const transcription = quote.kind === 'transcribe';
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const expired = new Date(quote.expiresAt).getTime() <= now;
  const blockReasonId = useId();
  const approvalBlocked = !quote.canApprove || expired;
  const unpriced = quote.unpriced === true || quote.maximumUsd == null;
  const automaticRetries = (quote.retryPolicy?.maxRetries ?? 0) > 0;
  return (
    <div className="quote-review">
      <div className="quote-cost">
        <span>
          <CircleDollarSign size={18} />
          {t('この実行の見積もり', 'Estimate for this job')}
        </span>
        <strong>
          <AnimatedValue value={unpriced
            ? t('料金不明', 'Price unknown')
            : money(quote.estimatedUsd)} />
        </strong>
        <small>
          {unpriced ? (
            t('金額上限は保証できません', 'A dollar limit cannot be guaranteed')
          ) : (
            <>
              {t('今回の予約上限', 'Reservation for this run')}{' '}
              <b><AnimatedValue value={money(quote.maximumUsd)} /></b>
            </>
          )}
        </small>
      </div>
      <dl className="details-list">
        {quote.applyPolicy === 'auto' && !transcription && <div><dt>{t('完成後', 'After completion')}</dt><dd>{t('字幕を自動表示', 'Apply subtitles automatically')}</dd></div>}
        {quote.focusTerm && (
          <div>
            <dt>{t('解説する表現', 'Phrase to explain')}</dt>
            <dd>{quote.focusTerm}</dd>
          </div>
        )}
        <div>
          <dt>{t('対象区間', 'Selected range')}</dt>
          <dd>
            <AnimatedValue value={`${timestamp(quote.startMs, true)} — ${timestamp(quote.endMs, true)}`} />
          </dd>
        </div>
        <div>
          <dt>{t('モデル', 'Model')}</dt>
          <dd>
            {quote.model} · {quote.location || 'global'}
          </dd>
        </div>
      </dl>
      <AnimatedDetails>
        <summary>{t('料金・送信の詳細', 'Cost and request details')}</summary>
        <dl className="details-list">
        {transcription && quote.applyPolicy === 'auto' && <div><dt>{t('受信後', 'As results arrive')}</dt><dd>{t('字幕を自動表示', 'Apply subtitles automatically')}</dd></div>}
        <div>
          <dt>{automaticRetries ? t('処理区間数 / 同時送信', 'Audio ranges / concurrency') : t('要求数 / 同時送信', 'Requests / concurrency')}</dt>
          <dd><AnimatedValue value={`${quote.requestCount ?? 1} / 1`} /></dd>
        </div>
        {automaticRetries && <div>
          <dt>{t('再試行込みの最大送信回数', 'Maximum requests including retries')}</dt>
          <dd><AnimatedValue value={quote.maximumRequestCount ?? ''} /></dd>
        </div>}
        {(quote.sendDurationMs || 0) > 0 && (
          <div>
            <dt>{t('重複込みの送信音声', 'Audio including overlap')}</dt>
            <dd><AnimatedValue value={timestamp(quote.sendDurationMs || 0, true)} /></dd>
          </div>
        )}
        {automaticRetries && quote.maximumSendDurationMs != null && <div>
          <dt>{t('再試行込みの最大送信音声', 'Maximum audio including retries')}</dt>
          <dd><AnimatedValue value={timestamp(quote.maximumSendDurationMs, true)} /></dd>
        </div>}
        <div>
          <dt>{automaticRetries ? t('1要求 / 再試行前の出力上限', 'Output limit per request / before retries') : t('1要求 / 全要求の出力上限', 'Output limit per request / total')}</dt>
          <dd>
            <AnimatedValue value={`${quote.maxOutputTokens.toLocaleString()} / ${(quote.totalOutputTokens ?? quote.maxOutputTokens).toLocaleString()}`} />{' '}
            tokens
          </dd>
        </div>
        {automaticRetries && quote.maximumTotalOutputTokens != null && <div>
          <dt>{t('再試行込みの最大出力', 'Maximum output including retries')}</dt>
          <dd><AnimatedValue value={quote.maximumTotalOutputTokens.toLocaleString()} /> tokens</dd>
        </div>}
        {quote.pricingSource && (
          <div>
            <dt>{t('単価の出所', 'Price source')}</dt>
            <dd>
              {quote.pricingSource === 'user'
                ? t('利用者設定', 'User provided')
                : t('Google公開SKU', 'Google public SKUs')}
            </dd>
          </div>
        )}
      </dl>
      {transcription && <>
        {quote.warnings.map((warning, index) => <p className="notice" key={index}>{warning}</p>)}
        {automaticRetries && <p className="helper-text" data-testid="automatic-retry-policy">{t(
          `混雑時（HTTP 429）は各区間を最大${quote.retryPolicy?.maxRetries ?? 0}回再試行します（最大${quote.maximumRequestCount}回送信）。通信結果が不明な場合は停止します。`,
          `If the service is busy (HTTP 429), each range may be retried up to ${quote.retryPolicy?.maxRetries ?? 0} times (${quote.maximumRequestCount} requests maximum). An unknown outcome stops the job.`,
        )}</p>}
        <p className="helper-text" data-testid="transcription-pacing-policy">{t('音声は順に送信します。混雑時はサーバーの案内に従って待機し、受信済みの字幕で学習を続けられます。', 'Audio is sent one range at a time. When the service is busy, Surtitle waits as directed; received subtitles remain available for learning.')}</p>
      </>}
      </AnimatedDetails>
      {!transcription && <MotionSwap disabled stateKey={quote.warnings.join('|')}>{quote.warnings.map((warning, index) => (
        <p className="notice warning" key={index}>
          {warning}
        </p>
      ))}</MotionSwap>}
      <MotionRegion mode="status" open={approvalBlocked}><MotionSwap disabled stateKey={expired ? 'expired' : quote.blockedReason ?? 'blocked'}>
        <p id={blockReasonId} className="notice warning" role="status">
          {expired
            ? t(
                '見積もりの有効期限が切れたため、承認できません。見積もりを更新してください。',
                'This quote has expired, so approval is disabled. Refresh the estimate to continue.',
              )
            : quote.blockedReason ||
              t(
                '予算や認証の設定を確認してください。',
                'Check your budget and credential settings.',
              )}
        </p>
        {expired && onRefresh && <Button busy={busy} onClick={onRefresh}>
          {t('見積もりを更新', 'Refresh estimate')}
        </Button>}
      </MotionSwap></MotionRegion>
      <MotionRegion mode="status" open={automaticRetries && !transcription}><p className="notice" data-testid="automatic-retry-policy">
        {t(
          `サービスが混雑した場合（HTTP 429）だけ、各区間を最大${quote.retryPolicy?.maxRetries ?? 0}回、自動で再試行します（最大${quote.maximumRequestCount}回の送信）。${unpriced ? '表示した送信上限には再試行を含みます。' : '予約額と送信上限は再試行を含みます。'}通信結果が不明な場合は停止します。`,
          `Only when the service is busy (HTTP 429), each audio range may be retried automatically up to ${quote.retryPolicy?.maxRetries ?? 0} times (${quote.maximumRequestCount} requests maximum). ${unpriced ? 'The displayed sending limits include retries.' : 'The reservation and maximum sending limits include retries.'} An unknown outcome stops the job.`,
        )}
      </p></MotionRegion>
      <MotionRegion mode="status" open={unpriced}><p className="helper-text">
        {t('開始すると、料金不明のまま表示した範囲の実行を承認します。', 'Starting approves this scope with an unknown price.')}
      </p></MotionRegion>
      <Button
        variant="primary"
        className="full-width"
        busy={busy}
        disabled={!quoteCanBeApproved(quote, now)}
        aria-describedby={approvalBlocked ? blockReasonId : undefined}
        onClick={onApprove}
      >
        <Play size={16} />
        {transcription ? t('文字起こしを開始', 'Start transcription') : quote.kind === 'translate' ? t('翻訳を開始', 'Start translation') : quote.focusTerm ? t('解説を開始', 'Start explanation') : t('表現の提案を開始', 'Find expressions')}
      </Button>
    </div>
  );
}
