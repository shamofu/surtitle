// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';

const shaPattern = /^[a-f0-9]{40}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const maxBuffer = 16 * 1024 * 1024;

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 50 || !versionPattern.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function validateIdentity({ repo, version, tag, sha }) {
  if (typeof repo !== 'string' || repo.length > 200 || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('A valid GitHub repository is required for release notes.');
  }
  const parts = parseVersion(version);
  if (!parts || tag !== `v${version}`) throw new Error('Release notes require a matching stable version and tag.');
  if (typeof sha !== 'string' || !shaPattern.test(sha)) throw new Error('Release notes require a full commit SHA.');
  return parts;
}

function validateCommits(commits) {
  if (!Array.isArray(commits)) throw new Error('Release commit records must be an array.');
  const seen = new Set();
  for (const commit of commits) {
    if (!commit || typeof commit !== 'object' || typeof commit.sha !== 'string' || !shaPattern.test(commit.sha) ||
      typeof commit.subject !== 'string' || !commit.subject.trim() || /[\x00-\x1f\x7f]/.test(commit.subject) || seen.has(commit.sha)) {
      throw new Error('Release commit records are malformed or duplicated.');
    }
    seen.add(commit.sha);
  }
}

// Escape presentation syntax without translating or rewriting Git subjects.
const markdownText = text => text.replace(/[\\`*_{}\[\]<>()!|#~]/g, '\\$&');

export function formatReleaseNotes({ repo, version, tag, sha, previousTag = null, commits }) {
  const currentVersion = validateIdentity({ repo, version, tag, sha });
  if (previousTag !== null) {
    const previousVersion = typeof previousTag === 'string' && previousTag.startsWith('v') && parseVersion(previousTag.slice(1));
    if (!previousVersion || compareVersions(previousVersion, currentVersion) >= 0) {
      throw new Error('Release notes require an earlier stable baseline tag.');
    }
  }
  validateCommits(commits);
  const baseUrl = `https://github.com/${repo}`;
  const changes = previousTag === null ? ['Initial release.', ''] : [];
  changes.push(...commits.map(commit => `- [${commit.sha.slice(0, 7)}](${baseUrl}/commit/${commit.sha}) ${markdownText(commit.subject)}`));
  if (!commits.length) changes.push('No commits since the previous release.');
  const historyLink = previousTag === null
    ? `[Full history](${baseUrl}/commits/${sha})`
    : `[Full changelog](${baseUrl}/compare/${previousTag}...${tag})`;
  return [
    `Surtitle ${version}`, '',
    'Windows 11 x64. Unsigned NSIS installer.',
    'The installer, SHA-256 checksums and corresponding source accompany this release.', '',
    '## Changes', '', ...changes, '', historyLink, '',
  ].join('\n');
}

function parseCommitLog(output) {
  if (output === '') return [];
  if (!output.endsWith('\0')) throw new Error('Git release history is malformed.');
  const fields = output.slice(0, -1).split('\0');
  if (fields.length % 2 !== 0) throw new Error('Git release history is malformed.');
  const commits = [];
  for (let index = 0; index < fields.length; index += 2) {
    commits.push({ sha: fields[index], subject: fields[index + 1] });
  }
  validateCommits(commits);
  return commits;
}

/**
 * Generate English notes from complete local history and GitHub release records.
 * Checkout must fetch all history and tags (fetch-depth: 0). The nearest baseline
 * is the published stable ancestor with the fewest commits in its difference;
 * equal distances prefer the higher version. No tags or releases are changed.
 */
export function generateReleaseNotes({ repo, version, tag, sha, releases, run = spawnSync, cwd = process.cwd() }) {
  const currentVersion = validateIdentity({ repo, version, tag, sha });
  if (!Array.isArray(releases) || releases.length > 10_000) throw new Error('Published release records must be a bounded array.');
  const candidates = [], seen = new Set();
  for (const release of releases) {
    if (!release || typeof release !== 'object' || typeof release.tag_name !== 'string' ||
      !release.tag_name || release.tag_name.length > 200 || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') {
      throw new Error('Published release records are malformed.');
    }
    const previousVersion = release.tag_name.startsWith('v') && parseVersion(release.tag_name.slice(1));
    if (release.draft || release.prerelease || !previousVersion || release.tag_name === tag || compareVersions(previousVersion, currentVersion) >= 0) continue;
    if (seen.has(release.tag_name)) throw new Error('Published release baseline tags are duplicated.');
    seen.add(release.tag_name);
    candidates.push({ tag: release.tag_name, version: previousVersion });
  }
  if (candidates.length > 1_000) throw new Error('There are too many published baseline tags to inspect.');
  // Both individual commands and the entire history inspection have deadlines.
  const deadline = Date.now() + 90_000;
  function command(args, allowedStatuses = [0]) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Release history inspection timed out.');
    const result = run('git', args, { cwd, encoding: 'utf8', shell: false, timeout: Math.min(30_000, remaining), maxBuffer });
    if (!result || result.error || !allowedStatuses.includes(result.status)) {
      throw new Error(result?.error?.message || result?.stderr || `Git release history failed: ${args[0]}. Fetch complete history and tags.`);
    }
    if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > maxBuffer) {
      throw new Error('Git release history output is missing or too large.');
    }
    return result;
  }
  function resolveCommit(ref) {
    const value = command(['rev-parse', '--verify', `${ref}^{commit}`]).stdout.trim();
    if (!shaPattern.test(value)) throw new Error('Git returned a malformed release commit SHA.');
    return value;
  }
  if (command(['rev-parse', '--is-shallow-repository']).stdout.trim() !== 'false') {
    throw new Error('Release notes require complete history; use checkout fetch-depth: 0.');
  }
  if (resolveCommit(sha) !== sha || resolveCommit(`refs/tags/${tag}`) !== sha) {
    throw new Error('The local release tag does not identify the tested commit.');
  }
  let previous = null;
  for (const candidate of candidates) {
    const previousSha = resolveCommit(`refs/tags/${candidate.tag}`);
    if (command(['merge-base', '--is-ancestor', previousSha, sha], [0, 1]).status === 1) continue;
    const countText = command(['rev-list', '--count', `${previousSha}..${sha}`, '--']).stdout.trim();
    const count = Number(countText);
    if (!/^(0|[1-9]\d*)$/.test(countText) || !Number.isSafeInteger(count)) throw new Error('Git returned a malformed release history count.');
    if (!previous || count < previous.count || (count === previous.count && compareVersions(candidate.version, previous.version) > 0)) {
      previous = { ...candidate, sha: previousSha, count };
    }
  }
  const range = previous ? `${previous.sha}..${sha}` : sha;
  const commits = parseCommitLog(command(['log', '--reverse', '--topo-order', '--format=%H%x00%s', '--encoding=UTF-8', '-z', range, '--']).stdout);
  if ((!previous && !commits.length) || (commits.length && !commits.some(commit => commit.sha === sha)) ||
    (previous && commits.length !== previous.count)) {
    throw new Error('Git release history is incomplete or inconsistent.');
  }
  return formatReleaseNotes({ repo, version, tag, sha, previousTag: previous?.tag ?? null, commits });
}
