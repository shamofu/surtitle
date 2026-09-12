// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluate, sha256, RUBRIC } from './evaluation.mjs';

function readJson(path) {
  if (statSync(path).size > 16 * 1024 * 1024) throw new Error('Evaluation JSON exceeds 16 MiB; use a bounded batch');
  const bytes = readFileSync(path);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
}
export function run(args) {
  const options = {}, caseIds = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') {
      process.stdout.write('Offline quality evaluation (no network):\nnode scripts/ai-tests/evaluate.mjs --manifest REFERENCE.json --results VALIDATION_REPORT.json --output REPORT.json [--rubric REVIEWS.json] [--case-id ID ...]\nAdd --rubric-template TEMPLATE.json to write a blank AI review form bound to result and reference hashes. AI review is never labeled human confirmation. Existing output files are never overwritten. Exit 2 means missing/failed evidence; authored oracle responses cannot establish live model quality.\n');
      return 0;
    }
    if (!['--manifest', '--results', '--output', '--rubric', '--case-id', '--rubric-template'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid or incomplete argument: ${key}`);
    if (key === '--case-id') caseIds.push(args[++i]);
    else {
      if (options[key]) throw new Error(`Duplicate argument: ${key}`);
      options[key] = resolve(args[++i]);
    }
  }
  for (const key of ['--manifest', '--results', '--output']) if (!options[key]) throw new Error(`${key} is required`);
  if (Object.values(options).filter((value, index, values) => values.indexOf(value) !== index).length) throw new Error('Input and output paths must be distinct');
  const manifest = readJson(options['--manifest']), results = readJson(options['--results']);
  const rubric = options['--rubric'] ? readJson(options['--rubric']) : null;
  const report = evaluate(manifest.value, results.value, rubric?.value || null, { resultsSha256: results.sha256, referencesSha256: manifest.sha256, ...(caseIds.length ? { caseIds } : {}) });
  const artifact = { ...report, generatedAt: new Date().toISOString(), inputs: { manifestSha256: manifest.sha256, resultsSha256: results.sha256, rubricSha256: rubric?.sha256 || null } };
  mkdirSync(dirname(options['--output']), { recursive: true });
  writeFileSync(options['--output'], `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
  if (options['--rubric-template']) {
    const items = results.value.requests.filter(request => !caseIds.length || caseIds.includes(request.caseId)).flatMap(request => {
      const dimensions = RUBRIC[request.taskKind];
      if (!Array.isArray(dimensions) || !request.output) return [];
      const outputs = request.taskKind === 'translation' ? request.output.translations : request.output.items;
      if (!Array.isArray(outputs)) return [];
      return outputs.map((item, index) => ({ requestId: request.id, itemId: request.taskKind === 'translation' ? item.id : `item:${index}`, term: request.term ?? null, proficiency: request.proficiency ?? null, requestBodySha256: request.requestBodySha256 ?? null, scores: Object.fromEntries(dimensions.map(dimension => [dimension, null])), evidence: Object.fromEntries(dimensions.map(dimension => [dimension, ''])), criticalErrors: [], note: '', ...(request.proficiency ? { understandableAtProficiency: null, proficiencyEvidence: '' } : {}) }));
    });
    const template = { schemaVersion: 1, reviewMethod: 'ai-review', resultsSha256: results.sha256, reviewer: '', reviewerModel: '', reviewedAt: '', referenceReview: { method: 'ai-review', reviewer: '', model: '', reviewedAt: '', referencesSha256: manifest.sha256, independentOfModelOutput: false }, instructions: 'Review the reference independently from the tested model output, then score every output item 0 (wrong), 1 (requires correction), or 2 (usable). Record critical meaning/number/negation/source errors, dictionary-form transitivity and proficiency depth. Never claim human confirmation. Boundary observations use reviewAccepted, not manuallyAccepted. Do not copy oracle scores as a real review.', items, timestampMatches: [], boundaries: [] };
    mkdirSync(dirname(options['--rubric-template']), { recursive: true });
    writeFileSync(options['--rubric-template'], `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, gatesPassed: report.gatesPassed, modelQualified: false, output: options['--output'] })}\n`);
  return report.status === 'evaluation_gates_passed' ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`Evaluation failed: ${error.message}\n`); process.exitCode = 1; }
}
