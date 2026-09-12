// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Check, Download, Play, Sparkles, Trash2 } from 'lucide-react';
import { api, nativeAvailable } from '../api';
import type { AiModelPreference, AiPurpose, AiQuote, Media, ReviewCue, TranscriptReview, VocabularyCandidate } from '../api';
import { useApp } from '../context';
import { draftStudyApi, savedDraftText } from '../draft-study';
import type { DraftSelection } from '../draft-study';
import { parseTimestamp, timestamp } from '../utils';
import { QuoteApproval } from './AiDialog';
import { ModelEditor, emptyModel } from './ModelEditor';
import { Badge, Button, Field, Modal } from './ui';
import './draft-study.css';

type Range = { startMs: number; endMs: number };
type PlayRange = (range: Range) => Promise<void> | void;
const PAGE_SIZE = 40;
const BLOCK_PAGE_SIZE = 8;

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return mounted;
}

function cueOrigin(cue: ReviewCue, review: TranscriptReview) {
  const sources = review.draft.chunks.filter(chunk => chunk.segments.some(segment => segment.startMs === cue.startMs && segment.endMs === cue.endMs && segment.text === cue.text)).map(chunk => chunk.source);
  for (const join of review.draft.edgeGroupJoins || []) {
    if (join.joined.startMs !== cue.startMs || join.joined.endMs !== cue.endMs || join.joined.text !== cue.text) continue;
    sources.push(review.draft.chunks.find(chunk => chunk.ordinal === join.leftOrdinal)?.source, review.draft.chunks.find(chunk => chunk.ordinal === join.rightOrdinal)?.source);
  }
  if (sources.length && sources.every(source => source === 'manual')) return 'manual';
  if (sources.some(source => source === 'manual')) return 'mixed';
  if (sources.length && sources.every(source => source === 'provider' || source === 'local_reparse')) return 'ai';
  return 'unknown';
}

export function DraftStudyPanel(props: { media: Media; onPlay: PlayRange; onReview: (jobId: string) => void; playbackReady: boolean }) {
  // A media switch drops editor state before any late asynchronous result can be shown.
  return <DraftStudyContent key={props.media.id} {...props} />;
}

