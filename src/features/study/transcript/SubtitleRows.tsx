// SPDX-License-Identifier: GPL-3.0-or-later
import { Plus, Trash2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ReviewText } from '../../../shared/contracts/transcript';
import { useAppearance } from '../../../app/runtime';
import { parseTimestamp, timestamp } from '../../../shared/format';
import { Button, Field, IconButton } from '../../../shared/ui/index';
import { MotionRegion, motionDurations, useAppMotion } from '../../../shared/motion';

export type EditRow = { uiId: string; start: string; end: string; text: string };
export const createEditRow = (value: Omit<EditRow, 'uiId'>): EditRow => ({ ...value, uiId: crypto.randomUUID() });
export const toEditRows = (segments: ReviewText[]): EditRow[] =>
  segments.map((cue) => createEditRow({
    start: timestamp(cue.startMs, true),
    end: timestamp(cue.endMs, true),
    text: cue.text,
  }));

export function validatedRows(
  rows: EditRow[],
  startMs: number,
  endMs: number,
  allowEmpty = false,
): ReviewText[] | null {
  if ((!allowEmpty && !rows.length) || rows.length > 200) return null;
  const parsed: ReviewText[] = [];
  for (const row of rows) {
    const start = parseTimestamp(row.start),
      end = parseTimestamp(row.end),
      text = row.text.trim();
    if (
      start === null ||
      end === null ||
      start < startMs ||
      end > endMs ||
      start >= end ||
      !text ||
      new TextEncoder().encode(text).length > 16000 ||
      (parsed.length && start < parsed[parsed.length - 1].startMs)
    )
      return null;
    parsed.push({ startMs: start, endMs: end, text });
  }
  return parsed;
}

export function SubtitleRows({
  rows,
  onChange,
  disabled,
  startMs,
  endMs,
}: {
  rows: EditRow[];
  onChange: (rows: EditRow[]) => void;
  disabled: boolean;
  startMs: number;
  endMs: number;
}) {
  const { t } = useAppearance();
  const { reducedMotion } = useAppMotion();
  // Retain removed rows only for their exit. Live rows keep their identity when
  // a preceding row is removed, so focus, selection and IME composition survive.
  const [retained, setRetained] = useState<{ row: EditRow; index: number; expires: number }[]>([]);
  const previous = useRef(rows);
  useLayoutEffect(() => {
    const liveIds = new Set(rows.map(row => row.uiId));
    const removed = previous.current.flatMap((row, index) => !liveIds.has(row.uiId) ? [{ row, index }] : []);
    previous.current = rows;
    if (reducedMotion) { setRetained([]); return; }
    if (removed.length) setRetained(current => [
      ...current.filter(item => !liveIds.has(item.row.uiId)),
      ...removed.map(item => ({ ...item, expires: Date.now() + (motionDurations.exit * 1000) + 100 })),
    ]);
  }, [rows, reducedMotion]);
  useLayoutEffect(() => {
    if (!retained.length) return;
    const timer = window.setTimeout(() => setRetained(items => items.filter(item => (item.expires ?? 0) > Date.now())),
      Math.max(0, Math.min(...retained.map(item => item.expires ?? 0)) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retained]);
  const liveIds = new Set(rows.map(row => row.uiId));
  const displayedRows = [...rows];
  if (!reducedMotion) {
    const outgoing = [...retained.filter(item => !liveIds.has(item.row.uiId))];
    // Include just-removed rows in this render, before the layout effect runs,
    // so React never unmounts their existing form controls during the exit.
    previous.current.forEach((row, index) => {
      if (!liveIds.has(row.uiId) && !outgoing.some(item => item.row.uiId === row.uiId)) outgoing.push({ row, index, expires: 0 });
    });
    outgoing.sort((a, b) => a.index - b.index).forEach(item => displayedRows.splice(Math.min(item.index, displayedRows.length), 0, item.row));
  }
  return (
    <div className="boundary-manual">
      {displayedRows.map(row => (
        <MotionRegion open={liveIds.has(row.uiId)} className="boundary-edit-row" key={row.uiId}>
          <Field label={t('開始', 'From')}>
            <input
              value={row.start}
              disabled={disabled}
              onChange={(event) =>
                onChange(
                  rows.map(item =>
                    item.uiId === row.uiId ? { ...item, start: event.target.value } : item,
                  ),
                )
              }
            />
          </Field>
          <Field label={t('終了', 'To')}>
            <input
              value={row.end}
              disabled={disabled}
              onChange={(event) =>
                onChange(
                  rows.map(item =>
                    item.uiId === row.uiId ? { ...item, end: event.target.value } : item,
                  ),
                )
              }
            />
          </Field>
          <Field label={t('本文', 'Text')}>
            <textarea
              value={row.text}
              disabled={disabled}
              maxLength={16000}
              onChange={(event) =>
                onChange(
                  rows.map(item =>
                    item.uiId === row.uiId ? { ...item, text: event.target.value } : item,
                  ),
                )
              }
            />
          </Field>
          <IconButton
            label={t('行を削除', 'Remove row')}
            disabled={disabled}
            onClick={() => onChange(rows.filter(item => item.uiId !== row.uiId))}
          >
            <Trash2 size={14} />
          </IconButton>
        </MotionRegion>
      ))}
      <Button
        disabled={disabled || rows.length >= 200}
        onClick={() =>
          onChange([
            ...rows,
            createEditRow({
              start: timestamp(startMs, true),
              end: timestamp(endMs, true),
              text: '',
            }),
          ])
        }
      >
        <Plus size={14} />
        {t('行を追加', 'Add row')}
      </Button>
    </div>
  );
}
