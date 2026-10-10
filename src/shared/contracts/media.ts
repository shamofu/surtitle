// SPDX-License-Identifier: GPL-3.0-or-later
export interface Media {
  id: string;
  title: string;
  path: string;
  sourceUrl?: string;
  kind: 'video' | 'audio';
  durationMs: number;
  learningLanguage: string;
  explanationLanguage: string;
  createdAt: string;
  lastPositionMs: number;
  segmentCount: number;
  cardCount: number;
  status: 'ready' | 'importing' | 'missing' | 'error';
  error?: string;
  audioStreamIndex?: number | null;
  subtitleStreamIndex?: number | null;
}

export interface SubtitleSegment {
  id: string;
  mediaId: string;
  startMs: number;
  endMs: number;
  text: string;
  translation?: string;
  timingPrecision?: 'cue' | 'source_block';
  status?: 'confirmed' | 'generated' | 'generated_review' | 'provisional' | 'review';
  reviewIssues?: { id: string; kind: string; startMs: number; endMs: number; alternatives: { startMs: number; endMs: number; text: string }[] }[];
}

export interface TranscriptIssueRecord {
  id: string;
  mediaId: string;
  sourceId: string;
  kind: string;
  startMs: number;
  endMs: number;
  alternatives: { startMs: number; endMs: number; text: string }[];
}

export function subtitleUsable(segment: Pick<SubtitleSegment, 'status'>): boolean {
  return !segment.status || ['confirmed', 'generated', 'generated_review'].includes(segment.status);
}

export interface ImportRequest {
  kind: 'local' | 'url';
  pathOrUrl: string;
  title?: string;
  learningLanguage: string;
  explanationLanguage: string;
}

export type MediaFileValidationReason =
  | 'invalidPath'
  | 'missing'
  | 'directory'
  | 'empty'
  | 'unsupported'
  | 'unreadable';

export type MediaFileValidation =
  | { inputPath: string; status: 'ready'; canonicalPath: string }
  | {
      inputPath: string;
      status: 'existing';
      canonicalPath: string;
      mediaId: string;
    }
  | { inputPath: string; status: 'invalid'; reason: MediaFileValidationReason };

export interface LocalMediaImportResult {
  mediaId: string;
  created: boolean;
}

export interface MediaStream {
  index: number;
  kind: string;
  codec: string;
  language?: string;
  title?: string;
  isDefault: boolean;
  supportedText: boolean;
}

export interface SubtitleVersion {
  id: string;
  mediaId: string;
  createdAt: string;
  label: string;
  streamIndex?: number;
  segments: SubtitleSegment[];
}

export interface DownloadJobSnapshot {
  id: string;
  request: ImportRequest;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  phase: string;
  storedBytes: number;
  totalBytes?: number;
  totalBytesExact?: boolean;
  mediaId?: string;
  error?: string;
  updatedAt: string;
  toolReceiptId?: string;
}