function DraftStudyContent({ media, onPlay, onReview, playbackReady }: { media: Media; onPlay: PlayRange; onReview: (jobId: string) => void; playbackReady: boolean }) {
  const { data, t, run } = useApp();
  const mounted = useMounted();
  const jobs = data?.jobs.filter(job => job.mediaId === media.id && job.transcriptReview) || [];
  const [chosenJob, setChosenJob] = useState('');
  const jobId = jobs.some(job => job.id === chosenJob) ? chosenJob : jobs[0]?.id;
  const identity = useRef(jobId);
  identity.current = jobId;
  const [loaded, setLoaded] = useState<{ jobId: string; view: TranscriptReview }>();
  const view = loaded && loaded.jobId === jobId ? loaded.view : undefined;
  const [bookmarks, setBookmarks] = useState<DraftSelection[]>([]);
  const [active, setActive] = useState<DraftSelection>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const mutation = useRef(0);
  const preparing = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [blockPage, setBlockPage] = useState(0);
  const [sourceText, setSourceText] = useState<Record<number, string | null>>({});
  const [reading, setReading] = useState<number>();

  useEffect(() => {
    setSelectedIds([]); setPage(0); setBlockPage(0); setSourceText({}); setReading(undefined);
  }, [jobId]);

  useEffect(() => {
    if (!nativeAvailable()) { setLoading(false); return; }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const revision = mutation.current;
      const results = await Promise.allSettled([draftStudyApi.list(media.id), jobId ? api.transcriptReview(jobId) : Promise.resolve(undefined)]);
      if (disposed || identity.current !== jobId) return;
      if (revision === mutation.current) {
        const [selections, review] = results;
        if (selections.status === 'fulfilled') setBookmarks(selections.value);
        if (review.status === 'fulfilled' && review.value && jobId) setLoaded({ jobId, view: review.value });
        const failed = results.find(result => result.status === 'rejected');
        setError(failed?.status === 'rejected' ? String(failed.reason instanceof Error ? failed.reason.message : failed.reason) : '');
      }
      setLoading(false);
      // Schedule only after completion, so a slow native read cannot overlap the next poll.
      timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [jobId, media.id, refresh]);

  async function prepare(request: { jobId: string; cueIds?: string[]; ordinal?: number }) {
    if (preparing.current) return;
    preparing.current = true; setBusy(true); mutation.current++;
    const selected = await run(() => draftStudyApi.prepare(request));
    if (!mounted.current) return;
    preparing.current = false; setBusy(false); mutation.current++;
    if (selected) {
      setBookmarks(items => [selected, ...items.filter(item => item.id !== selected.id)]);
      if (identity.current === request.jobId) setActive(selected);
    }
  }
  async function readSource(ordinal: number) {
    if (!jobId || reading !== undefined) return;
    const requestedJob = jobId;
    setReading(ordinal);
    const result = await run(() => api.transcriptResultDetail(requestedJob, ordinal));
    if (!mounted.current || identity.current !== requestedJob) return;
    setReading(undefined);
    if (result) setSourceText(items => ({ ...items, [ordinal]: savedDraftText(result.evidence?.response) ?? null }));
  }
  function saved(selection: DraftSelection) {
    mutation.current++;
    setBookmarks(items => [selection, ...items.filter(item => item.id !== selection.id)]);
    setActive(selection);
  }
  const cues = view?.draft.segments || [];
  const chosen = cues.filter(cue => selectedIds.includes(cue.id));
  const first = cues.findIndex(cue => cue.id === chosen[0]?.id);
  const consecutive = chosen.length > 0 && chosen.length <= 50 && chosen.length === selectedIds.length && chosen.every((cue, index) => cues[first + index]?.id === cue.id);
  const effectivePage = Math.min(page, Math.max(0, Math.ceil(cues.length / PAGE_SIZE) - 1));
  const chunks = view?.draft.chunks || [];
  const effectiveBlockPage = Math.min(blockPage, Math.max(0, Math.ceil(chunks.length / BLOCK_PAGE_SIZE) - 1));
  const originLabel = (origin: string) => origin === 'manual' ? t('手動修正', 'Manual correction') : origin === 'mixed' ? t('AI・手動の下書き', 'AI / manual draft') : origin === 'ai' ? t('AIの下書き', 'AI draft') : t('出所は全体の確認画面を参照', 'See full review for provenance');
  if (!jobs.length && !bookmarks.length && !loading) return null;

  return <section className="draft-study" aria-label={t('下書きから学ぶ', 'Study from drafts')}>
    <header className="draft-study-heading"><div><h2>{t('気になるところから、学び始める', 'Start with a moment that interests you')}</h2><p>{t('受信済みの下書きを読み、必要な表現だけ原音で確認できます。', 'Read available drafts and check the phrases you want to learn against the audio.')}</p></div><Badge tone="warning">{t('下書き', 'Draft')}</Badge></header>
    {error && <p className="notice warning" role="status">{t('下書きの更新に失敗しました。', 'Could not refresh drafts.')} {error} <Button onClick={() => setRefresh(value => value + 1)}>{t('再読込', 'Reload')}</Button></p>}
    {jobs.length > 0 && <Field label={t('文字起こしの下書き', 'Transcription draft')}><select value={jobId || ''} disabled={busy} onChange={event => { setChosenJob(event.target.value); setActive(undefined); }}>{jobs.map((job, index) => <option key={job.id} value={job.id}>{index + 1}. {job.createdAt} · {job.status}</option>)}</select></Field>}
    {loading && !view && <p role="status">{t('下書きを読み込み中…', 'Loading drafts…')}</p>}
    {view && <>
      <div className="scope-heading"><span>{timestamp(view.draft.startMs)}–{timestamp(view.draft.endMs)} · {cues.length} {t('字幕', 'subtitles')}</span><Button onClick={() => onReview(view.jobId)}>{t('全体を確認・採用', 'Review or adopt the full result')}</Button></div>
      {(view.draft.pendingRanges.length > 0 || view.draft.conflicts.some(conflict => !conflict.resolution)) && <p className="helper-text">{t('未受信・要確認の区間があります。ほかの区間から学習を続けられます。', 'Some ranges are pending or need review. You can keep studying other moments.')}</p>}
      <div className="draft-study-cues" role="list" aria-label={t('利用できる下書き字幕', 'Available draft subtitles')}>
        {cues.slice(effectivePage * PAGE_SIZE, (effectivePage + 1) * PAGE_SIZE).map(cue => {
          const conflict = view.draft.conflicts.some(item => !item.resolution && item.startMs < cue.endMs && item.endMs > cue.startMs);
          return <article key={cue.id} role="listitem" className="draft-study-cue">
            <input type="checkbox" aria-label={t(`字幕を選ぶ: ${cue.text}`, `Select subtitle: ${cue.text}`)} checked={selectedIds.includes(cue.id)} disabled={busy} onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, cue.id] : ids.filter(id => id !== cue.id))} />
            <div><p>{cue.text}</p><div className="draft-study-meta"><Badge>{originLabel(cueOrigin(cue, view))}</Badge><span>{t('字幕区間', 'Subtitle interval')}</span>{(conflict || cue.status === 'provisional') && <Badge tone="warning">{conflict ? t('候補が競合', 'Conflicting alternatives') : t('つなぎ目は未確定', 'Join not finalized')}</Badge>}</div></div>
            <Button disabled={!playbackReady || busy} onClick={() => void run(async () => { await onPlay(cue); })}><Play size={13} />{timestamp(cue.startMs, true)}–{timestamp(cue.endMs, true)}</Button>
          </article>;
        })}
        {!cues.length && <p className="helper-text">{t('時刻付きの下書きはまだありません。音声区間を開いて、保存済みの本文を確認できます。', 'No timed draft is available yet. Open a source audio range to inspect any saved text.')}</p>}
      </div>
      {cues.length > PAGE_SIZE && <div className="draft-study-pagination"><Button disabled={effectivePage === 0} onClick={() => setPage(effectivePage - 1)}>{t('前へ', 'Previous')}</Button><span>{effectivePage + 1} / {Math.ceil(cues.length / PAGE_SIZE)}</span><Button disabled={(effectivePage + 1) * PAGE_SIZE >= cues.length} onClick={() => setPage(effectivePage + 1)}>{t('次へ', 'Next')}</Button></div>}
      <div className="inline-actions"><Button disabled={busy || !consecutive} onClick={() => void prepare({ jobId: view.jobId, cueIds: chosen.map(cue => cue.id) })}><BookmarkPlus size={15} />{t('選んだ字幕をあとで確認', 'Keep selected subtitles for later')}</Button>{selectedIds.length > 0 && <Button disabled={busy} onClick={() => setSelectedIds([])}>{t('選択を解除', 'Clear selection')}</Button>}</div>
      {selectedIds.length > 0 && !consecutive && <p className="helper-text">{t('隣り合う字幕を50件以内で選んでください。更新で字幕が変わった場合は選び直してください。', 'Select up to 50 consecutive subtitles. Reselect if the draft has changed.')}</p>}
      <details className="draft-study-blocks"><summary>{t('音声区間と保存された本文', 'Source audio ranges and saved text')}</summary><p className="helper-text">{t('ここで表示する時刻は取得元の音声範囲です。本文の単語や文に対応する時刻ではありません。', 'These times identify the source audio block. They do not locate individual words or sentences in its text.')}</p>
        {chunks.slice(effectiveBlockPage * BLOCK_PAGE_SIZE, (effectiveBlockPage + 1) * BLOCK_PAGE_SIZE).map(chunk => <article key={chunk.ordinal} className="draft-study-block">
          <div className="scope-heading"><strong>{t('音声区間', 'Source block')} {chunk.ordinal + 1} · {timestamp(chunk.requestStartMs, true)}–{timestamp(chunk.requestEndMs, true)}</strong><Badge tone={chunk.status === 'pending' ? 'warning' : 'neutral'}>{chunk.status === 'pending' ? t('字幕の時刻が未確定', 'Subtitle timing unavailable') : originLabel(chunk.source === 'manual' ? 'manual' : 'ai')}</Badge></div>
          <div className="inline-actions"><Button disabled={!playbackReady || busy} onClick={() => void run(async () => { await onPlay({ startMs: chunk.requestStartMs, endMs: chunk.requestEndMs }); })}><Play size={13} />{t('取得元の音声を聴く', 'Play source block')}</Button><Button disabled={busy || reading !== undefined} onClick={() => void readSource(chunk.ordinal)}>{t('保存済みの本文を表示', 'Show saved text')}</Button><Button disabled={busy} onClick={() => void prepare({ jobId: view.jobId, ordinal: chunk.ordinal })}><BookmarkPlus size={13} />{t('この音声区間をあとで確認', 'Keep this source block for later')}</Button></div>
          {sourceText[chunk.ordinal] !== undefined && <div className="draft-study-raw">{sourceText[chunk.ordinal] === null ? <p className="helper-text">{t('表示できる本文がありません。原音を聴いて入力するか、全体の確認画面で保存応答を確認してください。', 'No unambiguous saved text is available. Listen and enter text, or inspect the response in the full review.')}</p> : <><Badge>{t('AI本文・時刻との対応は未確認', 'AI text · no verified text timing')}</Badge><p>{sourceText[chunk.ordinal]}</p></>}</div>}
        </article>)}
        {chunks.length > BLOCK_PAGE_SIZE && <div className="draft-study-pagination"><Button disabled={!effectiveBlockPage} onClick={() => setBlockPage(effectiveBlockPage - 1)}>{t('前の音声区間', 'Previous source blocks')}</Button><span>{effectiveBlockPage + 1} / {Math.ceil(chunks.length / BLOCK_PAGE_SIZE)}</span><Button disabled={(effectiveBlockPage + 1) * BLOCK_PAGE_SIZE >= chunks.length} onClick={() => setBlockPage(effectiveBlockPage + 1)}>{t('次の音声区間', 'Next source blocks')}</Button></div>}
      </details>
    </>}
    {!!bookmarks.length && <div className="draft-study-bookmarks"><h3>{t('あとで確認する表現', 'Kept for review')}</h3><div className="draft-study-bookmark-list">{bookmarks.map(bookmark => <button key={bookmark.id} className={active?.id === bookmark.id ? 'selected' : ''} disabled={busy} onClick={() => setActive(bookmark)}><span>{bookmark.text.trim() || t('本文を入力する音声区間', 'Source block awaiting text')}</span><small>{timestamp(bookmark.startMs)}–{timestamp(bookmark.endMs)} · {bookmark.confirmed ? t('学習用に確認済み', 'Checked for learning') : t('未確認', 'Not checked')}</small></button>)}</div></div>}
    {active && <DraftSelectionEditor key={`${active.id}:${active.version}`} selection={{ ...active, canConfirm: bookmarks.find(item => item.id === active.id)?.canConfirm ?? active.canConfirm, blockingReasons: bookmarks.find(item => item.id === active.id)?.blockingReasons ?? active.blockingReasons }} stale={active.stale || !bookmarks.some(item => item.id === active.id) || bookmarks.some(item => item.id === active.id && (item.version !== active.version || item.stale))} playbackReady={playbackReady} onPlay={onPlay} onSaved={saved} onClose={() => setActive(undefined)} onRemoved={() => { mutation.current++; setBookmarks(items => items.filter(item => item.id !== active.id)); setActive(undefined); }} />}
  </section>;
}

