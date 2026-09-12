// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { Archive, ArrowDownToLine, Check, CheckCircle2, CircleDollarSign, Download, Globe2, HardDrive, KeyRound, RefreshCw, RotateCcw, Save, ScanSearch, ShieldCheck, SlidersHorizontal, Terminal, Wrench } from 'lucide-react';
import { api, nativeAvailable } from '../api';
import type { AiPurpose, AppSettings, BudgetSummary, ExternalToolCandidate, ToolStatus } from '../api';
import { useApp } from '../context';
import { money } from '../utils';
import { Badge, Button, Field, PageTitle } from '../components/ui';
import { TransferDialog } from '../components/TransferDialog';
import { JobActions } from '../components/JobActions';
import { ModelEditor, emptyModel } from '../components/ModelEditor';

function equalSetting(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every(key => equalSetting(a[key], b[key]));
}

function mergeSettingFields<T extends object>(previous: T, current: T, next: T): T {
  const merged = { ...next };
  for (const key of Object.keys({ ...previous, ...current, ...next }) as (keyof T)[]) {
    // A newly persisted change wins a same-field conflict. Unrelated local
    // edits survive refreshes without restoring obsolete backend settings.
    if (equalSetting(previous[key], next[key])) merged[key] = current[key];
  }
  return merged;
}

export function mergeSettingsRefresh(previous: AppSettings | undefined, current: AppSettings | undefined, next: AppSettings): AppSettings {
  if (!previous || !current) return next;
  const merged = mergeSettingFields(previous, current, next);
  merged.aiModels = {};
  const purposes = Object.keys({ ...previous.aiModels, ...current.aiModels, ...next.aiModels }) as AiPurpose[];
  for (const purpose of purposes) {
    const before = previous.aiModels?.[purpose], local = current.aiModels?.[purpose], saved = next.aiModels?.[purpose];
    const selected = before && local && saved ? mergeSettingFields(before, local, saved)
      : equalSetting(before, saved) ? local : saved;
    if (!selected) continue;
    const model = { ...selected };
    if (before && local && saved) {
      // Level and token budget are one exclusive choice, not independent fields.
      const unchanged = equalSetting([before.thinkingLevel, before.thinkingBudget], [saved.thinkingLevel, saved.thinkingBudget]);
      const thinking = unchanged ? local : saved;
      model.thinkingLevel = thinking.thinkingLevel;
      model.thinkingBudget = thinking.thinkingBudget;
    }
    const localIdentity = model.modelId.trim() === local?.modelId.trim() && merged.vertexLocation === current.vertexLocation;
    const savedIdentity = model.modelId.trim() === saved?.modelId.trim() && merged.vertexLocation === next.vertexLocation;
    // Prices belong to one model/location. Never combine a preserved local
    // model with a refreshed price for another model, or vice versa.
    if (!localIdentity) model.price = savedIdentity ? saved?.price ?? null : null;
    else if (!savedIdentity) model.price = local?.price ?? null;
    merged.aiModels[purpose] = model;
  }
  return merged;
}

