import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

function hash(path) {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, 'r');
  try {
    for (let length; (length = readSync(descriptor, buffer)) > 0;) {
      digest.update(buffer.subarray(0, length));
    }
    return digest.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

export function validateRelease(directory, version) {
  const names = readdirSync(directory).sort();
  const required = ['release-manifest.json', 'SHA256SUMS.txt', 'surtitle-source.zip',
    'native-runtime-manifest.json', 'js-sbom.cdx.json', 'rust-dependencies.json', 'installer-audit.json', 'installer-smoke.json'];
  const installers = names.filter(name => name.endsWith('.exe'));
  if (required.some(name => !names.includes(name)) || installers.length !== 1) throw new Error('Release assets are incomplete or ambiguous');
  for (const name of names) {
    const item = lstatSync(join(directory, name));
    if (!item.isFile() || item.isSymbolicLink() || item.size === 0) throw new Error('Release assets must be nonempty regular files');
  }
  const sums = new Map();
  for (const line of readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8').trimEnd().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([^\\/:\x00-\x1f]+)$/.exec(line);
    if (!match || match[2] === 'SHA256SUMS.txt' || sums.has(match[2])) throw new Error('Invalid or duplicate release checksum entry');
    sums.set(match[2], match[1]);
  }
  if (sums.size !== names.length - 1 || names.some(name => name !== 'SHA256SUMS.txt'
      && sums.get(name) !== hash(join(directory, name)))) throw new Error('Release asset checksums do not match');
  const manifest = json(join(directory, 'release-manifest.json'));
  if (manifest.version !== version || manifest.installer !== installers[0] || manifest.installerSmokePassed !== true
      || manifest.installerSha256 !== sums.get(installers[0]) || !/^[a-f0-9]{64}$/.test(manifest.applicationSha256 ?? '')) {
    throw new Error('Release version or verified installer identity differs');
  }
  const audit = json(join(directory, 'installer-audit.json'));
  const smoke = json(join(directory, 'installer-smoke.json'));
  if (audit.passed !== true || audit.installerSha256 !== manifest.installerSha256
      || audit.applicationSha256 !== manifest.applicationSha256 || smoke.installerSha256 !== manifest.installerSha256
      || smoke.productionApplicationSha256 !== manifest.applicationSha256) throw new Error('Installer evidence identifies a different installer or application');
  return names.map(name => ({ name, path: join(directory, name), size: lstatSync(join(directory, name)).size }));
}
