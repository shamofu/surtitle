// SPDX-License-Identifier: GPL-3.0-or-later
import { useAppearance } from '../../app/runtime';
import type { AiRuntimeSnapshot, JobSummary } from '../../shared/contracts/ai';
import { AnimatedDetails } from '../../shared/ui/AnimatedDetails';
import { useAiRuntime } from './runtime-store';
import { previewFields } from './preview-fields';
import './runtime.css';

const phases: Record<string, [string, string]> = {
  preparing: ['送信の準備', 'Preparing request'], sending: ['送信を開始', 'Request started'],
  receiving: ['応答を受信中', 'Receiving response'], validating: ['応答を確認中', 'Checking response'],
  settled: ['結果を保存', 'Result saved'], rejected: ['応答を利用できませんでした', 'Response could not be used'],
  unknown: ['送信結果の確認が必要', 'Request outcome needs review'],
  completed: ['すべて完了', 'All requests completed'], partial: ['一部失敗', 'Completed with failures'],
  failed: ['処理に失敗', 'Processing failed'], stopped: ['処理を停止', 'Processing stopped'],
};
const labels: Record<string, [string, string]> = {
  term: ['表現', 'Expression'], meaning: ['意味', 'Meaning'], explanation: ['解説', 'Explanation'],
  example: ['例文', 'Example'], translation: ['翻訳', 'Translation'], text: ['字幕', 'Subtitle'], transcript: ['文字起こし', 'Transcript'],
};
const reasons: Record<string, [string, string]> = {
  output_limit: ['出力上限に到達', 'Output limit reached'], output_blocked: ['出力が制限されました', 'Output blocked'],
  output_incomplete: ['応答が不完全です', 'Incomplete response'], output_json: ['応答形式を読み取れません', 'Unreadable response format'],
  output_fields: ['必要な内容がありません', 'Missing required content'], output_source: ['引用元が一致しません', 'Source references do not match'],
  credentials: ['認証を確認してください', 'Check credentials'], budget: ['予算を確認してください', 'Check budget'],
  provider: ['サービスからのエラー', 'Service error'], source_changed: ['対象が変更されました', 'Source changed'],
  local_apply: ['結果の反映に失敗', 'Could not apply the result'], unknown_outcome: ['結果は未確認です', 'Outcome is unknown'],
  execution: ['実行できませんでした', 'Execution failed'],
};

export function JobOutcome({ job }: { job: JobSummary }) {
  const { t } = useAppearance();
  const counts = job.requestCounts;
  if (!counts || !job.executionOutcome || job.executionOutcome === 'running') return null;
  const label = job.executionOutcome === 'complete' ? t('完了', 'Complete')
    : job.executionOutcome === 'partial' ? t('一部失敗', 'Completed with failures')
      : job.executionOutcome === 'failed' ? t('全件失敗', 'All requests failed') : t('停止', 'Stopped');
  return <p className="ai-runtime-outcome" role="status" data-outcome={job.executionOutcome}>
    <strong>{label}</strong>{' · '}{t(`成功 ${counts.succeeded}件・失敗 ${counts.rejected}件`, `${counts.succeeded} succeeded · ${counts.rejected} failed`)}
    {counts.pending + counts.inFlight > 0 && <> · {t(`未完了 ${counts.pending + counts.inFlight}件`, `${counts.pending + counts.inFlight} unfinished`)}</>}
  </p>;
}

export function AiRuntime({ job, compact = false }: { job: JobSummary; compact?: boolean }) {
  const state = useAiRuntime(job.id, job.status === 'running');
  return <AiRuntimeView job={job} snapshot={state.snapshot} error={state.error} compact={compact} />;
}

export function AiRuntimeView({ job, snapshot, error = false, compact = false }: { job: JobSummary; snapshot: AiRuntimeSnapshot | null; error?: boolean; compact?: boolean }) {
  const { t } = useAppearance();
  const runtime = snapshot?.jobId === job.id ? snapshot : null;
  const events = runtime?.events ?? [];
  const preview = runtime?.preview;
  const fields = preview ? previewFields(preview.text) : [];
  if (!events.length && !preview && !job.executionOutcome && !error) return null;
  const eventLine = (event: AiRuntimeSnapshot['events'][number], withTime: boolean) => <li key={event.id}>
    {withTime && <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleString()}</time>}
    <span>{event.ordinal != null && <>{t(`要求 ${event.ordinal + 1}`, `Request ${event.ordinal + 1}`)} · </>}{phases[event.phase] ? t(...phases[event.phase]) : t('進捗を更新', 'Progress updated')}
      {event.reason && reasons[event.reason] && <> · {t(...reasons[event.reason])}</>}
      {event.httpStatus != null && Number.isInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599 && <> · HTTP {event.httpStatus}</>}
    </span>
  </li>;
  const previewContent = preview && fields.length > 0 && <section className="ai-runtime-preview" aria-label={t('生成中のプレビュー', 'Generation preview')} data-state={preview.state}>
      <strong>{preview.state === 'rejected' ? t('利用できなかった応答', 'Unusable response') : preview.state === 'validated' ? t('受信した内容', 'Received content') : t('生成中・未確定', 'Generating · provisional')}</strong>
      <p className="helper-text">{preview.state === 'validated'
        ? t('応答の形式を確認しました。反映状況は処理結果を確認してください。', 'Response format checked. See the job result for application status.')
        : t('このプレビューは保存・適用できません。', 'This preview cannot be saved or applied.')}</p>
      <dl>{fields.map((field, index) => <div key={`${index}:${field.key}`}><dt>{t(...labels[field.key])}</dt><dd>{field.text}</dd></div>)}</dl>
      {preview.truncated && <p className="helper-text">{t('プレビューは先頭部分のみ表示しています。', 'Only the beginning of the preview is shown.')}</p>}
    </section>;
  const history = events.length > 0 && <AnimatedDetails><summary>{t('処理の履歴', 'Progress history')}</summary>
    <ol className="ai-runtime-history">{events.map(event => eventLine(event, true))}</ol>
  </AnimatedDetails>;
  return <section className={`ai-runtime${compact ? ' ai-runtime-compact' : ''}`} aria-label={t('AI処理の状況', 'AI progress')} data-job-id={job.id}>
    <JobOutcome job={job} />
    {events.length > 0 && <ol className="ai-runtime-recent" aria-label={t('直近の進捗', 'Recent progress')}>{events.slice(-3).map(event => eventLine(event, false))}</ol>}
    {compact ? (previewContent || history) && <AnimatedDetails className="ai-runtime-disclosure">
      <summary>{t('生成内容・処理履歴', 'Generated content and history')}</summary>
      <div className="ai-runtime-expanded">{previewContent}{history}</div>
    </AnimatedDetails> : <>{history}{previewContent}</>}
    {error && <p className="helper-text" role="status">{t('進捗の更新を取得できませんでした。', 'Progress updates are temporarily unavailable.')}</p>}
  </section>;
}
