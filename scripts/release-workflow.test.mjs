// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// These assertions intentionally cover the checked-in workflow's explicit YAML
// shape. Changing its layout requires reviewing the event and permission policy.
function job(name) {
  const block = workflow.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:\\r?$|(?![\\s\\S]))`, 'm'));
  assert.ok(block, `Missing ${name} job`);
  return block[1];
}

function actionStep(name, action) {
  const steps = job(name).split(/^      - /m).slice(1);
  const step = steps.find(value => value.includes(`uses: ${action}@`));
  assert.ok(step, `Missing ${action} in ${name}`);
  return step;
}

test('same-ref runs queue without cancellation and every verification job runs serially', () => {
  assert.match(workflow, /^  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}$/m);
  assert.match(workflow, /^  cancel-in-progress: false$/m);
  assert.match(workflow, /^  queue: max$/m);
  const order = ['linux', 'native-build', 'windows', 'package', 'publish'];
  const ancestors = new Map();
  for (const name of order) {
    const dependencies = job(name).match(/^    needs: \[([^\]]+)\]$/m)?.[1].split(', ') ?? [];
    const reachable = new Set(dependencies);
    for (const dependency of dependencies) {
      assert.ok(ancestors.has(dependency), `${name} depends on an unknown or later job: ${dependency}`);
      for (const ancestor of ancestors.get(dependency)) reachable.add(ancestor);
    }
    for (const earlier of order.slice(0, order.indexOf(name))) {
      assert.ok(reachable.has(earlier), `${name} can run before ${earlier} completes`);
    }
    ancestors.set(name, reachable);
  }
});

test('Docker caching loads two isolated image caches while retaining runtime verification', () => {
  const scopes = [];
  for (const [name, dockerfile, tag] of [
    ['linux', '.devcontainer/Dockerfile', 'surtitle-devcontainer:local-check'],
    ['native-build', 'native/build/Dockerfile', 'surtitle-native-ci:${{ github.sha }}'],
  ]) {
    const image = actionStep(name, 'docker/build-push-action');
    assert.match(image, /^          context: \.$/m);
    assert.ok(image.includes(`          file: ${dockerfile}`));
    assert.ok(image.includes(`          tags: ${tag}`));
    assert.match(image, /^          load: true$/m);
    assert.match(image, /^          push: false$/m);
    const scope = image.match(/^          cache-from: type=gha,scope=([a-z0-9-]+)$/m)?.[1];
    assert.ok(scope, `Missing image cache scope in ${name}`);
    assert.ok(image.includes(`          cache-to: type=gha,scope=${scope},mode=max`));
    scopes.push(scope);
    assert.ok(job(name).indexOf('docker/setup-buildx-action@') < job(name).indexOf('docker/build-push-action@'));
  }
  assert.equal(new Set(scopes).size, 2, 'Image caches must not overwrite one another');
  assert.match(job('linux'), /node \.devcontainer\/container\.mjs start surtitle-ci/);
  assert.match(job('linux'), /node \.devcontainer\/container\.mjs verify surtitle-ci/);
  assert.doesNotMatch(job('linux'), /container\.mjs build/);
  assert.match(job('native-build'), /native-ci-build\.sh --prebuilt-image/);
  assert.match(actionStep('native-build', 'docker/build-push-action'), /labels: org\.opencontainers\.image\.revision=\$\{\{ github\.sha \}\}/);
});

test('host package caches retain only the pnpm store with explicit runtime and lockfile keys', () => {
  for (const name of ['native-build', 'windows', 'package']) {
    const node = actionStep(name, 'actions/setup-node');
    assert.match(node, /^        id: node$/m);
    assert.match(node, /^          node-version-file: \.node-version$/m);
    assert.match(node, /^          package-manager-cache: false$/m);
    const cache = actionStep(name, 'actions/cache');
    assert.match(cache, /^          path: \$\{\{ steps\.pnpm\.outputs\.store \}\}$/m);
    for (const key of ['runner.os', 'runner.arch', 'steps.node.outputs.node-version', 'steps.pnpm.outputs.version', "hashFiles('pnpm-lock.yaml', 'pnpm-workspace.yaml')"]) {
      assert.ok(cache.includes(`\${{ ${key} }}`), `Cache key omits ${key} in ${name}`);
    }
    assert.match(job(name), /^        id: pnpm$/m);
    assert.match(job(name), /pnpm store path --silent/);
    assert.match(job(name), /pnpm install --frozen-lockfile/);
    assert.doesNotMatch(cache, /node_modules|native-ci-artifact|target\/|artifacts\//);
  }
  assert.notEqual(actionStep('windows', 'Swatinem/rust-cache').match(/key: (.+)/)?.[1],
    actionStep('package', 'Swatinem/rust-cache').match(/key: (.+)/)?.[1], 'Debug and release dependency caches need separate keys');
  assert.doesNotMatch(workflow, /node --test/);
  assert.match(job('native-build'), /pnpm test:scripts/);
  assert.match(job('windows'), /^      - run: pnpm test$/m);
});

test('native caches restore by content and save improved entries only after validation on trusted main pushes', () => {
  const native = job('native-build'), steps = native.split(/^      - /m).slice(1);
  const prepare = steps.find(value => value.includes('id: native-cache'));
  assert.ok(prepare?.includes('native-ci-cache.mjs prepare surtitle-native-ci:${{ github.sha }}'));
  const buildIndex = steps.findIndex(value => value.includes('run: bash scripts/native-ci-build.sh --prebuilt-image'));
  assert.match(steps[buildIndex], /SURTITLE_NATIVE_CACHE_DIR: \$\{\{ steps\.native-cache\.outputs\.directory \}\}/);
  const restore = steps.filter(value => value.includes('uses: actions/cache/restore@v6.1.0'));
  const save = steps.filter(value => value.includes('uses: actions/cache/save@v6.1.0'));
  assert.equal(restore.length, 2);
  assert.equal(save.length, 2);
  for (const [index, kind] of ['compiler', 'source'].entries()) {
    const prefix = `\${{ steps.native-cache.outputs.${kind}-key }}`;
    const key = `${prefix}-\${{ github.run_id }}-\${{ github.run_attempt }}`;
    assert.ok(restore[index].includes(`key: ${key}`));
    assert.ok(save[index].includes(`key: ${key}`));
    assert.ok(restore[index].includes(`restore-keys: ${prefix}-`));
    assert.match(save[index], /^        if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m);
    assert.ok(steps.indexOf(prepare) < steps.indexOf(restore[index]));
    assert.ok(steps.indexOf(restore[index]) < buildIndex);
    assert.ok(steps.indexOf(save[index]) > buildIndex);
    assert.doesNotMatch(restore[index] + save[index], /always\(\)|reviewed-inputs\.json|target\/|\/objects|\/prefix|native-ci-artifact/);
    const expectedPaths = kind === 'compiler' ? ['compiler'] : ['source-cache', 'ort-archives'];
    for (const step of [restore[index], save[index]]) {
      const paths = [...step.matchAll(/\$\{\{ steps\.native-cache\.outputs\.directory \}\}\/([a-z-]+)/g)].map(value => value[1]);
      assert.deepEqual(paths, expectedPaths);
    }
  }
});

test('Linux exports selected tmpfs evidence through the container layer into a runner-owned directory', () => {
  const exporter = job('linux').split(/^      - /m).find(value => value.startsWith('name: Export selected verification evidence'));
  assert.ok(exporter);
  assert.match(exporter, /^        id: evidence$/m);
  assert.match(exporter, /evidence_dir="\$\(mktemp -d "\$RUNNER_TEMP\/surtitle-linux-evidence\.XXXXXXXX"\)"/);
  assert.match(exporter, /printf 'directory=%s\\n' "\$evidence_dir" >> "\$GITHUB_OUTPUT"/);
  assert.match(exporter, /for report in container-isolation\.json js-licenses\.json js-sbom\.cdx\.json; do/);
  assert.match(exporter, /docker exec --user vscode surtitle-ci cp "\/workspaces\/surtitle\/artifacts\/\$report" "\/opt\/surtitle-build\/evidence\/\$report"/);
  assert.match(exporter, /docker exec --user vscode surtitle-ci cp -a \/workspaces\/surtitle\/test-results\/native\/\. \/opt\/surtitle-build\/evidence\/native-screenshots\//);
  const exports = [...exporter.matchAll(/docker cp "?surtitle-ci:([^"\s]+)/g)].map(match => match[1]);
  assert.deepEqual(exports, ['/opt/surtitle-build/evidence/$report', '/opt/surtitle-build/verification.log', '/opt/surtitle-build/evidence/required-rust-tests', '/opt/surtitle-build/evidence/native-screenshots']);
  assert.doesNotMatch(exporter, /docker cp[^\n]+:\/workspaces\/surtitle/);
  for (const destination of ['$report', 'linux-verification.log', 'required-rust-tests', 'native-screenshots']) {
    assert.ok(exporter.includes(`"$evidence_dir/${destination}"`));
  }
  assert.doesNotMatch(exporter, /mkdir -p artifacts|docker cp[^\n]+ artifacts\//);
  assert.match(actionStep('linux', 'actions/upload-artifact'), /^          path: \$\{\{ steps\.evidence\.outputs\.directory \}\}$/m);
});

test('prebuilt native images still require this commit, committed inputs and unmounted offline compilation', () => {
  const script = readFileSync(new URL('./native-ci-build.sh', import.meta.url), 'utf8');
  assert.match(script, /1:--prebuilt-image\) prebuilt_image=true/);
  assert.match(script, /git rev-parse HEAD/);
  assert.match(script, /native-ci-artifact\.mjs check-inputs/);
  assert.match(script, /image="surtitle-native-ci:\$sha"/);
  assert.match(script, /docker image inspect --format '[^\n]+org\.opencontainers\.image\.revision[^\n]+"\$image"[^\n]+== "\$sha"/);
  assert.match(script, /docker inspect --format '\{\{json \.Mounts\}\}'/);
  assert.ok(script.indexOf('docker network disconnect bridge') < script.indexOf('docker exec "$name" bash /workspace/scripts/native-ci-build-inside.sh'));
  assert.match(script, /native-ci-artifact\.mjs seal "\$destination" "\$sha"/);
  assert.doesNotMatch(script, /docker (?:create|run)[^\n]+(?:--mount|--volume| -v )/);
});

test('package validation runs for main/release pushes and pull requests after all native checks', () => {
  const events = workflow.slice(0, workflow.indexOf('\npermissions:'));
  assert.match(events, /^  push:\r?\n    branches: \[main, release\]$/m);
  assert.match(events, /^  pull_request:\r?\n    branches: \[main, release\]$/m);
  assert.doesNotMatch(events, /pull_request_target|paths(?:-ignore)?:/);
  const packaging = job('package');
  assert.match(packaging, /^    needs: \[linux, windows, native-build\]$/m);
  assert.match(packaging, /^    runs-on: windows-2025$/m);
  assert.doesNotMatch(packaging, /^    if:|continue-on-error:/m);
  for (const step of packaging.split(/^      - /m).slice(1)) {
    if (step.startsWith('name: Preserve package verification diagnostics\n')) {
      assert.match(step, /^        if: always\(\)$/m);
      assert.match(step, /uses: actions\/upload-artifact@/);
      assert.match(step, /name: package-evidence-\$\{\{ github\.sha \}\}/);
      assert.doesNotMatch(step, /^        run:/m);
    } else {
      assert.doesNotMatch(step, /^\s+if:/m, 'Required package checks and release artifacts cannot be conditional');
    }
  }
  for (const command of ['nsis-plugin-build.ps1', 'native-installer-prepare.ps1', 'native-audit.mjs --release',
    'pnpm tauri build --bundles nsis -- --locked', 'native-installer-audit.ps1', 'package-verify.ps1']) {
    assert.ok(packaging.includes(command), `Missing required package check: ${command}`);
  }
  const verifier = readFileSync(new URL('./package-verify.ps1', import.meta.url), 'utf8');
  assert.match(verifier, /& pwsh[^\r\n]+scripts\/package-installer-smoke\.ps1/);
  assert.match(verifier, /validateRelease\("artifacts\/release", process\.env\.GITHUB_SHA/);
  assert.doesNotMatch(verifier, /scripts\/release\.mjs|gh release/);
});

test('native and package artifacts are consumed only from the current run and SHA', () => {
  const packaging = job('package');
  assert.match(packaging, /name: native-build-\$\{\{ github\.sha \}\}/);
  assert.match(packaging, /native-ci-artifact\.mjs consume work\/native-ci-artifact \$\{\{ github\.sha \}\}/);
  assert.match(packaging, /uses: actions\/upload-artifact@\S+[\s\S]+name: release-\$\{\{ github\.sha \}\}[\s\S]+path: artifacts\/release\/[\s\S]+if-no-files-found: error/);
  const publisher = job('publish');
  assert.match(publisher, /uses: actions\/download-artifact@\S+[\s\S]+name: release-\$\{\{ github\.sha \}\}[\s\S]+path: artifacts\/release\//);
  for (const block of [packaging, publisher]) {
    assert.doesNotMatch(block, /^\s+(run-id|repository|github-token|pattern|merge-multiple):/m);
  }
});

test('independent producer digests bind native consumers and the final publisher', () => {
  assert.match(job('native-build'), /receipt-sha256: \$\{\{ steps\.native-build\.outputs\.receipt-sha256 \}\}/);
  assert.match(job('native-build'), /id: native-build\r?\n        run: bash scripts\/native-ci-build\.sh/);
  for (const name of ['windows', 'package']) {
    assert.match(job(name), /SURTITLE_EXPECTED_NATIVE_RECEIPT_SHA256: \$\{\{ needs\.native-build\.outputs\.receipt-sha256 \}\}/);
    assert.match(job(name), /consume[^\r\n]+--expected-receipt-sha256 \$env:SURTITLE_EXPECTED_NATIVE_RECEIPT_SHA256/);
  }
  assert.match(job('package'), /release-manifest-sha256: \$\{\{ steps\.package-verify\.outputs\.release-manifest-sha256 \}\}/);
  assert.match(job('package'), /id: package-verify\r?\n        run: pwsh scripts\/package-verify\.ps1/);
  assert.match(job('publish'), /SURTITLE_EXPECTED_NATIVE_RECEIPT_SHA256: \$\{\{ needs\.package\.outputs\.receipt-sha256 \}\}/);
  assert.match(job('publish'), /SURTITLE_EXPECTED_RELEASE_MANIFEST_SHA256: \$\{\{ needs\.package\.outputs\.release-manifest-sha256 \}\}/);
  const verifier = readFileSync(new URL('./package-verify.ps1', import.meta.url), 'utf8');
  const validated = verifier.indexOf("throw 'The packaged artifact failed the same-SHA release contract.'");
  assert.ok(validated > 0);
  assert.ok(verifier.indexOf('"release-manifest-sha256=$releaseManifestSha256" >> $env:GITHUB_OUTPUT') > validated);
  assert.ok(verifier.indexOf('foreach ($component in $nativeManifest.components)') < verifier.indexOf('& node scripts/native-ci-source-check.mjs'));
  assert.equal(verifier.match(/native-ci-source-check\.mjs[^\r\n]+--reference-workspace \$workspace/g)?.length, 2);
  assert.match(verifier, /\$archiver x[^\r\n]+'native\/build\/\*'[^\r\n]+'native-sources\/\*'/);
});

test('short native regressions are required after preparing the fixed runtime and development model', () => {
  const windows = job('windows');
  assert.match(windows, /native-prepare\.ps1 -WithDevModel/);
  assert.ok(windows.indexOf('native-prepare.ps1 -WithDevModel') < windows.indexOf('run-required-rust-tests.mjs windows-native'));
  const required = windows.split(/^      - /m).find(step => step.includes('run-required-rust-tests.mjs windows-native'));
  assert.ok(required);
  assert.doesNotMatch(required, /if:|continue-on-error:|\|\|/);
  const linux = readFileSync(new URL('../.devcontainer/verify.sh', import.meta.url), 'utf8');
  assert.match(linux, /SURTITLE_TEST_FFMPEG="\$\(command -v ffmpeg\)" node scripts\/run-required-rust-tests\.mjs linux-ffmpeg/);
  assert.match(job('linux'), /cp -a \/workspaces\/surtitle\/artifacts\/required-rust-tests \/opt\/surtitle-build\/evidence\/required-rust-tests/);
});

test('long audio acceptance is manual, serial, source-built and uses a separate optimized Rust cache', () => {
  const manual = readFileSync(new URL('../.github/workflows/native-acceptance.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(manual, /^on:\r?\n  workflow_dispatch:$/m);
  assert.doesNotMatch(manual, /^  schedule:|contents: write|scripts\/release\.mjs|windows-spoken/m);
  assert.match(manual, /group: Test and release-\$\{\{ github\.ref \}\}/);
  assert.match(manual, /cancel-in-progress: false\r?\n  queue: max/);
  const native = manual.match(/^  native-build:\r?\n([\s\S]*?)(?=^  [a-z][a-z-]*:\r?$)/m)?.[1];
  assert.equal(native, job('native-build').replace(/^    needs: \[linux\]\r?\n/m, ''));
  assert.match(manual, /needs: \[native-build\]/);
  assert.match(manual, /SURTITLE_EXPECTED_NATIVE_RECEIPT_SHA256: \$\{\{ needs\.native-build\.outputs\.receipt-sha256 \}\}/);
  assert.match(manual, /native-prepare\.ps1 -WithDevModel/);
  assert.match(manual, /key: windows-2025-native-acceptance-optimized-v1/);
  assert.match(manual, /node scripts\/run-required-rust-tests\.mjs windows-six-hour/);
  assert.match(manual, /timeout-minutes: 15/);
  assert.match(manual, /if: always\(\)/);
});

test('only the release-push publisher receives write permission', () => {
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(job('publish'), /^    needs: \[linux, windows, package\]$/m);
  assert.match(job('publish'), /^    if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/release'$/m);
  assert.match(job('publish'), /^    permissions:\r?\n      contents: write$/m);
  assert.equal(workflow.match(/contents: write/g)?.length, 1);
  assert.equal(workflow.match(/node scripts\/release\.mjs/g)?.length, 1);
  assert.doesNotMatch(job('package'), /GH_TOKEN|github\.token|permissions:/);
});

test('the publisher itself rejects main pushes and PRs before examining artifacts or calling GitHub', () => {
  for (const [event, ref] of [['push', 'refs/heads/main'], ['pull_request', 'refs/pull/1/merge'], ['pull_request', 'refs/heads/release']]) {
    const result = spawnSync(process.execPath, ['scripts/release.mjs'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', GITHUB_REPOSITORY: 'test/surtitle',
        GITHUB_SHA: 'a'.repeat(40), GITHUB_EVENT_NAME: event, GITHUB_REF: ref },
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Only a release branch push can publish\./);
  }
});
