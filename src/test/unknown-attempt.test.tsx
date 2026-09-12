// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UnknownAttempt } from '../pages/Settings';
import { api } from '../api';

const context = vi.hoisted(() => ({ locale: 'en' as 'ja' | 'en' }));

vi.mock('../api', () => ({ api: { resolveUnknownAttempt: vi.fn().mockResolvedValue(undefined), createRetryQuote: vi.fn(), reapproveQuote: vi.fn() }, nativeAvailable: () => true }));
vi.mock('../context', () => ({ useApp: () => ({ t: (ja: string, en: string) => context.locale === 'ja' ? ja : en, run: (action: () => Promise<unknown>) => action() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('unknown-request accounting', () => {
  it('does not present an unpriced unknown request as a zero reservation', () => {
    context.locale = 'en';
    render(<UnknownAttempt attempt={{ id: 'unpriced', jobId: 'job', ordinal: 0, heldUsd: null, createdAt: '2026-09-09T00:00:00Z' }} />);
    expect(screen.getByText(/Cost not calculated/)).toBeVisible();
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'I acknowledge that an unknown charge may have occurred.' })).toBeVisible();
  });
  it.each([
    { locale: 'ja' as const, button: '課金の可能性を了承', checkbox: '課金の可能性を了承し、$0.15 の予約額の保留を維持します。', explanation: '課金済みか確認できないため、予約額の全額を保留し、予算から差し引き続けます。この確認では再実行されません。再実行には別の承認が必要です。' },
    { locale: 'en' as const, button: 'Acknowledge possible charge', checkbox: 'I acknowledge the possible charge and keep $0.15 reserved.', explanation: 'Because the charge is unknown, the entire reservation remains held against your budget. Acknowledging it does not retry the request; any retry requires a separate approval.' },
  ])('requires acknowledgment of the retained hold and never retries ($locale)', async ({ locale, button: buttonLabel, checkbox, explanation }) => {
    context.locale = locale;
    render(<UnknownAttempt attempt={{ id: 'uncertain-attempt', jobId: 'unfinished-job', ordinal: 2, heldUsd: .15, createdAt: '2026-09-08T00:00:00Z' }} />);
    const button = screen.getByRole('button', { name: buttonLabel });
    expect(button).toBeDisabled();
    expect(screen.getByText(explanation)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: checkbox })).toBeVisible();
    fireEvent.click(button);
    expect(api.resolveUnknownAttempt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button);
    await waitFor(() => expect(api.resolveUnknownAttempt).toHaveBeenCalledWith('uncertain-attempt'));
    expect(api.createRetryQuote).not.toHaveBeenCalled();
    expect(api.reapproveQuote).not.toHaveBeenCalled();
  });
});
