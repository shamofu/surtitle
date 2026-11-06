import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCampaignTotals, assertLiveApproval } from './live-api-budget.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surtitle-budget-'));
  const dbPath = join(dir, 'charges.sqlite');
  const db = new DatabaseSync(dbPath);
  // The actual product DDL, rather than a second hand-written approximation.
  const source = readFileSync(new URL('../../crates/ai/src/ledger/initialize.rs', import.meta.url), 'utf8');
  const ddl = source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS ai_jobs'), source.indexOf('CREATE TABLE IF NOT EXISTS ai_audit'));
  db.exec(ddl);
  db.prepare('INSERT INTO ai_jobs VALUES(?,?,?,?,?,?,?,?)').run('job', 'digest', JSON.stringify({execution:{provider:'openai'}}), 'prepared', 1, 9999999999999, null, null);
  db.prepare('INSERT INTO ai_requests(job_id,ordinal) VALUES(?,?)').run('job', 1);
  t.onTestFinished(() => { if (db.isOpen) db.close(); rmSync(dir, {recursive:true, force:true}); });
  const attempt = (id, state, reserve, charged, time = 1) => db.prepare('INSERT INTO ai_attempts(id,job_id,ordinal,state,reserve_microusd,charged_microusd,created_at_ms) VALUES(?,?,?,?,?,?,?)').run(id,'job',1,state,reserve,charged,time);
  const quote = (patch={}) => Object.freeze({provider:'openai', id:'job', digest:'digest', canApprove:true, unpriced:false, maximumUsd:0.00001, expiresAt:'2286-11-20T17:46:39.999Z', requestCount:1, maximumRequestCount:1, sendDurationMs:0, maximumSendDurationMs:0, maxOutputTokens:8192, totalOutputTokens:8192, maximumTotalOutputTokens:8192, ...patch});
  return {db,dbPath,attempt,quote, approve:(patch={}, options={})=>assertLiveApproval({dbPath,quote:quote(patch),capMicrousd:60_000_000,...options})};
}

test('lifetime total uses real charges, all monetary holds and released zero across restart and dates', t => {
  const f=fixture(t);
  f.attempt('a','settled',100,70,1); f.attempt('b','accepted_unknown',20,null,1700000000000);
  f.attempt('c','accepted_unknown',30,null); f.attempt('d','rejected_429',40,null); f.attempt('e','released',500,0);
  assert.equal(readCampaignTotals(f.dbPath).totalMicrousd,160);
  f.db.close();
  assert.equal(readCampaignTotals(f.dbPath).totalMicrousd,160);
  assert.equal(f.approve().projectedMicrousd,170);
});
test('cap is inclusive and new reservation is additional on reapproval', t => {
  const f=fixture(t); f.attempt('old','accepted_unknown',59_999_990,null);
  assert.equal(f.approve().projectedMicrousd,60_000_000);
  assert.throws(()=>f.approve({maximumUsd:0.000011}), /cap/);
});
test('unknown unpriced amount stops even when other attempts are priced',t=>{
  const f=fixture(t); f.attempt('a','settled',1,1);f.attempt('b','unknown',null,null);
  assert.throws(()=>f.approve(),/unpriced/);
});
test('released must have explicit zero charge',t=>{const f=fixture(t);f.attempt('a','released',null,null);assert.throws(()=>f.approve(),/released/);});
test('in-flight and competing approved pending jobs stop',t=>{
  const f=fixture(t);f.attempt('a','reserved',10,null); assert.throws(()=>f.approve(),/in.flight/);
  f.db.prepare('DELETE FROM ai_attempts').run();
  f.db.prepare("INSERT INTO ai_jobs VALUES('other','d2','{}','approved',1,9999999999999,1,'{}')").run();
  assert.throws(()=>f.approve(),/approved/);
});
test('rejects wrong provider, stale/mismatched or mutable quote',t=>{
  const f=fixture(t);
  for(const patch of [{provider:'vertex'},{digest:'changed'},{id:'missing'},{canApprove:false},{expiresAt:'2000-01-01'},{unpriced:true}]) assert.throws(()=>f.approve(patch));
  assert.throws(()=>assertLiveApproval({dbPath:f.dbPath,quote:{...f.quote()},capMicrousd:60_000_000}),/frozen/);
  f.db.prepare("UPDATE ai_jobs SET plan_json='{\"execution\":{\"provider\":\"vertex\"}}'").run(); assert.throws(()=>f.approve(),/provider/);
});
test('rejects unrepresentable monetary and invalid numerical bounds',t=>{
  const f=fixture(t);
  for(const cost of [NaN,Infinity,-1,null,0.0000001,0.000010000000000001]) assert.throws(()=>f.approve({maximumUsd:cost}));
  for(const patch of [{requestCount:0},{maximumRequestCount:121},{maximumRequestCount:2},{maxOutputTokens:8193},{maximumSendDurationMs:5400001},{sendDurationMs:NaN},{maximumTotalOutputTokens:8193}]) assert.throws(()=>f.approve(patch));
  assert.throws(()=>f.approve({}, {capMicrousd:NaN}));
});
test('bounded retries multiply all scope fields consistently',t=>{
  const f=fixture(t);
  assert.equal(f.approve({retryPolicy:{version:1,maxRetries:2},maximumRequestCount:3, maximumSendDurationMs:0,maximumTotalOutputTokens:24576}).additionalMicrousd,10);
  assert.throws(()=>f.approve({retryPolicy:{version:1,maxRetries:2}}),/scope/);
});
test('missing database fails without creating any database',t=>{const f=fixture(t);assert.throws(()=>readCampaignTotals(join(f.dbPath,'missing')));});


