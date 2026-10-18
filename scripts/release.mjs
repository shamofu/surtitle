// This only runs after the same workflow's required jobs.
import { lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateTagEvent } from './check-release.mjs';
import { readJson, sha256File } from './file-content.mjs';

export function validateRelease(directory, version) {
  const names = readdirSync(directory).sort();
  const required = ['release-manifest.json', 'surtitle-source.zip',
    'native-runtime-manifest.json', 'js-sbom.cdx.json', 'rust-dependencies.json', 'installer-smoke.json'];
  const installers = names.filter(name => name.endsWith('.exe'));
  if (required.some(name => !names.includes(name)) || installers.length !== 1) throw new Error('Release assets are incomplete or ambiguous');
  const files = names.map(name => {
    const path = join(directory, name), item = lstatSync(path);
    if (!item.isFile() || item.isSymbolicLink() || item.size === 0) throw new Error('Release assets must be nonempty regular files');
    return { name, path };
  });
  const manifest = readJson(join(directory, 'release-manifest.json'));
  if (manifest.version !== version || manifest.installer !== installers[0] || manifest.installerSmokePassed !== true) {
    throw new Error('Release version, installer name or smoke result differs');
  }
  return files;
}

export function publishRelease({ directory = 'work/artifacts/release', version = readJson('package.json').version,
  env = process.env, run = spawnSync } = {}) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('A valid GitHub repository is required.');
  const { tag, sha } = validateTagEvent(version, env);
  const files = validateRelease(directory, version);
  function command(program, args) {
    const result = run(program, args, { encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${program} failed: ${args[0]}`);
    return result.stdout;
  }
  const ref = `refs/tags/${tag}`;
  const output = command('git', ['ls-remote', 'origin', ref, `${ref}^{}`]);
  const refs = new Map();
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-f0-9]{40})\s+(\S+)$/.exec(line);
    if (!match || ![ref, `${ref}^{}`].includes(match[2]) || refs.has(match[2])) {
      throw new Error('Remote release tag response is invalid.');
    }
    refs.set(match[2], match[1]);
  }
  if (!refs.has(ref)) throw new Error('Release tag is missing from origin; tags are never created by publication.');
  if ((refs.get(`${ref}^{}`) ?? refs.get(ref)) !== sha) {
    throw new Error('Remote release tag differs from the tested commit.');
  }
  const payloads = files.filter(file => file.name.endsWith('.exe') || file.name === 'surtitle-source.zip');
  const temporary = mkdtempSync(join(tmpdir(), 'surtitle-public-release-'));
  try {
    // Checksums accompany the public downloads; they are not a runtime validation gate.
    const checksum = payloads.map(file => `${sha256File(file.path)}  ${file.name}`).join('\n') + '\n';
    const checksumPath = join(temporary, 'SHA256SUMS.txt');
    writeFileSync(checksumPath, checksum);
    // GitHub CLI creates the draft, uploads these assets, then publishes it.
    command('gh', ['release', 'create', tag, '--repo', repo, '--verify-tag', '--generate-notes',
      '--title', `Surtitle ${version}`, '--latest', ...payloads.map(file => file.path), checksumPath]);
    return tag;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--check')) {
    validateRelease('work/artifacts/release', readJson('package.json').version);
    console.log('Release assets are valid.');
  } else publishRelease();
}
