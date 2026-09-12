// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, Pause, Play, RotateCw, Scissors } from 'lucide-react';
import { api } from '../api';
import type { AiQuote, BoundaryChoice, ReviewConflict, ReviewCue, ReviewText, TranscriptDraft, TranscriptReview, TranscriptResultReview, TranscriptResultReason } from '../api';
import { useApp } from '../context';
import { timestamp } from '../utils';
import { Badge, Button, Field, Modal } from './ui';
import { QuoteApproval } from './AiDialog';
import { type EditRow, SubtitleRows, toEditRows, validatedRows } from './SubtitleRows';
import { TranscriptRangeEditor } from './TranscriptRangeEditor';

function DraftCues({ cues, play }: { cues: ReviewCue[]; play: (cue: ReviewText) => void }) {
  const { t } = useApp();
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: cues.length, getScrollElement: () => scroll.current, estimateSize: () => 84, overscan: 6 });
  return <div className="draft-cues" ref={scroll} aria-label={t('採用前の字幕', 'Subtitle draft')}>
    <div className="virtual-transcript" style={{ height: virtual.getTotalSize() }}>{virtual.getVirtualItems().map(item => {
      const cue = cues[item.index];
      return <article className="draft-cue" key={cue.id} data-index={item.index} ref={virtual.measureElement} style={{ transform: `translateY(${item.start}px)` }}>
        <button className="segment-time" onClick={() => play(cue)}><Play size={12} />{timestamp(cue.startMs, true)}</button>
        <div><p>{cue.text}</p>{cue.status === 'provisional' && <Badge tone="warning">{t('処理中・未確定', 'Pending / provisional')}</Badge>}</div>
      </article>;
    })}</div>
  </div>;
}

function Alternatives({ title, segments, play, disabled = false }: { title: string; segments: ReviewText[]; play: (cue: ReviewText) => void; disabled?: boolean }) {
  const { t } = useApp();
  return <section className="boundary-alternative"><h4>{title}</h4>{segments.length ? segments.map((cue, index) => <div key={index}>
    <button className="text-button mono" disabled={disabled} onClick={() => play(cue)}>{timestamp(cue.startMs, true)} – {timestamp(cue.endMs, true)}</button><p>{cue.text}</p>
  </div>) : <p className="helper-text">{t('この結果に発話はありません。', 'No speech in this result.')}</p>}</section>;
}

