import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { validateRelease, validateReleaseForPublish } from './release-contract.mjs';
import { publishRelease } from './release.mjs';
const sha = 'a'.repeat(40), version = '0.1.0';
const runId = '12345', baseManifestSha256 = 'b'.repeat(64);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'surtitle-release-test-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['surtitle.exe', 'surtitle-source.zip', 'js-sbom.cdx.json', 'rust-dependencies.json']) writeFileSync(join(directory, name), 'test payload');
  const nativeFiles = [{ file: 'mpv-2.dll', sha256: 'c'.repeat(64) }, { file: 'onnxruntime.dll', sha256: 'd'.repeat(64) }];
  const nativeManifest = JSON.stringify({ buildBinding: { sha, runId, baseManifestSha256 }, components: [{ runtimeFiles: nativeFiles.map(file => ({ target: file.file, sha256: file.sha256 })) }] });
  const nativeHash = createHash('sha256').update(nativeManifest).digest('hex');
  writeFileSync(join(directory, 'native-runtime-manifest.json'), nativeManifest);
  const nativeReceipt = JSON.stringify({ schemaVersion: 2, sha, runId, runAttempt: '1', baseManifestSha256, files: { 'effective-native-manifest.json': nativeHash } });
  const nativeReceiptSha256 = createHash('sha256').update(nativeReceipt).digest('hex');
  writeFileSync(join(directory, 'native-build-artifact.json'), nativeReceipt);
  writeFileSync(join(directory, 'native-audit.json'), JSON.stringify({ sha, nativeBuildSha: sha, nativeBuildRunId: runId, nativeReceiptSha256, effectiveManifestSha256: nativeHash, artifactIntegrityPassed: true, releaseEligible: true, errors: [], blockers: [] }));
  const emptyProfile = { credentialConfigured: false, savedModelPreferenceCount: 0,
    budget: { spentUsd: 0, reservedUsd: 0, limitUsd: 0, unpricedAttempts: 0, monetaryTotalsComplete: true, unknownAttempts: [] } };
  const production = { schemaVersion: 1, sha, passed: true, normalBuild: true, applicationSha256: 'e'.repeat(64), effectiveManifestSha256: nativeHash,
    nativeFiles, appReady: true, settingsReady: true, nativeMetadataPassed: true, visibleSurfacePassed: true, playbackAdvanced: true,
    intervalStopPassed: true, seekPassed: true, accountingUnchanged: true, paidRequests: 0, initial: emptyProfile, final: emptyProfile,
    ui: { modelInputs: 4, unsetInputs: 4, credentialMaterialVisible: false } };
  writeFileSync(join(directory, 'production-smoke.json'), JSON.stringify(production));
  writeFileSync(join(directory, 'installer-smoke.json'), JSON.stringify({ sha, installerSha256: createHash('sha256').update('test payload').digest('hex'),
    originalApplicationSha256: '4'.repeat(64),
    productionApplicationSha256: production.applicationSha256, productionSmokeSha256: createHash('sha256').update(JSON.stringify(production)).digest('hex'),
    freshInstallPassed: true, startupPassed: true, overwriteInstallPassed: true, uninstallPassed: true, defaultDataRetentionPassed: true, retainedFileCount: 2, retainedDataRemoved: false }));
  const installerBuild = { schemaVersion: 1, sha, plugin: { file: 'surtitle_nsis_utils.dll', sha256: 'f'.repeat(64) },
    sourcePackages: [{ file: 'nsis-plugin-source.tar.gz', sha256: '1'.repeat(64) }, { file: 'rust-runtime-source.tar.gz', sha256: '2'.repeat(64) }] };
  writeFileSync(join(directory, 'installer-build-receipt.json'), JSON.stringify(installerBuild));
  writeFileSync(join(directory, 'installer-audit.json'), JSON.stringify({ schemaVersion: 1, sha, releaseEligible: true, errors: [],
    installerSha256: createHash('sha256').update('test payload').digest('hex'), effectiveManifestSha256: nativeHash,
    sourceReceiptSha256: createHash('sha256').update(JSON.stringify(installerBuild)).digest('hex'), pluginSha256: installerBuild.plugin.sha256,
    sourcePackages: installerBuild.sourcePackages, files: [{ file: '$PLUGINSDIR/surtitle_nsis_utils.dll', sha256: installerBuild.plugin.sha256 }],
    application: { originalSha256: '4'.repeat(64), embeddedSha256: production.applicationSha256,
      transformation: 'tauri-nsis-bundle-marker', markerOffset: 1024, changedOffsets: [1048, 1049, 1050],
      originalMarker: '__TAURI_BUNDLE_TYPE_VAR_UNK', embeddedMarker: '__TAURI_BUNDLE_TYPE_VAR_NSS', byteLength: 32768 } }));
  reseal(directory);
  return directory;
}
function reseal(directory) {
  const hash = name => createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
  const files = Object.fromEntries(readdirSync(directory).filter(name => !['SHA256SUMS.txt', 'release-manifest.json'].includes(name)).map(name => [name, hash(name)]));
  writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify({ sha, version, installerSmokePassed: true, files }));
  writeFileSync(join(directory, 'SHA256SUMS.txt'), readdirSync(directory).filter(name => name !== 'SHA256SUMS.txt').map(name => `${hash(name)}  ${name}`).join('\n') + '\n');
}
test('accepts a complete artifact set without CI identity inputs', t => {
  const directory = fixture(t);
  assert.equal(validateRelease(directory, version).length, 13);
  assert.equal(validateReleaseForPublish(directory, version).length, 13);
  for (const name of ['release-manifest.json', 'native-build-artifact.json', 'native-audit.json', 'installer-smoke.json', 'production-smoke.json', 'installer-audit.json', 'installer-build-receipt.json']) {
    const file = join(directory, name), value = JSON.parse(readFileSync(file));
    delete value.sha; delete value.runId; delete value.nativeReceiptSha256;
    delete value.effectiveManifestSha256; delete value.sourceReceiptSha256;
    writeFileSync(file, JSON.stringify(value));
  }
  assert.equal(validateReleaseForPublish(directory, version).length, 13);
});

