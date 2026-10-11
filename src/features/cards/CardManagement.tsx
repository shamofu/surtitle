// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cardsApi } from './api';
import { cardEditor } from './editing';
import type { StudyCard } from '../../shared/contracts/cards';
import { useDataActions, useAppearance, useNotifications } from '../../app/runtime';
import { Button, Field, Modal, useModalExit } from '../../shared/ui/index';
import { useEditingSession } from '../../shared/editing/useEditingSession';

export function EditCardDialog({ card, onClose }: { card: StudyCard; onClose: () => void }) {
  const { t } = useAppearance();
  const client = useQueryClient();
  const [session] = useState(() => cardEditor(card.id, client));
  const edit = useEditingSession(session);
  const exit = useModalExit();
  const close = () => { void session.flush(); void exit.close(onClose); };
  const fields = [
    ['term', t('語彙・フレーズ', 'Word or phrase')], ['meaning', t('意味', 'Meaning')],
    ['example', t('例文', 'Example')], ['translation', t('翻訳', 'Translation')],
    ['explanation', t('解説・メモ', 'Explanation or notes')],
  ] as const;
  return <Modal {...exit.modalProps} title={t('フレーズを編集', 'Edit phrase')} onClose={close}>
    <fieldset disabled={!edit.ready || exit.exiting} onBlur={() => void session.flush()}>
      {fields.map(([key, label]) => <Field key={key} label={label}
        error={key === 'term' && edit.ready && !edit.fields.term?.trim() ? t('語彙・フレーズを入力してください。', 'Enter a word or phrase.') : undefined}>
        {key === 'term'
          ? <input autoFocus value={edit.fields[key] ?? ''} maxLength={4095} onChange={event => session.change({ [key]: event.target.value })} />
          : <textarea value={edit.fields[key] ?? ''} rows={key === 'example' || key === 'explanation' ? 3 : 2} onChange={event => session.change({ [key]: event.target.value })} />}
      </Field>)}
    </fieldset>
    {edit.recovery && <div className="notice warning">
      <p>{t('このフレーズは下書きの保存後に変更されています。前の入力を確認できます。', 'This phrase changed after the draft was saved. Your previous input is available below.')}</p>
      <textarea aria-label={t('前の入力', 'Previous input')} readOnly value={Object.values(edit.recovery).join('\n\n')} rows={4} />
      <Button onClick={() => session.recover()}>{t('この入力から編集を続ける', 'Continue editing this input')}</Button>
    </div>}
    {edit.error && <p className="notice warning" role="alert">{edit.error} <Button onClick={() => void session.flush()}>{t('再試行', 'Retry')}</Button></p>}
    <footer className="modal-footer autosave-footer">
      <span role="status">{edit.saving ? t('保存中…', 'Saving…') : edit.dirty ? t('入力途中の内容を保持しています', 'Unfinished input is kept') : t('自動保存', 'Saved automatically')}</span>
      <Button onClick={close}>{t('閉じる', 'Close')}</Button>
    </footer>
  </Modal>;
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