function ResultEvidence({ result, disabled, applied, draftDigest, jobId, update, play }: {
  result: TranscriptResultReview; disabled: boolean; applied: boolean; draftDigest: string; jobId: string;
  update: (operation: () => Promise<TranscriptReview>) => Promise<void>; play: (cue: ReviewText) => void;
}) {
  const { t, run } = useApp();
  const [detail, setDetail] = useState<TranscriptResultReview>();
  const [loading, setLoading] = useState(false);
  const labels = { pending: t('未受信', 'Not received'), invalid: t('受信済み・無効', 'Received, invalid'), empty: t('有効な空結果', 'Valid empty result'), received: t('有効な字幕', 'Valid subtitles') };
  const reasons: Record<TranscriptResultReason, string> = {
    not_received: t('応答はまだ届いていません。', 'No response has arrived.'),
    evidence_unavailable: t('保存された応答の詳細がありません。送信結果を確認してください。', 'Saved response details are unavailable. Check the request outcome.'),
    evidence_incomplete: t('応答の保存上限を超えたか、再解析に必要な情報が不足しています。', 'The response exceeded its storage limit or lacks information needed for reparsing.'),
    candidate_missing: t('応答に字幕候補がありません。', 'The response contains no subtitle candidate.'),
    candidate_count: t('字幕候補の数が想定と異なります。', 'The response has an unexpected number of candidates.'),
    incomplete_response: t('応答が中断・遮断されたか、完了していません。', 'The response was interrupted, blocked, or incomplete.'),
    content_missing: t('字幕の本文がありません。', 'The response contains no transcript content.'),
    invalid_structure: t('応答の形式を字幕として検証できません。', 'The response structure could not be validated as subtitles.'),
    invalid_word_timing: t('単語または字幕の時刻が無効です。', 'Word or subtitle times are invalid.'),
    reversed_time: t('終了時刻が開始時刻より前になっています。', 'An end time precedes its start time.'),
    time_outside_audio: t('音声の範囲外の時刻があります。', 'A timestamp is outside the audio range.'),
    unaligned_words: t('本文と単語時刻の対応が一致しません。', 'Transcript text does not match its timed words.'),
    usage_unknown: t('使用量が不明なため予約を保持しています。', 'Usage is unknown; the reservation is retained.'),
    settlement_pending: t('費用の結果が未確定です。予約を保持し、この応答の採用を停止しています。手動修正は別に保存できます。', 'The cost outcome is unresolved. Its reservation is retained and this response cannot be selected. Manual corrections can be saved separately.'),
  };
  async function load() {
    setLoading(true);
    const loaded = await run(() => api.transcriptResultDetail(jobId, result.ordinal));
    if (loaded) setDetail(loaded);
    setLoading(false);
  }
  return <section className="boundary-editor" aria-label={`${t('結果', 'Result')} ${result.ordinal + 1}`}>
    <div className="scope-heading"><strong>{t('区間', 'Range')} {result.ordinal + 1}</strong><Badge tone={result.state === 'invalid' || result.state === 'pending' ? 'warning' : 'accent'}>{labels[result.state]}</Badge></div>
    {result.reason && <p className="helper-text">{reasons[result.reason]}</p>}
    {result.evidence && <>
      <p className="helper-text">{t('元の応答と費用の記録を保持しています。再解析は保存済みの応答だけを使うローカル処理です。', 'The original response and cost record are preserved. Reparsing uses only the saved response locally.')}</p>
      <div className="inline-actions"><Button disabled={disabled || loading} onClick={() => void load()}>{t('保存応答と派生候補を表示', 'Show saved response and derived candidates')}</Button><Button disabled={disabled || loading || !result.evidence.complete || !result.evidenceSha256} onClick={() => { setDetail(undefined); void update(() => api.reparseTranscriptEvidence(jobId, result.ordinal, result.evidenceSha256!)); }}>{t('保存応答をローカルで再解析', 'Reparse saved response locally')}</Button></div>
    </>}
    {!!result.reparses.length && !detail && <p className="helper-text">{t(`派生候補が${result.reparses.length}件あります。表示して内容を確認してください。`, `${result.reparses.length} derived candidates are saved. Open them to review their contents.`)}</p>}
    {detail && <>
      <details><summary>{t('元の保存応答', 'Original saved response')}</summary><pre>{JSON.stringify(detail.evidence?.response ?? null, null, 2)}</pre></details>
      {detail.reparses.map(candidate => <section key={candidate.id}>
        <h4>{t('ローカル再解析の候補', 'Local reparse candidate')} · {labels[candidate.state]}</h4>
        {candidate.reason && <p className="helper-text">{reasons[candidate.reason]}</p>}
        {candidate.output?.kind === 'transcript' && <Alternatives title={t('派生した字幕', 'Derived subtitles')} segments={candidate.output.cues} play={play} disabled={disabled || loading} />}
        <Button disabled={disabled || loading || applied || candidate.selected || !candidate.output || result.state === 'received' || result.state === 'empty' || ['reserved', 'unknown'].includes(result.attemptState || '')} onClick={() => void update(() => api.selectTranscriptReparse(jobId, result.ordinal, candidate.id, draftDigest))}>{candidate.selected ? t('プレビューに選択済み', 'Selected for preview') : t('この候補をプレビューへ選択', 'Select this candidate for preview')}</Button>
      </section>)}
      <p className="helper-text">{t('候補の選択だけでは字幕を置き換えません。プレビューを確認し、最後に採用してください。', 'Selecting a candidate does not replace subtitles. Review the preview and adopt it separately.')}</p>
    </>}
  </section>;
}

