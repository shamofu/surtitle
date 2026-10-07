// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatReleaseNotes, generateReleaseNotes } from './release-notes.mjs';

const currentSha = 'a'.repeat(40), firstSha = 'b'.repeat(40), secondSha = 'c'.repeat(40);
const identity = { repo: 'example/surtitle', version: '0.1.2', tag: 'v0.1.2', sha: currentSha };
const published = tag_name => ({ tag_name, draft: false, prerelease: false });
const commits = [{ sha: secondSha, subject: 'fix: 日本語 & playback [details]' }, { sha: currentSha, subject: 'chore: release 0.1.2' }];
const logRecords = records => records.map(commit => `${commit.sha}\0${commit.subject}\0`).join('');

function history({ shallow = false, refs = {}, ancestors = [firstSha], counts = {}, records = commits, override } = {}) {
  const calls = [];
  const run = (program, args, options) => {
    calls.push({ program, args, options });
    assert.equal(program, 'git');
    assert.equal(options.shell, false);
    assert.equal(options.encoding, 'utf8');
    assert.ok(options.timeout > 0 && options.timeout <= 30_000);
    assert.equal(options.maxBuffer, 16 * 1024 * 1024);
    const replaced = override?.(args);
    if (replaced) return replaced;
    if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return { status: 0, stdout: `${shallow}\n` };
    if (args[0] === 'rev-parse') {
      const ref = args[2].replace(/\^\{commit\}$/, '');
      const value = ref === currentSha || ref === 'refs/tags/v0.1.2' ? currentSha : refs[ref] ?? firstSha;
      return { status: 0, stdout: `${value}\n` };
    }
    if (args[0] === 'merge-base') return { status: ancestors.includes(args[2]) ? 0 : 1, stdout: '' };
    if (args[0] === 'rev-list') return { status: 0, stdout: `${counts[args[2]] ?? records.length}\n` };
    if (args[0] === 'log') return { status: 0, stdout: logRecords(records) };
    assert.fail(`Unexpected Git invocation: ${args.join(' ')}`);
  };
  return { run, calls };
}

