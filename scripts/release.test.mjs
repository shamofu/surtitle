import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateRelease, publishRelease } from './release.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'surtitle-release-'));
  t.onTestFinished(() => rmSync(workspace, { recursive: true, force: true }));
  const directory = join(workspace, 'work/artifacts/release');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  for (const file of ['surtitle.exe', 'surtitle-source.zip', 'native-runtime-manifest.json', 'js-sbom.cdx.json', 'rust-dependencies.json']) writeFileSync(join(directory, file), file);
  writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify({ version: '0.1.0', installer: 'surtitle.exe', installerSmokePassed: true }));
  writeFileSync(join(directory, 'installer-smoke.json'), JSON.stringify({ passed: true }));
  return directory;
}

test('accepts release assets without runtime audits or checksum manifests', t => {
  const directory = fixture(t);
  const archive = Buffer.alloc(2 * 1024 * 1024 + 17, 123);
  archive[archive.length - 1] = 255;
  writeFileSync(join(directory, 'surtitle-source.zip'), archive);
  assert.equal(validateRelease(directory, '0.1.0').length, 7);
});

test('rejects empty, missing and ambiguous release payloads', t => {
  const root = fixture(t), source = join(root, 'surtitle-source.zip');
  writeFileSync(source, ''); assert.throws(() => validateRelease(root, '0.1.0'), /nonempty/);
  rmSync(source); assert.throws(() => validateRelease(root, '0.1.0'), /incomplete/);
  writeFileSync(source, 'source');
  writeFileSync(join(root, 'second.exe'), 'another installer');
  assert.throws(() => validateRelease(root, '0.1.0'), /ambiguous/);
});

test('rejects directories among the release assets', t => {
  const directory = fixture(t);
  mkdirSync(join(directory, 'unexpected-directory'));
  assert.throws(() => validateRelease(directory, '0.1.0'), /regular files/);
});

test('rejects wrong version, installer name and unsuccessful installer smoke', t => {
  const root = fixture(t);
  assert.throws(() => validateRelease(root, '0.2.0'), /version/);
  const path = join(root, 'release-manifest.json'), manifest = JSON.parse(readFileSync(path));
  writeFileSync(path, JSON.stringify({ ...manifest, installer: 'missing.exe' }));
  assert.throws(() => validateRelease(root, '0.1.0'), /installer name/);
  writeFileSync(path, JSON.stringify({ ...manifest, installerSmokePassed: false }));
  assert.throws(() => validateRelease(root, '0.1.0'), /smoke result/);
});

test('--check validates local package assets without release metadata or publication', t => {
  const directory = fixture(t), before = readdirSync(directory);
  const options = { cwd: resolve(directory, '../../..'), encoding: 'utf8', shell: false,
    env: { ...process.env, GITHUB_REPOSITORY: '', GITHUB_REF: '', GITHUB_SHA: '' } };
  const script = fileURLToPath(new URL('./release.mjs', import.meta.url));
  const success = spawnSync(process.execPath, [script, '--check'], options);
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(readdirSync(directory), before);
  writeFileSync(join(directory, 'surtitle-source.zip'), '');
  const invalid = spawnSync(process.execPath, [script, '--check'], options);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /nonempty/);
});

const releaseEnv = { GITHUB_REPOSITORY: 'example/surtitle', GITHUB_REF: 'refs/tags/v0.1.0',
  GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'a'.repeat(40) };
function publisher({ remoteState = 'lightweight', gitFailure = false, createError } = {}) {
  const calls = [], uploads = [];
  const run = (program, args, options) => {
    calls.push({ program, args });
    assert.equal(options.shell, false);
    if (program === 'git') {
      assert.deepEqual(args, ['ls-remote', 'origin', 'refs/tags/v0.1.0', 'refs/tags/v0.1.0^{}']);
      if (gitFailure) return { status: 128, stderr: 'Remote access failed' };
      const refs = {
        lightweight: `${releaseEnv.GITHUB_SHA}\trefs/tags/v0.1.0\n`,
        annotated: `${'b'.repeat(40)}\trefs/tags/v0.1.0\n${releaseEnv.GITHUB_SHA}\trefs/tags/v0.1.0^{}\n`,
        moved: `${'c'.repeat(40)}\trefs/tags/v0.1.0\n`,
        'moved-annotated': `${'b'.repeat(40)}\trefs/tags/v0.1.0\n${'c'.repeat(40)}\trefs/tags/v0.1.0^{}\n`,
        'peeled-only': `${releaseEnv.GITHUB_SHA}\trefs/tags/v0.1.0^{}\n`,
        'wrong-ref': `${releaseEnv.GITHUB_SHA}\trefs/tags/v0.1.00\n`,
        duplicate: `${releaseEnv.GITHUB_SHA}\trefs/tags/v0.1.0\n${releaseEnv.GITHUB_SHA}\trefs/tags/v0.1.0\n`,
        missing: '',
      };
      return { status: 0, stdout: refs[remoteState] };
    }
    assert.equal(program, 'gh');
    assert.deepEqual(args.slice(0, 10), ['release', 'create', 'v0.1.0', '--repo', 'example/surtitle',
      '--verify-tag', '--generate-notes', '--title', 'Surtitle 0.1.0', '--latest']);
    for (const path of args.slice(10)) {
      uploads.push({ path, name: basename(path),
        content: basename(path) === 'SHA256SUMS.txt' ? readFileSync(path, 'utf8') : undefined });
    }
    return createError ? { status: 1, stderr: createError } : { status: 0, stdout: '' };
  };
  return { calls, run, uploads };
}

