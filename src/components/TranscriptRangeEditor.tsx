// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { Play } from 'lucide-react';
import { api } from '../api';
import type { ReviewChunk, ReviewText, TranscriptRangeEdit, TranscriptResultReview, TranscriptReview } from '../api';
import { useApp } from '../context';
import { timestamp } from '../utils';
import { Badge, Button } from './ui';
import { SubtitleRows, toEditRows, validatedRows } from './SubtitleRows';

function originalText(response: unknown): string | undefined {
  // Copy only an unambiguous structured transcript, never its invalid timings.
  if (!response || typeof response !== 'object' || !('candidates' in response) || !Array.isArray(response.candidates) || response.candidates.length !== 1) return;
  const parts = response.candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return;
  const text = parts.filter(part => part && part.thought !== true && part.audioTranscription && typeof part.audioTranscription === 'object')
    .map(part => typeof part.audioTranscription.text === 'string' ? part.audioTranscription.text : typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
  if (text.trim() && new TextEncoder().encode(text).length <= 16000) return text;
}

export function TranscriptRangeEditor({ jobId, digest, chunk, edit, result, disabled, update, play }: {
  jobId: string; digest: string; chunk: ReviewChunk; edit: TranscriptRangeEdit; result?: TranscriptResultReview; disabled: boolean;
  update: (operation: () => Promise<TranscriptReview>) => Promise<void>; play: (cue: ReviewText) => void;
}) {
  const { t, run } = useApp();
  const [rows, setRows] = useState(() => toEditRows(chunk.segments));
  const [confirmedSilence, setConfirmedSilence] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const parsed = validatedRows(rows, chunk.requestStartMs, chunk.requestEndMs);
  const blocked = disabled || loading;
  const labels = { pending: t('未受信', 'Not received'), invalid: t('受信済み・無効', 'Received, invalid'), empty: t('有効な空結果', 'Valid empty result'), received: t('有効な字幕', 'Valid subtitles') };
  async function copyText() {
    setLoading(true);
    setCopyFailed(false);
    const detail = await run(() => api.transcriptResultDetail(jobId, chunk.ordinal));
    const text = originalText(detail?.evidence?.response);
    if (text) {
      setRows(items => [...items, { start: '', end: '', text }]);
      setConfirmedSilence(false);
    } else setCopyFailed(true);
    setLoading(false);
  }
  return <section className="boundary-editor" aria-label={`${t('区間の修正', 'Correct range')} ${chunk.ordinal + 1}`}>
    <div className="scope-heading"><h3>{t('区間', 'Range')} {chunk.ordinal + 1} · {timestamp(chunk.requestStartMs, true)} – {timestamp(chunk.requestEndMs, true)}</h3><Badge tone={chunk.source === 'manual' ? 'accent' : 'warning'}>{chunk.source === 'manual' ? t('手動修正を選択中', 'Manual correction selected') : t('原音を確認して修正', 'Listen and correct')}</Badge></div>
    <p className="helper-text">{t('元の応答', 'Original response')}: {result ? labels[result.state] : t('保存結果を参照', 'See saved results')}</p>
    <p className="helper-text">{t('前後の重複部分を含む音声です。手動の時刻は字幕区間として保存し、AIの単語時刻にはしません。保存後も、全体のプレビューから採用する操作が必要です。', 'This audio includes overlapping context. Manual times are subtitle ranges, not AI word timestamps. Saving still requires adoption from the complete preview.')}</p>
    <div className="inline-actions"><Button disabled={blocked} onClick={() => play({ startMs: chunk.requestStartMs, endMs: chunk.requestEndMs, text: '' })}><Play size={14} />{t('この区間の原音を再生', 'Play original range audio')}</Button>
      {result?.evidence && <Button disabled={blocked || rows.length >= 200} onClick={() => void copyText()}>{t('保存応答の本文を追加', 'Add text from saved response')}</Button>}
    </div>
    {copyFailed && <p className="notice warning" role="status">{t('編集欄へ安全に取り込める本文がありません。保存応答の詳細を確認し、必要な本文を入力してください。', 'No unambiguous text could be copied into the editor. Inspect the saved response and enter the required text.')}</p>}
    {(result?.attemptState === 'unknown' || result?.attemptState === 'reserved') && <p className="notice warning">{t('費用が未確定の予約を保持しています。この編集で再送や精算は行いません。', 'The unresolved cost reservation is retained. Editing neither resends nor settles the request.')}</p>}
    <details><summary>{t('修正前の字幕を表示', 'Show subtitles before manual correction')}</summary>{(chunk.originalSegments || []).map((cue, index) => <p key={index}>{timestamp(cue.startMs, true)} – {timestamp(cue.endMs, true)} · {cue.text}</p>)}{!chunk.originalSegments?.length && <p className="helper-text">{t('有効な元字幕がありません。これは無音を意味しません。', 'No validated original subtitles are available. This does not mean the audio is silent.')}</p>}</details>
    <SubtitleRows rows={rows} onChange={value => { setRows(value); setConfirmedSilence(false); }} disabled={blocked} startMs={chunk.requestStartMs} endMs={chunk.requestEndMs} />
    {!rows.length && <label className="check-field"><input type="checkbox" checked={confirmedSilence} disabled={blocked} onChange={event => setConfirmedSilence(event.target.checked)} /><span>{t('この区間全体の原音を聴き、発話がないことを確認した', 'I listened to this entire range and confirmed there is no speech')}</span></label>}
    {!parsed && !confirmedSilence && <p className="field-error">{t('音声範囲内の開始・終了時刻と本文を入力してください。空の編集欄だけでは発話なしになりません。', 'Enter text and valid start/end times within this audio range. An empty editor does not confirm silence.')}</p>}
    <div className="boundary-actions"><Button disabled={blocked || (!parsed && !confirmedSilence)} onClick={() => void update(() => api.saveManualTranscriptRange(jobId, digest, chunk.ordinal, edit.version, confirmedSilence && !rows.length ? { kind: 'confirmed_no_speech' } : { kind: 'subtitles', segments: parsed! }))}>{t('修正を保存してプレビューへ選択', 'Save correction and select for preview')}</Button>
      {edit.selectedRevisionId && <Button disabled={blocked} onClick={() => void update(() => api.selectTranscriptRangeSource(jobId, digest, chunk.ordinal, edit.version, { kind: 'original' }))}>{t('修正前の結果へ戻す', 'Return to previous result')}</Button>}
      {!edit.selectedRevisionId && edit.latestRevision && <Button disabled={blocked} onClick={() => void update(() => api.selectTranscriptRangeSource(jobId, digest, chunk.ordinal, edit.version, { kind: 'manual', revisionId: edit.latestRevision!.id }))}>{t('保存した修正を再選択', 'Reselect saved correction')}</Button>}
    </div>
  </section>;
}
