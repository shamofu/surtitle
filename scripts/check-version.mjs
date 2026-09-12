import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const tauri = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url)));
const cargo = readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8').match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/)?.[1];
if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.version !== tauri.version || pkg.version !== cargo) throw new Error('package.json, workspace Cargo.toml and tauri.conf.json must have the same explicit release version.');
console.log(`Version ${pkg.version} is consistent.`);
