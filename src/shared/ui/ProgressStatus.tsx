// SPDX-License-Identifier: GPL-3.0-or-later
import { useAppearance } from '../../app/runtime';
import type { ActivityStatus, ProgressUnit } from '../contracts/activity';
import './progress.css';

const phases: Record<string, [string, string]> = {
  preparing: ['準備中', 'Preparing'], setup: ['準備中', 'Preparing'], preparing_tools: ['メディアツールを準備中', 'Preparing media tools'],
  checking_files: ['ファイルを確認中', 'Checking files'], importing: ['ライブラリへ登録中', 'Adding to library'],
  inspecting: ['動画情報を確認中', 'Inspecting media'], connecting: ['接続中', 'Connecting'],
  downloading: ['ダウンロード中', 'Downloading'], downloading_archive: ['ダウンロード中', 'Downloading'],
  verifying: ['検証中', 'Verifying'], extracting: ['展開中', 'Extracting'], installing: ['インストール中', 'Installing'],
  activating: ['利用できるように準備中', 'Activating'], checking: ['確認中', 'Checking'],
  waiting: ['他の処理の完了を待機中', 'Waiting for another operation'], awaiting_approval: ['承認待ち', 'Awaiting approval'], queued: ['承認待ち', 'Awaiting approval'],
  completed: ['完了', 'Completed'], failed: ['失敗', 'Failed'], cancelled: ['中止しました', 'Cancelled'],
  interrupted: ['中断しました', 'Interrupted'], paused: ['一時停止中', 'Paused'], unknown: ['結果の確認が必要です', 'Outcome needs review'],
  exporting: ['書き出し中', 'Exporting'], reading_backup: ['バックアップを確認中', 'Reading backup'],
  restoring: ['復元中', 'Restoring'], extracting_subtitles: ['字幕を抽出中', 'Extracting subtitles'],
  saving_audio: ['音声を保存中', 'Saving audio'], checking_updates: ['更新を確認中', 'Checking for updates'],
  discovering_models: ['モデルを取得中', 'Fetching models'], checking_tools: ['ツールを確認中', 'Checking tools'],
  starting: ['処理を開始中', 'Starting'], estimating: ['見積もりを準備中', 'Preparing estimate'],
  decoding: ['音声を読み込み中', 'Decoding audio'], extracting_audio: ['音声を抽出中', 'Extracting audio'],
  analysing: ['音声を解析中', 'Analysing audio'], analyzing: ['音声を解析中', 'Analysing audio'],
  detecting_speech: ['発話区間を検出中', 'Detecting speech'], vad: ['発話区間を検出中', 'Detecting speech'],
  planning: ['音声の分割を準備中', 'Planning audio chunks'], encoding: ['音声を変換中', 'Encoding audio'],
  preparing_chunks: ['送信用の音声を準備中', 'Preparing audio chunks'], chunking: ['音声を分割中', 'Preparing audio chunks'],
  finalizing: ['仕上げ中', 'Finishing'], running: ['処理中', 'Working'],
  fingerprinting: ['音声ファイルを確認中', 'Checking audio files'], saving: ['保存中', 'Saving'], prepared: ['音声の準備が完了しました', 'Audio is ready'],
};

export function progressPhaseLabel(phase: string | undefined, t: (ja: string, en: string) => string) {
  if (!phase) return t('処理中', 'Working');
  const translation = phases[phase];
  return translation ? t(...translation) : phase;
}

export interface ProgressStatusProps {
  label: string;
  phase?: string;
  completed?: number;
  total?: number;
  unit?: ProgressUnit;
  status?: ActivityStatus;
  error?: string;
  compact?: boolean;
}

export function ProgressStatus({ label, phase, completed, total, unit, status = 'running', error, compact = false }: ProgressStatusProps) {
  const { t } = useAppearance();
  const exact = typeof total === 'number' && Number.isFinite(total) && total > 0;
  const value = Math.max(0, Number.isFinite(completed) ? completed ?? 0 : 0);
  const bounded = exact ? Math.min(value, total) : value;
  const active = status === 'running';
  const state = active ? phase : status === 'waiting' ? 'awaiting_approval' : status;
  const format = (number: number) => unit === 'bytes' ? `${(number / 1024 / 1024).toFixed(1)} MiB`
    : unit === 'milliseconds' ? `${Math.floor(number / 60000)}:${String(Math.floor(number / 1000) % 60).padStart(2, '0')}`
      : String(Math.floor(number));
  const ratioOnly = exact && total === 1 && !unit;
  const count = ratioOnly ? `${Math.floor(bounded * 100)}%` : exact ? `${format(bounded)} / ${format(total)}` : completed !== undefined ? format(value) : undefined;
  return <div className={`progress-status${compact ? ' compact' : ''}`} data-status={status} aria-busy={active}>
    <div className="progress-status-copy"><strong>{label}</strong><span role="status">{progressPhaseLabel(state, t)}</span></div>
    {active && <progress aria-label={label} {...(exact ? { value: bounded, max: total } : {})} />}
    {count && <p className="progress-status-count">{unit === 'bytes' && !exact ? `${t('保存中の容量', 'Stored size')}: ` : ''}{count}{exact && active && !ratioOnly ? ` · ${Math.floor(bounded / total * 100)}%` : ''}</p>}
    {error && <p className="progress-status-error">{error}</p>}
  </div>;
}
