// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { listen } from '@tauri-apps/api/event';
import { ArrowDownToLine, ArrowLeft, AudioLines, BookOpen, BookmarkPlus, Check, ChevronDown, Crosshair, Download, Edit3, FileSearch, FolderOpen, Languages, ListVideo, Maximize, Pause, Play, Repeat2, RotateCcw, RotateCw, Search, Sparkles, Subtitles, Volume2, X } from 'lucide-react';
import { api, nativeAvailable } from '../api';
import type { AiQuote, Media, PlayerState, SubtitleSegment, VocabularyCandidate } from '../api';
import { useApp } from '../context';
import { activeSegment, languageName, parseTimestamp, timestamp } from '../utils';
import { Badge, Button, EmptyState, Field, IconButton, Modal } from '../components/ui';
import { AiDialog } from '../components/AiDialog';
import { DraftStudyPanel } from '../components/DraftStudyPanel';
import { TranscriptReviewDialog } from '../components/TranscriptReview';
import { JobActions } from '../components/JobActions';
import { TransferDialog } from '../components/TransferDialog';
import { RemoveMediaDialog, SubtitleSourceDialog } from '../components/MediaManagement';

type SelectedContext = SubtitleSegment & { sourceCueIds?: string[] };

function NativePlayer({ media, selected, selectionRevision, onPosition, onReady, draftMode = false }: { media: Media; draftMode?: boolean; selected?: SubtitleSegment; selectionRevision: number; onPosition: (positionMs: number) => void; onReady: (ready: boolean) => void }) {
  const { t, notify, surfaceHidden, refresh } = useApp();
  const viewport = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PlayerState>();
  const [loaded, setLoaded] = useState(false);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [loop, setLoop] = useState(false);
  const loopActive = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  const control = useCallback(async (request: Parameters<typeof api.player>[0]) => { if ((request.action === 'seek' || request.action === 'source-seek')) { loopActive.current = false; setLoop(false); } try { await api.player(request); } catch (error) { notify(String(error), 'error'); } }, [notify]);
  const selectionSignature = selected ? JSON.stringify([selected.id, selected.startMs, selected.endMs]) : '';
  const previousSelection = useRef({ mediaId: media.id, revision: selectionRevision, signature: selectionSignature });
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { mediaId: media.id, revision: selectionRevision, signature: selectionSignature };
    // Explicit replays already clear the native loop with their seek. Only a
    // source refresh must clear it here, without erasing a newly requested range stop.
    if (loopActive.current && previous.mediaId === media.id && previous.revision === selectionRevision && previous.signature !== selectionSignature) {
      void api.player({ action: 'loop' }).catch(error => notify(String(error), 'error'));
    }
    loopActive.current = false;
    setLoop(false);
  }, [selectionSignature, media.id, selectionRevision, notify]);
  useEffect(() => {
    if (!nativeAvailable()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    setLoaded(false); onReady(false);
    let requested = false;
    void listen<PlayerState>('player-state', event => { if (!disposed && requested) { setState(event.payload); setLoaded(event.payload.ready === true); onReady(event.payload.ready === true); } }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    void api.loadMedia(media.id).then(async () => { requested = true; const current = await api.playerState(); if (!disposed) { setState(current); setLoaded(current.ready === true); onReady(current.ready === true); } }).catch(error => notify(String(error), 'error'));
    return () => { disposed = true; stop?.(); void api.player({ action: 'hide' }).catch(() => {}); };
  }, [media.id, media.path, notify, onReady]);
  useEffect(() => { if (state) onPosition(state.positionMs); }, [state?.positionMs, onPosition]);
  useEffect(() => {
    if (!nativeAvailable()) return;
    let frame = 0;
    let last = '';
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rect = viewport.current?.getBoundingClientRect();
        const main = viewport.current?.closest('.page-content')?.getBoundingClientRect();
        const hidden = surfaceHidden || !loaded || !rect || rect.width < 1 || rect.height < 1 || rect.top < (main?.top || 0) || rect.bottom > Math.min(main?.bottom || window.innerHeight, window.innerHeight) || document.hidden;
        const request = hidden ? { action: 'hide' as const } : { action: 'bounds' as const, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scaleFactor: window.devicePixelRatio } };
        const signature = JSON.stringify(request);
        if (signature !== last) { last = signature; void api.player(request).catch(() => {}); }
      });
    };
    const observer = new ResizeObserver(update);
    if (viewport.current) observer.observe(viewport.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    document.addEventListener('visibilitychange', update);
    update();
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); document.removeEventListener('visibilitychange', update); };
  }, [loaded, surfaceHidden, media.id]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (surfaceHidden || !loaded || (event.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(event.target.tagName) || event.target.isContentEditable))) return;
      if (event.code === 'Space') { event.preventDefault(); void control({ action: state?.paused ? 'play' : 'pause' }); }
      if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') { event.preventDefault(); void control({ action: 'seek', value: Math.max(0, (state?.positionMs || 0) + (event.code === 'ArrowLeft' ? -5000 : 5000)) }); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [loaded, surfaceHidden, state?.paused, state?.positionMs, control]);
  const duration = state?.durationMs || media.durationMs;
  async function selectAudio(id: number) { await control({ action: 'track', trackKind: 'audio', value: id }); await refresh(); }
  useEffect(() => { if (!loaded) return; void control({ action: 'draft-mode', value: draftMode ? 1 : 0 }); return () => { if (draftMode) void api.player({ action: 'draft-mode', value: 0 }).catch(() => {}); }; }, [draftMode, loaded, control]);
  async function setSentencePause(enabled: boolean) {
    try {
      await api.player({ action: 'sentence-pause', value: enabled ? 1 : 0 });
      setState(await api.playerState());
      await refresh();
    } catch (error) { notify(String(error), 'error'); }
  }
  const position = seekDraft ?? state?.positionMs ?? media.lastPositionMs;
  function commitSeek() { if (seekDraft !== null) { void control({ action: 'seek', value: seekDraft }); setSeekDraft(null); } }
  return <section className="player-card" aria-label={t('メディアプレイヤー', 'Media player')}>
    <div ref={viewport} className="native-player-viewport" data-testid="native-player-viewport"><div className="video-placeholder"><span className="large-brand-mark">S<span>·</span></span><p>{state?.error || (loaded ? '' : t('プレイヤーを準備しています', 'Preparing your player'))}</p></div></div>
    <div className="player-controls">
      <div className="seek-control"><input type="range" min="0" max={Math.max(duration, 1)} step="100" value={Math.min(position, duration || 1)} disabled={!loaded || !duration} onChange={event => setSeekDraft(Number(event.target.value))} onPointerUp={commitSeek} onKeyUp={commitSeek} onBlur={commitSeek} aria-label={t('再生位置', 'Playback position')} style={{ '--progress': `${duration ? position / duration * 100 : 0}%` } as React.CSSProperties} /></div>
      <div className="player-control-row"><div className="control-cluster"><IconButton label={t('5 秒戻る', 'Back 5 seconds')} disabled={!loaded} onClick={() => void control({ action: 'seek', value: Math.max(0, position - 5000) })}><RotateCcw size={18} /></IconButton><IconButton className="play-button" label={state?.paused ? t('再生', 'Play') : t('一時停止', 'Pause')} disabled={!loaded} onClick={() => void control({ action: state?.paused ? 'play' : 'pause' })}>{state?.paused !== false ? <Play size={19} fill="currentColor" /> : <Pause size={19} fill="currentColor" />}</IconButton><IconButton label={t('5 秒進む', 'Forward 5 seconds')} disabled={!loaded} onClick={() => void control({ action: 'seek', value: Math.min(duration, position + 5000) })}><RotateCw size={18} /></IconButton><span className="player-time">{timestamp(position)} <span>/ {timestamp(duration)}</span></span></div><div className="control-cluster"><IconButton className={loop ? 'active' : ''} label={t('選択区間をリピート', 'Repeat selected segment')} disabled={!loaded || !selected} aria-pressed={loop} onClick={() => { const next = !loop; loopActive.current = next; setLoop(next); if (selected) void control(next ? { action: 'source-loop', startMs: selected.startMs, endMs: selected.endMs } : { action: 'loop' }); }}><Repeat2 size={18} /></IconButton><label className="speed-select"><span className="sr-only">{t('再生速度', 'Playback speed')}</span><select value={state?.rate || 1} disabled={!loaded} onChange={event => void control({ action: 'rate', value: Number(event.target.value) })}>{[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select><ChevronDown size={12} /></label><Volume2 size={16} /><input className="volume-slider" type="range" min="0" max="100" value={state?.volume ?? 100} disabled={!loaded} onChange={event => void control({ action: 'volume', value: Number(event.target.value) })} aria-label={t('音量', 'Volume')} /></div></div>
      <div className="track-controls">{(['audio', 'sub'] as const).map(kind => { const tracks = state?.tracks.filter(track => track.kind === kind) || []; return tracks.length > 0 && <label key={kind}>{kind === 'audio' ? t('学習する音声', 'Study audio') : t('再生字幕', 'Playback captions')}<select aria-label={kind === 'audio' ? t('音声トラック', 'Audio track') : t('字幕トラック', 'Subtitle track')} disabled={!loaded} value={tracks.find(track => track.selected)?.id ?? 0} onChange={event => void (kind === 'audio' ? selectAudio(Number(event.target.value)) : control({ action: 'track', trackKind: kind, value: Number(event.target.value) }))}>{kind === 'sub' && <option value={0}>{t('非表示', 'Off')}</option>}{tracks.map(track => <option key={track.id} value={track.id}>{[track.language, track.title || `${kind} ${track.id}`].filter(Boolean).join(' · ')}</option>)}</select></label>; })}<IconButton label={t('全画面表示を切り替える', 'Toggle fullscreen')} aria-pressed={fullscreen} disabled={!loaded} onClick={() => { const next = !fullscreen; setFullscreen(next); void control({ action: 'fullscreen', value: next ? 1 : 0 }); }}><Maximize size={16} /></IconButton></div>
      <label className="check-field"><input type="checkbox" checked={!draftMode && (state?.sentencePause ?? false)} disabled={!loaded || draftMode} onChange={event => void setSentencePause(event.target.checked)} /><span>{t('字幕グループの終わりで一時停止', 'Pause at the end of a caption group')}</span></label>
      <p className="helper-text">{t('句読点や字幕の間隔を目安に、字幕の終端で止まります。選択区間の再生・リピートを優先します。', 'Stops at subtitle ends, using punctuation and gaps to group sentences. Selected ranges and repeat take priority.')}</p>
    </div>
  </section>;
}

function EditDialog({ segment, onClose }: { segment: SubtitleSegment; onClose: () => void }) {
  const { t, run } = useApp();
  const [text, setText] = useState(segment.text);
  const [translation, setTranslation] = useState(segment.translation || '');
  const [start, setStart] = useState(timestamp(segment.startMs, true));
  const [end, setEnd] = useState(timestamp(segment.endMs, true));
  const [busy, setBusy] = useState(false);
  const startMs = parseTimestamp(start), endMs = parseTimestamp(end);
  async function save() {
    if (startMs === null || endMs === null || endMs <= startMs) return;
    setBusy(true);
    const success = await run(async () => { await api.editSegment({ ...segment, text: text.trim(), translation: translation.trim() || undefined, startMs, endMs, status: 'confirmed' }); return true; }, t('字幕を保存しました。', 'Subtitle saved.'));
    setBusy(false);
    if (success) onClose();
  }
  return <Modal title={t('字幕を編集', 'Edit subtitle')} onClose={() => { if (!busy) onClose(); }}>
    <div className="field-row"><Field label={t('開始', 'From')}><input value={start} onChange={event => setStart(event.target.value)} /></Field><Field label={t('終了', 'To')}><input value={end} onChange={event => setEnd(event.target.value)} /></Field></div>
    <Field label={t('字幕', 'Subtitle')}><textarea value={text} onChange={event => setText(event.target.value)} rows={4} autoFocus /></Field><Field label={t('翻訳', 'Translation')}><textarea value={translation} onChange={event => setTranslation(event.target.value)} rows={3} /></Field>
    <footer className="modal-footer"><Button onClick={onClose}>{t('キャンセル', 'Cancel')}</Button><Button variant="primary" busy={busy} disabled={!text.trim() || startMs === null || endMs === null || endMs <= startMs} onClick={() => void save()}><Check size={16} />{t('内容を確認して保存', 'Confirm and save')}</Button></footer>
  </Modal>;
}
function SaveCardDialog({ segment, candidate, onClose }: { segment: SelectedContext; candidate?: VocabularyCandidate; onClose: () => void }) {
  const { t, run } = useApp();
  const selectedText = window.getSelection()?.toString().trim();
  const [term, setTerm] = useState(candidate?.term || selectedText || '');
  const [meaning, setMeaning] = useState(candidate?.meaning || '');
  const [example, setExample] = useState(candidate?.example || segment.text);
  const [explanation, setExplanation] = useState(candidate?.explanation || '');
  const [busy, setBusy] = useState(false);
  const confirmed = !segment.status || segment.status === 'confirmed';
  async function save() {
    if (!confirmed) return;
    setBusy(true);
    const success = await run(async () => { await api.saveCard({ mediaId: segment.mediaId, segmentId: segment.id, sourceCueIds: candidate?.sourceCueIds ?? segment.sourceCueIds, term: term.trim(), meaning: meaning.trim(), example: example.trim(), explanation: explanation.trim() || undefined, translation: candidate ? candidate.translation : segment.translation }); return true; }, t('マイフレーズに保存しました。', 'Saved to your phrases.'));
    setBusy(false);
    if (success) onClose();
  }
  return <Modal title={t('この表現を、自分の言葉に。', 'Make this phrase yours.')} eyebrow="SAVE A LITTLE DISCOVERY" onClose={() => { if (!busy) onClose(); }}>
    <Field label={t('語彙・フレーズ', 'Word or phrase')}><input autoFocus value={term} onChange={event => setTerm(event.target.value)} placeholder={t('覚えておきたい表現', 'A phrase worth remembering')} /></Field><Field label={t('意味', 'Meaning')}><textarea value={meaning} onChange={event => setMeaning(event.target.value)} rows={2} /></Field><Field label={t('元の文脈', 'Original context')}><textarea value={example} onChange={event => setExample(event.target.value)} rows={3} /></Field>
    <Field label={t('解説・メモ（任意）', 'Explanation or notes (optional)')}><textarea value={explanation} onChange={event => setExplanation(event.target.value)} rows={2} /></Field>
    <p className="notice"><AudioLines size={17} /><span>{t(`${timestamp(candidate?.startMs ?? segment.startMs)}–${timestamp(candidate?.endMs ?? segment.endMs)} の音声と文脈を残して復習します。`, `Review with audio and context from ${timestamp(candidate?.startMs ?? segment.startMs)}–${timestamp(candidate?.endMs ?? segment.endMs)}.`)}</span></p>
    {!confirmed && <p className="notice warning">{t('この字幕は未確認です。先に字幕を編集して内容を確認してください。', 'Confirm this provisional subtitle before saving a card.')}</p>}
    <footer className="modal-footer"><Button onClick={onClose}>{t('キャンセル', 'Cancel')}</Button><Button variant="primary" busy={busy} disabled={!confirmed || !term.trim() || !meaning.trim() || !example.trim()} onClick={() => void save()}><BookmarkPlus size={16} />{t('フレーズを保存', 'Save phrase')}</Button></footer>
  </Modal>;
}

export function StudyPage() {
  const navigate = useNavigate();
  const { mediaId } = useParams({ from: '/study/$mediaId' });
  const { data, t, locale, run } = useApp();
  const media = data?.media.find(item => item.id === mediaId);
  const segmentsQuery = useQuery({ queryKey: ['segments', mediaId], queryFn: () => api.segments(mediaId), enabled: nativeAvailable() });
  const candidatesQuery = useQuery({ queryKey: ['candidates', mediaId], queryFn: () => api.candidates(mediaId), enabled: nativeAvailable() });
  const segments = segmentsQuery.data || [];
  const [positionMs, setPositionMs] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedCueIds, setSelectedCueIds] = useState<string[]>([]);
  const [invalidatedSelection, setInvalidatedSelection] = useState(false);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [draftReview, setDraftReview] = useState<string>();
  const [draftPlayback, setDraftPlayback] = useState<SubtitleSegment>();
  const [search, setSearch] = useState('');
  const [following, setFollowing] = useState(true);
  const [showTranslations, setShowTranslations] = useState(true);
  const [tab, setTab] = useState<'transcript' | 'vocabulary' | 'draft'>('transcript');
  const [edit, setEdit] = useState<SubtitleSegment>();
  const [save, setSave] = useState<{ segment: SelectedContext; candidate?: VocabularyCandidate }>();
  const [aiKind, setAiKind] = useState<AiQuote['kind']>();
  const [aiTerm, setAiTerm] = useState<string>();
  const [transfer, setTransfer] = useState(false);
  const [subtitleSource, setSubtitleSource] = useState<'embedded' | 'file' | 'versions'>();
  const [removing, setRemoving] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeId = activeSegment(segments, positionMs);
  const selectedFirst = segments.find(item => item.id === selectedId);
  const selectedCues = selectedCueIds.map(id => segments.find(item => item.id === id)).filter((cue): cue is SubtitleSegment => !!cue);
  const firstIndex = segments.findIndex(item => item.id === selectedCueIds[0]);
  const missingOrReorderedSelection = !!selectedId && (!selectedFirst || (selectedCueIds.length > 1 && (firstIndex < 0 || selectedCues.length !== selectedCueIds.length || !selectedCueIds.every((id, offset) => {
    const cue = segments[firstIndex + offset];
    return cue?.id === id && cue.mediaId === mediaId && (!cue.status || cue.status === 'confirmed');
  }))));
  const selectionInvalid = invalidatedSelection || missingOrReorderedSelection;
  useEffect(() => { if (missingOrReorderedSelection) setInvalidatedSelection(true); }, [missingOrReorderedSelection]);
  const selected: SelectedContext | undefined = selectionInvalid ? undefined : selectedFirst && selectedCueIds.length > 1 ? {
    ...selectedFirst,
    sourceCueIds: selectedCueIds,
    endMs: Math.max(...selectedCues.map(cue => cue.endMs)),
    text: selectedCues.map(cue => cue.text).join('\n'),
    translation: selectedCues.every(cue => cue.translation?.trim()) ? selectedCues.map(cue => cue.translation).join('\n') : undefined,
    status: selectedCues.every(cue => !cue.status || cue.status === 'confirmed') ? 'confirmed' : 'provisional',
  } : selectedFirst;
  const filtered = segments.filter(item => `${item.text} ${item.translation || ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const virtualizer = useVirtualizer({ count: filtered.length, getScrollElement: () => scrollRef.current, estimateSize: () => showTranslations ? 118 : 90, overscan: 6 });
  useEffect(() => {
    if (!following || search || tab !== 'transcript') return;
    const index = filtered.findIndex(item => item.id === activeId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center', behavior: 'auto' });
  }, [activeId, following, search, tab, filtered.length]);
  async function playSegment(segment: SelectedContext) {
    if (!playerReady) return;
    const success = await run(async () => {
      if (segment.sourceCueIds?.length) await api.playSourceRange(mediaId, segment.sourceCueIds);
      else await api.player({ action: 'source-seek', startMs: segment.startMs, endMs: segment.endMs });
      return true;
    });
    if (!success) return;
    setSelectedId(segment.id);
    setSelectedCueIds(segment.sourceCueIds ?? [segment.id]);
    setInvalidatedSelection(false);
    setSelectionRevision(value => value + 1);
  }
  async function playCandidate(candidate: VocabularyCandidate) {
    if (!playerReady) return;
    const ids = candidate.sourceCueIds?.length ? candidate.sourceCueIds : [candidate.segmentId];
    const success = await run(async () => { await api.playSourceRange(mediaId, ids); return true; });
    if (!success) return;
    setSelectedId(ids[0]);
    setSelectedCueIds(ids);
    setInvalidatedSelection(false);
    setSelectionRevision(value => value + 1);
  }
  if (!media) return <div className="page-enter"><Link to="/" className="back-link"><ArrowLeft size={16} />{t('ライブラリへ', 'Back to library')}</Link><EmptyState icon={<ListVideo size={32} />} title={t('教材を選んでください', 'Choose something to study')} description={t('ライブラリから動画や音声を開くと、ここで学習できます。', 'Open a video or audio file from your library to start learning.')}><Link to="/" className="button primary">{t('ライブラリを開く', 'Open library')}</Link></EmptyState></div>;
  const mediaJobs = data?.jobs.filter(job => job.mediaId === mediaId && (job.status !== 'completed' || (job.pendingResults || 0) > 0 || job.transcriptReview)) || [];
  return <div className="study-page page-enter">
    <div className="study-top"><div><Link to="/" className="back-link"><ArrowLeft size={14} />{t('ライブラリ', 'Library')}</Link><h1>{media.title}</h1><div className="study-meta"><Badge tone="accent">{languageName(media.learningLanguage, locale)}</Badge><span>{timestamp(media.durationMs)}</span><span>·</span><span>{t(`${segments.length} 字幕`, `${segments.length} subtitles`)}</span></div></div><div className="page-actions"><Button onClick={() => setRemoving(true)}>{t('ライブラリから除外', 'Remove from library')}</Button><Button onClick={() => setTransfer(true)}><ArrowDownToLine size={16} />{t('書き出す', 'Export')}</Button><Button variant="primary" onClick={() => setAiKind(segments.length ? 'vocabulary' : 'transcribe')}><Sparkles size={16} />{t('AI で学ぶ', 'Learn with AI')}</Button></div></div>
    {mediaJobs.map(job => <div className={`job-status ${job.status === 'failed' || job.status === 'unknown' ? 'warning' : ''}`} key={job.id}><span className="status-dot" /><span>{job.message || job.kind}</span>{job.status === 'running' && <progress value={job.progress} max={1} />}<JobActions job={job} /></div>)}
    {(media.status === 'missing' || media.status === 'error') && <div className="job-status warning"><FolderOpen size={17} /><span>{media.error || t('元のメディアが見つかりません。場所を指定し直せます。', 'The source media is missing. Locate the file to reconnect it.')}</span><Button onClick={() => void run(() => api.relinkMedia(mediaId))}>{t('ファイルを指定', 'Locate file')}</Button></div>}
    <div className="study-grid"><div className="study-left"><NativePlayer media={media} selected={tab === 'draft' ? draftPlayback : selected} selectionRevision={selectionRevision} onPosition={setPositionMs} onReady={setPlayerReady} draftMode={tab === 'draft'} />{tab !== 'draft' && <section className="context-card"><div className="context-label"><AudioLines size={16} /><span>{t('いまの文脈', 'IN CONTEXT')}</span>{selected && <span className="mono">{timestamp(selected.startMs)} — {timestamp(selected.endMs)}</span>}</div>{selected ? <><p className="context-sentence">{selected.text}</p>{selected.translation && <p className="context-translation">{selected.translation}</p>}<div className="context-actions"><Button onClick={() => { setAiTerm(window.getSelection()?.toString().trim() || ''); setAiKind('vocabulary'); }}><Sparkles size={14} />{t('選んだ表現を解説', 'Explain a phrase')}</Button><Button onClick={() => void playSegment(selected)}><Play size={14} />{t('もう一度聴く', 'Listen again')}</Button><Button variant="primary" onClick={() => setSave({ segment: selected })} disabled={!!selected.status && selected.status !== 'confirmed'}><BookmarkPlus size={15} />{t('フレーズを保存', 'Save a phrase')}</Button></div>{selected.status && selected.status !== 'confirmed' && <p className="helper-text">{t('未確認の字幕です。編集画面で内容を確認すると保存できます。', 'Confirm this subtitle in the editor before saving a phrase.')}</p>}</> : selectionInvalid ? <div className="context-empty"><p className="notice warning">{t('出典の字幕が変わりました。字幕や表現を選び直してください。', 'The source subtitles changed. Select the subtitles or phrase again.')}</p><div className="context-actions"><Button disabled><Play size={14} />{t('もう一度聴く', 'Listen again')}</Button><Button disabled><BookmarkPlus size={15} />{t('フレーズを保存', 'Save a phrase')}</Button></div></div> : <div className="context-empty"><BookOpen size={27} strokeWidth={1.3} /><p>{t('字幕を選んで、気になる表現を聴いてみましょう。', 'Select a subtitle and listen a little closer.')}</p><small>{t('選んだ区間を再生し、その文脈からフレーズを保存できます。', 'Replay that moment and save a phrase in its original context.')}</small></div>}</section>}<p className="keyboard-hint"><kbd>Space</kbd>{t('再生 / 停止', 'Play / pause')}<span>·</span><kbd>←</kbd><kbd>→</kbd>{t('5 秒移動', 'Skip 5 seconds')}</p></div>
      <section className="transcript-panel"><header className="transcript-header"><div className="transcript-tabs"><button className={tab === 'draft' ? 'active' : ''} onClick={() => setTab('draft')}>{t('下書きから学ぶ', 'Study a draft')}</button><button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}><Subtitles size={17} />{t('字幕', 'Transcript')}<span>{segments.length}</span></button><button className={tab === 'vocabulary' ? 'active' : ''} onClick={() => setTab('vocabulary')}><Sparkles size={16} />{t('AI の提案', 'Suggestions')}</button></div><div className="inline-actions"><Button onClick={() => setSubtitleSource('versions')}>{t('旧版', 'Versions')}</Button><IconButton label={t('埋め込み字幕を抽出', 'Extract embedded subtitles')} onClick={() => setSubtitleSource('embedded')}><FileSearch size={17} /></IconButton><IconButton label={t('字幕を読み込む', 'Import subtitles')} onClick={() => setSubtitleSource('file')}><Download size={17} /></IconButton></div></header>
      {tab === 'draft' ? <DraftStudyPanel media={media} playbackReady={playerReady} onReview={setDraftReview} onPlay={async range => { await api.player({ action: 'source-seek', ...range }); setDraftPlayback({ id: 'draft-playback', mediaId, ...range, text: '', status: 'provisional' }); setSelectionRevision(value => value + 1); }} /> : tab === 'transcript' ? <>
        <div className="transcript-tools"><div className="search-box"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('字幕を検索', 'Search transcript')} aria-label={t('字幕を検索', 'Search transcript')} />{search && <button aria-label={t('検索をクリア', 'Clear search')} onClick={() => setSearch('')}><X size={14} /></button>}</div><IconButton label={t('翻訳を表示・非表示', 'Toggle translations')} className={showTranslations ? 'active' : ''} onClick={() => setShowTranslations(value => !value)} aria-pressed={showTranslations}><Languages size={17} /></IconButton></div>
        {segmentsQuery.error && <p className="notice warning" role="alert">{segmentsQuery.error.message}</p>}
        {!segments.length ? <EmptyState icon={<Subtitles size={30} />} title={t('言葉を、見えるかたちに。', 'Give the words a place.')} description={t('字幕ファイルを読み込むか、区間を選んで AI に文字起こしを依頼できます。', 'Import a subtitle file, or ask AI to transcribe a section.')}><Button onClick={() => setSubtitleSource('file')}><Download size={15} />{t('字幕を読み込む', 'Import subtitles')}</Button><Button variant="ghost" onClick={() => setAiKind('transcribe')}><Sparkles size={15} />{t('文字起こしを見積もる', 'Estimate transcription')}</Button></EmptyState> : !filtered.length ? <EmptyState icon={<Search size={26} />} title={t('一致する字幕はありません', 'No matching subtitles')} description={t('別の単語で検索してください。', 'Try another word.')} /> : <div ref={scrollRef} className="transcript-scroll" onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)} onPointerDown={event => { if (event.target === event.currentTarget) setFollowing(false); }} onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) setFollowing(false); }} tabIndex={0} aria-label={t('字幕一覧', 'Subtitle list')}><div className="virtual-transcript" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map(item => { const segment = filtered[item.index]; return <article key={segment.id} data-index={item.index} ref={virtualizer.measureElement} className={`transcript-row ${activeId === segment.id ? 'playing' : ''} ${selectedId === segment.id ? 'selected' : ''}`} style={{ transform: `translateY(${item.start}px)` }}><button className="segment-time" disabled={!playerReady} onClick={() => void playSegment(segment)} aria-label={`${t('この字幕を再生', 'Play subtitle')} ${timestamp(segment.startMs)}`}>{activeId === segment.id ? <AudioLines size={13} /> : <Play size={11} />}<span>{timestamp(segment.startMs)}</span></button><div className="segment-content"><button type="button" className="segment-text" disabled={!playerReady} onClick={() => { if (!window.getSelection()?.toString()) void playSegment(segment); }}>{segment.text}</button>{showTranslations && segment.translation && <p className="segment-translation">{segment.translation}</p>}{segment.status && segment.status !== 'confirmed' && <Badge tone="warning">{t('要確認', 'Needs review')}</Badge>}<div className="segment-actions"><IconButton label={t('字幕を編集', 'Edit subtitle')} onClick={() => setEdit(segment)}><Edit3 size={13} /></IconButton><IconButton label={t('フレーズを保存', 'Save phrase')} disabled={!!segment.status && segment.status !== 'confirmed'} onClick={() => setSave({ segment })}><BookmarkPlus size={14} /></IconButton></div></div></article>; })}</div></div>}
        <footer className="transcript-footer"><span>{search ? t(`${filtered.length} 件の一致`, `${filtered.length} matches`) : t('字幕の時刻をクリックして再生', 'Click a timestamp to listen')}</span><button className={following && !search ? 'following' : ''} onClick={() => { setSearch(''); setFollowing(true); }}><Crosshair size={13} />{following && !search ? t('再生に追従中', 'Following playback') : t('再生に戻る', 'Follow playback')}</button></footer>
      </> : <div className="suggestions-panel">{candidatesQuery.error && <p className="notice warning">{candidatesQuery.error.message}</p>}{!candidatesQuery.data?.length ? <EmptyState icon={<Sparkles size={30} />} title={t('次に覚えたい表現を見つける', 'Find your next favourite phrase')} description={t('選んだ区間から AI が語彙やイディオムを提案します。保存するものは自分で選べます。', 'AI suggests words and idioms from your chosen range. You choose what to keep.')}><Button variant="primary" onClick={() => setAiKind('vocabulary')}><Sparkles size={16} />{t('区間を選んで見積もる', 'Choose a range')}</Button></EmptyState> : candidatesQuery.data.map(candidate => { const segment = segments.find(item => item.id === candidate.segmentId); return <article className="suggestion-card" key={candidate.id}><span className="eyebrow">{t('表現のヒント', 'PHRASE TO NOTICE')}</span><h3>{candidate.term}</h3><p>{candidate.meaning}</p><blockquote>{candidate.example}</blockquote><Button disabled={!playerReady || !segment} onClick={() => void playCandidate(candidate)}><Play size={14} />{t('出典を聴く', 'Listen to source')}</Button><Button onClick={() => segment && setSave({ segment, candidate })} disabled={!segment || (!!segment.status && segment.status !== 'confirmed')}><BookmarkPlus size={14} />{t('内容を確認して保存', 'Review and save')}</Button></article>; })}</div>}
      </section>
    </div>
    {draftReview && <TranscriptReviewDialog jobId={draftReview} onClose={() => setDraftReview(undefined)} />}{subtitleSource && <SubtitleSourceDialog media={media} initialMode={subtitleSource} onClose={() => setSubtitleSource(undefined)} />}{removing && <RemoveMediaDialog media={media} onClose={() => setRemoving(false)} onRemoved={() => { setRemoving(false); void navigate({ to: '/' }); }} />}{edit && <EditDialog segment={edit} onClose={() => setEdit(undefined)} />}{save && <SaveCardDialog {...save} onClose={() => setSave(undefined)} />}{aiKind && <AiDialog media={media} initialKind={aiKind} initialRange={selected} initialTerm={aiTerm} onClose={() => { setAiKind(undefined); setAiTerm(undefined); }} />}{transfer && <TransferDialog mediaId={mediaId} onClose={() => setTransfer(false)} />}
  </div>;
}






