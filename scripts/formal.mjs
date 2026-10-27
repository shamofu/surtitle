// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile, cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cases = [
  ['ClaimSafety', null], ['RetrySafety', null], ['PacingSharedSafety', null],
  ['PacingSeparateSafety', null], ['PacingStopSafety', null], ['PacingRestartSafety', null], ['HealthyProgress', null],
  ['MissingGenerationGuard', 'NoStaleAuthority'], ['UnknownRefund', 'UnknownHoldPreserved'],
  ['RetryFloorIgnored', 'RetryFloorRespected'],
];

/** TLC 1.7.4 returns 12 for a safety violation. An arbitrary nonzero exit is not a negative-control pass. */
export function assessTlc(result, expectedInvariant) {
  const { stdout, exitCode, signal, timedOut } = result;
  const finished = /Finished in [^\n]+/.test(stdout);
  const violations = [...stdout.matchAll(/Invariant (\w+) is violated\./g)].map(match => match[1]);
  const stats = [...stdout.matchAll(/([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue\./g)].at(-1);
  const states = stats ? { generated: Number(stats[1].replaceAll(',', '')), distinct: Number(stats[2].replaceAll(',', '')), queued: Number(stats[3].replaceAll(',', '')) } : null;
  const passed = !timedOut && !signal && finished && (expectedInvariant
    ? exitCode === 12 && violations.length === 1 && violations[0] === expectedInvariant
    : exitCode === 0 && violations.length === 0 && stdout.includes('Model checking completed. No error has been found.') && states?.queued === 0 && states.distinct > 0);
  return { passed, expectedInvariant, violations, states, exitCode, signal, timedOut };
}

async function verified(pin, path) {
  try { return hash(await readFile(path)) === pin.sha256; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function acquireTlc(pin, destination, download = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`TLC download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}) {
  if (await verified(pin, destination)) return;
  const bytes = await download(pin.url);
  if (hash(bytes) !== pin.sha256) throw new Error('TLC checksum mismatch; existing cache was not replaced');
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
}

/** A single child's remaining time comes from the whole run's deadline. */
async function execute(command, args, cwd, timeoutMs) {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = '', stderr = '', timedOut = false, outputExceeded = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    function append(kind, bytes) {
      if (stdout.length + stderr.length > 32 * 1024 * 1024) { outputExceeded = true; child.kill('SIGKILL'); return; }
      if (kind === 'out') stdout += bytes.toString(); else stderr += bytes.toString();
    }
    child.stdout.on('data', bytes => append('out', bytes));
    child.stderr.on('data', bytes => append('err', bytes));
    child.on('error', error => { stderr += error.message; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({ stdout, stderr, exitCode, signal, timedOut, outputExceeded });
    });
  });
}

async function inputHashes(directory, prefix = '') {
  const entries = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(entries, await inputHashes(join(directory, entry.name), relative));
    else if (entry.isFile()) entries[relative] = hash(await readFile(join(directory, entry.name)));
  }
  return entries;
}

async function main() {
  const mode = process.argv[2];
  if (!['setup', 'check'].includes(mode) || process.argv.length !== 3) throw new Error('Usage: node scripts/formal.mjs setup|check');
  const toolchain = JSON.parse(await readFile(join(root, 'verification/toolchain.json'), 'utf8'));
  const jar = join(root, `work/tools/tla/tla2tools-${toolchain.tlc.version}.jar`);
  if (mode === 'setup') {
    await acquireTlc(toolchain.tlc, jar);
    console.log(`Verified TLC ${toolchain.tlc.version}: ${jar}`);
    return;
  }
  if (!await verified(toolchain.tlc, jar)) throw new Error('Pinned TLC is missing or corrupt. Run pnpm setup:formal first.');
  const java = spawnSync('java', ['-version'], { encoding: 'utf8', windowsHide: true });
  const javaVersion = `${java.stdout ?? ''}${java.stderr ?? ''}`.trim();
  if (java.status !== 0 || Number(javaVersion.match(/version "(\d+)/)?.[1]) !== toolchain.javaMajor) {
    throw new Error(`Java ${toolchain.javaMajor} is required: ${java.error?.message ?? javaVersion}`);
  }
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const output = join(root, 'work/test-results/formal', runId);
  const sources = join(output, 'sources');
  await cp(join(root, 'verification/tla'), sources, { recursive: true });
  const inputs = await inputHashes(sources);
  // Fingerprint the implementation/test surfaces to which the model is mapped,
  // including dirty worktrees and containers whose host .git link is unreadable.
  const implementation = {};
  for (const directory of ['crates/ai/src', 'crates/core/src/store', 'src/shared/editing',
    'src/shared/query', 'src/features/study/editor-drafts', 'src/test']) {
    Object.assign(implementation, await inputHashes(join(root, directory), directory));
  }
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const summary = { runId, toolchain, javaVersion, commit: git.status === 0 ? git.stdout.trim() : null,
    inputHashes: inputs, modelFingerprint: hash(JSON.stringify(inputs)),
    implementationHashes: implementation, implementationFingerprint: hash(JSON.stringify(implementation)),
    complete: false, passed: false, cases: [] };
  const started = Date.now();
  const deadline = Date.now() + toolchain.timeoutMs;
  try {
    for (const [name, expected] of cases) {
      if (Date.now() >= deadline) throw new Error('Formal verification aggregate deadline exceeded; unchecked cases remain');
      const metadata = join(root, 'work/formal-states', runId, name);
      await mkdir(metadata, { recursive: true });
      const caseStarted = Date.now();
      const result = await execute('java', [`-Xmx${toolchain.memoryMiB}m`, '-XX:+UseParallelGC', '-cp', jar,
        'tlc2.TLC', '-workers', '1', '-tool', '-config', `${name}.cfg`, '-metadir', metadata, 'AiLedger.tla'],
      sources, deadline - Date.now());
      await writeFile(join(output, `${name}.log`), result.stdout + result.stderr);
      const assessment = { name, ...assessTlc(result, expected), durationMs: Date.now() - caseStarted, outputExceeded: result.outputExceeded };
      if (result.outputExceeded) assessment.passed = false;
      summary.cases.push(assessment);
      console.log(`${assessment.passed ? 'PASS' : 'FAIL'} ${name}${expected ? ` (expected ${expected})` : ''}${assessment.states ? `: ${assessment.states.distinct} states` : ''}`);
      if (!assessment.passed) throw new Error(`${name} did not meet its result contract. See ${join(output, `${name}.log`)}`);
    }
    summary.complete = true;
    summary.passed = true;
  } catch (error) {
    summary.error = error.message;
    throw error;
  } finally {
    summary.durationMs = Date.now() - started;
    await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(`Formal evidence: ${output}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
