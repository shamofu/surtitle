// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFileSync, constants, existsSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, sha256File } from './file-content.mjs';

const inventory = readJson(fileURLToPath(new URL('../packaging/native-acceptance.json', import.meta.url)));
export const requiredNativeCases = Object.freeze(inventory.requiredCases.map(Object.freeze));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function requireCheck(condition, message) { if (!condition) throw new Error(message); }
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function measuredValue(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return nonempty(value);
  return value && typeof value === 'object' && Object.values(value).some(measuredValue);
}
function validateProvenance(report, receipt) {
  requireCheck(digest(receipt?.executableSha256) && digest(receipt?.installerSha256) && /^[a-f0-9]{40}$/.test(receipt?.sourceRevision ?? ''), 'Native acceptance needs binary/installer hashes and a source revision');
  for (const field of ['executableSha256', 'installerSha256', 'sourceRevision']) requireCheck(report?.[field] === receipt[field], `Native acceptance ${field} provenance differs from the production build`);
}
const finite = value => typeof value === 'number' && Number.isFinite(value);
const physicalBounds = value => value && ['x','y','width','height'].every(key=>finite(value[key])) && value.width>0 && value.height>0;
const displaySize = value => value && finite(value.width) && finite(value.height) && value.width>0 && value.height>0;
function validateCase(required, item, executableSha256) {
  requireCheck(item.method === required.method && typeof item.observations?.summary === 'string' && item.observations.summary.trim().length > 0
    && item.observations.measurements && typeof item.observations.measurements === 'object' && !Array.isArray(item.observations.measurements) && measuredValue(item.observations.measurements),
  `Native acceptance ${item.id} lacks actual ${required.method} measurements and observations`);
  requireCheck(item.source && (required.method === 'native-uia' ? item.source.kind === 'native-uia' : ['manual', 'external-probe'].includes(item.source.kind))
    && typeof item.source.operator === 'string' && item.source.operator.trim() && typeof item.source.observedAt === 'string' && Number.isFinite(Date.parse(item.source.observedAt)),
  `Native acceptance ${item.id} lacks an identified observation source/time`);
  if (item.id === 'audio-output') {
    const m = item.observations.measurements;
    requireCheck(typeof m.directListeningPerformed === 'boolean' && nonempty(m.outputDevice) && nonempty(m.captureMethod)
      && ['signalRmsDbfs','measuredDurationMs','stopExpectedMs','stopObservedMs','stopToleranceMs'].every(key => typeof m[key] === 'number' && Number.isFinite(m[key]))
      && m.measuredDurationMs > 0 && m.stopExpectedMs >= 0 && m.stopObservedMs >= 0 && m.stopToleranceMs >= 0,
    'Native acceptance audio-output needs measured signal/output and stop timing, and must distinguish actual direct listening');
  }
  if (item.id === 'rendered-composition') {
    const m=item.observations.measurements;
    requireCheck(nonempty(m.captureMethod) && Array.isArray(m.layouts) && required.requiredLayouts.every(id=>m.layouts.some(layout=>layout.id===id
      && displaySize(layout.clientLogicalSize) && finite(layout.frameCount) && layout.frameCount>=2
      && finite(layout.videoVisibleFrames) && layout.videoVisibleFrames>0 && finite(layout.dialogVisibleFrames) && layout.dialogVisibleFrames>0
      && finite(layout.transitionFrames) && layout.transitionFrames>0 && nonempty(layout.observedResult))),
    'Native acceptance rendered-composition needs actual normal/wide GPU/video/dialog/transition frame observations');
    requireCheck(m.layouts.find(layout=>layout.id==='wide').clientLogicalSize.width>m.layouts.find(layout=>layout.id==='normal').clientLogicalSize.width,
      'Native acceptance rendered-composition requires distinct normal and wide layouts');
  }
  if (item.id === 'real-japanese-ime') {
    const m=item.observations.measurements;
    requireCheck(m.languageTag==='ja-JP' && nonempty(m.imeEngine) && nonempty(m.imeVersion) && nonempty(m.preeditText) && nonempty(m.candidateText)
      && nonempty(m.committedText) && m.committedText===m.restoredText && physicalBounds(m.candidateBounds) && physicalBounds(m.workArea)
      && finite(m.windowDpi) && m.windowDpi>0 && nonempty(m.observedResult),
    'Native acceptance real-japanese-ime requires attributed engine, preedit/candidate geometry, commit and restart observations');
  }
  if (item.id === 'interval-auto-stop') {
    const m=item.observations.measurements;
    requireCheck(Array.isArray(m.stops) && required.requiredStopKinds.every(kind=>m.stops.some(stop=>stop.kind===kind
      && ['requestedStartMs','expectedStopMs','observedStopMs','toleranceMs'].every(key=>finite(stop[key]))
      && stop.requestedStartMs>=0 && stop.expectedStopMs>stop.requestedStartMs && stop.observedStopMs>=stop.requestedStartMs
      && stop.toleranceMs>=0 && nonempty(stop.clockSource) && nonempty(stop.observedResult))),
    'Native acceptance interval-auto-stop requires actual source and sentence stop clock records');
  }
  if (item.id === 'long-media') {
    const m=item.observations.measurements;
    requireCheck(digest(m.sourceSha256) && finite(m.sourceDurationMs) && m.sourceDurationMs>0 && nonempty(m.criteria)
      && Array.isArray(m.seeks) && m.seeks.length>=2 && m.seeks.every(seek=>finite(seek.targetMs) && seek.targetMs>=0 && seek.targetMs<m.sourceDurationMs
        && finite(seek.observedMs) && seek.observedMs>=0 && seek.observedMs<=m.sourceDurationMs && finite(seek.latencyMs) && seek.latencyMs>=0)
      && m.restart && finite(m.restart.beforePid) && finite(m.restart.afterPid) && m.restart.beforePid>0 && m.restart.afterPid>0 && m.restart.beforePid!==m.restart.afterPid
      && finite(m.restart.observedPositionMs) && nonempty(m.restart.observedResult)
      && m.transcriptScroll && finite(m.transcriptScroll.totalCueCount) && m.transcriptScroll.totalCueCount>0 && nonempty(m.transcriptScroll.firstCueId)
      && nonempty(m.transcriptScroll.lastCueId) && finite(m.transcriptScroll.maxLatencyMs) && m.transcriptScroll.maxLatencyMs>=0,
    'Native acceptance long-media requires actual source hash/duration/criteria, seek clocks, process restart and transcript-scroll observations');
  }
  if (item.id === 'gpu-performance') {
    const m = item.observations.measurements;
    requireCheck(nonempty(m.hardware) && nonempty(m.measurementMethod) && nonempty(m.criteria) && Array.isArray(m.workloads),
      'Native acceptance gpu-performance needs hardware, measurement method, criteria and comparable workloads');
    for (const workload of required.requiredWorkloads) {
      const samples=m.workloads.filter(sample=>sample.id===workload.id);
      requireCheck(samples.length===1, `Native acceptance gpu-performance requires one current ${workload.id} measurement`);
      const sample=samples[0], current=sample.current;
      requireCheck(sample.width===workload.width && sample.height===workload.height && sample.fps===workload.fps && current,
        `Native acceptance gpu-performance ${workload.id} lacks the specified video dimensions/fps and current measurements`);
      requireCheck(current.executableSha256===executableSha256 && digest(current.assetSha256) && displaySize(current.displaySize),
        `Native acceptance gpu-performance ${workload.id} must identify the current binary, source asset and display size`);
      requireCheck(required.requiredMetrics.every(key=>finite(current[key])) && current.sampleWindowMs>0 && current.droppedFrames>=0,
        `Native acceptance gpu-performance ${workload.id} requires actual current CPU/GPU/drop/A-V-sync measurements`);
    }
  }
  if (item.id === 'dpi-monitor-transitions') {
    const m=item.observations.measurements;
    requireCheck(Array.isArray(m.dpiSamples) && Array.isArray(m.monitorMoves), 'Native acceptance dpi-monitor-transitions needs actual DPI samples and monitor moves');
    for (const percentage of required.requiredDpiPercentages) {
      requireCheck(m.dpiSamples.some(sample=>sample.scalePercent===percentage && sample.windowDpi===96*percentage/100 && nonempty(sample.monitor)
        && physicalBounds(sample.viewportBounds) && physicalBounds(sample.nativeVideoBounds) && physicalBounds(sample.workArea)),
      `Native acceptance dpi-monitor-transitions lacks the actual ${percentage}% DPI viewport/native/work-area observation`);
    }
    requireCheck(m.monitorMoves.some(move=>nonempty(move.fromMonitor) && nonempty(move.toMonitor) && move.fromMonitor!==move.toMonitor
      && finite(move.fromDpi) && finite(move.toDpi) && physicalBounds(move.beforeViewportBounds) && physicalBounds(move.afterViewportBounds)
      && physicalBounds(move.beforeNativeVideoBounds) && physicalBounds(move.afterNativeVideoBounds)),
    'Native acceptance dpi-monitor-transitions requires an observed move between distinct monitors and before/after video geometry');
  }
  if (item.id === 'keyboard-clipboard-accessibility') {
    const m=item.observations.measurements;
    requireCheck(['physical-keyboard','windows-sendinput'].includes(m.keyboardInputMethod) && Array.isArray(m.keyboardOperations) && required.requiredKeyboardOperations.every(operation=>m.keyboardOperations.some(record=>record.operation===operation && nonempty(record.keys) && nonempty(record.observedResult))),
      'Native acceptance keyboard-clipboard-accessibility lacks real keyboard operation records');
    requireCheck(m.clipboard && m.clipboard.format==='CF_UNICODETEXT' && nonempty(m.clipboard.copiedText) && m.clipboard.copiedText===m.clipboard.pastedText,
      'Native acceptance keyboard-clipboard-accessibility needs an actual clipboard round trip');
    requireCheck(m.screenReader && nonempty(m.screenReader.product) && nonempty(m.screenReader.version) && nonempty(m.screenReader.outputCaptureMethod) && Array.isArray(m.screenReader.operations)
      && required.requiredScreenReaderOperations.every(operation=>m.screenReader.operations.some(record=>record.operation===operation && nonempty(record.controlRole) && nonempty(record.controlName) && nonempty(record.spokenText) && nonempty(record.observedResult))),
    'Native acceptance keyboard-clipboard-accessibility lacks principal screen-reader operation observations');
  }
  requireCheck(Array.isArray(item.evidence) && item.evidence.length > 0 && item.evidence.every(entry =>
    typeof entry.path === 'string' && entry.path.length > 0 && !isAbsolute(entry.path) && !entry.path.split(/[\\/]/).includes('..') && digest(entry.sha256)),
  `Native acceptance ${item.id} lacks safe relative evidence paths and SHA256 digests`);
}
function evidencePath(root, entry) {
  const path = resolve(root, entry.path);
  const inside = relative(root, realpathSync.native(path));
  requireCheck(inside !== '' && !isAbsolute(inside) && !inside.startsWith('..'), `Native acceptance evidence escapes the report directory: ${entry.path}`);
  let current = root;
  for (const part of relative(root, path).split(/[\\/]/)) {
    current = resolve(current, part);
    requireCheck(!lstatSync(current).isSymbolicLink(), `Native acceptance evidence traverses a link: ${entry.path}`);
  }
  const stat = lstatSync(path);
  requireCheck(stat.isFile() && stat.size > 0 && sha256File(path) === entry.sha256, `Native acceptance evidence is empty or changed: ${entry.path}`);
  return path;
}

