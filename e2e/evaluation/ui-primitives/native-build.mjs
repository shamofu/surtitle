// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
const output = resolve('work/ui-evaluation/native');
await mkdir(output, { recursive: true });
await build({ configFile: false, root: resolve('e2e/evaluation/ui-primitives'), plugins: [react()], build: { target: 'es2022', outDir: resolve(output, 'dist'), emptyOutDir: true, rollupOptions: { input: resolve('e2e/evaluation/ui-primitives/native.html') } } });
const revision = createHash('sha256').update(await readFile(resolve(output, 'dist/native.html'))).digest('hex').slice(0,12);
await writeFile(resolve(output, 'tauri.json'), JSON.stringify({ productName: 'Surtitle UI Native Evaluation', version:`0.1.5-eval.${revision}`, identifier: 'app.surtitle.evaluation.uinative20261011', build: { beforeBuildCommand: '', frontendDist: '../work/ui-evaluation/native/dist' }, app: { windows: [{ label: 'main', title: 'Surtitle UI Native Evaluation', url: 'native.html', width:1440, height:900, minWidth:1024, minHeight:700, backgroundColor:'#101416' }] } }, null, 2));
console.log(resolve(output, 'tauri.json'));
