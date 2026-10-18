// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function commandDefinitions() {
  const commands = {};
  for (const source of readdirSync(join(root, 'src-tauri/src/commands')).filter(name => name.endsWith('.rs')).sort()) {
    const code = readFileSync(join(root, 'src-tauri/src/commands', source), 'utf8');
    for (const match of code.matchAll(/#\[tauri::command\]\s*pub\s+(?:async\s+)?fn\s+(\w+)\s*\((.*?)\)\s*->\s*([^\{]+)\{/gs)) {
      const [, name, signature, result] = match;
      const args = []; let part = '', depth = 0;
      for (const char of signature + ',') {
        if (char === '<') depth++;
        if (char === '>') depth--;
        if (char === ',' && depth === 0) { if (part.trim()) args.push(part.trim()); part = ''; }
        else part += char;
      }
      const fields = {};
      for (const arg of args) {
        const colon = arg.indexOf(':');
        let key = arg.slice(0, colon).trim(), rust = arg.slice(colon + 1).trim();
        // Tauri injects these parameters; underscore-prefixed unused handles count too.
        if (/^(?:tauri::)?(?:State<|AppHandle\b|Window\b|WebviewWindow\b)/.test(rust)) continue;
        key = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        const optional = rust.startsWith('Option<');
        if (optional) rust = rust.slice(7, -1);
        const kind = rust === 'String' ? 'string' : rust === 'bool' ? 'boolean'
          : /^(?:[uif]\d+|usize|isize)$/.test(rust) ? 'number' : rust === 'Vec<String>' ? 'strings'
          : rust === 'Vec<crate::application::changes::ChangeDomain>' ? 'domains'
          : rust.startsWith('Vec<') ? 'array' : 'object';
        fields[key] = kind + (optional ? '?' : '');
      }
      if (Object.hasOwn(commands, name)) throw new Error(`Duplicate IPC command: ${name}`);
      const output = result.trim().replace(/^(?:std::result::)?(?:IpcResult|Result)</, '').replace(/>$/, '').replace(/,\s*String$/, '').replace(/\s+/g, '');
      commands[name] = { args: fields, result: output };
    }
  }
  return Object.fromEntries(Object.entries(commands).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
export function commandRegistry() { return Object.fromEntries(Object.entries(commandDefinitions()).map(([name, value]) => [name, value.args])); }
const namedResults = {
  AiQuote: ["../contracts/ai", 'AiQuote'], AppSnapshot: ['../contracts/snapshot', 'AppSnapshot'],
  RuntimeSnapshot: ['../contracts/ai', 'AiRuntimeSnapshot'], SavedAiResult: ['../contracts/ai', 'SavedAiResult'],
  VocabularyCandidate: ['../contracts/cards', 'VocabularyCandidate'], PreparationSummary: ['../contracts/ai', 'TranscriptionPreparation'],
  TranscriptionPreparation: ['../contracts/ai', 'TranscriptionPreparation'], DiscoveredModel: ['../contracts/ai', 'DiscoveredModel'],
  PriceLookup: ['../contracts/ai', 'PriceLookup'], EditorDraftView: ['../../features/study/editor-drafts/api', 'EditorDraft'],
  AiContinuation: ['../../features/ai/continuations', 'AiContinuation'],
  MediaStream: ['../contracts/media', 'MediaStream'], ExternalCandidate: ['../contracts/settings', 'ExternalToolCandidate'],
  OperationProgress: ['../contracts/activity', 'OperationProgress'], LocalMediaImportResult: ['../contracts/media', 'LocalMediaImportResult'],
  MediaFileValidation: ['../contracts/media', 'MediaFileValidation'], SettingsState: ['../contracts/editing', 'SettingsState'],
  CardEditState: ['../contracts/editing', 'CardEditState'], PlayerState: ['../contracts/player', 'PlayerState'],
  SubtitleSegment: ['../contracts/media', 'SubtitleSegment'], SubtitleVersion: ['../contracts/media', 'SubtitleVersion'],
  TranscriptIssueRecord: ['../contracts/media', 'TranscriptIssueRecord'], TranscriptReview: ['../contracts/transcript', 'TranscriptReview'],
  TranscriptResultReview: ['../contracts/transcript', 'TranscriptResultReview'], SelectionView: ['../../features/study/drafts/api', 'DraftSelection'],
  UiDraft: ['../contracts/editing', 'UiDraft'], RestorePreview: ['../contracts/transfer', 'RestorePreview'],
  RestoreResult: ['../contracts/transfer', 'RestoreResult'],
  ChangeCheckpoint: ['../contracts/synchronization', 'ChangeCheckpoint'], SnapshotPatch: ['../contracts/snapshot', 'SnapshotPatch'],
};
function resultType(rust, command) {
  if (rust.startsWith('Vec<')) return `(${resultType(rust.slice(4, -1), command)})[]`;
  if (rust.startsWith('Option<')) return `${resultType(rust.slice(7, -1), command)} | null`;
  if (rust === '()') return 'void';
  if (rust === 'String') return 'string';
  if (rust === 'bool') return 'boolean';
  const name = rust.split('::').at(-1);
  // This adapter returns serde_json::Value today; bind its documented candidate DTO explicitly.
  const entry = namedResults[name === 'Value' && command === 'list_draft_selection_candidates' ? 'VocabularyCandidate' : name];
  if (!entry) throw new Error(`Unmapped native result ${rust} for ${command}`);
  return `import('${entry[0]}').${entry[1]}`;
}
export function registrySource() {
  const definitions = commandDefinitions();
  return '// SPDX-License-Identifier: GPL-3.0-or-later\n// Generated by scripts/generate-ipc-contract.mjs; do not hand-edit.\nexport const commandArguments = ' + JSON.stringify(commandRegistry(), null, 2) + ' as const;\n'
    + '\nexport const commandResults = ' + JSON.stringify(Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, value.result])), null, 2) + ' as const;\n'
    + '\nexport interface CommandResults {\n' + Object.entries(definitions).map(([name, value]) => `  ${name}: ${resultType(value.result, name)};`).join('\n') + '\n}\n';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = join(root, 'src/shared/native/command-registry.ts');
  const result = registrySource();
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== result) throw new Error('IPC registry is stale. Run node scripts/generate-ipc-contract.mjs');
  } else writeFileSync(target, result);
  console.log(`${process.argv.includes('--check') ? 'Checked' : 'Generated'} ${Object.keys(commandRegistry()).length} IPC command envelopes`);
}
