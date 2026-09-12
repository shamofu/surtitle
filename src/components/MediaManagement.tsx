// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, nativeAvailable } from '../api';
import type { Media } from '../api';
import { useApp } from '../context';
import { Button, Field, Modal } from './ui';

export function DownloadJobs() {
  const { t, run } = useApp();
  const query = useQuery({ queryKey: ['download-jobs'], queryFn: api.downloadJobs, enabled: nativeAvailable(), refetchInterval: 1000 });
  const [busyId, setBusyId] = useState<string>();
  async function perform(id: string, action: () => Promise<unknown>) { setBusyId(id); await run(action); setBusyId(undefined); }
  if (!query.data?.length && !query.error) return null;
  const phases: Record<string, string> = { preparing: t('準備中', 'Preparing'), preparing_tools: t('メディアツールを準備中', 'Preparing media tools'), inspecting: t('動画情報を確認中', 'Inspecting video'), connecting: t('接続中', 'Connecting'), downloading: t('ダウンロード中', 'Downloading'), importing: t('ライブラリへ登録中', 'Adding to library'), completed: t('完了', 'Completed') };
  const statuses: Record<string, string> = { failed: t('失敗', 'Failed'), cancelled: t('キャンセル済み', 'Cancelled'), interrupted: t('中断', 'Interrupted') };
  return <section className="download-jobs" aria-label={t('ダウンロード', 'Downloads')}>
    <h2>{t('ダウンロード', 'Downloads')}</h2>
    {query.error && <p role="alert">{query.error.message}</p>}
    {query.data?.slice(0, 10).map(job => <article key={job.id} className="download-job" data-download-id={job.id}>
      <div><strong>{job.request.title || job.request.pathOrUrl}</strong><p role="status">{statuses[job.status] || phases[job.phase] || t('処理中', 'Working')}{job.storedBytes > 0 && <> · {job.status === 'running' || job.status === 'completed' ? t('保存中の容量', 'Stored size') : t('削除前の保存容量', 'Size before cleanup')} {(job.storedBytes / 1024 / 1024).toFixed(1)} MiB</>}</p>{job.error && <details><summary>{t('詳細', 'Details')}</summary><p>{job.error}</p></details>}</div>
      {job.status === 'running' ? <><progress aria-label={t('ダウンロード中', 'Downloading')} /><Button busy={busyId === job.id} onClick={() => void perform(job.id, () => api.cancelDownload(job.id))}>{t('中止', 'Cancel download')}</Button></> : job.mediaId ? <Link to="/study/$mediaId" params={{ mediaId: job.mediaId }} className="button">{t('教材を開く', 'Open media')}</Link> : <Button busy={busyId === job.id} onClick={() => void perform(job.id, () => api.startUrlImport(job.request))}>{t('最初から再試行', 'Retry from start')}</Button>}
    </article>)}
  </section>;
}

