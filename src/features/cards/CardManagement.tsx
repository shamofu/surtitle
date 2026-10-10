// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef, useState } from 'react';
import { cardsApi } from './api';
import type { StudyCard } from '../../shared/contracts/cards';
import {
  useDataActions,
  useAppearance,
  useNotifications,
} from '../../app/runtime';
import { Button, Field, Modal, useModalExit } from '../../shared/ui/index';
import { MotionRegion, MotionSwap } from '../../shared/motion';

export function EditCardDialog({
  card,
  onClose,
}: {
  card: StudyCard;
  onClose: () => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const [term, setTerm] = useState(card.term),
    [meaning, setMeaning] = useState(card.meaning),
    [example, setExample] = useState(card.example),
    [translation, setTranslation] = useState(card.translation || ''),
    [explanation, setExplanation] = useState(card.explanation || '');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const exit = useModalExit();
  const confirmationExit = useModalExit(confirmClose);
  const [saveError, setSaveError] = useState('');
  const dirty = term.trim() !== card.term || meaning !== card.meaning ||
    example !== card.example || translation !== (card.translation || '') ||
    explanation !== (card.explanation || '');
  function close() {
    if (pending.current || exit.exiting || confirmationExit.exiting) return;
    if (dirty) setConfirmClose(true);
    else void exit.close(onClose);
  }
  async function closeEditor() {
    if (confirmClose) {
      await confirmationExit.close(async () => {
        setConfirmClose(false);
        await exit.close(onClose);
      });
      return;
    }
    await exit.close(onClose);
  }
  function keepEditing() {
    if (!pending.current) void confirmationExit.close(() => setConfirmClose(false));
  }
  async function save() {
    if (pending.current || exit.exiting || confirmationExit.exiting || !dirty || !term.trim()) return;
    pending.current = true;
    setBusy(true);
    setSaveError('');
    const ok = await report(
      async () => {
        try {
          await mutate(
            () => cardsApi.editCard({
              id: card.id,
              term: term.trim(),
              meaning,
              example,
              translation: translation || undefined,
              explanation: explanation || undefined,
            }),
            { kind: 'snapshot' },
          );
        } catch (error) {
          setSaveError(error instanceof Error ? error.message : String(error));
          throw error;
        }
        return true;
      },
      t('フレーズを更新しました。', 'Phrase updated.'),
    );
    setBusy(false);
    pending.current = false;
    if (ok) await closeEditor();
  }
  return (
    <Modal
      {...exit.modalProps}
      title={t('フレーズを編集', 'Edit phrase')}
      onClose={close}
      closeDisabled={busy || exit.exiting || confirmationExit.exiting}
    >
      <fieldset disabled={busy || exit.exiting || confirmationExit.exiting}>
        <Field label={t('語彙・フレーズ', 'Word or phrase')}>
          <input
            autoFocus
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            maxLength={4095}
          />
        </Field>
        <Field label={t('意味', 'Meaning')}>
          <textarea
            value={meaning}
            onChange={(event) => setMeaning(event.target.value)}
            rows={2}
          />
        </Field>
        <Field label={t('例文', 'Example')}>
          <textarea
            value={example}
            onChange={(event) => setExample(event.target.value)}
            rows={3}
          />
        </Field>
        <Field label={t('翻訳', 'Translation')}>
          <textarea
            value={translation}
            onChange={(event) => setTranslation(event.target.value)}
            rows={2}
          />
        </Field>
        <Field label={t('解説・メモ', 'Explanation or notes')}>
          <textarea
            value={explanation}
            onChange={(event) => setExplanation(event.target.value)}
            rows={3}
          />
        </Field>
        <p className="helper-text">
          {t(
            '保存済み音声と復習の予定はそのまま保持します。',
            'Saved audio and your review schedule stay unchanged.',
          )}
        </p>
        <MotionRegion open={!!saveError}><p className="notice warning" role="alert"><MotionSwap as="span" stateKey={saveError}>{saveError}</MotionSwap></p></MotionRegion>
        <footer className="modal-footer">
          <Button onClick={close}>
            {t('キャンセル', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!dirty || !term.trim()}
            onClick={() => void save()}
          >
            {t('保存', 'Save')}
          </Button>
        </footer>
      </fieldset>
      {confirmClose && <Modal
        {...confirmationExit.modalProps}
        title={t('変更を保存しますか？', 'Save your changes?')}
        onClose={keepEditing}
        closeDisabled={busy || confirmationExit.exiting}
      >
        <p>{t('このフレーズには未保存の変更があります。', 'This phrase has unsaved changes.')}</p>
        <MotionRegion open={!!saveError}><p className="notice warning" role="alert"><MotionSwap as="span" stateKey={saveError}>{saveError}</MotionSwap></p></MotionRegion>
        <footer className="modal-footer">
          <Button disabled={busy} onClick={keepEditing}>{t('編集を続ける', 'Keep editing')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void closeEditor()}>{t('保存せずに閉じる', 'Discard changes')}</Button>
          <Button variant="primary" busy={busy} disabled={!term.trim()} onClick={() => void save()}>{t('保存して閉じる', 'Save and close')}</Button>
        </footer>
      </Modal>}
    </Modal>
  );
}

export function DeleteCardDialog({
  card,
  onClose,
}: {
  card: StudyCard;
  onClose: () => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const [busy, setBusy] = useState(false);
  const exit = useModalExit();
  const close = () => { if (!busy) void exit.close(onClose); };
  async function remove() {
    if (busy || exit.exiting) return;
    setBusy(true);
    const ok = await report(async () => {
      await mutate(() => cardsApi.deleteCard(card.id), { kind: 'snapshot' });
      return true;
    });
    setBusy(false);
    if (ok) await exit.close(onClose);
  }
  return (
    <Modal
      {...exit.modalProps}
      title={t('フレーズを削除', 'Delete phrase')}
      closeDisabled={busy || exit.exiting}
      onClose={close}
    >
      <p>{card.term}</p>
      <p className="notice warning">
        {t(
          'このフレーズと復習履歴を削除します。復習を一時的に止めたい場合は「復習を停止」を使えます。',
          'Delete this phrase and its review history. Use “Suspend reviews” if you only want a temporary break.',
        )}
      </p>
      <footer className="modal-footer">
        <Button disabled={busy} onClick={close}>
          {t('キャンセル', 'Cancel')}
        </Button>
        <Button variant="danger" busy={busy} onClick={() => void remove()}>
          {t('削除する', 'Delete phrase')}
        </Button>
      </footer>
    </Modal>
  );
}
