// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { useAppearance } from '../../app/runtime';
import type { JobSummary } from '../../shared/contracts/ai';
import { timestamp } from '../../shared/format';

/** Wait timing is informational. Only the native worker may schedule a request. */
export function JobStatusMessage({ job }: { job: JobSummary }) {
  const { t } = useAppearance();
  const [now, setNow] = useState(Date.now);
  const waiting = job.status === 'running' && job.retry?.state === 'waiting';
  const pacing = job.status === 'running' && !job.retry ? job.pacing : undefined;
  const waitUntil = waiting ? job.retry?.nextRetryAt : pacing?.nextSendAt;
  const deadline = waitUntil ? Date.parse(waitUntil) : NaN;
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  const retry = job.retry;
  const count = retry ? `${retry.retryNumber}/${retry.maxRetries}` : '';
  let message = job.message || (job.status === 'completed'
    ? t('字幕を表示しました', 'Subtitles are ready') : t('文字起こし中', 'Transcribing'));
  if (waiting) {
    message = t(`サービスが混雑しています（HTTP 429）。自動再試行を待機中です（${count}）。`, `The service is busy (HTTP 429). Waiting to retry (${count}).`);
  } else if (job.status === 'running' && retry?.state === 'retrying') {
    message = t(`混雑した区間を再試行しています（${count}）。`, `Retrying the busy audio range (${count}).`);
  } else if (pacing) {
    message = pacing.slowed
      ? t('混雑を避けるため送信間隔を調整中です。', 'Spacing out requests to reduce congestion.')
      : t('送信間隔を調整中です。', 'Spacing out requests.');
  } else if (job.status === 'failed' && retry?.state === 'deferred') {
    message = t('サービスが5分を超える待機を指定したため停止しました。受信済み字幕は保存されています。', 'Stopped because the service requires waiting more than 5 minutes. Received subtitles are saved.');
  } else if (job.status === 'failed' && retry?.state === 'exhausted') {
    message = t(`混雑が続き、自動再試行の上限（${retry.maxRetries}回）に達したため停止しました。受信済み字幕は保存されています。`, `Stopped after ${retry.maxRetries} automatic retries because the service is still busy. Received subtitles are saved.`);
  } else if (job.status === 'failed' && job.issue?.httpStatus === 429) {
    message = t('サービスの混雑または利用枠の制限（HTTP 429）で停止しました。受信済み字幕は保存されています。残りの処理を見積もって再開できます。', 'Stopped because the service is busy or rate limited (HTTP 429). Received subtitles are saved. Review an estimate to resume the remaining work.');
  } else if (job.status === 'unknown' && job.issue?.httpStatus === 429) {
    message = t('サービスの混雑または利用枠の制限（HTTP 429）が記録されています。結果不明の送信を確認してください。受信済み字幕は保存されています。', 'The service reported congestion or a rate limit (HTTP 429). Review requests with an unknown outcome. Received subtitles are saved.');
  }
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return <>
    <span role="status">{message}</span>
    {Number.isFinite(deadline) && <span className="retry-countdown">
      {' '}{waiting
        ? seconds > 0 ? t(`${seconds}秒後に再試行`, `Retrying in ${seconds}s`) : t('再送を準備中', 'Preparing to retry')
        : seconds > 0 ? t(`${seconds}秒後に次の区間を送信`, `Next request in ${seconds}s`) : t('次の送信を準備中', 'Preparing the next request')}
    </span>}
  </>;
}

export function JobProcessingDetails({ job }: { job: JobSummary }) {
  const { t } = useAppearance();
  const pacing = job.status === 'running' && !job.retry ? job.pacing : undefined;
  const issue = pacing ? undefined : job.issue;
  const ordinal = job.retry?.ordinal ?? pacing?.ordinal ?? issue?.ordinal;
  const range = ordinal == null ? undefined : job.transcriptionRanges?.[ordinal];
  const httpStatus = issue?.httpStatus ?? (job.retry ? 429 : undefined);
  return <dl className="details-list">
    {httpStatus != null && <div><dt>{t('応答', 'Response')}</dt><dd>HTTP {httpStatus}</dd></div>}
    {ordinal != null && <div><dt>{pacing ? t('次の区間', 'Next range') : t('対象区間', 'Affected range')}</dt><dd>
      {t(`区間 ${ordinal + 1}`, `Range ${ordinal + 1}`)}
      {range && <> · {timestamp(range.startMs)}–{timestamp(range.endMs)}</>}
    </dd></div>}
    {job.retry && <div><dt>{t('自動再試行', 'Automatic retry')}</dt><dd>{job.retry.retryNumber}/{job.retry.maxRetries}</dd></div>}
    {issue?.occurredAt && <div><dt>{t('発生時刻', 'Occurred at')}</dt><dd><time dateTime={issue.occurredAt}>{issue.occurredAt}</time></dd></div>}
    {job.retry?.nextRetryAt && <div><dt>{job.retry.state === 'deferred' ? t('再開可能時刻', 'May resume after') : t('次の再試行予定', 'Next retry scheduled')}</dt><dd><time dateTime={job.retry.nextRetryAt}>{job.retry.nextRetryAt}</time></dd></div>}
    {pacing && <>
      <div><dt>{t('送信開始の間隔', 'Interval between request starts')}</dt><dd>{t(`${pacing.intervalMs / 1000}秒以上`, `At least ${pacing.intervalMs / 1000}s`)}</dd></div>
      <div><dt>{t('次の送信予定', 'Next request scheduled')}</dt><dd>{pacing.nextSendAt
        ? <time dateTime={pacing.nextSendAt}>{pacing.nextSendAt}</time>
        : t('再開可能時刻を取得できません', 'The next allowed send time is unavailable')}</dd></div>
    </>}
  </dl>;
}

export function currentTranscriptionJob(jobs: JobSummary[]): JobSummary | undefined {
  return jobs.find(job => job.status === 'running') ?? jobs.find(job => !['completed', 'cancelled'].includes(job.status));
}
