import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertContainer, assertDefinition, maskTargets, workspace } from './isolation.mjs';

const definition = JSON.parse(readFileSync(new URL('./devcontainer.json', import.meta.url), 'utf8'));
const dockerfiles = [readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8'), readFileSync(new URL('../native/build/Dockerfile', import.meta.url), 'utf8')];
const ignore = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
const inspection = () => [{ Mounts: [{ Type: 'bind', Source: '/repo', Destination: workspace, RW: true }, ...maskTargets.map(Destination => ({ Type: 'tmpfs', Destination }))], HostConfig: { Binds: [], Privileged: false } }];
test('repository source is shared while every dependency/output location is masked', () => assertDefinition(definition, dockerfiles, ignore));

test('each full verification seeds and launches one fresh profile inside the work mask', () => {
  const script = readFileSync(new URL('./verify.sh', import.meta.url), 'utf8');
  assert.ok(maskTargets.includes(workspace + '/work'));
  assert.match(script, /^e2e_data_dir="\$\(mktemp -d "\$PWD\/work\/e2e-linux\.XXXXXXXX"\)"$/m);
  assert.match(script, /^cargo run .*--example seed_fixture -- "\$e2e_data_dir" /m);
  assert.match(script, /^export SURTITLE_E2E_DATA_DIR="\$e2e_data_dir"$/m);
  assert.doesNotMatch(script, /\$PWD\/work\/e2e-linux"/);
  assert.doesNotMatch(script, /\b(?:rm|rmdir)\b/);
});
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

