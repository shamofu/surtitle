import { readJson as json } from './file-content.mjs';
import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';


export function validateRelease(directory, version) {
  const names = readdirSync(directory).sort();
  const required = ['release-manifest.json', 'surtitle-source.zip',
    'native-runtime-manifest.json', 'js-sbom.cdx.json', 'rust-dependencies.json', 'installer-smoke.json'];
  const installers = names.filter(name => name.endsWith('.exe'));
  if (required.some(name => !names.includes(name)) || installers.length !== 1) throw new Error('Release assets are incomplete or ambiguous');
  for (const name of names) {
    const item = lstatSync(join(directory, name));
    if (!item.isFile() || item.isSymbolicLink() || item.size === 0) throw new Error('Release assets must be nonempty regular files');
  }
  const manifest = json(join(directory, 'release-manifest.json'));
  if (manifest.version !== version || manifest.installer !== installers[0] || manifest.installerSmokePassed !== true) {
    throw new Error('Release version, installer name or smoke result differs');
  }
  return names.map(name => ({ name, path: join(directory, name), size: lstatSync(join(directory, name)).size }));
}
