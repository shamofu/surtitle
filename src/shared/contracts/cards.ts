// SPDX-License-Identifier: GPL-3.0-or-later
import type { SubtitleSegment } from './media';

export interface StudyCard {
  sourceCues?: SubtitleSegment[];
  id: string;
  mediaId: string;
  segmentId: string;
  term: string;
  meaning: string;
  example: string;
  language: string;
  dueAt: string;
  createdAt: string;
  reviewCount: number;
  audioPath?: string;
  audioClipRange?: { startMs: number; endMs: number } | null;
  audioStreamIndex?: number | null;
  sourceTitle?: string;
  sourceUrl?: string | null;
  suspended: boolean;
  explanation?: string;
  translation?: string;
}

export interface VocabularyCandidate {
  sourceCueIds?: string[];
  startMs?: number;
  endMs?: number;
  id: string;
  mediaId: string;
  segmentId: string;
  term: string;
  meaning: string;
  example: string;
  explanation?: string;
  translation?: string;
}
