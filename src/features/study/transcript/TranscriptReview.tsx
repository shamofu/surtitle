// SPDX-License-Identifier: GPL-3.0-or-later
import { BoundaryEditor } from './BoundaryEditor';
import { ResultEvidence, JoinedSubtitles } from './Evidence';
import { DraftCues, Alternatives } from './Preview';
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';

import { Check, Pause, Play, RotateCw } from 'lucide-react';
import { studyApi } from '../api';
import { playerApi } from '../playback/api';
import { aiApi } from '../../ai/api';
import type { AiQuote } from '../../../shared/contracts/ai';

import type { ReviewText } from '../../../shared/contracts/transcript';

import type { TranscriptReview } from '../../../shared/contracts/transcript';

import {
  useDataActions,
  useAppearance,
  useNotifications,
} from '../../../app/runtime';
import { timestamp } from '../../../shared/format';
import { MotionSwap } from '../../../shared/motion';
import { Badge, Button, Field, Modal, useModalExit } from '../../../shared/ui/index';
import { AnimatedDetails } from '../../../shared/ui/AnimatedDetails';
import { QuoteApproval } from '../../ai/QuoteApproval';

import { TranscriptRangeEditor } from './TranscriptRangeEditor';

export function TranscriptReviewDialog({
  jobId,
  onClose,
}: {
  jobId: string;
  onClose: () => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const [view, setView] = useState<TranscriptReview>();
  const [busy, setBusy] = useState(false);
  const [boundaryId, setBoundaryId] = useState('');
  const [rangeOrdinal, setRangeOrdinal] = useState<number>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [repairQuote, setRepairQuote] = useState<AiQuote>();
  const exit = useModalExit();
  const repairExit = useModalExit(!!repairQuote);
  const close = () => { if (!busy) void exit.close(onClose); };
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void report(() => studyApi.transcriptReview(jobId)).then((result) => {
      if (active) {
        if (result) setView(result);
        setLoadFailed(!result);
      }
    });
    return () => {
      active = false;
    };
  }, [jobId, report]);
  async function update(operation: () => Promise<TranscriptReview>) {
    if (busy || exit.exiting || repairExit.exiting) return;
    setBusy(true);
    const result = await report(operation);
    if (result) {
      setView(result);
      setAcknowledged(false);
      setLoadFailed(false);
    }
    setBusy(false);
  }
  async function play(cue: ReviewText) {
    if (!view || busy || exit.exiting || repairExit.exiting) return;
    setBusy(true);
    await report(async () => {
      await playerApi.loadMedia(view.mediaId);
      // FILE_LOADED restores the saved position. Seeking before readiness can
      // fail or be overwritten by that restore, including for VAD warning audio.
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const state = await playerApi.playerState();
        if (state.error) throw new Error(state.error);
        if (state.ready === true) {
          await playerApi.player({
            action: 'seek',
            startMs: cue.startMs,
            endMs: cue.endMs,
          });
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      throw new Error(
        t(
          'プレイヤーの準備が完了しませんでした。もう一度お試しください。',
          'The player did not become ready. Try again.',
        ),
      );
    });
    setBusy(false);
  }
  async function repair(id: string) {
    if (!view || busy || exit.exiting || repairExit.exiting) return;
    setBusy(true);
    const result = await report(() =>
      mutate(() => aiApi.prepareBoundaryRepair(jobId, view.draft.digest, id), {
        kind: 'snapshot',
      }),
    );
    if (result) setRepairQuote(result);
    setBusy(false);
  }
  const draft = view?.draft;
  const conflict =
    draft?.conflicts.find((item) => item.id === boundaryId) ||
    draft?.conflicts[0];
  const rangeEdit = view?.rangeEdits?.find(
    (item) => item.ordinal === rangeOrdinal,
  );
  const selectedChunk = draft?.chunks.find(
    (item) => item.ordinal === rangeOrdinal,
  );
  return (
    <Modal
      {...exit.modalProps}
      title={t('文字起こしを確認', 'Review transcription')}
      closeDisabled={busy || exit.exiting || repairExit.exiting}
      eyebrow="LISTEN, REVIEW, THEN KEEP"
      wide
      onClose={close}
    >
      <MotionSwap stateKey={!view || !draft ? loadFailed ? 'error' : 'loading' : 'ready'}>{!view || !draft ? (
        loadFailed ? (
          <div>
            <p className="notice warning" role="status">
              {t(
                '保存結果を読み込めませんでした。表示されたエラーを確認してください。',
                'Saved results could not be loaded. Check the reported error.',
              )}
            </p>
            <Button
              busy={busy}
              onClick={() =>
                void update(() => studyApi.transcriptReview(jobId))
              }
            >
              {t('再読込', 'Reload')}
            </Button>
          </div>
        ) : (
          <p role="status">
            {t('保存した結果を読み込み中…', 'Loading saved results…')}
          </p>
        )
      ) : (
        <>
          <p className="notice">
            {t(
              'この確認・編集・採用はローカル処理です。元の受信結果を保持し、カードに保存した内容は変更しません。',
              'Review, editing and adoption are local operations. Original responses and saved cards are preserved.',
            )}
          </p>
          <div className="scope-heading">
            <span>
              {timestamp(draft.startMs, true)} – {timestamp(draft.endMs, true)}{' '}
              · {draft.segments.length} {t('字幕', 'subtitles')}
            </span>
            <Button
              disabled={busy}
              onClick={() =>
                void update(() => studyApi.transcriptReview(jobId))
              }
            >
              <RotateCw size={14} />
              {t('保存結果を再読込', 'Refresh saved results')}
            </Button>
          </div>
          {!!draft.pendingRanges.length && (
            <p className="notice warning" role="status">
              {t(
                `${draft.pendingRanges.length} 区間に有効な字幕がありません。保存応答を確認するか、原音を聴いて区間を修正してください。未確定のまま採用はできません。`,
                `${draft.pendingRanges.length} ranges have no validated subtitles. Inspect saved responses or listen and correct each range. Unresolved ranges prevent adoption.`,
              )}
            </p>
          )}
          {!!view.rangeEdits?.length && (
            <section>
              <Field label={t('修正する音声区間', 'Audio range to correct')}>
                <select
                  value={rangeOrdinal ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    setRangeOrdinal(
                      event.target.value === ''
                        ? undefined
                        : Number(event.target.value),
                    )
                  }
                >
                  <option value="">{t('区間を選択', 'Select a range')}</option>
                  {draft.chunks.map((chunk) => (
                    <option key={chunk.ordinal} value={chunk.ordinal}>
                      {chunk.ordinal + 1}. {timestamp(chunk.coreStartMs, true)}{' '}
                      – {timestamp(chunk.coreEndMs, true)} ·{' '}
                      {chunk.source === 'manual'
                        ? t('手動修正', 'Manual correction')
                        : chunk.status === 'pending'
                          ? t('要修正', 'Needs correction')
                          : t('字幕あり', 'Subtitles available')}
                    </option>
                  ))}
                </select>
              </Field>
              {!view.applied && view.manualEditingBlockedReason && (
                <div className="notice warning" role="status">
                  <p>
                    {t(
                      '送信を一時停止し、実行中の要求の終了を待ってから編集してください。費用不明の予約は保持します。',
                      'Pause sending and wait for the in-flight request to finish before editing. Unknown cost reservations are retained.',
                    )}
                  </p>
                  <Button
                    disabled={busy || view.applied}
                    onClick={() =>
                      void update(async () => {
                        await mutate(() => aiApi.pauseAiJob(jobId), {
                          kind: 'snapshot',
                        });
                        return studyApi.transcriptReview(jobId);
                      })
                    }
                  >
                    <Pause size={14} />
                    {t('送信を一時停止して確認', 'Pause sending and check')}
                  </Button>
                </div>
              )}
              {rangeEdit && selectedChunk && (
                <TranscriptRangeEditor
                  key={`${selectedChunk.ordinal}:${rangeEdit.version}`}
                  jobId={jobId}
                  digest={draft.digest}
                  chunk={selectedChunk}
                  edit={rangeEdit}
                  result={view.results?.find(
                    (result) => result.ordinal === selectedChunk.ordinal,
                  )}
                  disabled={
                    busy || view.applied || !!view.manualEditingBlockedReason
                  }
                  update={update}
                  play={(cue) => void play(cue)}
                />
              )}
            </section>
          )}
          {!!view.results?.length && (
            <AnimatedDetails className="draft-chunks">
              <summary>
                {t('保存応答の検証状態', 'Saved response validation status')}
              </summary>
              {view.results.map((result) => (
                <ResultEvidence
                  key={`${result.ordinal}:${result.evidenceSha256}:${result.reparses.length}:${result.reparses.map((candidate) => candidate.selected).join(',')}`}
                  result={result}
                  disabled={busy}
                  applied={view.applied}
                  draftDigest={draft.digest}
                  jobId={jobId}
                  update={update}
                  play={(cue) => void play(cue)}
                />
              ))}
            </AnimatedDetails>
          )}
          {draft.warnings?.map((warning) => (
            <section className="notice warning" key={warning.id}>
              <p>
                {draft.chunks.find((chunk) => chunk.ordinal === warning.ordinal)
                  ?.source === 'manual'
                  ? t(
                      'VADが発話を検出しなかった範囲に、手動字幕があります。原音と入力した字幕を確認してください。',
                      'Manual subtitles contain speech where VAD detected none. Review the original audio and the entered subtitles.',
                    )
                  : warning.kind === 'speech_in_vad_pause_range'
                    ? t(
                        'VADが休止と推定した区間内に、AIが発話の字幕を生成しました。VADの見落としやAIの誤生成の可能性があります。元の音声と字幕を確認してください。',
                        'AI returned speech inside a VAD-estimated pause. VAD may have missed speech, or AI may have invented it. Review the original audio and subtitles.',
                      )
                    : t(
                        '発話を検出しなかった区間に、AIが字幕を生成しました。VADの見落としやAIの誤生成の可能性があります。元の音声と字幕を確認してください。',
                        'AI generated subtitles in a range where no speech was detected. VAD may have missed speech, or AI may have invented it. Check the original audio and subtitles.',
                      )}
              </p>
              <p>
                {timestamp(warning.startMs, true)} –{' '}
                {timestamp(warning.endMs, true)}
              </p>
              {warning.kind === 'speech_in_vad_pause_range' && (
                <p className="helper-text">
                  {t(
                    '2秒以上続く低い発話確率を根拠とし、休止の前後250ミリ秒を除いています。無音であることを保証する判定ではありません。',
                    'This estimate uses at least two seconds of consistently low speech probability and excludes 250 ms at each pause edge. It is not proof of silence.',
                  )}
                </p>
              )}
              <div className="inline-actions">
                <Button
                  disabled={busy}
                  onClick={() => void play({ ...warning, text: '' })}
                >
                  <Play size={14} />
                  {t('この区間を聴く', 'Listen to this range')}
                </Button>
                <Button
                  disabled={busy || view.applied || warning.acknowledged}
                  onClick={() =>
                    void update(() =>
                      mutate(
                        () =>
                          studyApi.acknowledgeTranscriptWarning(
                            jobId,
                            draft.digest,
                            warning.id,
                          ),
                        { kind: 'review', jobId: jobId },
                      ),
                    )
                  }
                >
                  {warning.acknowledged
                    ? t('確認済み', 'Reviewed')
                    : t(
                        '原音と字幕を確認した',
                        'I checked the audio and subtitles',
                      )}
                </Button>
              </div>
              <p className="helper-text">
                {t(
                  '確認しても元の応答は削除しません。字幕の採用は別の操作です。',
                  'Reviewing keeps the original response. Adopting subtitles is a separate action.',
                )}
              </p>
            </section>
          ))}
          <AnimatedDetails className="draft-chunks">
            <summary>
              {t(
                '元の音声区間とプレビューの状態',
                'Original audio ranges and preview status',
              )}
            </summary>
            {draft.chunks.map((chunk) => (
              <div key={chunk.ordinal}>
                <span>
                  {chunk.ordinal + 1}. {timestamp(chunk.coreStartMs, true)} –{' '}
                  {timestamp(chunk.coreEndMs, true)}
                </span>
                <Badge tone={chunk.status === 'pending' ? 'warning' : 'accent'}>
                  {chunk.status === 'pending'
                    ? t('有効な字幕なし', 'No validated subtitles')
                    : t('プレビューあり', 'Preview available')}
                </Badge>
                {chunk.status === 'received' && (
                  <AnimatedDetails>
                    <summary>
                      {t('区間の字幕を表示', 'Show subtitles for this range')}
                    </summary>
                    <Alternatives
                      title={t(
                        'この区間のプレビュー',
                        'Preview for this range',
                      )}
                      segments={chunk.segments}
                      play={(cue) => void play(cue)}
                    />
                  </AnimatedDetails>
                )}
              </div>
            ))}
          </AnimatedDetails>
          <JoinedSubtitles
            draft={draft}
            disabled={busy}
            play={(cue) => void play(cue)}
          />
          {!!draft.conflicts.length && (
            <>
              <Field label={t('確認する境界', 'Boundary to review')}>
                <select
                  value={conflict?.id}
                  disabled={busy}
                  onChange={(event) => setBoundaryId(event.target.value)}
                >
                  {draft.conflicts.map((item) => (
                    <option key={item.id} value={item.id}>
                      {timestamp(item.atMs, true)} ·{' '}
                      {item.resolution
                        ? t('確認済み', 'Resolved')
                        : t('要確認', 'Needs review')}
                    </option>
                  ))}
                </select>
              </Field>
              {conflict && (
                <BoundaryEditor
                  key={`${conflict.id}:${draft.digest}`}
                  conflict={conflict}
                  disabled={busy || view.applied}
                  onResolve={(choice) =>
                    void update(() =>
                      mutate(
                        () =>
                          studyApi.resolveTranscriptBoundary(
                            jobId,
                            draft.digest,
                            conflict.id,
                            choice,
                          ),
                        { kind: 'review', jobId: jobId },
                      ),
                    )
                  }
                  onRepair={() => void repair(conflict.id)}
                  play={(cue) => void play(cue)}
                  repairs={view.repairAlternatives.filter(
                    (item) => item.boundaryId === conflict.id,
                  )}
                />
              )}
            </>
          )}
          <h3>
            {t('採用する字幕のプレビュー', 'Preview of subtitles to adopt')}
          </h3>
          {draft.segments.length ? (
            <DraftCues cues={draft.segments} play={(cue) => void play(cue)} />
          ) : (
            <p className="helper-text">
              {draft.pendingRanges.length
                ? t(
                    '字幕の受信を待っています。',
                    'Waiting for subtitle results.',
                  )
                : t(
                    '現時点の字幕は空です。無音であることを原音で確認してください。',
                    'There are no subtitle cues. Confirm that the original audio is silent.',
                  )}
            </p>
          )}
          {view.blockedReason && (
            <p className="notice warning" role="status">
              {view.blockedReason}
            </p>
          )}
          {!view.applied && (
            <label className="check-field">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={!view.canApply || busy}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                {t(
                  '原音と境界を確認しました。この範囲の字幕をプレビューの内容で置き換えます。',
                  'I reviewed the audio and boundaries. Replace subtitles in this range with the preview.',
                )}
              </span>
            </label>
          )}
          <footer className="modal-footer">
            <Button disabled={busy} onClick={close}>
              {t('閉じる', 'Close')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || view.applied || !view.canApply || !acknowledged}
              onClick={() =>
                void update(() =>
                  mutate(
                    () => studyApi.applyTranscriptReview(jobId, draft.digest),
                    { kind: 'subtitles', mediaId: view.mediaId },
                  ),
                )
              }
            >
              <Check size={15} />
              {view.applied
                ? t('採用済み', 'Adopted')
                : t('この字幕を採用', 'Adopt these subtitles')}
            </Button>
          </footer>
        </>
      )}
      </MotionSwap>
      {repairQuote && (
        <Modal
          {...repairExit.modalProps}
          title={t('境界修復の見積もり', 'Boundary repair estimate')}
          closeDisabled={busy || repairExit.exiting}
          onClose={() => {
            if (!busy) void repairExit.close(() => setRepairQuote(undefined));
          }}
        >
          <QuoteApproval
            key={repairQuote.id}
            quote={repairQuote}
            busy={busy}
            onApprove={() => {
              if (busy || repairExit.exiting) return;
              setBusy(true);
              void report(async () => {
                await mutate(() => aiApi.approveQuote(repairQuote), {
                  kind: 'snapshot',
                });
                return studyApi.transcriptReview(jobId);
              }).then((result) => {
                if (result) {
                  setView(result);
                  void repairExit.close(() => setRepairQuote(undefined));
                  setAcknowledged(false);
                }
                setBusy(false);
              });
            }}
          />
        </Modal>
      )}
    </Modal>
  );
}
