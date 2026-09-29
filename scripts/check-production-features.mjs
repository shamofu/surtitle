// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function validateProductionFeatures(tree) {
  const rows = tree.split(/\r?\n/).filter(line => /^surtitle(?:-ai)? v/.test(line));
  if (!rows.some(line => /^surtitle v/.test(line)) || !rows.some(line => /^surtitle-ai v/.test(line))) {
    throw new Error('Production dependency graph is missing the desktop or AI crate');
  }
  for (const row of rows) {
    const features = row.split('|')[1]?.replace(/\s*\(\*\)$/, '').split(',') ?? [];
    if (features.some(feature => ['development-validation', 'e2e-fixtures', 'e2e-test'].includes(feature.trim()))) {
      throw new Error(`Development-only AI feature in production graph: ${row}`);
    }
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = spawnSync('cargo', ['tree', '--locked', '--package', 'surtitle', '--no-default-features', '--features', 'custom-protocol', '--edges', 'normal,build', '--prefix', 'none', '--format', '{p}|{f}'], { encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'cargo tree failed');
  validateProductionFeatures(result.stdout);
  console.log('Production desktop excludes development validation and offline E2E fixtures.');
}
