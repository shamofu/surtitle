// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import {
  ArchiveRestore,
  Check,
  Download,
  FileArchive,
  FileJson,
  FileSpreadsheet,
  FolderOpen,
  Upload,
} from 'lucide-react';
import { transferApi } from './api';
import type { ExportFormat } from '../../shared/contracts/transfer';
import type { RestorePreview } from '../../shared/contracts/transfer';
import {
  useDataActions,
  useAppearance,
  useNotifications,
} from '../../app/runtime';
import { Button, Modal, useModalExit } from '../../shared/ui/index';
import { ProgressStatus } from '../../shared/ui/ProgressStatus';
import { useActivities } from '../../app/providers/Activities';
import { useClearPreparationSessions } from '../ai/PreparationSessions';
import { clearEditorDraftSessions, flushEditorDrafts } from '../study/editor-drafts/useEditorDraft';
import { AnimatedValue, MotionRegion, MotionSwap } from '../../shared/motion';

export function TransferDialog({
  onClose,
  mediaId,
}: {
  onClose: () => void;
  mediaId?: string;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const { runTracked } = useActivities();
  const clearPreparations = useClearPreparationSessions();
  const [tab, setTab] = useState<'export' | 'restore'>('export');
  const [format, setFormat] = useState<ExportFormat>(mediaId ? 'srt' : 'zip');
  const [exportedPaths, setExportedPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const exit = useModalExit();
  const close = () => { if (!busy) void exit.close(onClose); };
  const [phase, setPhase] = useState('exporting');
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const mounted = useRef(true);
  const previewRequest = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      previewRequest.current++;
    };
  }, []);
  useEffect(
    () => () => {
      if (preview)
        void transferApi.discardRestorePreview(preview.token).catch(() => {});
    },
    [preview],
  );
  const formats: {
    id: ExportFormat;
    icon: typeof FileArchive;
    title: string;
    description: string;
  }[] = [
    {
      id: 'zip',
      icon: FileArchive,
      title: t('音声付きバックアップ', 'Portable backup'),
      description: t(
        '全作品の学習データ・復習履歴・保存した音声を ZIP に。',
        'All media, learning records, review history, and saved audio in a ZIP.',
      ),
    },
    {
      id: 'json',
      icon: FileJson,
      title: 'JSON',
      description: t(
        'すべての学習データと復習履歴。音声は含みません。',
        'All learning records and review history. Without audio.',
      ),
    },
    {
      id: 'csv',
      icon: FileSpreadsheet,
      title: 'CSV',
      description: t(
        '全作品のフレーズ一覧。表計算アプリで使えます。',
        'Phrases from all media for spreadsheets.',
      ),
    },
    {
      id: 'tsv',
      icon: FileSpreadsheet,
      title: 'TSV',
      description: t(
        '全作品のフレーズ一覧。他の学習ツールへ移せます。',
        'Tab-separated phrases from all media for other learning tools.',
      ),
    },
    ...(mediaId
      ? [
          {
            id: 'srt' as const,
            icon: FileJson,
            title: 'SRT',
            description: t(
              'この教材の字幕を書き出す。',
              'Export subtitles for this media.',
            ),
          },
          {
            id: 'vtt' as const,
            icon: FileJson,
            title: 'WebVTT',
            description: t(
              'Web プレイヤーで使える字幕。',
              'Subtitles for web players.',
            ),
          },
        ]
      : []),
  ];
  async function exportData() {
    if (busy || exit.exiting) return;
    setBusy(true);
    setPhase('exporting');
    try {
      const paths = await report(() => runTracked({ kind: 'export', label: t('学習データの書き出し', 'Export learning data'), phase: 'exporting', mediaId }, async () => {
        await flushEditorDrafts();
        return transferApi.exportLearning(format, mediaId);
      }, { classifyResult: paths => ({ status: paths.length ? 'completed' : 'cancelled' }) }));
      if (mounted.current && paths?.length) setExportedPaths(paths);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function chooseBackup() {
    if (busy || exit.exiting) return;
    const request = ++previewRequest.current;
    setBusy(true);
    setPhase('reading_backup');
    const result = await report(() => runTracked({ kind: 'restore_preview', label: t('バックアップの確認', 'Review backup'), phase: 'reading_backup' }, transferApi.previewRestore,
      { classifyResult: result => ({ status: result ? 'completed' : 'cancelled' }) }));
    if (!mounted.current || request !== previewRequest.current) {
      if (result)
        await transferApi.discardRestorePreview(result.token).catch(() => {});
      return;
    }
    if (result) {
      setPreview(result);
      setAcknowledged(false);
    }
    setBusy(false);
  }
  async function restoreData() {
    if (!preview || !acknowledged || busy || exit.exiting) return;
    setBusy(true);
    setPhase('restoring');
    const result = await report(
      () => runTracked({ kind: 'restore', label: t('学習データの復元', 'Restore learning data'), phase: 'restoring' }, async () => {
        await flushEditorDrafts();
        await mutate(async () => {
          await transferApi.restoreLearning(preview.token);
          clearEditorDraftSessions();
          clearPreparations();
        }, {
          kind: 'restore',
        });
        return true;
      }),
      t('学習データを復元しました。', 'Learning data restored.'),
    );
    setBusy(false);
    if (result) await exit.close(onClose);
  }
  return (
    <Modal
      {...exit.modalProps}
      closeDisabled={busy || exit.exiting}
      title={t('学びを持ち運ぶ', 'Take your learning with you')}
      eyebrow="YOUR WORDS, YOUR DATA"
      onClose={close}
    >
      <div className="segmented-control">
        <button
          className={tab === 'export' ? 'selected' : ''}
          disabled={busy}
          onClick={() => setTab('export')}
        >
          <Download size={15} />
          {t('エクスポート', 'Export')}
        </button>
        <button
          className={tab === 'restore' ? 'selected' : ''}
          disabled={busy}
          onClick={() => setTab('restore')}
        >
          <Upload size={15} />
          {t('復元', 'Restore')}
        </button>
      </div>
      <MotionRegion open={busy}><ProgressStatus label={phase === 'exporting' ? t('学習データの書き出し', 'Export learning data') : phase === 'reading_backup' ? t('バックアップの確認', 'Review backup') : t('学習データの復元', 'Restore learning data')} phase={phase} /></MotionRegion>
      <MotionSwap stateKey={tab === 'export' ? exportedPaths.length ? 'exported' : 'export' : `restore:${preview?.token || 'choose'}`}>
      {tab === 'export' && exportedPaths.length > 0 ? <section aria-label={t('書き出し完了', 'Export complete')}>
        <p role="status">{t('書き出しました。', 'Your export is ready.')}</p>
        <ul>{exportedPaths.map(path => <li key={path}><p style={{ overflowWrap: 'anywhere' }}>{path}</p><Button onClick={() => void report(() => transferApi.revealExportFile(path))}><FolderOpen size={16} />{t('保存先を開く', 'Open containing folder')}</Button></li>)}</ul>
        <footer className="modal-footer"><Button onClick={() => setExportedPaths([])}>{t('別の形式で書き出す', 'Export another format')}</Button><Button variant="primary" onClick={close}>{t('完了', 'Done')}</Button></footer>
      </section> : tab === 'export' ? (
        <>
          <p className="notice" role="status"><MotionSwap as="span" stateKey={format === 'srt' || format === 'vtt' ? 'subtitles' : format === 'csv' || format === 'tsv' ? 'phrases' : 'all'}>{format === 'srt' || format === 'vtt'
            ? t('対象：この作品の字幕（翻訳があれば別ファイルも作成）', 'Scope: subtitles for this media, plus a separate translation file when available')
            : format === 'csv' || format === 'tsv'
              ? t('対象：すべての作品のフレーズ', 'Scope: phrases from all media')
              : t('対象：すべての学習データ', 'Scope: all learning data')}</MotionSwap></p>
          <div className="format-list">
            {formats.map((item) => (
              <button
                key={item.id}
                className={`format-option ${format === item.id ? 'selected' : ''}`}
                onClick={() => setFormat(item.id)}
                aria-pressed={format === item.id}
                disabled={busy}
              >
                <item.icon size={21} />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.description}</small>
                </span>
                <span className="radio-indicator">
                  <MotionRegion as="span" open={format === item.id}><Check size={12} /></MotionRegion>
                </span>
              </button>
            ))}
          </div>
          <p className="helper-text">
            {t(
              '元の動画・認証情報・有料ジョブの実行承認は含まれません。',
              'Original videos, credentials, and paid-job approvals are excluded.',
            )}
          </p>
          <footer className="modal-footer">
            <Button onClick={close} disabled={busy}>
              {t('キャンセル', 'Cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void exportData()}
              busy={busy}
            >
              <Download size={16} />
              {t('保存先を選ぶ', 'Choose destination')}
            </Button>
          </footer>
        </>
      ) : (
        <>
          {!preview ? (
            <div className="restore-drop">
              <ArchiveRestore size={38} strokeWidth={1.3} />
              <h3>
                {t('バックアップから続ける', 'Pick up where you left off')}
              </h3>
              <p>
                {t(
                  'JSON または ZIP を選ぶと、復元する内容を先に確認できます。',
                  'Select JSON or ZIP to preview its contents before restoring.',
                )}
              </p>
              <Button
                variant="primary"
                busy={busy}
                onClick={() => void chooseBackup()}
              >
                <FolderOpen size={16} />
                {t('バックアップを選ぶ', 'Choose backup')}
              </Button>
            </div>
          ) : (
            <>
              <div className="restore-summary">
                <div>
                  <strong><AnimatedValue value={preview.mediaCount} /></strong>
                  <span>{t('教材', 'media')}</span>
                </div>
                <div>
                  <strong><AnimatedValue value={preview.cardCount} /></strong>
                  <span>{t('フレーズ', 'phrases')}</span>
                </div>
                <div>
                  <strong><AnimatedValue value={preview.reviewCount} /></strong>
                  <span>{t('復習記録', 'reviews')}</span>
                </div>
                <div>
                  <strong><AnimatedValue value={preview.audioCount} /></strong>
                  <span>{t('音声', 'clips')}</span>
                </div>
              </div>
              {preview.warnings.map((warning, index) => (
                <p className="notice warning" key={index}>
                  {warning}
                </p>
              ))}
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>
                  {t(
                    '復元内容を確認しました。現在の学習データを置き換えて復元します。',
                    'I reviewed this backup and want to replace the current learning data.',
                  )}
                </span>
              </label>
              <p className="helper-text">
                {t(
                  'このデバイスの認証情報・課金台帳・ツール設定は保持します。新しいデバイスでは初期設定が必要です。',
                  'This device keeps its credentials, usage ledger, and tool settings. A new device needs its own setup.',
                )}
              </p>
              <footer className="modal-footer">
                <Button onClick={() => void chooseBackup()} disabled={busy}>
                  {t('別のファイル', 'Choose another')}
                </Button>
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={!acknowledged}
                  onClick={() => void restoreData()}
                >
                  <ArchiveRestore size={16} />
                  {t('復元する', 'Restore backup')}
                </Button>
              </footer>
            </>
          )}
        </>
      )}
      </MotionSwap>
    </Modal>
  );
}
