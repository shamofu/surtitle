// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, parse } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const output = (path, value) => { writableDestination(path); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
const alias = 'surtitle_nsis_utils.dll';

export function verifyNsisApplication(original, embedded) {
  const originalMarker = '__TAURI_BUNDLE_TYPE_VAR_UNK';
  const embeddedMarker = '__TAURI_BUNDLE_TYPE_VAR_NSS';
  assert(Buffer.isBuffer(original) && Buffer.isBuffer(embedded) && original.length === embedded.length
    && original.length > originalMarker.length, 'NSIS application byte lengths differ');
  const markerOffset = original.indexOf(originalMarker);
  assert(markerOffset >= 0 && original.lastIndexOf(originalMarker) === markerOffset && original.indexOf(embeddedMarker) === -1,
    'The original application must contain one unpatched Tauri bundle marker');
  assert(embedded.indexOf(embeddedMarker) === markerOffset && embedded.lastIndexOf(embeddedMarker) === markerOffset
    && embedded.indexOf(originalMarker) === -1, 'The embedded application must contain only the corresponding NSIS marker');
  const expected = Buffer.from(original);
  expected.write(embeddedMarker, markerOffset, 'ascii');
  assert(expected.equals(embedded), 'The embedded application differs outside the exact Tauri NSIS bundle marker');
  const changedOffsets = [...Buffer.from(originalMarker)].flatMap((byte, offset) => byte !== embeddedMarker.charCodeAt(offset) ? [markerOffset + offset] : []);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  return { originalSha256: digest(original), embeddedSha256: digest(embedded), transformation: 'tauri-nsis-bundle-marker',
    markerOffset, changedOffsets, originalMarker, embeddedMarker, byteLength: original.length };
}

export function regular(base, name) {
  assert(typeof name === 'string' && !isAbsolute(name) && !name.split(/[\\/]/).some(part => part === '..'), 'Unsafe installer evidence path');
  const path = resolve(base, name);
  const rel = relative(resolve(base), path);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Installer evidence escapes its root');
  let cursor = parse(path).root;
  const parts = relative(cursor, path).split(/[\\/]/);
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]);
    const item = lstatSync(cursor);
    assert(!item.isSymbolicLink() && (index === parts.length - 1 ? item.isFile() : item.isDirectory()), 'Installer evidence must have regular ancestry');
  }
  return path;
}
function checked(base, item) {
  assert(/^[a-f0-9]{64}$/.test(item.sha256), 'Invalid installer evidence hash');
  const path = regular(base, item.file ?? item.path);
  assert(hash(path) === item.sha256, `Changed installer evidence: ${item.file ?? item.path}`);
  return path;
}
export function writableDestination(path, directory = false) {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  const parts = relative(cursor, absolute).split(/[\\/]/);
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]);
    try {
      const item = lstatSync(cursor);
      assert(!item.isSymbolicLink() && (index === parts.length - 1 && !directory ? item.isFile() : item.isDirectory()), 'Installer output must have regular ancestry');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function copy(source, target) { writableDestination(target); mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target); }

export function validatePluginBuild(directory, root = workspace) {
  const policy = json(regular(root, 'native/nsis-plugin/inputs.json'));
  const evidence = json(regular(directory, 'build-evidence.json'));
  assert(evidence.schemaVersion === 2 && evidence.component === 'nsis-tauri-utils'
    && evidence.version === policy.pluginVersion && evidence.sourceCommit === policy.sourceCommit
    && isDeepStrictEqual(evidence.inputs, policy), 'Plugin build does not match reviewed inputs');
  assert(evidence.cargoLockSha256 === hash(regular(root, 'native/nsis-plugin/Cargo.lock'))
    && evidence.cargoLockSha256 === policy.cargoLockSha256, 'Plugin dependency lock differs');
  const expected = ['scripts/nsis-plugin-build.py', 'scripts/nsis-plugin-build.ps1', 'scripts/nsis-plugin-smoke.ps1', 'native/nsis-plugin/inputs.json', 'native/nsis-plugin/Cargo.lock', 'native/nsis-plugin/README.md', 'package.json'];
  assert(Array.isArray(evidence.recipe) && evidence.recipe.length === expected.length
    && expected.every(path => evidence.recipe.filter(item => item.path === path).length === 1), 'Incomplete plugin recipe');
  for (const item of evidence.recipe) checked(root, item);
  validateDependencyAcquisition(evidence, json(regular(root, 'package.json')).packageManager);
  assert(evidence.runtime?.file === 'nsis_tauri_utils.dll', 'Unexpected plugin runtime');
  const runtime = checked(directory, evidence.runtime);
  assert(lstatSync(runtime).size === evidence.runtime.bytes && evidence.smoke?.passed === true
    && evidence.smoke.sha256.toLowerCase() === evidence.runtime.sha256, 'Plugin functional smoke does not match its bytes');
  assert(evidence.toolchain?.verifiedHostStandardLibraryFiles?.length > 0
    && evidence.toolchain?.i686StandardLibraryFiles?.length > 0, 'Missing exact Rust standard library evidence');
  for (const field of ['sourcePackage', 'rustRuntimeSourcePackage']) checked(directory, evidence[field]);
  for (const [field, folder] of [['notices', 'notices'], ['runtimeNotices', 'rust-runtime-notices']]) {
    assert(Array.isArray(evidence[field]) && evidence[field].length > 0, 'Missing plugin/runtime notices');
    for (const item of evidence[field]) checked(join(directory, folder), item);
  }
  return evidence;
}

