// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function prepareTextCase(manifest, caseId, kind, term, proficiency = 'B1') {
  if (![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.cases)) throw new Error('Unsupported reference manifest');
  const selected = manifest.cases.filter(item => item.id === caseId);
  if (selected.length !== 1) throw new Error('Select exactly one existing case ID');
  const reference = selected[0];
  if (!['en', 'ja'].includes(reference.language) || !['en', 'ja'].includes(reference.explanationLanguage) || !Array.isArray(reference.cues) || !reference.cues.length || reference.cues.length > 1000) throw new Error('Invalid bounded text reference');
  const cues = reference.cues.map(cue => ({ id: cue.id, start_ms: cue.startMs, end_ms: cue.endMs, text: cue.text }));
  if (kind === 'translation') return { kind, target_language: reference.explanationLanguage, cues };
  if (kind === 'vocabulary') return { kind, learning_language: reference.language, explanation_language: reference.explanationLanguage, cues, max_items: 20 };
  if (kind !== 'explanation' || typeof term !== 'string' || !term.trim() || !['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(proficiency)) throw new Error('Explanation requires a selected term and valid proficiency');
  const normalize = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  if (!normalize(cues.map(cue => cue.text).join(' ')).includes(normalize(term))) throw new Error('Selected term is absent from the source text');
  return { kind, term: term.trim(), learning_language: reference.language, explanation_language: reference.explanationLanguage, proficiency, cues };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.length === 1 && args[0] === '--help') process.stdout.write('node scripts/ai-tests/prepare-text-case.mjs --manifest REFERENCE.json --case-id T01-en --kind vocabulary|translation|explanation --output TASK.json [--term "break the ice"] [--proficiency B1]\nWrites a native RequestTask JSON file only. No key, approval, budget change or network call.\n');
    else {
      for (let i = 0; i < args.length; i += 2) {
        if (!['--manifest', '--case-id', '--kind', '--output', '--term', '--proficiency'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid, missing or duplicate argument');
        options[args[i]] = args[i + 1];
      }
      for (const key of ['--manifest', '--case-id', '--kind', '--output']) if (!options[key]) throw new Error(`${key} is required`);
      if (statSync(options['--manifest']).size > 16 * 1024 * 1024) throw new Error('Reference JSON exceeds 16 MiB');
      const task = prepareTextCase(JSON.parse(readFileSync(options['--manifest'], 'utf8')), options['--case-id'], options['--kind'], options['--term'], options['--proficiency']);
      const output = resolve(options['--output']);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(task, null, 2)}\n`, { flag: 'wx' });
      process.stdout.write(`${JSON.stringify({ caseId: options['--case-id'], kind: task.kind, output, cloudRequests: 0 })}\n`);
    }
  } catch (error) { process.stderr.write(`Text fixture preparation failed: ${error.message}\n`); process.exitCode = 1; }
}
