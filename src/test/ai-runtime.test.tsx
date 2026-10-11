// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AiRuntimeView } from '../features/ai/AiRuntime';
import { createAiRuntimeStore } from '../features/ai/runtime-store';
import { previewFields } from '../features/ai/preview-fields';
import type { AiRuntimeSnapshot, JobSummary } from '../shared/contracts/ai';

vi.mock('../app/runtime', () => ({ useAppearance: () => ({ t: (_ja: string, en: string) => en }) }));
afterEach(cleanup);
const job: JobSummary = { id: 'job', kind: 'vocabulary', status: 'running', progress: 0, createdAt: '' };
const snapshot: AiRuntimeSnapshot = { jobId: 'job', approvalId: 'approval', revision: 5,
  events: ['preparing', 'sending', 'receiving', 'validating'].map((phase, index) => ({ id: String(index), phase, ordinal: 0, timestamp: `2026-10-11T01:00:0${index}Z` })),
  preview: { attemptId: 'attempt', ordinal: 0, text: '{"items":[{"term":"look forward to","meaning":"楽しみにする","explanation":"Used when', state: 'streaming' },
};

it('shows the newest three actual phases and exposes the full timestamped history on expansion', () => {
  render(<AiRuntimeView job={job} snapshot={snapshot} />);
  const recent = within(screen.getByRole('list', { name: 'Recent progress' }));
  expect(recent.getAllByRole('listitem')).toHaveLength(3);
  expect(recent.queryByText('Request 1 · Preparing request')).not.toBeInTheDocument();
  expect(recent.getByText('Request 1 · Receiving response')).toBeVisible();
  expect(screen.getByText('Request 1 · Preparing request')).not.toBeVisible();
  fireEvent.click(screen.getByText('Progress history'));
  expect(screen.getByText('Request 1 · Preparing request')).toBeVisible();
  expect(document.querySelectorAll('time')).toHaveLength(4);
  expect(document.querySelector('time')).toHaveAttribute('dateTime', snapshot.events[0].timestamp);
});

it('renders readable provisional fields without save/apply controls or provider JSON', () => {
  const { rerender } = render(<AiRuntimeView job={job} snapshot={snapshot} />);
  const preview = screen.getByRole('region', { name: 'Generation preview' });
  expect(preview).toHaveTextContent('Generating · provisional');
  expect(within(preview).getByText('look forward to')).toBeVisible();
  expect(within(preview).getByText('楽しみにする')).toBeVisible();
  expect(within(preview).getByText('Used when')).toBeVisible();
  expect(within(preview).queryByRole('button')).not.toBeInTheDocument();
  expect(preview.textContent).not.toContain('{"items"');
  rerender(<AiRuntimeView job={job} snapshot={{ ...snapshot, preview: { ...snapshot.preview!, state: 'rejected' } }} />);
  expect(preview).toHaveTextContent('Unusable response');
  expect(preview).toHaveTextContent('cannot be saved or applied');
  rerender(<AiRuntimeView job={{ ...job, id: 'different-job' }} snapshot={snapshot} />);
  expect(screen.queryByRole('region', { name: 'Generation preview' })).not.toBeInTheDocument();
});

it.each([
  ['complete', 3, 0, 'Complete'], ['partial', 2, 1, 'Completed with failures'], ['failed', 0, 3, 'All requests failed'],
] as const)('shows %s with successful and rejected counts', (executionOutcome, succeeded, rejected, label) => {
  render(<AiRuntimeView job={{ ...job, status: executionOutcome === 'complete' ? 'completed' : 'failed', executionOutcome,
    requestCounts: { total: 3, succeeded, rejected, pending: 0, inFlight: 0 } }} snapshot={null} />);
  expect(screen.getByRole('status')).toHaveTextContent(label);
  expect(screen.getByRole('status')).toHaveTextContent(`${succeeded} succeeded · ${rejected} failed`);
});

it('decodes incomplete JSON strings safely and excludes escaped fake keys and metadata', () => {
  expect(previewFields(String.raw`{"items":[{"term":"hello \"term\": \"fake\"","meaning":"line\nnext","sourceCueIds":["not content"],"explanation":"\u65e5\u672c\u`))
    .toEqual([{ key: 'term', text: 'hello "term": "fake"' }, { key: 'meaning', text: 'line\nnext' }, { key: 'explanation', text: '日本' }]);
  expect(previewFields(String.raw`{"text":"Hi \uD83D\uDE`)).toEqual([{ key: 'text', text: 'Hi ' }]);
  expect(previewFields(String.raw`{"text":"Hi \uD83D\uDE00`)).toEqual([{ key: 'text', text: 'Hi 😀' }]);
  expect(previewFields('{"text":"Hi \ud83d')).toEqual([{ key: 'text', text: 'Hi ' }]);
});

