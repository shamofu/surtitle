// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '../../shared/native/transport';
import type { ImportRequest } from '../../shared/contracts/media';

export const libraryApi = {
  selectMediaFiles: () => call('select_media_files'),
  validateMediaFiles: (
    paths: string[],
    learningLanguage: string,
    explanationLanguage: string,
  ) => call('validate_media_files', {
    paths, learningLanguage, explanationLanguage,
  }),
  importLocalMedia: (request: ImportRequest) =>
    call('import_local_media', { request }),
  importMedia: (request: ImportRequest) =>
    call('import_media', { request }),
  startUrlImport: (request: ImportRequest) =>
    call('start_url_import', { request }),
  downloadJobs: () => call('list_download_jobs'),
  cancelDownload: (jobId: string) => call('cancel_download', { jobId }),
  mediaStreams: (mediaId: string, operationId?: string) =>
    call('list_media_streams', { mediaId, operationId }),
  selectAudioStream: (mediaId: string, streamIndex: number, operationId?: string) =>
    call('select_audio_stream', { mediaId, streamIndex, operationId }),
  subtitleVersions: (mediaId: string) =>
    call('list_subtitle_versions', { mediaId }),
  restoreSubtitleVersion: (mediaId: string, versionId: string) =>
    call('restore_subtitle_version', { mediaId, versionId }),
  importSubtitles: (mediaId: string, replaceExisting = false) =>
    call('import_subtitles', { mediaId, replaceExisting }),
  extractEmbeddedSubtitles: (
    mediaId: string,
    streamIndex: number,
    replaceExisting = false,
    operationId?: string,
  ) =>
    call('extract_embedded_subtitles', {
      mediaId,
      streamIndex,
      replaceExisting,
      operationId,
    }),
  removeMedia: (mediaId: string) => call('remove_media', { mediaId }),
  relinkMedia: (mediaId: string) => call('relink_media', { mediaId }),
};
