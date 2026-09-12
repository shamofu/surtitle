// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { listen } from '@tauri-apps/api/event';
import { ArrowRight, Check, CircleDollarSign, Languages, Mic2, ShieldCheck, Sparkles } from 'lucide-react';
import { api, nativeAvailable } from '../api';
import type { AiModelPreference, AiPurpose, AiQuote, Media, TranscriptionPreparation } from '../api';
import { useApp } from '../context';
import { money, parseTimestamp, quoteCanBeApproved, timestamp } from '../utils';
import { Badge, Button, Field, Modal } from './ui';
import { ModelEditor, emptyModel } from './ModelEditor';

export function QuoteApproval({ quote, busy, onApprove }: { quote: AiQuote; busy: boolean; onApprove: () => void }) {
  const { t } = useApp();
  const [acknowledgedQuote, setAcknowledgedQuote] = useState<string | null>(null);
  const approvalIdentity = `${quote.id}:${quote.digest || ''}`;
  const acknowledged = acknowledgedQuote === approvalIdentity;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  const expired = new Date(quote.expiresAt).getTime() <= now;
  const unpriced = quote.unpriced === true || quote.maximumUsd == null;
  return <div className="quote-review">
    <div className="quote-cost"><span><CircleDollarSign size={18} />{t('この実行の見積もり', 'Estimate for this job')}</span><strong>{unpriced ? t('料金不明', 'Price unknown') : money(quote.estimatedUsd)}</strong><small>{unpriced ? t('金額上限は保証できません', 'A dollar limit cannot be guaranteed') : <>{t('承認する予約額', 'Approved reservation')} <b>{money(quote.maximumUsd)}</b></>}</small></div>
    <dl className="details-list">{quote.focusTerm && <div><dt>{t('解説する表現', 'Phrase to explain')}</dt><dd>{quote.focusTerm}</dd></div>}<div><dt>{t('対象区間', 'Selected range')}</dt><dd>{timestamp(quote.startMs, true)} — {timestamp(quote.endMs, true)}</dd></div><div><dt>{t('モデル', 'Model')}</dt><dd>{quote.model} · {quote.location || 'global'}</dd></div><div><dt>{t('要求数 / 同時送信', 'Requests / concurrency')}</dt><dd>{quote.requestCount ?? 1} / 1</dd></div>{(quote.sendDurationMs || 0) > 0 && <div><dt>{t('重複込みの送信音声', 'Audio including overlap')}</dt><dd>{timestamp(quote.sendDurationMs || 0, true)}</dd></div>}<div><dt>{t('1要求 / 全要求の出力上限', 'Output limit per request / total')}</dt><dd>{quote.maxOutputTokens.toLocaleString()} / {(quote.totalOutputTokens ?? quote.maxOutputTokens).toLocaleString()} tokens</dd></div>{quote.pricingSource && <div><dt>{t('単価の出所', 'Price source')}</dt><dd>{quote.pricingSource === 'user' ? t('利用者設定', 'User provided') : t('Google公開SKU', 'Google public SKUs')}</dd></div>}</dl>
    {quote.warnings.map((warning, index) => <p className="notice warning" key={index}>{warning}</p>)}
    {(!quote.canApprove || expired) && <p className="notice warning" role="status">{expired ? t('見積もりの有効期限が切れました。再見積もりしてください。', 'This quote has expired. Request a new estimate.') : quote.blockedReason || t('予算や認証の設定を確認してください。', 'Check your budget and credential settings.')}</p>}
    <label className="check-field"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledgedQuote(event.target.checked ? approvalIdentity : null)} disabled={!quote.canApprove || expired || busy} /><span>{unpriced
      ? t('料金と品質が未確認であることを理解し、この範囲・要求数・音声時間・出力設定で今回の実行を承認します。', 'I understand that pricing and quality are unverified and approve this job for the displayed scope, request count, audio duration, and output settings.')
      : t('この区間と予約額を確認し、モデルの出力を確認して利用することを了承して、今回のAI実行を承認します。', 'I approve this AI job for the displayed scope and reservation, and will review the model output before use.')}</span></label>
    <Button variant="primary" className="full-width" busy={busy} disabled={!quoteCanBeApproved(quote, acknowledged, now)} onClick={onApprove}><Check size={16} />{t('この実行を承認する', 'Approve this job')}</Button>
    <p className="helper-text centered"><ShieldCheck size={13} />{t('以後の実行や結果不明の再試行を、自動で承認することはありません。', 'This does not authorize future jobs or retries with an unknown result.')}</p>
  </div>;
}
export function AiDialog({ media, initialRange, initialKind = 'transcribe', initialTerm, onClose }: { media: Media; initialRange?: { startMs: number; endMs: number }; initialKind?: AiQuote['kind']; initialTerm?: string; onClose: () => void }) {
  const { t, data, run } = useApp();
  const [kind, setKind] = useState<AiQuote['kind']>(initialKind);
  const [focusTerm, setFocusTerm] = useState(initialTerm || '');
  const [models, setModels] = useState<Partial<Record<AiPurpose, AiModelPreference>>>({});
  const purpose: AiPurpose = kind === 'transcribe' ? 'transcription' : kind === 'translate' ? 'translation' : focusTerm.trim() ? 'explanation' : 'vocabulary';
  const selectedModel = models[purpose] || data?.settings.aiModels?.[purpose] || emptyModel(purpose);
  const modelValid = !!selectedModel.modelId.trim() && Number.isInteger(selectedModel.maxOutputTokens) && selectedModel.maxOutputTokens > 0;

  const [start, setStart] = useState(timestamp(initialRange?.startMs || 0, true));
  const [end, setEnd] = useState(timestamp(initialRange?.endMs || Math.min(media.durationMs || 60000, 60000), true));
  const [quote, setQuote] = useState<AiQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [preparation, setPreparation] = useState<Awaited<ReturnType<typeof api.prepareTranscription>>>();
  const [preparations, setPreparations] = useState<TranscriptionPreparation[]>([]);
  useEffect(() => {
    if (kind !== 'transcribe' || !nativeAvailable()) return;
    let active = true;
    void run(() => api.transcriptionPreparations(media.id)).then(items => { if (active && items) setPreparations(items); });
    return () => { active = false; };
  }, [kind, media.id, run]);
  const [progress, setProgress] = useState<{ phase: string; processed_ms: number; total_ms: number; completed_chunks: number; total_chunks: number }>();
  const startMs = parseTimestamp(start), endMs = parseTimestamp(end);
  const valid = startMs !== null && endMs !== null && endMs > startMs && (!media.durationMs || endMs <= media.durationMs);
  useEffect(() => {
    if (!preparing || !nativeAvailable()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<NonNullable<typeof progress>>('preparation-progress', event => setProgress(event.payload)).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop?.(); };
  }, [preparing]);
  async function prepare() {
    if (!valid || preparing) return;
    setPreparing(true); setPreparation(undefined); setProgress(undefined);
    const result = await run(() => api.prepareTranscription(media.id, startMs, endMs));
    if (result) { setPreparation(result); setPreparations(items => [result, ...items.filter(item => item.id !== result.id)]); }
    setPreparing(false);
  }
  async function estimate() {
    if (!valid || !modelValid || (kind === 'transcribe' && !preparation)) return;
    setBusy(true);
    const result = await run(() => kind === 'transcribe' && preparation
      ? api.createTranscriptionQuote(preparation.id, selectedModel)
      : api.createQuote({ mediaId: media.id, kind, startMs, endMs, focusTerm: kind === 'vocabulary' ? focusTerm.trim() || undefined : undefined, model: selectedModel }));
    if (result) setQuote(result);
    setBusy(false);
  }
  async function approve() {
    if (!quote) return;
    setBusy(true);
    const result = await run(async () => { await api.approveQuote(quote); return true; }, t('承認した処理を開始しました。', 'Your approved job has started.'));
    setBusy(false);
    if (result) onClose();
  }
  return <Modal title={t('学びたいところに、AI を。', 'AI for the moments you choose.')} eyebrow="A LITTLE HELP, ON YOUR TERMS" onClose={() => { if (!busy && !preparing) onClose(); }}>
    {!quote ? <>
      <div className="ai-kind-list">{[{ id: 'transcribe' as const, icon: Mic2, title: t('文字起こし', 'Transcribe'), detail: t('音声から字幕をつくる', 'Turn speech into subtitles') }, { id: 'translate' as const, icon: Languages, title: t('翻訳', 'Translate'), detail: t('字幕の意味をつかむ', 'Understand the subtitles') }, { id: 'vocabulary' as const, icon: Sparkles, title: t('語彙・イディオム', 'Words & idioms'), detail: t('覚えたい表現を見つける', 'Discover useful expressions') }].map(item => <button className={kind === item.id ? 'selected' : ''} key={item.id} disabled={preparing || busy} onClick={() => setKind(item.id)} aria-pressed={kind === item.id}><item.icon size={22} /><strong>{item.title}</strong><small>{item.detail}</small></button>)}</div>
      {kind === 'vocabulary' && <Field label={t('解説してほしい表現（任意）', 'A specific phrase to explain (optional)')} hint={t('対象字幕にある表現を指定できます。空欄なら AI が語彙・イディオムを提案します。', 'Enter a phrase from the selected subtitles, or leave blank for vocabulary suggestions.')}><input value={focusTerm} disabled={busy || preparing} onChange={event => setFocusTerm(event.target.value)} placeholder={t('字幕で選んだ単語やフレーズ', 'A word or phrase from your subtitles')} /></Field>}
      {kind === 'vocabulary' && <p className="notice">{t('語彙・解説は試験機能です。語義や文中の意味を確認してから保存してください。', 'Vocabulary and explanations are experimental. Check the meaning in context before saving.')}</p>}
      {kind === 'transcribe' && <p className="helper-text">{t('受信後に字幕を確認し、不正な時刻や未取得の区間は原音を聴いて手動で修正できます。すべての認識誤りを自動検出できるわけではありません。', 'Review the received subtitles. Invalid times and missing ranges can be corrected manually while listening to the source. Some recognition errors cannot be detected automatically.')}</p>}
      <ModelEditor key={purpose} purpose={purpose} value={selectedModel} location={data?.settings.vertexLocation || 'global'} disabled={busy || preparing} onChange={model => setModels(current => ({ ...current, [purpose]: model }))} />
      <div className="scope-heading"><h3>{t('使う区間を選ぶ', 'Choose your range')}</h3><Badge>{t('全体ではなく、必要なところから', 'Start with a small section')}</Badge></div>
      <div className="field-row"><Field label={t('開始', 'From')} hint="hh:mm:ss"><input value={start} disabled={preparing || busy} onChange={event => { setStart(event.target.value); setPreparation(undefined); }} inputMode="decimal" /></Field><span className="range-arrow"><ArrowRight size={18} /></span><Field label={t('終了', 'To')} hint="hh:mm:ss"><input value={end} disabled={preparing || busy} onChange={event => { setEnd(event.target.value); setPreparation(undefined); }} inputMode="decimal" /></Field></div>
      {!valid && <p className="field-error">{t('動画内の有効な開始・終了時刻を入力してください。', 'Enter a valid start and end time within the media.')}</p>}
      {kind === 'transcribe' && preparations.length > 0 && <Field label={t('保存済みの音声準備を使う', 'Use previously prepared audio')} hint={t('同じ音声を再生成せずに見積もれます。', 'Estimate from immutable prepared audio without generating it again.')}><select value={preparation?.id || ''} disabled={preparing || busy} onChange={event => { const item = preparations.find(value => value.id === event.target.value); setPreparation(item); if (item) { setStart(timestamp(item.startMs, true)); setEnd(timestamp(item.endMs, true)); } }}><option value="">{t('選択してください', 'Choose a preparation')}</option>{preparations.filter(item => !item.repairParentJobId).map(item => <option value={item.id} key={item.id}>{timestamp(item.startMs, true)} – {timestamp(item.endMs, true)} · {item.chunkCount} {t('区間', 'chunks')}</option>)}</select></Field>}
      {kind === 'transcribe' && <div className="local-preparation"><p className="notice warning">{t('まず音声をローカルで準備します。送信するモデルと範囲は、準備後の承認画面で確認できます。', 'Prepare audio locally first, then review the model and scope before approving cloud requests.')}</p>{preparation && <p className="notice">{t(`${preparation.chunkCount} 個の音声区間を準備しました（送信予定音声 ${timestamp(preparation.sendDurationMs)}）。クラウドには送信していません。`, `Prepared ${preparation.chunkCount} audio chunks (${timestamp(preparation.sendDurationMs)} of audio). Nothing was sent to the cloud.`)}</p>}{preparing ? <div className="job-status"><span>{t('ローカルで音声を準備中', 'Preparing audio locally')}{progress ? ` · ${progress.completed_chunks} / ${progress.total_chunks || '—'}` : ''}</span>{progress && <progress value={progress.processed_ms} max={progress.total_ms || 1} />}<Button onClick={() => void run(api.cancelPreparation)}>{t('キャンセル', 'Cancel')}</Button></div> : <Button disabled={!valid || busy} onClick={() => void prepare()}><Mic2 size={15} />{t('音声をローカルで準備（無料）', 'Prepare audio locally (free)')}</Button>}</div>}
      <div className="notice"><ShieldCheck size={18} /><span>{t('見積もりを確認してから実行できます。予算の初期値は $0 です。', 'You will review the estimate before any paid job. The initial budget is $0.')}</span></div>
      {!data?.settings.credentialConfigured && !preparing && <p className="helper-text">{t('AI を使うにはサービスアカウントの設定が必要です。', 'Set up your service account to use AI.')} <Link to="/settings" onClick={onClose}>{t('設定を開く', 'Open settings')} →</Link></p>}
      <footer className="modal-footer"><Button onClick={onClose} disabled={busy || preparing}>{t('キャンセル', 'Cancel')}</Button><Button variant="primary" onClick={() => void estimate()} busy={busy} disabled={!valid || !modelValid || preparing || (kind === 'transcribe' && !preparation)}><CircleDollarSign size={16} />{t('見積もりを確認', 'Review estimate')}</Button></footer>
    </> : <><button className="text-button" onClick={() => setQuote(null)} disabled={busy}>← {t('範囲を変更・再見積もり', 'Change range or re-estimate')}</button><QuoteApproval key={quote.id} quote={quote} busy={busy} onApprove={() => void approve()} /></>}
  </Modal>;
}



