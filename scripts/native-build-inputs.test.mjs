import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const dockerfile = readFileSync(new URL('native/build/Dockerfile', root), 'utf8');

// Check the checked-in COPY/FROM boundary, without pretending to run BuildKit.
// Keep the supported syntax narrow so a new kind of input cannot go unnoticed.
function stagesFromDockerfile(contents) {
  const stages = new Map();
  let current;
  for (const line of contents.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/).map(line => line.trim())) {
    if (!line || line.startsWith('#')) continue;
    if (/^FROM /i.test(line)) {
      const match = /^FROM (\S+) AS (\S+)$/i.exec(line);
      assert.ok(match, `Unrecognized FROM: ${line}`);
      current = { dependencies: stages.has(match[1]) ? [match[1]] : [], inputs: [] };
      assert.equal(stages.has(match[2]), false, `Duplicate stage: ${match[2]}`);
      stages.set(match[2], current);
    } else if (/^COPY /i.test(line)) {
      assert.ok(current, 'COPY before FROM');
      const parts = line.slice(5).split(/\s+/);
      if (parts[0].startsWith('--from=')) {
        const stage = parts.shift().slice('--from='.length);
        assert.ok(stages.has(stage), `Unknown COPY stage: ${stage}`);
        current.dependencies.push(stage);
      } else {
        assert.ok(parts.length >= 2 && parts.every(part => !/^--|[\[\]"'$]/.test(part)),
          `Unrecognized COPY syntax: ${line}`);
        current.inputs.push(...parts.slice(0, -1));
      }
    } else {
      assert.doesNotMatch(line, /^ADD\b|--mount=[^ ]*type=bind/i,
        'New filesystem input syntax must be included in the dependency check');
    }
  }
  return stages;
}

function matchesCopySource(path, source) {
  const pattern = source.split('*').map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return new RegExp(`^${pattern}${source.endsWith('/') ? '.*' : '(?:/.*)?'}$`).test(path);
}

const stages = stagesFromDockerfile(dockerfile);
function affectedStages(path) {
  const affected = new Set();
  for (const [name, stage] of stages) {
    if (stage.inputs.some(source => matchesCopySource(path, source)) ||
        stage.dependencies.some(dependency => affected.has(dependency))) affected.add(name);
  }
  return [...affected];
}

test('all native Docker COPY inputs exist in the checkout', () => {
  const files = ['native/', 'scripts/'].flatMap(directory =>
    readdirSync(new URL(directory, root), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => relative(fileURLToPath(root), join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
  for (const [name, stage] of stages) {
    for (const source of stage.inputs) {
      assert.ok(files.some(file => matchesCopySource(file, source)), `${name} COPY has no input: ${source}`);
    }
  }
});

test('application and packaging changes do not enter the native Docker stages', () => {
  for (const path of [
    'src/App.tsx', 'src/styles.css', 'crates/ai/src/lib.rs', 'src-tauri/src/main.rs',
    'src-tauri/tauri.conf.json', 'Cargo.lock', 'package.json', 'pnpm-lock.yaml',
    'scripts/package-verify.ps1', 'scripts/native-ci-artifact.mjs',
    'native/installer-inputs.json',
  ]) assert.deepEqual(affectedStages(path), [], path);
});

test('libmpv source pins and their reader invalidate only libmpv and exported artifacts', () => {
  for (const path of ['native/build/sources.json', 'scripts/native-source-inputs.py', 'scripts/native_source_manifest.py']) {
    assert.deepEqual(affectedStages(path), ['libmpv-sources', 'libmpv-build', 'native-artifact', 'export'], path);
  }
  for (const path of ['native/build/cross-win64.ini', 'native/build/toolchain-win64.cmake']) {
    assert.deepEqual(affectedStages(path), ['libmpv-build', 'native-artifact', 'export'], path);
  }
});

test('ORT source pins and overlays invalidate acquisition, packaging and exported artifacts', () => {
  for (const path of [
    'native/build/onnxruntime-sources.json', 'scripts/native-ort-source-inputs.py',
    'native/upstream-evidence/onnxruntime-overlay-ports/protobuf/portfile.cmake',
  ]) assert.deepEqual(affectedStages(path), ['ort-sources', 'ort-package', 'native-artifact', 'export'], path);
});

test('ORT runtime, notices and evidence changes reuse the acquired source stage', () => {
  for (const path of [
    'native/runtime-windows-x64.json', 'native/onnxruntime-LICENSE', 'native/onnxruntime-ThirdPartyNotices.txt',
    'native/reviews/onnxruntime-dependencies.json', 'native/upstream-evidence/onnxruntime-vcpkg.json',
    'scripts/native-ort-compare.py', 'scripts/native-ort-generated.py',
    'scripts/native-ort-package.py', 'scripts/native-ort-evidence.py',
  ]) assert.deepEqual(affectedStages(path), ['ort-package', 'native-artifact', 'export'], path);
});

test('shared archive validation changes invalidate both native source artifact branches', () => {
  assert.deepEqual(affectedStages('scripts/native-source-archive-check.py'),
    ['libmpv-build', 'ort-package', 'native-artifact', 'export']);
});
