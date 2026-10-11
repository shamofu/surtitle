// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit live validation runner. Uses the production Rust request builder,
// parser and ledger through its isolated CLI; never initializes/resets budgets.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  mode: { type: 'string' }, root: { type: 'string' }, validator: { type: 'string' },
  credential: { type: 'string' }, price: { type: 'string' },
  model: { type: 'string', default: 'gemini-3.8-flash' },
  round: { type: 'string', default: 'r1' },
  offset: { type: 'string', default: '0' }, count: { type: 'string', default: '26' },
} });
if (!['prepare', 'run'].includes(values.mode) || !values.root || !values.validator || !/^[a-z0-9-]+$/.test(values.round)) {
  throw new Error('Use --mode prepare|run --root ABS --validator ABS [--credential ID --price ABS] [--round r1] [--offset 0 --count 2]');
}
const root = resolve(values.root), validator = resolve(values.validator);
const suite = join(root, `vocabulary-${values.round}`);
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function cli(command, args = [], allowFailure = false) {
  const result = spawnSync(validator, [command, '--data-root', root, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return { failed: true, error: result.stderr.trim() || result.stdout.trim() };
    throw new Error(result.stderr.trim() || result.stdout.trim());
  }
  return JSON.parse(result.stdout);
}
function checkBudget(report, reservation = 0) {
  const totals = report.validation;
  if (!totals.monetaryTotalsComplete || totals.unpricedAttempts !== 0 || totals.totalLimitMicrousd > 15_000_000 ||
      totals.chargedOrHeldMicrousd + reservation > 12_000_000) {
    throw new Error('Stop: priced, cumulative $15 ceiling / $12 dispatch line required');
  }
  if (report.budget.unknownAttempts?.some(attempt => attempt.state === 'unknown')) {
    throw new Error('Stop: unresolved request outcome; no automatic resend');
  }
}
if (values.mode === 'prepare') {
  if (!values.credential || !values.price) throw new Error('Preparation requires --credential and verified --price');
  checkBudget(cli('report'));
  mkdirSync(suite); // A new round is explicit; never overwrite earlier evidence.
  const corpus = json(resolve('crates/ai/tests/fixtures/evaluation/text-corpus.json'));
  const cases = [];
  const cleanCues = cues => cues.map(cue => ({ id: cue.id, start_ms: cue.startMs, end_ms: cue.endMs, text: cue.text }));
  for (const source of corpus.cases) {
    cases.push({ id: `vocab-${source.id}`, task: { kind: 'vocabulary', learning_language: source.language,
      explanation_language: source.explanationLanguage, cues: cleanCues(source.cues), max_items: 20 } });
  }
  for (const language of ['en', 'ja']) {
    const sources = corpus.cases.filter(source => source.language === language);
    const cues = sources.flatMap((source, index) => cleanCues(source.cues).map(cue => ({ ...cue,
      start_ms: cue.start_ms + index * 80_000, end_ms: cue.end_ms + index * 80_000 })));
    cases.push({ id: `vocab-60-${language}`, task: { kind: 'vocabulary', learning_language: language,
      explanation_language: language === 'en' ? 'ja' : 'en', cues, max_items: 20 } });
  }
  const terms = { 'T01-en': 'break the ice', 'T01-ja': '白紙に戻った', 'T02-en': 'look forward to',
    'T02-ja': '頭が痛い', 'T03-en': 'reveal', 'T03-ja': '取り違えない' };
  for (const source of corpus.cases) for (const proficiency of ['A2', 'B1', 'C1']) {
    cases.push({ id: `explain-${source.id}-${proficiency}`, task: { kind: 'explanation', term: terms[source.id],
      learning_language: source.language, explanation_language: source.explanationLanguage, proficiency,
      cues: cleanCues(source.cues) } });
  }
  const prepared = [];
  for (const item of cases) {
    const taskFile = join(suite, `${item.id}.task.json`);
    write(taskFile, item.task);
    const result = cli('prepare', ['--credential-id', values.credential, '--case-id', `${item.id}-${values.round}`,
      '--task-file', taskFile, '--model-id', values.model, '--location', 'global', '--response-mode', 'stream',
      '--max-output-tokens', item.task.kind === 'vocabulary' ? '8192' : '4096', '--price-file', resolve(values.price)]);
    write(join(suite, `${item.id}.quote.json`), result);
    prepared.push({ caseId: item.id, jobId: result.quote.id, digest: result.quote.digest, approveChargeUsd: result.approveChargeUsd });
  }
  write(join(suite, 'cases.json'), prepared);
  console.log(JSON.stringify({ prepared: prepared.length, maximumUsd: prepared.reduce((sum, item) => sum + Number(item.approveChargeUsd), 0), paidRequests: 0 }));
} else {
  const cases = json(join(suite, 'cases.json'));
  const offset = Number(values.offset), count = Number(values.count);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count < 1) throw new Error('Invalid case range');
  for (const item of cases.slice(offset, offset + count)) {
    const report = cli('report');
    const prior = report.requests.find(request => request.id === item.jobId);
    if (prior?.attempts.length) { console.log(JSON.stringify({ caseId: item.caseId, skipped: 'already attempted' })); continue; }
    const quote = cli('show', ['--job-id', item.jobId]);
    if (quote.quote.digest !== item.digest || quote.approveChargeUsd !== item.approveChargeUsd) throw new Error('Reviewed quote changed');
    const reservation = Math.round(Number(item.approveChargeUsd) * 1_000_000);
    if (!Number.isSafeInteger(reservation) || reservation <= 0) throw new Error('A priced reservation is required');
    checkBudget(report, reservation);
    const outputFile = join(suite, `${item.caseId}.run.json`);
    if (existsSync(outputFile)) throw new Error('Run evidence already exists');
    const result = cli('run', ['--job-id', item.jobId, '--digest', item.digest,
      '--acknowledge-unqualified', '--approve-charge-usd', item.approveChargeUsd], true);
    write(outputFile, result);
    const after = cli('report');
    write(join(suite, `${item.caseId}.report.json`), after);
    const request = after.requests.find(request => request.id === item.jobId);
    console.log(JSON.stringify({ caseId: item.caseId, state: request?.state, outcome: result.failed ? 'failed' : 'received',
      chargedOrHeldUsd: after.validation.chargedOrHeldMicrousd / 1_000_000, stream: result.transportObservation }));
    checkBudget(after);
    if (result.failed && !request?.attempts.some(attempt => attempt.state === 'settled' && attempt.usageState === 'known' && Number.isSafeInteger(attempt.chargedMicrousd))) {
      throw new Error('Stopped after an unsettled execution failure');
    }
  }
}
