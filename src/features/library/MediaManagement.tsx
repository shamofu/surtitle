// SPDX-License-Identifier: GPL-3.0-or-later
import { queryKeys } from '../../shared/query/keys';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { libraryApi } from './api';
import type { Media, MediaStream } from '../../shared/contracts/media';
import { languageName } from '../../shared/format';
import {
  useDataActions,
  useAppearance,
  useNotifications,
} from '../../app/runtime';
import { Button, Field, Modal, useModalExit } from '../../shared/ui/index';
import { AnimatedDetails } from '../../shared/ui/AnimatedDetails';
import { ProgressStatus } from '../../shared/ui/ProgressStatus';
import { useActivities } from '../../app/providers/Activities';
import { MotionRegion, MotionSwap } from '../../shared/motion';
import { SelectionIndicator } from '../../shared/motion/SelectionIndicator';

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
  const { report, notify } = useNotifications();
  const { runTracked } = useActivities();
  const [mode, setMode] = useState(initialMode === 'choose' ? 'embedded' : initialMode);
  const [stream, setStream] = useState('');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const exit = useModalExit();
  const close = () => { if (!busy) void exit.close(onClose); };
  const streams = useQuery({
    queryKey: queryKeys.streams(media.id),
    queryFn: () => {
      const operationId = `local:${crypto.randomUUID()}`;
      return runTracked({ id: operationId, kind: 'inspect', label: media.title, mediaId: media.id, phase: 'inspecting' }, () => libraryApi.mediaStreams(media.id, operationId));
    },
    enabled: mode === 'embedded' && !busy,
  });
  const versions = useQuery({
    queryKey: queryKeys.versions(media.id),
    queryFn: () => libraryApi.subtitleVersions(media.id),
    enabled: mode === 'versions' && !busy,
  });
  const hasExisting = media.segmentCount > 0;
  const replace = hasExisting;
  useEffect(() => {
    if (!streams.data) return;
    const requested = streams.data.find(item => item.index === initialStreamIndex && item.kind === 'subtitle' && item.supportedText);
    const recommended = initialStreamIndex !== undefined ? requested?.index : recommendedSubtitleStream(streams.data, media.learningLanguage);
    if (recommended !== undefined) setStream(String(recommended));
  }, [streams.data, initialStreamIndex, media.learningLanguage]);
  const canSubmit =
    mode === 'transcribe' ? !!onTranscribe :
    (mode === 'file' || (mode === 'embedded' ? streams.data?.some(item => String(item.index) === stream && item.supportedText) : version !== ''));
  async function submit() {
    if (!canSubmit || busy || exit.exiting) return;
    if (mode === 'transcribe') { await exit.close(() => onTranscribe?.()); return; }
    setBusy(true);
    const operationId = `local:${crypto.randomUUID()}`;
    const success = await report(
      () => runTracked({ id: operationId, kind: 'subtitles', label: media.title, mediaId: media.id, phase: mode === 'embedded' ? 'extracting_subtitles' : mode === 'file' ? 'importing' : 'restoring' }, async () => {
        if (mode === 'embedded')
          await mutate(
            () =>
              libraryApi.extractEmbeddedSubtitles(
                media.id,
                Number(stream),
                replace,
                operationId,
              ),
            { kind: 'subtitles', mediaId: media.id },
          );
        else if (mode === 'file')
          return mutate(() => libraryApi.importSubtitles(media.id, replace), {
            kind: 'subtitles',
            mediaId: media.id,
          });
        else
          await mutate(
            () => libraryApi.restoreSubtitleVersion(media.id, version),
            { kind: 'subtitles', mediaId: media.id },
          );
        return true;
      }, { classifyResult: result => ({ status: result ? 'completed' : 'cancelled' }) }),
    );
    setBusy(false);
    if (success) {
      notify(t('字幕を更新しました。', 'Subtitles updated.'));
      await exit.close(onClose);
    }
  }
  return (
    <Modal
      {...exit.modalProps}
      title={t('字幕を追加・切り替え', 'Add or switch subtitles')}
      closeDisabled={busy || exit.exiting}
      onClose={close}
    >
      <div className="segmented-control" role="group" aria-label={t('字幕の取得方法', 'Subtitle source')}>
        <SelectionIndicator variant="pill" />
        {(
          [
            ['embedded', t('埋め込み字幕', 'Embedded')],
            ...(onTranscribe ? [['transcribe', t('全編を文字起こし', 'Transcribe full media')]] as const : []),
            ['file', t('字幕ファイル', 'Subtitle file')],
            ['versions', t('保存した字幕', 'Saved subtitles')],
          ] as const
        ).map(([id, title]) => (
          <button
            key={id}
            disabled={busy}
            className={mode === id ? 'selected' : ''}
            aria-pressed={id === 'transcribe' ? undefined : mode === id}
            onClick={() => {
              if (id === 'transcribe' && onTranscribe) { void exit.close(onTranscribe); return; }
              setMode(id);
            }}
          >
            {title}
          </button>
        ))}
      </div>
      <MotionSwap stateKey={mode}>
      {mode === 'embedded' && (
        <>
          <MotionRegion mode="status" open={streams.isLoading}>
            <ProgressStatus label={t(
                'メディアツールで字幕一覧を確認しています。初回はツールの取得が必要です。',
                'Inspecting subtitles with media tools. Tools may download on first use.',
              )} phase="inspecting" />
          </MotionRegion>
          <MotionRegion mode="status" open={!!streams.error}><p role="alert">{streams.error?.message}</p></MotionRegion>
          <MotionRegion mode="status" open={!!streams.data && initialStreamIndex !== undefined && !streams.data.some(item => item.index === initialStreamIndex && item.kind === 'subtitle' && item.supportedText)}><p className="notice warning">
            {t('再生中の字幕は学習用に読み込めません。別の字幕か全編の文字起こしを選んでください。', 'The playback captions cannot be imported for study. Choose another subtitle track or transcribe the full media.')}
          </p></MotionRegion>
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
          <MotionRegion mode="status" open={!!streams.data && !streams.data.some((item) => item.kind === 'subtitle')}>
              <p>
                {t(
                  'この作品に字幕はありません。全編の文字起こしか、字幕ファイルを利用できます。',
                  'No embedded subtitles were found. Transcribe the full media or choose a subtitle file.',
                )}
              </p>
          </MotionRegion>
          <MotionRegion mode="status" open={!!streams.data?.some(item => item.kind === 'subtitle') && !streams.data?.some(item => item.kind === 'subtitle' && item.supportedText)}><p className="notice">
            {t('画像の字幕は学習用に読み込めません。全編の文字起こしか字幕ファイルを利用してください。', 'Image captions cannot be used for study. Transcribe the full media or choose a subtitle file.')}
          </p></MotionRegion>
          <MotionRegion mode="status" open={!!streams.data}><AnimatedDetails><summary>{t('字幕の詳細', 'Subtitle details')}</summary><ul>{streams.data?.filter(item => item.kind === 'subtitle').map(item => <li key={item.index}>{item.title || item.language || t('字幕', 'Subtitle')} · {item.codec} · #{item.index}</li>)}</ul></AnimatedDetails></MotionRegion>
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
          <MotionRegion mode="status" open={!!versions.error}><p role="alert">{versions.error?.message}</p></MotionRegion>
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
          <MotionRegion mode="status" open={versions.data?.length === 0}>
            <p>{t('保存した旧版はありません。', 'No saved versions yet.')}</p>
          </MotionRegion>
        </>
      )}
      </MotionSwap>
      <MotionRegion open={hasExisting && mode !== 'transcribe'}>
        <p className="helper-text">
          <span>
            {t(
              '現在の字幕を旧版として保存し、選択した字幕へ切り替えます。',
              'Keep the current subtitles as a saved version and switch to the selected source.',
            )}
          </span>
        </p>
      </MotionRegion>
      <p className="helper-text">
        {t(
          '保存済みフレーズの文脈・音声・復習履歴は保持します。',
          'Saved phrases keep their context, audio, and review history.',
        )}
      </p>
      <MotionRegion mode="status" open={busy}><ProgressStatus label={media.title} phase={mode === 'embedded' ? 'extracting_subtitles' : mode === 'file' ? 'importing' : 'restoring'} /></MotionRegion>
      <footer className="modal-footer">
        <Button disabled={busy} onClick={close}>
          {t('キャンセル', 'Cancel')}
        </Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          <MotionSwap as="span" stateKey={mode}>{mode === 'transcribe' ? t('全編の見積もりへ', 'Estimate full transcription') : mode === 'file'
            ? t('ファイルを選ぶ', 'Choose file')
            : t('この字幕へ切り替える', 'Use these subtitles')}</MotionSwap>
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
  const exit = useModalExit();
  const close = () => { if (!busy) void exit.close(onClose); };
  async function remove() {
    if (busy || exit.exiting) return;
    setBusy(true);
    const ok = await report(async () => {
      await mutate(() => libraryApi.removeMedia(media.id), {
        kind: 'media',
        mediaId: media.id,
      });
      return true;
    });
    setBusy(false);
    if (ok) await exit.close(onRemoved);
  }
  return (
    <Modal
      {...exit.modalProps}
      title={t('ライブラリから除外', 'Remove from library')}
      closeDisabled={busy || exit.exiting}
      onClose={close}
    >
      <p>{media.title}</p>
      <p className="notice">
        {t(
          '教材と字幕をライブラリから除外します。元の動画・音声ファイルと、保存したフレーズ・音声・復習履歴は残ります。',
          'Remove this media and its subtitles from the library. Original files and saved phrases, clips, and review history remain.',
        )}
      </p>
      <footer className="modal-footer">
        <Button disabled={busy} onClick={close}>
          {t('キャンセル', 'Cancel')}
        </Button>
        <Button variant="danger" busy={busy} onClick={() => void remove()}>
          {t('ライブラリから除外する', 'Remove from library')}
        </Button>
      </footer>
    </Modal>
  );
}