test('priced unresolved unknown blocks paid approvals',t=>{const f=fixture(t);f.attempt('u','unknown',10,null);assert.throws(()=>f.approve(),/unknown/);});

test('native paused retry is approvable while failed job state is rejected',t=>{
  const f=fixture(t);
  f.db.prepare("UPDATE ai_jobs SET state='paused'").run();
  assert.equal(f.approve({isRetry:true}).additionalMicrousd,10);
  f.db.prepare("UPDATE ai_jobs SET state='failed'").run();
  assert.throws(()=>f.approve({isRetry:true}),/awaiting approval/);
});
test('native retry policy version one always authorizes exactly two retries',t=>{
  const f=fixture(t);
  for(const retries of [0,1]) assert.throws(()=>f.approve({retryPolicy:{version:1,maxRetries:retries},maximumRequestCount:retries+1,maximumTotalOutputTokens:8192*(retries+1)}),/retry policy/);
});

async function exclusiveLock(t, dbPath, releaseAfterMs) {
  const worker = new Worker(`
    const {DatabaseSync}=require('node:sqlite');
    const {parentPort,workerData}=require('node:worker_threads');
    const db=new DatabaseSync(workerData.dbPath);
    db.exec('BEGIN EXCLUSIVE');
    parentPort.postMessage('locked');
    function release(){db.exec('ROLLBACK');db.close();parentPort.close();}
    if(workerData.releaseAfterMs !== null) setTimeout(release,workerData.releaseAfterMs);
    else parentPort.on('message',release);
  `, {eval:true,workerData:{dbPath,releaseAfterMs}});
  t.onTestFinished(()=>worker.terminate());
  await once(worker,'message');
  return worker;
}
test('read-only snapshot waits for a transient real SQLite exclusive lock',async t=>{
  const f=fixture(t); f.attempt('a','settled',10,7);
  await exclusiveLock(t,f.dbPath,150);
  assert.equal(readCampaignTotals(f.dbPath,{timeoutMs:1000}).totalMicrousd,7);
  assert.equal(f.approve({}, {timeoutMs:1000}).projectedMicrousd,17);
});
test('persistent real SQLite lock fails closed within the bounded wait and later reopens',async t=>{
  const f=fixture(t); f.attempt('a','settled',10,7);
  const worker=await exclusiveLock(t,f.dbPath,null);
  const start=Date.now();
  assert.throws(()=>f.approve({}, {timeoutMs:100}),/locked/);
  assert.ok(Date.now()-start>=70);
  assert.ok(Date.now()-start<1500);
  const exited=once(worker,'exit');worker.postMessage('release');await exited;
  assert.equal(f.approve({}, {timeoutMs:100}).projectedMicrousd,17);
});
test('success and failed approval release snapshot locks before another writer',t=>{
  const f=fixture(t); f.attempt('a','settled',10,7);
  for(let i=0;i<3;i++){
    readCampaignTotals(f.dbPath);assert.throws(()=>f.approve({}, {capMicrousd:1}),/cap/);
    const writer=new DatabaseSync(f.dbPath);
    try {writer.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');} finally {writer.close();}
  }
});
