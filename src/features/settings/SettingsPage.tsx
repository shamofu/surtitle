// SPDX-License-Identifier: GPL-3.0-or-later
import { PausedJobs } from './PausedJobs';
import { RecoveredInputs } from './RecoveredInputs';
import { ToolRow } from './ToolRow';
import { WindowSizeSettings } from './WindowSizeSettings';
import { settingsEditor, settingsFields, settingsFromFields } from './editing';
import { useEditingSession } from '../../shared/editing/useEditingSession';
import { useQueryClient } from '@tanstack/react-query';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { continuationApi, type AiContinuation } from '../ai/continuations';
import { ModelSetup } from '../ai/ModelSetup';
import {
  Archive,
  ArrowDownToLine,
  CheckCircle2,
  CircleDollarSign,
  Download,
  Globe2,
  HardDrive,
  KeyRound,
  RefreshCw,

  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
} from 'lucide-react';

import { settingsApi } from './api';
import { aiApi } from '../ai/api';
import { nativeAvailable } from '../../shared/native/transport';
import type { AiPurpose, DiscoveredModel } from '../../shared/contracts/ai';
import type { AppSettings } from '../../shared/contracts/settings';

import type { ExternalToolCandidate } from '../../shared/contracts/settings';

import {
  useDataActions,
  useSnapshot,
  useAppearance,
  useNotifications,
} from '../../app/runtime';
import { money } from '../../shared/format';
import { Button, Field, PageTitle } from '../../shared/ui/index';
import { ProgressStatus } from '../../shared/ui/ProgressStatus';
import { AnimatedDetails, openAnimatedDetails } from '../../shared/ui/AnimatedDetails';
import { useActivities } from '../../app/providers/Activities';
import { LanguageInput } from '../../shared/ui/LanguageInput';
import { TransferDialog } from '../transfer/TransferDialog';

import { ModelEditor, emptyModel, validOutputTokens, validTokenInput, type ModelInputDraft } from '../ai/ModelEditor';
import { AnimatedValue, MotionRegion, MotionSwap, useAppMotion, useMotionEntrance } from '../../shared/motion';

const learningLevels = [
  ['A1', '挨拶や簡単な自己紹介ができる', 'Greetings and simple introductions'],
  ['A2', '買い物など身近な会話ができる', 'Everyday exchanges, such as shopping'],
  ['B1', '経験や考えを日常的な言葉で説明できる', 'Explain experiences and opinions in everyday language'],
  ['B2', '複雑な話題でも議論や説明ができる', 'Discuss and explain more complex topics'],
  ['C1', '専門的な内容を理解し柔軟に表現できる', 'Understand specialist content and express yourself flexibly'],
  ['C2', '細かなニュアンスまで理解し表現できる', 'Understand and express subtle nuances'],
] as const;

type SettingsCategory = 'learning' | 'appearance' | 'ai' | 'tools' | 'data';
const settingsCategories = [
  { id: 'learning', ja: '学習', en: 'Learning', icon: Globe2 },
  { id: 'appearance', ja: '表示', en: 'Appearance', icon: SlidersHorizontal },
  { id: 'ai', ja: 'AI', en: 'AI', icon: KeyRound },
  { id: 'tools', ja: 'ツール', en: 'Tools', icon: Wrench },
  { id: 'data', ja: 'データ', en: 'Data', icon: Archive },
] satisfies Array<{ id: SettingsCategory; ja: string; en: string; icon: typeof Globe2 }>;

function categoryForAnchor(anchor: string): SettingsCategory | undefined {
  if (['ai', 'vertex', 'ai-models', 'budget'].includes(anchor)) return 'ai';
  return settingsCategories.find(category => category.id === anchor)?.id;
}

