import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkVersion } from './check-version.mjs';

export function validateTagEvent(version, env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'push'
      || !/^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(env.GITHUB_REF ?? '')) {
    throw new Error('Only a canonical vX.Y.Z tag push can publish.');
  }
  if (env.GITHUB_REF !== `refs/tags/v${version}`) throw new Error('Release tag and explicit application version differ.');
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('Release tag push requires the full commit SHA.');
  return { tag: env.GITHUB_REF.slice('refs/tags/'.length), sha: env.GITHUB_SHA };
}

export function checkRelease({ directory = fileURLToPath(new URL('..', import.meta.url)),
  env = process.env, run = spawnSync } = {}) {
  const version = checkVersion(directory);
  if (!env.GITHUB_REF?.startsWith('refs/tags/')) return version;
  const { tag, sha } = validateTagEvent(version, env);
  function git(args) {
    const result = run('git', args, { cwd: directory, encoding: 'utf8', shell: false });
    if (result.error || result.status !== 0) {
      throw new Error(result.error?.message || result.stderr || `git ${args[0]} failed`);
    }
    return result.stdout.trim();
  }
  if (git(['rev-parse', '--verify', 'HEAD^{commit}']) !== sha
      || git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]) !== sha) {
    throw new Error('Release tag or checkout differs from the triggered commit.');
  }
  const ancestor = run('git', ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main'],
    { cwd: directory, encoding: 'utf8', shell: false });
  if (ancestor.error || ancestor.status !== 0) {
    throw new Error('Release commit must be contained in origin/main; fetch the complete main history before validation.');
  }
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`Version ${checkRelease()} and release inputs are valid.`);
}
