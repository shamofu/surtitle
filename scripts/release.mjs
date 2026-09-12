// This only runs after the same workflow's required jobs.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { validateRelease } from './release-contract.mjs';
const version = JSON.parse(readFileSync('package.json')).version;
const sha = process.env.GITHUB_SHA;
const repo = process.env.GITHUB_REPOSITORY;
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || process.env.GITHUB_REF !== 'refs/heads/release' || process.env.GITHUB_EVENT_NAME !== 'push') throw new Error('Only a release branch push can publish.');
const files = validateRelease('artifacts/release', sha, version);
const tag = `v${version}`;
function gh(args, input) {
  const result = spawnSync('gh', args, { input, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `gh failed: ${args[0]}`);
  return result.stdout;
}
function pages(endpoint) { return JSON.parse(gh(['api', '--paginate', '--slurp', endpoint])).flat(); }
function tagCommit(object) {
  for (let depth = 0; object.type === 'tag'; depth++) {
    if (depth === 8) throw new Error('Excessively nested annotated tag');
    object = JSON.parse(gh(['api', `repos/${repo}/git/tags/${object.sha}`])).object;
  }
  if (object.type !== 'commit') throw new Error('Release tag does not reference a commit');
  return object.sha;
}
function findTag() { return pages(`repos/${repo}/git/matching-refs/tags/${tag}`).find(ref => ref.ref === `refs/tags/${tag}`); }
const existing = findTag();
if (existing && tagCommit(existing.object) !== sha) throw new Error(`${tag} points to another commit; bump the version on main.`);
if (pages(`repos/${repo}/releases`).some(release => release.tag_name === tag)) throw new Error('This release already exists, including drafts. Artifacts are never overwritten.');
if (!existing) gh(['api', `repos/${repo}/git/refs`, '--input', '-'], JSON.stringify({ ref: `refs/tags/${tag}`, sha }));
const notes = `Surtitle ${version}\n\nWindows 11 x64. Unsigned NSIS installer.\nAll required checks passed for ${sha}.\nLicenses, SBOM and corresponding-source records accompany this release.`;
// Incomplete uploads remain drafts. Verify server-side digests before publication.
gh(['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag', '--target', sha, '--title', `Surtitle ${version}`, '--notes', notes, ...files.map(file => file.path)]);
const draft = JSON.parse(gh(['api', `repos/${repo}/releases/tags/${tag}`]));
if (draft.draft !== true || draft.assets.length !== files.length) throw new Error('Draft upload is incomplete; publication stopped');
for (const file of files) {
  const uploaded = draft.assets.find(asset => asset.name === file.name);
  if (!uploaded || uploaded.size !== file.size || uploaded.digest !== `sha256:${file.sha256}`) throw new Error(`Uploaded artifact failed digest verification: ${file.name}`);
}
const finalTag = findTag();
if (!finalTag || tagCommit(finalTag.object) !== sha) throw new Error('Release tag changed during upload');
gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
