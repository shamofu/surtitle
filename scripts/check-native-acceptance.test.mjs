// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requiredNativeCases, validateNativeAcceptance, checkNativeAcceptance, combineNativeAcceptance, checkExternalEvidence } from './check-native-acceptance.mjs';
import { sha256File } from './file-content.mjs';
import { syntheticMeasurements } from './fixtures/native-acceptance.mjs';

const binary = 'a'.repeat(64);
function report() {
  return { schemaVersion: 1, suite: 'gpui-windows', executableSha256: binary, installerSha256:'c'.repeat(64),sourceRevision:'d'.repeat(40),normalBuild: true, paidRequests: 0,passed:true,
    cases: requiredNativeCases.map(item => ({ id: item.id, status: 'passed', method: item.method,
      source:{kind:item.method==='native-uia'?'native-uia':'external-probe',operator:'Synthetic gate test',observedAt:'2026-11-06T00:00:00Z'},
      observations: { summary: 'Synthetic acceptance record for gate tests only', measurements:syntheticMeasurements(item,binary) },
      evidence: [{ path: 'observations.json', sha256: 'b'.repeat(64) }] })),
    limitations: ['No claim of direct listening is made by this synthetic test fixture.'] };
}
test('acceptance rejects smoke-only, omitted, pending, duplicate and wrong-binary coverage with specific case names', () => {
  const complete = report();
  assert.doesNotThrow(() => validateNativeAcceptance(complete, binary));
  for (const item of requiredNativeCases) {
    assert.throws(() => validateNativeAcceptance({ ...complete, cases: complete.cases.filter(c => c.id !== item.id) }, binary), new RegExp(item.id));
    assert.throws(() => validateNativeAcceptance({ ...complete, cases: complete.cases.map(c => c.id === item.id ? { ...c, status: 'not_run' } : c) }, binary), new RegExp(item.id));
  }
  assert.throws(() => validateNativeAcceptance({ ...complete, cases: [complete.cases[0], ...complete.cases] }, binary), /duplicate/i);
  assert.throws(() => validateNativeAcceptance(complete, 'c'.repeat(64)), /binary/i);
  assert.throws(() => validateNativeAcceptance({ passed: true, normalBuild: true, paidRequests: 0 }, binary), /suite|schema/i);
});
test('acceptance requires native observations and evidence rather than unqualified passed booleans', () => {
  const complete = report();
  for (const change of [{ method: 'unit-test' }, { source:{} }, { observations: {} }, {observations:{summary:'Only booleans',measurements:{passed:true}}}, { evidence: [] }]) {
    const cases = complete.cases.map((c, i) => i === 0 ? { ...c, ...change } : c);
    assert.throws(() => validateNativeAcceptance({ ...complete, cases }, binary), /production-playback/);
  }
  assert.throws(() => validateNativeAcceptance({ ...complete, normalBuild: false }, binary), /production/i);
  assert.throws(() => validateNativeAcceptance({ ...complete, paidRequests: 1 }, binary), /paid/i);
});

test('current display/accessibility and both current performance workloads require measured evidence', () => {
  const reject=(id,change)=>{
    const value=report(); change(value.cases.find(item=>item.id===id).observations.measurements);
    assert.throws(()=>validateNativeAcceptance(value,binary),new RegExp(id));
  };
  reject('dpi-monitor-transitions',m=>{m.dpiSamples=m.dpiSamples.filter(sample=>sample.scalePercent!==125)});
  reject('dpi-monitor-transitions',m=>{m.monitorMoves=[]});
  reject('keyboard-clipboard-accessibility',m=>{m.keyboardOperations=[]});
  reject('keyboard-clipboard-accessibility',m=>{m.clipboard.pastedText='Different clipboard result'});
  reject('keyboard-clipboard-accessibility',m=>{m.screenReader.operations.pop()});
  reject('gpu-performance',m=>{m.workloads=m.workloads.filter(sample=>sample.id!=='4k30')});
  reject('gpu-performance',m=>{m.workloads[0].current.assetSha256='unidentified source'});
  reject('gpu-performance',m=>{m.workloads[0].current.displaySize.width=0});
  reject('gpu-performance',m=>{delete m.workloads[0].current.avSyncOffsetMs});
  reject('gpu-performance',m=>{m.workloads[0].current.executableSha256='f'.repeat(64)});
  reject('rendered-composition',m=>{m.layouts=m.layouts.filter(layout=>layout.id!=='wide')});
  reject('real-japanese-ime',m=>{delete m.candidateBounds});
  reject('interval-auto-stop',m=>{m.stops=m.stops.filter(stop=>stop.kind!=='sentence')});
  reject('long-media',m=>{delete m.sourceDurationMs});
  reject('long-media',m=>{delete m.transcriptScroll});
});

