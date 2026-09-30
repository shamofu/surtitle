import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateRelease } from './release-contract.mjs';
import { publishRelease } from './release.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
function sums(directory) {
  writeFileSync(join(directory, 'SHA256SUMS.txt'), readdirSync(directory).filter(name => name !== 'SHA256SUMS.txt')
    .map(name => `${digest(readFileSync(join(directory, name)))}  ${name}`).join('\n') + '\n');
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'surtitle-release-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of ['surtitle.exe', 'surtitle-source.zip', 'native-runtime-manifest.json', 'js-sbom.cdx.json', 'rust-dependencies.json']) writeFileSync(join(directory, file), file);
  const identity = { installerSha256: digest('surtitle.exe'), applicationSha256: digest('embedded executable') };
  writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify({ version: '0.1.0', installer: 'surtitle.exe', installerSmokePassed: true, ...identity }));
  writeFileSync(join(directory, 'installer-audit.json'), JSON.stringify({ passed: true, ...identity }));
  writeFileSync(join(directory, 'installer-smoke.json'), JSON.stringify({ installerSha256: identity.installerSha256, productionApplicationSha256: identity.applicationSha256 }));
  sums(directory);
  return directory;
}

test('accepts checksum-bound assets and the tested installer without UI or build receipt assertions', t => {
  const directory = fixture(t);
  const archive = Buffer.alloc(2 * 1024 * 1024 + 17, 123);
  archive[archive.length - 1] = 255;
  writeFileSync(join(directory, 'surtitle-source.zip'), archive);
  sums(directory);
  assert.equal(validateRelease(directory, '0.1.0').length, 9);
});

test('rejects changed, missing, duplicate and unlisted release assets', t => {
  const root = fixture(t), source = join(root, 'surtitle-source.zip');
  writeFileSync(source, 'altered'); assert.throws(() => validateRelease(root, '0.1.0'), /checksums/);
  sums(root); writeFileSync(source, ''); assert.throws(() => validateRelease(root, '0.1.0'), /nonempty/);
  rmSync(source); assert.throws(() => validateRelease(root, '0.1.0'), /incomplete/);
  writeFileSync(source, 'source'); sums(root);
  const sumfile = join(root, 'SHA256SUMS.txt'), content = readFileSync(sumfile, 'utf8');
  writeFileSync(sumfile, content + content.split('\n')[0] + '\n'); assert.throws(() => validateRelease(root, '0.1.0'), /duplicate/);
  writeFileSync(sumfile, content);
  writeFileSync(join(root, 'extra.txt'), 'extra'); assert.throws(() => validateRelease(root, '0.1.0'), /checksums/);
});

test('rejects wrong version or evidence from a different installer even with updated checksums', t => {
  const root = fixture(t);
  assert.throws(() => validateRelease(root, '0.2.0'), /version/);
  const path = join(root, 'installer-smoke.json'), smoke = JSON.parse(readFileSync(path));
  smoke.installerSha256 = digest('another installer'); writeFileSync(path, JSON.stringify(smoke)); sums(root);
  assert.throws(() => validateRelease(root, '0.1.0'), /different installer/);
});

const releaseEnv = { GITHUB_REPOSITORY: 'example/surtitle', GITHUB_REF: 'refs/tags/v0.1.0',
  GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'a'.repeat(40) };
function publisher(directory, { existing = null, remoteStates = ['lightweight'], assets,
  draft = true, gitFailure = false, createdReleases } = {}) {
  const calls = [], files = validateRelease(directory, '0.1.0');
  let remoteRead = 0, created = false;
  const run = (program, args, options) => {
    calls.push({ program, args });
    assert.equal(options.shell, false);
    if (program === 'git') {
      assert.deepEqual(args, ['ls-remote', 'origin', 'refs/tags/v0.1.0', 'refs/tags/v0.1.0^{}']);
      if (gitFailure) return { status: 128, stderr: 'Remote access failed' };
      const state = remoteStates[Math.min(remoteRead++, remoteStates.length - 1)];
      let stdout = '';
      if (state === 'lightweight') stdout = `${releaseEnv.GITHUB_SHA}\trefs/tags/v0.1.0\n`;
      if (state === 'annotated') stdout = `${'b'.repeat(40)}\trefs/tags/v0.1.0\n${releaseEnv.GITHUB_SHA}\trefs/tags/v0.1.0^{}\n`;
      if (state === 'moved') stdout = `${'c'.repeat(40)}\trefs/tags/v0.1.0\n`;
      if (state === 'moved-annotated') stdout = `${'b'.repeat(40)}\trefs/tags/v0.1.0\n${'c'.repeat(40)}\trefs/tags/v0.1.0^{}\n`;
      if (state === 'peeled-only') stdout = `${releaseEnv.GITHUB_SHA}\trefs/tags/v0.1.0^{}\n`;
      if (state === 'wrong-ref') stdout = `${releaseEnv.GITHUB_SHA}\trefs/tags/v0.1.00\n`;
      return { status: 0, stdout };
    }
    assert.equal(program, 'gh');
    if (args[0] === 'api') {
      if (args[1] === 'repos/example/surtitle/releases/tags/v0.1.0') {
        return { status: 1, stderr: 'gh: Not Found (HTTP 404)' };
      }
      assert.deepEqual(args, ['api', '--paginate', '--slurp', 'repos/example/surtitle/releases']);
      const releases = created ? createdReleases ?? [{ id: 123, tag_name: 'v0.1.0', draft,
        assets: assets ?? files.map(({ name, size }) => ({ name, size })) }] : existing ? [existing] : [];
      return { status: 0, stdout: JSON.stringify([releases]) };
    }
    assert.equal(args[0], 'release');
    if (args[1] === 'create') created = true;
    return { status: 0, stdout: '' };
  };
  return { calls, run };
}

