// SPDX-License-Identifier: GPL-3.0-or-later
import { MotionLink } from '../../shared/ui/MotionLink';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FolderOpen, Link2, RefreshCw, Upload, X } from 'lucide-react';
import { libraryApi } from './api';
import { importWorkspace as workspace } from './import-workspace';
import { useDataActions, useAppearance, useSnapshot, useNotifications } from '../../app/runtime';
import { Button, Field, IconButton, Modal } from '../../shared/ui/index';
import { ProgressStatus } from '../../shared/ui/ProgressStatus';
import { useActivities } from '../../app/providers/Activities';
import { LanguageInput } from '../../shared/ui/LanguageInput';
import { MotionSwap } from '../../shared/motion';
import { SelectionIndicator } from '../../shared/motion/SelectionIndicator';
import './import.css';

export interface DroppedMediaFiles { revision: number; paths: string[] }
const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;

export function ImportDialog({ onClose, onReturnToLibrary = onClose, droppedFiles, dragging = false, onBusyChange }: {
  onClose: () => void; onReturnToLibrary?: () => void; droppedFiles?: DroppedMediaFiles; dragging?: boolean; onBusyChange?: (busy: boolean) => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { data } = useSnapshot();
  const { report } = useNotifications();
  const { runTracked } = useActivities();
  const view = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const [picking, setPicking] = useState(false);
  const [startingUrl, setStartingUrl] = useState(false);
  const received = useRef<number | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; void workspace.initialize(data?.settings.learningLanguage || 'en', data?.settings.explanationLanguage || 'ja'); return () => { alive.current = false; void workspace.flush().catch(() => {}); }; }, []);
  const languagesValid = !!view.learningLanguage.trim() && !!view.explanationLanguage.trim();
  const busy = view.busy || picking || startingUrl;
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const add = (paths: string[], retry = false) => workspace.add(paths, action => mutate(action, { kind: 'snapshot' }), runTracked, t('ファイルをライブラリに追加', 'Add files to library'), retry);
  useEffect(() => {
    if (!view.ready || !languagesValid || busy || !droppedFiles || received.current === droppedFiles.revision) return;
    received.current = droppedFiles.revision;
    void add(droppedFiles.paths);
  }, [view.ready, languagesValid, busy, droppedFiles]);
  async function selectFiles() {
    setPicking(true);
    try { const paths = await libraryApi.selectMediaFiles(); if (paths.length) void add(paths); }
    catch (error) { void report(() => Promise.reject(error)); }
    finally { if (alive.current) setPicking(false); }
  }
  const validUrl = (() => { try { return ['http:', 'https:'].includes(new URL(view.url).protocol); } catch { return false; } })();
  async function startUrl() {
    if (!validUrl || !languagesValid || busy) return;
    setStartingUrl(true);
    const success = await report(async () => {
      await mutate(() => libraryApi.startUrlImport({ kind: 'url', pathOrUrl: view.url.trim(), learningLanguage: view.learningLanguage.trim(), explanationLanguage: view.explanationLanguage.trim() }), { kind: 'downloads' });
      workspace.change({ url: '' });
      return true;
    }, t('ダウンロードを開始しました。', 'Download started.'));
    if (alive.current) { setStartingUrl(false); if (success) onReturnToLibrary(); }
  }
  const failed = view.rows.filter(row => row.status === 'failed');
  return <Modal title={t('作品を追加', 'Add a video or audio file')} onClose={onClose}>
    <div className="media-import"><div className="import-body">
      <div className="segmented-control" role="group" aria-label={t('追加する方法', 'Import source')}>
        <SelectionIndicator variant="pill" />
        <button className={view.mode === 'local' ? 'selected' : ''} aria-pressed={view.mode === 'local'} onClick={() => workspace.change({ mode: 'local' })}><FolderOpen size={16} />{t('ファイル', 'Local file')}</button>
        <button className={view.mode === 'url' ? 'selected' : ''} aria-pressed={view.mode === 'url'} onClick={() => workspace.change({ mode: 'url' })}><Link2 size={16} />URL</button>
      </div>
      <div className="field-row import-languages">
        <Field label={t('学習する言語', 'Learning language')}><LanguageInput value={view.learningLanguage} onChange={learningLanguage => workspace.change({ learningLanguage })} disabled={busy || !view.ready} /></Field>
        <Field label={t('説明・翻訳の言語', 'Explanation language')}><LanguageInput value={view.explanationLanguage} onChange={explanationLanguage => workspace.change({ explanationLanguage })} disabled={busy || !view.ready} /></Field>
      </div>
      <MotionSwap stateKey={view.mode}>
      {view.mode === 'local' ? <>
        <button className={`import-drop ${dragging ? 'is-dragging' : ''}`} onClick={() => void selectFiles()} disabled={busy || !view.ready || !languagesValid}>
          <span className="drop-icon"><Upload size={26} /></span><strong>{t('動画・音声ファイルを選択', 'Choose a video or audio file')}</strong>
          <span>{t('選択・ドロップすると取り込みを開始します。複数選択できます。', 'Choose or drop files to start importing. Multiple files are supported.')}</span><small>MP4 · MKV · WEBM · MOV · AVI · MP3 · WAV · FLAC</small>
        </button>
        {!!view.rows.length && <section className="import-selection" aria-label={t('選択したファイル', 'Selected files')}>
          <div className="import-selection-heading"><strong>{t(`${view.rows.length} 件のファイル`, `${view.rows.length} files`)}</strong><Button variant="ghost" disabled={busy} onClick={() => workspace.clear()}>{t('一覧をクリア', 'Clear list')}</Button></div>
          <ul className="import-file-list">{view.rows.map(row => <li key={row.id} className={`import-file-row ${row.status}`}>
            <div className="import-file-copy"><strong title={row.inputPath}>{fileName(row.inputPath)}</strong><p>{row.status === 'imported' ? t('追加しました', 'Added') : row.status === 'existing' ? t('追加済み', 'Already in library') : row.status === 'invalid' ? t('読み込めないファイルです', 'This file cannot be imported') : row.status === 'failed' ? row.error : t('追加中…', 'Adding…')}</p></div>
            <div className="import-file-actions">{row.mediaId && <MotionLink to="/study/$mediaId" params={{ mediaId: row.mediaId }} className="button secondary" aria-label={t(`${fileName(row.inputPath)} を開く`, `Open ${fileName(row.inputPath)}`)} onClick={onClose}>{t('開く', 'Open')}</MotionLink>}<IconButton label={t(`${fileName(row.inputPath)} を一覧から外す`, `Remove ${fileName(row.inputPath)} from this list`)} disabled={busy} onClick={() => workspace.remove(row.id)}><X size={17} /></IconButton></div>
          </li>)}</ul>
        </section>}
      </> : <Field label={t('動画・音声の URL', 'Video or audio URL')} hint={t('公開 YouTube 動画、またはメディアファイルへの直接リンク。', 'A public YouTube video or direct media link.')}><input value={view.url} onChange={event => workspace.change({ url: event.target.value })} type="url" placeholder="https://…" disabled={startingUrl} /></Field>}
      </MotionSwap>
      {view.busy && <ProgressStatus label={t('ファイルを追加中', 'Importing files')} phase="importing" completed={view.completed} total={view.total} unit="items" />}
      {busy && <p className="helper-text">{t('この画面を閉じても取り込みは続きます。', 'Importing continues when you close this panel.')}</p>}
      {view.error && <p className="notice warning" role="alert">{view.error}
        {!view.ready && <Button onClick={() => void workspace.flush().catch(() => {})}>{t('再試行', 'Retry')}</Button>}
      </p>}
      {!languagesValid && <p className="helper-text">{t('学習言語と説明・翻訳の言語を入力してください。', 'Enter both languages.')}</p>}
      <p className="helper-text">{t('取り込みだけでは AI を実行しません。', 'Importing does not run AI.')}</p>
    </div><footer className="modal-footer import-footer"><Button onClick={onClose}>{t('閉じる', 'Close')}</Button>
      {!!failed.length && view.mode === 'local' && <Button disabled={busy || !languagesValid} onClick={() => void add(failed.map(row => row.inputPath), true)}><RefreshCw size={16} />{t('失敗したファイルだけ再試行', 'Retry failed files')}</Button>}
      {view.mode === 'url' && <Button variant="primary" busy={startingUrl} disabled={busy || !view.ready || !languagesValid || !validUrl} onClick={() => void startUrl()}>{t('ダウンロードを開始', 'Start download')}</Button>}
    </footer></div>
  </Modal>;
}