test.for(['lightweight', 'annotated'])('publishes an existing %s tag using one generated-notes release command', (remoteState, t) => {
  const directory = fixture(t), { calls, run } = publisher({ remoteState });
  assert.equal(publishRelease({ directory, version: '0.1.0', env: releaseEnv, run }), 'v0.1.0');
  assert.deepEqual(calls.map(call => call.program), ['git', 'gh']);
});

test('uploads only installer, corresponding source and public checksums while preserving every internal artifact', t => {
  const directory = fixture(t);
  for (const name of ['native-smoke.json', 'production-smoke.json', 'js-licenses.json', 'extra-private.zip']) {
    writeFileSync(join(directory, name), `Internal evidence: ${name}`);
  }
  const before = new Map(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]));
  const { run, uploads } = publisher();
  assert.equal(publishRelease({ directory, version: '0.1.0', env: releaseEnv, run }), 'v0.1.0');
  assert.deepEqual(uploads.map(file => file.name).sort(), ['SHA256SUMS.txt', 'surtitle-source.zip', 'surtitle.exe']);
  const checksum = uploads.find(file => file.name === 'SHA256SUMS.txt');
  assert.equal(checksum.content, ['surtitle-source.zip', 'surtitle.exe']
    .map(name => `${digest(before.get(name))}  ${name}`).join('\n') + '\n');
  assert.notEqual(checksum.path, join(directory, 'SHA256SUMS.txt'));
  assert.equal(existsSync(dirname(checksum.path)), false);
  for (const file of uploads.filter(file => file.name !== 'SHA256SUMS.txt')) assert.equal(file.path, join(directory, file.name));
  assert.deepEqual(readdirSync(directory).sort(), [...before.keys()].sort());
  for (const [name, content] of before) assert.deepEqual(readFileSync(join(directory, name)), content);
});

test('rejects unsuccessful installer smoke before upload', t => {
  const directory = fixture(t), path = join(directory, 'release-manifest.json');
  const manifest = JSON.parse(readFileSync(path));
  manifest.installerSmokePassed = false;
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => publishRelease({ directory, version: '0.1.0', env: releaseEnv,
    run: () => assert.fail('Smoke result must be checked before external commands') }), /smoke result/);
});

test.for(['Asset upload failed', 'A release with the same tag name already exists'])('propagates GitHub failure: %s', (createError, t) => {
  const directory = fixture(t), originalFiles = readdirSync(directory);
  const { calls, run, uploads } = publisher({ createError });
  assert.throws(() => publishRelease({ directory, version: '0.1.0', env: releaseEnv, run }), { message: createError });
  assert.equal(existsSync(dirname(uploads.find(file => file.name === 'SHA256SUMS.txt').path)), false);
  assert.deepEqual(readdirSync(directory), originalFiles);
  assert.equal(validateRelease(directory, '0.1.0').length, 7);
  assert.deepEqual(calls.map(call => call.program), ['git', 'gh']);
});

test('rejects invalid events, version mismatches, repositories and missing commit SHAs before external commands', t => {
  const directory = fixture(t), run = () => assert.fail('Invalid release input must not invoke Git or GitHub');
  for (const changes of [
    { GITHUB_REF: 'refs/heads/main' }, { GITHUB_REF: 'refs/heads/release' },
    { GITHUB_REF: 'refs/tags/v0.1.0-rc.1' }, { GITHUB_REF: 'refs/tags/v00.1.0' },
    { GITHUB_REF: 'refs/tags/v0.2.0' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_SHA: undefined },
    { GITHUB_REPOSITORY: 'not-a-repository' },
  ]) assert.throws(() => publishRelease({ directory, version: '0.1.0', env: { ...releaseEnv, ...changes }, run }));
});

test.for(['missing', 'peeled-only', 'moved', 'moved-annotated', 'wrong-ref', 'duplicate'])('does not create a release for a %s remote tag', (remoteState, t) => {
  const directory = fixture(t), { calls, run } = publisher({ remoteState });
  assert.throws(() => publishRelease({ directory, version: '0.1.0', env: releaseEnv, run }), /tag.*(missing|differs|invalid)/);
  assert.equal(calls.some(call => call.program === 'gh'), false);
});

test('remote verification failures stop publication', t => {
  const directory = fixture(t), { calls, run } = publisher({ gitFailure: true });
  assert.throws(() => publishRelease({ directory, version: '0.1.0', env: releaseEnv, run }), /Remote access failed/);
  assert.equal(calls.some(call => call.program === 'gh'), false);
});
