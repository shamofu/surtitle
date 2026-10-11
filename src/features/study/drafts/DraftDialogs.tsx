// SPDX-License-Identifier: GPL-3.0-or-later
import { useMounted } from './lifecycle';
import { draftCardEditor } from './card-draft';
import { uiDraftApi } from '../../../shared/editing/drafts';
import { useEditingSession } from '../../../shared/editing/useEditingSession';
import { nativeAvailable } from '../../../shared/native/transport';
import { closeWindow, registerCloseTask, subscribeWindowClose } from '../../../shared/native/window';
import { useEffect, useRef, useState } from 'react';
import { AnimatedDetails } from '../../../shared/ui/AnimatedDetails';

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
import { Button, Field, Modal, useModalExit } from '../../../shared/ui/index';
import { useActivities } from '../../../app/providers/Activities';
import { ProgressStatus } from '../../../shared/ui/ProgressStatus';
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
  const exit = useModalExit();
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const { runTracked } = useActivities();
  const mounted = useMounted();
  const session = draftCardEditor(selection, candidate);
  const edit = useEditingSession(session);
  const binding = `${selection.id}:${selection.version}`;
  const [loadedBinding, setLoadedBinding] = useState('');
  useEffect(() => {
    let active = true;
    void (async () => {
      await session.refresh();
      if (candidate && !session.getSnapshot().recovery && !Object.values(session.getSnapshot().fields).some(Boolean)) {
        const saved = await uiDraftApi.get('draft_card', selection.id);
        if (active && !saved) session.change({ term: candidate.term, meaning: candidate.meaning,
          explanation: candidate.explanation ?? '', translation: candidate.translation ?? '' });
      }
      if (active) setLoadedBinding(binding);
    })().catch(() => { if (active) setLoadedBinding(binding); });
    return () => { active = false; };
  }, [session, binding, candidate, selection.id]);
  const ready = edit.ready && loadedBinding === binding;
  const { term = '', meaning = '', explanation = '', translation = '' } = edit.fields;
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const closeRequested = useRef(false);
  async function close() {
    if (exit.exiting) return;
    if (locked.current) { closeRequested.current = true; return; }
    if (await session.flush()) await exit.close(onClose);
  }
  async function save() {
    if (exit.exiting || locked.current || !ready || selection.stale || !selection.confirmed || !term.trim() || !meaning.trim()) return;
    locked.current = true;
    setBusy(true);
    const operationId = `local:${crypto.randomUUID()}`;
    const task = report(async () => {
      if (!await session.flush()) throw new Error(t('入力を保存できませんでした。再試行してください。', 'Could not keep your input. Please retry.'));
      await runTracked({ id: operationId, kind: 'audio', label: term.trim(), mediaId: selection.mediaId, phase: 'saving_audio' }, async () => {
        await mutate(() => draftStudyApi.saveCard({
          selectionId: selection.id, version: selection.version, term: term.trim(), meaning: meaning.trim(),
          explanation: explanation.trim() || undefined, translation: translation.trim() || undefined,
        }, operationId), { kind: 'snapshot' });
      });
      await report(() => session.resetDraft());
      return true;
    });
    // The operation and close task outlive the mounted dialog, including route changes.
    const unregister = registerCloseTask(async () => { await task; if (!await session.flush()) throw new Error('Could not preserve phrase input'); }, () => true);
    let nativeClosePending = false;
    const unsubscribe = nativeAvailable() ? subscribeWindowClose(() => {
      if (!nativeClosePending) {
        nativeClosePending = true;
        void task.then(() => closeWindow()).catch(cause => { nativeClosePending = false; void report(() => Promise.reject(cause)); });
      }
      return true;
    }, cause => { void report(() => Promise.reject(cause)); }) : () => {};
    const result = await task;
    unregister(); unsubscribe();
    locked.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (result || closeRequested.current) { closeRequested.current = false; await close(); }
  }
  return (
    <Modal {...exit.modalProps} title={t('この表現を覚える', 'Keep this phrase')}
      closeDisabled={exit.exiting} onClose={() => void close()}>
      <p className="draft-study-example">{selection.text}</p>
      {busy && <ProgressStatus label={term.trim()} phase="saving_audio" />}
      <p className="helper-text">
        {timestamp(selection.startMs, true)}–{timestamp(selection.endMs, true)} ·{' '}
        {t('選んだ区間と、設定した前後の余白の音声を保存します。', 'Save audio from the selected interval with the configured replay context.')}
      </p>
      <fieldset disabled={!ready || busy || exit.exiting} onBlur={() => void session.flush()}>
        <Field label={t('覚えたい表現', 'Phrase to remember')}>
          <input value={term} maxLength={500} onChange={event => session.change({ term: event.target.value })} />
        </Field>
        <Field label={t('意味', 'Meaning')}>
          <textarea value={meaning} maxLength={4000} onChange={event => session.change({ meaning: event.target.value })} />
        </Field>
        <Field label={t('訳（任意）', 'Translation (optional)')}>
          <textarea value={translation} maxLength={16000} onChange={event => session.change({ translation: event.target.value })} />
        </Field>
        <Field label={t('解説・メモ（任意）', 'Explanation or notes (optional)')}>
          <textarea value={explanation} maxLength={16000} onChange={event => session.change({ explanation: event.target.value })} />
        </Field>
      </fieldset>
      {edit.recovery && <div className="notice warning">
        <p>{t('選択区間が変わっています。前の入力を確認できます。', 'This selection changed. Your previous input is available below.')}</p>
        <textarea aria-label={t('前の入力', 'Previous input')} readOnly value={Object.values(edit.recovery).join('\n\n')} />
        <Button disabled={busy} onClick={() => session.recover()}>{t('この入力から編集を続ける', 'Continue editing this input')}</Button>
      </div>}
      {edit.error && <p role="alert" className="notice warning">{edit.error} <Button onClick={() => void session.flush()}>{t('再試行', 'Retry')}</Button></p>}
      <footer className="modal-footer">
        <span role="status">{t('入力途中の内容は自動保存されます', 'Unfinished input is kept automatically')}</span>
        <Button disabled={exit.exiting} onClick={() => void close()}>{t('閉じる', 'Close')}</Button>
        <Button variant="primary" busy={busy} disabled={!ready || selection.stale || !selection.confirmed || !term.trim() || !meaning.trim()} onClick={() => void save()}>
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
  const exit = useModalExit();
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { data } = useSnapshot();
  const { report } = useNotifications();
  const { runTracked } = useActivities();
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
  const lastAttempt = useRef('');
  const [quoteKey, setQuoteKey] = useState('');
  const inputKey = JSON.stringify([selection.id, selection.version, focusTerm.trim(), model, data?.settings.vertexLocation]);
  const currentInput = useRef(inputKey); currentInput.current = inputKey;
  const configured = !!data?.settings.credentialConfigured && !!data.settings.vertexProject;
  const valid = !!model.modelId.trim() && Number.isInteger(model.maxOutputTokens) && model.maxOutputTokens > 0;
  const estimateAction = useRef(() => {});
  useEffect(() => {
    if (quoteKey !== inputKey) setQuote(undefined);
    if (!configured || !valid || busy || lastAttempt.current === inputKey) return;
    const timer = window.setTimeout(() => { lastAttempt.current = inputKey; estimateAction.current(); }, 350);
    return () => window.clearTimeout(timer);
  }, [inputKey, quoteKey, configured, valid, busy]);
  async function estimate() {
    if (
      exit.exiting || locked.current ||
      !model.modelId.trim() ||
      !Number.isInteger(model.maxOutputTokens) ||
      model.maxOutputTokens <= 0
    )
      return;
    locked.current = true;
    setBusy(true);
    const result = await report(() => runTracked({ kind: 'estimate', label: selection.text, mediaId: selection.mediaId, phase: 'estimating' }, () =>
      mutate(
        () =>
          draftStudyApi.createQuote({
            selectionId: selection.id,
            version: selection.version,
            focusTerm: focusTerm.trim() || undefined,
            model,
          }),
        { kind: 'snapshot' },
      )),
    );
    if (!mounted.current) return;
    locked.current = false;
    setBusy(false);
    if (result && currentInput.current === inputKey) { setQuote(result); setQuoteKey(inputKey); }
  }
  estimateAction.current = () => { void estimate(); };
  async function approve() {
    if (exit.exiting || !quote || quoteKey !== inputKey || locked.current) return;
    locked.current = true;
    setBusy(true);
    const result = await report(
      async () => {
        await mutate(() => aiApi.approveQuote(quote), { kind: 'snapshot' });
        return true;
      },
      t('AI処理を開始しました。', 'AI job started.'),
    );
    if (!mounted.current) return;
    locked.current = false;
    setBusy(false);
    if (result) await exit.close(onClose);
  }
  return (
    <Modal
      {...exit.modalProps}
      title={t('この表現に、AIの助けを', 'AI for this phrase')}
      closeDisabled={busy || exit.exiting}
      onClose={() => {
        if (!busy && !exit.exiting) void exit.close(onClose);
      }}
    >
      <p className="draft-study-example">{selection.text}</p>
      {busy && <ProgressStatus label={selection.text} phase={quote ? 'starting' : 'estimating'} />}
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
          <AnimatedDetails open={!valid}><summary>{t('モデルを変更', 'Change model')}</summary>
          <ModelEditor
            value={model}
            onChange={(value) =>
              setModels((items) => ({ ...items, [purpose]: value }))
            }
            purpose={purpose}
            location={data?.settings.vertexLocation || 'global'}
            disabled={busy}
          />
          </AnimatedDetails>
          {!configured && <p role="status">{t('設定でモデルと認証を設定してください。', 'Configure your model and credentials in Settings.')}</p>}
          {quote && quoteKey === inputKey && <QuoteApproval quote={quote} busy={busy} onApprove={() => void approve()} onRefresh={() => void estimate()} />}
          {!quote && !busy && configured && valid && lastAttempt.current === inputKey && <Button onClick={() => void estimate()}>{t('見積もりを再試行', 'Retry estimate')}</Button>}
      </>
    </Modal>
  );
}
