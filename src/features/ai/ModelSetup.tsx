import { useId, useState } from 'react';
import { useAppearance, useNotifications } from '../../app/runtime';
import type { AiModelPreference, AiProvider, AiPurpose, DiscoveredModel } from '../../shared/contracts/ai';
import { Button, Field } from '../../shared/ui/index';
import { aiApi } from './api';
import { emptyModel } from './ModelEditor';
import { MotionRegion, MotionSwap } from '../../shared/motion';

const purposes: AiPurpose[] = ['transcription', 'vocabulary', 'explanation', 'translation'];
export function applyModelSetup(existing: Partial<Record<AiPurpose, AiModelPreference>>, flash: string, transcribe: string, selected: AiPurpose[]) {
  const result = { ...existing };
  for (const purpose of selected) {
    const modelId = (purpose === 'transcription' ? transcribe : flash).trim();
    if (modelId) result[purpose] = { ...emptyModel(purpose), modelId, transcriptionMode: purpose === 'transcription' && !/flash/i.test(modelId) ? 'transcribe' : 'subtitles' };
  }
  return result;
}
export function ModelSetup({ models, location, disabled, onChange, candidates, provider = 'vertex' }: {
  provider?: AiProvider;
  models: Partial<Record<AiPurpose, AiModelPreference>>;
  location: string;
  disabled: boolean;
  onChange: (models: Partial<Record<AiPurpose, AiModelPreference>>) => void;
  candidates?: DiscoveredModel[];
}) {
  const { t } = useAppearance();
  const { report } = useNotifications();
  const id = useId();
  const [flash, setFlash] = useState('');
  const [transcribe, setTranscribe] = useState('');
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const availableModels = candidates ?? discoveredModels;
  const [selected, setSelected] = useState<AiPurpose[]>(() => purposes.filter(p => !models[p]?.modelId.trim()));
  const [busy, setBusy] = useState(false);
  const label = (purpose: AiPurpose) => ({ transcription: t('文字起こし', 'Transcription'), vocabulary: t('語彙・イディオム', 'Vocabulary'), explanation: t('表現の解説', 'Explanation'), translation: t('字幕翻訳', 'Translation') })[purpose];
  return <div className="model-preference">
    <h3>{provider === 'openai' ? t('用途別にモデルを設定', 'Set models by purpose') : t('おすすめの組み合わせを設定', 'Set up the recommended combination')}</h3>
    <p>{provider === 'openai' ? t('文字起こし用と、語彙・解説・翻訳用のモデルIDを指定します。', 'Choose an audio transcription model and a text model for vocabulary, explanations, and translation.') : t('文字起こしにはTranscribe、語彙・解説・翻訳にはFlashを選びます。', 'Choose Transcribe for transcription and Flash for vocabulary, explanations, and translation.')}</p>
    <div className="field-row">
      <Field label={provider === 'openai' ? t('テキストモデル', 'Text model') : t('Flashモデル', 'Flash model')}><input disabled={disabled || busy} value={flash} list={`${id}-flash`} onChange={event => setFlash(event.target.value)} placeholder={provider === 'openai' ? 'gpt-…' : 'gemini-…-flash'} />
        <datalist id={`${id}-flash`}>{availableModels.filter(model => provider === 'openai' ? !/transcribe|whisper/i.test(`${model.id} ${model.displayName}`) : /flash/i.test(`${model.id} ${model.displayName}`)).map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}</datalist>
      </Field>
      <Field label={t('Transcribeモデル', 'Transcribe model')}><input disabled={disabled || busy} value={transcribe} list={`${id}-transcribe`} onChange={event => setTranscribe(event.target.value)} placeholder={provider === 'openai' ? 'gpt-…-transcribe' : 'gemini-…-transcribe'} />
        <datalist id={`${id}-transcribe`}>{availableModels.filter(model => /transcribe/i.test(`${model.id} ${model.displayName}`)).map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}</datalist>
      </Field>
    </div>
    <MotionRegion mode="status" open={candidates === undefined}><Button disabled={disabled} busy={busy} onClick={async () => { setBusy(true); const items = await report(() => provider === 'openai' ? aiApi.openaiModels() : aiApi.vertexModels(location)); if (items) setDiscoveredModels(items); setBusy(false); }}>{t('モデルの候補を取得', 'Fetch model choices')}</Button></MotionRegion>
    <p className="helper-text">{t('候補から選ぶかIDを入力できます。既存設定を変更する場合は用途を選んでください。', 'Select a candidate or enter an ID. Select a purpose explicitly to replace its existing settings.')}</p>
    <div>{purposes.map(purpose => <label className="check-field" key={purpose}><input type="checkbox" checked={selected.includes(purpose)} disabled={disabled || busy} onChange={event => setSelected(current => event.target.checked ? [...current, purpose] : current.filter(item => item !== purpose))} /><span>{label(purpose)}<MotionSwap disabled as="span" stateKey={models[purpose]?.modelId ?? ''}>{models[purpose]?.modelId && ` · ${models[purpose]?.modelId}`}</MotionSwap></span></label>)}</div>
    <Button disabled={disabled || busy || !selected.length || selected.some(p => p === 'transcription' ? !transcribe.trim() : !flash.trim())} onClick={() => onChange(applyModelSetup(models, flash, transcribe, selected))}>{t('選んだ用途に適用', 'Apply to selected purposes')}</Button>
  </div>;
}
