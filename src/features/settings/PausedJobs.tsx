// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { Check, ShieldCheck } from 'lucide-react';
import { aiApi } from '../ai/api';

import type { BudgetSummary } from '../../shared/contracts/ai';

import {
  useDataActions,
  useAppearance,
  useNotifications,
  useSnapshot,
} from '../../app/runtime';
import { money } from '../../shared/format';
import { Button } from '../../shared/ui/index';

import { TranscriptReviewDialog } from '../study/transcript/TranscriptReview';
import { JobActions } from '../ai/JobActions';
import { AnimatedValue, MotionRegion, MotionSwap } from '../../shared/motion';

export function UnknownAttempt({
  attempt,
  onResolved,
}: {
  attempt: NonNullable<BudgetSummary['unknownAttempts']>[number];
  onResolved?: () => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const [acknowledged, setAcknowledged] = useState(false);
  const unpriced = attempt.heldUsd == null;
  const [busy, setBusy] = useState(false);
  async function resolve() {
    if (!acknowledged) return;
    setBusy(true);
    const success = await report(
      async () => {
        await mutate(() => aiApi.resolveUnknownAttempt(attempt.id), {
          kind: 'snapshot',
        }); return true;
      },
      t(
        '課金の可能性を了承しました。未確定の利用記録を保持します。再実行には別の承認が必要です。',
        'Possible charge acknowledged. Unresolved accounting is retained. Any retry requires a separate approval.',
      ),
    );
    setBusy(false);
    if (success) onResolved?.();
  }
  return (
    <article className="unknown-attempt">
      <h3>
        {t(
          '送信結果が確認できないリクエスト',
          'Request with an unknown outcome',
        )}{' '}
        ·{' '}
        <AnimatedValue value={unpriced
          ? t('料金未算定', 'Cost not calculated')
          : money(attempt.heldUsd)} />
      </h3>
      <p>
        <MotionSwap as="span" stateKey={unpriced ? 'unpriced' : 'reserved'}>{unpriced
          ? t(
              '応答と金額を確認できません。料金未算定の送信記録を保持します。了承しても再送されません。',
              'The outcome and cost are unknown. The unpriced request remains recorded. Acknowledging does not resend it.',
            )
          : t(
              '課金済みか確認できないため、予約額の全額を保留し、予算から差し引き続けます。この確認では再実行されません。再実行には別の承認が必要です。',
              'Because the charge is unknown, the entire reservation remains held against your budget. Acknowledging it does not retry the request; any retry requires a separate approval.',
            )}</MotionSwap>
      </p>
      <label className="check-field">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={busy}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>
          <MotionSwap as="span" stateKey={unpriced ? 'unpriced' : money(attempt.heldUsd)}>{unpriced
            ? t(
                '金額不明の課金が発生した可能性を了承します。',
                'I acknowledge that an unknown charge may have occurred.',
              )
            : t(
                `課金の可能性を了承し、${money(attempt.heldUsd)} の予約額の保留を維持します。`,
                `I acknowledge the possible charge and keep ${money(attempt.heldUsd)} reserved.`,
              )}</MotionSwap>
        </span>
      </label>
      <Button
        disabled={!acknowledged}
        busy={busy}
        onClick={() => void resolve()}
      >
        <Check size={15} />
        {t('課金の可能性を了承', 'Acknowledge possible charge')}
      </Button>
    </article>
  );
}

export function PausedJobs() {
  const [reviewJob, setReviewJob] = useState<string>();
  const { data } = useSnapshot();
  const { t } = useAppearance();
  const attempts = data?.budget.unknownAttempts || [];
  const jobs =
    data?.jobs.filter(
      (job) =>
        ['paused', 'failed', 'unknown'].includes(job.status) ||
        (job.pendingResults || 0) > 0 ||
        (job.needsAttention ?? job.transcriptReview),
    ) || [];
  return (
    <>
    <MotionRegion open={!!attempts.length || !!jobs.length}>
    <section className="settings-card">
      <div className="settings-section-title">
        <ShieldCheck size={20} />
        <div>
          <h2>
            {t('停止中・結果不明の処理', 'Paused jobs & unknown requests')}
          </h2>
          <p>
            {t(
              '利用額の確認と、残りの処理の承認は別の操作です。',
              'Accounting for a request and approving remaining work are separate actions.',
            )}
          </p>
        </div>
      </div>
      <MotionSwap stateKey={`${attempts.map(attempt => attempt.id).join('|')}:${jobs.map(job => job.id).join('|')}`}>
      {attempts.map((attempt) => (
        <UnknownAttempt key={attempt.id} attempt={attempt} />
      ))}
      {jobs.map((job) => (
        <div className="job-status" key={job.id}>
          <MotionSwap as="span" stateKey={job.message || job.kind}>{job.message || job.kind}</MotionSwap>
          <JobActions job={job} onReviewTranscript={setReviewJob} />
        </div>
      ))}
      </MotionSwap>
    </section>
    </MotionRegion>
      {reviewJob && (
        <TranscriptReviewDialog
          jobId={reviewJob}
          onClose={() => setReviewJob(undefined)}
        />
      )}
    </>
  );
}
