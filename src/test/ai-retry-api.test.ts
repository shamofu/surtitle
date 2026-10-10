// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { aiApi } from '../features/ai/api';
import type { AiQuote } from '../shared/contracts/ai';
import { call } from '../shared/native/transport';

vi.mock('../shared/native/transport', () => ({ call: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => vi.clearAllMocks());

it.each(['approveQuote', 'reapproveQuote'] as const)('%s echoes only the policy version actually reviewed', async method => {
  const quote = { id: 'job', digest: 'frozen', retryPolicy: { version: 1, maxRetries: 2 } } as AiQuote;
  await aiApi[method](quote);
  expect(call).toHaveBeenLastCalledWith(method === 'approveQuote' ? 'approve_quote' : 'reapprove_quote', expect.objectContaining({
    quoteId: 'job', digest: 'frozen', retryPolicyVersion: 1,
  }));
  await aiApi[method]({ ...quote, retryPolicy: undefined });
  expect(call).toHaveBeenLastCalledWith(method === 'approveQuote' ? 'approve_quote' : 'reapprove_quote', expect.objectContaining({ retryPolicyVersion: undefined }));
});