export function UnknownAttempt({ attempt }: { attempt: NonNullable<BudgetSummary['unknownAttempts']>[number] }) {
  const { t, run } = useApp();
  const [acknowledged, setAcknowledged] = useState(false);
  const unpriced = attempt.heldUsd == null;
  const [busy, setBusy] = useState(false);
  async function resolve() {
    if (!acknowledged) return;
    setBusy(true);
    await run(() => api.resolveUnknownAttempt(attempt.id), t('課金の可能性を了承しました。未確定の利用記録を保持します。再実行には別の承認が必要です。', 'Possible charge acknowledged. Unresolved accounting is retained. Any retry requires a separate approval.'));
    setBusy(false);
  }
  return <article className="unknown-attempt"><h3>{t('送信結果が確認できないリクエスト', 'Request with an unknown outcome')} · {unpriced ? t('料金未算定', 'Cost not calculated') : money(attempt.heldUsd)}</h3><p>{unpriced ? t('応答と金額を確認できません。料金未算定の送信記録を保持します。了承しても再送されません。', 'The outcome and cost are unknown. The unpriced request remains recorded. Acknowledging does not resend it.') : t('課金済みか確認できないため、予約額の全額を保留し、予算から差し引き続けます。この確認では再実行されません。再実行には別の承認が必要です。', 'Because the charge is unknown, the entire reservation remains held against your budget. Acknowledging it does not retry the request; any retry requires a separate approval.')}</p><label className="check-field"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} /><span>{unpriced ? t('金額不明の課金が発生した可能性を了承します。', 'I acknowledge that an unknown charge may have occurred.') : t(`課金の可能性を了承し、${money(attempt.heldUsd)} の予約額の保留を維持します。`, `I acknowledge the possible charge and keep ${money(attempt.heldUsd)} reserved.`)}</span></label><Button disabled={!acknowledged} busy={busy} onClick={() => void resolve()}><Check size={15} />{t('課金の可能性を了承', 'Acknowledge possible charge')}</Button></article>;
}
function PausedJobs() {
  const { data, t } = useApp();
  const attempts = data?.budget.unknownAttempts || [];
  const jobs = data?.jobs.filter(job => ['paused', 'failed', 'unknown'].includes(job.status) || (job.pendingResults || 0) > 0 || job.transcriptReview) || [];
  if (!attempts.length && !jobs.length) return null;
  return <section className="settings-card"><div className="settings-section-title"><ShieldCheck size={20} /><div><h2>{t('停止中・結果不明の処理', 'Paused jobs & unknown requests')}</h2><p>{t('利用額の確認と、残りの処理の承認は別の操作です。', 'Accounting for a request and approving remaining work are separate actions.')}</p></div></div>{attempts.map(attempt => <UnknownAttempt key={attempt.id} attempt={attempt} />)}{jobs.map(job => <div className="job-status" key={job.id}><span>{job.message || job.kind}</span><JobActions job={job} /></div>)}</section>;
}

function ToolRow({ tool, candidates }: { tool: ToolStatus; candidates: ExternalToolCandidate[] }) {
  const { t, run } = useApp();
  const [busy, setBusy] = useState(false);
  const [externalPath, setExternalPath] = useState(tool.provider === 'external' ? tool.path || '' : '');
  const [chooseExternal, setChooseExternal] = useState(false);
  const available = candidates.filter(candidate => candidate.toolId === tool.id);
  async function perform(action: () => Promise<void>) { setBusy(true); await run(action); setBusy(false); }
  const ready = tool.status === 'ready';
  return <article className="tool-row"><div className="tool-heading"><div className="tool-icon"><Terminal size={21} /></div><div><h3>{tool.name}<Badge tone={ready ? 'accent' : tool.status === 'error' ? 'danger' : 'neutral'}>{ready ? t('利用可能', 'Ready') : tool.status === 'installing' ? t('準備中', 'Installing') : t('要セットアップ', 'Setup needed')}</Badge></h3><p>{tool.version || t('未インストール', 'Not installed')}<span>·</span>{tool.provider === 'managed' ? t('Surtitle が管理', 'Managed by Surtitle') : t('外部ツール', 'External tool')}</p></div></div>
    {tool.updateAvailable && <p className="notice"><Download size={15} />{t(`新しい版 ${tool.latestVersion || ''} を利用できます。`, `Update available: ${tool.latestVersion || ''}`)}</p>}{tool.path && <code className="tool-path" title={tool.path}>{tool.path}</code>}{tool.error && <p className="field-error">{tool.error}</p>}
    <div className="tool-actions"><div className="segmented-control compact"><button className={tool.provider === 'managed' && !chooseExternal ? 'selected' : ''} disabled={busy} onClick={() => { setChooseExternal(false); if (tool.provider !== 'managed') void perform(() => api.setToolProvider({ toolId: tool.id, provider: 'managed' })); }}>{t('アプリ管理', 'Managed')}</button>{tool.id !== 'vad' && <button className={tool.provider === 'external' || chooseExternal ? 'selected' : ''} disabled={busy} onClick={() => setChooseExternal(true)}>{t('外部を使う', 'External')}</button>}</div><div className="inline-actions">{tool.provider === 'managed' && <><Button busy={busy} disabled={tool.status === 'installing'} onClick={() => void perform(() => ready ? api.updateTool(tool.id) : api.installTool(tool.id))}>{ready ? <RefreshCw size={14} /> : <Download size={14} />}{ready ? t('更新する', 'Update tool') : t('ダウンロード', 'Download')}</Button>{tool.canRollback && <Button disabled={busy} onClick={() => void perform(() => api.rollbackTool(tool.id))}><RotateCcw size={14} />{t('前の版へ', 'Roll back')}</Button>}</>}</div></div>
    {chooseExternal && <div className="external-picker"><Field label={t('使用する実行ファイルの絶対パス', 'Absolute executable path')} hint={t('選んだパスだけを使用します。外部ツールをアプリが更新・削除することはありません。', 'Only this selected path is used. Surtitle never updates or deletes an external tool.')}><input value={externalPath} onChange={event => setExternalPath(event.target.value)} placeholder={tool.id === 'ffmpeg' ? 'C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe' : `C:\\Tools\\${tool.id}.exe`} /></Field>{available.length > 0 && <div className="candidate-list">{available.map(candidate => <button key={candidate.path} disabled={!candidate.selectable} onClick={() => setExternalPath(candidate.path)} className={externalPath === candidate.path ? 'selected' : ''}><span><code>{candidate.path}</code><small>{t('未検証・選択後に機能互換性を確認します。', 'Unverified; capabilities are checked when selected.')}{candidate.reason ? ` ${candidate.reason}` : ''}</small></span></button>)}</div>}<Button busy={busy} disabled={!externalPath.trim()} onClick={() => void perform(async () => { await api.setToolProvider({ toolId: tool.id, provider: 'external', path: externalPath.trim() }); setChooseExternal(false); })}><Check size={15} />{t('検証してこのパスを使用', 'Verify and use this path')}</Button></div>}
  </article>;
}