function DraftSelectionEditor({ selection, stale, playbackReady, onPlay, onSaved, onClose, onRemoved }: { selection: DraftSelection; stale: boolean; playbackReady: boolean; onPlay: PlayRange; onSaved: (selection: DraftSelection) => void; onClose: () => void; onRemoved: () => void }) {
  const { t, run } = useApp();
  const mounted = useMounted();
  const [text, setText] = useState(selection.text);
  const [start, setStart] = useState(timestamp(selection.startMs, true));
  const [end, setEnd] = useState(timestamp(selection.endMs, true));
  const [acknowledged, setAcknowledged] = useState(selection.confirmed);
  const [listened, setListened] = useState(selection.confirmed);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const editRevision = useRef(0);
  const [dialog, setDialog] = useState<'card' | 'ai'>();
  const [candidate, setCandidate] = useState<VocabularyCandidate>();
  const [candidates, setCandidates] = useState<VocabularyCandidate[]>([]);
  const [candidateError, setCandidateError] = useState('');
  const [format, setFormat] = useState<'json' | 'srt' | 'vtt'>('json');
  const startMs = parseTimestamp(start), endMs = parseTimestamp(end);
  const rangeValid = startMs !== null && endMs !== null && startMs >= selection.sourceStartMs && endMs <= selection.sourceEndMs && endMs > startMs;
  const valid = rangeValid && !!text.trim() && new TextEncoder().encode(text).length <= 16000;
  const dirty = text !== selection.text || startMs !== selection.startMs || endMs !== selection.endMs;
  const confirmed = selection.confirmed && !dirty && !stale;
  useEffect(() => {
    if (!confirmed) { setCandidates([]); return; }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const result = await draftStudyApi.candidates({ id: selection.id, version: selection.version });
        if (!disposed) { setCandidates(result); setCandidateError(''); }
      } catch (error) { if (!disposed) setCandidateError(String(error instanceof Error ? error.message : error)); }
      if (!disposed) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [confirmed, selection.id, selection.version]);
  function edit(action: () => void) { action(); editRevision.current++; setAcknowledged(false); setListened(false); }
  async function operate<T>(action: () => Promise<T>, done?: (result: T) => void, allowStale = false) {
    if (locked.current || (stale && !allowStale)) return;
    locked.current = true; setBusy(true);
    const result = await run(action);
    if (!mounted.current) return;
    locked.current = false; setBusy(false);
    if (result !== undefined) done?.(result);
  }
  async function play() {
    if (!rangeValid || !playbackReady) return;
    const revision = editRevision.current;
    await operate(async () => { await onPlay({ startMs, endMs }); return true; }, () => { if (editRevision.current === revision) setListened(true); });
  }
  function save(confirm: boolean) {
    if (!rangeValid || (confirm && (!valid || !acknowledged || !listened || !selection.canConfirm))) return;
    void operate(() => draftStudyApi.update({ id: selection.id, version: selection.version, text, startMs, endMs, confirm }), onSaved);
  }
  return <section className="draft-study-editor" aria-label={t('選んだ表現を確認', 'Check selected phrase')}>
    <div className="scope-heading"><h3>{t('この表現を、自分の言葉に', 'Make this phrase yours')}</h3><Badge tone={confirmed ? 'accent' : 'warning'}>{confirmed ? t('学習用に確認済み', 'Checked for learning') : t('確認前', 'Needs your check')}</Badge></div>
    <p className="helper-text">{selection.origin === 'manual' ? t('手動で修正した本文', 'Manually corrected text') : selection.origin === 'mixed' ? t('AI・手動修正を含む本文', 'Text from AI and manual corrections') : t('AIから受信した本文', 'Text received from AI')} · {selection.timing === 'source_block' ? t('時刻は取得元の音声範囲', 'Times locate the source block') : selection.timing === 'manual' ? t('利用者が指定した再生区間', 'User-selected replay interval') : t('時刻は字幕区間', 'Times locate subtitle intervals')}</p>
    <p className="helper-text">{t('原音を再生し、本文と再生範囲を確認してください。保存したカードには、この時点の内容と音声が残ります。', 'Play the audio and check the text and replay interval. A saved card keeps this version of the text and audio.')}</p>
    <p className="helper-text">{t('この確認は選んだ表現だけが対象です。元の下書きの競合や他の区間の状態は保持します。', 'This check covers only your excerpt. Original draft conflicts and the status of other ranges are retained.')}</p>
    {stale && <p className="notice warning" role="status">{t('この保存内容は別の操作で更新されました。上の一覧から選び直してください。', 'This bookmark changed elsewhere. Select it again from the list above.')}</p>}
    {selection.blockingReasons.map((reason, index) => <p className="notice warning" role="status" key={index}>{reason}</p>)}
    <Field label={t('学ぶ本文', 'Text to learn')}><textarea value={text} rows={4} maxLength={16000} disabled={busy || stale} onChange={event => edit(() => setText(event.target.value))} /></Field>
    {new TextEncoder().encode(text).length > 16000 && <p className="field-error">{t('本文が長すぎます。学びたい部分に絞ってから確認してください。', 'This text is too long. Narrow it to the passage you want to study before confirming.')}</p>}
    <div className="field-row"><Field label={t('再生開始', 'Replay from')}><input value={start} disabled={busy || stale} onChange={event => edit(() => setStart(event.target.value))} /></Field><Field label={t('再生終了', 'Replay to')}><input value={end} disabled={busy || stale} onChange={event => edit(() => setEnd(event.target.value))} /></Field></div>
    <p className="helper-text">{t('取得元の範囲', 'Source bounds')}: {timestamp(selection.sourceStartMs, true)}–{timestamp(selection.sourceEndMs, true)}</p>
    {!rangeValid && <p className="field-error">{t('取得元の範囲内で、開始より後の終了時刻を指定してください。', 'Choose a positive-width replay interval within the source bounds.')}</p>}
    <Button disabled={busy || stale || !rangeValid || !playbackReady} onClick={() => void play()}><Play size={14} />{t('この本文の原音を再生', 'Play audio for this text')}</Button>
    <label className="check-field"><input type="checkbox" checked={acknowledged} disabled={busy || stale || !valid || !listened} onChange={event => setAcknowledged(event.target.checked)} /><span>{t('原音を聴き、この本文と再生範囲を学習に使うことを確認しました', 'I listened and checked this text and replay interval for learning')}</span></label>
    {!listened && <p className="helper-text">{t('再生して確認すると、カード保存やAI解説へ進めます。', 'Play and check this version before saving a card or requesting AI help.')}</p>}
    <div className="inline-actions"><Button disabled={busy || stale || !rangeValid} onClick={() => save(false)}><BookmarkPlus size={14} />{t('未確認で保存・あとで続ける', 'Save unchecked for later')}</Button><Button variant="primary" disabled={busy || stale || !valid || !acknowledged || !listened || confirmed || !selection.canConfirm} onClick={() => save(true)}><Check size={14} />{t('この本文と音声を確認済みにする', 'Confirm this text and audio')}</Button></div>
    <div className="inline-actions"><Button disabled={busy || !confirmed} onClick={() => { setCandidate(undefined); setDialog('card'); }}><BookmarkPlus size={14} />{t('音声付きカードを作る', 'Create an audio card')}</Button><Button disabled={busy || !confirmed} onClick={() => setDialog('ai')}><Sparkles size={14} />{t('この表現をAIに相談', 'AI help for this phrase')}</Button></div>
    {confirmed && <section className="draft-study-suggestions" aria-label={t('この本文へのAI候補', 'AI suggestions for this text')}>
      {candidateError && <p className="notice warning" role="status">{t('保存済みのAI候補を読み込めませんでした。', 'Could not load saved AI suggestions.')} {candidateError}</p>}
      {candidates.length ? <><h4>{t('受信した候補を確認する', 'Review received suggestions')}</h4><p className="helper-text">{t('この確認済み本文に対する候補です。内容を確認してから保存してください。', 'These suggestions belong to this checked text. Review their contents before saving.')}</p>{candidates.map(item => <article key={item.id}><strong>{item.term}</strong><p>{item.meaning}</p>{item.explanation && <p>{item.explanation}</p>}<Button disabled={busy} onClick={() => { setCandidate(item); setDialog('card'); }}>{t('この候補を確認して保存', 'Review and save this suggestion')}</Button></article>)}</> : <p className="helper-text">{t('AI処理を実行すると、この本文に対する候補をここで確認できます。', 'After an AI job finishes, its suggestions for this text appear here.')}</p>}
    </section>}
    <details><summary>{t('この下書きの書き出し・削除', 'Export or remove this draft')}</summary><p className="helper-text">{t('未確認の下書きは状態付きJSONとして書き出せます。SRT・VTTは本文と区間を確認してから使えます。', 'Unchecked drafts can be exported as JSON with their status. SRT and VTT require confirmed text and intervals.')}</p><div className="inline-actions"><select aria-label={t('下書きの形式', 'Draft export format')} value={format} disabled={busy || dirty} onChange={event => setFormat(event.target.value as typeof format)}><option value="json">JSON</option><option value="srt" disabled={!confirmed}>SRT</option><option value="vtt" disabled={!confirmed}>VTT</option></select><Button disabled={busy || dirty || (format !== 'json' && !confirmed)} onClick={() => void operate(async () => { await draftStudyApi.export({ id: selection.id, version: selection.version, format }); return true; }, undefined, format === 'json')}><Download size={14} />{t('この下書きを書き出す', 'Export this draft')}</Button><Button disabled={busy} onClick={() => void operate(async () => { await draftStudyApi.remove({ id: selection.id, version: selection.version }); return true; }, onRemoved, true)}><Trash2 size={14} />{t('あとで確認する一覧から外す', 'Remove from kept drafts')}</Button></div></details>
    <Button variant="ghost" disabled={busy} onClick={onClose}>{t('閉じて視聴を続ける', 'Close and keep watching')}</Button>
    {dialog === 'card' && confirmed && <DraftCardDialog selection={selection} candidate={candidate} onClose={() => setDialog(undefined)} />}
    {dialog === 'ai' && confirmed && <DraftAiDialog selection={selection} onClose={() => setDialog(undefined)} />}
  </section>;
}

