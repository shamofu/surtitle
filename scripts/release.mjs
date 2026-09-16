// This only runs after the same workflow's required jobs.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateReleaseForPublish } from './release-contract.mjs';
export function publishRelease({ directory = 'artifacts/release', version = JSON.parse(readFileSync('package.json')).version,
  env = process.env, run = spawnSync } = {}) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || env.GITHUB_REF !== 'refs/heads/release' || env.GITHUB_EVENT_NAME !== 'push') throw new Error('Only a release branch push can publish.');
  const files = validateReleaseForPublish(directory, version);
  const target = env.GITHUB_SHA || 'release';
  const tag = `v${version}`;
  function gh(args, input) {
    const result = run('gh', args, { input, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `gh failed: ${args[0]}`);
    return result.stdout;
  }
  function pages(endpoint) { return JSON.parse(gh(['api', '--paginate', '--slurp', endpoint])).flat(); }
  const existing = pages(`repos/${repo}/git/matching-refs/tags/${tag}`).some(ref => ref.ref === `refs/tags/${tag}`);
  if (existing) throw new Error(`${tag} already exists; bump the version on main. Tags are never overwritten.`);
  if (pages(`repos/${repo}/releases`).some(release => release.tag_name === tag)) throw new Error('This release already exists, including drafts. Artifacts are never overwritten.');
  const notes = `Surtitle ${version}\n\nWindows 11 x64. Unsigned NSIS installer.\nLicenses, SBOM and corresponding-source records accompany this release.`;
  // Leave incomplete uploads as drafts; only publish the complete asset set.
  gh(['release', 'create', tag, '--repo', repo, '--draft', '--target', target, '--title', `Surtitle ${version}`, '--notes', notes, ...files.map(file => file.path)]);
  const draft = JSON.parse(gh(['api', `repos/${repo}/releases/tags/${tag}`]));
  if (draft.draft !== true || draft.assets.length !== files.length) throw new Error('Draft upload is incomplete; publication stopped');
  for (const file of files) {
    const uploaded = draft.assets.filter(asset => asset.name === file.name);
    if (uploaded.length !== 1 || uploaded[0].size !== file.size) throw new Error(`Uploaded artifact is missing or incomplete: ${file.name}`);
  }
  gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
  return tag;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) publishRelease();