function JoinedSubtitles({ draft, disabled, play }: { draft: TranscriptDraft; disabled: boolean; play: (cue: ReviewText) => void }) {
  const { t } = useApp();
  const joins = draft.edgeGroupJoins || [];
  if (!joins.length) return null;
  function originalGroup(ordinal: number, indices: number[]): ReviewText[] | undefined {
    const chunk = draft.chunks.find(item => item.ordinal === ordinal);
    if (!chunk || !indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || !chunk.segments[index])) return undefined;
    return indices.map(index => chunk.segments[index]);
  }
  const missing = t('元の字幕を表示できません。保存結果を再読み込みしてください。', 'The original subtitles could not be displayed. Refresh the saved results.');
  return <details className="draft-chunks"><summary>{t(`自動でつないだ字幕を確認（${joins.length} 件）`, `Review automatically joined subtitles (${joins.length})`)}</summary>
    <p className="helper-text">{t('重なった部分の内容が一致したため、字幕をつなぎました。元の字幕は両方とも保持しています。音声を聴いて比べられます。字幕の採用は別の操作です。', 'Matching text in overlapping audio was joined. Both original subtitle groups are kept. Listen and compare them; adopting subtitles is a separate action.')}</p>
    <p className="helper-text">{t('表示する時刻は字幕の区間です。', 'Times refer to subtitle ranges.')}</p>
    {joins.map(join => {
      const earlier = originalGroup(join.leftOrdinal, join.leftSegmentIndices);
      const later = originalGroup(join.rightOrdinal, join.rightSegmentIndices);
      const earlierManual = draft.chunks.find(chunk => chunk.ordinal === join.leftOrdinal)?.source === 'manual';
      const laterManual = draft.chunks.find(chunk => chunk.ordinal === join.rightOrdinal)?.source === 'manual';
      return <section className="boundary-editor" key={join.id}>
        <Alternatives title={t('つないだ字幕', 'Joined subtitle')} segments={[join.joined]} disabled={disabled} play={play} />
        <div className="boundary-alternatives">
          {earlier ? <Alternatives title={earlierManual ? t('前の区間で選択した手動字幕', 'Selected manual subtitles from the earlier audio') : t('前の区間の元字幕', 'Original subtitles from the earlier audio')} segments={earlier} disabled={disabled} play={play} /> : <p className="notice warning">{missing}</p>}
          {later ? <Alternatives title={laterManual ? t('次の区間で選択した手動字幕', 'Selected manual subtitles from the later audio') : t('次の区間の元字幕', 'Original subtitles from the later audio')} segments={later} disabled={disabled} play={play} /> : <p className="notice warning">{missing}</p>}
        </div>
      </section>;
    })}
  </details>;
}

