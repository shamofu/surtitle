// This only runs after the same workflow's required jobs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRelease } from './release-contract.mjs';
import { validateTagEvent } from './check-release.mjs';
import { sha256File } from './file-content.mjs';

export function publishRelease({ directory = 'artifacts/release', version = JSON.parse(readFileSync('package.json')).version,
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
  const gh = args => command('gh', args);
  function pages(endpoint) { return JSON.parse(gh(['api', '--paginate', '--slurp', endpoint])).flat(); }
  function verifyRemoteTag() {
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
  }
  if (pages(`repos/${repo}/releases`).some(release => release.tag_name === tag)) {
    throw new Error('This release already exists, including drafts. Artifacts are never overwritten.');
  }
  verifyRemoteTag();
  const payloads = files.filter(file => file.name.endsWith('.exe') || file.name === 'surtitle-source.zip');
  const temporary = mkdtempSync(join(tmpdir(), 'surtitle-public-release-'));
  try {
    // Keep CI evidence and its complete checksum file intact; stage only the public checksum file.
    const checksum = payloads.map(file => `${sha256File(file.path)}  ${file.name}`).join('\n') + '\n';
    const checksumPath = join(temporary, 'SHA256SUMS.txt');
    writeFileSync(checksumPath, checksum);
    const publicFiles = [...payloads, { name: 'SHA256SUMS.txt', path: checksumPath, size: Buffer.byteLength(checksum) }];
    const notes = `Surtitle ${version}\n\nWindows 11 x64. Unsigned NSIS installer.\nThe installer, SHA-256 checksums and corresponding source accompany this release.`;
    // Leave incomplete uploads as drafts; only publish the complete public asset set.
    gh(['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag', '--title', `Surtitle ${version}`, '--notes', notes, ...publicFiles.map(file => file.path)]);
    // The by-tag endpoint only returns published releases; authenticated lists include drafts.
    const matching = pages(`repos/${repo}/releases`).filter(release => release.tag_name === tag);
    if (matching.length !== 1) throw new Error('New release draft is missing or ambiguous; publication stopped');
    const draft = matching[0];
    if (draft.draft !== true || draft.assets.length !== publicFiles.length) throw new Error('Draft upload is incomplete; publication stopped');
    for (const file of publicFiles) {
      const uploaded = draft.assets.filter(asset => asset.name === file.name);
      if (uploaded.length !== 1 || uploaded[0].size !== file.size) throw new Error(`Uploaded artifact is missing or incomplete: ${file.name}`);
    }
    verifyRemoteTag();
    gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
    return tag;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) publishRelease();
