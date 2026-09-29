// SPDX-License-Identifier: GPL-3.0-or-later
import { Alternatives } from './Preview';
import { useState } from 'react';

import { studyApi } from '../api';

import type { ReviewText } from '../../../shared/contracts/transcript';
import type { TranscriptDraft } from '../../../shared/contracts/transcript';
import type { TranscriptReview } from '../../../shared/contracts/transcript';
import type { TranscriptResultReview } from '../../../shared/contracts/transcript';
import type { TranscriptResultReason } from '../../../shared/contracts/transcript';
import {
  useDataActions,
  useAppearance,
  useNotifications,
} from '../../../app/runtime';

import { Badge, Button } from '../../../shared/ui/index';

export function ResultEvidence({
  result,
  disabled,
  applied,
  draftDigest,
  jobId,
  update,
  play,
}: {
  result: TranscriptResultReview;
  disabled: boolean;
  applied: boolean;
  draftDigest: string;
  jobId: string;
  update: (operation: () => Promise<TranscriptReview>) => Promise<void>;
  play: (cue: ReviewText) => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const [detail, setDetail] = useState<TranscriptResultReview>();
  const [loading, setLoading] = useState(false);
  const labels = {
    pending: t('未受信', 'Not received'),
    invalid: t('受信済み・無効', 'Received, invalid'),
    empty: t('有効な空結果', 'Valid empty result'),
    received: t('有効な字幕', 'Valid subtitles'),
  };
  const reasons: Record<TranscriptResultReason, string> = {
    not_received: t('応答はまだ届いていません。', 'No response has arrived.'),
    evidence_unavailable: t(
      '保存された応答の詳細がありません。送信結果を確認してください。',
      'Saved response details are unavailable. Check the request outcome.',
    ),
    evidence_incomplete: t(
      '応答の保存上限を超えたか、再解析に必要な情報が不足しています。',
      'The response exceeded its storage limit or lacks information needed for reparsing.',
    ),
    candidate_missing: t(
      '応答に字幕候補がありません。',
      'The response contains no subtitle candidate.',
    ),
    candidate_count: t(
      '字幕候補の数が想定と異なります。',
      'The response has an unexpected number of candidates.',
    ),
    incomplete_response: t(
      '応答が中断・遮断されたか、完了していません。',
      'The response was interrupted, blocked, or incomplete.',
    ),
    content_missing: t(
      '字幕の本文がありません。',
      'The response contains no transcript content.',
    ),
    invalid_structure: t(
      '応答の形式を字幕として検証できません。',
      'The response structure could not be validated as subtitles.',
    ),
    invalid_word_timing: t(
      '単語または字幕の時刻が無効です。',
      'Word or subtitle times are invalid.',
    ),
    reversed_time: t(
      '終了時刻が開始時刻より前になっています。',
      'An end time precedes its start time.',
    ),
    time_outside_audio: t(
      '音声の範囲外の時刻があります。',
      'A timestamp is outside the audio range.',
    ),
    unaligned_words: t(
      '本文と単語時刻の対応が一致しません。',
      'Transcript text does not match its timed words.',
    ),
    usage_unknown: t(
      '使用量が不明なため予約を保持しています。',
      'Usage is unknown; the reservation is retained.',
    ),
    settlement_pending: t(
      '費用の結果が未確定です。予約を保持し、この応答の採用を停止しています。手動修正は別に保存できます。',
      'The cost outcome is unresolved. Its reservation is retained and this response cannot be selected. Manual corrections can be saved separately.',
    ),
  };
  async function load() {
    setLoading(true);
    const loaded = await report(() =>
      studyApi.transcriptResultDetail(jobId, result.ordinal),
    );
    if (loaded) setDetail(loaded);
    setLoading(false);
  }
  return (
    <section
      className="boundary-editor"
      aria-label={`${t('結果', 'Result')} ${result.ordinal + 1}`}
    >
      <div className="scope-heading">
        <strong>
          {t('区間', 'Range')} {result.ordinal + 1}
        </strong>
        <Badge
          tone={
            result.state === 'invalid' || result.state === 'pending'
              ? 'warning'
              : 'accent'
          }
        >
          {labels[result.state]}
        </Badge>
      </div>
      {result.reason && <p className="helper-text">{reasons[result.reason]}</p>}
      {result.evidence && (
        <>
          <p className="helper-text">
            {t(
              '元の応答と費用の記録を保持しています。再解析は保存済みの応答だけを使うローカル処理です。',
              'The original response and cost record are preserved. Reparsing uses only the saved response locally.',
            )}
          </p>
          <div className="inline-actions">
            <Button disabled={disabled || loading} onClick={() => void load()}>
              {t(
                '保存応答と派生候補を表示',
                'Show saved response and derived candidates',
              )}
            </Button>
            <Button
              disabled={
                disabled ||
                loading ||
                !result.evidence.complete ||
                !result.evidenceSha256
              }
              onClick={() => {
                setDetail(undefined);
                void update(() =>
                  mutate(
                    () =>
                      studyApi.reparseTranscriptEvidence(
                        jobId,
                        result.ordinal,
                        result.evidenceSha256!,
                      ),
                    { kind: 'review', jobId: jobId },
                  ),
                );
              }}
            >
              {t(
                '保存応答をローカルで再解析',
                'Reparse saved response locally',
              )}
            </Button>
          </div>
        </>
      )}
      {!!result.reparses.length && !detail && (
        <p className="helper-text">
          {t(
            `派生候補が${result.reparses.length}件あります。表示して内容を確認してください。`,
            `${result.reparses.length} derived candidates are saved. Open them to review their contents.`,
          )}
        </p>
      )}
      {detail && (
        <>
          <details>
            <summary>{t('元の保存応答', 'Original saved response')}</summary>
            <pre>
              {JSON.stringify(detail.evidence?.response ?? null, null, 2)}
            </pre>
          </details>
          {detail.reparses.map((candidate) => (
            <section key={candidate.id}>
              <h4>
                {t('ローカル再解析の候補', 'Local reparse candidate')} ·{' '}
                {labels[candidate.state]}
              </h4>
              {candidate.reason && (
                <p className="helper-text">{reasons[candidate.reason]}</p>
              )}
              {candidate.output?.kind === 'transcript' && (
                <Alternatives
                  title={t('派生した字幕', 'Derived subtitles')}
                  segments={candidate.output.cues}
                  play={play}
                  disabled={disabled || loading}
                />
              )}
              <Button
                disabled={
                  disabled ||
                  loading ||
                  applied ||
                  candidate.selected ||
                  !candidate.output ||
                  result.state === 'received' ||
                  result.state === 'empty' ||
                  ['reserved', 'unknown'].includes(result.attemptState || '')
                }
                onClick={() =>
                  void update(() =>
                    mutate(
                      () =>
                        studyApi.selectTranscriptReparse(
                          jobId,
                          result.ordinal,
                          candidate.id,
                          draftDigest,
                        ),
                      { kind: 'review', jobId: jobId },
                    ),
                  )
                }
              >
                {candidate.selected
                  ? t('プレビューに選択済み', 'Selected for preview')
                  : t(
                      'この候補をプレビューへ選択',
                      'Select this candidate for preview',
                    )}
              </Button>
            </section>
          ))}
          <p className="helper-text">
            {t(
              '候補の選択だけでは字幕を置き換えません。プレビューを確認し、最後に採用してください。',
              'Selecting a candidate does not replace subtitles. Review the preview and adopt it separately.',
            )}
          </p>
        </>
      )}
    </section>
  );
}

export function JoinedSubtitles({
  draft,
  disabled,
  play,
}: {
  draft: TranscriptDraft;
  disabled: boolean;
  play: (cue: ReviewText) => void;
}) {
  const { t } = useAppearance();
  const joins = draft.edgeGroupJoins || [];
  if (!joins.length) return null;
  function originalGroup(
    ordinal: number,
    indices: number[],
  ): ReviewText[] | undefined {
    const chunk = draft.chunks.find((item) => item.ordinal === ordinal);
    if (
      !chunk ||
      !indices.length ||
      indices.some(
        (index) =>
          !Number.isInteger(index) || index < 0 || !chunk.segments[index],
      )
    )
      return undefined;
    return indices.map((index) => chunk.segments[index]);
  }
  const missing = t(
    '元の字幕を表示できません。保存結果を再読み込みしてください。',
    'The original subtitles could not be displayed. Refresh the saved results.',
  );
  return (
    <details className="draft-chunks">
      <summary>
        {t(
          `自動でつないだ字幕を確認（${joins.length} 件）`,
          `Review automatically joined subtitles (${joins.length})`,
        )}
      </summary>
      <p className="helper-text">
        {t(
          '重なった部分の内容が一致したため、字幕をつなぎました。元の字幕は両方とも保持しています。音声を聴いて比べられます。字幕の採用は別の操作です。',
          'Matching text in overlapping audio was joined. Both original subtitle groups are kept. Listen and compare them; adopting subtitles is a separate action.',
        )}
      </p>
      <p className="helper-text">
        {t('表示する時刻は字幕の区間です。', 'Times refer to subtitle ranges.')}
      </p>
      {joins.map((join) => {
        const earlier = originalGroup(
          join.leftOrdinal,
          join.leftSegmentIndices,
        );
        const later = originalGroup(
          join.rightOrdinal,
          join.rightSegmentIndices,
        );
        const earlierManual =
          draft.chunks.find((chunk) => chunk.ordinal === join.leftOrdinal)
            ?.source === 'manual';
        const laterManual =
          draft.chunks.find((chunk) => chunk.ordinal === join.rightOrdinal)
            ?.source === 'manual';
        return (
          <section className="boundary-editor" key={join.id}>
            <Alternatives
              title={t('つないだ字幕', 'Joined subtitle')}
              segments={[join.joined]}
              disabled={disabled}
              play={play}
            />
            <div className="boundary-alternatives">
              {earlier ? (
                <Alternatives
                  title={
                    earlierManual
                      ? t(
                          '前の区間で選択した手動字幕',
                          'Selected manual subtitles from the earlier audio',
                        )
                      : t(
                          '前の区間の元字幕',
                          'Original subtitles from the earlier audio',
                        )
                  }
                  segments={earlier}
                  disabled={disabled}
                  play={play}
                />
              ) : (
                <p className="notice warning">{missing}</p>
              )}
              {later ? (
                <Alternatives
                  title={
                    laterManual
                      ? t(
                          '次の区間で選択した手動字幕',
                          'Selected manual subtitles from the later audio',
                        )
                      : t(
                          '次の区間の元字幕',
                          'Original subtitles from the later audio',
                        )
                  }
                  segments={later}
                  disabled={disabled}
                  play={play}
                />
              ) : (
                <p className="notice warning">{missing}</p>
              )}
            </div>
          </section>
        );
      })}
    </details>
  );
}