it('keeps Study previews collapsed during streaming until explicitly expanded', () => {
  const { rerender } = render(<AiRuntimeView job={job} snapshot={snapshot} compact />);
  expect(screen.getByRole('list', { name: 'Recent progress' })).toBeVisible();
  expect(screen.getByText('look forward to')).not.toBeVisible();
  rerender(<AiRuntimeView job={job} snapshot={{ ...snapshot, revision: 6, preview: { ...snapshot.preview!, text: '{"term":"new streamed content"}' } }} compact />);
  expect(screen.getByText('new streamed content')).not.toBeVisible();
  fireEvent.click(screen.getByText('Generated content and history'));
  expect(screen.getByRole('region', { name: 'Generation preview' })).toBeVisible();
  expect(screen.getByText('new streamed content')).toBeVisible();
  expect(screen.getByText('Request 1 · Preparing request')).not.toBeVisible();
  fireEvent.click(screen.getByText('Progress history'));
  expect(screen.getByText('Request 1 · Preparing request')).toBeVisible();
});

it('previews transcript and translation bodies but never repeats word-level text', () => {
  expect(previewFields('{"transcript":"Full sentence","words":[{"text":"Full"},{"text":"sentence"}],"cues":[{"text":"Subtitle"}],"translations":[{"id":"source","translation":"翻訳"}]}'))
    .toEqual([{ key: 'transcript', text: 'Full sentence' }, { key: 'text', text: 'Subtitle' }, { key: 'translation', text: '翻訳' }]);
});

it('shows typed rejection reasons and HTTP status without rendering diagnostics or promising application', () => {
  const { rerender } = render(<AiRuntimeView job={job} snapshot={{ ...snapshot,
    events: [{ id: 'rejected', phase: 'rejected', timestamp: '2026-10-11T01:00:00Z', reason: 'output_source', httpStatus: 200 }],
    preview: { ...snapshot.preview!, state: 'validated', truncated: true },
  }} />);
  expect(screen.getByRole('list', { name: 'Recent progress' })).toHaveTextContent('Source references do not match · HTTP 200');
  expect(screen.getByText('Only the beginning of the preview is shown.')).toBeVisible();
  expect(screen.getByText('Response format checked. See the job result for application status.')).toBeVisible();
  rerender(<AiRuntimeView job={job} snapshot={{ ...snapshot, preview: undefined,
    events: [{ id: 'unknown-code', phase: 'raw diagnostic', timestamp: '', reason: 'secret diagnostic', httpStatus: 9999 }],
  }} />);
  expect(screen.getByRole('list', { name: 'Recent progress' })).toHaveTextContent('Progress updated');
  expect(screen.queryByText(/secret diagnostic|raw diagnostic|9999/)).not.toBeInTheDocument();
});

it('shares one subscription and rejects stale reads or old-attempt revisions after reapproval', async () => {
  let receive!: (runtime: AiRuntimeSnapshot) => void;
  let finish!: (runtime: AiRuntimeSnapshot | null) => void;
  const stop = vi.fn();
  const read = vi.fn(() => new Promise<AiRuntimeSnapshot | null>(resolve => { finish = resolve; }));
  const listen = vi.fn(callback => { receive = callback; return stop; });
  const store = createAiRuntimeStore({ read, listen });
  const first = store.subscribe('job', vi.fn());
  const second = store.subscribe('job', vi.fn());
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
  expect(listen).toHaveBeenCalledTimes(1);
  receive(snapshot);
  const renewed = { ...snapshot, revision: 6, approvalId: 'new-approval', preview: undefined };
  receive(renewed);
  receive(snapshot);
  finish(snapshot);
  await store.refresh('job');
  expect(store.getSnapshot('job').snapshot).toBe(renewed);
  expect(store.getSnapshot('job').snapshot?.preview).toBeUndefined();
  first(); expect(stop).not.toHaveBeenCalled();
  second(); expect(stop).toHaveBeenCalledOnce();
});

it('clears cached runtime after restoring a database with no matching runtime', async () => {
  let receive!: (runtime: AiRuntimeSnapshot) => void;
  const store = createAiRuntimeStore({ read: vi.fn().mockResolvedValue(null), listen: callback => { receive = callback; return () => {}; } });
  const stop = store.subscribe('job', vi.fn());
  await store.refresh('job');
  receive(snapshot);
  await store.refresh('job');
  expect(store.getSnapshot('job').snapshot).toBeNull();
  stop();
});
