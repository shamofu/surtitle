// SPDX-License-Identifier: GPL-3.0-or-later
import { AnimatedDetails } from '../../../shared/ui/AnimatedDetails';
import { DraftCardDialog, DraftAiDialog } from './DraftDialogs';
import { useMounted } from './lifecycle';
import type { PlayRange } from './lifecycle';
import { useEffect, useRef, useState } from 'react';
import {
  BookmarkPlus,
  Check,
  Download,
  Play,
  Sparkles,
  Trash2,
} from 'lucide-react';

import type { VocabularyCandidate } from '../../../shared/contracts/cards';
import { useAppearance, useNotifications } from '../../../app/runtime';
import { draftStudyApi } from './api';
import type { DraftSelection } from './api';
import { parseTimestamp, timestamp } from '../../../shared/format';
import { Badge, Button, Field } from '../../../shared/ui/index';
import { useActivities } from '../../../app/providers/Activities';
import { ProgressStatus } from '../../../shared/ui/ProgressStatus';
import './draft-study.css';

export function DraftSelectionEditor({
  selection,
  stale,
  playbackReady,
  onPlay,
  onSaved,
  onClose,
  onRemoved,
}: {
  selection: DraftSelection;
  stale: boolean;
  playbackReady: boolean;
  onPlay: PlayRange;
  onSaved: (selection: DraftSelection) => void;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { t } = useAppearance();
  const { report } = useNotifications();
  const { runTracked } = useActivities();
  const mounted = useMounted();
  const [text, setText] = useState(selection.text);
  const [start, setStart] = useState(timestamp(selection.startMs, true));
  const [end, setEnd] = useState(timestamp(selection.endMs, true));
  const [acknowledged, setAcknowledged] = useState(selection.confirmed);
  const [listened, setListened] = useState(selection.confirmed);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const locked = useRef(false);
  const editRevision = useRef(0);
  const [dialog, setDialog] = useState<'card' | 'ai'>();
  const [candidate, setCandidate] = useState<VocabularyCandidate>();
  const [candidates, setCandidates] = useState<VocabularyCandidate[]>([]);
  const [candidateError, setCandidateError] = useState('');
  const [format, setFormat] = useState<'json' | 'srt' | 'vtt'>('json');
  const startMs = parseTimestamp(start),
    endMs = parseTimestamp(end);
  const rangeValid =
    startMs !== null &&
    endMs !== null &&
    startMs >= selection.sourceStartMs &&
    endMs <= selection.sourceEndMs &&
    endMs > startMs;
  const valid =
    rangeValid &&
    !!text.trim() &&
    new TextEncoder().encode(text).length <= 16000;
  const dirty =
    text !== selection.text ||
    startMs !== selection.startMs ||
    endMs !== selection.endMs;
  const confirmed = selection.confirmed && !dirty && !stale;
  useEffect(() => {
    if (!confirmed) {
      setCandidates([]);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const result = await draftStudyApi.candidates({
          id: selection.id,
          version: selection.version,
        });
        if (!disposed) {
          setCandidates(result);
          setCandidateError('');
        }
      } catch (error) {
        if (!disposed)
          setCandidateError(
            String(error instanceof Error ? error.message : error),
          );
      }
      if (!disposed) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [confirmed, selection.id, selection.version]);
  function edit(action: () => void) {
    action();
    editRevision.current++;
    setAcknowledged(false);
    setListened(false);
  }
  async function operate<T>(
    action: () => Promise<T>,
    done?: (result: T) => void,
    allowStale = false,
  ) {
    if (locked.current || (stale && !allowStale)) return;
    locked.current = true;
    setBusy(true);
    const result = await report(action);
    if (!mounted.current) return;
    locked.current = false;
    setBusy(false);
    if (result !== undefined) done?.(result);
  }
  async function play() {
    if (!rangeValid || !playbackReady) return;
    const revision = editRevision.current;
    await operate(
      async () => {
        await onPlay({ startMs, endMs });
        return true;
      },
      () => {
        if (editRevision.current === revision) setListened(true);
      },
    );
  }
  function save(confirm: boolean) {
    if (
      !rangeValid ||
      (confirm &&
        (!valid || !acknowledged || !listened || !selection.canConfirm))
    )
      return;
    void operate(
      () =>
        draftStudyApi.update({
          id: selection.id,
          version: selection.version,
          text,
          startMs,
          endMs,
          confirm,
        }),
      onSaved,
    );
  }
  return (
    <section
      className="draft-study-editor"
      aria-label={t('選んだ表現を確認', 'Check selected phrase')}
    >
      <div className="scope-heading">
        <h3>{t('この表現を、自分の言葉に', 'Make this phrase yours')}</h3>
        <Badge tone={confirmed ? 'accent' : 'warning'}>
          {confirmed
            ? t('学習用に確認済み', 'Checked for learning')
            : t('確認前', 'Needs your check')}
        </Badge>
      </div>
      <p className="helper-text">
        {selection.origin === 'manual'
          ? t('手動で修正した本文', 'Manually corrected text')
          : selection.origin === 'mixed'
            ? t('AI・手動修正を含む本文', 'Text from AI and manual corrections')
            : t('AIから受信した本文', 'Text received from AI')}{' '}
        ·{' '}
        {selection.timing === 'source_block'
          ? t('時刻は取得元の音声範囲', 'Times locate the source block')
          : selection.timing === 'manual'
            ? t('利用者が指定した再生区間', 'User-selected replay interval')
            : t('時刻は字幕区間', 'Times locate subtitle intervals')}
      </p>
      <p className="helper-text">
        {t(
          '原音を再生し、本文と再生範囲を確認してください。保存したカードには、この時点の内容と音声が残ります。',
          'Play the audio and check the text and replay interval. A saved card keeps this version of the text and audio.',
        )}
      </p>
      <p className="helper-text">
        {t(
          'この確認は選んだ表現だけが対象です。元の下書きの競合や他の区間の状態は保持します。',
          'This check covers only your excerpt. Original draft conflicts and the status of other ranges are retained.',
        )}
      </p>
      {stale && (
        <p className="notice warning" role="status">
          {t(
            'この保存内容は別の操作で更新されました。上の一覧から選び直してください。',
            'This bookmark changed elsewhere. Select it again from the list above.',
          )}
        </p>
      )}
      {selection.blockingReasons.map((reason, index) => (
        <p className="notice warning" role="status" key={index}>
          {reason}
        </p>
      ))}
      <Field label={t('学ぶ本文', 'Text to learn')}>
        <textarea
          value={text}
          rows={4}
          maxLength={16000}
          disabled={busy || stale}
          onChange={(event) => edit(() => setText(event.target.value))}
        />
      </Field>
      {new TextEncoder().encode(text).length > 16000 && (
        <p className="field-error">
          {t(
            '本文が長すぎます。学びたい部分に絞ってから確認してください。',
            'This text is too long. Narrow it to the passage you want to study before confirming.',
          )}
        </p>
      )}
      <div className="field-row">
        <Field label={t('再生開始', 'Replay from')}>
          <input
            value={start}
            disabled={busy || stale}
            onChange={(event) => edit(() => setStart(event.target.value))}
          />
        </Field>
        <Field label={t('再生終了', 'Replay to')}>
          <input
            value={end}
            disabled={busy || stale}
            onChange={(event) => edit(() => setEnd(event.target.value))}
          />
        </Field>
      </div>
      <p className="helper-text">
        {t('取得元の範囲', 'Source bounds')}:{' '}
        {timestamp(selection.sourceStartMs, true)}–
        {timestamp(selection.sourceEndMs, true)}
      </p>
      {!rangeValid && (
        <p className="field-error">
          {t(
            '取得元の範囲内で、開始より後の終了時刻を指定してください。',
            'Choose a positive-width replay interval within the source bounds.',
          )}
        </p>
      )}
      <Button
        disabled={busy || stale || !rangeValid || !playbackReady}
        onClick={() => void play()}
      >
        <Play size={14} />
        {t('この本文の原音を再生', 'Play audio for this text')}
      </Button>
      <label className="check-field">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={busy || stale || !valid || !listened}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>
          {t(
            '原音を聴き、この本文と再生範囲を学習に使うことを確認しました',
            'I listened and checked this text and replay interval for learning',
          )}
        </span>
      </label>
      {!listened && (
        <p className="helper-text">
          {t(
            '再生して確認すると、カード保存やAI解説へ進めます。',
            'Play and check this version before saving a card or requesting AI help.',
          )}
        </p>
      )}
      <div className="inline-actions">
        <Button
          disabled={busy || stale || !rangeValid}
          onClick={() => save(false)}
        >
          <BookmarkPlus size={14} />
          {t('未確認で保存・あとで続ける', 'Save unchecked for later')}
        </Button>
        <Button
          variant="primary"
          disabled={
            busy ||
            stale ||
            !valid ||
            !acknowledged ||
            !listened ||
            confirmed ||
            !selection.canConfirm
          }
          onClick={() => save(true)}
        >
          <Check size={14} />
          {t('この本文と音声を確認済みにする', 'Confirm this text and audio')}
        </Button>
      </div>
      <div className="inline-actions">
        <Button
          disabled={busy || !confirmed}
          onClick={() => {
            setCandidate(undefined);
            setDialog('card');
          }}
        >
          <BookmarkPlus size={14} />
          {t('音声付きカードを作る', 'Create an audio card')}
        </Button>
        <Button disabled={busy || !confirmed} onClick={() => setDialog('ai')}>
          <Sparkles size={14} />
          {t('この表現をAIに相談', 'AI help for this phrase')}
        </Button>
      </div>
      {confirmed && (
        <section
          className="draft-study-suggestions"
          aria-label={t('この本文へのAI候補', 'AI suggestions for this text')}
        >
          {candidateError && (
            <p className="notice warning" role="status">
              {t(
                '保存済みのAI候補を読み込めませんでした。',
                'Could not load saved AI suggestions.',
              )}{' '}
              {candidateError}
            </p>
          )}
          {candidates.length ? (
            <>
              <h4>
                {t('受信した候補を確認する', 'Review received suggestions')}
              </h4>
              <p className="helper-text">
                {t(
                  'この確認済み本文に対する候補です。内容を確認してから保存してください。',
                  'These suggestions belong to this checked text. Review their contents before saving.',
                )}
              </p>
              {candidates.map((item) => (
                <article key={item.id}>
                  <strong>{item.term}</strong>
                  <p>{item.meaning}</p>
                  {item.explanation && <p>{item.explanation}</p>}
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setCandidate(item);
                      setDialog('card');
                    }}
                  >
                    {t(
                      'この候補を確認して保存',
                      'Review and save this suggestion',
                    )}
                  </Button>
                </article>
              ))}
            </>
          ) : (
            <p className="helper-text">
              {t(
                'AI処理を実行すると、この本文に対する候補をここで確認できます。',
                'After an AI job finishes, its suggestions for this text appear here.',
              )}
            </p>
          )}
        </section>
      )}
      <AnimatedDetails>
        <summary>
          {t('この下書きの書き出し・削除', 'Export or remove this draft')}
        </summary>
        {exporting && <ProgressStatus label={selection.text} phase="exporting" />}
        <p className="helper-text">
          {t(
            '未確認の下書きは状態付きJSONとして書き出せます。SRT・VTTは本文と区間を確認してから使えます。',
            'Unchecked drafts can be exported as JSON with their status. SRT and VTT require confirmed text and intervals.',
          )}
        </p>
        <div className="inline-actions">
          <select
            aria-label={t('下書きの形式', 'Draft export format')}
            value={format}
            disabled={busy || dirty}
            onChange={(event) => setFormat(event.target.value as typeof format)}
          >
            <option value="json">JSON</option>
            <option value="srt" disabled={!confirmed}>
              SRT
            </option>
            <option value="vtt" disabled={!confirmed}>
              VTT
            </option>
          </select>
          <Button
            disabled={busy || dirty || (format !== 'json' && !confirmed)}
            onClick={() =>
              void operate(
                async () => {
                  setExporting(true);
                  try {
                    return await runTracked({ kind: 'export', label: selection.text, mediaId: selection.mediaId, phase: 'exporting' },
                      () => draftStudyApi.export({ id: selection.id, version: selection.version, format }),
                      { classifyResult: result => ({ status: result ? 'completed' : 'cancelled' }) });
                  } finally { if (mounted.current) setExporting(false); }
                },
                undefined,
                format === 'json',
              )
            }
          >
            <Download size={14} />
            {t('この下書きを書き出す', 'Export this draft')}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void operate(
                async () => {
                  await draftStudyApi.remove({
                    id: selection.id,
                    version: selection.version,
                  });
                  return true;
                },
                onRemoved,
                true,
              )
            }
          >
            <Trash2 size={14} />
            {t('あとで確認する一覧から外す', 'Remove from kept drafts')}
          </Button>
        </div>
      </AnimatedDetails>
      <Button variant="ghost" disabled={busy} onClick={onClose}>
        {t('閉じて視聴を続ける', 'Close and keep watching')}
      </Button>
      {dialog === 'card' && confirmed && (
        <DraftCardDialog
          selection={selection}
          candidate={candidate}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog === 'ai' && confirmed && (
        <DraftAiDialog
          selection={selection}
          onClose={() => setDialog(undefined)}
        />
      )}
    </section>
  );
}