function BoundaryEditor({ conflict, disabled, onResolve, onRepair, play, repairs }: {
  conflict: ReviewConflict; disabled: boolean; onResolve: (choice: BoundaryChoice) => void;
  onRepair: () => void; play: (cue: ReviewText) => void; repairs: TranscriptReview['repairAlternatives'];
}) {
  const { t } = useApp();
  const [manual, setManual] = useState<EditRow[]>();
  const [confirmedSilence, setConfirmedSilence] = useState(false);
  const rows = manual && validatedRows(manual, conflict.startMs, conflict.endMs, confirmedSilence);
  const edit = (segments: ReviewText[]) => { setManual(toEditRows(segments)); setConfirmedSilence(false); };
  return <section className="boundary-editor">
    <div className="scope-heading"><h3>{t('境界を原音で確認', 'Listen at the boundary')} · {timestamp(conflict.atMs, true)}</h3>{conflict.resolution && <Badge tone="accent">{t('確認済み', 'Resolved')}</Badge>}</div>
    <Button onClick={() => play({ startMs: conflict.startMs, endMs: conflict.endMs, text: '' })}><Play size={14} />{t('境界の音声を再生', 'Play boundary audio')}</Button>
    <div className="boundary-alternatives"><Alternatives title={t('前の音声区間の結果', 'Earlier chunk result')} segments={conflict.leftAlternative} play={play} /><Alternatives title={t('次の音声区間の結果', 'Later chunk result')} segments={conflict.rightAlternative} play={play} /></div>
    <div className="boundary-actions"><Button disabled={disabled} onClick={() => onResolve({ kind: 'left' })}>{t('前の結果を採用', 'Use earlier result')}</Button><Button disabled={disabled} onClick={() => onResolve({ kind: 'right' })}>{t('次の結果を採用', 'Use later result')}</Button><Button disabled={disabled} onClick={() => onResolve({ kind: 'keep_both' })}>{t('両方を残す', 'Keep both')}</Button><Button disabled={disabled} onClick={() => edit(conflict.resolution?.kind === 'manual' ? conflict.resolution.segments : conflict.leftAlternative)}>{t('手動で整える', 'Edit manually')}</Button></div>
    {manual && <div className="boundary-manual"><p className="helper-text">{t('原音を聴き、必要な文と時刻を入力してください。行をすべて削除しても、確認するまで発話なしにはなりません。', 'Listen and enter the wording and times. Removing every row does not confirm the absence of speech.')}</p>
      <SubtitleRows rows={manual} onChange={value => { setManual(value); setConfirmedSilence(false); }} disabled={disabled} startMs={conflict.startMs} endMs={conflict.endMs} />
      {!manual.length && <label className="check-field"><input type="checkbox" checked={confirmedSilence} disabled={disabled} onChange={event => setConfirmedSilence(event.target.checked)} /><span>{t('この境界の原音を聴き、発話がないことを確認した', 'I listened to this boundary and confirmed there is no speech')}</span></label>}
      <div className="boundary-actions"><Button disabled={disabled || !rows} onClick={() => { if (rows) onResolve({ kind: 'manual', segments: rows }); }}>{t('編集内容で確定', 'Confirm edited boundary')}</Button></div>{!rows && <p className="field-error">{t('表示された境界内の有効な時刻と本文を入力してください。', 'Enter valid times and text inside the displayed boundary.')}</p>}</div>}
    {repairs.map(repair => <div key={repair.jobId} className="repair-result">{repair.draft.pendingRanges.length ? <p className="notice" role="status">{t('修復結果は未受信です。準備や見積もりだけでは送信しません。', 'The repair result has not been received. Preparation and estimates do not send a request.')}</p> : <><Alternatives title={t('追加処理で受信した結果', 'Received repair result')} segments={repair.draft.segments} play={play} /><Button disabled={disabled || !repair.draft.canAdopt} onClick={() => edit(repair.draft.segments)}>{t('修復結果を手動編集へコピー', 'Copy repair into manual editor')}</Button><p className="helper-text">{t('コピーした結果の時刻と本文を確認し、境界内へ整えてから確定します。', 'Review the copied text and times, and keep the edited result inside this boundary before confirming.')}</p></>}</div>)}
    <div className="repair-estimate"><Button disabled={disabled} onClick={onRepair}><Scissors size={14} />{t('30秒以内の修復を見積もる', 'Estimate repair, up to 30 seconds')}</Button><small>{t('音声準備と見積もりだけです。追加送信は別の承認が必要です。', 'Prepares audio and a quote only. Another approval is required to send it.')}</small></div>
  </section>;
}

