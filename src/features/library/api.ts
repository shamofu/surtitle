// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../shared/native/transport';
import type {
  ImportRequest,
  MediaFileValidation,
  LocalMediaImportResult,
  MediaStream,
  SubtitleVersion,
  DownloadJobSnapshot,
} from '../../shared/contracts/media';

export const libraryApi = {
  selectMediaFiles: () => call<string[]>('select_media_files'),
  validateMediaFiles: (
    paths: string[],
    learningLanguage: string,
    explanationLanguage: string,
  ) => call<MediaFileValidation[]>('validate_media_files', {
    paths, learningLanguage, explanationLanguage,
  }),
  importLocalMedia: (request: ImportRequest) =>
    call<LocalMediaImportResult>('import_local_media', { request }),
  importMedia: (request: ImportRequest) =>
    call<void>('import_media', { request }),
  startUrlImport: (request: ImportRequest) =>
    call<string>('start_url_import', { request }),
  downloadJobs: () => call<DownloadJobSnapshot[]>('list_download_jobs'),
  cancelDownload: (jobId: string) => call<void>('cancel_download', { jobId }),
  mediaStreams: (mediaId: string) =>
    call<MediaStream[]>('list_media_streams', { mediaId }),
  selectAudioStream: (mediaId: string, streamIndex: number) =>
    call<void>('select_audio_stream', { mediaId, streamIndex }),
  subtitleVersions: (mediaId: string) =>
    call<SubtitleVersion[]>('list_subtitle_versions', { mediaId }),
  restoreSubtitleVersion: (mediaId: string, versionId: string) =>
    call<void>('restore_subtitle_version', { mediaId, versionId }),
  importSubtitles: (mediaId: string, replaceExisting = false) =>
    call<void>('import_subtitles', { mediaId, replaceExisting }),
  extractEmbeddedSubtitles: (
    mediaId: string,
    streamIndex?: number,
    replaceExisting = false,
  ) =>
    call<void>('extract_embedded_subtitles', {
      mediaId,
      streamIndex,
      replaceExisting,
    }),
  removeMedia: (mediaId: string) => call<void>('remove_media', { mediaId }),
  relinkMedia: (mediaId: string) => call<void>('relink_media', { mediaId }),
};
