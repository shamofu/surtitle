// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';

// Callers own path, symlink and inventory validation. This module only reads bytes.
export function sha256File(path) {
  const digest = createHash('sha256');
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (let length; (length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) {
      digest.update(buffer.subarray(0, length));
    }
    return digest.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}