function DraftCardDialog({ selection, candidate, onClose }: { selection: DraftSelection; candidate?: VocabularyCandidate; onClose: () => void }) {
  const { t, run } = useApp();
  const mounted = useMounted();
  const [term, setTerm] = useState(candidate?.term || '');
  const [meaning, setMeaning] = useState(candidate?.meaning || '');
  const [explanation, setExplanation] = useState(candidate?.explanation || '');
  const [translation, setTranslation] = useState(candidate?.translation || '');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  async function save() {
    if (locked.current || !term.trim() || !meaning.trim()) return;
    locked.current = true; setBusy(true);
    const result = await run(async () => { await draftStudyApi.saveCard({ selectionId: selection.id, version: selection.version, term: term.trim(), meaning: meaning.trim(), explanation: explanation.trim() || undefined, translation: translation.trim() || undefined }); return true; }, t('音声付きカードを保存しました。', 'Audio card saved.'));
    if (!mounted.current) return;
    locked.current = false; setBusy(false);
    if (result) onClose();
  }
  return <Modal title={t('この表現を覚える', 'Keep this phrase')} onClose={() => { if (!busy) onClose(); }}>
    <p className="draft-study-example">{selection.text}</p><p className="helper-text">{timestamp(selection.startMs, true)}–{timestamp(selection.endMs, true)} · {t('確認した区間と、設定した前後の余白の音声を保存します。', 'Save audio from the checked interval with the configured replay context.')}</p>
    <Field label={t('覚えたい表現', 'Phrase to remember')}><input value={term} maxLength={500} disabled={busy} onChange={event => setTerm(event.target.value)} /></Field><Field label={t('意味', 'Meaning')}><textarea value={meaning} maxLength={4000} disabled={busy} onChange={event => setMeaning(event.target.value)} /></Field>
    <Field label={t('訳（任意）', 'Translation (optional)')}><textarea value={translation} maxLength={16000} disabled={busy} onChange={event => setTranslation(event.target.value)} /></Field><Field label={t('解説・メモ（任意）', 'Explanation or notes (optional)')}><textarea value={explanation} maxLength={16000} disabled={busy} onChange={event => setExplanation(event.target.value)} /></Field>
    <footer className="modal-footer"><Button disabled={busy} onClick={onClose}>{t('キャンセル', 'Cancel')}</Button><Button variant="primary" busy={busy} disabled={!term.trim() || !meaning.trim()} onClick={() => void save()}>{t('カードと音声を保存', 'Save card and audio')}</Button></footer>
  </Modal>;
}

