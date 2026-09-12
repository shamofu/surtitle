// SPDX-License-Identifier: GPL-3.0-or-later
import type { StudyCard, SubtitleSegment } from './api';

export function timestamp(ms: number, precise = false): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const base = hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  const fraction = Math.max(0, Math.round(ms)) % 1000;
  return precise && fraction ? `${base}.${String(fraction).padStart(3, '0')}` : base;
}
export function parseTimestamp(value: string): number | null {
  if (!/^\d+(?::[0-5]?\d){0,2}(?:\.\d{1,3})?$/.test(value.trim())) return null;
  const result = Math.round(value.trim().split(':').reduce((total, part) => total * 60 + Number(part), 0) * 1000);
  return Number.isSafeInteger(result) ? result : null;
}
export const money = (value: number | null | undefined) => value == null ? '—' : `$${Number.isFinite(value) ? value.toFixed(value > 0 && value < 0.01 ? 4 : 2) : '—'}`;
export const languageName = (code: string, locale = 'ja') => {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(code) || code; }
  catch { return code; }
};
export const dueCards = (cards: StudyCard[], now = Date.now()) => cards.filter(card => !card.suspended && new Date(card.dueAt).getTime() <= now);
export function activeSegment(segments: SubtitleSegment[], positionMs: number): string | undefined {
  return segments.find(segment => segment.startMs <= positionMs && positionMs < segment.endMs)?.id;
}
export function quoteCanBeApproved(quote: { canApprove: boolean; expiresAt: string }, acknowledged: boolean, now = Date.now()): boolean {
  return acknowledged && quote.canApprove && new Date(quote.expiresAt).getTime() > now;
}
