import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspace = '/workspaces/surtitle';
export const maskedDirectories = ['.pnpm', '.cargo', 'node_modules', 'target', 'dist', 'work', 'artifacts', 'test-results',
  'playwright-report', 'src-tauri/gen', 'src-tauri/resources/native', 'src-tauri/resources/notices'];
export const maskTargets = maskedDirectories.map(path => workspace + '/' + path);

export function runtimeUserForHost({ platform, viaWsl = false, remoteUser, uid, gid }) {
  if (platform !== 'linux' || viaWsl) return { user: remoteUser };
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) {
    throw new Error('Start the Linux development container as a non-root host user with a non-root primary group');
  }
  if (!/^[a-z_][a-z0-9_-]*$/.test(remoteUser)) throw new Error('Invalid development container user');
  return { user: `${uid}:${gid}`, uid, gid, home: `/home/${remoteUser}` };
}

export function assertDefinition(config, dockerfiles, ignore) {
  if (config.workspaceMount !== 'source=$' + '{localWorkspaceFolder},target=' + workspace + ',type=bind' || config.workspaceFolder !== workspace) {
    throw new Error('Exactly one read/write source workspace bind is required');
  }
  const expected = maskTargets.flatMap(target => ['--tmpfs', target + ':rw,exec,nosuid,nodev,mode=1777']);
  if ((config.mounts ?? []).length || JSON.stringify(config.runArgs ?? []) !== JSON.stringify(expected)) {
    throw new Error('Dependency/output mounts must be exactly the required temporary masks; no named volumes or extra binds');
  }
  if (config.dockerComposeFile) throw new Error('Unreviewed compose mounts are forbidden');
  for (const key of ['CARGO_TARGET_DIR', 'SURTITLE_BUILD_ROOT', 'npm_config_store_dir', 'npm_config_cache', 'PLAYWRIGHT_BROWSERS_PATH', 'XDG_CACHE_HOME', 'TMPDIR']) {
    const value = config.containerEnv?.[key];
    if (typeof value !== 'string' || !/^\/opt\/surtitle-build(?:\/[^.][^:]*)?$/.test(value) || value.includes('..')) throw new Error(key + ' must stay in the container build directory');
  }
  for (const dockerfile of dockerfiles) {
    if (/^\s*VOLUME\b/im.test(dockerfile) || /--mount\s*=/.test(dockerfile)) throw new Error('Dockerfile volume/cache/bind mounts are forbidden');
  }
  if (ignore.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'))[0] !== '*') throw new Error('Docker context must start with a source allowlist');
  for (const directory of ['.pnpm', '.cargo', 'node_modules', 'target', 'work', 'artifacts', 'dist', '.git']) {
    const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('^!/?' + escaped + '(?:/|$)', 'm').test(ignore)) throw new Error('Host ' + directory + ' must not enter the build context');
  }
}

export function assertContainer(inspections, expectedSource) {
  if (!Array.isArray(inspections) || inspections.length !== 1) throw new Error('Inspect exactly one container');
  const container = inspections[0];
  if (!Array.isArray(container.Mounts)) throw new Error('Runtime mount inventory is required');
  const binds = container.Mounts.filter(mount => mount.Type === 'bind');
  if (binds.length !== 1 || binds[0].Destination !== workspace || binds[0].RW !== true || (expectedSource && binds[0].Source !== expectedSource)) throw new Error('Runtime must share only the selected source repository read/write');
  if (container.Mounts.some(mount => !['bind', 'tmpfs'].includes(mount.Type))) throw new Error('Runtime named/anonymous volumes are forbidden');
  const actualMasks = new Set(container.Mounts.filter(mount => mount.Type === 'tmpfs').map(mount => mount.Destination));
  for (const destination of Object.keys(container.HostConfig?.Tmpfs ?? {})) actualMasks.add(destination);
  if (JSON.stringify([...actualMasks].sort()) !== JSON.stringify([...maskTargets].sort())) throw new Error('Runtime dependency/output tmpfs masks are incomplete or unexpected');
  if ((container.HostConfig?.Binds ?? []).some(bind => !bind.includes(':' + workspace + ':'))) throw new Error('Client-injected host binds are forbidden');
  if (container.HostConfig?.Privileged === true) throw new Error('Privileged containers are not permitted');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  assertDefinition(JSON.parse(readFileSync(resolve(root, '.devcontainer/devcontainer.json'), 'utf8').replace(/^\uFEFF/, '')),
    [readFileSync(resolve(root, '.devcontainer/Dockerfile'), 'utf8')],
    readFileSync(resolve(root, '.dockerignore'), 'utf8'));
  const inspectFile = process.argv[2];
  if (inspectFile) assertContainer(JSON.parse(readFileSync(inspectFile, 'utf8').replace(/^\uFEFF/, '')));
  console.log(inspectFile ? 'Shared source and runtime dependency/output isolation verified.' : 'Container definition verified; runtime inspection and write probes are still required.');
}