export function validateDependencyAcquisition(evidence, packageManager) {
  const acquisition = evidence.dependencyAcquisition;
  assert(/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)
    && acquisition?.packageManager === packageManager
    && 'pnpm@' + acquisition?.pnpmVersion === packageManager, 'Plugin dependency acquisition used a different pnpm version');
  assert(isDeepStrictEqual(acquisition.settings, { packages: ['.'], cargo: { enabled: true } })
    && acquisition.workspaceConfigSha256 === createHash('sha256').update("packages:\n  - '.'\ncargo:\n  enabled: true\n").digest('hex')
    && isDeepStrictEqual(acquisition.installArguments, ['install', '--frozen-lockfile', '--ignore-scripts'])
    && isDeepStrictEqual(acquisition.vendorArguments, ['vendor', '--respect-source-config', '--locked', '--offline', '--versioned-dirs'])
    && /^[a-f0-9]{64}$/.test(evidence.dependencyInstallLogSha256), 'Incomplete pnpm dependency acquisition evidence');
}

export function validateTemplate(root, inputs) {
  const upstream = readFileSync(checked(root, inputs.upstreamTemplate), 'utf8');
  const expected = upstream.replaceAll('nsis_tauri_utils::', 'surtitle_nsis_utils::')
    .replace('!include "utils.nsh"\n', '')
    .replace('!include "{{installer_hooks}}"\n{{/if}}', '!include "{{installer_hooks}}"\n{{/if}}\n!include "${SURTITLE_NATIVE_DIR}\\installer-utils.nsh"')
    .replace('!addplugindir "${ADDITIONALPLUGINSPATH}"', '!addplugindir "${ADDITIONALPLUGINSPATH}"\n!addplugindir "${SURTITLE_PLUGIN_DIR}"');
  assert(readFileSync(regular(root, 'native/installer.nsi'), 'utf8') === expected, 'The custom installer template has unreviewed changes');
  const helpers = readFileSync(checked(root, inputs.upstreamHelpers), 'utf8');
  assert(readFileSync(regular(root, 'native/installer-utils.nsh'), 'utf8') === helpers.replaceAll('nsis_tauri_utils::', 'surtitle_nsis_utils::'), 'Custom installer helper macros have unreviewed changes');
  const config = json(regular(root, 'src-tauri/tauri.conf.json'));
  assert(config.bundle.useLocalToolsDir === true && config.bundle.windows.nsis.template === '../native/installer.nsi'
    && config.bundle.windows.nsis.installerHooks === '../native/windows-prerequisite.nsh', 'The installer must use the reviewed local-tools/template configuration');
}

