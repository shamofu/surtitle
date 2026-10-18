// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertOfflineFixtureLedger } from './native-e2e-ledger.mjs';

function fixture({ translation = false, boundary = false } = {}) {
  const environment = {
    ...(translation ? { SURTITLE_E2E_AI_RECOVERY: 'translation' } : {}),
    ...(boundary ? { SURTITLE_E2E_TRANSCRIPT_REVIEW: 'boundary' } : {}),
  };
  const stored = {
    ai_jobs: [], ai_requests: [], ai_attempts: [],
    ai_settings: [{ id: 1, limits_json: JSON.stringify({ per_job_microusd: 0, daily_microusd: 0, monthly_microusd: 0 }) }],
  };
  const add = (id, title, media_id, kind, count, received, state) => {
    stored.ai_jobs.push({ id, state, approved_at_ms: null, approval_json: null, plan_json: JSON.stringify({ title, project_id: 'e2e-project', credential_id: 'unused-e2e-fixture', binding: { media_id }, requests: Array.from({ length: count }, () => ({ kind })) }) });
    for (let ordinal = 0; ordinal < count; ordinal++) {
      stored.ai_requests.push({ job_id: id, ordinal, state: ordinal < received ? 'completed' : 'pending', response_json: ordinal < received ? '{}' : null, error_code: null });
      if (ordinal < received) stored.ai_attempts.push({ id: `${id}-${ordinal}`, job_id: id, ordinal, state: 'settled', reserve_microusd: 0, charged_microusd: 0, dispatched_at_ms: null, usage_json: '{"offlineFixture":true,"paidRequests":0}' });
    }
  };
  if (translation) add('translation', 'E2E saved translation recovery', 'e2e-ai-recovery', 'translation', 1, 1, 'completed');
  if (boundary) {
    add('transcript', 'E2E / e2e-transcript-review', 'e2e-transcript-review', 'transcribe_preview', 2, 2, 'completed');
    add('pending', 'E2E / e2e-transcript-pending', 'e2e-transcript-pending', 'transcribe_preview', 2, 1, 'needs_review');
    add('repair', 'E2E transcript repair', 'e2e-transcript-review', 'transcribe_preview', 1, 0, 'prepared');
  }
  const snapshot = { jobs: stored.ai_jobs.filter(job => job.id !== 'repair').map(({ id }) => ({ id })) };
  return { snapshot, stored, environment };
}
const check = ({ snapshot, stored, environment }) => assertOfflineFixtureLedger(snapshot, stored, environment);

test.each([{}, { translation: true }, { boundary: true }, { translation: true, boundary: true }])('validates the entire offline ledger and its activity projection for %j', options => {
  const data = fixture(options), before = structuredClone(data);
  check(data);
  assert.deepEqual(data, before, 'Validation must not modify the ledger used for before/after comparisons');
});

test('rejects missing, duplicate, foreign, or prepared jobs in the activity snapshot', () => {
  for (const ids of [['translation', 'transcript'], ['translation', 'transcript', 'pending', 'pending'], ['translation', 'transcript', 'pending', 'foreign'], ['translation', 'transcript', 'pending', 'repair']]) {
    const data = fixture({ translation: true, boundary: true });
    data.snapshot.jobs = ids.map(id => ({ id }));
    assert.throws(() => check(data), /IPC activity must match/);
  }
});

test('checks the hidden repair row for paid approval, execution, saved output, and extra prepared jobs', () => {
  const mutations = [
    data => { data.stored.ai_jobs.find(job => job.id === 'repair').approved_at_ms = 1; },
    data => { data.stored.ai_jobs.find(job => job.id === 'repair').approval_json = '{}'; },
    data => { data.stored.ai_jobs.find(job => job.id === 'repair').state = 'approved'; },
    data => { data.stored.ai_requests.find(request => request.job_id === 'repair').response_json = '{}'; },
    data => { data.stored.ai_attempts.push({ ...data.stored.ai_attempts[0], job_id: 'repair' }); },
    data => { data.stored.ai_jobs.push({ ...data.stored.ai_jobs.find(job => job.id === 'repair'), id: 'unexpected' }); },
  ];
  for (const mutate of mutations) {
    const data = fixture({ boundary: true }); mutate(data);
    assert.throws(() => check(data), assert.AssertionError);
  }
});

test('rejects provider dispatch, nonzero fees or limits, and orphan request records', () => {
  const mutations = [
    data => { data.stored.ai_attempts[0].dispatched_at_ms = 1; },
    data => { data.stored.ai_attempts[0].reserve_microusd = 1; },
    data => { data.stored.ai_attempts[0].charged_microusd = 1; },
    data => { data.stored.ai_attempts[0].usage_json = '{"offlineFixture":true,"paidRequests":1}'; },
    data => { data.stored.ai_settings[0].limits_json = '{"per_job_microusd":0,"daily_microusd":1,"monthly_microusd":0}'; },
    data => { data.stored.ai_requests.push({ ...data.stored.ai_requests[0], job_id: 'foreign' }); },
  ];
  for (const mutate of mutations) {
    const data = fixture({ translation: true, boundary: true }); mutate(data);
    assert.throws(() => check(data), assert.AssertionError);
  }
});
