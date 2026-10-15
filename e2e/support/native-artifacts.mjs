// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export function artifactIdentity(value) {
  const label = String(value).replace(/[^a-z0-9.-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'unnamed';
  return `${label}-${createHash('sha256').update(String(value)).digest('hex').slice(0, 8)}`;
}

export function nativeArtifact(name) {
  if (!name || /[\\/]/.test(name) || basename(name) !== name || name === '.' || name === '..') throw new Error('Native artifact must be a plain file name');
  const directory = resolve(process.env.SURTITLE_E2E_ARTIFACT_DIR || 'test-results/native', process.env.SURTITLE_E2E_TEST_ID || 'session');
  mkdirSync(directory, { recursive: true });
  return resolve(directory, name);
}