export function SubtitleSourceDialog({ media, initialMode, onClose }: { media: Media; initialMode: 'embedded' | 'file' | 'versions'; onClose: () => void }) {
  const { t, run } = useApp();
  const [mode, setMode] = useState(initialMode);
  const [stream, setStream] = useState('');
  const [version, setVersion] = useState('');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const streams = useQuery({ queryKey: ['media-streams', media.id], queryFn: () => api.mediaStreams(media.id), enabled: mode === 'embedded' && !busy });
  const versions = useQuery({ queryKey: ['subtitle-versions', media.id], queryFn: () => api.subtitleVersions(media.id), enabled: mode === 'versions' && !busy });
  const hasExisting = media.segmentCount > 0;
  const canSubmit = (!hasExisting || replace) && (mode === 'file' || (mode === 'embedded' ? stream !== '' : version !== ''));
  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    const success = await run(async () => {
      if (mode === 'embedded') await api.extractEmbeddedSubtitles(media.id, Number(stream), replace);
      else if (mode === 'file') await api.importSubtitles(media.id, replace);
      else await api.restoreSubtitleVersion(media.id, version);
      return true;
    }, t('字幕を更新しました。', 'Subtitles updated.'));
    setBusy(false); if (success) onClose();
  }
  return <Modal title={t('学習する字幕を選ぶ', 'Choose your study subtitles')} onClose={() => { if (!busy) onClose(); }}>
    <div className="segmented-control">{([['embedded', t('埋め込み字幕', 'Embedded')], ['file', t('字幕ファイル', 'Subtitle file')], ['versions', t('保存した旧版', 'Saved versions')]] as const).map(([id, title]) => <button key={id} disabled={busy} className={mode === id ? 'selected' : ''} onClick={() => { setMode(id); setReplace(false); }}>{title}</button>)}</div>
    {mode === 'embedded' && <>{streams.isLoading && <p role="status">{t('メディアツールで字幕一覧を確認しています。初回はツールの取得が必要です。', 'Inspecting subtitles with media tools. Tools may download on first use.')}</p>}{streams.error && <p role="alert">{streams.error.message}</p>}<Field label={t('抽出する字幕', 'Subtitle to extract')}><select value={stream} onChange={event => setStream(event.target.value)} disabled={busy || streams.isLoading}><option value="">{t('選択してください', 'Choose a subtitle')}</option>{streams.data?.filter(item => item.kind === 'subtitle').map(item => <option key={item.index} value={item.index} disabled={!item.supportedText}>{item.title || item.language || t('字幕', 'Subtitle')} · {item.codec} · #{item.index}{!item.supportedText ? t('（画像字幕・非対応）', ' (image subtitles; unsupported)') : ''}</option>)}</select></Field>{streams.data && !streams.data.some(item => item.kind === 'subtitle') && <p>{t('埋め込み字幕はありません。字幕ファイルを選択できます。', 'No embedded subtitles were found. You can choose a subtitle file.')}</p>}</>}
    {mode === 'file' && <p>{t('SRT または WebVTT ファイルを選択します。', 'Choose an SRT or WebVTT file.')}</p>}
    {mode === 'versions' && <>{versions.error && <p role="alert">{versions.error.message}</p>}<Field label={t('復帰する旧版', 'Version to restore')}><select value={version} onChange={event => setVersion(event.target.value)} disabled={busy || versions.isLoading}><option value="">{t('旧版を選択', 'Choose a saved version')}</option>{versions.data?.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.segments.length} {t('字幕', 'subtitles')}</option>)}</select></Field>{versions.data?.length === 0 && <p>{t('保存した旧版はありません。', 'No saved versions yet.')}</p>}</>}
    {hasExisting && <label className="check-field"><input type="checkbox" checked={replace} disabled={busy} onChange={event => setReplace(event.target.checked)} /><span>{t('現在の字幕を旧版として保存し、選択した字幕へ切り替えます。', 'Keep the current subtitles as a saved version and switch to the selected source.')}</span></label>}
    <p className="helper-text">{t('保存済みフレーズの文脈・音声・復習履歴は保持します。', 'Saved phrases keep their context, audio, and review history.')}</p>
    <footer className="modal-footer"><Button disabled={busy} onClick={onClose}>{t('キャンセル', 'Cancel')}</Button><Button variant="primary" busy={busy} disabled={!canSubmit} onClick={() => void submit()}>{mode === 'file' ? t('ファイルを選ぶ', 'Choose file') : t('この字幕へ切り替える', 'Use these subtitles')}</Button></footer>
  </Modal>;
}

export function RemoveMediaDialog({ media, onClose, onRemoved }: { media: Media; onClose: () => void; onRemoved: () => void }) {
  const { t, run } = useApp(); const [busy, setBusy] = useState(false);
  async function remove() { setBusy(true); const ok = await run(async () => { await api.removeMedia(media.id); return true; }); setBusy(false); if (ok) onRemoved(); }
  return <Modal title={t('ライブラリから除外', 'Remove from library')} onClose={() => { if (!busy) onClose(); }}><p>{media.title}</p><p className="notice">{t('教材と字幕をライブラリから除外します。元の動画・音声ファイルと、保存したフレーズ・音声・復習履歴は残ります。', 'Remove this media and its subtitles from the library. Original files and saved phrases, clips, and review history remain.')}</p><footer className="modal-footer"><Button disabled={busy} onClick={onClose}>{t('キャンセル', 'Cancel')}</Button><Button variant="danger" busy={busy} onClick={() => void remove()}>{t('ライブラリから除外する', 'Remove from library')}</Button></footer></Modal>;
}