test.for(['lightweight', 'annotated'])('publishes an existing %s tag when its draft is unavailable by tag', (tagType, t) => {
  const directory = fixture(t), { calls, run } = publisher(directory, { remoteStates: [tagType] });
  assert.equal(publishRelease({ directory, version: '0.1.0', env: releaseEnv, run }), 'v0.1.0');
  const create = calls.find(call => call.args[1] === 'create').args;
  assert.ok(create.includes('--draft'));
  assert.ok(create.includes('--verify-tag'));
  assert.equal(create.includes('--target'), false);
  assert.equal(calls.filter(call => call.program === 'git').length, 2);
  assert.equal(calls.filter(call => call.args.includes('--paginate')).length, 2);
  assert.equal(calls.some(call => call.args.includes('repos/example/surtitle/releases/tags/v0.1.0')), false);
  assert.ok(calls.at(-1).args.includes('--draft=false'));
  assert.equal(calls.at(-2).program, 'git');
});

test.for([
  { reason: 'missing', releases: [] },
  { reason: 'wrong tag', releases: [{ id: 123, tag_name: 'v0.2.0', draft: true }] },
  { reason: 'ambiguous', releases: [{ id: 123, tag_name: 'v0.1.0', draft: true },
    { id: 124, tag_name: 'v0.1.0', draft: true }] },
])('does not publish a $reason draft after upload', ({ releases }, t) => {
  const directory = fixture(t), { calls, run } = publisher(directory, { createdReleases: releases });
  assert.throws(() => publishRelease({ directory, version: '0.1.0', env: releaseEnv, run }), /missing or ambiguous/);
  assert.ok(calls.some(call => call.args[1] === 'create'));
  assert.equal(calls.some(call => call.args.includes('--draft=false')), false);
});

test('does not edit a release published elsewhere during upload', t => {
  const directory = fixture(t), { calls, run } = publisher(directory, { draft: false });
  assert.throws(() => publishRelease({ directory, version: '0.1.0', env: releaseEnv, run }), /publication stopped/);
  assert.equal(calls.some(call => call.args.includes('--draft=false')), false);
});

test.for([false, true])('never overwrites an existing release with draft=%s', (draft, t) => {
  const directory = fixture(t);
  const { calls, run } = publisher(directory, { existing: { tag_name: 'v0.1.0', draft } });
  assert.throws(() => publishRelease({ directory, version: '0.1.0', env: releaseEnv, run }), /already exists/);
  assert.equal(calls.some(call => call.args[0] === 'release'), false);
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

test.for(['missing', 'peeled-only', 'moved', 'moved-annotated', 'wrong-ref'])('does not create a release for a %s remote tag', (state, t) => {
  const directory = fixture(t), { calls, run } = publisher(directory, { remoteStates: [state] });
  assert.throws(() => publishRelease({ directory, version: '0.1.0', env: releaseEnv, run }), /tag.*(missing|differs|invalid)/);
  assert.equal(calls.some(call => call.args[0] === 'release'), false);
});

test.for(['missing', 'moved', 'moved-annotated'])('leaves a draft when its tag becomes %s during upload', (state, t) => {
  const directory = fixture(t), { calls, run } = publisher(directory, { remoteStates: ['annotated', state] });
  assert.throws(() => publishRelease({ directory, version: '0.1.0', env: releaseEnv, run }), /tag.*(missing|differs)/);
  assert.ok(calls.some(call => call.args[1] === 'create'));
  assert.equal(calls.some(call => call.args.includes('--draft=false')), false);
});

test('remote verification failures stop publication', t => {
  const directory = fixture(t), { calls, run } = publisher(directory, { gitFailure: true });
  assert.throws(() => publishRelease({ directory, version: '0.1.0', env: releaseEnv, run }), /Remote access failed/);
  assert.equal(calls.some(call => call.args[0] === 'release'), false);
});

test('incomplete or incorrectly sized draft uploads are not published', t => {
  const directory = fixture(t), files = validateRelease(directory, '0.1.0');
  for (const assets of [[], files.map(({ name, size }) => ({ name, size: size + 1 }))]) {
    const { calls, run } = publisher(directory, { assets });
    assert.throws(() => publishRelease({ directory, version: '0.1.0', env: releaseEnv, run }), /incomplete/);
    assert.equal(calls.some(call => call.args.includes('--draft=false')), false);
  }
});