test('requires the requested version and nonempty source, metadata and installer assets', t => {
  const directory = fixture(t);
  assert.throws(() => validateRelease(directory, '1.0.0'), /version/);
  const source = join(directory, 'surtitle-source.zip'), contents = readFileSync(source);
  rmSync(source);
  assert.throws(() => validateRelease(directory, version), /incomplete/);
  writeFileSync(source, '');
  assert.throws(() => validateRelease(directory, version), /empty/);
  writeFileSync(source, contents);
  writeFileSync(join(directory, 'second.exe'), 'ambiguous');
  assert.throws(() => validateRelease(directory, version), /ambiguous/);
});

test('requires fresh/overwrite/uninstall/retention evidence', t => {
  const directory = fixture(t);
  const path = join(directory, 'installer-smoke.json');
  const valid = JSON.parse(readFileSync(path, 'utf8'));
  for (const changed of [{ overwriteInstallPassed: false }, { uninstallPassed: false }, { defaultDataRetentionPassed: false }, { retainedDataRemoved: true }]) {
    writeFileSync(path, JSON.stringify({ ...valid, ...changed }));
    reseal(directory);
    assert.throws(() => validateRelease(directory, version), /Installer lifecycle/);
  }
});
test('rejects native redistribution blockers', t => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'native-audit.json'), JSON.stringify({ sha, artifactIntegrityPassed: true, releaseEligible: false, errors: [], blockers: ['missing matching GPL source'] }));
  reseal(directory);
  assert.throws(() => validateRelease(directory, version), /Native redistribution audit/);
});
test('refuses omitted production evidence and an installer receipt for a different production executable', t => {
  const directory = fixture(t), productionPath = join(directory, 'production-smoke.json'), original = readFileSync(productionPath);
  rmSync(productionPath); reseal(directory);
  assert.throws(() => validateRelease(directory, version), /incomplete/);
  writeFileSync(productionPath, original);
  const smokePath = join(directory, 'installer-smoke.json'), smoke = JSON.parse(readFileSync(smokePath));
  smoke.productionApplicationSha256 = 'f'.repeat(64); writeFileSync(smokePath, JSON.stringify(smoke)); reseal(directory);
  assert.throws(() => validateRelease(directory, version), /Installed production evidence/);
});
test('production reports require readiness, external native hashes and empty accounting', t => {
  const directory = fixture(t), productionPath = join(directory, 'production-smoke.json'), original = JSON.parse(readFileSync(productionPath));
  for (const change of [
    ...['passed', 'normalBuild', 'appReady', 'settingsReady', 'nativeMetadataPassed', 'visibleSurfacePassed', 'playbackAdvanced', 'intervalStopPassed', 'seekPassed', 'accountingUnchanged']
      .map(field => value => { value[field] = false; }),
    value => { value.paidRequests = 1; },
    value => { value.applicationSha256 = 'f'.repeat(64); },
    value => { value.nativeFiles[0].sha256 = 'f'.repeat(64); }, value => { value.nativeFiles.pop(); },
    value => { value.nativeFiles.push(value.nativeFiles[0]); }, value => { value.final.budget.reservedUsd = 0.01; },
    value => { value.final.budget.unpricedAttempts = 1; }, value => { value.final.credentialConfigured = true; },
    value => { value.ui.unsetInputs = 0; },
  ]) {
    const production = structuredClone(original); change(production);
    writeFileSync(productionPath, JSON.stringify(production));
    const smokePath = join(directory, 'installer-smoke.json'), smoke = JSON.parse(readFileSync(smokePath));
    smoke.productionSmokeSha256 = createHash('sha256').update(readFileSync(productionPath)).digest('hex');
    writeFileSync(smokePath, JSON.stringify(smoke)); reseal(directory);
    assert.throws(() => validateRelease(directory, version), /Installed production/);
  }
});
test('embedded installer evidence rejects changed external plugin and source identities', t => {
  const directory = fixture(t), path = join(directory, 'installer-audit.json'), original = JSON.parse(readFileSync(path));
  rmSync(path); reseal(directory);
  assert.throws(() => validateRelease(directory, version), /incomplete/);
  for (const change of [
    value => { value.pluginSha256 = '0'.repeat(64); }, value => { value.releaseEligible = false; },
    value => { value.errors.push('missing corresponding source'); }, value => { value.sourcePackages[0].sha256 = '0'.repeat(64); },
    value => { value.sourcePackages.pop(); }, value => { value.files = []; },
    value => { value.files[0].sha256 = '0'.repeat(64); },
    value => { value.files.push({ file: '$PLUGINSDIR/nsis_tauri_utils.dll', sha256: '3'.repeat(64) }); },
    value => { value.files.push({ file: '$PLUGINSDIR/../unreviewed.dll', sha256: '3'.repeat(64) }); },
  ]) {
    const audit = structuredClone(original); change(audit); writeFileSync(path, JSON.stringify(audit)); reseal(directory);
    assert.throws(() => validateRelease(directory, version), /Embedded installer/);
  }
});
test('installer source metadata retains the reviewed external plugin and source inventory', t => {
  const directory = fixture(t), path = join(directory, 'installer-build-receipt.json'), original = JSON.parse(readFileSync(path));
  for (const change of [value => { value.plugin.sha256 = '0'.repeat(64); },
    value => { value.plugin.file = 'nsis_tauri_utils.dll'; }, value => { value.sourcePackages = []; }]) {
    const receipt = structuredClone(original); change(receipt); writeFileSync(path, JSON.stringify(receipt));
    const auditPath = join(directory, 'installer-audit.json'), audit = JSON.parse(readFileSync(auditPath));
    audit.sourceReceiptSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    writeFileSync(auditPath, JSON.stringify(audit)); reseal(directory);
    assert.throws(() => validateRelease(directory, version), /Embedded installer/);
  }
});
test('accepts the exact NSIS marker patch at a different observed offset without assuming reproducible layout', t => {
  const directory = fixture(t), path = join(directory, 'installer-audit.json'), audit = JSON.parse(readFileSync(path));
  audit.application.markerOffset = 65500; audit.application.changedOffsets = [65524, 65525, 65526]; audit.application.byteLength = 131072;
  writeFileSync(path, JSON.stringify(audit)); reseal(directory);
  assert.equal(validateRelease(directory, version).length, 13);
});
test('rejects a missing, altered or out-of-bounds bundle-marker transformation', t => {
  const directory = fixture(t), path = join(directory, 'installer-audit.json'), original = JSON.parse(readFileSync(path));
  for (const change of [
    value => { delete value.application; },
    value => { value.application.transformation = 'arbitrary executable replacement'; },
    value => { value.application.originalMarker = '__TAURI_BUNDLE_TYPE_VAR_MSI'; },
    value => { value.application.embeddedMarker = '__TAURI_BUNDLE_TYPE_VAR_DEB'; },
    value => { value.application.markerOffset = -1; }, value => { value.application.markerOffset = 1.5; },
    value => { value.application.markerOffset = Number.MAX_SAFE_INTEGER; },
    value => { value.application.byteLength = 26; }, value => { value.application.byteLength = 1050; },
    value => { value.application.byteLength = 32768.5; }, value => { value.application.changedOffsets = [1046, 1047, 1048]; },
    value => { value.application.changedOffsets.push(2000); }, value => { value.application.changedOffsets.pop(); },
    value => { value.application.originalSha256 = '0'.repeat(64); }, value => { value.application.embeddedSha256 = '0'.repeat(64); },
    value => { value.application.originalSha256 = value.application.embeddedSha256; },
  ]) {
    const audit = structuredClone(original); change(audit); writeFileSync(path, JSON.stringify(audit)); reseal(directory);
    assert.throws(() => validateRelease(directory, version), /Embedded application identity/);
  }
});
test('production and lifecycle reports cannot jointly substitute an app outside the audited marker patch', t => {
  const directory = fixture(t), productionPath = join(directory, 'production-smoke.json'), smokePath = join(directory, 'installer-smoke.json');
  const originalSmoke = JSON.parse(readFileSync(smokePath));
  writeFileSync(smokePath, JSON.stringify({ ...originalSmoke, originalApplicationSha256: '0'.repeat(64) })); reseal(directory);
  assert.throws(() => validateRelease(directory, version), /Embedded application identity/);
  const production = JSON.parse(readFileSync(productionPath)); production.applicationSha256 = '0'.repeat(64);
  writeFileSync(productionPath, JSON.stringify(production));
  writeFileSync(smokePath, JSON.stringify({ ...originalSmoke, productionApplicationSha256: production.applicationSha256,
    productionSmokeSha256: createHash('sha256').update(readFileSync(productionPath)).digest('hex') }));
  reseal(directory);
  assert.throws(() => validateRelease(directory, version), /Embedded application identity/);
});