export function validateNativeAcceptance(report, executableSha256) {
  requireCheck(report?.schemaVersion === inventory.schemaVersion && report.suite === inventory.suite,
    'Expected the comprehensive GPUI Windows acceptance suite/schema; a production smoke is insufficient');
  requireCheck(digest(executableSha256) && report.executableSha256 === executableSha256, 'Native acceptance binary hash differs from the production executable');
  requireCheck(report.normalBuild === true, 'Native acceptance requires the production build');
  requireCheck(report.paidRequests === 0, 'Native acceptance must contain zero paid requests');
  requireCheck(Array.isArray(report.cases), 'Native acceptance case inventory is missing');
  const actual = new Map();
  for (const item of report.cases) {
    requireCheck(item && typeof item.id === 'string' && !actual.has(item.id), `Invalid or duplicate native acceptance case: ${item?.id}`);
    requireCheck(requiredNativeCases.some(required => required.id === item.id), `Unknown native acceptance case: ${item.id}`);
    actual.set(item.id, item);
  }
  const missing = requiredNativeCases.filter(required => actual.get(required.id)?.status !== 'passed');
  requireCheck(missing.length === 0, `Native acceptance incomplete: ${missing.map(item => `${item.id} (${actual.get(item.id)?.status ?? 'missing'})`).join(', ')}`);
  for (const required of requiredNativeCases) {
    const item = actual.get(required.id);
    validateCase(required, item, executableSha256);
  }
  requireCheck(report.passed === true, 'Native acceptance report records an unsuccessful run');
  requireCheck(Array.isArray(report.limitations) && report.limitations.every(value => typeof value === 'string'), 'Native acceptance limitations must be explicit');
  return report;
}

