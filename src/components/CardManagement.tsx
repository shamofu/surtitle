// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { api } from '../api';
import type { StudyCard } from '../api';
import { useApp } from '../context';
import { Button, Field, Modal } from './ui';

export function EditCardDialog({ card, onClose }: { card: StudyCard; onClose: () => void }) {
  const { t, run } = useApp();
  const [term, setTerm] = useState(card.term), [meaning, setMeaning] = useState(card.meaning), [example, setExample] = useState(card.example), [translation, setTranslation] = useState(card.translation || ''), [explanation, setExplanation] = useState(card.explanation || '');
  const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); const ok = await run(async () => { await api.editCard({ id: card.id, term: term.trim(), meaning, example, translation: translation || undefined, explanation: explanation || undefined }); return true; }, t('フレーズを更新しました。', 'Phrase updated.')); setBusy(false); if (ok) onClose(); }
  return <Modal title={t('フレーズを編集', 'Edit phrase')} onClose={() => { if (!busy) onClose(); }}><Field label={t('語彙・フレーズ', 'Word or phrase')}><input autoFocus value={term} onChange={event => setTerm(event.target.value)} maxLength={4095} /></Field><Field label={t('意味', 'Meaning')}><textarea value={meaning} onChange={event => setMeaning(event.target.value)} rows={2} /></Field><Field label={t('例文', 'Example')}><textarea value={example} onChange={event => setExample(event.target.value)} rows={3} /></Field><Field label={t('翻訳', 'Translation')}><textarea value={translation} onChange={event => setTranslation(event.target.value)} rows={2} /></Field><Field label={t('解説・メモ', 'Explanation or notes')}><textarea value={explanation} onChange={event => setExplanation(event.target.value)} rows={3} /></Field><p className="helper-text">{t('保存済み音声と復習の予定はそのまま保持します。', 'Saved audio and your review schedule stay unchanged.')}</p><footer className="modal-footer"><Button disabled={busy} onClick={onClose}>{t('キャンセル', 'Cancel')}</Button><Button variant="primary" busy={busy} disabled={!term.trim()} onClick={() => void save()}>{t('保存', 'Save')}</Button></footer></Modal>;
}

export function DeleteCardDialog({ card, onClose }: { card: StudyCard; onClose: () => void }) {
  const { t, run } = useApp(); const [busy, setBusy] = useState(false);
  async function remove() { setBusy(true); const ok = await run(async () => { await api.deleteCard(card.id); return true; }); setBusy(false); if (ok) onClose(); }
  return <Modal title={t('フレーズを削除', 'Delete phrase')} onClose={() => { if (!busy) onClose(); }}><p>{card.term}</p><p className="notice warning">{t('このフレーズと復習履歴を削除します。復習を一時的に止めたい場合は「復習を停止」を使えます。', 'Delete this phrase and its review history. Use “Suspend reviews” if you only want a temporary break.')}</p><footer className="modal-footer"><Button disabled={busy} onClick={onClose}>{t('キャンセル', 'Cancel')}</Button><Button variant="danger" busy={busy} onClick={() => void remove()}>{t('削除する', 'Delete phrase')}</Button></footer></Modal>;
}
