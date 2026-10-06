// SPDX-License-Identifier: GPL-3.0-or-later
import { queryKeys } from '../../shared/query/keys';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { libraryApi } from './api';
import { nativeAvailable } from '../../shared/native/transport';
import type { Media, MediaStream } from '../../shared/contracts/media';
import { languageName } from '../../shared/format';
import {
  useDataActions,
  useAppearance,
  useNotifications,
} from '../../app/runtime';
import { Button, Field, Modal } from '../../shared/ui/index';

export function DownloadJobs() {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const query = useQuery({
    queryKey: queryKeys.downloads,
    queryFn: libraryApi.downloadJobs,
    enabled: nativeAvailable(),
    refetchInterval: 1000,
  });
  const [busyId, setBusyId] = useState<string>();
  async function perform(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    await report(action);
    setBusyId(undefined);
  }
  if (!query.data?.length && !query.error) return null;
  const phases: Record<string, string> = {
    preparing: t('準備中', 'Preparing'),
    preparing_tools: t('メディアツールを準備中', 'Preparing media tools'),
    inspecting: t('動画情報を確認中', 'Inspecting video'),
    connecting: t('接続中', 'Connecting'),
    downloading: t('ダウンロード中', 'Downloading'),
    importing: t('ライブラリへ登録中', 'Adding to library'),
    completed: t('完了', 'Completed'),
  };
  const statuses: Record<string, string> = {
    failed: t('失敗', 'Failed'),
    cancelled: t('キャンセル済み', 'Cancelled'),
    interrupted: t('中断', 'Interrupted'),
  };
  return (
    <section
      className="download-jobs"
      aria-label={t('ダウンロード', 'Downloads')}
    >
      <h2>{t('ダウンロード', 'Downloads')}</h2>
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data?.slice(0, 10).map((job) => (
        <article
          key={job.id}
          className="download-job"
          data-download-id={job.id}
        >
          <div>
            <strong>{job.request.title || job.request.pathOrUrl}</strong>
            <p role="status">
              {statuses[job.status] ||
                phases[job.phase] ||
                t('処理中', 'Working')}
              {job.storedBytes > 0 && (
                <>
                  {' '}
                  ·{' '}
                  {job.status === 'running' || job.status === 'completed'
                    ? t('保存中の容量', 'Stored size')
                    : t('削除前の保存容量', 'Size before cleanup')}{' '}
                  {(job.storedBytes / 1024 / 1024).toFixed(1)} MiB
                </>
              )}
            </p>
            {job.error && (
              <details>
                <summary>{t('詳細', 'Details')}</summary>
                <p>{job.error}</p>
              </details>
            )}
          </div>
          {job.status === 'running' ? (
            <>
              <progress aria-label={t('ダウンロード中', 'Downloading')} />
              <Button
                busy={busyId === job.id}
                onClick={() =>
                  void perform(job.id, () =>
                    mutate(() => libraryApi.cancelDownload(job.id), {
                      kind: 'downloads',
                    }),
                  )
                }
              >
                {t('中止', 'Cancel download')}
              </Button>
            </>
          ) : job.mediaId ? (
            <Link
              to="/study/$mediaId"
              params={{ mediaId: job.mediaId }}
              className="button"
            >
              {t('教材を開く', 'Open media')}
            </Link>
          ) : (
            <Button
              busy={busyId === job.id}
              onClick={() =>
                void perform(job.id, () =>
                  mutate(() => libraryApi.startUrlImport(job.request), {
                    kind: 'downloads',
                  }),
                )
              }
            >
              {t('最初から再試行', 'Retry from start')}
            </Button>
          )}
        </article>
      ))}
    </section>
  );
}

export function recommendedSubtitleStream(streams: MediaStream[], learningLanguage: string) {
  const normalize = (value: string) => {
    try { return new Intl.Locale(value.trim().replaceAll('_', '-')).language; }
    catch { return value.toLowerCase(); }
  };
  const matches = streams.filter(item => item.kind === 'subtitle' && item.supportedText &&
    item.language && normalize(item.language) === normalize(learningLanguage));
  return matches.length === 1 ? matches[0].index : undefined;
}