test('uses the nearest published stable ancestor and preserves subjects with safe Markdown', () => {
  const { run, calls } = history({
    refs: { 'refs/tags/v0.1.0': secondSha, 'refs/tags/v0.1.1': firstSha },
    ancestors: [firstSha, secondSha], counts: { [`${secondSha}..${currentSha}`]: 3 },
  });
  const notes = generateReleaseNotes({ ...identity, releases: [published('v0.1.0'), published('v0.1.1')], run });
  assert.match(notes, /## Changes\n\n/);
  assert.ok(notes.includes(`[ccccccc](https://github.com/example/surtitle/commit/${secondSha}) fix: 日本語 & playback \\[details\\]`));
  assert.ok(notes.indexOf('ccccccc') < notes.indexOf('aaaaaaa'));
  assert.match(notes, /compare\/v0\.1\.1\.\.\.v0\.1\.2/);
  assert.match(notes, /Windows 11 x64\. Unsigned NSIS installer/);
  assert.match(notes, /installer, SHA-256 checksums and corresponding source/);
  assert.deepEqual(calls.at(-1).args, ['log', '--reverse', '--topo-order', '--format=%H%x00%s', '--encoding=UTF-8', '-z', `${firstSha}..${currentSha}`, '--']);
});

test('ignores draft, prerelease, current, higher versions and unpublished tags; non-ancestors cannot be a baseline', () => {
  const unrelated = 'd'.repeat(40);
  const { run, calls } = history({ refs: { 'refs/tags/v0.1.1': unrelated } });
  const releases = [published('v0.1.0'), published('v0.1.1'),
    { ...published('v0.1.1'), draft: true }, { ...published('v0.1.1'), prerelease: true },
    published('v0.1.2'), published('v0.2.0'), published('v0.1.1-rc.1'), published('nightly')];
  const notes = generateReleaseNotes({ ...identity, releases, run });
  assert.match(notes, /compare\/v0\.1\.0\.\.\.v0\.1\.2/);
  const resolved = calls.filter(call => call.args[0] === 'rev-parse').map(call => call.args[2]);
  assert.equal(resolved.includes('refs/tags/v0.2.0^{commit}'), false);
  assert.equal(resolved.includes('refs/tags/nightly^{commit}'), false);
  assert.equal(calls.filter(call => call.args[0] === 'rev-list').length, 1);
});

test('initial releases include all history and an explicit initial-release link', () => {
  const { run, calls } = history({ records: [{ sha: firstSha, subject: 'Initial import' }, ...commits] });
  const notes = generateReleaseNotes({ ...identity, releases: [], run });
  assert.match(notes, /Initial release\./);
  assert.ok(notes.includes(`[bbbbbbb](https://github.com/example/surtitle/commit/${firstSha}) Initial import`));
  assert.ok(notes.includes(`[Full history](https://github.com/example/surtitle/commits/${currentSha})`));
  assert.doesNotMatch(notes, /\/compare\//);
  assert.equal(calls.at(-1).args.at(-2), currentSha);
});

test('equal ancestry distances prefer the higher version, independent of API listing order', () => {
  const { run } = history();
  for (const releases of [[published('v0.1.0'), published('v0.1.1')], [published('v0.1.1'), published('v0.1.0')]]) {
    assert.match(generateReleaseNotes({ ...identity, releases, run }), /compare\/v0\.1\.1\.\.\.v0\.1\.2/);
  }
});

test('rejects unsafe or malformed identities and release records before executing commands', () => {
  const run = () => assert.fail('Invalid input must not invoke Git');
  for (const changes of [{ repo: 'bad/repo/extra' }, { sha: '--all' }, { sha: 'a'.repeat(39) },
    { version: '00.1.2', tag: 'v00.1.2' }, { tag: 'v0.1.2-rc.1' }, { releases: null },
    { releases: [{ tag_name: 'v0.1.0', draft: false }] },
    { releases: [published('v0.1.0'), published('v0.1.0')] }]) {
    assert.throws(() => generateReleaseNotes({ ...identity, releases: [], run, ...changes }));
  }
});

test('stops on shallow or missing history and a current tag that differs from the tested commit', () => {
  assert.throws(() => generateReleaseNotes({ ...identity, releases: [], ...history({ shallow: true }) }), /complete history/);
  for (const result of [{ status: 128, stdout: '', stderr: 'Missing tag; fetch complete history' },
    { status: 0, stdout: `${firstSha}\n` }, { status: 0, stdout: 'not-a-sha\n' }]) {
    const { run } = history({ override: args => args[2] === 'refs/tags/v0.1.2^{commit}' ? result : undefined });
    assert.throws(() => generateReleaseNotes({ ...identity, releases: [], run }), /history|tested commit|malformed/);
  }
  const { run } = history({ override: args => args[2] === 'refs/tags/v0.1.0^{commit}' ? { status: 128, stdout: '', stderr: 'Missing published baseline tag' } : undefined });
  assert.throws(() => generateReleaseNotes({ ...identity, releases: [published('v0.1.0')], run }), /Missing published baseline/);
});

test('propagates Git timeouts and unexpected ancestry errors instead of treating them as an initial release', () => {
  for (const result of [{ status: null, stdout: '', error: new Error('Git ETIMEDOUT') }, { status: 128, stdout: '', stderr: 'Corrupt history' }]) {
    const { run } = history({ override: args => args[0] === 'merge-base' ? result : undefined });
    assert.throws(() => generateReleaseNotes({ ...identity, releases: [published('v0.1.0')], run }), /ETIMEDOUT|Corrupt history/);
  }
});

test('rejects truncated, duplicate or mismatched commit history instead of publishing a partial list', () => {
  for (const output of [logRecords(commits).slice(0, -1), `bad-sha\0subject\0`, logRecords([commits[0], commits[0]]),
    logRecords([{ sha: secondSha, subject: 'Missing current commit' }])]) {
    const { run } = history({ override: args => args[0] === 'log' ? { status: 0, stdout: output } : undefined });
    assert.throws(() => generateReleaseNotes({ ...identity, releases: [published('v0.1.0')], run }), /malformed|duplicated|incomplete/);
  }
  const { run } = history({ counts: { [`${firstSha}..${currentSha}`]: 3 } });
  assert.throws(() => generateReleaseNotes({ ...identity, releases: [published('v0.1.0')], run }), /incomplete/);
});

test('pure formatting rejects an invalid baseline and escapes HTML or Markdown without changing subjects', () => {
  assert.throws(() => formatReleaseNotes({ ...identity, previousTag: 'v0.2.0', commits }), /earlier stable/);
  const notes = formatReleaseNotes({ ...identity, previousTag: 'v0.1.1', commits: [{ sha: currentSha, subject: 'fix: <script> and **links**' }] });
  assert.ok(notes.includes('fix: \\<script\\> and \\*\\*links\\*\\*'));
});

test('real Git history peels annotated release tags and excludes unpublished and unrelated changes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'surtitle-release-notes-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // Personal signing, hooks and inherited Git paths must not affect this fixture.
  const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(directory, 'empty-global-config'), GIT_CONFIG_COUNT: '0' };
  const git = args => {
    const result = spawnSync('git', args, { cwd: directory, env: gitEnv, encoding: 'utf8', shell: false, timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--initial-branch=main']);
  git(['config', 'user.name', 'Release test']);
  git(['config', 'user.email', 'release-test@example.invalid']);
  const commit = subject => { git(['commit', '--allow-empty', '-m', subject]); return git(['rev-parse', 'HEAD']); };
  const initial = commit('Initial import');
  git(['tag', '-a', 'v0.1.0', '-m', 'First release']);
  commit('Previously released');
  git(['tag', '-a', 'v0.1.1', '-m', 'Second release']);
  const improvement = commit('fix: 日本語 & playback');
  git(['tag', 'v0.1.2']); // A tag alone is not a published release.
  git(['checkout', '-b', 'unrelated', initial]);
  commit('Unrelated branch');
  git(['tag', 'v0.2.0']);
  git(['checkout', 'main']);
  const sha = commit('chore: release 0.3.0');
  git(['tag', '-a', 'v0.3.0', '-m', 'Current release']);
  const notes = generateReleaseNotes({ repo: identity.repo, version: '0.3.0', tag: 'v0.3.0', sha,
    releases: [published('v0.2.0'), published('v0.1.0'), published('v0.1.1')], cwd: directory,
    run: (program, args, options) => spawnSync(program, args, { ...options, env: gitEnv }) });
  assert.match(notes, /compare\/v0\.1\.1\.\.\.v0\.3\.0/);
  assert.ok(notes.includes(`/commit/${improvement}`));
  assert.ok(notes.includes(`/commit/${sha}`));
  assert.doesNotMatch(notes, /Initial import|Previously released|Unrelated branch/);
  assert.ok(notes.indexOf('日本語 & playback') < notes.indexOf('chore: release 0.3.0'));
}, 30_000);
