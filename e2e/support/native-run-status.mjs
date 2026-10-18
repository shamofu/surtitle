// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactIdentity } from './native-artifacts.mjs';

export function recordNativeRunFailure(stage, error, details = {}, environment = process.env) {
  const directory = join(environment.SURTITLE_E2E_RUN_ARTIFACT_DIR, 'failures');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${artifactIdentity(`${stage}-${details.cid ?? process.pid}`)}.json`);
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, stage, recordedAt: new Date().toISOString(), details,
    failure: { name: error.name, message: String(error.message ?? error), stack: error.stack } }, null, 2)}\n`);
  return path;
}

// WDIO logs and swallows configuration-hook exceptions in each worker. Its
// launcher onComplete hook does propagate failure, after reporters have flushed.
export function assertNativeRunSucceeded(environment = process.env) {
  if (!environment.SURTITLE_E2E_RUN_ARTIFACT_DIR) throw new Error('The native run was not initialized');
  const directory = join(environment.SURTITLE_E2E_RUN_ARTIFACT_DIR, 'failures');
  if (!existsSync(directory)) return;
  const failures = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => {
    const path = join(directory, name);
    const failure = JSON.parse(readFileSync(path, 'utf8'));
    return `${failure.stage}: ${failure.failure.message}; ${path}`;
  });
  if (failures.length) throw new Error(`Native lifecycle failed:\n${failures.join('\n')}`);
}