export function TranscriptReviewDialog({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { t, run } = useApp();
  const [view, setView] = useState<TranscriptReview>();
  const [busy, setBusy] = useState(false);
  const [boundaryId, setBoundaryId] = useState('');
  const [rangeOrdinal, setRangeOrdinal] = useState<number>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [repairQuote, setRepairQuote] = useState<AiQuote>();
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void run(() => api.transcriptReview(jobId)).then(result => { if (active) { if (result) setView(result); setLoadFailed(!result); } });
    return () => { active = false; };
  }, [jobId, run]);
  async function update(operation: () => Promise<TranscriptReview>) {
    setBusy(true);
    const result = await run(operation);
    if (result) { setView(result); setAcknowledged(false); setLoadFailed(false); }
    setBusy(false);
  }
  async function play(cue: ReviewText) {
    if (!view || busy) return;
    setBusy(true);
    await run(async () => {
      await api.loadMedia(view.mediaId);
      // FILE_LOADED restores the saved position. Seeking before readiness can
      // fail or be overwritten by that restore, including for VAD warning audio.
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const state = await api.playerState();
        if (state.error) throw new Error(state.error);
        if (state.ready === true) {
          await api.player({ action: 'seek', startMs: cue.startMs, endMs: cue.endMs });
          return;
        }
        await new Promise(resolve => window.setTimeout(resolve, 100));
      }
      throw new Error(t('プレイヤーの準備が完了しませんでした。もう一度お試しください。', 'The player did not become ready. Try again.'));
    });
    setBusy(false);
  }
  async function repair(id: string) {
    if (!view) return;
    setBusy(true);
    const result = await run(() => api.prepareBoundaryRepair(jobId, view.draft.digest, id));
    if (result) setRepairQuote(result);
    setBusy(false);
  }
  const draft = view?.draft;
  const conflict = draft?.conflicts.find(item => item.id === boundaryId) || draft?.conflicts[0];
  const rangeEdit = view?.rangeEdits?.find(item => item.ordinal === rangeOrdinal);
  const selectedChunk = draft?.chunks.find(item => item.ordinal === rangeOrdinal);
  return <Modal title={t('文字起こしを確認', 'Review transcription')} eyebrow="LISTEN, REVIEW, THEN KEEP" wide onClose={() => { if (!busy) onClose(); }}>
    {!view || !draft ? loadFailed ? <div><p className="notice warning" role="status">{t('保存結果を読み込めませんでした。表示されたエラーを確認してください。', 'Saved results could not be loaded. Check the reported error.')}</p><Button busy={busy} onClick={() => void update(() => api.transcriptReview(jobId))}>{t('再読込', 'Reload')}</Button></div> : <p role="status">{t('保存した結果を読み込み中…', 'Loading saved results…')}</p> : <>
      <p className="notice">{t('この確認・編集・採用はローカル処理です。元の受信結果を保持し、カードに保存した内容は変更しません。', 'Review, editing and adoption are local operations. Original responses and saved cards are preserved.')}</p>
      <div className="scope-heading"><span>{timestamp(draft.startMs, true)} – {timestamp(draft.endMs, true)} · {draft.segments.length} {t('字幕', 'subtitles')}</span><Button disabled={busy} onClick={() => void update(() => api.transcriptReview(jobId))}><RotateCw size={14} />{t('保存結果を再読込', 'Refresh saved results')}</Button></div>
      {!!draft.pendingRanges.length && <p className="notice warning" role="status">{t(`${draft.pendingRanges.length} 区間に有効な字幕がありません。保存応答を確認するか、原音を聴いて区間を修正してください。未確定のまま採用はできません。`, `${draft.pendingRanges.length} ranges have no validated subtitles. Inspect saved responses or listen and correct each range. Unresolved ranges prevent adoption.`)}</p>}
      {!!view.rangeEdits?.length && <section>
        <Field label={t('修正する音声区間', 'Audio range to correct')}><select value={rangeOrdinal ?? ''} disabled={busy} onChange={event => setRangeOrdinal(event.target.value === '' ? undefined : Number(event.target.value))}><option value="">{t('区間を選択', 'Select a range')}</option>{draft.chunks.map(chunk => <option key={chunk.ordinal} value={chunk.ordinal}>{chunk.ordinal + 1}. {timestamp(chunk.coreStartMs, true)} – {timestamp(chunk.coreEndMs, true)} · {chunk.source === 'manual' ? t('手動修正', 'Manual correction') : chunk.status === 'pending' ? t('要修正', 'Needs correction') : t('字幕あり', 'Subtitles available')}</option>)}</select></Field>
        {!view.applied && view.manualEditingBlockedReason && <div className="notice warning" role="status"><p>{t('送信を一時停止し、実行中の要求の終了を待ってから編集してください。費用不明の予約は保持します。', 'Pause sending and wait for the in-flight request to finish before editing. Unknown cost reservations are retained.')}</p><Button disabled={busy || view.applied} onClick={() => void update(async () => { await api.pauseAiJob(jobId); return api.transcriptReview(jobId); })}><Pause size={14} />{t('送信を一時停止して確認', 'Pause sending and check')}</Button></div>}
        {rangeEdit && selectedChunk && <TranscriptRangeEditor key={`${selectedChunk.ordinal}:${rangeEdit.version}`} jobId={jobId} digest={draft.digest} chunk={selectedChunk} edit={rangeEdit} result={view.results?.find(result => result.ordinal === selectedChunk.ordinal)} disabled={busy || view.applied || !!view.manualEditingBlockedReason} update={update} play={cue => void play(cue)} />}
      </section>}
      {!!view.results?.length && <details className="draft-chunks"><summary>{t('保存応答の検証状態', 'Saved response validation status')}</summary>{view.results.map(result => <ResultEvidence key={`${result.ordinal}:${result.evidenceSha256}:${result.reparses.length}:${result.reparses.map(candidate => candidate.selected).join(',')}`} result={result} disabled={busy} applied={view.applied} draftDigest={draft.digest} jobId={jobId} update={update} play={cue => void play(cue)} />)}</details>}
      {draft.warnings?.map(warning => <section className="notice warning" key={warning.id}>
        <p>{draft.chunks.find(chunk => chunk.ordinal === warning.ordinal)?.source === 'manual'
          ? t('VADが発話を検出しなかった範囲に、手動字幕があります。原音と入力した字幕を確認してください。', 'Manual subtitles contain speech where VAD detected none. Review the original audio and the entered subtitles.')
          : warning.kind === 'speech_in_vad_pause_range'
          ? t('VADが休止と推定した区間内に、AIが発話の字幕を生成しました。VADの見落としやAIの誤生成の可能性があります。元の音声と字幕を確認してください。', 'AI returned speech inside a VAD-estimated pause. VAD may have missed speech, or AI may have invented it. Review the original audio and subtitles.')
          : t('発話を検出しなかった区間に、AIが字幕を生成しました。VADの見落としやAIの誤生成の可能性があります。元の音声と字幕を確認してください。', 'AI generated subtitles in a range where no speech was detected. VAD may have missed speech, or AI may have invented it. Check the original audio and subtitles.')}</p>
        <p>{timestamp(warning.startMs, true)} – {timestamp(warning.endMs, true)}</p>
        {warning.kind === 'speech_in_vad_pause_range' && <p className="helper-text">{t('2秒以上続く低い発話確率を根拠とし、休止の前後250ミリ秒を除いています。無音であることを保証する判定ではありません。', 'This estimate uses at least two seconds of consistently low speech probability and excludes 250 ms at each pause edge. It is not proof of silence.')}</p>}
        <div className="inline-actions"><Button disabled={busy} onClick={() => void play({ ...warning, text: '' })}><Play size={14} />{t('この区間を聴く', 'Listen to this range')}</Button><Button disabled={busy || view.applied || warning.acknowledged} onClick={() => void update(() => api.acknowledgeTranscriptWarning(jobId, draft.digest, warning.id))}>{warning.acknowledged ? t('確認済み', 'Reviewed') : t('原音と字幕を確認した', 'I checked the audio and subtitles')}</Button></div>
        <p className="helper-text">{t('確認しても元の応答は削除しません。字幕の採用は別の操作です。', 'Reviewing keeps the original response. Adopting subtitles is a separate action.')}</p>
      </section>)}
      <details className="draft-chunks"><summary>{t('元の音声区間とプレビューの状態', 'Original audio ranges and preview status')}</summary>{draft.chunks.map(chunk => <div key={chunk.ordinal}><span>{chunk.ordinal + 1}. {timestamp(chunk.coreStartMs, true)} – {timestamp(chunk.coreEndMs, true)}</span><Badge tone={chunk.status === 'pending' ? 'warning' : 'accent'}>{chunk.status === 'pending' ? t('有効な字幕なし', 'No validated subtitles') : t('プレビューあり', 'Preview available')}</Badge>{chunk.status === 'received' && <details><summary>{t('区間の字幕を表示', 'Show subtitles for this range')}</summary><Alternatives title={t('この区間のプレビュー', 'Preview for this range')} segments={chunk.segments} play={cue => void play(cue)} /></details>}</div>)}</details>
      <JoinedSubtitles draft={draft} disabled={busy} play={cue => void play(cue)} />
      {!!draft.conflicts.length && <><Field label={t('確認する境界', 'Boundary to review')}><select value={conflict?.id} disabled={busy} onChange={event => setBoundaryId(event.target.value)}>{draft.conflicts.map(item => <option key={item.id} value={item.id}>{timestamp(item.atMs, true)} · {item.resolution ? t('確認済み', 'Resolved') : t('要確認', 'Needs review')}</option>)}</select></Field>{conflict && <BoundaryEditor key={`${conflict.id}:${draft.digest}`} conflict={conflict} disabled={busy || view.applied} onResolve={choice => void update(() => api.resolveTranscriptBoundary(jobId, draft.digest, conflict.id, choice))} onRepair={() => void repair(conflict.id)} play={cue => void play(cue)} repairs={view.repairAlternatives.filter(item => item.boundaryId === conflict.id)} />}</>}
      <h3>{t('採用する字幕のプレビュー', 'Preview of subtitles to adopt')}</h3>
      {draft.segments.length ? <DraftCues cues={draft.segments} play={cue => void play(cue)} /> : <p className="helper-text">{draft.pendingRanges.length ? t('字幕の受信を待っています。', 'Waiting for subtitle results.') : t('現時点の字幕は空です。無音であることを原音で確認してください。', 'There are no subtitle cues. Confirm that the original audio is silent.')}</p>}
      {view.blockedReason && <p className="notice warning" role="status">{view.blockedReason}</p>}
      {!view.applied && <label className="check-field"><input type="checkbox" checked={acknowledged} disabled={!view.canApply || busy} onChange={event => setAcknowledged(event.target.checked)} /><span>{t('原音と境界を確認しました。この範囲の字幕をプレビューの内容で置き換えます。', 'I reviewed the audio and boundaries. Replace subtitles in this range with the preview.')}</span></label>}
      <footer className="modal-footer"><Button disabled={busy} onClick={onClose}>{t('閉じる', 'Close')}</Button><Button variant="primary" disabled={busy || view.applied || !view.canApply || !acknowledged} onClick={() => void update(() => api.applyTranscriptReview(jobId, draft.digest))}><Check size={15} />{view.applied ? t('採用済み', 'Adopted') : t('この字幕を採用', 'Adopt these subtitles')}</Button></footer>
    </>}
    {repairQuote && <Modal title={t('境界修復の見積もり', 'Boundary repair estimate')} onClose={() => { if (!busy) setRepairQuote(undefined); }}><QuoteApproval key={repairQuote.id} quote={repairQuote} busy={busy} onApprove={() => { setBusy(true); void run(async () => { await api.approveQuote(repairQuote); return api.transcriptReview(jobId); }).then(result => { if (result) { setView(result); setRepairQuote(undefined); setAcknowledged(false); } setBusy(false); }); }} /></Modal>}
  </Modal>;
}
