// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppearance } from '../../app/runtime';
import { call, nativeAvailable } from '../../shared/native/transport';
import { Button } from '../../shared/ui';

/** Orphaned input remains readable even when its original card no longer exists. */
export function RecoveredInputs() {
  const { t } = useAppearance();
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['recoverable-inputs'], queryFn: () => call('list_ui_drafts'), enabled: open && nativeAvailable(), staleTime: 0 });
  const drafts = (query.data ?? []).filter(draft => (draft.archiveId || draft.stale || draft.fields.recovery) && Object.keys(draft.fields).some(key => key !== 'baseRevision'));
  return <section className="recovered-inputs">
    <Button aria-expanded={open} onClick={() => { setOpen(value => !value); if (!open) void query.refetch(); }}>{t('以前の入力を回収', 'Recover earlier input')}</Button>
    {open && <div>
      <p className="helper-text">{t('競合した入力や、復元前・削除済みカードの入力です。必要な内容をコピーできます。現在のデータには自動適用しません。', 'Input preserved after a conflicting save, a restore, or card deletion. Copy the text you need; it is never applied automatically.')}</p>
      {query.error && <p role="alert">{query.error.message}</p>}
      {!query.isFetching && !drafts.length && <p>{t('回収する入力はありません。', 'No earlier input to recover.')}</p>}
      {drafts.map(draft => {
        const { baseRevision: _base, recovery, ...fields } = draft.fields;
        const text = [Object.keys(fields).length ? JSON.stringify(fields, null, 2) : '', recovery].filter(Boolean).join('\n\n');
        return <label className="field" key={draft.archiveId || `${draft.kind}:${draft.entityId}`}><span>{fields.term || t('以前の入力', 'Earlier input')} · {new Date(draft.updatedAt).toLocaleString()}</span><textarea readOnly rows={5} value={text} /></label>;
      })}
    </div>}
  </section>;
}
