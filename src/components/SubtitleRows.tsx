// SPDX-License-Identifier: GPL-3.0-or-later
import { Plus, Trash2 } from 'lucide-react';
import type { ReviewText } from '../api';
import { useApp } from '../context';
import { parseTimestamp, timestamp } from '../utils';
import { Button, Field, IconButton } from './ui';

export type EditRow = { start: string; end: string; text: string };
export const toEditRows = (segments: ReviewText[]): EditRow[] => segments.map(cue => ({ start: timestamp(cue.startMs, true), end: timestamp(cue.endMs, true), text: cue.text }));

export function validatedRows(rows: EditRow[], startMs: number, endMs: number, allowEmpty = false): ReviewText[] | null {
  if ((!allowEmpty && !rows.length) || rows.length > 200) return null;
  const parsed: ReviewText[] = [];
  for (const row of rows) {
    const start = parseTimestamp(row.start), end = parseTimestamp(row.end), text = row.text.trim();
    if (start === null || end === null || start < startMs || end > endMs || start >= end || !text || new TextEncoder().encode(text).length > 16000 || (parsed.length && start < parsed[parsed.length - 1].startMs)) return null;
    parsed.push({ startMs: start, endMs: end, text });
  }
  return parsed;
}

export function SubtitleRows({ rows, onChange, disabled, startMs, endMs }: {
  rows: EditRow[]; onChange: (rows: EditRow[]) => void; disabled: boolean; startMs: number; endMs: number;
}) {
  const { t } = useApp();
  return <div className="boundary-manual">{rows.map((row, index) => <div className="boundary-edit-row" key={index}>
    <Field label={t('開始', 'From')}><input value={row.start} disabled={disabled} onChange={event => onChange(rows.map((item, i) => i === index ? { ...item, start: event.target.value } : item))} /></Field>
    <Field label={t('終了', 'To')}><input value={row.end} disabled={disabled} onChange={event => onChange(rows.map((item, i) => i === index ? { ...item, end: event.target.value } : item))} /></Field>
    <Field label={t('本文', 'Text')}><textarea value={row.text} disabled={disabled} maxLength={16000} onChange={event => onChange(rows.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} /></Field>
    <IconButton label={t('行を削除', 'Remove row')} disabled={disabled} onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2 size={14} /></IconButton>
  </div>)}<Button disabled={disabled || rows.length >= 200} onClick={() => onChange([...rows, { start: timestamp(startMs, true), end: timestamp(endMs, true), text: '' }])}><Plus size={14} />{t('行を追加', 'Add row')}</Button></div>;
}
