import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkVersion, checkRelease, validateTagEvent, checkSourceRevision } from './check-release.mjs';

const version = '0.1.0';
const environment = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.1.0', GITHUB_SHA: 'a'.repeat(40) };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'surtitle-release-inputs-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'Cargo.toml'), `[workspace.package]\nversion = "${version}"\n`);
  return directory;
}

function git(directory, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
  { cwd: directory, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim();
}

function repository(t, annotated = false) {
  const directory = fixture(t);
  git(directory, 'init', '--initial-branch=main');
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', 'Release version');
  const sha = git(directory, 'rev-parse', 'HEAD');
  git(directory, 'update-ref', 'refs/remotes/origin/main', sha);
  if (annotated) git(directory, 'tag', '-a', 'v0.1.0', '-m', 'Surtitle 0.1.0');
  else git(directory, 'tag', 'v0.1.0');
  git(directory, 'checkout', '--detach', 'v0.1.0');
  return { directory, env: { ...environment, GITHUB_SHA: sha } };
}

test('checks versions for branch and PR runs without querying Git', t => {
  const directory = fixture(t);
  const run = () => assert.fail('Branch and PR checks must not query release refs');
  assert.equal(checkVersion(directory), version);
  for (const env of [
    { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' },
    { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/17/merge' },
    {},
  ]) assert.equal(checkRelease({ directory, env, run }), version);
});

test('version-only checks do not require release event metadata or Git refs', t => {
  const directory = fixture(t);
  assert.equal(checkRelease({ directory, versionOnly: true, env: { GITHUB_REF: 'refs/tags/invalid' },
    run: () => assert.fail('Version-only checks must not query Git') }), version);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-release.mjs', import.meta.url)), '--version-only'],
    { encoding: 'utf8', shell: false, env: { ...process.env, GITHUB_REF: 'refs/tags/invalid' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Version .* is consistent/);
});

test('uses the workspace version independently of legacy JavaScript and Tauri metadata', t => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '8.0.0' }));
  assert.equal(checkVersion(directory), version);
});

test('rejects missing or unsupported workspace versions before querying release refs', t => {
  const directory = fixture(t);
  const run = () => assert.fail('Invalid versions must stop before Git');
  for (const content of [
    '[package]\nversion = "0.1.0"\n',
    '[workspace.package]\nversion = "0.1.0-rc.1"\n',
    '[workspace.package]\nversion = "00.1.0"\n',
    '[workspace.package]\nlicense = "MIT"\n[package]\nversion = "0.1.0"\n',
  ]) {
    writeFileSync(join(directory, 'Cargo.toml'), content);
    assert.throws(() => checkRelease({ directory, env: environment, run }), /workspace.*version/i);
  }
});

test('requires a canonical stable version tag, push event and full commit SHA', () => {
  for (const GITHUB_REF of ['refs/heads/main', 'refs/heads/release', 'refs/tags/0.1.0',
    'refs/tags/v01.1.0', 'refs/tags/v0.01.0', 'refs/tags/v0.1.00', 'refs/tags/v0.1',
    'refs/tags/v0.1.0-rc.1', 'refs/tags/v0.1.0+build', 'refs/tags/v0.1.0/extra', undefined]) {
    assert.throws(() => validateTagEvent(version, { ...environment, GITHUB_REF }), /canonical/);
  }
  for (const GITHUB_EVENT_NAME of ['pull_request', 'workflow_dispatch', 'release', undefined]) {
    assert.throws(() => validateTagEvent(version, { ...environment, GITHUB_EVENT_NAME }), /canonical/);
  }
  assert.throws(() => validateTagEvent('0.2.0', environment), /version differ/);
  for (const GITHUB_SHA of [undefined, '', 'a'.repeat(7), 'z'.repeat(40), '--help']) {
    assert.throws(() => validateTagEvent(version, { ...environment, GITHUB_SHA }), /full commit SHA/);
  }
  assert.deepEqual(validateTagEvent(version, environment), { tag: 'v0.1.0', sha: environment.GITHUB_SHA });
});

