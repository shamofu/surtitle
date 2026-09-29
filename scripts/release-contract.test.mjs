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

test('publishes through a complete draft and never overwrites an existing tag or release', t => {
  const directory = fixture(t), files = validateRelease(directory, '0.1.0');
  const env = { GITHUB_REPOSITORY: 'example/surtitle', GITHUB_REF: 'refs/heads/release', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'a'.repeat(40) };
  for (const existing of ['tag', 'release', null]) {
    const calls = [];
    const run = (_, args) => {
      calls.push(args);
      let output = '';
      if (args.includes('--paginate')) output = JSON.stringify([args.at(-1).includes('matching-refs')
        ? (existing === 'tag' ? [{ ref: 'refs/tags/v0.1.0' }] : []) : (existing === 'release' ? [{ tag_name: 'v0.1.0' }] : [])]);
      else if (args[0] === 'api') output = JSON.stringify({ draft: true, assets: files.map(({ name, size }) => ({ name, size })) });
      return { status: 0, stdout: output };
    };
    if (existing) {
      assert.throws(() => publishRelease({ directory, version: '0.1.0', env, run }), /already exists/);
      assert.equal(calls.some(args => args[0] === 'release'), false);
    } else {
      assert.equal(publishRelease({ directory, version: '0.1.0', env, run }), 'v0.1.0');
      assert.ok(calls.find(args => args[1] === 'create').includes('--draft'));
      assert.ok(calls.at(-1).includes('--draft=false'));
    }
  }
});

test('incomplete draft uploads are not published', t => {
  const directory = fixture(t), calls = [];
  const run = (_, args) => { calls.push(args); return { status: 0, stdout: args.includes('--paginate') ? '[[]]' : JSON.stringify({ draft: true, assets: [] }) }; };
  assert.throws(() => publishRelease({ directory, version: '0.1.0', env: { GITHUB_REPOSITORY: 'example/repo', GITHUB_REF: 'refs/heads/release', GITHUB_EVENT_NAME: 'push' }, run }), /incomplete/);
  assert.equal(calls.some(args => args.includes('--draft=false')), false);
});
