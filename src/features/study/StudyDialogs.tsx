// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef, useState } from 'react';

import { AudioLines, BookmarkPlus, Check } from 'lucide-react';

import { cardsApi } from '../cards/api';
import { studyApi } from './api';

import type { SubtitleSegment } from '../../shared/contracts/media';
import type { VocabularyCandidate } from '../../shared/contracts/cards';
import {
  useDataActions,
  useAppearance,
  useNotifications,
} from '../../app/runtime';
import { parseTimestamp, timestamp } from '../../shared/format';
import { Button, Field, Modal } from '../../shared/ui/index';

import type { SelectedContext } from './source-selection';

export interface PhraseFormValues {
  term: string;
  meaning: string;
  example: string;
  explanation: string;
}

export function phraseFormValues(
  segment: SelectedContext,
  candidate?: VocabularyCandidate,
  initialTerm = '',
): PhraseFormValues {
  return {
    term: candidate?.term || initialTerm,
    meaning: candidate?.meaning || '',
    example: candidate?.example || segment.text,
    explanation: candidate?.explanation || '',
  };
}

export function EditDialog({
  segment,
  onClose,
}: {
  segment: SubtitleSegment;
  onClose: () => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const [text, setText] = useState(segment.text);
  const [translation, setTranslation] = useState(segment.translation || '');
  const [start, setStart] = useState(timestamp(segment.startMs, true));
  const [end, setEnd] = useState(timestamp(segment.endMs, true));
  const [busy, setBusy] = useState(false);
  const startMs = parseTimestamp(start),
    endMs = parseTimestamp(end);
  async function save() {
    if (startMs === null || endMs === null || endMs <= startMs) return;
    setBusy(true);
    const success = await report(
      async () => {
        await mutate(
          () =>
            studyApi.editSegment({
              ...segment,
              text: text.trim(),
              translation: translation.trim() || undefined,
              startMs,
              endMs,
              status: 'confirmed',
            }),
          { kind: 'subtitles', mediaId: segment.mediaId },
        );
        return true;
      },
      t('字幕を保存しました。', 'Subtitle saved.'),
    );
    setBusy(false);
    if (success) onClose();
  }
  return (
    <Modal
      title={t('字幕を編集', 'Edit subtitle')}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="field-row">
        <Field label={t('開始', 'From')}>
          <input
            value={start}
            onChange={(event) => setStart(event.target.value)}
          />
        </Field>
        <Field label={t('終了', 'To')}>
          <input value={end} onChange={(event) => setEnd(event.target.value)} />
        </Field>
      </div>
      <Field label={t('字幕', 'Subtitle')}>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          autoFocus
        />
      </Field>
      <Field label={t('翻訳', 'Translation')}>
        <textarea
          value={translation}
          onChange={(event) => setTranslation(event.target.value)}
          rows={3}
        />
      </Field>
      <footer className="modal-footer">
        <Button onClick={onClose}>{t('キャンセル', 'Cancel')}</Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={
            !text.trim() ||
            startMs === null ||
            endMs === null ||
            endMs <= startMs
          }
          onClick={() => void save()}
        >
          <Check size={16} />
          {t('内容を確認して保存', 'Confirm and save')}
        </Button>
      </footer>
    </Modal>
  );
}

export function SaveCardDialog({
  segment,
  candidate,
  initialTerm = '',
  onClose,
}: {
  segment: SelectedContext;
  candidate?: VocabularyCandidate;
  initialTerm?: string;
  onClose: () => void;
}) {
  const { t } = useAppearance();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={t('フレーズを保存', 'Save phrase')} onClose={() => { if (!busy) onClose(); }}>
      <SaveCardForm segment={segment} candidate={candidate} initialTerm={initialTerm} onClose={onClose} onBusyChange={setBusy} />
    </Modal>
  );
}