export function checkNativeAcceptance(reportPath, receiptPath) {
  const receipt = readJson(receiptPath);
  requireCheck(receipt.schema === 1 && receipt.productionBuild === true && digest(receipt.executableSha256), 'Native acceptance needs a production build receipt');
  const report = validateNativeAcceptance(readJson(reportPath), receipt.executableSha256);
  validateProvenance(report, receipt);
  const root = realpathSync.native(dirname(reportPath));
  for (const item of report.cases) for (const entry of item.evidence) {
    evidencePath(root, entry);
  }
  for (const source of report.externalSources ?? []) {
    requireCheck(typeof source.path === 'string' && !isAbsolute(source.path) && !source.path.split(/[\\/]/).includes('..') && digest(source.sha256), 'Invalid external observation source');
    evidencePath(root, source);
  }
  return report;
}

function externalInput(externalPath, receipt, requireComplete = false) {
  const external = readJson(externalPath);
  requireCheck(external.schemaVersion === inventory.schemaVersion && external.suite === 'gpui-windows-external' && external.normalBuild === true && external.paidRequests === 0, 'Expected an external GPUI measurement report for a zero-paid-request production run');
  validateProvenance(external, receipt);
  requireCheck(Array.isArray(external.cases) && new Set(external.cases.map(item => item.id)).size === external.cases.length, 'Duplicate external native case');
  const externalRoot = realpathSync.native(dirname(externalPath));
  // Validate the complete external input before copying any file.
  const transfers = [];
  for (const item of external.cases) {
    const required = requiredNativeCases.find(required => required.id === item.id);
    requireCheck(required && required.method !== 'native-uia', `External evidence cannot override automated case: ${item.id}`);
    requireCheck(item.status === 'passed', `External native case ${item.id} is not passed`);
    validateCase(required, item, receipt.executableSha256);
    transfers.push({ item, files: item.evidence.map(entry => ({entry, path:evidencePath(externalRoot, entry)})) });
  }
  if (requireComplete) {
    const missing=requiredNativeCases.filter(item=>item.method!=='native-uia' && !external.cases.some(actual=>actual.id===item.id));
    requireCheck(missing.length===0, `External evidence incomplete: ${missing.map(item=>item.id).join(', ')}`);
  }
  return {external, transfers};
}