function stage(pluginDirectory) {
  const root = join(workspace, 'work/native-installer-tools');
  assert(!existsSync(root), 'Installer evidence staging must be fresh');
  writableDestination(root, true);
  const inputs = json(regular(workspace, 'native/installer-inputs.json'));
  validateTemplate(workspace, inputs);
  const plugin = validatePluginBuild(pluginDirectory);
  const downloads = join(workspace, 'work/native-installer-downloads');
  for (const item of [inputs.toolArchive, inputs.sourceArchive, inputs.cacheOnlyPlugin]) checked(downloads, item);
  const privateTools = join(workspace, 'target/.tauri/NSIS');
  for (const item of inputs.embeddedFiles) {
    const file = item.file.endsWith('.bmp') ? 'Contrib/Graphics/Wizard/win.bmp' : 'Plugins/x86-unicode/' + basename(item.file);
    checked(privateTools, { file, sha256: item.sha256 });
  }
  checked(privateTools, { file: 'Stubs/lzma_solid-x86-unicode', sha256: inputs.stubSha256 });
  mkdirSync(root, { recursive: true });
  copy(regular(pluginDirectory, plugin.runtime.file), join(root, 'plugin', alias));
  const packages = [
    [checked(downloads, inputs.sourceArchive), inputs.sourceArchive.file],
    [checked(pluginDirectory, plugin.sourcePackage), plugin.sourcePackage.file],
    [checked(pluginDirectory, plugin.rustRuntimeSourcePackage), plugin.rustRuntimeSourcePackage.file],
    [regular(pluginDirectory, 'build-evidence.json'), 'plugin-build-evidence.json'],
    [regular(pluginDirectory, 'rust-runtime-evidence.json'), 'rust-runtime-evidence.json'],
  ];
  const sourcePackages = packages.map(([source, file]) => {
    copy(source, join(root, 'sources', file));
    return { file, sha256: hash(source) };
  });
  const notices = [];
  const recordNotice = (source, suffix) => {
    const file = 'notices/installer/' + suffix;
    copy(source, join(workspace, 'src-tauri/resources', file));
    notices.push({ file, sha256: hash(source) });
  };
  for (const item of inputs.notices) recordNotice(checked(join(workspace, 'native/installer-notices'), item), item.file);
  for (const [field, folder, prefix] of [['notices', 'notices', 'plugin'], ['runtimeNotices', 'rust-runtime-notices', 'rust-runtime']]) {
    for (const item of plugin[field]) recordNotice(checked(join(pluginDirectory, folder), item), prefix + '/' + item.file);
  }
  const receipt = { schemaVersion: 1, sha: process.env.GITHUB_SHA ?? null,
    inputsSha256: hash(join(workspace, 'native/installer-inputs.json')), plugin: { file: alias, sha256: plugin.runtime.sha256 },
    pluginInputsSha256: hash(join(workspace, 'native/nsis-plugin/inputs.json')),
    templateSha256: hash(join(workspace, 'native/installer.nsi')), sourcePackages, notices,
    nsisToolArchiveSha256: inputs.toolArchive.sha256, sourcePluginDirectory: relative(workspace, pluginDirectory).replaceAll('\\', '/') };
  output(join(root, 'receipt.json'), receipt);
  console.log('Prepared exact source-backed installer plugin, notices and source packages. Final installer extraction remains required.');
}

export function validateInstallerExtraction(directory, inputs, receipt, root = workspace) {
  assert(!existsSync(join(directory, '$PLUGINSDIR/nsis_tauri_utils.dll')), 'Unreviewed prebuilt utility was embedded');
  const expected = [...inputs.embeddedFiles, { file: '$PLUGINSDIR/' + alias, sha256: receipt.plugin.sha256 },
    ...receipt.notices, { file: '$PLUGINSDIR/surtitle-vc-prerequisite.ps1', sha256: hash(regular(root, 'native/vc-prerequisite.ps1')) }];
  for (const item of expected) checked(directory, item);
  const allowedPlugins = new Set(expected.filter(item => item.file.startsWith('$PLUGINSDIR/')).map(item => basename(item.file)));
  assert(readdirSync(join(directory, '$PLUGINSDIR')).every(file => allowedPlugins.has(file)), 'Unexpected transient installer component');
  return expected.map(item => ({ file: item.file, sha256: item.sha256 }));
}

function resourceFiles(root, folder) {
  const files = [];
  const visit = name => {
    const directory = resolve(root, name);
    writableDestination(directory, true);
    assert(lstatSync(directory).isDirectory(), 'Resource directory must exist');
    for (const entry of readdirSync(directory).sort()) {
      const child = name + '/' + entry;
      const item = lstatSync(resolve(root, child));
      assert(!item.isSymbolicLink(), 'Bundled resources must not traverse links');
      if (item.isDirectory()) visit(child);
      else files.push({ file: child, sha256: hash(regular(root, child)) });
    }
  };
  visit(folder);
  return files;
}

