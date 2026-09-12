// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

// These assertions intentionally cover the checked-in workflow's explicit YAML
// shape. Changing its layout requires reviewing the event and permission policy.
function job(name) {
  const block = workflow.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:\\r?$|(?![\\s\\S]))`, 'm'));
  assert.ok(block, `Missing ${name} job`);
  return block[1];
}

test('package validation runs for main/release pushes and pull requests after all native checks', () => {
  const events = workflow.slice(0, workflow.indexOf('\npermissions:'));
  assert.match(events, /^  push:\r?\n    branches: \[main, release\]$/m);
  assert.match(events, /^  pull_request:\r?\n    branches: \[main, release\]$/m);
  assert.doesNotMatch(events, /pull_request_target|paths(?:-ignore)?:/);
  const packaging = job('package');
  assert.match(packaging, /^    needs: \[linux, windows, native-build\]$/m);
  assert.match(packaging, /^    runs-on: windows-2022$/m);
  assert.doesNotMatch(packaging, /^\s+if:|continue-on-error:/m);
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
  assert.match(packaging, /uses: actions\/upload-artifact@v4[\s\S]+name: release-\$\{\{ github\.sha \}\}[\s\S]+path: artifacts\/release\/[\s\S]+if-no-files-found: error/);
  const publisher = job('publish');
  assert.match(publisher, /uses: actions\/download-artifact@v4[\s\S]+name: release-\$\{\{ github\.sha \}\}[\s\S]+path: artifacts\/release\//);
  for (const block of [packaging, publisher]) {
    assert.doesNotMatch(block, /^\s+(run-id|repository|github-token|pattern|merge-multiple):/m);
  }
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
