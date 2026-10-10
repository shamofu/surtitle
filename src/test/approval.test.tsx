// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuoteApproval } from '../features/ai/QuoteApproval';
import type { AiQuote } from '../shared/contracts/ai';

vi.mock('../app/runtime', () => {
  const useFixture = () => ({
    mutate: (action: () => Promise<unknown>) => action(),
    t: (_ja: string, en: string) => en,
  });
  return {
    useSnapshot: useFixture,
    useDataActions: useFixture,
    useAppearance: useFixture,
    useNotifications: useFixture,
    useSurface: useFixture,
  };
});
const fixture: AiQuote = {
  id: 'test-quote',
  mediaId: 'fixture-media',
  kind: 'transcribe',
  startMs: 0,
  endMs: 60000,
  model: 'test-model',
  estimatedUsd: 0.01,
  maximumUsd: 0.03,
  inputTokens: 100,
  maxOutputTokens: 200,
  expiresAt: '2099-01-01T00:00:00Z',
  warnings: [],
  canApprove: true,
};
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
  ])('blocks a disallowed or expired quote', (quote) => {
    render(<QuoteApproval quote={quote} busy={false} onApprove={vi.fn()} />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Approve this job' }),
    ).toBeDisabled();
  });
  it('prevents duplicate approval while a request is in flight', () => {
    const { rerender } = render(
      <QuoteApproval quote={fixture} busy={false} onApprove={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    rerender(<QuoteApproval quote={fixture} busy onApprove={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Approve this job' }),
    ).toBeDisabled();
  });
  it('allows explicit scope approval without inventing a zero dollar estimate', () => {
    const approve = vi.fn();
    render(
      <QuoteApproval
        quote={{
          ...fixture,
          unpriced: true,
          estimatedUsd: null,
          maximumUsd: null,
          requestCount: 3,
          sendDurationMs: 126000,
          totalOutputTokens: 600,
        }}
        busy={false}
        onApprove={approve}
      />,
    );
    expect(screen.getByText('Price unknown')).toBeInTheDocument();
    expect(
      screen.getByText('A dollar limit cannot be guaranteed'),
    ).toBeInTheDocument();
    expect(screen.getByText('3 / 1')).toBeInTheDocument();
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Approve this job' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve this job' }));
    expect(approve).toHaveBeenCalledOnce();
  });
  it('does not carry acknowledgement across a changed quote digest', () => {
    const { rerender } = render(
      <QuoteApproval
        quote={{ ...fixture, digest: 'first' }}
        busy={false}
        onApprove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    rerender(
      <QuoteApproval
        quote={{ ...fixture, digest: 'changed' }}
        busy={false}
        onApprove={vi.fn()}
      />,
    );
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Approve this job' }),
    ).toBeDisabled();
  });
  it('requires acknowledgement again when a same-id same-digest quote gets a new expiry', () => {
    const approve = vi.fn();
    const { rerender } = render(<QuoteApproval quote={{ ...fixture, digest: 'unchanged' }} busy={false} onApprove={approve} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Approve this job' })).toBeEnabled();
    rerender(<QuoteApproval quote={{ ...fixture, digest: 'unchanged', expiresAt: '2099-01-02T00:00:00Z' }} busy={false} onApprove={approve} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Approve this job' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve this job' }));
    expect(approve).not.toHaveBeenCalled();
  });
  it('shows the automatic retry scope before approval and separates base ranges from maximum sends', () => {
    const approve = vi.fn();
    render(<QuoteApproval quote={{ ...fixture, retryPolicy: { version: 1, maxRetries: 2 },
      requestCount: 3, sendDurationMs: 120000, totalOutputTokens: 600,
      maximumRequestCount: 9, maximumSendDurationMs: 360000, maximumTotalOutputTokens: 1800, maximumUsd: .09,
    }} busy={false} transcription onApprove={approve} />);
    const policy = screen.getByTestId('automatic-retry-policy');
    expect(policy).toBeVisible();
    expect(policy).toHaveTextContent('up to 2 times (9 requests maximum)');
    expect(policy).toHaveTextContent('An unknown outcome stops the job');
    expect(screen.getByTestId('transcription-pacing-policy')).toBeVisible();
    expect(screen.getByTestId('transcription-pacing-policy')).toHaveTextContent('at least 10 seconds between request starts');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cost and request details'));
    expect(screen.getByText('Audio ranges / concurrency').parentElement).toHaveTextContent('3 / 1');
    expect(screen.getByText('Maximum requests including retries').parentElement).toHaveTextContent('9');
    expect(screen.getByText('Maximum audio including retries').parentElement).toHaveTextContent('6:00');
    expect(screen.getByText('Maximum output including retries').parentElement).toHaveTextContent('1,800 tokens');
    fireEvent.click(screen.getByRole('button', { name: 'Start transcription' }));
    expect(approve).toHaveBeenCalledOnce();
  });
  it('binds acknowledgement to the displayed retry policy and sending ceilings', () => {
    const policyQuote = { ...fixture, unpriced: true, maximumUsd: null, retryPolicy: { version: 1, maxRetries: 2 }, maximumRequestCount: 3 };
    const { rerender } = render(<QuoteApproval quote={policyQuote} busy={false} transcription onApprove={vi.fn()} />);
    const acknowledgement = screen.getByRole('checkbox', { name: /including the displayed automatic retries and sending limits/ });
    fireEvent.click(acknowledgement);
    rerender(<QuoteApproval quote={{ ...policyQuote, retryPolicy: { version: 2, maxRetries: 2 } }} busy={false} transcription onApprove={vi.fn()} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Start transcription' })).toBeDisabled();
  });
  it('does not imply automatic retries for a legacy quote', () => {
    render(<QuoteApproval quote={fixture} busy={false} transcription onApprove={vi.fn()} />);
    expect(screen.queryByTestId('automatic-retry-policy')).not.toBeInTheDocument();
    expect(screen.queryByText('Maximum requests including retries')).not.toBeInTheDocument();
  });
});