export function SettingsPage() {
  const { data, t, run } = useApp();
  const [draft, setDraft] = useState<AppSettings>();
  const savedSettings = useRef<AppSettings | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [candidates, setCandidates] = useState<ExternalToolCandidate[]>([]);
  const [transfer, setTransfer] = useState(false);
  useEffect(() => {
    if (!nativeAvailable()) return;
    let mounted = true;
    // Read the startup discovery cache; candidates remain unverified/unselected.
    void run(() => api.scanExternalTools(false)).then(result => { if (mounted && result) setCandidates(result); });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    if (!data?.settings) return;
    const previous = savedSettings.current;
    const next = data.settings;
    savedSettings.current = next;
    setDraft(current => mergeSettingsRefresh(previous, current, next));
  }, [data?.settings]);
  function change<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setDraft(current => {
      if (!current) return current;
      const updated = { ...current, [key]: value };
      if (key === 'vertexLocation' && value !== current.vertexLocation) {
        updated.aiModels = Object.fromEntries(Object.entries(current.aiModels || {}).map(([purpose, model]) => [purpose, { ...model, price: null }]));
      }
      return updated;
    });
  }
  async function save() { if (!draft) return; setBusy(true); await run(() => api.updateSettings(draft), t('設定を保存しました。', 'Settings saved.')); setBusy(false); }
  async function scan() { setScanning(true); const result = await run(() => api.scanExternalTools(true)); if (result) setCandidates(result); setScanning(false); }
  async function checkUpdates() {
    setCheckingUpdates(true);
    try { await run(api.checkToolUpdates, t('更新情報を確認しました。', 'Update information checked.')); }
    finally { setCheckingUpdates(false); }
  }
  const valid = !!draft && draft.dailyBudgetUsd >= 0 && draft.dailyBudgetUsd <= 1000 && Number.isFinite(draft.dailyBudgetUsd) && draft.retention >= .7 && draft.retention <= .97 && Number.isInteger(draft.replayContextMs ?? 150) && (draft.replayContextMs ?? 150) >= 0 && (draft.replayContextMs ?? 150) <= 1000 && !!draft.learningLanguage.trim() && !!draft.explanationLanguage.trim();
  return <div className="settings-page page-enter"><PageTitle eyebrow="MAKE YOURSELF AT HOME" title={t('あなたに合った学び方を。', 'A studio that feels like yours.')} description={t('言語、AI、学習データ。すべて自分でコントロール。', 'Your languages, your AI, your learning. You are in control.')}><Button variant="primary" busy={busy} disabled={!valid} onClick={() => void save()}><Save size={16} />{t('変更を保存', 'Save changes')}</Button></PageTitle>
    <div className="settings-layout"><nav className="settings-nav" aria-label={t('設定セクション', 'Settings sections')}><a href="#preferences"><SlidersHorizontal size={16} />{t('学習と表示', 'Preferences')}</a><a href="#vertex"><KeyRound size={16} />Vertex AI</a><a href="#ai-models"><SlidersHorizontal size={16} />{t('AIモデル', 'AI models')}</a><a href="#budget"><ShieldCheck size={16} />{t('利用額と承認', 'Budget & approval')}</a><a href="#tools"><Wrench size={16} />{t('メディアツール', 'Media tools')}</a><a href="#data"><Archive size={16} />{t('学習データ', 'Learning data')}</a></nav><div className="settings-sections">
    <section id="preferences" className="settings-card"><div className="settings-section-title"><Globe2 size={20} /><div><h2>{t('学習と表示', 'Learning & appearance')}</h2><p>{t('新しい教材に使う初期設定です。教材ごとに言語を選べます。', 'Defaults for new content. Choose languages for each import.')}</p></div></div><fieldset disabled={!draft || busy}><div className="field-row"><Field label={t('学習する言語', 'Learning language')} hint={t('言語コード（例: en、fr、ko）', 'Language code, such as en, fr, ko')}><input value={draft?.learningLanguage || ''} onChange={event => change('learningLanguage', event.target.value)} placeholder="en" /></Field><Field label={t('説明・翻訳の言語', 'Explanation language')}><input value={draft?.explanationLanguage || ''} onChange={event => change('explanationLanguage', event.target.value)} placeholder="ja" /></Field></div><div className="field-row"><Field label={t('学習レベルの目安', 'Learning level')}><select value={draft?.proficiency || 'B1'} onChange={event => change('proficiency', event.target.value)}>{['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(level => <option key={level}>{level}</option>)}</select></Field><Field label={t('目標の記憶保持率', 'Target retention')} hint={t('高くすると復習の回数が増えます。', 'Higher retention means more reviews.')}><input type="number" min="0.7" max="0.97" step="0.01" value={draft?.retention ?? .9} onChange={event => change('retention', Number(event.target.value))} /></Field></div><Field label={t('区間再生の前後の余白（ms）', 'Playback context on each side (ms)')} hint={t('出典の再生・リピートと新しく保存する音声に適用します。字幕の時刻や既存のカード音声は変わりません。', 'Applies to source playback, repeat and newly saved audio. Subtitle times and existing card audio stay unchanged.')}><input type="number" min="0" max="1000" step="1" value={Number.isNaN(draft?.replayContextMs) ? '' : (draft?.replayContextMs ?? 150)} onChange={event => change('replayContextMs', event.target.value === '' ? Number.NaN : Number(event.target.value))} /></Field><div className="field-row"><Field label={t('表示言語', 'Interface language')}><select value={draft?.locale || 'ja'} onChange={event => change('locale', event.target.value as AppSettings['locale'])}><option value="ja">日本語</option><option value="en">English</option></select></Field><Field label={t('テーマ', 'Theme')}><select value={draft?.theme || 'dark'} onChange={event => change('theme', event.target.value as AppSettings['theme'])}><option value="dark">{t('ダーク', 'Dark')}</option><option value="light">{t('ライト', 'Light')}</option><option value="system">{t('システムに合わせる', 'System')}</option></select></Field></div></fieldset></section>
    <section id="vertex" className="settings-card"><div className="settings-section-title"><KeyRound size={20} /><div><h2>Vertex AI</h2><p>{t('自分の Google Cloud プロジェクトとサービスアカウントを使います。', 'Use your own Google Cloud project and service account.')}</p></div></div><fieldset disabled={!draft || busy}><div className="field-row"><Field label={t('プロジェクト ID', 'Project ID')}><input value={draft?.vertexProject || ''} onChange={event => change('vertexProject', event.target.value)} placeholder="my-language-project" /></Field><Field label={t('ロケーション', 'Location')}><input value={draft?.vertexLocation || ''} onChange={event => change('vertexLocation', event.target.value)} placeholder="global" /></Field></div></fieldset><div className="credential-row"><span className={`credential-icon ${data?.settings.credentialConfigured ? 'ready' : ''}`}>{data?.settings.credentialConfigured ? <CheckCircle2 size={21} /> : <KeyRound size={21} />}</span><div><strong>{data?.settings.credentialConfigured ? t('認証情報を設定済み', 'Credential configured') : t('サービスアカウント未設定', 'No service account yet')}</strong><p>{t('JSON ファイルを選ぶと、このデバイスで保護して保存します。', 'Import a JSON key to protect and store it on this device.')}</p></div><Button disabled={!nativeAvailable()} onClick={() => void run(api.importCredential, t('認証情報を保存しました。', 'Credential saved.'))}><Download size={15} />{t('JSON を読み込む', 'Import JSON')}</Button></div></section>
    <section id="ai-models" className="settings-card"><div className="settings-section-title"><SlidersHorizontal size={20} /><div><h2>{t('用途ごとのGeminiモデル', 'Gemini models by purpose')}</h2><p>{t('既定モデルを保存し、実行時にも変更できます。モデルの選択だけでは送信されません。', 'Save defaults and override them for individual jobs. Selecting a model sends no content.')}</p></div></div>
      {(['transcription', 'vocabulary', 'explanation', 'translation'] as AiPurpose[]).map(purpose => <section className="model-preference" key={purpose}><h3>{({ transcription: t('文字起こし', 'Transcription'), vocabulary: t('語彙・イディオム', 'Vocabulary & idioms'), explanation: t('選択表現の解説', 'Phrase explanation'), translation: t('字幕翻訳', 'Subtitle translation') })[purpose]}</h3><ModelEditor purpose={purpose} value={draft?.aiModels?.[purpose] || emptyModel(purpose)} location={draft?.vertexLocation || 'global'} disabled={!draft || busy} onChange={model => setDraft(current => current ? { ...current, aiModels: { ...current.aiModels, [purpose]: model } } : current)} /></section>)}
    </section>
    <section id="budget" className="settings-card"><div className="settings-section-title"><ShieldCheck size={20} /><div><h2>{t('利用額と実行承認', 'Budget & job approval')}</h2><p>{t('対象区間・要求数・出力設定と、単価がある場合の予約額を確認します。', 'Approve scope, request count, output settings, and a reservation when pricing is set.')}</p></div></div><div className="budget-summary"><div><span>{t('算定済みの利用額', 'Calculated spending')}</span><strong>{data ? money(data.budget.spentUsd) : '—'}</strong></div><div><span>{t('金額を予約中', 'Priced reservations')}</span><strong>{data ? money(data.budget.reservedUsd) : '—'}</strong></div><div><span>{t('設定上限', 'Limit')}</span><strong>{data ? money(data.budget.limitUsd) : '—'}</strong></div></div>{data && data.budget.monetaryTotalsComplete === false && <p className="notice warning">{t(`料金未算定の要求が ${data.budget.unpricedAttempts || 0} 件あります。上の金額には含まれず、請求総額ではありません。`, `${data.budget.unpricedAttempts || 0} requests have uncalculated costs. They are excluded from the amounts above, which are not your total bill.`)}</p>}<Field label={t('AI 予算（1 回・1 日・1 か月それぞれの上限 / USD）', 'AI budget (per job / day / month, each in USD)')} hint={t('初期値は $0。単価を設定した処理の各上限に適用します。料金未設定の処理は対象範囲を別途承認します。', 'Starts at $0 and caps priced jobs. Unpriced jobs require separate scope approval.')}><div className="currency-input"><CircleDollarSign size={18} /><input type="number" min="0" max="1000" step="0.01" value={draft?.dailyBudgetUsd ?? 0} disabled={!draft || busy} onChange={event => change('dailyBudgetUsd', Number(event.target.value))} /></div></Field><p className="notice"><ShieldCheck size={17} />{t('結果不明のリクエストは自動再試行せず、予約額を維持します。バックアップ復元でも利用額は巻き戻りません。', 'Unknown requests keep their reserved budget and are never automatically retried. Restoring a backup does not roll back usage.')}</p></section>
    <PausedJobs /><section id="tools" className="settings-card"><div className="settings-section-title"><Wrench size={20} /><div><h2>{t('メディアツール', 'Media tools')}</h2><p>{t('必要なときに取得するか、すでにある外部ツールを選べます。', 'Download tools when needed, or choose an existing installation.')}</p></div><div className="inline-actions"><Button busy={checkingUpdates} aria-busy={checkingUpdates} disabled={!nativeAvailable()} onClick={() => void checkUpdates()}><RefreshCw size={15} />{t('更新を確認', 'Check updates')}</Button><Button busy={scanning} disabled={!nativeAvailable()} onClick={() => void scan()}><ScanSearch size={15} />{t('PATH を再検索', 'Rescan PATH')}</Button></div></div><Field label={t('yt-dlp の更新チャンネル', 'yt-dlp update channel')} hint={t('YouTube の変更に早く追従する nightly が初期値です。設定を保存してから更新を確認してください。', 'Nightly is the default for prompt YouTube fixes. Save changes before checking for updates.')}><select value={draft?.ytDlpChannel || 'nightly'} disabled={!draft || busy} onChange={event => change('ytDlpChannel', event.target.value as 'nightly' | 'stable')}><option value="nightly">Nightly</option><option value="stable">Stable</option></select></Field><div className="bundled-note"><CheckCircle2 size={17} /><span>{t('動画プレイヤーと CPU 推論ランタイムはアプリに同梱します。', 'The native player and CPU inference runtime are bundled with the app.')}</span></div>{data?.tools.length ? data.tools.map(tool => <ToolRow key={`${tool.id}-${tool.provider}-${tool.path}`} tool={tool} candidates={candidates} />) : <p className="settings-placeholder">{t('デスクトップアプリでツールの状態を確認できます。', 'Tool status is available in the desktop app.')}</p>}<p className="helper-text">{t('FFmpeg と ffprobe はペアで使用します。外部ツールが移動・変更された場合は再確認が必要です。', 'FFmpeg and ffprobe are used as a pair. Moved or changed external tools require revalidation.')}</p></section>
    <section id="data" className="settings-card"><div className="settings-section-title"><HardDrive size={20} /><div><h2>{t('学習データを持ち運ぶ', 'Your learning belongs to you')}</h2><p>{t('汎用形式への書き出しと、音声付きバックアップの復元。', 'Export open formats or restore a portable backup with audio.')}</p></div></div><p className="settings-copy">{t('CSV / TSV はフレーズ一覧、JSON は学習履歴を含む全データ、ZIP は保存した復習音声も含みます。元の動画と認証情報は含みません。', 'CSV / TSV export your phrases, JSON preserves learning and review records, and ZIP includes saved review audio. Original videos and credentials are excluded.')}</p><Button onClick={() => setTransfer(true)}><ArrowDownToLine size={16} />{t('エクスポート・復元を開く', 'Export or restore')}</Button></section><div className="settings-save"><p>{t('Surtitle · GPL-3.0-or-later · 学習データはローカル保存', 'Surtitle · GPL-3.0-or-later · Learning is stored locally')}</p><Button variant="primary" busy={busy} disabled={!valid} onClick={() => void save()}><Save size={16} />{t('変更を保存', 'Save changes')}</Button></div>
    </div></div>{transfer && <TransferDialog onClose={() => setTransfer(false)} />}
  </div>;
}






