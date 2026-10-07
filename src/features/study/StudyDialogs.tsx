// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';

import { AudioLines, BookmarkPlus, Check } from 'lucide-react';

import { cardsApi } from '../cards/api';
import { studyApi } from './api';
import { playerApi } from './playback/api';

import { subtitleUsable, type SubtitleSegment } from '../../shared/contracts/media';
import { editorDraftApi, editorSourceKey, flushEditorDrafts, useEditorDraft } from './editor-drafts/useEditorDraft';
import type { DraftSaveStatus } from './editor-drafts/session';
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
  audioStart?: string;
  audioEnd?: string;
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
    ...(segment.timingPrecision === 'source_block' ? {
      audioStart: timestamp(segment.startMs, true),
      audioEnd: timestamp(Math.min(segment.endMs, segment.startMs + 180000), true),
    } : {}),
  };
}

export function EditDialog({
  segment,
  onClose,
  onRetranscribe,
}: {
  segment: SubtitleSegment;
  onClose: () => void;
  onRetranscribe?: (range: { startMs: number; endMs: number }) => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report, notify } = useNotifications();
  const [values, setValues] = useState({ text: segment.text, translation: segment.translation || '',
    start: timestamp(segment.startMs, true), end: timestamp(segment.endMs, true) });
  const { text, translation, start, end } = values;
  const draft = useEditorDraft({ mediaId: segment.mediaId, kind: 'subtitle', sourceKey: editorSourceKey([segment]),
    sourceCues: [segment], initialValue: values, onRestore: setValues });
  function change(patch: Partial<typeof values>) {
    const next = { ...values, ...patch }; setValues(next); draft.setValue(next);
  }
  const [busy, setBusy] = useState(false);
  const startMs = parseTimestamp(start),
    endMs = parseTimestamp(end);
  async function save() {
    if (draft.stale || startMs === null || endMs === null || endMs <= startMs) return;
    setBusy(true);
    const success = await report(
      async () => {
        const stored = await draft.flush(true);
        const updated: SubtitleSegment = { ...(stored?.sourceCues[0] ?? segment), text: text.trim(), translation: translation.trim() || undefined,
          startMs, endMs, status: 'confirmed' };
        if (updated.reviewIssues?.length) updated.reviewIssues = [];
        await mutate(
          async () => {
            if (stored) {
              const warning = await editorDraftApi.commitSubtitle(stored, updated);
              if (warning) notify(t('字幕を保存しました。再生表示の更新には動画を開き直してください。', 'Subtitle saved. Reopen the video to refresh its display.') + ` ${warning}`, 'error');
            } else await studyApi.editSegment(updated);
          },
          { kind: 'subtitles', mediaId: segment.mediaId },
        );
        draft.consume();
        return true;
      },
      t('字幕を保存しました。', 'Subtitle saved.'),
    );
    setBusy(false);
    if (success) onClose();
  }
  async function close(discard = false) {
    if (busy) return;
    const success = await report(async () => { if (discard) await draft.discard(); else await draft.flush(); return true; });
    if (success) onClose();
  }
  async function retranscribe() {
    if (busy || !onRetranscribe) return;
    setBusy(true);
    const saved = await report(async () => { await draft.flush(); return true; });
    setBusy(false);
    if (saved) onRetranscribe({ startMs: segment.startMs, endMs: segment.endMs });
  }
  return (
    <Modal
      title={t('字幕を編集', 'Edit subtitle')}
      onClose={() => void close()}
    >
      {!!segment.reviewIssues?.length && <details className="notice warning">
        <summary>{t('自動字幕の注意点と候補', 'Automatic subtitle notes and alternatives')}</summary>
        <p>{t('以下は元の生成結果です。必要な箇所を編集して保存できます。', 'These are the original generated results. Edit the subtitle below to make corrections.')}</p>
        {segment.reviewIssues.map(issue => <div key={issue.id}>
          <p>{timestamp(issue.startMs)}–{timestamp(issue.endMs)} · {issue.kind === 'boundary_conflict'
            ? t('境界で内容が一致しない候補があります。', 'Alternatives disagree at this boundary.')
            : t('生成結果の確認が必要な箇所です。', 'This part of the generated result needs attention.')}</p>
          {issue.alternatives.map((alternative, index) => <blockquote key={index}>
            <small>{timestamp(alternative.startMs)}–{timestamp(alternative.endMs)}</small>
            <p>{alternative.text}</p>
            <Button variant="ghost" disabled={busy || draft.stale} onClick={() => change({ text: alternative.text, start: timestamp(alternative.startMs, true), end: timestamp(alternative.endMs, true) })}>{t('この候補を使う', 'Use this alternative')}</Button>
          </blockquote>)}
        </div>)}
      </details>}
      {segment.timingPrecision === 'source_block' && <p className="helper-text">{t('この時刻は取得元の音声範囲です。本文の修正だけでは正確な字幕時刻には変わりません。', 'These times identify the source audio range. Editing the text does not establish precise subtitle timing.')}</p>}
      {onRetranscribe && <Button variant="ghost" disabled={busy} onClick={() => void retranscribe()}>{t('この区間を再文字起こし', 'Transcribe this range again')}</Button>}
      <div className="field-row">
        <Field label={t('開始', 'From')}>
          <input
            disabled={busy}
            value={start}
            onChange={(event) => change({ start: event.target.value })}
          />
        </Field>
        <Field label={t('終了', 'To')}>
          <input disabled={busy} value={end} onChange={(event) => change({ end: event.target.value })} />
        </Field>
      </div>
      <Field label={t('字幕', 'Subtitle')}>
        <textarea
          disabled={busy}
          value={text}
          onChange={(event) => change({ text: event.target.value })}
          rows={4}
          autoFocus
        />
      </Field>
      <Field label={t('翻訳', 'Translation')}>
        <textarea
          disabled={busy}
          value={translation}
          onChange={(event) => change({ translation: event.target.value })}
          rows={3}
        />
      </Field>
      <EditorDraftStatus status={draft.status} error={draft.error} retry={() => void report(() => draft.retry())} />
      {draft.stale && <SourceRebindPicker mediaId={segment.mediaId} sourceIds={[segment.id]} multiple={false}
        onRebind={async cues => { setBusy(true); try { await draft.rebind(cues); } finally { setBusy(false); } }} />}
      <footer className="modal-footer">
        <Button variant="ghost" onClick={() => void close(true)}>{t('入力を破棄', 'Discard draft')}</Button>
        <Button onClick={() => void close()}>{t('あとで続ける', 'Continue later')}</Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={
            draft.stale || draft.status === 'loading' || !text.trim() ||
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
  const { report } = useNotifications();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={t('フレーズを保存', 'Save phrase')} onClose={() => { if (!busy) void report(async () => { await flushEditorDrafts(); onClose(); }); }}>
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
  sourceCues,
  onSourceRebound,
  onDraftSaved,
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
  sourceCues?: SubtitleSegment[];
  onSourceRebound?: (cues: SubtitleSegment[]) => void;
  onDraftSaved?: () => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const [localValue, setLocalValue] = useState(() => phraseFormValues(segment, candidate, initialTerm));
  const values = value ?? localValue;
  const { term, meaning, example, explanation } = values;
  const restore = (next: PhraseFormValues) => { if (onChange) onChange(next); else setLocalValue(next); };
  const originalCues = sourceCues ?? [segment];
  const draft = useEditorDraft({ mediaId: segment.mediaId, kind: 'phrase', sourceKey: editorSourceKey(originalCues),
    sourceCues: originalCues, initialValue: values, onRestore: restore });
  const lastSavedVersion = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (draft.status === 'saved' && draft.draft && lastSavedVersion.current !== draft.draft.version) {
      lastSavedVersion.current = draft.draft.version; onDraftSaved?.();
    }
  }, [draft.status, draft.draft, onDraftSaved]);
  const invalidSource = sourceInvalid || draft.stale;
  function change(patch: Partial<PhraseFormValues>) {
    const next = { ...values, ...patch };
    restore(next); draft.setValue(next);
  }
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [saveError, setSaveError] = useState('');
  const confirmed = subtitleUsable(segment);
  const sourceBlock = segment.timingPrecision === 'source_block';
  const audioStart = parseTimestamp(values.audioStart ?? timestamp(segment.startMs, true));
  const audioEnd = parseTimestamp(values.audioEnd ?? timestamp(Math.min(segment.endMs, segment.startMs + 180000), true));
  const audioValid = !sourceBlock || (audioStart !== null && audioEnd !== null && audioStart >= segment.startMs && audioEnd <= segment.endMs && audioEnd > audioStart && audioEnd - audioStart <= 180000);
  async function previewAudio() {
    if (!audioValid || audioStart === null || audioEnd === null || invalidSource || busy) return;
    setBusy(true); onBusyChange?.(true);
    await report(() => playerApi.player({ action: 'source-seek', startMs: audioStart, endMs: audioEnd }));
    setBusy(false); onBusyChange?.(false);
  }
  async function save() {
    if (invalidSource || !confirmed || !audioValid || pending.current || !term.trim() || !meaning.trim() || !example.trim()) return;
    pending.current = true;
    setBusy(true);
    setSaveError('');
    onBusyChange?.(true);
    const success = await report(
      async () => {
        try {
          const stored = await draft.flush(true);
          const request = {
            mediaId: segment.mediaId, segmentId: segment.id,
            sourceCueIds: candidate?.sourceCueIds ?? segment.sourceCueIds,
            ...(sourceBlock && audioStart !== null && audioEnd !== null ? { sourceRange: { startMs: audioStart, endMs: audioEnd } } : {}),
            term: term.trim(), meaning: meaning.trim(), example: example.trim(),
            explanation: explanation.trim() || undefined,
            translation: candidate ? candidate.translation : segment.translation,
          };
          await mutate(
            () => stored ? editorDraftApi.savePhrase(stored, request) : cardsApi.saveCard(request),
            { kind: 'snapshot' },
          );
          draft.consume(); onDraftSaved?.();
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
  async function close(discard = false) {
    const success = await report(async () => { if (discard) await draft.discard(); else await draft.flush(); return true; });
    if (success) { if (discard) { onDraftSaved?.(); (onDiscard || onClose)(); } else onClose(); }
  }
  async function rebind(cues: SubtitleSegment[]) {
    setBusy(true); onBusyChange?.(true);
    try { await draft.rebind(cues); onSourceRebound?.(cues); onDraftSaved?.(); }
    finally { setBusy(false); onBusyChange?.(false); }
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
      {sourceBlock && <section className="source-block-audio">
        <p className="helper-text">{t('本文は取得済みですが、発話の正確な時刻は未確定です。取得元の音声から、再生・保存する範囲を選べます（3分以内）。', 'The text is available; exact speech timing is unavailable. Choose up to 3 minutes of the source audio to replay and save.')}</p>
        <p className="helper-text">{t('取得元の音声範囲', 'Source audio range')}: {timestamp(segment.startMs)}–{timestamp(segment.endMs)}</p>
        <div className="field-row"><Field label={t('音声の開始', 'Audio from')}><input value={values.audioStart ?? timestamp(segment.startMs, true)} onChange={event => change({ audioStart: event.target.value })} /></Field>
          <Field label={t('音声の終了', 'Audio to')}><input value={values.audioEnd ?? timestamp(Math.min(segment.endMs, segment.startMs + 180000), true)} onChange={event => change({ audioEnd: event.target.value })} /></Field></div>
        {!audioValid && <p className="field-error">{t('取得元の範囲内で3分以内の音声を選んでください。', 'Select up to 3 minutes within the source audio range.')}</p>}
        <Button disabled={invalidSource || !audioValid} onClick={() => void previewAudio()}>{t('選んだ音声範囲を再生', 'Play selected audio range')}</Button>
      </section>}
      <p className="notice">
        <AudioLines size={17} />
        <span>
          {t(
            `${timestamp(sourceBlock ? audioStart ?? segment.startMs : candidate?.startMs ?? segment.startMs)}–${timestamp(sourceBlock ? audioEnd ?? segment.endMs : candidate?.endMs ?? segment.endMs)} の音声と文脈を残して復習します。`,
            `Review with audio and context from ${timestamp(sourceBlock ? audioStart ?? segment.startMs : candidate?.startMs ?? segment.startMs)}–${timestamp(sourceBlock ? audioEnd ?? segment.endMs : candidate?.endMs ?? segment.endMs)}.`,
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
      <EditorDraftStatus status={draft.status} error={draft.error} retry={() => void report(() => draft.retry())} />
      {invalidSource && <SourceRebindPicker mediaId={segment.mediaId}
        sourceIds={candidate?.sourceCueIds ?? segment.sourceCueIds ?? [segment.id]} multiple onRebind={rebind} />}
      {saveError && <p className="notice warning" role="alert">{saveError}</p>}
      {(!term.trim() || !meaning.trim() || !example.trim()) && <p className="helper-text">{t(
        '語彙・フレーズ、意味、元の文脈を入力すると保存できます。',
        'Enter a phrase, meaning, and original context to save.',
      )}</p>}
      <footer className="modal-footer">
        <Button variant="ghost" onClick={() => void close(true)}>{t('入力を破棄', 'Discard draft')}</Button>
        <Button onClick={() => void close()}>{t('あとで続ける', 'Continue later')}</Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={
            invalidSource || draft.status === 'loading' || !confirmed || !audioValid || !term.trim() || !meaning.trim() || !example.trim()
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

function EditorDraftStatus({ status, error, retry }: { status: DraftSaveStatus; error: string; retry: () => void }) {
  const { t } = useAppearance();
  return <div className={error ? 'notice warning' : 'helper-text'} role={error ? 'alert' : 'status'}>
    {status === 'loading' ? t('下書きを読み込み中…', 'Loading draft…')
      : status === 'saving' ? t('下書きを保存中…', 'Saving draft…')
      : status === 'error' ? t('下書きを保存できませんでした。画面を閉じる前に再試行してください。', 'Could not save your draft. Retry before leaving.')
      : t('入力は自動保存されます。', 'Your input is saved automatically.')}
    {error && <> {error} <Button onClick={retry}>{t('再試行', 'Retry')}</Button></>}
  </div>;
}

function SourceRebindPicker({ mediaId, sourceIds, multiple, onRebind }: {
  mediaId: string; sourceIds: string[]; multiple: boolean; onRebind: (cues: SubtitleSegment[]) => Promise<void>;
}) {
  const { t } = useAppearance();
  const { report } = useNotifications();
  const [cues, setCues] = useState<SubtitleSegment[]>([]);
  const [ids, setIds] = useState(sourceIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void studyApi.segments(mediaId).then(items => {
      if (!live) return;
      const usable = multiple ? items.filter(subtitleUsable) : items;
      setCues(usable); setIds(current => current.filter(id => usable.some(cue => cue.id === id)));
    }).catch(cause => { if (live) setError(String(cause)); });
    return () => { live = false; };
  }, [mediaId, multiple]);
  return <div className="notice warning">
    <p>{t('出典が変わりました。入力を残したまま、現在の字幕を選んで結び直せます。', 'The source changed. Choose current subtitles to reconnect without losing your input.')}</p>
    <Field label={t('結び直す字幕', 'Replacement subtitles')}>
      <select multiple={multiple} size={multiple ? 5 : undefined} value={multiple ? ids : ids[0] ?? ''}
        onChange={event => setIds(Array.from(event.target.selectedOptions, option => option.value).filter(Boolean))}>
        {!multiple && <option value="">{t('字幕を選択', 'Choose a subtitle')}</option>}
        {cues.map(cue => <option key={cue.id} value={cue.id}>{timestamp(cue.startMs)} {cue.text}</option>)}
      </select>
    </Field>
    {multiple && <p className="helper-text">{t('複数の場合は連続する字幕を選んでください。', 'Choose consecutive subtitles when selecting more than one.')}</p>}
    {error && <p role="alert">{error}</p>}
    <Button disabled={!ids.length} busy={busy} onClick={() => {
      setBusy(true);
      void report(async () => { await onRebind(cues.filter(cue => ids.includes(cue.id))); })
        .finally(() => setBusy(false));
    }}>{t('選んだ字幕に結び直す', 'Use selected subtitles')}</Button>
  </div>;
}
