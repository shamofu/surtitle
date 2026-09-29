// SPDX-License-Identifier: GPL-3.0-or-later
export interface RestorePreview {
  token: string;
  mediaCount: number;
  cardCount: number;
  reviewCount: number;
  audioCount: number;
  warnings: string[];
}

export type ExportFormat = 'json' | 'csv' | 'tsv' | 'srt' | 'vtt' | 'zip';