test('performance accepts the approved load/drop/A-V metrics without extra totals or latency metrics, but source frame counts cannot replace drops', () => {
  const complete = report();
  const workloads = complete.cases.find(item => item.id === 'gpu-performance').observations.measurements.workloads;
  for (const sample of workloads) {
    delete sample.current.decodedFrames;
    delete sample.current.memoryBytes;
    delete sample.current.inputLatencyMs;
  }
  assert.doesNotThrow(() => validateNativeAcceptance(complete, binary));

  for (const workload of workloads) {
    const value = structuredClone(complete);
    const sample = value.cases.find(item => item.id === 'gpu-performance').observations.measurements.workloads.find(item => item.id === workload.id);
    delete sample.current.droppedFrames;
    // Source metadata and an estimated/current frame index are not observed drops.
    sample.current.sourceFrameCount = sample.fps * 8;
    sample.current.estimatedFrameNumber = sample.fps * 8;
    sample.current.decodedFrames = sample.fps * 8;
    assert.throws(() => validateNativeAcceptance(value, binary), /gpu-performance.*drop/);
  }
});

test('external intake requires complete measured cases and an unchanged clean candidate of the selected revision', t => {
  const root=mkdtempSync(join(tmpdir(),'surtitle external intake '));
  t.onTestFinished(()=>rmSync(root,{recursive:true,force:true}));
  const installer=join(root,'candidate.exe'),receipt=installer+'.build.json',external=join(root,'report.json');
  const bytes='Synthetic installer; never executed';
  writeFileSync(installer,bytes); writeFileSync(join(root,'measurement.txt'),'Synthetic measurement fixture only');
  const value={...report(),suite:'gpui-windows-external',installerSha256:sha256File(installer)};
  value.cases=value.cases.filter(item=>item.method!=='native-uia').map(item=>({...item,evidence:[{path:'measurement.txt',sha256:sha256File(join(root,'measurement.txt'))}]}));
  writeFileSync(receipt,JSON.stringify({schema:1,productionBuild:true,sourceTreeClean:true,executableSha256:binary,installerSha256:value.installerSha256,sourceRevision:value.sourceRevision}));
  writeFileSync(external,JSON.stringify(value));
  assert.doesNotThrow(()=>checkExternalEvidence(external,receipt,value.sourceRevision));
  assert.throws(()=>checkExternalEvidence(external,receipt,'e'.repeat(40)),/revision/i);
  writeFileSync(external,JSON.stringify({...value,cases:value.cases.filter(item=>item.id!=='audio-output')}));
  assert.throws(()=>checkExternalEvidence(external,receipt,value.sourceRevision),/audio-output/);
  writeFileSync(external,JSON.stringify(value)); writeFileSync(installer,'changed candidate');
  assert.throws(()=>checkExternalEvidence(external,receipt,value.sourceRevision),/installer.*hash/i);
});
test('acceptance validates referenced evidence bytes and refuses stale, missing or escaping evidence', t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle acceptance 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'evidence'));
  const observation = join(root, 'evidence/observations.json');
  writeFileSync(observation, 'Synthetic observation; never a desktop acceptance result');
  const value = report();
  for (const item of value.cases) item.evidence = [{ path: 'observations.json', sha256: sha256File(observation) }];
  const reportPath = join(root, 'evidence/gpui-native-acceptance.json');
  const receipt = join(root, 'build.json');
  writeFileSync(receipt, JSON.stringify({ schema: 1, productionBuild: true, executableSha256: binary,installerSha256:'c'.repeat(64),sourceRevision:'d'.repeat(40),sourceTreeClean:true }));
  writeFileSync(reportPath, JSON.stringify(value));
  assert.doesNotThrow(() => checkNativeAcceptance(reportPath, receipt));
  writeFileSync(observation, 'Changed observation bytes');
  assert.throws(() => checkNativeAcceptance(reportPath, receipt), /evidence/i);
  value.cases[0].evidence[0].path = '../build.json';
  writeFileSync(reportPath, JSON.stringify(value));
  assert.throws(() => checkNativeAcceptance(reportPath, receipt), /escape|relative/i);
  rmSync(reportPath);
  assert.throws(() => checkNativeAcceptance(reportPath, receipt), /ENOENT/);
});

