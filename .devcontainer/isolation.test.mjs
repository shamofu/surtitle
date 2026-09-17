import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertContainer, assertDefinition, maskTargets, runtimeUserForHost, workspace } from './isolation.mjs';

const definition = JSON.parse(readFileSync(new URL('./devcontainer.json', import.meta.url), 'utf8'));
const dockerfiles = [readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8')];
const ignore = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
const inspection = () => [{ Mounts: [{ Type: 'bind', Source: '/repo', Destination: workspace, RW: true }, ...maskTargets.map(Destination => ({ Type: 'tmpfs', Destination }))], HostConfig: { Binds: [], Privileged: false } }];
test('repository source is shared while every dependency/output location is masked', () => assertDefinition(definition, dockerfiles, ignore));

test('pnpm Cargo sources and generated configuration cannot escape into the host checkout', () => {
  for (const directory of ['.pnpm', '.cargo']) {
    assert.ok(maskTargets.includes(workspace + '/' + directory));
    assert.throws(() => assertDefinition(definition, dockerfiles, ignore + '\n!' + directory + '/**'), /must not enter/);
    const missing = inspection();
    missing[0].Mounts = missing[0].Mounts.filter(mount => mount.Destination !== workspace + '/' + directory);
    assert.throws(() => assertContainer(missing), /incomplete/);
  }

});

test('native Linux uses host IDs while Windows and WSL retain the image account', () => {
  for (const uid of [1000, 1001]) {
    assert.deepEqual(runtimeUserForHost({ platform: 'linux', remoteUser: 'vscode', uid, gid: 1001 }),
      { user: `${uid}:1001`, uid, gid: 1001, home: '/home/vscode' });
  }
  for (const context of [{ platform: 'win32' }, { platform: 'linux', viaWsl: true }, { platform: 'darwin' }]) {
    assert.deepEqual(runtimeUserForHost({ ...context, remoteUser: 'vscode' }), { user: 'vscode' });
  }
  for (const [uid, gid] of [[0, 1000], [1000, 0], [-1, 1000], [1000, undefined]]) {
    assert.throws(() => runtimeUserForHost({ platform: 'linux', remoteUser: 'vscode', uid, gid }), /non-root/);
  }
});


test('live verification output is retained and producer or tee failures stay nonzero', t => {
  const childTimeoutMs = 10_000;
  const launcher = readFileSync(new URL('./container.mjs', import.meta.url), 'utf8');
  const invocation = launcher.match(/'bash', '-o', '(pipefail)', '(-lc)', '([^']+)'/);
  assert.ok(invocation, 'Verification must explicitly preserve the status of the tee pipeline');
  assert.match(invocation[3], /^bash \.devcontainer\/verify\.sh 2>&1 \| tee \/opt\/surtitle-build\/verification\.log$/);
  assert.doesNotMatch(launcher, /'tail', '-n', '80'/);
  let bash = 'bash';
  if (process.platform === 'win32') {
    const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: childTimeoutMs, windowsHide: true });
    assert.equal(git.error, undefined);
    bash = resolve(git.stdout?.trim() ?? '', '../../../bin/bash.exe');
    if (git.status !== 0 || !existsSync(bash)) {
      t.skip('Git Bash is needed to execute the Linux streaming pipeline on Windows');
      return;
    }
  }
  const directory = mkdtempSync(join(tmpdir(), 'surtitle verification stream 日本語 & '));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  for (const exitCode of [0, 23]) {
    const log = join(directory, `verification-${exitCode}.log`);
    const pipeline = invocation[3]
      .replace('bash .devcontainer/verify.sh', `(printf 'stdout marker\\n'; printf 'stderr marker\\n' >&2; exit ${exitCode})`)
      .replace('/opt/surtitle-build/verification.log', '"$1"');
    const result = spawnSync(bash, ['--noprofile', '--norc', '-o', invocation[1], invocation[2], pipeline, 'verification-stream-test', log.replaceAll('\\', '/')], {
      encoding: 'utf8', timeout: childTimeoutMs, windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, exitCode, result.stderr);
    assert.equal(result.stdout, 'stdout marker\nstderr marker\n');
    assert.equal(readFileSync(log, 'utf8'), result.stdout);
  }
  const failingLog = join(directory, 'missing-directory', 'verification.log').replaceAll('\\', '/');
  const pipeline = invocation[3].replace('bash .devcontainer/verify.sh', "printf 'stdout marker\\n'").replace('/opt/surtitle-build/verification.log', '"$1"');
  const result = spawnSync(bash, ['--noprofile', '--norc', '-o', invocation[1], invocation[2], pipeline, 'verification-stream-test', failingLog], { encoding: 'utf8', timeout: childTimeoutMs, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, 'An unwritable log must not silently lose verification evidence');
}, 45_000); // Up to four sequential children, each bounded at ten seconds.


test('rejects read-only source, missing masks, named volumes and additional host binds', () => {
  assert.throws(() => assertDefinition({ ...definition, workspaceMount: definition.workspaceMount + ',readonly' }, dockerfiles, ignore), /source workspace/);
  for (const mounts of [['type=volume,source=cache,target=/deps'], ['type=bind,source=/deps,target=/deps']]) {
    assert.throws(() => assertDefinition({ ...definition, mounts }, dockerfiles, ignore), /temporary masks/);
  }
  for (const runArgs of [[], definition.runArgs.slice(2), ['--volume', 'cache:/deps'], [...definition.runArgs, '--privileged']]) {
    assert.throws(() => assertDefinition({ ...definition, runArgs }, dockerfiles, ignore), /temporary masks/);
  }
  assert.throws(() => assertDefinition({ ...definition, containerEnv: { ...definition.containerEnv, CARGO_TARGET_DIR: workspace + '/unmasked' } }, dockerfiles, ignore), /CARGO_TARGET_DIR/);
});
test('rejects Dockerfile volumes, cache mounts and host dependencies in build context', () => {
  assert.throws(() => assertDefinition(definition, ['VOLUME /deps'], ignore), /mounts/);
  assert.throws(() => assertDefinition(definition, ['RUN --mount=type=cache,target=/deps npm install'], ignore), /mounts/);
  assert.throws(() => assertDefinition(definition, dockerfiles, ignore + '\n!node_modules/**'), /node_modules/);
});
test('actual runtime permits only the intended source bind and all tmpfs masks', () => {
  assertContainer(inspection(), '/repo');
  const alternative = inspection();
  alternative[0].Mounts = alternative[0].Mounts.slice(0, 1);
  alternative[0].HostConfig.Tmpfs = Object.fromEntries(maskTargets.map(target => [target, 'rw,mode=1777']));
  assertContainer(alternative, '/repo');
  assert.throws(() => assertContainer(inspection(), '/different'), /selected source/);
  const readonly = inspection(); readonly[0].Mounts[0].RW = false;
  assert.throws(() => assertContainer(readonly), /read\/write/);
  const missing = inspection(); missing[0].Mounts.pop();
  assert.throws(() => assertContainer(missing), /incomplete/);
  const extra = inspection(); extra[0].Mounts.push({ Type: 'volume', Destination: '/deps' });
  assert.throws(() => assertContainer(extra), /volumes/);
  const privileged = inspection(); privileged[0].HostConfig.Privileged = true;
  assert.throws(() => assertContainer(privileged), /Privileged/);
  const injected = inspection(); injected[0].Mounts.push({ Type: 'bind', Destination: '/keys' });
  assert.throws(() => assertContainer(injected), /selected source/);
  assert.throws(() => assertContainer([]), /one container/);
});
