// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MotionProvider } from '../shared/motion';
import { SubtitleRows, toEditRows, validatedRows } from '../features/study/transcript/SubtitleRows';

vi.mock('../app/runtime', () => ({ useAppearance: () => ({ t: (_ja: string, en: string) => en }) }));

const source = [
  { startMs: 0, endMs: 1000, text: 'Earlier line' },
  { startMs: 1000, endMs: 2000, text: 'Editing this line' },
];
const animationDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
function Editor({ reduced = false }: { reduced?: boolean }) {
  const [rows, setRows] = useState(() => toEditRows(source));
  return <MotionProvider preference={reduced ? 'reduce' : 'system'}>
    <SubtitleRows rows={rows} onChange={setRows} disabled={false} startMs={0} endMs={3000} />
  </MotionProvider>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn(() => ({
    finished: new Promise(() => {}), cancel: vi.fn(),
  } as unknown as Animation)) });
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (animationDescriptor) Object.defineProperty(HTMLElement.prototype, 'animate', animationDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
});

it('keeps the surviving textarea, focus, selection and composition when an earlier row is removed', () => {
  render(<Editor />);
  const field = screen.getByDisplayValue('Editing this line') as HTMLTextAreaElement;
  field.focus();
  field.setSelectionRange(3, 9);
  fireEvent.compositionStart(field);
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove row' })[0]);
  expect(screen.getByDisplayValue('Editing this line')).toBe(field);
  expect(field).toHaveFocus();
  expect([field.selectionStart, field.selectionEnd]).toEqual([3, 9]);
  expect(screen.getByDisplayValue('Earlier line').closest('.motion-region')).toHaveAttribute('inert');
  expect(screen.getAllByRole('button', { name: 'Remove row' })).toHaveLength(1);
  fireEvent.compositionEnd(field, { data: '編集中' });
  fireEvent.change(field, { target: { value: '編集中の字幕' } });
  act(() => vi.advanceTimersByTime(321));
  expect(screen.queryByDisplayValue('Earlier line')).not.toBeInTheDocument();
  expect(screen.getByDisplayValue('編集中の字幕')).toBe(field);
});

it('keeps new row identities while deletions exit and drops retained rows when motion is reduced', () => {
  const view = render(<Editor />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove row' })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
  const fields = screen.getAllByRole('textbox', { name: 'Text' });
  const added = fields[1];
  fireEvent.change(added, { target: { value: 'New line' } });
  view.rerender(<Editor reduced />);
  expect(screen.queryByDisplayValue('Earlier line')).not.toBeInTheDocument();
  expect(screen.getByDisplayValue('New line')).toBe(added);
});

it('generates distinct UI identities and excludes them from serialized subtitle data', () => {
  const rows = toEditRows(source);
  expect(rows[0].uiId).not.toBe(rows[1].uiId);
  expect(validatedRows(rows, 0, 3000)).toEqual(source);
  expect(JSON.stringify(validatedRows(rows, 0, 3000))).not.toContain('uiId');
});
