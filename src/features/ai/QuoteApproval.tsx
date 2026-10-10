// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';

import { Check, CircleDollarSign, ShieldCheck } from 'lucide-react';

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
  transcription = false,
}: {
  quote: AiQuote;
  busy: boolean;
  onApprove: () => void;
  transcription?: boolean;
}) {
  const { t } = useAppearance();
  const [acknowledgedQuote, setAcknowledgedQuote] = useState<string | null>(
    null,
  );
  const approvalIdentity = JSON.stringify([quote.id, quote.digest, quote.expiresAt, quote.retryPolicy,
    quote.maximumRequestCount, quote.maximumSendDurationMs, quote.maximumTotalOutputTokens]);
  const acknowledged = acknowledgedQuote === approvalIdentity;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const expired = new Date(quote.expiresAt).getTime() <= now;
  const unpriced = quote.unpriced === true || quote.maximumUsd == null;
  const requiresAcknowledgement = !transcription || unpriced;
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
              {t('承認する予約額', 'Approved reservation')}{' '}
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
        {!transcription && <div>
          <dt>{t('モデル', 'Model')}</dt>
          <dd>
            {quote.model} · {quote.location || 'global'}
          </dd>
        </div>}
      </dl>
      <AnimatedDetails open={!transcription}>
        <summary>{t('料金・送信の詳細', 'Cost and request details')}</summary>
        <dl className="details-list">
        {transcription && <div><dt>{t('モデル', 'Model')}</dt><dd>{quote.model} · {quote.location || 'global'}</dd></div>}
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
      </AnimatedDetails>
      <MotionSwap stateKey={quote.warnings.join('|')}>{quote.warnings.map((warning, index) => (
        <p className="notice warning" key={index}>
          {warning}
        </p>
      ))}</MotionSwap>
      <MotionRegion open={!quote.canApprove || expired}><MotionSwap stateKey={expired ? 'expired' : quote.blockedReason ?? 'blocked'}>
        <p className="notice warning" role="status">
          {expired
            ? t(
                '見積もりの有効期限が切れました。再見積もりしてください。',
                'This quote has expired. Request a new estimate.',
              )
            : quote.blockedReason ||
              t(
                '予算や認証の設定を確認してください。',
                'Check your budget and credential settings.',
              )}
        </p>
      </MotionSwap></MotionRegion>
      <MotionRegion open={requiresAcknowledgement} keepMounted><label className="check-field">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) =>
            setAcknowledgedQuote(event.target.checked ? approvalIdentity : null)
          }
          disabled={!quote.canApprove || expired || busy}
        />
        <span>
          {unpriced && transcription ? automaticRetries
            ? t('料金を事前に確定できないことを了承し、表示された自動再試行と送信上限を含め、この範囲の文字起こしを開始します。', 'I understand the price cannot be determined in advance and authorize transcription of this range, including the displayed automatic retries and sending limits.')
            : t('料金を事前に確定できないことを了承し、この範囲の文字起こしを開始します。', 'I understand the price cannot be determined in advance and authorize transcription of this range.') : unpriced
            ? t(
                '料金と品質が未確認であることを理解し、この範囲・要求数・音声時間・出力設定で今回の実行を承認します。',
                'I understand that pricing and quality are unverified and approve this job for the displayed scope, request count, audio duration, and output settings.',
              )
            : t(
                'この区間と予約額を確認し、モデルの出力を確認して利用することを了承して、今回のAI実行を承認します。',
                'I approve this AI job for the displayed scope and reservation, and will review the model output before use.',
              )}
        </span>
      </label></MotionRegion>
      <MotionRegion open={automaticRetries}><p className="notice" data-testid="automatic-retry-policy">
        {t(
          `サービスが混雑した場合（HTTP 429）だけ、各区間を最大${quote.retryPolicy?.maxRetries ?? 0}回、自動で再試行します（最大${quote.maximumRequestCount}回の送信）。${unpriced ? '表示した送信上限には再試行を含みます。' : '予約額と送信上限は再試行を含みます。'}通信結果が不明な場合は停止します。`,
          `Only when the service is busy (HTTP 429), each audio range may be retried automatically up to ${quote.retryPolicy?.maxRetries ?? 0} times (${quote.maximumRequestCount} requests maximum). ${unpriced ? 'The displayed sending limits include retries.' : 'The reservation and maximum sending limits include retries.'} An unknown outcome stops the job.`,
        )}
      </p></MotionRegion>
      <MotionRegion open={transcription}><p className="helper-text" data-testid="transcription-pacing-policy">
        {t('音声は順に送信し、送信開始の間隔を10秒以上空けます。混雑時は間隔を延ばします。', 'Audio is sent one range at a time, with at least 10 seconds between request starts. Congestion increases the interval.')}
      </p></MotionRegion>
      <Button
        variant="primary"
        className="full-width"
        busy={busy}
        disabled={!quoteCanBeApproved(quote, !requiresAcknowledgement || acknowledged, now)}
        onClick={onApprove}
      >
        <Check size={16} />
        {transcription ? t('この内容で文字起こしを開始', 'Start transcription') : t('この実行を承認する', 'Approve this job')}
      </Button>
      <MotionRegion open={!transcription}><p className="helper-text centered">
        <ShieldCheck size={13} />
        {t(
          '以後の実行や結果不明の再試行を、自動で承認することはありません。',
          'This does not authorize future jobs or retries with an unknown result.',
        )}
      </p></MotionRegion>
    </div>
  );
}
