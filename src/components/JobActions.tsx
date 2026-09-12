// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { Check, FileCheck2, Pause, RotateCw, Square } from 'lucide-react';
import { api } from '../api';
import type { AiQuote, JobSummary, SavedAiResult } from '../api';
import { useApp } from '../context';
import { Button, Modal } from './ui';
import { QuoteApproval } from './AiDialog';
import { timestamp } from '../utils';
import { TranscriptReviewDialog } from './TranscriptReview';

export function JobActions({ job }: { job: JobSummary }) {
  const { t, run } = useApp();
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<AiQuote>();
  const [saved, setSaved] = useState<SavedAiResult[]>();
  const [transcript, setTranscript] = useState(false);
  async function perform(action: () => Promise<void>) { setBusy(true); await run(action); setBusy(false); }
  async function estimateRetry() {
    setBusy(true);
    const result = await run(() => api.createRetryQuote(job.id));
    if (result) setQuote(result);
    setBusy(false);
  }
  async function approve() {
    if (!quote) return;
    setBusy(true);
    const success = await run(async () => { await api.reapproveQuote(quote); return true; });
    setBusy(false);
    if (success) setQuote(undefined);
  }
  async function openSaved() {
    setBusy(true);
    const results = await run(() => api.savedAiResults(job.id));
    if (results) setSaved(results);
    setBusy(false);
  }
  async function applySaved(result: SavedAiResult) {
    setBusy(true);
    const results = await run(async () => {
      await api.applySavedAiResult(result.jobId, result.ordinal);
      return api.savedAiResults(job.id);
    }, t('保存済み翻訳を適用しました。', 'Applied the saved translation.'));
    if (results) setSaved(results);
    setBusy(false);
  }
  return <><div className="inline-actions job-actions">
    {job.transcriptReview && <Button data-testid="transcript-review-open" data-job-id={job.id} disabled={busy} onClick={() => setTranscript(true)}><FileCheck2 size={13} />{t('文字起こしを確認', 'Review transcription')}</Button>}
    {(job.pendingResults || 0) > 0 && <Button disabled={busy} onClick={() => void openSaved()}><FileCheck2 size={13} />{t('保存済み翻訳を確認', 'Review saved translations')}</Button>}
    {job.status === 'running' && <Button disabled={busy} onClick={() => void perform(() => api.pauseAiJob(job.id))}><Pause size={13} />{t('次の送信前に一時停止', 'Pause before next request')}</Button>}
    {['running', 'queued', 'paused'].includes(job.status) && <Button disabled={busy} onClick={() => void perform(() => api.cancelAiJob(job.id))}><Square size={12} />{t('中止', 'Cancel')}</Button>}
    {['paused', 'failed', 'unknown'].includes(job.status) && <Button busy={busy} onClick={() => void estimateRetry()}><RotateCw size={13} />{t('残りを再見積もり', 'Estimate remaining work')}</Button>}
  </div>{transcript && <TranscriptReviewDialog jobId={job.id} onClose={() => setTranscript(false)} />}{saved && <Modal title={t('保存済み翻訳を確認', 'Review saved translations')} eyebrow="SAVED ON THIS DEVICE" onClose={() => { if (!busy) setSaved(undefined); }}>
    <p className="notice">{t('受信済みの結果を教材へ適用します。API送信も追加課金も行いません。すでに適用した結果は、後の手動編集を上書きしません。', 'Apply received results to your subtitles without sending an API request or adding a charge. Applying a result again preserves later manual edits.')}</p>
    {saved.map(result => <section className="saved-ai-result" key={result.ordinal}>
      <div className="saved-translations">{result.translations.map((translation, index) => <div className="saved-translation" key={index}><small>{timestamp(translation.startMs)} – {timestamp(translation.endMs)}</small><p>{translation.source}</p><p>{translation.translation}</p></div>)}</div>
      {result.blockedReason && <p className="notice warning" role="status">{result.blockedReason}</p>}
      <Button variant={result.applied ? 'secondary' : 'primary'} disabled={busy || !result.canApply} onClick={() => void applySaved(result)}>{result.applied ? <><Check size={14} />{t('適用済み', 'Applied')}</> : t('この翻訳を適用', 'Apply this translation')}</Button>
    </section>)}
  </Modal>}{quote && <Modal title={t('残りの処理を、あらためて確認。', 'Review the remaining work.')} eyebrow="A NEW QUOTE, A NEW DECISION" onClose={() => { if (!busy) setQuote(undefined); }}><p className="notice">{t('未完了の処理だけを新しく承認します。結果不明の送信は、利用額の確認を済ませるまで再実行できません。', 'This new approval covers unfinished work only. Unknown attempts must be accounted for before retrying.')}</p><QuoteApproval key={quote.id} quote={quote} busy={busy} onApprove={() => void approve()} /></Modal>}</>;
}
