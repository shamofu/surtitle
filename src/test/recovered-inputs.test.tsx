// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RecoveredInputs } from '../features/settings/RecoveredInputs';
import { call } from '../shared/native/transport';
vi.mock('../app/runtime', () => ({ useAppearance: () => ({ t: (_ja: string, en: string) => en }) }));
vi.mock('../shared/native/transport', () => ({ call: vi.fn(), nativeAvailable: () => true }));

it('shows both immutable same-entity inputs and nested prior recovery as read-only text', async () => {
  vi.mocked(call).mockResolvedValue([
    { kind: 'card', entityId: 'same-card', archiveId: 'first', revision: 1, stale: true, updatedAt: '2026-10-11T00:00:00Z', fields: { term: 'first input', recovery: '{"term":"older input"}' } },
    { kind: 'card', entityId: 'same-card', archiveId: 'second', revision: 2, stale: true, updatedAt: '2026-10-11T00:00:01Z', fields: { term: 'second input' } },
  ]);
  render(<QueryClientProvider client={new QueryClient()}><RecoveredInputs /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Recover earlier input' }));
  const fields = await screen.findAllByRole('textbox');
  expect(fields).toHaveLength(2);
  expect((fields[0] as HTMLTextAreaElement).value).toContain('first input');
  expect((fields[0] as HTMLTextAreaElement).value).toContain('older input');
  expect((fields[1] as HTMLTextAreaElement).value).toContain('second input');
  fields.forEach(field => expect(field).toHaveAttribute('readonly'));
  expect(vi.mocked(call).mock.calls.every(([command]) => command === 'list_ui_drafts')).toBe(true);
});
