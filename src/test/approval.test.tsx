// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuoteApproval } from '../components/AiDialog';
import type { AiQuote } from '../api';

vi.mock('../context', () => ({ useApp: () => ({ t: (_ja: string, en: string) => en }) }));
const fixture: AiQuote = { id: 'test-quote', mediaId: 'fixture-media', kind: 'transcribe', startMs: 0, endMs: 60000, model: 'test-model', estimatedUsd: .01, maximumUsd: .03, inputTokens: 100, maxOutputTokens: 200, expiresAt: '2099-01-01T00:00:00Z', warnings: [], canApprove: true };
afterEach(cleanup);
describe('one-job approval UI', () => {
  it('never approves merely by rendering an estimate; requires its checkbox', () => {
    const approve = vi.fn();
    render(<QuoteApproval quote={fixture} busy={false} onApprove={approve} />);
    const button = screen.getByRole('button', { name: 'Approve this job' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(approve).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...fixture, canApprove: false, blockedReason: 'Budget is zero' },
    { ...fixture, expiresAt: '2020-01-01T00:00:00Z' },
  ])('blocks a disallowed or expired quote', quote => {
    render(<QuoteApproval quote={quote} busy={false} onApprove={vi.fn()} />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve this job' })).toBeDisabled();
  });
  it('prevents duplicate approval while a request is in flight', () => {
    const { rerender } = render(<QuoteApproval quote={fixture} busy={false} onApprove={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox'));
    rerender(<QuoteApproval quote={fixture} busy onApprove={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve this job' })).toBeDisabled();
  });
  it('allows explicit scope approval without inventing a zero dollar estimate', () => {
    const approve = vi.fn();
    render(<QuoteApproval quote={{ ...fixture, unpriced: true, estimatedUsd: null, maximumUsd: null, requestCount: 3, sendDurationMs: 126000, totalOutputTokens: 600 }} busy={false} onApprove={approve} />);
    expect(screen.getByText('Price unknown')).toBeInTheDocument();
    expect(screen.getByText('A dollar limit cannot be guaranteed')).toBeInTheDocument();
    expect(screen.getByText('3 / 1')).toBeInTheDocument();
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve this job' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve this job' }));
    expect(approve).toHaveBeenCalledOnce();
  });
  it('does not carry acknowledgement across a changed quote digest', () => {
    const { rerender } = render(<QuoteApproval quote={{ ...fixture, digest: 'first' }} busy={false} onApprove={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox'));
    rerender(<QuoteApproval quote={{ ...fixture, digest: 'changed' }} busy={false} onApprove={vi.fn()} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Approve this job' })).toBeDisabled();
  });
});
