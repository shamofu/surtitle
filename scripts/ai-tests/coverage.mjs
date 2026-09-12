// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';

function ensure(value, message) { if (!value) throw new Error(message); }
function unique(values, message) { ensure(new Set(values).size === values.length, message); }
const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
const key = item => stable([item.caseId, item.taskKind, item.term, item.proficiency, item.candidateId]);
const hash = value => createHash('sha256').update(value).digest('hex');

/** The independently frozen plan supplies the denominator, never observed output. */
export function evaluationCoverage(plan, requests, cases, selected) {
  ensure(plan && Array.isArray(plan.candidates) && plan.candidates.length > 0 && Array.isArray(plan.cases) && plan.cases.length > 0, 'An evaluation plan needs candidates and case matrices');
  unique(plan.candidates.map(item => item.id), 'Duplicate candidate IDs');
  unique(plan.candidates.map(item => stable(item.execution)), 'Duplicate candidate execution settings');
  const candidates = new Map(plan.candidates.map(item => {
    ensure(typeof item.id === 'string' && item.id.trim() && item.execution && typeof item.execution.model_id === 'string' && typeof item.execution.location === 'string' && Number.isSafeInteger(item.execution.max_output_tokens) && item.execution.max_output_tokens > 0 && item.execution.thinking && item.execution.price, 'Candidate needs exact model, location, output settings, thinking and price snapshot');
    return [item.id, item];
  }));
  const expected = [];
  for (const matrix of plan.cases) {
    const reference = cases.find(item => item.id === matrix.caseId);
    ensure(reference && selected.includes(matrix.caseId), 'Matrix case is missing or excluded from selection');
    ensure(['explanation', 'vocabulary', 'translation', 'audio_transcription', 'transcribe_preview', 'transcribe_diagnostic'].includes(matrix.taskKind), 'Unknown matrix task');
    ensure(Array.isArray(matrix.candidateIds) && matrix.candidateIds.length > 0 && matrix.candidateIds.every(id => candidates.has(id)), 'Matrix needs known candidates');
    unique(matrix.candidateIds, 'Duplicate matrix candidates');
    const explanation = matrix.taskKind === 'explanation';
    const terms = explanation ? matrix.terms : [null], levels = explanation ? matrix.proficiencies : [null];
    ensure(Array.isArray(terms) && terms.length > 0 && Array.isArray(levels) && levels.length > 0, 'Explanation matrix needs terms and proficiency levels');
    if (explanation) {
      ensure(terms.every(term => typeof term === 'string' && term.trim()), 'Matrix terms must be nonempty');
      ensure(levels.every(level => ['A2', 'B1', 'C1'].includes(level)), 'Quality evaluation uses A2, B1 and C1');
      unique(terms, 'Duplicate terms'); unique(levels, 'Duplicate proficiency levels');
    }
    for (const term of terms) for (const proficiency of levels) for (const candidateId of matrix.candidateIds) {
      ensure(expected.length < 10_000, 'Evaluation matrix is too large');
      expected.push({ caseId: matrix.caseId, taskKind: matrix.taskKind, term, proficiency, candidateId });
    }
  }
  unique(expected.map(key), 'Duplicate expected evaluation requests');
  ensure(selected.every(id => expected.some(item => item.caseId === id)), 'Every selected case needs an explicit matrix');
  const observed = [], invalid = [];
  for (const request of requests.filter(item => selected.includes(item.caseId))) {
    const candidate = plan.candidates.find(item => stable(item.execution) === stable(request.execution));
    if (!candidate || !/^[a-f0-9]{64}$/u.test(request.requestBodySha256 || '') || !/^[a-f0-9]{64}$/u.test(request.digest || '')) {
      invalid.push({ requestId: request.id, reason: 'missing_or_changed_execution_or_request_hash' }); continue;
    }
    const item = { requestId: request.id, caseId: request.caseId, taskKind: request.taskKind, term: request.term ?? null, proficiency: request.proficiency ?? null, candidateId: candidate.id, requestBodySha256: request.requestBodySha256, planDigest: request.digest };
    if (!expected.some(target => key(target) === key(item))) invalid.push({ requestId: request.id, reason: 'unexpected_case_term_level_or_candidate' });
    else observed.push(item);
  }
  const missing = expected.filter(target => !observed.some(item => key(item) === key(target)));
  const duplicate = expected.flatMap(target => {
    const matches = observed.filter(item => key(item) === key(target));
    return matches.length > 1 ? [{ ...target, requestIds: matches.map(item => item.requestId) }] : [];
  });
  return { planSha256: hash(stable(plan)), expectedRequests: expected.length, observedRequests: observed.length, missing, duplicate, invalid, requests: observed, passed: !missing.length && !duplicate.length && !invalid.length };
}
