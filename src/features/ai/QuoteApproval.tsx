// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';

import { Check, CircleDollarSign, ShieldCheck } from 'lucide-react';

import type { AiQuote } from '../../shared/contracts/ai';

import { useAppearance } from '../../app/runtime';
import { money, quoteCanBeApproved, timestamp } from '../../shared/format';
import { Button } from '../../shared/ui/index';

export function QuoteApproval({
  quote,
  busy,
  onApprove,
}: {
  quote: AiQuote;
  busy: boolean;
  onApprove: () => void;
}) {
  const { t } = useAppearance();
  const [acknowledgedQuote, setAcknowledgedQuote] = useState<string | null>(
    null,
  );
  const approvalIdentity = `${quote.id}:${quote.digest || ''}:${quote.expiresAt}`;
  const acknowledged = acknowledgedQuote === approvalIdentity;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const expired = new Date(quote.expiresAt).getTime() <= now;
  const unpriced = quote.unpriced === true || quote.maximumUsd == null;
  return (
    <div className="quote-review">
      <div className="quote-cost">
        <span>
          <CircleDollarSign size={18} />
          {t('この実行の見積もり', 'Estimate for this job')}
        </span>
        <strong>
          {unpriced
            ? t('料金不明', 'Price unknown')
            : money(quote.estimatedUsd)}
        </strong>
        <small>
          {unpriced ? (
            t('金額上限は保証できません', 'A dollar limit cannot be guaranteed')
          ) : (
            <>
              {t('承認する予約額', 'Approved reservation')}{' '}
              <b>{money(quote.maximumUsd)}</b>
            </>
          )}
        </small>
      </div>
      <dl className="details-list">
        {quote.applyPolicy === 'auto' && <div><dt>{t('完成後', 'After completion')}</dt><dd>{t('字幕を自動表示', 'Apply subtitles automatically')}</dd></div>}
        {quote.focusTerm && (
          <div>
            <dt>{t('解説する表現', 'Phrase to explain')}</dt>
            <dd>{quote.focusTerm}</dd>
          </div>
        )}
        <div>
          <dt>{t('対象区間', 'Selected range')}</dt>
          <dd>
            {timestamp(quote.startMs, true)} — {timestamp(quote.endMs, true)}
          </dd>
        </div>
        <div>
          <dt>{t('モデル', 'Model')}</dt>
          <dd>
            {quote.model} · {quote.location || 'global'}
          </dd>
        </div>
        <div>
          <dt>{t('要求数 / 同時送信', 'Requests / concurrency')}</dt>
          <dd>{quote.requestCount ?? 1} / 1</dd>
        </div>
        {(quote.sendDurationMs || 0) > 0 && (
          <div>
            <dt>{t('重複込みの送信音声', 'Audio including overlap')}</dt>
            <dd>{timestamp(quote.sendDurationMs || 0, true)}</dd>
          </div>
        )}
        <div>
          <dt>
            {t('1要求 / 全要求の出力上限', 'Output limit per request / total')}
          </dt>
          <dd>
            {quote.maxOutputTokens.toLocaleString()} /{' '}
            {(
              quote.totalOutputTokens ?? quote.maxOutputTokens
            ).toLocaleString()}{' '}
            tokens
          </dd>
        </div>
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
      {quote.warnings.map((warning, index) => (
        <p className="notice warning" key={index}>
          {warning}
        </p>
      ))}
      {(!quote.canApprove || expired) && (
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
      )}
      <label className="check-field">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) =>
            setAcknowledgedQuote(event.target.checked ? approvalIdentity : null)
          }
          disabled={!quote.canApprove || expired || busy}
        />
        <span>
          {unpriced
            ? t(
                '料金と品質が未確認であることを理解し、この範囲・要求数・音声時間・出力設定で今回の実行を承認します。',
                'I understand that pricing and quality are unverified and approve this job for the displayed scope, request count, audio duration, and output settings.',
              )
            : t(
                'この区間と予約額を確認し、モデルの出力を確認して利用することを了承して、今回のAI実行を承認します。',
                'I approve this AI job for the displayed scope and reservation, and will review the model output before use.',
              )}
        </span>
      </label>
      <Button
        variant="primary"
        className="full-width"
        busy={busy}
        disabled={!quoteCanBeApproved(quote, acknowledged, now)}
        onClick={onApprove}
      >
        <Check size={16} />
        {t('この実行を承認する', 'Approve this job')}
      </Button>
      <p className="helper-text centered">
        <ShieldCheck size={13} />
        {t(
          '以後の実行や結果不明の再試行を、自動で承認することはありません。',
          'This does not authorize future jobs or retries with an unknown result.',
        )}
      </p>
    </div>
  );
}
