import assert from 'node:assert/strict';
import { test } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLiveCommand, assertLiveProfileIdentity, persistCampaignIdentity, requireLiveOptIn } from './live-api-session.mjs';

test('live profile attestation matches unique saved job IDs before any mutation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'surtitle-live-identity-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true }));
  const dbPath = join(directory, 'charges.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE ai_jobs(id TEXT PRIMARY KEY,state TEXT,created_at_ms INTEGER DEFAULT 0); INSERT INTO ai_jobs(id,state) VALUES ('campaign-unique-completed','completed'),('campaign-unsent','prepared')");
  db.close();
  const before = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const jobs = before.prepare('SELECT * FROM ai_jobs ORDER BY id').all();
    let mutated = false;
    assert.throws(() => {
      assertLiveProfileIdentity({ jobs: [{ id: 'foreign-profile-job' }] }, dbPath);
      mutated = true;
    }, /IPC activity must match/);
    assert.equal(mutated, false);
    assertLiveProfileIdentity({ jobs: [{ id: 'campaign-unique-completed' }] }, dbPath);
    assert.throws(() => assertLiveProfileIdentity({ jobs: [{ id: 'campaign-unique-completed' }, { id: 'campaign-unsent' }] }, dbPath), /IPC activity must match/);
    assert.deepEqual(before.prepare('SELECT * FROM ai_jobs ORDER BY id').all(), jobs);
  } finally { before.close(); }
});

test('an empty or missing live campaign cannot establish app identity', t => {
  const directory = mkdtempSync(join(tmpdir(), 'surtitle-live-empty-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true }));
  const dbPath = join(directory, 'charges.sqlite');
  assert.throws(() => assertLiveProfileIdentity({ jobs: [] }, dbPath));
  assert.equal(existsSync(dbPath), false, 'Identity checks must not create a missing ledger');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE ai_jobs(id TEXT PRIMARY KEY,state TEXT,created_at_ms INTEGER DEFAULT 0)');
  db.close();
  assert.throws(() => assertLiveProfileIdentity({ jobs: [] }, dbPath), /cannot establish.*identity/i);
});

test('live profile attestation matches the newest 500 jobs before omitting prepared estimates', t => {
  const directory = mkdtempSync(join(tmpdir(), 'surtitle-live-history-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true }));
  const dbPath = join(directory, 'charges.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE ai_jobs(id TEXT PRIMARY KEY,state TEXT,created_at_ms INTEGER); BEGIN');
  const insert = db.prepare('INSERT INTO ai_jobs VALUES (?,?,?)');
  for (let index = 0; index <= 500; index++) insert.run(`history-${index}`, index === 500 ? 'prepared' : 'completed', index);
  db.exec('COMMIT');
  db.close();
  const jobs = Array.from({ length: 499 }, (_, index) => ({ id: `history-${index + 1}` }));
  assertLiveProfileIdentity({ jobs }, dbPath);
  assert.throws(() => assertLiveProfileIdentity({ jobs: [...jobs, { id: 'history-0' }] }, dbPath), /IPC activity must match/);
  assert.throws(() => assertLiveProfileIdentity({ jobs: jobs.slice(1) }, dbPath), /IPC activity must match/);
});

test('live use requires an explicit boolean opt in', () => {
  for (const options of [{}, { optIn: 'true' }, { optIn: false }]) assert.throws(() => requireLiveOptIn(options), /optIn/);
  requireLiveOptIn({ optIn: true });
});
test('paid approval and key entry cannot bypass the reviewed approval or manual UI', () => {
  for (const command of ['approve_quote', 'reapprove_quote', 'save_openai_api_key', 'import_credential', 'resolve_unknown_attempt']) assert.throws(() => assertLiveCommand(command), /guarded|manual/);
  assertLiveCommand('get_app_snapshot');
  assertLiveCommand('create_quote');
});
test('campaign resume preserves the exact evaluation profile and original cap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'surtitle-campaign-'));
  try {
    const identity = { appId: 'app.surtitle.evaluation.openai20261029', dataRoot: 'C:\\evaluation', capMicrousd: 60000000 };
    await persistCampaignIdentity(directory, identity);
    await persistCampaignIdentity(directory, identity);
    await assert.rejects(persistCampaignIdentity(directory, { ...identity, capMicrousd: 60000001 }), /identity/);
    await assert.rejects(persistCampaignIdentity(directory, { ...identity, dataRoot: 'C:\\different' }), /identity/);
  } finally { rmSync(directory, { recursive: true }); }
});


test('campaign identity rejects production and unrelated profiles', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'surtitle-profile-'));
  try {
    for (const appId of ['app.surtitle.desktop', 'app.other', 'app.surtitle.evaluation.other']) {
      await assert.rejects(persistCampaignIdentity(directory, { appId, dataRoot: 'C:\\evaluation', capMicrousd: 60000000 }), /evaluation identity/);
    }
  } finally { rmSync(directory, { recursive: true }); }
});
