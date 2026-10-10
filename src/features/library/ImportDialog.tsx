// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowDownToLine, Check, FileVideo2, FolderOpen, Link2, Plus, RefreshCw, Sparkles, Upload, X } from 'lucide-react';
import { libraryApi } from './api';
import { useDataActions, useAppearance, useSnapshot, useNotifications } from '../../app/runtime';
import { Button, Field, IconButton, Modal } from '../../shared/ui/index';
import { ProgressStatus } from '../../shared/ui/ProgressStatus';
import { useActivities } from '../../app/providers/Activities';
import { LanguageInput } from '../../shared/ui/LanguageInput';
import { languagePair, mergeQueue, queueStatus, validatedItem } from './import-queue';
import type { ImportQueueItem } from './import-queue';
import './import.css';

export interface DroppedMediaFiles { revision: number; paths: string[] }
const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function ImportDialog({ onClose, onReturnToLibrary = onClose, droppedFiles, dragging = false, onBusyChange }: {
  onClose: () => void;
  onReturnToLibrary?: () => void;
  droppedFiles?: DroppedMediaFiles;
  dragging?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { data } = useSnapshot();
  const { report } = useNotifications();
  const { runTracked } = useActivities();
  const [fileProgress, setFileProgress] = useState<{ completed: number; total: number }>();
  const [mode, setMode] = useState<'local' | 'url'>('local');
  const [rows, setRows] = useState<ImportQueueItem[]>([]);
  const rowsRef = useRef(rows);
  const nextId = useRef(0);
  const [url, setUrl] = useState('');
  const [learningLanguage, setLearningLanguage] = useState(data?.settings.learningLanguage || 'en');
  const [explanationLanguage, setExplanationLanguage] = useState(data?.settings.explanationLanguage || 'ja');
  const [phase, setPhase] = useState<'picking' | 'validating' | 'languages' | 'importing' | 'url' | null>(null);
  const pending = useRef(false);
  const checkingLanguages = useRef(false);
  const languageRevision = useRef(0);
  const alive = useRef(true);
  const [attempted, setAttempted] = useState(false);
  const [problem, setProblem] = useState('');
  const [duplicates, setDuplicates] = useState(0);
  const busy = phase !== null;
  const pair = languagePair(learningLanguage, explanationLanguage);
  const previousPair = useRef(pair);
  const languagesValid = !!learningLanguage.trim() && !!explanationLanguage.trim();
  const readyCount = rows.filter(row => queueStatus(row, pair) === 'ready').length;
  const failedCount = rows.filter(row => row.status === 'failed').length;
  const addedCount = rows.filter(row => row.status === 'imported').length;
  const existingCount = rows.filter(row => queueStatus(row, pair) === 'existing').length;
  const invalidCount = rows.filter(row => row.status === 'invalid').length;
  const validUrl = (() => {
    try { return ['http:', 'https:'].includes(new URL(url).protocol); }
    catch { return false; }
  })();
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  function updateRows(update: (current: ImportQueueItem[]) => ImportQueueItem[]) {
    if (!alive.current) return;
    rowsRef.current = update(rowsRef.current);
    setRows(rowsRef.current);
  }
  function begin(next: NonNullable<typeof phase>) {
    if (pending.current || checkingLanguages.current) return false;
    pending.current = true;
    setPhase(next);
    setProblem('');
    onBusyChange?.(true);
    return true;
  }
  function finish() {
    pending.current = false;
    if (!alive.current) return;
    setPhase(null);
    onBusyChange?.(false);
  }
  useEffect(() => {
    if (previousPair.current === pair) return;
    previousPair.current = pair;
    const revision = ++languageRevision.current;
    const targets = rowsRef.current.filter(row => row.status === 'ready' || row.status === 'existing');
    if (!languagesValid || !targets.length) {
      if (checkingLanguages.current) {
        checkingLanguages.current = false;
        setPhase(null);
        onBusyChange?.(false);
      }
      return;
    }
    checkingLanguages.current = true;
    setPhase('languages');
    setProblem('');
    onBusyChange?.(true);
    // LanguageInput accepts free text. Keep it editable while waiting for a
    // pause in typing, and discard responses for an older language pair.
    const timer = window.setTimeout(() => {
      void libraryApi.validateMediaFiles(targets.map(row => row.inputPath), learningLanguage.trim(), explanationLanguage.trim())
        .then(results => {
          if (!alive.current || revision !== languageRevision.current) return;
          const byPath = new Map(results.map(result => [result.inputPath, result]));
          const targetIds = new Set(targets.map(row => row.id));
          updateRows(current => mergeQueue([], current.map(row => {
            const result = targetIds.has(row.id) ? byPath.get(row.inputPath) : undefined;
            return result ? validatedItem(row.id, result, pair) : row;
          })));
        })
        .catch(error => {
          if (!alive.current || revision !== languageRevision.current) return;
          const ids = new Set(targets.map(row => row.id));
          updateRows(current => current.map(row => ids.has(row.id) ? { ...row, status: 'failed', error: errorText(error) } : row));
        })
        .finally(() => {
          if (!alive.current || revision !== languageRevision.current) return;
          checkingLanguages.current = false;
          setPhase(null);
          onBusyChange?.(false);
        });
    }, 250);
    return () => { window.clearTimeout(timer); languageRevision.current += 1; };
  }, [pair]);
  async function appendPaths(paths: string[]) {
    if (!paths.length || !alive.current) return;
    setPhase('validating');
    // Inspect files even while a language field is incomplete. The final
    // language pair is always checked again before any write.
    const learning = learningLanguage.trim() || data?.settings.learningLanguage || 'en';
    const explanation = explanationLanguage.trim() || data?.settings.explanationLanguage || 'ja';
    const validationPair = languagePair(learning, explanation);
    let incoming: ImportQueueItem[];
    try {
      const results = await runTracked({ kind: 'import_check', label: t('追加するファイルの確認', 'Check selected files'), phase: 'checking_files' }, () => libraryApi.validateMediaFiles(paths, learning, explanation));
      incoming = results.map(result => validatedItem(++nextId.current, result, validationPair));
    } catch (error) {
      incoming = paths.map(inputPath => ({ id: ++nextId.current, inputPath, status: 'failed', languagePair: validationPair, error: errorText(error) }));
    }
    if (!alive.current) return;
    const before = rowsRef.current.length;
    const merged = mergeQueue(rowsRef.current, incoming);
    setDuplicates(incoming.length - (merged.length - before));
    updateRows(() => merged);
  }
  async function receivePaths(paths: string[]) {
    if (!paths.length || !begin('validating')) return;
    setMode('local');
    try { await appendPaths(paths); } finally { finish(); }
  }
  const receiveRef = useRef(receivePaths);
  receiveRef.current = receivePaths;
  const received = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!droppedFiles || received.current === droppedFiles.revision) return;
    received.current = droppedFiles.revision;
    void receiveRef.current(droppedFiles.paths);
  }, [droppedFiles]);
  async function selectFiles() {
    if (!begin('picking')) return;
    try { await appendPaths(await libraryApi.selectMediaFiles()); }
    catch (error) { if (alive.current) setProblem(errorText(error)); }
    finally { finish(); }
  }
  async function submitLocal(retryFailed = false) {
    if (!languagesValid || !begin('importing')) return;
    const targets = rowsRef.current.filter(row => retryFailed ? row.status === 'failed' : queueStatus(row, pair) === 'ready');
    const targetIds = new Set(targets.map(row => row.id));
    setAttempted(true);
    setFileProgress(undefined);
    try {
      await runTracked({ kind: 'import', label: t('ファイルをライブラリに追加', 'Add files to library'), phase: 'checking_files' }, async update => {
        const results = await libraryApi.validateMediaFiles(targets.map(row => row.inputPath), learningLanguage.trim(), explanationLanguage.trim());
        if (!alive.current) return { failed: 0, cancelled: true };
        const byPath = new Map(results.map(result => [result.inputPath, result]));
        updateRows(current => mergeQueue([], current.map(row => {
          if (!targetIds.has(row.id)) return row;
          const result = byPath.get(row.inputPath);
          return result ? validatedItem(row.id, result, pair) : { ...row, status: 'failed', error: t('ファイルを確認できませんでした。再試行してください。', 'Could not check this file. Try again.') };
        })));
        const ready = rowsRef.current.filter(row => targetIds.has(row.id) && row.status === 'ready');
        let failed = rowsRef.current.filter(row => targetIds.has(row.id) && ['invalid', 'failed'].includes(row.status)).length;
        let completed = targets.length - ready.length;
        const progress = () => {
          update({ phase: 'importing', completed, total: targets.length, unit: 'items' });
          if (alive.current) setFileProgress({ completed, total: targets.length });
        };
        progress();
        for (const row of ready) {
          if (!alive.current) return { failed, cancelled: true };
          updateRows(current => current.map(item => item.id === row.id ? { ...item, status: 'importing' } : item));
          try {
            const result = await mutate(() => libraryApi.importLocalMedia({
              kind: 'local', pathOrUrl: row.canonicalPath || row.inputPath,
              learningLanguage: learningLanguage.trim(), explanationLanguage: explanationLanguage.trim(),
            }), { kind: 'snapshot' });
            updateRows(current => current.map(item => item.id === row.id ? { ...item, status: result.created ? 'imported' : 'existing', mediaId: result.mediaId } : item));
          } catch (error) {
            failed++;
            updateRows(current => current.map(item => item.id === row.id ? { ...item, status: 'failed', error: errorText(error) } : item));
          }
          completed++;
          progress();
        }
        return { failed, cancelled: false };
      }, { classifyResult: result => ({ status: result.cancelled ? 'cancelled' : result.failed ? 'failed' : 'completed', error: result.failed ? t(`${result.failed} 件を追加できませんでした。`, `${result.failed} files could not be added.`) : undefined }) });
    } catch (error) {
      updateRows(current => current.map(row => targetIds.has(row.id) ? { ...row, status: 'failed', error: errorText(error) } : row));
    } finally { finish(); }
  }
  async function submitUrl() {
    if (!validUrl || !languagesValid || !begin('url')) return;
    const success = await report(async () => {
      await mutate(() => libraryApi.startUrlImport({ kind: 'url', pathOrUrl: url.trim(), learningLanguage: learningLanguage.trim(), explanationLanguage: explanationLanguage.trim() }), { kind: 'downloads' });
      return true;
    }, t('ダウンロードを開始しました。ライブラリで進捗を確認できます。', 'Download started. Follow its progress in the library.'));
    finish();
    if (success && alive.current) onReturnToLibrary();
  }
  function statusText(row: ImportQueueItem) {
    const status = queueStatus(row, pair);
    if (status === 'ready') return t('追加できます', 'Ready to add');
    if (status === 'importing') return t('追加中…', 'Adding…');
    if (status === 'imported') return t('追加しました', 'Added');
    if (status === 'existing') return t('この言語の組み合わせで追加済み', 'Already in your library with these languages');
    if (status === 'failed') return row.error || t('追加できませんでした', 'Could not add this file');
    const reasons = {
      invalidPath: t('ファイルの場所を確認できません。ファイルを選び直してください。', 'Select this file again to confirm its location.'),
      missing: t('ファイルが見つかりません。移動していないか確認してください。', 'File not found. Check whether it has moved.'),
      directory: t('フォルダーは追加できません。中の動画・音声を選んでください。', 'Choose the video or audio files inside this folder.'),
      empty: t('空のファイルは追加できません。', 'This file is empty.'),
      unsupported: t('対応していない形式です。動画・音声ファイルを選んでください。', 'Unsupported format. Choose a supported video or audio file.'),
      unreadable: t('ファイルを読み取れません。アクセス権を確認してください。', 'Cannot read this file. Check its access permissions.'),
    };
    return row.reason ? reasons[row.reason] : t('追加できないファイルです', 'This file cannot be added');
  }
  return <Modal title={t('作品を追加', 'Add a video or audio file')} closeDisabled={busy} onClose={() => { if (!pending.current && !checkingLanguages.current) onClose(); }}>
    <div className="media-import">
      <div className="import-body">
      <div className="segmented-control" role="group" aria-label={t('追加する方法', 'Import source')}>
        <button className={mode === 'local' ? 'selected' : ''} aria-pressed={mode === 'local'} disabled={busy} onClick={() => setMode('local')}><FolderOpen size={16} />{t('ファイル', 'Local file')}</button>
        <button className={mode === 'url' ? 'selected' : ''} aria-pressed={mode === 'url'} disabled={busy} onClick={() => setMode('url')}><Link2 size={16} />URL</button>
      </div>
      <div className="field-row import-languages">
        <Field label={t('学習する言語', 'Learning language')}><LanguageInput value={learningLanguage} onChange={setLearningLanguage} disabled={busy && phase !== 'languages'} /></Field>
        <Field label={t('説明・翻訳の言語', 'Explanation language')}><LanguageInput value={explanationLanguage} onChange={setExplanationLanguage} disabled={busy && phase !== 'languages'} /></Field>
      </div>
      {dragging && mode === 'url' && <p className="import-drag-notice" role="status">{t('ドロップするとファイルの追加に切り替わります。入力中の URL は残ります。', 'Drop to add local files. Your URL will be kept.')}</p>}
      {mode === 'local' ? <>
        <button className={`import-drop ${dragging ? 'is-dragging' : ''} ${rows.length ? 'has-files' : ''}`} onClick={() => void selectFiles()} disabled={busy}>
          <span className="drop-icon"><Upload size={26} strokeWidth={1.5} /></span>
          <strong>{dragging ? t('ここにドロップしてファイルを確認', 'Drop to review these files') : rows.length ? t('ファイルを追加で選択', 'Choose more files') : t('動画・音声ファイルを選択', 'Choose a video or audio file')}</strong>
          <span>{t('ここへドラッグ＆ドロップ、またはクリックして選択。複数のファイルをまとめて追加できます。', 'Drag and drop here, or click to choose. You can add several files together.')}</span>
          <small>MP4 · MKV · WEBM · MOV · AVI · M4V · MP3 · WAV · FLAC · M4A · OGG · OPUS</small>
        </button>
        {!!rows.length && <section className="import-selection" aria-label={t('選択したファイル', 'Selected files')}>
          <div className="import-selection-heading"><strong>{t(`${rows.length} 件のファイル`, `${rows.length} files`)}</strong><Button variant="ghost" disabled={busy} onClick={() => { updateRows(() => []); setDuplicates(0); setAttempted(false); }}>{t('一覧をクリア', 'Clear list')}</Button></div>
          <ul className="import-file-list">{rows.map(row => {
            const status = queueStatus(row, pair);
            return <li key={row.id} className={`import-file-row ${status}`}>
              {status === 'imported' || status === 'existing' ? <Check size={18} aria-hidden="true" /> : <FileVideo2 size={18} aria-hidden="true" />}
              <div className="import-file-copy"><strong title={row.inputPath}>{fileName(row.inputPath)}</strong><small className="import-file-path">{row.inputPath}</small><p>{statusText(row)}</p></div>
              <div className="import-file-actions">
                {row.mediaId && (status === 'imported' || status === 'existing') && !busy && <Link to="/study/$mediaId" params={{ mediaId: row.mediaId }} className="button secondary" aria-label={t(`${fileName(row.inputPath)} を開く`, `Open ${fileName(row.inputPath)}`)}>{t('開く', 'Open')}</Link>}
                <IconButton label={t(`${fileName(row.inputPath)} を一覧から外す`, `Remove ${fileName(row.inputPath)} from this list`)} disabled={busy} onClick={() => updateRows(current => current.filter(item => item.id !== row.id))}><X size={17} /></IconButton>
              </div>
            </li>;
          })}</ul>
        </section>}
        {duplicates > 0 && <p className="helper-text" role="status">{t(`同じファイル ${duplicates} 件をまとめました。`, `${duplicates} repeated file${duplicates === 1 ? '' : 's'} skipped.`)}</p>}
        {attempted && <p className="import-results" role="status">{t(`追加 ${addedCount} 件・追加済み ${existingCount} 件・失敗 ${failedCount} 件・対象外 ${invalidCount} 件`, `${addedCount} added · ${existingCount} already in library · ${failedCount} failed · ${invalidCount} unsupported or unavailable`)}</p>}
      </> : <div className="url-import">
        <Field label={t('動画・音声の URL', 'Video or audio URL')} hint={t('公開 YouTube 動画、またはメディアファイルへの直接リンク。プレイリスト・ライブには対応しません。', 'A public YouTube video or direct media link. Playlists and live streams are not supported.')}><input value={url} disabled={busy} onChange={event => setUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" type="url" autoFocus /></Field>
        <p className="notice"><ArrowDownToLine size={16} />{t('ダウンロード完了後に再生できます。', 'Playback starts after the complete download.')}</p>
      </div>}
      {!languagesValid && <p className="helper-text">{t('追加する前に、学習言語と説明・翻訳の言語を指定してください。', 'Choose both languages before adding files.')}</p>}
      {problem && <p className="notice warning" role="alert">{problem}</p>}
      {phase === 'picking' ? <p className="helper-text" role="status">{t('ファイルを選択してください…', 'Choose your files…')}</p> : phase && <ProgressStatus label={phase === 'url' ? t('ダウンロードの準備', 'Prepare download') : t('ファイルをライブラリに追加', 'Add files to library')} phase={phase === 'validating' || phase === 'languages' || (phase === 'importing' && !fileProgress) ? 'checking_files' : phase === 'url' ? 'preparing' : 'importing'} completed={phase === 'importing' ? fileProgress?.completed : undefined} total={phase === 'importing' ? fileProgress?.total : undefined} unit="items" />}
      <p className="helper-text"><Sparkles size={13} />{t('追加だけでは AI を実行しません。使う範囲と金額を後から選べます。', 'Importing does not run AI. Choose its scope and cost when you need it.')}</p>
      </div>
      <footer className="modal-footer import-footer">
        <Button onClick={attempted || addedCount || existingCount ? onReturnToLibrary : onClose} disabled={busy}>{attempted || addedCount || existingCount ? t('ライブラリに戻る', 'Return to library') : t('キャンセル', 'Cancel')}</Button>
        {mode === 'local' && failedCount > 0 && <Button disabled={busy || !languagesValid} onClick={() => void submitLocal(true)}><RefreshCw size={16} />{t('失敗したファイルだけ再試行', 'Retry failed files')}</Button>}
        {(mode === 'url' || readyCount > 0 || !rows.length) && <Button variant="primary" busy={busy} disabled={!languagesValid || (mode === 'local' ? !readyCount : !validUrl)} onClick={() => void (mode === 'local' ? submitLocal() : submitUrl())}><Plus size={16} />{mode === 'local' && readyCount ? t(`${readyCount} 件をライブラリに追加`, `Add ${readyCount} ${readyCount === 1 ? 'file' : 'files'} to library`) : t('ライブラリに追加', 'Add to library')}</Button>}
      </footer>
    </div>
  </Modal>;
}