function publisher(t, options = {}) {
  const directory = fixture(t), calls = [];
  const assets = validateRelease(directory, version).map(({ name, size }) => ({ name, size }));
  const run = (program, args) => {
    assert.equal(program, 'gh'); calls.push(args);
    const endpoint = args.at(-1);
    let output = '';
    if (args.includes('--paginate')) {
      output = JSON.stringify([endpoint.includes('matching-refs') ? (options.existingTag ? [{ ref: `refs/tags/v${version}` }] : [])
        : (options.existingRelease ? [{ tag_name: `v${version}`, draft: true }] : [])]);
    } else if (args[0] === 'api') {
      output = JSON.stringify({ draft: true, assets: options.assets?.(assets) ?? assets });
    }
    return { status: 0, stdout: output, stderr: '' };
  };
  const env = { GITHUB_REPOSITORY: 'owner/surtitle', GITHUB_REF: 'refs/heads/release', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sha };
  return { calls, publish: () => publishRelease({ directory, version, env, run }) };
}

test('publishing rejects existing version tags or releases without writing anything', t => {
  for (const options of [{ existingTag: true }, { existingRelease: true }]) {
    const f = publisher(t, options);
    assert.throws(f.publish, /already exists/);
    assert.ok(f.calls.every(args => args[0] === 'api' && args.includes('--paginate')));
  }
});

test('publishing leaves incomplete uploads as drafts', t => {
  for (const assets of [items => items.slice(1), items => items.map((item, index) => index === 0 ? { ...item, size: item.size + 1 } : item),
    items => [items[0], items[0], ...items.slice(2)]]) {
    const f = publisher(t, { assets });
    assert.throws(f.publish, /incomplete|missing/);
    assert.ok(f.calls.some(args => args[0] === 'release' && args[1] === 'create' && args.includes('--draft')));
    assert.ok(!f.calls.some(args => args[0] === 'release' && args[1] === 'edit'));
  }
});

test('publishing completes a full upload without internal digest or run-identity inputs', t => {
  const f = publisher(t);
  assert.equal(f.publish(), `v${version}`);
  assert.ok(f.calls.some(args => args[0] === 'release' && args[1] === 'create' && args[args.indexOf('--target') + 1] === sha));
  assert.deepEqual(f.calls.at(-1), ['release', 'edit', `v${version}`, '--repo', 'owner/surtitle', '--draft=false', '--latest']);
});
