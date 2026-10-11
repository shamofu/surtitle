// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const requiredFiles = ['mpv-2.dll', 'libmpv-source.tar.gz', 'onnxruntime-source.tar.gz'];
const optionalFiles = ['libmpv-build-evidence.json', 'onnxruntime-source-inventory.json'];
export const nativeArtifactFiles = Object.freeze([...requiredFiles, ...optionalFiles]);
const check = (condition, message) => { if (!condition) throw new Error(message); };

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

/** Stage build output at the manifest's fixed paths without rewriting tracked files. */
export function consumeNativeArtifact(directory, workspace) {
  const root = regular(directory, true);
  const files = nativeArtifactFiles.filter(name => requiredFiles.includes(name) || lstatSync(join(root, name), { throwIfNoEntry: false }));
  for (const name of files) {
    const path = regular(join(root, name));
    check(lstatSync(path).size > 0, 'Empty native artifact file: ' + name);
  }
  const work = join(regular(workspace, true), 'work');
  if (lstatSync(work, { throwIfNoEntry: false })) regular(work, true);
  else mkdirSync(work);
  const destination = join(work, 'native-ci-artifact');
  if (root !== resolve(destination)) {
    check(!lstatSync(destination, { throwIfNoEntry: false }), 'Native artifact destination must be fresh');
    mkdirSync(destination);
    for (const name of files) copyFileSync(join(root, name), join(destination, name));
  }
  return { directory: destination, files };
}

function main(args) {
  const [command, directory, ...extra] = args;
  check(command === 'consume' && directory && !extra.length,
    'Usage: native-ci-artifact.mjs consume DIRECTORY');
  consumeNativeArtifact(directory, resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
  console.log('Native build output staged.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