export function validateBundledResources(directory, root = workspace,
  installerNotices = json(regular(root, 'work/native-installer-tools/receipt.json')).notices) {
  assert(isDeepStrictEqual(readdirSync(directory).sort(), ['$PLUGINSDIR', 'native', 'notices', 'surtitle.exe', 'uninstall.exe']),
    'Unexpected or missing top-level installer payload');
  regular(directory, 'surtitle.exe');
  regular(directory, 'uninstall.exe');
  const config = json(regular(root, 'src-tauri/tauri.conf.json'));
  assert(isDeepStrictEqual(config.bundle?.resources, {
    'resources/native/': 'native/', 'resources/notices/': 'notices/',
  }), 'Review changed installer resource mappings before packaging');
  const staged = join(root, 'src-tauri/resources');
  const manifest = json(regular(root, 'native/runtime-windows-x64.json'));
  const expectedNative = manifest.components.flatMap(component => [
    ...component.runtimeFiles.map(file => ({ file: 'native/' + file.target, sha256: file.sha256 })),
    ...component.noticeFiles.map(file => ({ file: 'native/' + basename(file.path), sha256: file.sha256 })),
  ]);
  // The source directory placeholder is harmless but remains byte-bound too.
  if (existsSync(join(staged, 'native/.gitkeep'))) {
    const placeholder = regular(staged, 'native/.gitkeep');
    assert(['', '\n', '\r\n'].some(value => readFileSync(placeholder).equals(Buffer.from(value))), 'Native directory placeholder must be empty');
    expectedNative.push({ file: 'native/.gitkeep', sha256: hash(placeholder) });
  }
  assert(new Set(expectedNative.map(item => item.file)).size === expectedNative.length, 'Duplicate native resource destination');
  for (const item of expectedNative) checked(staged, item);
  const ordered = rows => [...rows].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  assert(isDeepStrictEqual(ordered(resourceFiles(staged, 'native')), ordered(expectedNative)), 'Unmanifested native resource; separately downloaded tools and models must not be bundled');
  const applicationNotices = ['javascript.txt', 'rust.html', 'README.txt'];
  for (const name of applicationNotices) {
    assert(lstatSync(regular(staged, 'notices/' + name)).size > 0, 'Required application dependency notices are empty');
  }
  assert(Array.isArray(installerNotices) && installerNotices.length > 0, 'The verified installer notice receipt is required');
  for (const item of installerNotices) {
    assert(item.file.startsWith('notices/installer/'), 'Unexpected installer notice destination');
    checked(staged, item);
  }
  const expectedNotices = [
    ...applicationNotices.map(name => ({ file: 'notices/' + name, sha256: hash(regular(staged, 'notices/' + name)) })),
    ...installerNotices,
  ];
  assert(isDeepStrictEqual(ordered(resourceFiles(staged, 'notices')), ordered(expectedNotices)), 'Unmanifested staged notice resource');
  const expected = ordered([...expectedNative, ...expectedNotices]);
  const actual = ordered([...resourceFiles(directory, 'native'), ...resourceFiles(directory, 'notices')]);
  assert(isDeepStrictEqual(actual, expected), 'Bundled application resources differ from the verified DLLs and complete staged notices');
  return expected;
}

function prepared() {
  const root = join(workspace, 'work/native-installer-tools');
  const receipt = json(regular(root, 'receipt.json'));
  const inputs = json(regular(workspace, 'native/installer-inputs.json'));
  const toolCheck = spawnSync('python', [join(workspace, 'scripts/native-installer-tool-check.py')], { encoding: 'utf8' });
  assert(toolCheck.status === 0, 'Private NSIS tools differ from their authenticated archive: ' + toolCheck.stderr);
  validateTemplate(workspace, inputs);
  assert(receipt.inputsSha256 === hash(join(workspace, 'native/installer-inputs.json'))
    && receipt.pluginInputsSha256 === hash(join(workspace, 'native/nsis-plugin/inputs.json'))
    && receipt.templateSha256 === hash(join(workspace, 'native/installer.nsi')), 'Prepared installer inputs changed');
  assert(receipt.sha === (process.env.GITHUB_SHA ?? null), 'Installer build receipt belongs to another commit');
  const evidence = validatePluginBuild(resolve(workspace, receipt.sourcePluginDirectory));
  assert(evidence.runtime.sha256 === receipt.plugin.sha256 && receipt.plugin.file === alias, 'Prepared plugin identity changed');
  assertSourcePackageBinding(receipt, inputs, evidence, resolve(workspace, receipt.sourcePluginDirectory));
  assertInstallerNoticeBinding(receipt, inputs, evidence);
  for (const item of receipt.sourcePackages) checked(join(root, 'sources'), item);
  checked(join(root, 'plugin'), receipt.plugin);
  return { root, receipt, inputs };
}

