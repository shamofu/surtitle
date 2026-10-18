// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { withReadOnlyDatabase } from './native-e2e-database.mjs';

export function readFeeLedger(dataDirectory) {
  return withReadOnlyDatabase(resolve(dataDirectory, 'charges.sqlite'), database =>
    Object.fromEntries(['ai_settings', 'ai_jobs', 'ai_requests', 'ai_attempts'].map(table =>
      [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}

export function assertOfflineFixtureLedger(snapshot, stored, environment = process.env) {
  const expected = new Map();
  if (environment.SURTITLE_E2E_AI_RECOVERY === 'translation') expected.set('E2E saved translation recovery', { media: 'e2e-ai-recovery', kind: 'translation', requests: 1, received: 1, state: 'completed' });
  if (environment.SURTITLE_E2E_TRANSCRIPT_REVIEW === 'boundary') {
    expected.set('E2E / e2e-transcript-review', { media: 'e2e-transcript-review', kind: 'transcribe_preview', requests: 2, received: 2, state: 'completed' });
    expected.set('E2E / e2e-transcript-pending', { media: 'e2e-transcript-pending', kind: 'transcribe_preview', requests: 2, received: 1, state: 'needs_review' });
    expected.set('E2E transcript repair', { media: 'e2e-transcript-review', kind: 'transcribe_preview', requests: 1, received: 0, state: 'prepared' });
  }
  assert.equal(stored.ai_jobs.length, expected.size, 'Only the explicitly enabled offline fixture jobs are allowed');
  const seen = new Set();
  for (const job of stored.ai_jobs) {
    const plan = JSON.parse(job.plan_json), allowed = expected.get(plan.title);
    assert(allowed && !seen.has(plan.title), 'Unexpected or duplicate fixture plan');
    seen.add(plan.title);
    assert.equal(plan.project_id, 'e2e-project');
    assert.equal(plan.credential_id, 'unused-e2e-fixture');
    assert.equal(plan.binding.media_id, allowed.media);
    assert.equal(plan.requests.length, allowed.requests);
    assert(plan.requests.every(request => request.kind === allowed.kind));
    assert.equal(job.state, allowed.state, 'Offline fixtures must retain their authored execution state');
    assert.equal(job.approved_at_ms, null, 'No test job may have a paid approval');
    assert.equal(job.approval_json, null, 'No test job may have an approval payload');
    const attempts = stored.ai_attempts.filter(attempt => attempt.job_id === job.id);
    assert.equal(attempts.length, allowed.received, 'Unexpected fixture execution history');
    assert.deepEqual(attempts.map(attempt => attempt.ordinal).sort(), Array.from({ length: allowed.received }, (_, index) => index));
    const requests = stored.ai_requests.filter(request => request.job_id === job.id);
    assert.equal(requests.length, allowed.requests);
    assert.deepEqual(requests.map(request => request.ordinal).sort(), Array.from({ length: allowed.requests }, (_, index) => index));
    for (const request of requests) {
      assert.equal(request.state, request.ordinal < allowed.received ? 'completed' : 'pending');
      assert.equal(request.error_code, null);
      assert.equal(request.response_json !== null, request.ordinal < allowed.received);
    }
  }
  assert.equal(stored.ai_requests.length, [...expected.values()].reduce((sum, value) => sum + value.requests, 0));
  assert.equal(stored.ai_attempts.length, [...expected.values()].reduce((sum, value) => sum + value.received, 0));
  for (const attempt of stored.ai_attempts) {
    assert.equal(attempt.state, 'settled');
    assert.equal(attempt.reserve_microusd, 0);
    assert.equal(attempt.charged_microusd, 0);
    assert.equal(attempt.dispatched_at_ms, null, 'Offline fixtures must never reach the provider');
    const usage = JSON.parse(attempt.usage_json);
    assert.equal(usage.offlineFixture, true);
    assert.equal(usage.paidRequests, 0);
  }
  assert.equal(stored.ai_settings.length, 1);
  assert.equal(stored.ai_settings[0].id, 1);
  assert.deepEqual(JSON.parse(stored.ai_settings[0].limits_json), { per_job_microusd: 0, daily_microusd: 0, monthly_microusd: 0 });
  // The activity snapshot omits estimates in `prepared` state. Their complete
  // ledger rows are still checked above and retained in before/after comparisons.
  const listed = stored.ai_jobs.filter(job => job.state !== 'prepared');
  assert.deepEqual(snapshot.jobs.map(job => job.id).sort(), listed.map(job => job.id).sort(), 'IPC activity must match every non-prepared job in the exact disposable ledger');
}
