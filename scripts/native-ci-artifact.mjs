// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const nativeArtifactFiles = Object.freeze([
  'mpv-2.dll', 'libmpv-source.tar.gz', 'onnxruntime-source.tar.gz',
  'libmpv-build-evidence.json', 'onnxruntime-source-inventory.json',
]);
const checksumFile = 'SHA256SUMS.txt';
const check = (condition, message) => { if (!condition) throw new Error(message); };
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

function regular(path, directory = false) {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  const parts = relative(cursor, absolute).split(/[\\/]/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    check(!stat.isSymbolicLink() && (index < parts.length - 1 || directory ? stat.isDirectory() : stat.isFile()),
      'Native path must contain only regular files and directories: ' + path);
  }
  return absolute;
}

export function nativeFileHash(path) {
  const digest = createHash('sha256');
  const descriptor = openSync(regular(path), 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count));
  } finally { closeSync(descriptor); }
  return digest.digest('hex');
}

/** Docker owns native generation; consumers only verify the exported files. */
export function validateNativeArtifact(directory) {
  const root = regular(directory, true);
  const expected = [...nativeArtifactFiles, checksumFile].sort();
  check(JSON.stringify(readdirSync(root).sort()) === JSON.stringify(expected), 'Unexpected or missing native artifact files');
  const sums = new Map();
  for (const line of readFileSync(regular(join(root, checksumFile)), 'utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
    check(match && nativeArtifactFiles.includes(match[2]) && !sums.has(match[2]), 'Invalid native SHA256SUMS');
    sums.set(match[2], match[1]);
  }
  check(sums.size === nativeArtifactFiles.length, 'Incomplete native SHA256SUMS');
  const files = nativeArtifactFiles.map(name => {
    const path = regular(join(root, name));
    const size = lstatSync(path).size;
    check(size > 0, 'Empty native artifact file: ' + name);
    const sha256 = nativeFileHash(path);
    check(sha256 === sums.get(name), 'Native checksum mismatch: ' + name);
    return { name, sha256, size };
  });
  return { directory: root, files };
}

export function consumeNativeArtifact(directory, workspace) {
  const result = validateNativeArtifact(directory);
  const manifestPath = regular(join(workspace, 'native/runtime-windows-x64.json'));
  check(lstatSync(manifestPath).nlink === 1, 'Native manifest must not be hard-linked');
  // Settings, notices and prerequisite changes belong to the current checkout.
  const manifest = json(manifestPath);
  const mpv = manifest.components?.find(component => component.id === 'libmpv');
  const ort = manifest.components?.find(component => component.id === 'onnxruntime');
  check(mpv?.runtimeFiles?.length === 1 && mpv.runtimeFiles[0].target === 'mpv-2.dll' && ort,
    'Native manifest must include libmpv and ONNX Runtime');
  const hashes = Object.fromEntries(result.files.map(file => [file.name, file.sha256]));
  const mpvEvidence = json(join(directory, 'libmpv-build-evidence.json'));
  const ortInventory = json(join(directory, 'onnxruntime-source-inventory.json'));
  check(mpvEvidence.runtime?.sha256 === hashes['mpv-2.dll'], 'libmpv inventory does not match its DLL');
  check(ortInventory.binarySha256 === ort.runtimeFiles?.find(file => file.target === 'onnxruntime.dll')?.sha256,
    'ONNX Runtime sources do not match the selected official DLL');

  const work = join(workspace, 'work');
  if (lstatSync(work, { throwIfNoEntry: false })) regular(work, true);
  else mkdirSync(work);
  const destination = join(work, 'native-ci-artifact');
  if (resolve(directory) !== resolve(destination)) {
    check(!lstatSync(destination, { throwIfNoEntry: false }), 'Native artifact destination must be fresh');
    mkdirSync(destination);
    for (const name of [...nativeArtifactFiles, checksumFile]) copyFileSync(join(directory, name), join(destination, name));
  }
  mpv.localRuntimePath = 'work/native-ci-artifact';
  mpv.runtimeFiles[0].sha256 = hashes['mpv-2.dll'];
  for (const [component, source, inventory] of [
    [mpv, 'libmpv-source.tar.gz', 'libmpv-build-evidence.json'],
    [ort, 'onnxruntime-source.tar.gz', 'onnxruntime-source-inventory.json'],
  ]) {
    component.redistribution.correspondingSource = { path: 'work/native-ci-artifact/' + source, sha256: hashes[source] };
    component.redistribution.dependencyInventory = { path: 'work/native-ci-artifact/' + inventory, sha256: hashes[inventory] };
  }
  delete manifest.buildBinding;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** Inspect the actual extracted source ZIP without regenerating dependencies. */
export function verifyNativeSources(sourceRoot) {
  const root = regular(sourceRoot, true);
  const manifest = json(regular(join(root, 'native/runtime-windows-x64.json')));
  check(Array.isArray(manifest.components) && manifest.components.length > 0, 'Missing native source manifest');
  let checkedFiles = 0;
  for (const component of manifest.components) {
    check(component.redistribution?.correspondingSource && component.redistribution?.dependencyInventory,
      'Missing native source or inventory: ' + component.id);
    for (const [kind, item] of [
      ...['correspondingSource', 'dependencyInventory', 'reviewEvidence']
        .map(field => [field, component.redistribution[field]]).filter(([, item]) => item),
      ...(component.noticeFiles ?? []).map(item => ['notice', item]),
    ]) {
      const name = item.path;
      check(typeof name === 'string' && !isAbsolute(name) && !/[\\:\x00-\x1f]/.test(name)
        && name.split('/').every(part => part && part !== '.' && part !== '..')
        && (kind === 'notice' || name.startsWith('native-sources/')), 'Unsafe native source path');
      check(/^[a-f0-9]{64}$/.test(item.sha256) && nativeFileHash(join(root, name)) === item.sha256,
        'Native source checksum mismatch: ' + name);
      checkedFiles++;
    }
  }
  return { checkedFiles };
}

function main(args) {
  const [command, directory, ...extra] = args;
  check(directory && !extra.length && ['verify', 'consume', 'verify-source'].includes(command),
    'Usage: native-ci-artifact.mjs verify DIRECTORY | consume DIRECTORY | verify-source SOURCE_ROOT');
  if (command === 'verify') validateNativeArtifact(directory);
  if (command === 'consume') consumeNativeArtifact(directory, resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  if (command === 'verify-source') verifyNativeSources(directory);
  console.log('Native ' + command + ' completed.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));