test.for([false, true])('accepts a main commit with annotated=%s tag', (annotated, t) => {
  const options = repository(t, annotated);
  assert.equal(checkRelease(options), version);
});

test('accepts a released ancestor after main advances', t => {
  const options = repository(t, true);
  git(options.directory, 'checkout', 'main');
  writeFileSync(join(options.directory, 'next.txt'), 'Later main development');
  git(options.directory, 'add', 'next.txt');
  git(options.directory, 'commit', '-m', 'Continue development');
  git(options.directory, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(options.directory, 'checkout', '--detach', 'v0.1.0');
  assert.equal(checkRelease(options), version);
});

test('rejects a tagged commit not contained in main', t => {
  const options = repository(t);
  git(options.directory, 'checkout', '-b', 'unmerged');
  writeFileSync(join(options.directory, 'unmerged.txt'), 'Not on main');
  git(options.directory, 'add', 'unmerged.txt');
  git(options.directory, 'commit', '-m', 'Unmerged change');
  git(options.directory, 'tag', '-f', 'v0.1.0');
  options.env.GITHUB_SHA = git(options.directory, 'rev-parse', 'HEAD');
  assert.throws(() => checkRelease(options), /contained in origin\/main/);
});

test('rejects mismatched checkout, moved tag and missing refs', t => {
  const options = repository(t);
  assert.throws(() => checkRelease({ ...options, env: { ...options.env, GITHUB_SHA: 'b'.repeat(40) } }), /triggered commit/);
  git(options.directory, 'checkout', 'main');
  writeFileSync(join(options.directory, 'next.txt'), 'Changed checkout');
  git(options.directory, 'add', 'next.txt');
  git(options.directory, 'commit', '-m', 'Next commit');
  git(options.directory, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  options.env.GITHUB_SHA = git(options.directory, 'rev-parse', 'HEAD');
  assert.throws(() => checkRelease(options), /triggered commit/);
  git(options.directory, 'tag', '-f', 'v0.1.0');
  git(options.directory, 'update-ref', '-d', 'refs/remotes/origin/main');
  assert.throws(() => checkRelease(options), /contained in origin\/main/);
  git(options.directory, 'tag', '-d', 'v0.1.0');
  assert.throws(() => checkRelease(options), /revision|argument|valid|failed/i);
});

test('a tag ref from a non-push event cannot use branch validation', t => {
  const directory = fixture(t);
  assert.throws(() => checkRelease({ directory, env: { ...environment, GITHUB_EVENT_NAME: 'workflow_dispatch' },
    run: () => assert.fail('Invalid event must stop before Git') }), /canonical/);
});

test('source packaging refuses modified, staged and untracked source instead of archiving an unrelated HEAD', t => {
  const options = repository(t);
  const check = () => checkSourceRevision({ directory: options.directory, revision: 'HEAD' });
  assert.equal(check(), options.env.GITHUB_SHA);
  const cargo = join(options.directory, 'Cargo.toml');
  writeFileSync(cargo, '[workspace.package]\nversion = "0.2.0"\n');
  assert.throws(check, /clean source tree/);
  git(options.directory, 'add', 'Cargo.toml');
  assert.throws(check, /clean source tree/);
  git(options.directory, 'reset', '--hard', 'HEAD');
  writeFileSync(join(options.directory, 'new-source.rs'), '// untracked application source');
  assert.throws(check, /clean source tree/);
});

test('source packaging requires the checkout to be the exact tested revision', t => {
  const options = repository(t);
  writeFileSync(join(options.directory, 'next.txt'), 'new revision');
  git(options.directory, 'add', 'next.txt');
  git(options.directory, 'commit', '-m', 'Next revision');
  assert.throws(() => checkSourceRevision({ directory: options.directory, revision: options.env.GITHUB_SHA }), /tested revision/);
});