export function SubtitleSourceDialog({
  media,
  initialMode = 'choose',
  initialStreamIndex,
  onTranscribe,
  onClose,
}: {
  media: Media;
  initialMode?: 'choose' | 'embedded' | 'file' | 'versions' | 'transcribe';
  initialStreamIndex?: number;
  onTranscribe?: () => void;
  onClose: () => void;
}) {
  const { mutate } = useDataActions();
  const { t, locale } = useAppearance();
  const { report } = useNotifications();
  const [mode, setMode] = useState(initialMode === 'choose' ? 'embedded' : initialMode);
  const [stream, setStream] = useState('');
  const [version, setVersion] = useState('');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const streams = useQuery({
    queryKey: queryKeys.streams(media.id),
    queryFn: () => libraryApi.mediaStreams(media.id),
    enabled: mode === 'embedded' && !busy,
  });
  const versions = useQuery({
    queryKey: queryKeys.versions(media.id),
    queryFn: () => libraryApi.subtitleVersions(media.id),
    enabled: mode === 'versions' && !busy,
  });
  const hasExisting = media.segmentCount > 0;
  useEffect(() => {
    if (!streams.data) return;
    const requested = streams.data.find(item => item.index === initialStreamIndex && item.kind === 'subtitle' && item.supportedText);
    const recommended = initialStreamIndex !== undefined ? requested?.index : recommendedSubtitleStream(streams.data, media.learningLanguage);
    if (recommended !== undefined) setStream(String(recommended));
  }, [streams.data, initialStreamIndex, media.learningLanguage]);
  const canSubmit =
    mode === 'transcribe' ? !!onTranscribe : (!hasExisting || replace) &&
    (mode === 'file' || (mode === 'embedded' ? streams.data?.some(item => String(item.index) === stream && item.supportedText) : version !== ''));
  async function submit() {
    if (!canSubmit) return;
    if (mode === 'transcribe') { onTranscribe?.(); return; }
    setBusy(true);
    const success = await report(
      async () => {
        if (mode === 'embedded')
          await mutate(
            () =>
              libraryApi.extractEmbeddedSubtitles(
                media.id,
                Number(stream),
                replace,
              ),
            { kind: 'subtitles', mediaId: media.id },
          );
        else if (mode === 'file')
          await mutate(() => libraryApi.importSubtitles(media.id, replace), {
            kind: 'subtitles',
            mediaId: media.id,
          });
        else
          await mutate(
            () => libraryApi.restoreSubtitleVersion(media.id, version),
            { kind: 'subtitles', mediaId: media.id },
          );
        return true;
      },
      t('字幕を更新しました。', 'Subtitles updated.'),
    );
    setBusy(false);
    if (success) onClose();
  }
  return (
    <Modal
      title={t('字幕を用意する', 'Set up study subtitles')}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="segmented-control">
        {(
          [
            ['embedded', t('埋め込み字幕', 'Embedded')],
            ...(onTranscribe ? [['transcribe', t('全編を文字起こし', 'Transcribe full media')]] as const : []),
            ['file', t('字幕ファイル', 'Subtitle file')],
            ['versions', t('保存した旧版', 'Saved versions')],
          ] as const
        ).map(([id, title]) => (
          <button
            key={id}
            disabled={busy}
            className={mode === id ? 'selected' : ''}
            onClick={() => {
              setMode(id);
              setReplace(false);
            }}
          >
            {title}
          </button>
        ))}
      </div>
      {mode === 'embedded' && (
        <>
          {streams.isLoading && (
            <p role="status">
              {t(
                'メディアツールで字幕一覧を確認しています。初回はツールの取得が必要です。',
                'Inspecting subtitles with media tools. Tools may download on first use.',
              )}
            </p>
          )}
          {streams.error && <p role="alert">{streams.error.message}</p>}
          {streams.data && initialStreamIndex !== undefined && !streams.data.some(item => item.index === initialStreamIndex && item.kind === 'subtitle' && item.supportedText) && <p className="notice warning">
            {t('再生中の字幕は学習用に読み込めません。別の字幕か全編の文字起こしを選んでください。', 'The playback captions cannot be imported for study. Choose another subtitle track or transcribe the full media.')}
          </p>}
          <Field label={t('抽出する字幕', 'Subtitle to extract')}>
            <select
              value={stream}
              onChange={(event) => setStream(event.target.value)}
              disabled={busy || streams.isLoading}
            >
              <option value="">
                {t('選択してください', 'Choose a subtitle')}
              </option>
              {streams.data
                ?.filter((item) => item.kind === 'subtitle')
                .map((item) => (
                  <option
                    key={item.index}
                    value={item.index}
                    disabled={!item.supportedText}
                  >
                    {item.title || (item.language ? languageName(item.language, locale || 'en') : t('字幕', 'Subtitle'))}
                    {item.language && item.title ? ` · ${languageName(item.language, locale || 'en')}` : ''}
                    {!item.supportedText
                      ? t(
                          '（画像字幕・非対応）',
                          ' (image subtitles; unsupported)',
                        )
                      : ''}
                  </option>
                ))}
            </select>
          </Field>
          {streams.data &&
            !streams.data.some((item) => item.kind === 'subtitle') && (
              <p>
                {t(
                  'この作品に字幕はありません。全編の文字起こしか、字幕ファイルを利用できます。',
                  'No embedded subtitles were found. Transcribe the full media or choose a subtitle file.',
                )}
              </p>
            )}
          {streams.data?.some(item => item.kind === 'subtitle') && !streams.data.some(item => item.kind === 'subtitle' && item.supportedText) && <p className="notice">
            {t('画像の字幕は学習用に読み込めません。全編の文字起こしか字幕ファイルを利用してください。', 'Image captions cannot be used for study. Transcribe the full media or choose a subtitle file.')}
          </p>}
          {streams.data && <details><summary>{t('字幕の詳細', 'Subtitle details')}</summary><ul>{streams.data.filter(item => item.kind === 'subtitle').map(item => <li key={item.index}>{item.title || item.language || t('字幕', 'Subtitle')} · {item.codec} · #{item.index}</li>)}</ul></details>}
        </>
      )}
      {mode === 'transcribe' && <p>{t('動画・音声の全編から字幕を作成します。全体の見積もりを一度承認すると、最後まで自動で処理します。', 'Create subtitles for the entire video or recording. Review one estimate, then processing continues to the end automatically.')}</p>}
      {mode === 'file' && (
        <p>
          {t(
            'SRT または WebVTT ファイルを選択します。',
            'Choose an SRT or WebVTT file.',
          )}
        </p>
      )}
      {mode === 'versions' && (
        <>
          {versions.error && <p role="alert">{versions.error.message}</p>}
          <Field label={t('復帰する旧版', 'Version to restore')}>
            <select
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              disabled={busy || versions.isLoading}
            >
              <option value="">
                {t('旧版を選択', 'Choose a saved version')}
              </option>
              {versions.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {new Date(item.createdAt).toLocaleString()} ·{' '}
                  {item.segments.length} {t('字幕', 'subtitles')}
                </option>
              ))}
            </select>
          </Field>
          {versions.data?.length === 0 && (
            <p>{t('保存した旧版はありません。', 'No saved versions yet.')}</p>
          )}
        </>
      )}
      {hasExisting && mode !== 'transcribe' && (
        <label className="check-field">
          <input
            type="checkbox"
            checked={replace}
            disabled={busy}
            onChange={(event) => setReplace(event.target.checked)}
          />
          <span>
            {t(
              '現在の字幕を旧版として保存し、選択した字幕へ切り替えます。',
              'Keep the current subtitles as a saved version and switch to the selected source.',
            )}
          </span>
        </label>
      )}
      <p className="helper-text">
        {t(
          '保存済みフレーズの文脈・音声・復習履歴は保持します。',
          'Saved phrases keep their context, audio, and review history.',
        )}
      </p>
      <footer className="modal-footer">
        <Button disabled={busy} onClick={onClose}>
          {t('キャンセル', 'Cancel')}
        </Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {mode === 'transcribe' ? t('全編の見積もりへ', 'Estimate full transcription') : mode === 'file'
            ? t('ファイルを選ぶ', 'Choose file')
            : t('この字幕へ切り替える', 'Use these subtitles')}
        </Button>
      </footer>
    </Modal>
  );
}

export function RemoveMediaDialog({
  media,
  onClose,
  onRemoved,
}: {
  media: Media;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { mutate } = useDataActions();
  const { t } = useAppearance();
  const { report } = useNotifications();
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    const ok = await report(async () => {
      await mutate(() => libraryApi.removeMedia(media.id), {
        kind: 'media',
        mediaId: media.id,
      });
      return true;
    });
    setBusy(false);
    if (ok) onRemoved();
  }
  return (
    <Modal
      title={t('ライブラリから除外', 'Remove from library')}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>{media.title}</p>
      <p className="notice">
        {t(
          '教材と字幕をライブラリから除外します。元の動画・音声ファイルと、保存したフレーズ・音声・復習履歴は残ります。',
          'Remove this media and its subtitles from the library. Original files and saved phrases, clips, and review history remain.',
        )}
      </p>
      <footer className="modal-footer">
        <Button disabled={busy} onClick={onClose}>
          {t('キャンセル', 'Cancel')}
        </Button>
        <Button variant="danger" busy={busy} onClick={() => void remove()}>
          {t('ライブラリから除外する', 'Remove from library')}
        </Button>
      </footer>
    </Modal>
  );
}
