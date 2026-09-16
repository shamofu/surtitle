import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';

/** Publish only the complete asset set verified by the package job. */
export function validateReleaseForPublish(directory, version) {
  return validateRelease(directory, version);
}

export function validateRelease(directory, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Invalid release version');
  const names = readdirSync(directory);
  if (names.some(name => basename(name) !== name || !lstatSync(join(directory, name)).isFile() || lstatSync(join(directory, name)).isSymbolicLink())) throw new Error('Release assets must be regular files in a flat directory');
  const required = ['release-manifest.json', 'SHA256SUMS.txt', 'surtitle-source.zip', 'native-audit.json', 'installer-smoke.json', 'production-smoke.json', 'installer-audit.json', 'installer-build-receipt.json', 'js-sbom.cdx.json', 'rust-dependencies.json', 'native-runtime-manifest.json', 'native-build-artifact.json'];
  if (required.some(name => !names.includes(name)) || names.filter(name => name.endsWith('.exe')).length !== 1) throw new Error('Release assets are incomplete or ambiguous');
  if (names.some(name => lstatSync(join(directory, name)).size === 0)) throw new Error('Release assets must not be empty');
  const manifest = JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8'));
  if (manifest.version !== version || manifest.installerSmokePassed !== true) throw new Error('Release manifest does not certify this version and installer smoke');
  const audit = JSON.parse(readFileSync(join(directory, 'native-audit.json'), 'utf8'));
  if (audit.artifactIntegrityPassed !== true || audit.releaseEligible !== true || !Array.isArray(audit.errors) || audit.errors.length || !Array.isArray(audit.blockers) || audit.blockers.length) throw new Error('Native redistribution audit has failures or blockers');
  const nativeManifest = JSON.parse(readFileSync(join(directory, 'native-runtime-manifest.json'), 'utf8'));
  const smoke = JSON.parse(readFileSync(join(directory, 'installer-smoke.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (['freshInstallPassed', 'startupPassed', 'overwriteInstallPassed', 'uninstallPassed', 'defaultDataRetentionPassed'].some(field => smoke[field] !== true) ||
      !Number.isSafeInteger(smoke.retainedFileCount) || smoke.retainedFileCount < 1 || smoke.retainedDataRemoved !== false) {
    throw new Error('Installer lifecycle evidence is incomplete or failed');
  }
  const production = JSON.parse(readFileSync(join(directory, 'production-smoke.json'), 'utf8'));
  const requiredProductionChecks = ['passed', 'normalBuild', 'appReady', 'settingsReady', 'nativeMetadataPassed', 'visibleSurfacePassed',
    'playbackAdvanced', 'intervalStopPassed', 'seekPassed', 'accountingUnchanged'];
  if (production.schemaVersion !== 1 || requiredProductionChecks.some(field => production[field] !== true)
      || production.paidRequests !== 0 || !/^[a-f0-9]{64}$/.test(production.applicationSha256 ?? '')
      || smoke.productionApplicationSha256 !== production.applicationSha256) {
    throw new Error('Installed production evidence is incomplete or failed');
  }
  const expectedNative = nativeManifest.components?.flatMap(component => component.runtimeFiles).map(file => `${file.target}:${file.sha256}`).sort();
  const observedNative = production.nativeFiles?.map(file => `${file.file}:${file.sha256}`).sort();
  if (!expectedNative?.length || !observedNative || new Set(observedNative).size !== observedNative.length
      || JSON.stringify(expectedNative) !== JSON.stringify(observedNative)) throw new Error('Installed production native DLL hashes differ from the effective manifest');
  for (const snapshot of [production.initial, production.final]) {
    const budget = snapshot?.budget;
    if (snapshot?.credentialConfigured !== false || snapshot.savedModelPreferenceCount !== 0
        || budget?.spentUsd !== 0 || budget.reservedUsd !== 0 || budget.limitUsd !== 0 || budget.unpricedAttempts !== 0
        || budget.monetaryTotalsComplete !== true || !Array.isArray(budget.unknownAttempts) || budget.unknownAttempts.length) {
      throw new Error('Installed production accounting/profile evidence is not empty and unpriced-free');
    }
  }
  if (production.ui?.modelInputs !== 4 || production.ui.unsetInputs !== 4 || production.ui.credentialMaterialVisible !== false) {
    throw new Error('Installed production Settings were not ready with four unset model fields');
  }
  const installerAudit = JSON.parse(readFileSync(join(directory, 'installer-audit.json'), 'utf8'));
  const installerBuild = JSON.parse(readFileSync(join(directory, 'installer-build-receipt.json'), 'utf8'));
  if (installerAudit.schemaVersion !== 1 || installerBuild.schemaVersion !== 1 || installerAudit.releaseEligible !== true
      || !Array.isArray(installerAudit.errors) || installerAudit.errors.length || installerBuild.plugin?.file !== 'surtitle_nsis_utils.dll'
      || !/^[a-f0-9]{64}$/.test(installerAudit.pluginSha256 ?? '') || installerAudit.pluginSha256 !== installerBuild.plugin.sha256) {
    throw new Error('Embedded installer audit does not certify this installer, source receipt and plugin');
  }
  // Tauri temporarily patches this fixed-width marker for NSIS, then restores
  // the original build output. The audit compares every other embedded byte.
  const originalMarker = '__TAURI_BUNDLE_TYPE_VAR_UNK';
  const embeddedMarker = '__TAURI_BUNDLE_TYPE_VAR_NSS';
  const application = installerAudit.application;
  const expectedChangedOffsets = [...Buffer.from(originalMarker)].flatMap((value, index) =>
    value === Buffer.from(embeddedMarker)[index] ? [] : [(application?.markerOffset ?? 0) + index]);
  if (application?.transformation !== 'tauri-nsis-bundle-marker' || application.originalMarker !== originalMarker || application.embeddedMarker !== embeddedMarker
      || !Number.isSafeInteger(application.markerOffset) || application.markerOffset < 0
      || !Number.isSafeInteger(application.byteLength) || application.byteLength < Buffer.byteLength(originalMarker)
      || application.markerOffset > application.byteLength - Buffer.byteLength(originalMarker)
      || JSON.stringify(application.changedOffsets) !== JSON.stringify(expectedChangedOffsets)
      || !/^[a-f0-9]{64}$/.test(application.originalSha256 ?? '') || !/^[a-f0-9]{64}$/.test(application.embeddedSha256 ?? '')
      || application.originalSha256 === application.embeddedSha256 || smoke.originalApplicationSha256 !== application.originalSha256
      || production.applicationSha256 !== application.embeddedSha256 || smoke.productionApplicationSha256 !== application.embeddedSha256) {
    throw new Error('Embedded application identity is not bound to the exact Tauri NSIS marker transformation');
  }
  function installerEntries(items) {
    if (!Array.isArray(items) || !items.length || items.some(item => typeof item.file !== 'string' || !item.file
        || /[\\:\x00-\x1f]/.test(item.file) || item.file.split('/').some(part => !part || part === '.' || part === '..')
        || !/^[a-f0-9]{64}$/.test(item.sha256 ?? ''))
        || new Set(items.map(item => item.file.toLowerCase())).size !== items.length) throw new Error('Embedded installer source/file inventory is invalid');
    return items.map(item => `${item.file}:${item.sha256}`).sort();
  }
  if (JSON.stringify(installerEntries(installerAudit.sourcePackages)) !== JSON.stringify(installerEntries(installerBuild.sourcePackages))) {
    throw new Error('Embedded installer source package hashes differ from the build receipt');
  }
  installerEntries(installerAudit.files);
  const embeddedPlugin = installerAudit.files.find(file => file.file === '$PLUGINSDIR/surtitle_nsis_utils.dll');
  if (embeddedPlugin?.sha256 !== installerAudit.pluginSha256
      || installerAudit.files.some(file => file.file.toLowerCase() === '$pluginsdir/nsis_tauri_utils.dll')) {
    throw new Error('Embedded installer uses an absent, altered or unreviewed Tauri plugin');
  }
  return names.map(name => ({ name, path: join(directory, name), size: lstatSync(join(directory, name)).size }));
}
