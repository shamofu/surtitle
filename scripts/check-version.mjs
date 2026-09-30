import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function checkVersion(directory = fileURLToPath(new URL('..', import.meta.url))) {
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json')));
  const tauri = JSON.parse(readFileSync(join(directory, 'src-tauri/tauri.conf.json')));
  const cargo = readFileSync(join(directory, 'Cargo.toml'), 'utf8')
    .match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/)?.[1];
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.version !== tauri.version || pkg.version !== cargo) {
    throw new Error('package.json, workspace Cargo.toml and tauri.conf.json must have the same explicit release version.');
  }
  return pkg.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`Version ${checkVersion()} is consistent.`);
}