test('combines genuine external evidence only for pending native cases and the exact installer, binary and revision', t => {
  const root=mkdtempSync(join(tmpdir(),'surtitle acceptance merge '));
  t.onTestFinished(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'external')); mkdirSync(join(root,'combined'));
  const bytes='Synthetic external measurement fixture; no actual desktop observation';
  writeFileSync(join(root,'external/measurement.txt'),bytes);
  writeFileSync(join(root,'combined/observations.json'),bytes);
  const complete=report();
  const automated={...complete,cases:complete.cases.map(item=>item.method==='native-uia'?item:{...item,status:'not_run',evidence:[]})};
  for(const item of automated.cases.filter(item=>item.status==='passed')) item.evidence=[{path:'observations.json',sha256:sha256File(join(root,'combined/observations.json'))}];
  const external={...complete,suite:'gpui-windows-external',cases:complete.cases.filter(item=>item.method!=='native-uia').map(item=>({...item,evidence:[{path:'measurement.txt',sha256:sha256File(join(root,'external/measurement.txt'))}]}))};
  const receipt=join(root,'receipt.json'),auto=join(root,'combined/automated.json'),ext=join(root,'external/report.json'),output=join(root,'combined/gpui-native-acceptance.json');
  writeFileSync(receipt,JSON.stringify({schema:1,productionBuild:true,executableSha256:binary,installerSha256:complete.installerSha256,sourceRevision:complete.sourceRevision,sourceTreeClean:true}));
  writeFileSync(auto,JSON.stringify(automated));
  const pending=join(root,'combined/pending.json');
  combineNativeAcceptance(auto,receipt,pending);
  assert.throws(()=>checkNativeAcceptance(pending,receipt),/rendered-composition.*not_run.*real-japanese-ime/);
  for(const [field,value] of [['installerSha256','e'.repeat(64)],['executableSha256','f'.repeat(64)],['sourceRevision','e'.repeat(40)]]) {
    writeFileSync(ext,JSON.stringify({...external,[field]:value}));
    assert.throws(()=>combineNativeAcceptance(auto,receipt,output,ext),/provenance/i);
  }
  writeFileSync(ext,JSON.stringify({...external,cases:[...external.cases,complete.cases[0]]}));
  assert.throws(()=>combineNativeAcceptance(auto,receipt,output,ext),/override|automated/i);
  writeFileSync(ext,JSON.stringify(external));
  combineNativeAcceptance(auto,receipt,output,ext);
  assert.doesNotThrow(()=>checkNativeAcceptance(output,receipt));
  assert.throws(()=>combineNativeAcceptance(auto,receipt,output,ext),/exist|evidence/i);
});
