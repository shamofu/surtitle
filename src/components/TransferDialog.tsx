// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { ArchiveRestore, Check, Download, FileArchive, FileJson, FileSpreadsheet, FolderOpen, Upload } from 'lucide-react';
import { api } from '../api';
import type { ExportFormat, RestorePreview } from '../api';
import { useApp } from '../context';
import { Button, Modal } from './ui';

export function TransferDialog({ onClose, mediaId }: { onClose: () => void; mediaId?: string }) {
  const { t, run } = useApp();
  const [tab, setTab] = useState<'export' | 'restore'>('export');
  const [format, setFormat] = useState<ExportFormat>('zip');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const mounted = useRef(true);
  const previewRequest = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; previewRequest.current++; }; }, []);
  useEffect(() => () => { if (preview) void api.discardRestorePreview(preview.token).catch(() => {}); }, [preview]);
  const formats: { id: ExportFormat; icon: typeof FileArchive; title: string; description: string }[] = [
    { id: 'zip', icon: FileArchive, title: t('音声付きバックアップ', 'Portable backup'), description: t('学習データ・復習履歴・保存した音声を ZIP に。', 'Learning, review history, and saved audio in a ZIP.') },
    { id: 'json', icon: FileJson, title: 'JSON', description: t('すべての学習データと復習履歴。音声は含みません。', 'All learning records and review history. Without audio.') },
    { id: 'csv', icon: FileSpreadsheet, title: 'CSV', description: t('表計算アプリで使えるフレーズ一覧。', 'A phrase collection for spreadsheets.') },
    { id: 'tsv', icon: FileSpreadsheet, title: 'TSV', description: t('他の学習ツールへ移せるタブ区切りテキスト。', 'Tab-separated phrases for other learning tools.') },
    ...(mediaId ? [
      { id: 'srt' as const, icon: FileJson, title: 'SRT', description: t('この教材の字幕を書き出す。', 'Export subtitles for this media.') },
      { id: 'vtt' as const, icon: FileJson, title: 'WebVTT', description: t('Web プレイヤーで使える字幕。', 'Subtitles for web players.') },
    ] : []),
  ];
  async function exportData() {
    setBusy(true);
    const path = await run(() => api.exportLearning(format, mediaId));
    if (path) { await run(async () => true, t('学習データを書き出しました。', 'Learning data exported.')); onClose(); }
    setBusy(false);
  }
  async function chooseBackup() {
    const request = ++previewRequest.current;
    setBusy(true);
    const result = await run(api.previewRestore);
    if (!mounted.current || request !== previewRequest.current) {
      if (result) await api.discardRestorePreview(result.token).catch(() => {});
      return;
    }
    if (result) { setPreview(result); setAcknowledged(false); }
    setBusy(false);
  }
  async function restoreData() {
    if (!preview || !acknowledged) return;
    setBusy(true);
    const result = await run(async () => { await api.restoreLearning(preview.token); return true; }, t('学習データを復元しました。', 'Learning data restored.'));
    setBusy(false);
    if (result) onClose();
  }
  return <Modal title={t('学びを持ち運ぶ', 'Take your learning with you')} eyebrow="YOUR WORDS, YOUR DATA" onClose={() => { if (!busy) onClose(); }}>
    <div className="segmented-control"><button className={tab === 'export' ? 'selected' : ''} onClick={() => setTab('export')}><Download size={15} />{t('エクスポート', 'Export')}</button><button className={tab === 'restore' ? 'selected' : ''} onClick={() => setTab('restore')}><Upload size={15} />{t('復元', 'Restore')}</button></div>
    {tab === 'export' ? <>
      <div className="format-list">{formats.map(item => <button key={item.id} className={`format-option ${format === item.id ? 'selected' : ''}`} onClick={() => setFormat(item.id)} aria-pressed={format === item.id}><item.icon size={21} /><span><strong>{item.title}</strong><small>{item.description}</small></span><span className="radio-indicator">{format === item.id && <Check size={12} />}</span></button>)}</div>
      <p className="helper-text">{t('元の動画・認証情報・有料ジョブの実行承認は含まれません。', 'Original videos, credentials, and paid-job approvals are excluded.')}</p>
      <footer className="modal-footer"><Button onClick={onClose} disabled={busy}>{t('キャンセル', 'Cancel')}</Button><Button variant="primary" onClick={() => void exportData()} busy={busy}><Download size={16} />{t('保存先を選ぶ', 'Choose destination')}</Button></footer>
    </> : <>
      {!preview ? <div className="restore-drop"><ArchiveRestore size={38} strokeWidth={1.3} /><h3>{t('バックアップから続ける', 'Pick up where you left off')}</h3><p>{t('JSON または ZIP を選ぶと、復元する内容を先に確認できます。', 'Select JSON or ZIP to preview its contents before restoring.')}</p><Button variant="primary" busy={busy} onClick={() => void chooseBackup()}><FolderOpen size={16} />{t('バックアップを選ぶ', 'Choose backup')}</Button></div> : <>
        <div className="restore-summary"><div><strong>{preview.mediaCount}</strong><span>{t('教材', 'media')}</span></div><div><strong>{preview.cardCount}</strong><span>{t('フレーズ', 'phrases')}</span></div><div><strong>{preview.reviewCount}</strong><span>{t('復習記録', 'reviews')}</span></div><div><strong>{preview.audioCount}</strong><span>{t('音声', 'clips')}</span></div></div>
        {preview.warnings.map((warning, index) => <p className="notice warning" key={index}>{warning}</p>)}
        <label className="check-field"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>{t('復元内容を確認しました。現在の学習データを置き換えて復元します。', 'I reviewed this backup and want to replace the current learning data.')}</span></label>
        <p className="helper-text">{t('このデバイスの認証情報・課金台帳・ツール設定は保持します。新しいデバイスでは初期設定が必要です。', 'This device keeps its credentials, usage ledger, and tool settings. A new device needs its own setup.')}</p>
        <footer className="modal-footer"><Button onClick={() => void chooseBackup()} disabled={busy}>{t('別のファイル', 'Choose another')}</Button><Button variant="primary" busy={busy} disabled={!acknowledged} onClick={() => void restoreData()}><ArchiveRestore size={16} />{t('復元する', 'Restore backup')}</Button></footer>
      </>}
    </>}
  </Modal>;
}