export function assertInstallerNoticeBinding(receipt, inputs, evidence) {
  const expected = [
    ...inputs.notices.map(item => ({ file: 'notices/installer/' + item.file, sha256: item.sha256 })),
    ...evidence.notices.map(item => ({ file: 'notices/installer/plugin/' + item.file, sha256: item.sha256 })),
    ...evidence.runtimeNotices.map(item => ({ file: 'notices/installer/rust-runtime/' + item.file, sha256: item.sha256 })),
  ];
  assert(isDeepStrictEqual(receipt.notices, expected), 'Installer notice receipt omits or changes required source-backed notices');
}

export function assertSourcePackageBinding(receipt, inputs, evidence, pluginDirectory) {
  const expected = [
    { file: inputs.sourceArchive.file, sha256: inputs.sourceArchive.sha256 },
    { file: evidence.sourcePackage.file, sha256: evidence.sourcePackage.sha256 },
    { file: evidence.rustRuntimeSourcePackage.file, sha256: evidence.rustRuntimeSourcePackage.sha256 },
    { file: 'plugin-build-evidence.json', sha256: hash(regular(pluginDirectory, 'build-evidence.json')) },
    { file: 'rust-runtime-evidence.json', sha256: hash(regular(pluginDirectory, 'rust-runtime-evidence.json')) },
  ];
  assert(isDeepStrictEqual(receipt.sourcePackages, expected), 'Staged source packages differ from the validated plugin build');
}

function main() {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'stage') return stage(resolve(first));
  const { root, receipt, inputs } = prepared();
  if (command === 'source-check') {
    const sources = resolve(first, 'native-installer-sources');
    assert(hash(regular(sources, 'installer-build-receipt.json')) === hash(join(root, 'receipt.json')), 'Installer source receipt is missing or changed');
    for (const item of receipt.sourcePackages) checked(sources, item);
    console.log('Installer source archive contains the exact prepared receipt and all corresponding-source packages.');
    return;
  }
  assert(command === 'audit' && first && second, 'Usage: native-installer-audit.mjs stage PLUGIN_DIR | audit INSTALLER EXTRACTED_DIR | source-check SOURCE_ROOT');
  const files = validateInstallerExtraction(resolve(second), inputs, receipt);
  const resourceFiles = validateBundledResources(resolve(second));
  const application = verifyNsisApplication(readFileSync(regular(workspace, 'target/release/surtitle.exe')),
    readFileSync(regular(resolve(second), 'surtitle.exe')));
  application.upstreamProof = { path: 'native/upstream-evidence/tauri-bundle-2.11.4.rs',
    sha256: 'a4622ce32d88b99e8a785d57cfd96ebc2aa99d066a3c7bb17c0634a8a943aa3d',
    url: 'https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs' };
  checked(workspace, application.upstreamProof);
  const manifest = json(join(workspace, 'native/runtime-windows-x64.json'));
  for (const component of manifest.components) for (const file of component.runtimeFiles) checked(resolve(second), { file: 'native/' + file.target, sha256: file.sha256 });
  const report = { schemaVersion: 1, sha: process.env.GITHUB_SHA ?? null, installerSha256: hash(resolve(first)),
    effectiveManifestSha256: hash(join(workspace, 'native/runtime-windows-x64.json')),
    sourceReceiptSha256: hash(join(root, 'receipt.json')), pluginSha256: receipt.plugin.sha256,
    sourcePackages: receipt.sourcePackages, files, resourceFiles, application, releaseEligible: true, errors: [] };
  writableDestination(join(workspace, 'artifacts'), true);
  mkdirSync(join(workspace, 'artifacts'), { recursive: true });
  output(join(workspace, 'artifacts/installer-audit.json'), report);
  console.log('Exact embedded installer plugin, notices, native DLLs and corresponding sources verified.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
