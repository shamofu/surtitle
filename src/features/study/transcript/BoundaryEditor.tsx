// SPDX-License-Identifier: GPL-3.0-or-later
import { Alternatives } from './Preview';
import { useState } from 'react';
import { Play, Scissors } from 'lucide-react';

import type { BoundaryChoice } from '../../../shared/contracts/transcript';
import type { ReviewConflict } from '../../../shared/contracts/transcript';
import type { ReviewText } from '../../../shared/contracts/transcript';
import type { TranscriptReview } from '../../../shared/contracts/transcript';
import { useAppearance } from '../../../app/runtime';
import { timestamp } from '../../../shared/format';
import { Badge, Button } from '../../../shared/ui/index';

import {
  type EditRow,
  SubtitleRows,
  toEditRows,
  validatedRows,
} from './SubtitleRows';

export function BoundaryEditor({
  conflict,
  disabled,
  onResolve,
  onRepair,
  play,
  repairs,
}: {
  conflict: ReviewConflict;
  disabled: boolean;
  onResolve: (choice: BoundaryChoice) => void;
  onRepair: () => void;
  play: (cue: ReviewText) => void;
  repairs: TranscriptReview['repairAlternatives'];
}) {
  const { t } = useAppearance();
  const [manual, setManual] = useState<EditRow[]>();
  const [confirmedSilence, setConfirmedSilence] = useState(false);
  const rows =
    manual &&
    validatedRows(manual, conflict.startMs, conflict.endMs, confirmedSilence);
  const edit = (segments: ReviewText[]) => {
    setManual(toEditRows(segments));
    setConfirmedSilence(false);
  };
  return (
    <section className="boundary-editor">
      <div className="scope-heading">
        <h3>
          {t('境界を原音で確認', 'Listen at the boundary')} ·{' '}
          {timestamp(conflict.atMs, true)}
        </h3>
        {conflict.resolution && (
          <Badge tone="accent">{t('確認済み', 'Resolved')}</Badge>
        )}
      </div>
      <Button
        onClick={() =>
          play({ startMs: conflict.startMs, endMs: conflict.endMs, text: '' })
        }
      >
        <Play size={14} />
        {t('境界の音声を再生', 'Play boundary audio')}
      </Button>
      <div className="boundary-alternatives">
        <Alternatives
          title={t('前の音声区間の結果', 'Earlier chunk result')}
          segments={conflict.leftAlternative}
          play={play}
        />
        <Alternatives
          title={t('次の音声区間の結果', 'Later chunk result')}
          segments={conflict.rightAlternative}
          play={play}
        />
      </div>
      <div className="boundary-actions">
        <Button disabled={disabled} onClick={() => onResolve({ kind: 'left' })}>
          {t('前の結果を採用', 'Use earlier result')}
        </Button>
        <Button
          disabled={disabled}
          onClick={() => onResolve({ kind: 'right' })}
        >
          {t('次の結果を採用', 'Use later result')}
        </Button>
        <Button
          disabled={disabled}
          onClick={() => onResolve({ kind: 'keep_both' })}
        >
          {t('両方を残す', 'Keep both')}
        </Button>
        <Button
          disabled={disabled}
          onClick={() =>
            edit(
              conflict.resolution?.kind === 'manual'
                ? conflict.resolution.segments
                : conflict.leftAlternative,
            )
          }
        >
          {t('手動で整える', 'Edit manually')}
        </Button>
      </div>
      {manual && (
        <div className="boundary-manual">
          <p className="helper-text">
            {t(
              '原音を聴き、必要な文と時刻を入力してください。行をすべて削除しても、確認するまで発話なしにはなりません。',
              'Listen and enter the wording and times. Removing every row does not confirm the absence of speech.',
            )}
          </p>
          <SubtitleRows
            rows={manual}
            onChange={(value) => {
              setManual(value);
              setConfirmedSilence(false);
            }}
            disabled={disabled}
            startMs={conflict.startMs}
            endMs={conflict.endMs}
          />
          {!manual.length && (
            <label className="check-field">
              <input
                type="checkbox"
                checked={confirmedSilence}
                disabled={disabled}
                onChange={(event) => setConfirmedSilence(event.target.checked)}
              />
              <span>
                {t(
                  'この境界の原音を聴き、発話がないことを確認した',
                  'I listened to this boundary and confirmed there is no speech',
                )}
              </span>
            </label>
          )}
          <div className="boundary-actions">
            <Button
              disabled={disabled || !rows}
              onClick={() => {
                if (rows) onResolve({ kind: 'manual', segments: rows });
              }}
            >
              {t('編集内容で確定', 'Confirm edited boundary')}
            </Button>
          </div>
          {!rows && (
            <p className="field-error">
              {t(
                '表示された境界内の有効な時刻と本文を入力してください。',
                'Enter valid times and text inside the displayed boundary.',
              )}
            </p>
          )}
        </div>
      )}
      {repairs.map((repair) => (
        <div key={repair.jobId} className="repair-result">
          {repair.draft.pendingRanges.length ? (
            <p className="notice" role="status">
              {t(
                '修復結果は未受信です。準備や見積もりだけでは送信しません。',
                'The repair result has not been received. Preparation and estimates do not send a request.',
              )}
            </p>
          ) : (
            <>
              <Alternatives
                title={t('追加処理で受信した結果', 'Received repair result')}
                segments={repair.draft.segments}
                play={play}
              />
              <Button
                disabled={disabled || !repair.draft.canAdopt}
                onClick={() => edit(repair.draft.segments)}
              >
                {t(
                  '修復結果を手動編集へコピー',
                  'Copy repair into manual editor',
                )}
              </Button>
              <p className="helper-text">
                {t(
                  'コピーした結果の時刻と本文を確認し、境界内へ整えてから確定します。',
                  'Review the copied text and times, and keep the edited result inside this boundary before confirming.',
                )}
              </p>
            </>
          )}
        </div>
      ))}
      <div className="repair-estimate">
        <Button disabled={disabled} onClick={onRepair}>
          <Scissors size={14} />
          {t('30秒以内の修復を見積もる', 'Estimate repair, up to 30 seconds')}
        </Button>
        <small>
          {t(
            '音声準備と見積もりだけです。追加送信は別の承認が必要です。',
            'Prepares audio and a quote only. Another approval is required to send it.',
          )}
        </small>
      </div>
    </section>
  );
}
