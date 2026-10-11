// SPDX-License-Identifier: GPL-3.0-or-later
// Compile an isolated entry for each candidate, with identical providers and fields.
import { mkdir, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const source = await readFile('e2e/evaluation/ui-primitives/main.tsx', 'utf8');
const html = await readFile('e2e/evaluation/ui-primitives/index.html', 'utf8');
const results = [];
for (const candidate of ['current', 'base', 'aria', 'radix']) {
  const root = resolve('work/ui-evaluation', candidate);
  await mkdir(root, { recursive: true });
  const isolated = source.replace(/const requested =[^\n]+\nconst candidate:[^\n]+/, `const candidate: Candidate = '${candidate}';`);
  await writeFile(resolve(root, 'main.tsx'), isolated);
  await writeFile(resolve(root, 'index.html'), html);
  await cp('e2e/evaluation/ui-primitives/style.css', resolve(root, 'style.css'));
  await cp('e2e/evaluation/ui-primitives/baseline-ui.tsx', resolve(root, 'baseline-ui.tsx'));
  await cp('e2e/evaluation/ui-primitives/baseline-modal-motion.css', resolve(root, 'baseline-modal-motion.css'));
  await build({ configFile: false, root, plugins: [react()], logLevel: 'warn', build: { target: 'es2022', outDir: 'dist' } });
  const assets = resolve(root, 'dist/assets');
  const result = { candidate, jsBytes: 0, gzipBytes: 0 };
  for (const file of await readdir(assets)) {
    if (!file.endsWith('.js')) continue;
    const buffer = await readFile(resolve(assets, file));
    result.jsBytes += buffer.length;
    result.gzipBytes += gzipSync(buffer).length;
  }
  results.push(result);
}
await writeFile('work/ui-evaluation/results/bundles.json', JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