function DraftAiDialog({ selection, onClose }: { selection: DraftSelection; onClose: () => void }) {
  const { t, data, run } = useApp();
  const mounted = useMounted();
  const [focusTerm, setFocusTerm] = useState('');
  const [models, setModels] = useState<Partial<Record<AiPurpose, AiModelPreference>>>({});
  const purpose: AiPurpose = focusTerm.trim() ? 'explanation' : 'vocabulary';
  const model = models[purpose] || data?.settings.aiModels?.[purpose] || emptyModel(purpose);
  const [quote, setQuote] = useState<AiQuote>();
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  async function estimate() {
    if (locked.current || !model.modelId.trim() || !Number.isInteger(model.maxOutputTokens) || model.maxOutputTokens <= 0) return;
    locked.current = true; setBusy(true);
    const result = await run(() => draftStudyApi.createQuote({ selectionId: selection.id, version: selection.version, focusTerm: focusTerm.trim() || undefined, model }));
    if (!mounted.current) return;
    locked.current = false; setBusy(false); if (result) setQuote(result);
  }
  async function approve() {
    if (!quote || locked.current) return;
    locked.current = true; setBusy(true);
    const result = await run(async () => { await api.approveQuote(quote); return true; }, t('承認したAI処理を開始しました。', 'The approved AI job has started.'));
    if (!mounted.current) return;
    locked.current = false; setBusy(false); if (result) onClose();
  }
  return <Modal title={t('この表現に、AIの助けを', 'AI for this phrase')} onClose={() => { if (!busy) onClose(); }}>
    <p className="draft-study-example">{selection.text}</p>
    {quote ? <QuoteApproval key={quote.id} quote={quote} busy={busy} onApprove={() => void approve()} /> : <><Field label={t('解説する表現（空欄なら候補を提案）', 'Phrase to explain (leave blank for suggestions)')}><input value={focusTerm} maxLength={500} disabled={busy} onChange={event => setFocusTerm(event.target.value)} /></Field><ModelEditor value={model} onChange={value => setModels(items => ({ ...items, [purpose]: value }))} purpose={purpose} location={data?.settings.vertexLocation || 'global'} disabled={busy} /><Button variant="primary" busy={busy} disabled={!model.modelId.trim() || !Number.isInteger(model.maxOutputTokens) || model.maxOutputTokens <= 0} onClick={() => void estimate()}>{t('この確認済み本文で見積もる', 'Estimate using this checked text')}</Button></>}
  </Modal>;
}
