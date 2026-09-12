// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, nativeAvailable } from '../api';
import type { AiModelPreference, AiPurpose, DiscoveredModel } from '../api';
import { useApp } from '../context';
import { Button, Field } from './ui';

export const emptyModel = (purpose: AiPurpose): AiModelPreference => ({
  modelId: '', transcriptionMode: 'transcribe', maxOutputTokens: purpose === 'explanation' ? 4096 : purpose === 'vocabulary' ? 8192 : 12288,
  thinkingLevel: null, thinkingBudget: null, price: null,
});

export function ModelEditor({ value, onChange, purpose, location, disabled = false }: {
  value: AiModelPreference; onChange: (value: AiModelPreference) => void;
  purpose: AiPurpose; location: string; disabled?: boolean;
}) {
  const { t } = useApp();
  const id = useId();
  const latest = useRef({ value, onChange, location, purpose, revision: 0 });
  const revision = latest.current.revision + Number(latest.current.location !== location || latest.current.purpose !== purpose || latest.current.value.modelId !== value.modelId);
  latest.current = { value, onChange, location, purpose, revision };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [manual, setManual] = useState(value.price?.source === 'user');
  const [input, setInput] = useState(value.price ? String(value.price.inputMicrousdPerMillion / 1_000_000) : '');
  const [output, setOutput] = useState(value.price ? String(value.price.outputMicrousdPerMillion / 1_000_000) : '');
  useEffect(() => {
    setManual(value.price?.source === 'user');
    setInput(value.price ? String(value.price.inputMicrousdPerMillion / 1_000_000) : '');
    setOutput(value.price ? String(value.price.outputMicrousdPerMillion / 1_000_000) : '');
  }, [value.price?.id, value.modelId, location, purpose]);
  const thinking = value.thinkingLevel ? 'level' : value.thinkingBudget != null ? 'budget' : 'omit';
  const frozen = disabled || busy;
  async function discover() {
    const requestedRevision = latest.current.revision;
    setBusy(true); setNotice('');
    try { const result = await api.vertexModels(location); if (!mounted.current || requestedRevision !== latest.current.revision) return; setModels(result); setNotice(t('Googleが返した候補です。掲載だけではこのプロジェクトでの実行可否を確認できません。', 'These are candidates returned by Google. Listing does not confirm access in this project.')); }
    catch { if (mounted.current && requestedRevision === latest.current.revision) setNotice(t('一覧を取得できませんでした。モデルIDを直接入力して利用できます。', 'Could not fetch the list. You can still enter a model ID directly.')); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function price() {
    const requestedRevision = latest.current.revision;
    setBusy(true); setNotice('');
    try {
      const result = await api.vertexPrice(value.modelId.trim(), location);
      if (!mounted.current || requestedRevision !== latest.current.revision) return;
      if (result.price) {
        latest.current.onChange({ ...latest.current.value, price: result.price }); setManual(false);
        setInput(String(result.price.inputMicrousdPerMillion / 1_000_000));
        setOutput(String(result.price.outputMicrousdPerMillion / 1_000_000));
        setNotice(t('公式SKUから入力種別・段階料金の最大単価を取得しました。', 'Retrieved maximum public SKU rates across input types and tiers.'));
      } else setNotice(t('適用単価を特定できませんでした。単価を設定するか、料金不明として実行できます。', 'Could not identify applicable rates. Set rates manually or run with unknown pricing.'));
    } catch { if (mounted.current && requestedRevision === latest.current.revision) setNotice(t('公式料金を取得できませんでした。Cloud Billing APIの設定を確認するか、料金不明として利用できます。', 'Could not retrieve public prices. Check Cloud Billing API settings, or use unknown pricing.')); }
    finally { if (mounted.current) setBusy(false); }
  }
  function applyManual() {
    if (!validRate(input) || !validRate(output)) return;
    onChange({ ...value, price: { id: `user-${Date.now()}`, source: 'user', observedAtMs: Date.now(),
      inputMicrousdPerMillion: Math.round(Number(input) * 1_000_000), outputMicrousdPerMillion: Math.round(Number(output) * 1_000_000) } });
    setNotice(t('入力した単価を見積もりに使います。', 'The entered rates will be used for estimates.'));
  }
  return <div className="model-editor">
    <Field label={t('GeminiモデルID', 'Gemini model ID')} hint={t('一覧から選ぶか、任意のIDを入力できます。', 'Choose a returned model or enter an ID.')}>
      <input list={id} value={value.modelId} disabled={frozen} placeholder="gemini-…" onChange={event => { onChange({ ...value, modelId: event.target.value, price: null }); setManual(false); setInput(''); setOutput(''); setNotice(''); }} />
      <datalist id={id}>{models.map(model => <option key={model.id} value={model.id}>{model.displayName}{model.launchStage ? ` · ${model.launchStage}` : ''}</option>)}</datalist>
    </Field>
    <div className="inline-actions"><Button disabled={frozen || !nativeAvailable()} onClick={() => void discover()}><RefreshCw size={14} />{t('Vertexから候補を取得', 'Fetch Vertex candidates')}</Button></div>
    {purpose === 'transcription' && <Field label={t('文字起こしのAPI方式', 'Transcription API mode')}><select value={value.transcriptionMode} disabled={frozen} onChange={event => onChange({ ...value, transcriptionMode: event.target.value as AiModelPreference['transcriptionMode'] })}><option value="transcribe">{t('Transcribe：逐語・単語時刻', 'Transcribe: verbatim and word timestamps')}</option><option value="subtitles">{t('GenerateContent：時刻付き字幕', 'GenerateContent: timed subtitles')}</option></select></Field>}
    <details><summary>{t('出力・思考・料金の設定', 'Output, thinking, and pricing')}</summary>
      <div className="field-row"><Field label={t('1要求の出力トークン上限', 'Maximum output tokens per request')}><input type="number" min="1" max="65536" value={value.maxOutputTokens} disabled={frozen} onChange={event => onChange({ ...value, maxOutputTokens: Number(event.target.value) })} /></Field>
        <Field label={t('思考設定', 'Thinking setting')}><select value={thinking} disabled={frozen} onChange={event => onChange({ ...value, thinkingLevel: event.target.value === 'level' ? 'LOW' : null, thinkingBudget: event.target.value === 'budget' ? 1024 : null })}><option value="omit">{t('モデルの既定値', 'Model default')}</option><option value="level">{t('レベルを指定', 'Set level')}</option><option value="budget">{t('トークン数を指定', 'Set token budget')}</option></select></Field></div>
      {thinking === 'level' && <Field label={t('思考レベル', 'Thinking level')}><select value={value.thinkingLevel || 'LOW'} disabled={frozen} onChange={event => onChange({ ...value, thinkingLevel: event.target.value })}>{['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].map(level => <option key={level}>{level}</option>)}</select></Field>}
      {thinking === 'budget' && <Field label={t('思考トークン予算', 'Thinking token budget')}><input type="number" min="0" max="65536" value={value.thinkingBudget ?? 1024} disabled={frozen} onChange={event => onChange({ ...value, thinkingBudget: Number(event.target.value) })} /></Field>}
      <p className="helper-text">{t('対応しない設定はAPIエラーになります。自動で設定を変更して再送しません。', 'Unsupported settings produce an API error. Settings are never changed and retried automatically.')}</p>
      <div className="inline-actions"><Button disabled={frozen || !nativeAvailable() || !value.modelId.trim()} onClick={() => void price()}>{t('公式料金を取得', 'Retrieve public prices')}</Button><Button disabled={frozen} onClick={() => setManual(!manual)}>{t('単価を手動設定', 'Set rates manually')}</Button>{value.price && <Button disabled={frozen} onClick={() => { onChange({ ...value, price: null }); setNotice(''); }}>{t('料金未設定に戻す', 'Clear pricing')}</Button>}</div>
      {manual && <><div className="field-row"><Field label={t('入力 USD / 100万トークン', 'Input USD / million tokens')}><input inputMode="decimal" value={input} disabled={frozen} onChange={event => setInput(event.target.value)} /></Field><Field label={t('出力 USD / 100万トークン', 'Output USD / million tokens')}><input inputMode="decimal" value={output} disabled={frozen} onChange={event => setOutput(event.target.value)} /></Field></div><Button disabled={frozen || !validRate(input) || !validRate(output)} onClick={applyManual}>{t('この単価を適用', 'Apply these rates')}</Button></>}
    </details>
    <p className="helper-text">{value.price
      ? t(`${value.price.source === 'user' ? '利用者設定' : '公式SKU'} · 入力 $${value.price.inputMicrousdPerMillion / 1_000_000} / 出力 $${value.price.outputMicrousdPerMillion / 1_000_000}（100万トークンあたり）`, `${value.price.source === 'user' ? 'User rates' : 'Public SKU rates'} · Input $${value.price.inputMicrousdPerMillion / 1_000_000} / output $${value.price.outputMicrousdPerMillion / 1_000_000} per million tokens`)
      : t('料金未設定：送信範囲を承認して使えます。ドル上限は計算できません。', 'Pricing is unset: approve the request scope to use this model. A dollar limit cannot be calculated.')}</p>
    {notice && <p className="notice" role="status">{notice}</p>}
  </div>;
}

function validRate(value: string) { return /^\d+(?:\.\d{1,6})?$/.test(value) && Number(value) <= 1_000_000; }
