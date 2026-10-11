// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Identify the emitted entry point that the native executable must embed. */
export function readFrontendScript(indexPath = resolve('dist/index.html')) {
  const html = readFileSync(indexPath, 'utf8');
  const entries = [...html.matchAll(/<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>/g)]
    .map(match => match[1]);
  assert.equal(entries.length, 1, 'Built frontend must have exactly one module entry point');
  const [entry] = entries;
  assert.match(entry, /^\/assets\/[^/]+\.js$/, 'Built frontend entry must be a local JavaScript asset');
  assert(existsSync(resolve(dirname(indexPath), `.${entry}`)), `Built frontend entry is missing: ${entry}`);
  return entry;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(readFrontendScript());
}