export function checkExternalEvidence(externalPath, receiptPath, sourceRevision) {
  const receipt=readJson(receiptPath);
  requireCheck(receipt.schema===1 && receipt.productionBuild===true && receipt.sourceTreeClean===true, 'External intake requires a clean production candidate');
  requireCheck(/^[a-f0-9]{40}$/.test(sourceRevision ?? '') && receipt.sourceRevision===sourceRevision, 'External intake candidate source revision differs from the selected workflow revision');
  requireCheck(receiptPath.endsWith('.exe.build.json'), 'Expected the candidate installer build receipt');
  const installer=receiptPath.slice(0,-'.build.json'.length);
  requireCheck(lstatSync(installer).isFile() && !lstatSync(installer).isSymbolicLink() && sha256File(installer)===receipt.installerSha256, 'External intake installer hash differs from candidate receipt');
  return externalInput(externalPath,receipt,true).external;
}

// External/manual measurements may complete only the separately identified
// cases. They cannot turn a failed automated interaction into a passed case.
export function combineNativeAcceptance(automatedPath, receiptPath, outputPath, externalPath) {
  requireCheck(!existsSync(outputPath), 'Existing combined acceptance evidence is protected');
  const receipt = readJson(receiptPath), report = readJson(automatedPath);
  requireCheck(receipt.schema === 1 && receipt.productionBuild === true, 'Expected a production build receipt');
  requireCheck(report.schemaVersion === inventory.schemaVersion && report.suite === inventory.suite && report.normalBuild === true, 'Expected the automated GPUI suite');
  validateProvenance(report, receipt);
  requireCheck(Array.isArray(report.cases) && report.cases.length === requiredNativeCases.length && new Set(report.cases.map(item => item.id)).size === requiredNativeCases.length
    && requiredNativeCases.every(required => report.cases.some(item => item.id === required.id)), 'Automated native case inventory differs');
  const root = realpathSync.native(dirname(outputPath));
  requireCheck(realpathSync.native(dirname(automatedPath)) === root, 'Combined report must retain the automated evidence directory');
  for (const item of report.cases.filter(item => item.status === 'passed')) {
    validateCase(requiredNativeCases.find(required => required.id === item.id), item, receipt.executableSha256);
    for (const entry of item.evidence) evidencePath(root, entry);
  }
  if (externalPath) {
    const {external, transfers}=externalInput(externalPath,receipt);
    for (const {item} of transfers) requireCheck(report.cases.find(existing=>existing.id===item.id).status==='not_run', `External evidence cannot override an already measured case: ${item.id}`);
    const reportCopy = resolve(root, 'external-evidence-report.json');
    requireCheck(!existsSync(reportCopy), 'Existing external evidence is protected');
    copyFileSync(externalPath, reportCopy, constants.COPYFILE_EXCL);
    for (const {item, files} of transfers) {
      const evidence = files.map(({entry, path}, index) => {
        const name = `external-${item.id}-${index}-${basename(path)}`;
        copyFileSync(path, resolve(root, name), constants.COPYFILE_EXCL);
        return {...entry, path:name};
      });
      report.cases[report.cases.findIndex(existing => existing.id === item.id)] = {...item, evidence};
    }
    report.externalSources = [{path:'external-evidence-report.json',sha256:sha256File(reportCopy)}];
    report.limitations = [...(report.limitations ?? []), ...(external.limitations ?? [])];
  }
  report.passed = report.paidRequests === 0 && requiredNativeCases.every(required => report.cases.find(item => item.id === required.id)?.status === 'passed');
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', {flag:'wx'});
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--external') {
    if (process.argv.length!==6) throw new Error('Usage: node scripts/check-native-acceptance.mjs --external EXTERNAL BUILD_RECEIPT SOURCE_REVISION');
    checkExternalEvidence(resolve(process.argv[3]),resolve(process.argv[4]),process.argv[5]);
  } else if (process.argv[2] === '--combine') {
    if (![6,7].includes(process.argv.length)) throw new Error('Usage: node scripts/check-native-acceptance.mjs --combine AUTOMATED BUILD_RECEIPT OUTPUT [EXTERNAL]');
    const [, , , automated, receipt, output, external] = process.argv;
    combineNativeAcceptance(resolve(automated),resolve(receipt),resolve(output),external ? resolve(external) : undefined);
    checkNativeAcceptance(resolve(output),resolve(receipt));
  } else {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/check-native-acceptance.mjs REPORT BUILD_RECEIPT');
    checkNativeAcceptance(resolve(process.argv[2]), resolve(process.argv[3]));
  }
  console.log(process.argv[2] === '--external'
    ? 'External measurements match the exact candidate; automated native acceptance remains required.'
    : 'All required GPUI native acceptance cases have matching production-binary evidence.');
}
