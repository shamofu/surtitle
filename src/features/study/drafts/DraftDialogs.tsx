// SPDX-License-Identifier: GPL-3.0-or-later
import { useMounted } from './lifecycle';
import { useRef, useState } from 'react';

import { aiApi } from '../../ai/api';

import type { AiModelPreference } from '../../../shared/contracts/ai';
import type { AiPurpose } from '../../../shared/contracts/ai';
import type { AiQuote } from '../../../shared/contracts/ai';

import type { VocabularyCandidate } from '../../../shared/contracts/cards';
import {
  useDataActions,
  useAppearance,
  useNotifications,
  useSnapshot,
} from '../../../app/runtime';
import { draftStudyApi } from './api';
import type { DraftSelection } from './api';
import { timestamp } from '../../../shared/format';
import { QuoteApproval } from '../../ai/QuoteApproval';
import { ModelEditor, emptyModel } from '../../ai/ModelEditor';
import { Button, Field, Modal } from '../../../shared/ui/index';
import './draft-study.css';

export function DraftCardDialog({
  selection,
  candidate,
  onClose,
}: {
  selection: DraftSelection;
  candidate?: VocabularyCandidate;
  onClose: () => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const mounted = useMounted();
  const [term, setTerm] = useState(candidate?.term || '');
  const [meaning, setMeaning] = useState(candidate?.meaning || '');
  const [explanation, setExplanation] = useState(candidate?.explanation || '');
  const [translation, setTranslation] = useState(candidate?.translation || '');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  async function save() {
    if (locked.current || !term.trim() || !meaning.trim()) return;
    locked.current = true;
    setBusy(true);
    const result = await report(
      async () => {
        await mutate(
          () =>
            draftStudyApi.saveCard({
              selectionId: selection.id,
              version: selection.version,
              term: term.trim(),
              meaning: meaning.trim(),
              explanation: explanation.trim() || undefined,
              translation: translation.trim() || undefined,
            }),
          { kind: 'snapshot' },
        );
        return true;
      },
      t('音声付きカードを保存しました。', 'Audio card saved.'),
    );
    if (!mounted.current) return;
    locked.current = false;
    setBusy(false);
    if (result) onClose();
  }
  return (
    <Modal
      title={t('この表現を覚える', 'Keep this phrase')}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="draft-study-example">{selection.text}</p>
      <p className="helper-text">
        {timestamp(selection.startMs, true)}–{timestamp(selection.endMs, true)}{' '}
        ·{' '}
        {t(
          '確認した区間と、設定した前後の余白の音声を保存します。',
          'Save audio from the checked interval with the configured replay context.',
        )}
      </p>
      <Field label={t('覚えたい表現', 'Phrase to remember')}>
        <input
          value={term}
          maxLength={500}
          disabled={busy}
          onChange={(event) => setTerm(event.target.value)}
        />
      </Field>
      <Field label={t('意味', 'Meaning')}>
        <textarea
          value={meaning}
          maxLength={4000}
          disabled={busy}
          onChange={(event) => setMeaning(event.target.value)}
        />
      </Field>
      <Field label={t('訳（任意）', 'Translation (optional)')}>
        <textarea
          value={translation}
          maxLength={16000}
          disabled={busy}
          onChange={(event) => setTranslation(event.target.value)}
        />
      </Field>
      <Field label={t('解説・メモ（任意）', 'Explanation or notes (optional)')}>
        <textarea
          value={explanation}
          maxLength={16000}
          disabled={busy}
          onChange={(event) => setExplanation(event.target.value)}
        />
      </Field>
      <footer className="modal-footer">
        <Button disabled={busy} onClick={onClose}>
          {t('キャンセル', 'Cancel')}
        </Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={!term.trim() || !meaning.trim()}
          onClick={() => void save()}
        >
          {t('カードと音声を保存', 'Save card and audio')}
        </Button>
      </footer>
    </Modal>
  );
}

export function DraftAiDialog({
  selection,
  onClose,
}: {
  selection: DraftSelection;
  onClose: () => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { data } = useSnapshot();
  const { report } = useNotifications();
  const mounted = useMounted();
  const [focusTerm, setFocusTerm] = useState('');
  const [models, setModels] = useState<
    Partial<Record<AiPurpose, AiModelPreference>>
  >({});
  const purpose: AiPurpose = focusTerm.trim() ? 'explanation' : 'vocabulary';
  const model =
    models[purpose] ||
    data?.settings.aiModels?.[purpose] ||
    emptyModel(purpose);
  const [quote, setQuote] = useState<AiQuote>();
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  async function estimate() {
    if (
      locked.current ||
      !model.modelId.trim() ||
      !Number.isInteger(model.maxOutputTokens) ||
      model.maxOutputTokens <= 0
    )
      return;
    locked.current = true;
    setBusy(true);
    const result = await report(() =>
      mutate(
        () =>
          draftStudyApi.createQuote({
            selectionId: selection.id,
            version: selection.version,
            focusTerm: focusTerm.trim() || undefined,
            model,
          }),
        { kind: 'snapshot' },
      ),
    );
    if (!mounted.current) return;
    locked.current = false;
    setBusy(false);
    if (result) setQuote(result);
  }
  async function approve() {
    if (!quote || locked.current) return;
    locked.current = true;
    setBusy(true);
    const result = await report(
      async () => {
        await mutate(() => aiApi.approveQuote(quote), { kind: 'snapshot' });
        return true;
      },
      t('承認したAI処理を開始しました。', 'The approved AI job has started.'),
    );
    if (!mounted.current) return;
    locked.current = false;
    setBusy(false);
    if (result) onClose();
  }
  return (
    <Modal
      title={t('この表現に、AIの助けを', 'AI for this phrase')}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="draft-study-example">{selection.text}</p>
      {quote ? (
        <QuoteApproval
          key={quote.id}
          quote={quote}
          busy={busy}
          onApprove={() => void approve()}
        />
      ) : (
        <>
          <Field
            label={t(
              '解説する表現（空欄なら候補を提案）',
              'Phrase to explain (leave blank for suggestions)',
            )}
          >
            <input
              value={focusTerm}
              maxLength={500}
              disabled={busy}
              onChange={(event) => setFocusTerm(event.target.value)}
            />
          </Field>
          <ModelEditor
            value={model}
            onChange={(value) =>
              setModels((items) => ({ ...items, [purpose]: value }))
            }
            purpose={purpose}
            location={data?.settings.vertexLocation || 'global'}
            disabled={busy}
          />
          <Button
            variant="primary"
            busy={busy}
            disabled={
              !model.modelId.trim() ||
              !Number.isInteger(model.maxOutputTokens) ||
              model.maxOutputTokens <= 0
            }
            onClick={() => void estimate()}
          >
            {t(
              'この確認済み本文で見積もる',
              'Estimate using this checked text',
            )}
          </Button>
        </>
      )}
    </Modal>
  );
}