export function SaveCardForm({
  segment,
  candidate,
  initialTerm = '',
  onClose,
  onSaved,
  onBusyChange,
  value,
  onChange,
  onDiscard,
  sourceInvalid = false,
}: {
  segment: SelectedContext;
  candidate?: VocabularyCandidate;
  initialTerm?: string;
  onClose: () => void;
  onSaved?: () => void;
  onBusyChange?: (busy: boolean) => void;
  value?: PhraseFormValues;
  onChange?: (value: PhraseFormValues) => void;
  onDiscard?: () => void;
  sourceInvalid?: boolean;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const [localValue, setLocalValue] = useState(() => phraseFormValues(segment, candidate, initialTerm));
  const values = value ?? localValue;
  const { term, meaning, example, explanation } = values;
  function change(patch: Partial<PhraseFormValues>) {
    const next = { ...values, ...patch };
    if (onChange) onChange(next);
    else setLocalValue(next);
  }
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [saveError, setSaveError] = useState('');
  const confirmed = !segment.status || segment.status === 'confirmed';
  async function save() {
    if (sourceInvalid || !confirmed || pending.current || !term.trim() || !meaning.trim() || !example.trim()) return;
    pending.current = true;
    setBusy(true);
    setSaveError('');
    onBusyChange?.(true);
    const success = await report(
      async () => {
        try {
          await mutate(
            () =>
              cardsApi.saveCard({
                mediaId: segment.mediaId,
                segmentId: segment.id,
                sourceCueIds: candidate?.sourceCueIds ?? segment.sourceCueIds,
                term: term.trim(),
                meaning: meaning.trim(),
                example: example.trim(),
                explanation: explanation.trim() || undefined,
                translation: candidate
                  ? candidate.translation
                  : segment.translation,
              }),
            { kind: 'snapshot' },
          );
        } catch (error) {
          setSaveError(error instanceof Error ? error.message : String(error));
          throw error;
        }
        return true;
      },
      t('マイフレーズに保存しました。', 'Saved to your phrases.'),
    );
    setBusy(false);
    pending.current = false;
    onBusyChange?.(false);
    if (success) (onSaved || onClose)();
  }
  return (
    <fieldset className="save-phrase-form" disabled={busy}>
      <Field label={t('語彙・フレーズ', 'Word or phrase')}>
        <input
          autoFocus
          value={term}
          onChange={(event) => change({ term: event.target.value })}
          placeholder={t('覚えておきたい表現', 'A phrase worth remembering')}
        />
      </Field>
      <Field label={t('意味', 'Meaning')}>
        <textarea
          value={meaning}
          onChange={(event) => change({ meaning: event.target.value })}
          rows={2}
        />
      </Field>
      <Field label={t('元の文脈', 'Original context')}>
        <textarea
          value={example}
          onChange={(event) => change({ example: event.target.value })}
          rows={3}
        />
      </Field>
      <Field label={t('解説・メモ（任意）', 'Explanation or notes (optional)')}>
        <textarea
          value={explanation}
          onChange={(event) => change({ explanation: event.target.value })}
          rows={2}
        />
      </Field>
      <p className="notice">
        <AudioLines size={17} />
        <span>
          {t(
            `${timestamp(candidate?.startMs ?? segment.startMs)}–${timestamp(candidate?.endMs ?? segment.endMs)} の音声と文脈を残して復習します。`,
            `Review with audio and context from ${timestamp(candidate?.startMs ?? segment.startMs)}–${timestamp(candidate?.endMs ?? segment.endMs)}.`,
          )}
        </span>
      </p>
      {!confirmed && (
        <p className="notice warning">
          {t(
            'この字幕は未確認です。先に字幕を編集して内容を確認してください。',
            'Confirm this provisional subtitle before saving a card.',
          )}
        </p>
      )}
      {sourceInvalid && <p className="notice warning" role="alert">{t(
        '出典が変わったため保存できません。入力をコピーするか、破棄して字幕を選び直してください。',
        'The source changed. Copy your notes or discard this draft and select the subtitles again.',
      )}</p>}
      {saveError && <p className="notice warning" role="alert">{saveError}</p>}
      {(!term.trim() || !meaning.trim() || !example.trim()) && <p className="helper-text">{t(
        '語彙・フレーズ、意味、元の文脈を入力すると保存できます。',
        'Enter a phrase, meaning, and original context to save.',
      )}</p>}
      <footer className="modal-footer">
        {onDiscard && <Button variant="ghost" onClick={onDiscard}>{t('入力を破棄', 'Discard draft')}</Button>}
        <Button onClick={onClose}>{onChange ? t('あとで続ける', 'Continue later') : t('キャンセル', 'Cancel')}</Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={
            sourceInvalid || !confirmed || !term.trim() || !meaning.trim() || !example.trim()
          }
          onClick={() => void save()}
        >
          <BookmarkPlus size={16} />
          {t('フレーズを保存', 'Save phrase')}
        </Button>
      </footer>
    </fieldset>
  );
}
