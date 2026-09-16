// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cacheKeys, compilerInputPaths, prepareCache, sourceInputPaths, sourceTreePath } from './native-ci-cache.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-native-cache-test-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  for (const path of new Set([...compilerInputPaths, ...sourceInputPaths])) write(path, 'fixed input ' + path);
  write(sourceTreePath + '/protobuf/portfile.cmake', 'fixed upstream reference');
  write(sourceTreePath + '/protobuf/build.patch', 'reviewed patch');
  const toolchain = {
    schemaVersion: 1, architecture: 'amd64', packages: ['gcc\t13.2\tamd64', 'ccache\t4.9\tamd64'],
    files: { gcc: { path: '/usr/bin/gcc-13', sha256: 'a'.repeat(64) }, 'gcc/cc1': { path: '/usr/lib/gcc/cc1', sha256: 'b'.repeat(64) } },
    ccacheVersion: 'ccache version 4.9', ccacheConfig: { path: '/etc/surtitle-ccache.conf', sha256: 'c'.repeat(64) },
  };
  const runnerTemp = join(root, 'runner-temp');
  mkdirSync(runnerTemp);
  return { root, write, toolchain, runnerTemp, outputPath: join(root, 'github-output') };
}

test('frontend, documentation, CI and commit changes retain both native cache keys', t => {
  const f = fixture(t), expected = cacheKeys(f.root, f.toolchain);
  for (const path of ['src/app.tsx', 'README.md', '.github/workflows/ci.yml', '.git/HEAD']) {
    f.write(path, 'unrelated new commit content');
  }
  assert.deepEqual(cacheKeys(f.root, f.toolchain), expected);
});

test('compiler contents, compiler internals, packages and trusted ccache configuration invalidate only the compiler key', t => {
  const f = fixture(t), expected = cacheKeys(f.root, f.toolchain);
  for (const change of [
    value => { value.files.gcc.sha256 = 'd'.repeat(64); },
    value => { value.files['gcc/cc1'].sha256 = 'e'.repeat(64); },
    value => { value.packages[0] = 'gcc\t13.3\tamd64'; },
    value => { value.ccacheVersion = 'ccache version 4.10'; },
    value => { value.ccacheConfig.sha256 = 'f'.repeat(64); },
  ]) {
    const toolchain = structuredClone(f.toolchain); change(toolchain);
    const actual = cacheKeys(f.root, toolchain);
    assert.notEqual(actual.compilerKey, expected.compilerKey);
    assert.equal(actual.sourceKey, expected.sourceKey);
  }
});

test('native compile flags invalidate compiler results without discarding identical source archives', t => {
  const f = fixture(t), expected = cacheKeys(f.root, f.toolchain);
  f.write('scripts/native-ci-build-inside.sh', 'changed protoc compiler flags');
  const actual = cacheKeys(f.root, f.toolchain);
  assert.notEqual(actual.compilerKey, expected.compilerKey);
  assert.equal(actual.sourceKey, expected.sourceKey);
});

test('source acquisition changes and source/patch bytes invalidate the relevant cache key', t => {
  const f = fixture(t), expected = cacheKeys(f.root, f.toolchain);
  f.write('scripts/native-ci-inputs.py', 'updated fixed archive checksum');
  const acquisition = cacheKeys(f.root, f.toolchain);
  assert.notEqual(acquisition.sourceKey, expected.sourceKey);
  assert.equal(acquisition.compilerKey, expected.compilerKey);
  f.write('native/build/sources.json', 'new source hash');
  const source = cacheKeys(f.root, f.toolchain);
  assert.notEqual(source.compilerKey, acquisition.compilerKey);
  assert.notEqual(source.sourceKey, acquisition.sourceKey);
  f.write(sourceTreePath + '/protobuf/build.patch', 'changed compiler input patch');
  const patched = cacheKeys(f.root, f.toolchain);
  assert.notEqual(patched.compilerKey, source.compilerKey);
  assert.notEqual(patched.sourceKey, source.sourceKey);
});

test('preparation probes each supplied image offline and emits stable cache paths without image identity in keys', t => {
  const f = fixture(t), calls = [];
  const run = (command, args, options) => {
    calls.push(args);
    assert.equal(command, 'docker');
    assert.deepEqual(args.slice(0, 6), ['run', '--rm', '--network', 'none', '--pull', 'never']);
    assert.deepEqual(args.slice(7, 9), ['python3', '-c']);
    assert.ok(!args.some(value => ['--mount', '-v', '--volume'].includes(value)));
    assert.match(args[9], /file_record\('\/etc\/surtitle-ccache\.conf'\)/);
    assert.match(args[9], /-print-prog-name=/);
    assert.equal(options.timeout, 60_000);
    return { status: 0, stdout: JSON.stringify(f.toolchain) };
  };
  const first = prepareCache('surtitle-native-ci:' + 'a'.repeat(40), { ...f, run });
  assert.equal(first.directory, join(f.runnerTemp, 'surtitle-native-cache-v1'));
  assert.deepEqual(readdirSync(first.directory).sort(), ['compiler', 'ort-archives', 'source-cache']);
  assert.equal(readFileSync(f.outputPath, 'utf8'), `directory=${first.directory}\ncompiler-key=${first.compilerKey}\nsource-key=${first.sourceKey}\n`);
  const otherRunner = join(f.root, 'other-runner'); mkdirSync(otherRunner);
  const second = prepareCache('surtitle-native-ci:' + 'b'.repeat(40), { ...f, runnerTemp: otherRunner, run });
  assert.equal(second.compilerKey, first.compilerKey);
  assert.equal(second.sourceKey, first.sourceKey);
  assert.equal(calls.length, 2);
});

test('missing images, Docker startup errors and malformed fingerprints fail before cache staging exists', t => {
  const f = fixture(t);
  for (const result of [
    { status: 125, stderr: 'No such image' },
    { error: new Error('spawn docker ENOENT') },
    { status: 0, stdout: 'not JSON' },
    { status: 0, stdout: '{}' },
  ]) {
    assert.throws(() => prepareCache('surtitle-native-ci:missing', { ...f, run: () => result }), /fingerprint|native image/);
    assert.equal(existsSync(join(f.runnerTemp, 'surtitle-native-cache-v1')), false);
    assert.equal(existsSync(f.outputPath), false);
  }
});

test('a previous populated staging directory is rejected so stale build trees cannot enter cache restore paths', t => {
  const f = fixture(t), directory = join(f.runnerTemp, 'surtitle-native-cache-v1');
  mkdirSync(directory);
  writeFileSync(join(directory, 'previous-output.dll'), 'must remain untouched');
  assert.throws(() => prepareCache('surtitle-native-ci:prepared', { ...f, run: () => ({ status: 0, stdout: JSON.stringify(f.toolchain) }) }), /absent or empty/);
  assert.equal(readFileSync(join(directory, 'previous-output.dll'), 'utf8'), 'must remain untouched');
  assert.equal(existsSync(f.outputPath), false);
});
