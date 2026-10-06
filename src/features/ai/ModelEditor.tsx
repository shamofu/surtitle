// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { aiApi } from './api';
import { nativeAvailable } from '../../shared/native/transport';
import type { AiModelPreference } from '../../shared/contracts/ai';
import type { AiPurpose } from '../../shared/contracts/ai';
import type { DiscoveredModel } from '../../shared/contracts/ai';
import { useAppearance } from '../../app/runtime';
import { Button, Field } from '../../shared/ui/index';
import './model-editor.css';

export const emptyModel = (purpose: AiPurpose): AiModelPreference => ({
  modelId: '',
  transcriptionMode: 'transcribe',
  maxOutputTokens:
    purpose === 'explanation' ? 4096 : purpose === 'vocabulary' ? 8192 : 12288,
  thinkingLevel: null,
  thinkingBudget: null,
  price: null,
});

export function ModelEditor({
  value,
  onChange,
  purpose,
  location,
  disabled = false,
  candidates,
}: {
  value: AiModelPreference;
  onChange: (value: AiModelPreference) => void;
  purpose: AiPurpose;
  location: string;
  disabled?: boolean;
  candidates?: DiscoveredModel[];
}) {
  const { t } = useAppearance();
  const id = useId();
  const latest = useRef({ value, onChange, location, purpose, revision: 0 });
  const revision =
    latest.current.revision +
    Number(
      latest.current.location !== location ||
        latest.current.purpose !== purpose ||
        latest.current.value.modelId !== value.modelId,
    );
  latest.current = { value, onChange, location, purpose, revision };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  useEffect(() => {
    setModels([]);
  }, [location]);
  const availableModels = candidates ?? models;
  const recommendedTokens = emptyModel(purpose).maxOutputTokens;
  const [editingCustomOutput, setEditingCustomOutput] = useState(false);
  const customOutput =
    editingCustomOutput || value.maxOutputTokens !== recommendedTokens;
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    setEditingCustomOutput(false);
  }, [purpose]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [manual, setManual] = useState(value.price?.source === 'user');
  const [input, setInput] = useState(
    value.price ? String(value.price.inputMicrousdPerMillion / 1_000_000) : '',
  );
  const [output, setOutput] = useState(
    value.price ? String(value.price.outputMicrousdPerMillion / 1_000_000) : '',
  );
  useEffect(() => {
    setManual(value.price?.source === 'user');
    setInput(
      value.price
        ? String(value.price.inputMicrousdPerMillion / 1_000_000)
        : '',
    );
    setOutput(
      value.price
        ? String(value.price.outputMicrousdPerMillion / 1_000_000)
        : '',
    );
  }, [value.price?.id, value.modelId, location, purpose]);
  const thinking = value.thinkingLevel
    ? 'level'
    : value.thinkingBudget != null
      ? 'budget'
      : 'omit';
  const frozen = disabled || busy;
  async function discover() {
    const requestedRevision = latest.current.revision;
    setBusy(true);
    setNotice('');
    try {
      const result = await aiApi.vertexModels(location);
      if (!mounted.current || requestedRevision !== latest.current.revision)
        return;
      setModels(result);
      setNotice(
        t(
          'Googleが返した候補です。掲載だけではこのプロジェクトでの実行可否を確認できません。',
          'These are candidates returned by Google. Listing does not confirm access in this project.',
        ),
      );
    } catch {
      if (mounted.current && requestedRevision === latest.current.revision)
        setNotice(
          t(
            '一覧を取得できませんでした。モデルIDを直接入力して利用できます。',
            'Could not fetch the list. You can still enter a model ID directly.',
          ),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function price() {
    const requestedRevision = latest.current.revision;
    setBusy(true);
    setNotice('');
    try {
      const result = await aiApi.vertexPrice(value.modelId.trim(), location);
      if (!mounted.current || requestedRevision !== latest.current.revision)
        return;
      if (result.price) {
        latest.current.onChange({
          ...latest.current.value,
          price: result.price,
        });
        setManual(false);
        setInput(String(result.price.inputMicrousdPerMillion / 1_000_000));
        setOutput(String(result.price.outputMicrousdPerMillion / 1_000_000));
        setNotice(
          t(
            '公式SKUから入力種別・段階料金の最大単価を取得しました。',
            'Retrieved maximum public SKU rates across input types and tiers.',
          ),
        );
      } else
        setNotice(
          t(
            '適用単価を特定できませんでした。単価を設定するか、料金不明として実行できます。',
            'Could not identify applicable rates. Set rates manually or report with unknown pricing.',
          ),
        );
    } catch {
      if (mounted.current && requestedRevision === latest.current.revision)
        setNotice(
          t(
            '公式料金を取得できませんでした。Cloud Billing APIの設定を確認するか、料金不明として利用できます。',
            'Could not retrieve public prices. Check Cloud Billing API settings, or use unknown pricing.',
          ),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function applyManual() {
    if (!validRate(input) || !validRate(output)) return;
    onChange({
      ...value,
      price: {
        id: `user-${Date.now()}`,
        source: 'user',
        observedAtMs: Date.now(),
        inputMicrousdPerMillion: Math.round(Number(input) * 1_000_000),
        outputMicrousdPerMillion: Math.round(Number(output) * 1_000_000),
      },
    });
    setNotice(
      t(
        '入力した単価を見積もりに使います。',
        'The entered rates will be used for estimates.',
      ),
    );
  }
  return (
    <div className="model-editor">
      <Field
        label={t('GeminiモデルID', 'Gemini model ID')}
        hint={t(
          '一覧から選ぶか、任意のIDを入力できます。',
          'Choose a returned model or enter an ID.',
        )}
      >
        <input
          list={id}
          value={value.modelId}
          disabled={frozen}
          placeholder="gemini-…"
          onChange={(event) => {
            const modelId = event.target.value;
            const transcriptionMode = purpose === 'transcription'
              ? /transcribe/i.test(modelId) ? 'transcribe' : /flash/i.test(modelId) ? 'subtitles' : value.transcriptionMode
              : value.transcriptionMode;
            onChange({ ...value, modelId, transcriptionMode, price: null });
            setManual(false);
            setInput('');
            setOutput('');
            setNotice('');
          }}
        />
        <datalist id={id}>
          {availableModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName}
              {model.launchStage ? ` · ${model.launchStage}` : ''}
            </option>
          ))}
        </datalist>
      </Field>
      {candidates === undefined && (
        <div className="inline-actions model-discovery-actions">
          <Button
            disabled={frozen || !nativeAvailable()}
            busy={busy}
            onClick={() => void discover()}
          >
            <RefreshCw size={14} />
            {t('Vertexから候補を取得', 'Fetch Vertex candidates')}
          </Button>
        </div>
      )}
      {purpose === 'transcription' && (
        <Field
          label={t('字幕の作り方', 'How to create subtitles')}
          hint={
            value.transcriptionMode === 'transcribe'
              ? t(
                  '単語ごとのテキストと時刻を取得し、アプリが字幕を組み立てます（Transcribe）。',
                  'Get text and timestamps for each word; the app assembles the subtitles (Transcribe).',
                )
              : t(
                  'AIが文章を字幕区間にまとめ、区間ごとの開始・終了時刻を生成します（GenerateContent）。',
                  'AI groups speech into subtitle cues and generates a start and end time for each cue (GenerateContent).',
                )
          }
        >
          <select
            value={value.transcriptionMode}
            disabled={frozen}
            onChange={(event) =>
              onChange({
                ...value,
                transcriptionMode: event.target
                  .value as AiModelPreference['transcriptionMode'],
              })
            }
          >
            <option value="transcribe">
              {t(
                '逐語の文字起こし・単語時刻',
                'Verbatim transcription and word timestamps',
              )}
            </option>
            <option value="subtitles">
              {t(
                '字幕区間をまとめて生成',
                'Generate timed subtitle cues',
              )}
            </option>
          </select>
        </Field>
      )}
      <Field
        label={t('回答の長さの上限', 'Output limit')}
        hint={
          customOutput
            ? t(
                `カスタム設定：1要求あたり最大 ${value.maxOutputTokens.toLocaleString()} トークン。詳細設定で変更できます。`,
                `Custom: up to ${value.maxOutputTokens.toLocaleString()} tokens per request. Edit the value in the detailed settings.`,
              )
            : t(
                '通常は標準のまま利用できます。用途に合わせてアプリが用意した上限です。',
                'Use the standard setting for typical requests. This is an app preset for this task.',
              )
        }
      >
        <select
          value={customOutput ? 'custom' : 'standard'}
          disabled={frozen}
          onChange={(event) => {
            if (event.target.value === 'standard') {
              setEditingCustomOutput(false);
              onChange({ ...value, maxOutputTokens: recommendedTokens });
            } else {
              setEditingCustomOutput(true);
              if (details.current) details.current.open = true;
            }
          }}
        >
          <option value="standard">
            {t('標準（おすすめ）', 'Standard (recommended)')}
          </option>
          <option value="custom">{t('カスタム', 'Custom')}</option>
        </select>
      </Field>
      <details ref={details} className="model-editor-details">
        <summary>
          {t('出力・思考・料金の設定', 'Output, thinking, and pricing')}
        </summary>
        <div className="model-editor-detail-content">
          {customOutput && (
            <Field
              label={t(
                '1要求の出力トークン上限',
                'Maximum output tokens per request',
              )}
              hint={t(
                '小さすぎると回答が途中で切れる場合があります。大きくすると料金の最大見積もりが増えます。トークンはテキストの長さを数える単位です。',
                'A low limit can cut answers short. A higher limit increases the maximum cost estimate. Tokens measure the length of text.',
              )}
            >
              <input
                type="number"
                min="1"
                max="1048576"
                step="1"
                value={value.maxOutputTokens}
                disabled={frozen}
                onChange={(event) =>
                  onChange({
                    ...value,
                    maxOutputTokens: Number(event.target.value),
                  })
                }
              />
            </Field>
          )}
          <Field label={t('思考設定', 'Thinking setting')}>
            <select
              value={thinking}
              disabled={frozen}
              onChange={(event) =>
                onChange({
                  ...value,
                  thinkingLevel: event.target.value === 'level' ? 'LOW' : null,
                  thinkingBudget: event.target.value === 'budget' ? 1024 : null,
                })
              }
            >
              <option value="omit">
                {t('モデルの既定値', 'Model default')}
              </option>
              <option value="level">{t('レベルを指定', 'Set level')}</option>
              <option value="budget">
                {t('トークン数を指定', 'Set token budget')}
              </option>
            </select>
          </Field>
          {thinking === 'level' && (
            <Field label={t('思考レベル', 'Thinking level')}>
              <select
                value={value.thinkingLevel || 'LOW'}
                disabled={frozen}
                onChange={(event) =>
                  onChange({ ...value, thinkingLevel: event.target.value })
                }
              >
                {['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].map((level) => (
                  <option key={level}>{level}</option>
                ))}
              </select>
            </Field>
          )}
          {thinking === 'budget' && (
            <Field label={t('思考トークン予算', 'Thinking token budget')}>
              <input
                type="number"
                min="0"
                max="65536"
                value={value.thinkingBudget ?? 1024}
                disabled={frozen}
                onChange={(event) =>
                  onChange({
                    ...value,
                    thinkingBudget: Number(event.target.value),
                  })
                }
              />
            </Field>
          )}
          <p className="helper-text">
            {t(
              '対応しない設定はAPIエラーになります。自動で設定を変更して再送しません。',
              'Unsupported settings produce an API error. Settings are never changed and retried automatically.',
            )}
          </p>
          <div className="inline-actions">
            <Button
              disabled={frozen || !nativeAvailable() || !value.modelId.trim()}
              onClick={() => void price()}
            >
              {t('公式料金を取得', 'Retrieve public prices')}
            </Button>
            <Button disabled={frozen} onClick={() => setManual(!manual)}>
              {t('単価を手動設定', 'Set rates manually')}
            </Button>
            {value.price && (
              <Button
                disabled={frozen}
                onClick={() => {
                  onChange({ ...value, price: null });
                  setNotice('');
                }}
              >
                {t('料金未設定に戻す', 'Clear pricing')}
              </Button>
            )}
          </div>
          {manual && (
            <>
              <div className="field-row">
                <Field
                  label={t(
                    '入力 USD / 100万トークン',
                    'Input USD / million tokens',
                  )}
                >
                  <input
                    inputMode="decimal"
                    value={input}
                    disabled={frozen}
                    onChange={(event) => setInput(event.target.value)}
                  />
                </Field>
                <Field
                  label={t(
                    '出力 USD / 100万トークン',
                    'Output USD / million tokens',
                  )}
                >
                  <input
                    inputMode="decimal"
                    value={output}
                    disabled={frozen}
                    onChange={(event) => setOutput(event.target.value)}
                  />
                </Field>
              </div>
              <Button
                disabled={frozen || !validRate(input) || !validRate(output)}
                onClick={applyManual}
              >
                {t('この単価を適用', 'Apply these rates')}
              </Button>
            </>
          )}
        </div>
      </details>
      <p className="helper-text">
        {value.price
          ? t(
              `${value.price.source === 'user' ? '利用者設定' : '公式SKU'} · 入力 $${value.price.inputMicrousdPerMillion / 1_000_000} / 出力 $${value.price.outputMicrousdPerMillion / 1_000_000}（100万トークンあたり）`,
              `${value.price.source === 'user' ? 'User rates' : 'Public SKU rates'} · Input $${value.price.inputMicrousdPerMillion / 1_000_000} / output $${value.price.outputMicrousdPerMillion / 1_000_000} per million tokens`,
            )
          : t(
              '料金未設定：送信範囲を承認して使えます。ドル上限は計算できません。',
              'Pricing is unset: approve the request scope to use this model. A dollar limit cannot be calculated.',
            )}
      </p>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

function validRate(value: string) {
  return /^\d+(?:\.\d{1,6})?$/.test(value) && Number(value) <= 1_000_000;
}