export function SettingsPage() {
  const navigate = useNavigate();
  const { resume } = useSearch({ from: '/settings' });
  const hash = useLocation({ select: location => location.hash });
  const [initialCategory] = useState<SettingsCategory>(() => resume ? 'ai' : 'learning');
  const [category, setCategory] = useState<SettingsCategory>(() => categoryForAnchor(hash) ?? initialCategory);
  const [revealTarget, setRevealTarget] = useState<{ id?: string; element?: HTMLElement; focus?: boolean }>();
  const [continuations, setContinuations] = useState<AiContinuation[]>([]);
  const { mutate, refresh } = useDataActions();
  const { data, loading, error: snapshotError } = useSnapshot();
  const [retryingLoad, setRetryingLoad] = useState(false);
  const { t } = useAppearance();
  const { reducedMotion } = useAppMotion();
  const { report, notify } = useNotifications();
  const client = useQueryClient();
  const [session] = useState(() => settingsEditor(client));
  const editing = useEditingSession(session);
  const draft = editing.ready && data ? settingsFromFields(editing.fields, data.settings) : undefined;
  const busy = editing.saving;
  const modelInputs = JSON.parse(editing.fields.modelInputs || '{}') as Partial<Record<AiPurpose, ModelInputDraft>>;
  function setDraft(update: (current: AppSettings | undefined) => AppSettings | undefined) {
    if (!data || !editing.ready) return;
    const previous = settingsFromFields(session.getSnapshot().fields, data.settings);
    const next = update(previous);
    if (next) {
      const before = settingsFields(previous);
      session.change(Object.fromEntries(Object.entries(settingsFields(next)).filter(([key, value]) => value !== before[key])));
    }
  }

  const lastMonthlyBudget = useRef(0);

  const { runTracked } = useActivities();

  const priceRequests = useRef(new Set<AiPurpose>());
  const [pricing, setPricing] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  useMotionEntrance(page);
  useEffect(() => {
    // A continuation chooses the initial category only. Hash navigation still
    // follows browser history, without a later AI refresh taking over selection.
    const next = categoryForAnchor(hash) ?? initialCategory;
    setCategory(next);
    if (hash) setRevealTarget({ id: hash });
  }, [hash, initialCategory]);
  useLayoutEffect(() => {
    if (!revealTarget || !page.current) return;
    const target = revealTarget.element ?? (revealTarget.id ? document.getElementById(revealTarget.id) : null);
    if (!target || !page.current.contains(target) || target.closest('[hidden]')) return;
    let openedDetails = false;
    for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLDetailsElement && (!ancestor.open || ancestor.dataset.motionState === 'exiting')) {
        openAnimatedDetails(ancestor);
        openedDetails = true;
      }
    }
    // Revealing a disclosure clears its inert descendants in the next commit.
    // Move focus only after that commit, including when reversing a close.
    if (openedDetails) { setRevealTarget({ ...revealTarget }); return; }
    target.scrollIntoView({ block: revealTarget.focus ? 'center' : 'start', behavior: reducedMotion ? 'instant' : 'smooth' });
    if (revealTarget.focus) target.focus({ preventScroll: true });
    else if (document.activeElement?.closest('[hidden]')) page.current.querySelector<HTMLButtonElement>(`#settings-nav-${category}`)?.focus({ preventScroll: true });
    setRevealTarget(undefined);
  }, [category, revealTarget, editing.ready, reducedMotion]);
  function selectCategory(next: SettingsCategory) {
    setCategory(next);
    setRevealTarget({ id: next });
    void navigate({ to: '/settings', search: previous => previous, hash: next, resetScroll: false, hashScrollIntoView: false });
  }
  function keepFieldVisible(target: EventTarget) {
    if (!(target instanceof HTMLElement)) return;
    const field = target.closest<HTMLElement>('.field');
    const viewport = page.current?.closest('.page-content');
    const footer = page.current?.querySelector('.settings-save');
    if (!field || !viewport || !footer) return;
    const bounds = viewport.getBoundingClientRect();
    const visibleBottom = Math.min(bounds.bottom, footer.getBoundingClientRect().top);
    const fieldBounds = field.getBoundingClientRect();
    // Focusing just the input can leave its label or help under the fixed
    // footer in a short window. Keep the whole field readable when it fits.
    if (fieldBounds.top < bounds.top || fieldBounds.bottom > visibleBottom) {
      const visibleTarget = fieldBounds.height <= visibleBottom - bounds.top ? field : target;
      visibleTarget.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }
  const [scanning, setScanning] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [candidates, setCandidates] = useState<ExternalToolCandidate[]>([]);
  const [transfer, setTransfer] = useState(false);
  const [retentionCustom, setRetentionCustom] = useState(false);
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [modelCatalogue, setModelCatalogue] = useState<{ key: string; models: DiscoveredModel[] }>({ key: '', models: [] });
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelNotice, setModelNotice] = useState('');
  const catalogueKey = JSON.stringify([
    draft?.vertexLocation || 'global',
    data?.settings.vertexProject,
    data?.settings.credentialConfigured,
    credentialRevision,
  ]);
  const catalogue = useRef({ key: catalogueKey, revision: 0, mounted: true });
  if (catalogue.current.key !== catalogueKey) {
    catalogue.current = { ...catalogue.current, key: catalogueKey, revision: catalogue.current.revision + 1 };
  }
  useEffect(() => {
    catalogue.current.mounted = true;
    return () => { catalogue.current.mounted = false; };
  }, []);
  useEffect(() => {
    setModelsBusy(false);
    setModelNotice('');
  }, [catalogueKey]);
  useEffect(() => { if (nativeAvailable()) void continuationApi.list().then(setContinuations).catch(() => {}); }, []);
  useEffect(() => {
    if (!nativeAvailable()) return;
    let mounted = true;
    // Read the startup discovery cache; candidates remain unverified/unselected.
    void report(() => settingsApi.scanExternalTools(false)).then((result) => {
      if (mounted && result) setCandidates(result);
    });
    return () => {
      mounted = false;
    };
  }, []);
  function change<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setDraft((current) => {
      if (!current) return current;
      const updated = { ...current, [key]: value };
      if (key === 'monthlyBudgetUsd' && Number.isFinite(value)) {
        const previousMonthly = Number.isFinite(current.monthlyBudgetUsd) ? current.monthlyBudgetUsd! : lastMonthlyBudget.current;
        if (current.dailyBudgetUsd === previousMonthly) updated.dailyBudgetUsd = value as number;
        if ((current.perJobBudgetUsd ?? current.dailyBudgetUsd) === previousMonthly) updated.perJobBudgetUsd = value as number;
        lastMonthlyBudget.current = value as number;
      }
      if (key === 'vertexLocation' && value !== current.vertexLocation) {
        updated.aiModels = Object.fromEntries(
          Object.entries(current.aiModels || {}).map(([purpose, model]) => [
            purpose,
            { ...model, price: null },
          ]),
        );
      }
      return updated;
    });
  }
  const save = session.flush;
  function changeNumber(key: 'retention' | 'replayContextMs' | 'monthlyBudgetUsd' | 'dailyBudgetUsd' | 'perJobBudgetUsd', raw: string) {
    const number = raw.trim() === '' ? Number.NaN : Number(raw);
    change(key, key === 'retention' ? number / 100 : number);
    session.change({ [key === 'retention' ? 'retentionInput' : key]: raw });
  }
  async function importCredential() {
    setCredentialBusy(true);
    try {
      const imported = await report(() => mutate(settingsApi.importCredential, { kind: 'snapshot' }));
      if (imported) {
        setCredentialRevision((current) => current + 1);
        notify(t('認証情報を保存しました。', 'Credential saved.'));
      }
    } finally {
      setCredentialBusy(false);
    }
  }
  async function discoverModels() {
    const requestedRevision = ++catalogue.current.revision;
    const requestedKey = catalogueKey;
    setModelsBusy(true);
    setModelNotice('');
    try {
      const result = await runTracked({ kind: 'models', label: t('AIモデルの候補', 'AI model candidates'), phase: 'discovering_models' }, () => aiApi.vertexModels(draft?.vertexLocation || 'global'));
      if (!catalogue.current.mounted || catalogue.current.revision !== requestedRevision) return;
      setModelCatalogue({ key: requestedKey, models: result });
      setModelNotice(t(
        `${result.length} 件の候補を全用途で使えます。候補への掲載だけでは、このプロジェクトでの実行可否は確認できません。`,
        `${result.length} ${result.length === 1 ? 'candidate is' : 'candidates are'} available for every purpose. Listing does not confirm access in this project.`,
      ));
    } catch {
      if (catalogue.current.mounted && catalogue.current.revision === requestedRevision) {
        setModelNotice(t('候補を取得できませんでした。モデルIDを直接入力するか、もう一度取得してください。', 'Could not fetch candidates. Enter a model ID directly or try again.'));
      }
    } finally {
      if (catalogue.current.mounted && catalogue.current.revision === requestedRevision) setModelsBusy(false);
    }
  }
  async function scan() {
    setScanning(true);
    const result = await report(() => runTracked({ kind: 'tool_scan', label: t('外部ツールの検索', 'Find external tools'), phase: 'checking_tools' }, () => settingsApi.scanExternalTools(true)));
    if (result) setCandidates(result);
    setScanning(false);
  }
  async function checkUpdates() {
    setCheckingUpdates(true);
    try {
      await report(
        () => runTracked({ kind: 'tool_updates', label: t('ツールの更新確認', 'Check tool updates'), phase: 'checking_updates' }, () => mutate(settingsApi.checkToolUpdates, { kind: 'snapshot' })),
        t('更新情報を確認しました。', 'Update information checked.'),
      );
    } finally {
      setCheckingUpdates(false);
    }
  }
  const monthlyBudget = draft?.monthlyBudgetUsd ?? draft?.dailyBudgetUsd ?? 0;
  const perJobBudget = draft?.perJobBudgetUsd ?? draft?.dailyBudgetUsd ?? 0;
  const budgetError = (value: number) => draft && !(Number.isFinite(value) && value >= 0 && value <= 1000)
    ? t('0〜1000 USD の金額を入力してください。', 'Enter an amount between 0 and 1,000 USD.') : undefined;
  const errors = {
    learningLanguage: draft && !draft.learningLanguage.trim() ? t('学習する言語を指定してください。', 'Choose a learning language.') : undefined,
    explanationLanguage: draft && !draft.explanationLanguage.trim() ? t('説明・翻訳の言語を指定してください。', 'Choose an explanation language.') : undefined,
    retention: draft && !(draft.retention >= 0.7 - 0.0000001 && draft.retention <= 0.97 + 0.0000001) ? t('70〜97% の保持率を入力してください。', 'Enter a retention rate between 70% and 97%.') : undefined,
    replayContextMs: draft && !(Number.isInteger(draft.replayContextMs ?? 150) && (draft.replayContextMs ?? 150) >= 0 && (draft.replayContextMs ?? 150) <= 1000) ? t('0〜1000 ms の整数を入力してください。', 'Enter a whole number between 0 and 1,000 ms.') : undefined,
    monthlyBudgetUsd: budgetError(monthlyBudget),
    dailyBudgetUsd: budgetError(draft?.dailyBudgetUsd ?? 0),
    perJobBudgetUsd: budgetError(perJobBudget),
  };
  const modelInputValid = Object.values(modelInputs).every(input => !input ||
    (input.maxOutputTokens === undefined || validTokenInput(input.maxOutputTokens, 1, 1048576)) &&
    (input.thinkingBudget === undefined || validTokenInput(input.thinkingBudget, 0, 65536)));
  const valid = !!draft && modelInputValid && !Object.values(errors).some(Boolean) && Object.values(draft.aiModels || {}).every(model => !model || validOutputTokens(model.maxOutputTokens));
  const dirty = editing.dirty || !modelInputValid;

  function reviewErrors() {
    const invalid = page.current?.querySelector<HTMLElement>('input[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"]');
    if (!invalid) return;
    const next = invalid.closest<HTMLElement>('[data-settings-category]')?.dataset.settingsCategory as SettingsCategory | undefined;
    if (next) setCategory(next);
    setRevealTarget({ element: invalid, focus: true });
  }
  const customBudget = !!draft && (draft.dailyBudgetUsd !== monthlyBudget || perJobBudget !== monthlyBudget);
  const retentionPreset = [0.85, 0.9, 0.95].find((value) => Math.abs(value - (draft?.retention ?? 0.9)) < 0.000001);
  const continuation = continuations.find(item => item.id === resume) || continuations[0];
  if (nativeAvailable() && ((!data && snapshotError) || (!editing.ready && editing.error))) return <div ref={page} className="settings-page">
    <PageTitle title={t('設定', 'Settings')} description={t('学習・AI・外部ツールの設定を調整できます。', 'Adjust your learning, AI, and external tool settings.')} />
    <div className="notice warning" role="alert">
      <span>{t('設定を読み込めませんでした。', 'Could not load settings.')} {!data ? snapshotError?.message || editing.error : editing.error}</span>
      <Button busy={retryingLoad || loading} onClick={() => {
        setRetryingLoad(true);
        void report(async () => {
          if (!data) await refresh();
          if (!editing.ready) await session.load();
        }).finally(() => setRetryingLoad(false));
      }}>{t('再試行', 'Retry')}</Button>
    </div>
  </div>;
  return (
    <div ref={page} className="settings-page" onBlur={() => void save()} onFocusCapture={event => keepFieldVisible(event.target)}>
      <MotionRegion mode="status" open={!!continuation}>{continuation && <div className="notice"><span>{t('途中のAI依頼に戻れます。', 'You can return to your unfinished AI request.')}</span><Button disabled={credentialBusy} busy={busy} onClick={async () => { if (await save()) { void navigate({ to: '/study/$mediaId', params: { mediaId: continuation.mediaId }, search: { resume: continuation.id } }); } }}>{t('元の操作に戻る', 'Return to your request')}</Button></div>}</MotionRegion>
      <PageTitle
        title={t('設定', 'Settings')}
        description={t(
          '学習・AI・外部ツールの設定を調整できます。',
          'Adjust your learning, AI, and external tool settings.',
        )}
      />
      <div className="settings-layout">
        <nav
          className="settings-nav"
          aria-label={t('設定セクション', 'Settings sections')}
        >
          {settingsCategories.map(({ id, ja, en, icon: Icon }) => (
            <button key={id} id={`settings-nav-${id}`} type="button" aria-pressed={category === id} aria-controls={id} onClick={() => selectCategory(id)}>
              <Icon size={18} />{t(ja, en)}
            </button>
          ))}
        </nav>
        <div className="settings-sections">
          <section id="learning" className="settings-card settings-category" data-settings-category="learning" hidden={category !== 'learning'}>
            <div className="settings-section-title">
              <Globe2 size={20} />
              <div>
                <h2>{t('学習', 'Learning')}</h2>
                <p>
                  {t(
                    '新しい教材に使う初期設定です。教材ごとに言語を選べます。',
                    'Defaults for new content. Choose languages for each import.',
                  )}
                </p>
              </div>
            </div>
            <fieldset disabled={!draft}>
              <div className="field-row">
                <Field
                  label={t('学習する言語', 'Learning language')}
                  error={errors.learningLanguage}
                  hint={t(
                    '一覧にない言語はコードでも指定できます。',
                    'You can also enter a language code.',
                  )}
                >
                  <LanguageInput
                    value={draft?.learningLanguage || ''}
                    onChange={(code) =>
                      change('learningLanguage', code)
                    }
                  />
                </Field>
                <Field label={t('説明・翻訳の言語', 'Explanation language')} error={errors.explanationLanguage}>
                  <LanguageInput
                    value={draft?.explanationLanguage || ''}
                    onChange={(code) =>
                      change('explanationLanguage', code)
                    }
                  />
                </Field>
              </div>
              <div className="field-row">
                <Field label={t('学習レベルの目安', 'Learning level')} hint={t('選択した表現のAI解説の難しさに反映します。迷ったら B1 から始め、解説に合わせて調整してください。', 'Controls the difficulty of AI explanations for selected phrases. Start at B1 if unsure, then adjust to suit the explanations.')}>
                  <select
                    value={draft?.proficiency || 'B1'}
                    onChange={(event) =>
                      change('proficiency', event.target.value)
                    }
                  >
                    {learningLevels.map(([level, ja, en]) => (
                      <option key={level} value={level}>{level} — {t(ja, en)}</option>
                    ))}
                  </select>
                </Field>
                <div className="settings-field-group">
                <Field
                  label={t('復習の頻度', 'Review frequency')}
                  hint={t(
                    '記憶力の自己評価は不要です。復習の負担に合わせて選べます。',
                    'No need to judge your memory. Choose the review workload that suits you.',
                  )}
                >
                  <select value={retentionCustom || retentionPreset == null ? 'custom' : String(retentionPreset)} onChange={(event) => {
                    setRetentionCustom(event.target.value === 'custom');
                    if (event.target.value !== 'custom') change('retention', Number(event.target.value));
                  }}>
                    <option value="0.85">{t('少なめ — 復習の負担を抑える', 'Lighter — fewer reviews')}</option>
                    <option value="0.9">{t('標準（おすすめ）— バランスよく復習', 'Standard (recommended) — balanced reviews')}</option>
                    <option value="0.95">{t('多め — 忘れる前にこまめに復習', 'More frequent — review before forgetting')}</option>
                    <option value="custom">{t('カスタム — 詳細を調整', 'Custom — adjust the details')}</option>
                  </select>
                </Field>
                <AnimatedDetails className="settings-details" open={retentionCustom || retentionPreset == null}>
                  <summary>{t('復習の詳細設定', 'Advanced review settings')}</summary>
                  <Field label={t('目標の記憶保持率（%）', 'Target retention (%)')} error={errors.retention} hint={t('次の復習まで覚えていることを目指す割合です。高いほど復習が増えます。標準は90%です。', 'The proportion you aim to remember until the next review. Higher values mean more reviews. The standard is 90%.')}>
                  <input
                    type="text" inputMode="decimal"
                    value={editing.fields.retentionInput ?? ''}
                    onChange={(event) => {
                      setRetentionCustom(true);
                      changeNumber('retention', event.target.value);
                    }}
                  />
                </Field>
                </AnimatedDetails>
                </div>
              </div>
              <Field
                error={errors.replayContextMs}
                label={t(
                  '区間再生の前後の余白（ms）',
                  'Playback context on each side (ms)',
                )}
                hint={t(
                  '出典の再生・リピートと新しく保存する音声に適用します。字幕の時刻や既存のカード音声は変わりません。',
                  'Applies to source playback, repeat and newly saved audio. Subtitle times and existing card audio stay unchanged.',
                )}
              >
                <input
                  type="text" inputMode="numeric"
                  value={editing.fields.replayContextMs ?? ''}
                  onChange={(event) => changeNumber('replayContextMs', event.target.value)}
                />
              </Field>
            </fieldset>
          </section>
          <section id="appearance" className="settings-card settings-category" data-settings-category="appearance" hidden={category !== 'appearance'}>
            <div className="settings-section-title"><SlidersHorizontal size={20} /><h2>{t('表示', 'Appearance')}</h2></div>
            <fieldset disabled={!draft}>
              <div className="field-row">
                <Field label={t('表示言語', 'Interface language')}>
                  <select
                    value={draft?.locale || 'ja'}
                    onChange={(event) =>
                      change(
                        'locale',
                        event.target.value as AppSettings['locale'],
                      )
                    }
                  >
                    <option value="ja">日本語</option>
                    <option value="en">English</option>
                  </select>
                </Field>
                <Field label={t('テーマ', 'Theme')}>
                  <select
                    value={draft?.theme || 'dark'}
                    onChange={(event) =>
                      change(
                        'theme',
                        event.target.value as AppSettings['theme'],
                      )
                    }
                  >
                    <option value="dark">{t('ダーク', 'Dark')}</option>
                    <option value="light">{t('ライト', 'Light')}</option>
                    <option value="system">
                      {t('システムに合わせる', 'System')}
                    </option>
                  </select>
                </Field>
              </div>
              <div className="field-row">
                <Field label={t('アニメーション', 'Animations')} hint={t('動きを減らすと、画面の切り替えや開閉をすぐに完了します。', 'Reduced motion makes transitions and dialogs complete immediately.')}>
                  <select
                    value={draft?.motionPreference ?? 'system'}
                    onChange={(event) => change('motionPreference', event.target.value as AppSettings['motionPreference'])}
                  >
                    <option value="system">{t('OS設定に従う', 'Follow system settings')}</option>
                    <option value="reduce">{t('アニメーションを減らす', 'Reduce motion')}</option>
                  </select>
                </Field>
              </div>
            </fieldset>
            <WindowSizeSettings />
          </section>
          <section id="ai" className="settings-group settings-category" data-settings-category="ai" hidden={category !== 'ai'} aria-labelledby="ai-settings-heading">
            <h2 id="ai-settings-heading">{t('AI', 'AI')}</h2>
          <section id="vertex" className="settings-card">
            <div className="settings-section-title">
              <KeyRound size={20} />
              <div>
                <h3>Vertex AI</h3>
                <p>
                  {t(
                    '自分の Google Cloud プロジェクトとサービスアカウントを使います。',
                    'Use your own Google Cloud project and service account.',
                  )}
                </p>
              </div>
            </div>
            <fieldset disabled={!draft}>
              <div className="field-row">
                <Field label={t('プロジェクト ID', 'Project ID')} hint={t('サービスアカウントのJSONから読み込みます。変更する場合は別のJSONを読み込んでください。', 'Read from the service-account JSON. Import another JSON key to change it.')}>
                  <input
                    value={draft?.vertexProject || ''}
                    readOnly
                    placeholder={t('JSONを読み込むと表示されます', 'Import JSON to display the project')}
                  />
                </Field>
                <Field label={t('ロケーション', 'Location')}>
                  <input
                    value={draft?.vertexLocation || ''}
                    onChange={(event) =>
                      change('vertexLocation', event.target.value)
                    }
                    placeholder="global"
                  />
                </Field>
              </div>
            </fieldset>
            <div className="credential-row">
              <span
                className={`credential-icon ${data?.settings.credentialConfigured ? 'ready' : ''}`}
              >
                <MotionSwap disabled as="span" stateKey={data?.settings.credentialConfigured ? 'ready' : 'missing'}>{data?.settings.credentialConfigured ? (
                  <CheckCircle2 size={21} />
                ) : (
                  <KeyRound size={21} />
                )}</MotionSwap>
              </span>
              <div>
                <strong>
                  <MotionSwap disabled as="span" stateKey={data?.settings.credentialConfigured ? 'ready' : 'missing'}>{data?.settings.credentialConfigured
                    ? t('認証情報を設定済み', 'Credential configured')
                    : t('サービスアカウント未設定', 'No service account yet')}</MotionSwap>
                </strong>
                <p>
                  {t(
                    'JSONを読み込むと、このデバイスで保護して保存し、すぐに反映します。',
                    'Import a JSON key to protect and store it on this device. It takes effect immediately.',
                  )}
                </p>
              </div>
              <Button
                busy={credentialBusy}
                disabled={!nativeAvailable() || busy}
                onClick={() => void importCredential()}
              >
                <Download size={15} />
                {t('JSON を読み込む', 'Import JSON')}
              </Button>
            </div>
          </section>
          <section id="ai-models" className="settings-card">
            <div className="settings-section-title">
              <SlidersHorizontal size={20} />
              <div>
                <h3>
                  {t('用途ごとのGeminiモデル', 'Gemini models by purpose')}
                </h3>
                <p>
                  {t(
                    '既定モデルを保存し、実行時にも変更できます。モデルの選択だけでは送信されません。',
                    'Save defaults and override them for individual jobs. Selecting a model sends no content.',
                  )}
                </p>
              </div>
            </div>
            <div className="model-catalogue">
              <Button busy={modelsBusy} disabled={!draft || credentialBusy || !nativeAvailable() || !data?.settings.credentialConfigured} onClick={() => void discoverModels()}>
                <RefreshCw size={15} />
                {t('Vertexからモデル候補を取得', 'Fetch Vertex model candidates')}
              </Button>
              <p>{t('一度取得すると、以下のすべての用途で選べます。モデルIDを直接入力することもできます。', 'Fetch once to use the candidates for every purpose below. You can also enter a model ID directly.')}</p>
              <MotionRegion mode="status" open={!data?.settings.credentialConfigured}><p>{t('先にサービスアカウントのJSONを読み込んでください。', 'Import a service-account JSON key first.')}</p></MotionRegion>
              <MotionRegion mode="status" open={!!modelNotice}><p role="status"><MotionSwap disabled as="span" stateKey={modelNotice}>{modelNotice}</MotionSwap></p></MotionRegion>
              <MotionRegion mode="status" open={modelsBusy}><ProgressStatus label={t('AIモデルの候補', 'AI model candidates')} phase="discovering_models" /></MotionRegion>
            </div>
            <ModelSetup models={draft?.aiModels || {}} location={draft?.vertexLocation || 'global'} candidates={modelCatalogue.key === catalogueKey ? modelCatalogue.models : []} disabled={!draft || credentialBusy} onChange={aiModels => change('aiModels', aiModels)} />
            <AnimatedDetails><summary>{t('用途ごとの詳細設定', 'Detailed settings by purpose')}</summary>
            {(
              [
                'transcription',
                'vocabulary',
                'explanation',
                'translation',
              ] as AiPurpose[]
            ).map((purpose) => (
              <section className="model-preference" key={purpose}>
                <h3>
                  {
                    {
                      transcription: t('文字起こし', 'Transcription'),
                      vocabulary: t('語彙・イディオム', 'Vocabulary & idioms'),
                      explanation: t('選択表現の解説', 'Phrase explanation'),
                      translation: t('字幕翻訳', 'Subtitle translation'),
                    }[purpose]
                  }
                </h3>
                <ModelEditor
                  key={editing.ready ? purpose : `loading:${purpose}`}
                  purpose={purpose}
                  value={draft?.aiModels?.[purpose] || emptyModel(purpose)}
                  location={draft?.vertexLocation || 'global'}
                  candidates={modelCatalogue.key === catalogueKey ? modelCatalogue.models : []}
                  disabled={!draft}
                  autoApplyRates
                  inputDraft={modelInputs[purpose]}
                  onInputDraftChange={input => {
                    const current = JSON.parse(session.getSnapshot().fields.modelInputs || '{}');
                    session.change({ modelInputs: JSON.stringify({ ...current, [purpose]: input }) });
                  }}
                  onPricePendingChange={(pending) => {
                    if (pending) priceRequests.current.add(purpose);
                    else priceRequests.current.delete(purpose);
                    setPricing(priceRequests.current.size > 0);
                  }}
                  onChange={(model) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            aiModels: { ...current.aiModels, [purpose]: model },
                          }
                        : current,
                    )
                  }
                />
              </section>
            ))}
            </AnimatedDetails>
          </section>
          <section id="budget" className="settings-card">
            <div className="settings-section-title">
              <ShieldCheck size={20} />
              <div>
                <h3>{t('利用額と実行承認', 'Budget & job approval')}</h3>
                <p>
                  {t(
                    '対象区間・要求数・出力設定と、単価がある場合の予約額を確認します。',
                    'Approve scope, request count, output settings, and a reservation when pricing is set.',
                  )}
                </p>
              </div>
            </div>
            <div className="budget-summary">
              <div>
                <span>{t('今月の算定済み利用額', 'Calculated spending this month')}</span>
                <strong><AnimatedValue value={data ? money(data.budget.spentUsd) : '—'} /></strong>
              </div>
              <div>
                <span>{t('現在の予約額', 'Current reservations')}</span>
                <strong><AnimatedValue value={data ? money(data.budget.reservedUsd) : '—'} /></strong>
              </div>
              <div>
                <span>{t('保存済みの月額上限', 'Saved monthly limit')}</span>
                <strong><AnimatedValue value={data ? data.budget.limitUsd === 0 ? t('上限なし', 'Unlimited') : money(data.budget.limitUsd) : '—'} /></strong>
              </div>
            </div>
            <MotionRegion mode="status" open={data?.budget.monetaryTotalsComplete === false}>
              <p className="notice warning">
                <MotionSwap disabled as="span" stateKey={data?.budget.unpricedAttempts || 0}>{t(
                  `料金未算定の要求が ${data?.budget.unpricedAttempts || 0} 件あります。上の金額には含まれず、請求総額ではありません。`,
                  `${data?.budget.unpricedAttempts || 0} requests have uncalculated costs. They are excluded from the amounts above, which are not your total bill.`,
                )}</MotionSwap>
              </p>
            </MotionRegion>
            <Field
              error={errors.monthlyBudgetUsd}
              label={t(
                '1か月のAI予算（USD）',
                'Monthly AI budget (USD)',
              )}
              hint={t(
                'UTC基準の暦月ごとの上限です。0は月額の上限なしです。正の金額は料金を算定できる処理に適用します。料金未設定の処理は金額上限の対象外で、送信範囲を別途承認します。',
                'A limit for each UTC calendar month. Zero means no monthly limit. Positive amounts cap priced jobs. Unpriced jobs are outside the dollar limits and require separate approval of the request scope.',
              )}
            >
              <div className="currency-input">
                <CircleDollarSign size={18} />
                <input
                  type="text" inputMode="decimal"
                  value={editing.fields.monthlyBudgetUsd ?? ''}
                  disabled={!draft}
                  onChange={(event) =>
                    changeNumber('monthlyBudgetUsd', event.target.value)
                  }
                />
              </div>
            </Field>
            <MotionRegion mode="status" open={customBudget}><p className="budget-custom-summary"><MotionSwap disabled as="span" stateKey={`${money(draft?.dailyBudgetUsd ?? 0)}:${money(perJobBudget)}`}>{t(
              `詳細の上限を設定済み：1日 ${money(draft?.dailyBudgetUsd ?? 0)}、1処理 ${money(perJobBudget)}。月額と異なる上限だけを維持し、同じ上限は月額の変更に合わせます。`,
              `Advanced limits: ${money(draft?.dailyBudgetUsd ?? 0)} per day and ${money(perJobBudget)} per job. Independent limits are kept when the monthly budget changes.`,
            )}</MotionSwap></p></MotionRegion>
            <AnimatedDetails className="settings-details budget-details">
              <summary>{t('1日・1処理の上限を調整', 'Adjust daily and per-job limits')}</summary>
              <p className="helper-text">{t('月額と同じ上限は月額の変更に合わせて調整します。個別の上限はそのまま維持します。各上限の0は、その期間・処理の上限なしを意味します。', 'Limits matching the monthly budget follow its changes. Independent limits are kept. Zero removes the limit for that period or job.')}</p>
              <div className="field-row">
                <div className="settings-field-group">
                  <Field label={t('1日の上限（USD）', 'Daily limit (USD)')} error={errors.dailyBudgetUsd} hint={t('UTC基準の暦日ごとに集計します。', 'Usage is counted by UTC calendar day.')}>
                    <input type="text" inputMode="decimal" value={editing.fields.dailyBudgetUsd ?? ''} disabled={!draft} onChange={(event) => changeNumber('dailyBudgetUsd', event.target.value)} />
                  </Field>
                  <Button disabled={!draft || !Number.isFinite(monthlyBudget) || draft.dailyBudgetUsd === monthlyBudget} onClick={() => change('dailyBudgetUsd', monthlyBudget)}>{t('月額と同じに戻す', 'Match the monthly budget')}</Button>
                </div>
                <div className="settings-field-group">
                  <Field label={t('1処理の上限（USD）', 'Per-job limit (USD)')} error={errors.perJobBudgetUsd} hint={t('1処理には、文字起こしなどの複数のリクエストを含む場合があります。', 'One job can include multiple requests, such as transcription chunks.')}>
                    <input type="text" inputMode="decimal" value={editing.fields.perJobBudgetUsd ?? ''} disabled={!draft} onChange={(event) => changeNumber('perJobBudgetUsd', event.target.value)} />
                  </Field>
                  <Button disabled={!draft || !Number.isFinite(monthlyBudget) || perJobBudget === monthlyBudget} onClick={() => change('perJobBudgetUsd', monthlyBudget)}>{t('月額と同じに戻す', 'Match the monthly budget')}</Button>
                </div>
              </div>
            </AnimatedDetails>
            <p className="notice">
              <ShieldCheck size={17} />
              {t(
                '結果不明のリクエストは自動再試行せず、日・月が変わっても予約額を維持します。バックアップ復元でも利用額は巻き戻りません。',
                'Unknown requests keep their reservations across days and months and are never automatically retried. Restoring a backup does not roll back usage.',
              )}
            </p>
          </section>
          <PausedJobs />
          </section>
          <section id="tools" className="settings-card settings-category" data-settings-category="tools" hidden={category !== 'tools'}>
            <div className="settings-section-title">
              <Wrench size={20} />
              <div>
                <h2>{t('ツール', 'Tools')}</h2>
                <p>
                  {t(
                    '必要なときに取得するか、すでにある外部ツールを選べます。',
                    'Download tools when needed, or choose an existing installation.',
                  )}
                </p>
              </div>
              <div className="inline-actions">
                <Button
                  busy={checkingUpdates}
                  aria-busy={checkingUpdates}
                  disabled={!nativeAvailable()}
                  onClick={() => void checkUpdates()}
                >
                  <RefreshCw size={15} />
                  {t('更新を確認', 'Check updates')}
                </Button>
                <Button
                  busy={scanning}
                  disabled={!nativeAvailable()}
                  onClick={() => void scan()}
                >
                  <ScanSearch size={15} />
                  {t('PATH を再検索', 'Rescan PATH')}
                </Button>
              </div>
            </div>
            <MotionRegion mode="status" open={checkingUpdates}><ProgressStatus label={t('ツールの更新確認', 'Check tool updates')} phase="checking_updates" /></MotionRegion>
            <MotionRegion mode="status" open={scanning}><ProgressStatus label={t('外部ツールの検索', 'Find external tools')} phase="checking_tools" /></MotionRegion>
            <Field
              label={t('yt-dlp の更新チャンネル', 'yt-dlp update channel')}
              hint={t(
                '安定版のStableが初期値です。Nightlyは最新の修正を早く試したい場合に選べます。保存後に更新を確認してください。',
                'Stable is the default. Choose Nightly to try the latest fixes sooner. Save changes before checking for updates.',
              )}
            >
              <select
                value={draft?.ytDlpChannel || 'stable'}
                disabled={!draft}
                onChange={(event) =>
                  change(
                    'ytDlpChannel',
                    event.target.value as 'nightly' | 'stable',
                  )
                }
              >
                <option value="stable">Stable</option>
                <option value="nightly">Nightly</option>
              </select>
            </Field>
            <div className="bundled-note">
              <CheckCircle2 size={17} />
              <span>
                {t(
                  '動画プレイヤーと CPU 推論ランタイムはアプリに同梱します。',
                  'The native player and CPU inference runtime are bundled with the app.',
                )}
              </span>
            </div>
            <MotionSwap disabled stateKey={data?.tools.map(tool => tool.id).join('|') || 'empty'}>
            {data?.tools.length ? (
              data.tools.map((tool) => (
                <ToolRow
                  key={tool.id}
                  tool={tool}
                  candidates={candidates}
                />
              ))
            ) : (
              <p className="settings-placeholder">
                {t(
                  'デスクトップアプリでツールの状態を確認できます。',
                  'Tool status is available in the desktop app.',
                )}
              </p>
            )}
            </MotionSwap>
            <p className="helper-text">
              {t(
                'FFmpeg と ffprobe はペアで使用します。外部ツールが移動・変更された場合は再確認が必要です。',
                'FFmpeg and ffprobe are used as a pair. Moved or changed external tools require revalidation.',
              )}
            </p>
          </section>
          <section id="data" className="settings-card settings-category" data-settings-category="data" hidden={category !== 'data'}>
            <div className="settings-section-title">
              <HardDrive size={20} />
              <div>
                <h2>
                  {t('データ', 'Data')}
                </h2>
                <p>
                  {t(
                    '汎用形式への書き出しと、音声付きバックアップの復元。',
                    'Export open formats or restore a portable backup with audio.',
                  )}
                </p>
              </div>
            </div>
            <p className="settings-copy">
              {t(
                'CSV / TSV はフレーズ一覧、JSON は学習履歴を含む全データ、ZIP は保存した復習音声も含みます。元の動画と認証情報は含みません。',
                'CSV / TSV export your phrases, JSON preserves learning and review records, and ZIP includes saved review audio. Original videos and credentials are excluded.',
              )}
            </p>
            <Button onClick={() => setTransfer(true)}>
              <ArrowDownToLine size={16} />
              {t('エクスポート・復元を開く', 'Export or restore')}
            </Button>
            <RecoveredInputs />
          </section>
        </div>
      </div>
      <div className="settings-save autosave-footer" aria-busy={busy || pricing}>
        <div className="settings-save-status">
        <span role="status">{busy ? t('保存中…', 'Saving…') : !draft ? t('設定を読み込み中…', 'Loading settings…') : dirty ? t('入力途中の内容を保持しています。有効な変更は自動保存します。', 'Unfinished input is kept. Valid changes save automatically.') : t('変更は自動保存されます', 'Changes save automatically')}</span>
        {editing.error && <div className="notice warning" role="alert"><span>{editing.error}</span><Button onClick={() => void save()}>{t('再試行', 'Retry')}</Button></div>}
        </div>
        {!valid && draft && <Button onClick={reviewErrors}>{t('入力エラーを確認', 'Review errors')}</Button>}
      </div>
      {editing.recovery && <div className="notice warning"><p>{t('設定の変更前に保存した入力があります。', 'Input from an earlier version of your settings is available.')}</p><textarea aria-label={t('前の入力', 'Previous input')} readOnly value={JSON.stringify(editing.recovery, null, 2)} /><Button onClick={() => session.recover()}>{t('この入力から編集を続ける', 'Continue editing this input')}</Button></div>}
      {transfer && <TransferDialog onClose={() => setTransfer(false)} />}
    </div>
  );
}
