// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { withReadOnlyDatabase } from './native-e2e-database.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle e2e database 日本語 '));
  const path = join(root, 'observer.sqlite'), workers = [];
  t.onTestFinished(async () => {
    await Promise.all(workers.map(worker => worker.terminate()));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA journal_mode=WAL; CREATE TABLE saved_state (value INTEGER NOT NULL); INSERT INTO saved_state VALUES (1);');
  } finally { database.close(); }
  const lock = async () => {
    const worker = new Worker(`
      const { DatabaseSync } = require('node:sqlite');
      const { parentPort, workerData } = require('node:worker_threads');
      const database = new DatabaseSync(workerData);
      database.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE saved_state SET value=2;');
      parentPort.on('message', delayMs => {
        setTimeout(() => {
          database.exec('COMMIT');
          database.close();
          parentPort.close();
        }, delayMs);
      });
      parentPort.postMessage('locked');
    `, { eval: true, workerData: path });
    workers.push(worker);
    assert.deepEqual(await once(worker, 'message', { signal: AbortSignal.timeout(5000) }), ['locked']);
    return worker;
  };
  return { path, root, lock };
}

test('a read-only observer waits for an independent WAL writer and reads its committed rows', async t => {
  const { path, lock } = fixture(t);
  const writer = await lock();
  const noWait = new DatabaseSync(path, { readOnly: true });
  try {
    assert.throws(() => noWait.prepare('SELECT value FROM saved_state').get(), error => error.errcode === 5);
  } finally { noWait.close(); }
  const exited = once(writer, 'exit', { signal: AbortSignal.timeout(15000) });
  let observer;
  const value = withReadOnlyDatabase(path, database => {
    observer = database;
    // Release from a separate worker: the synchronous observer blocks this
    // test's event loop, so an ordinary same-thread timer cannot unlock it.
    writer.postMessage(150);
    return database.prepare('SELECT value FROM saved_state').get().value;
  });
  assert.equal(value, 2);
  assert.equal(observer.isOpen, false);
  assert.deepEqual(await exited, [0]);
}, 20000);

test('a persistent WAL lock reports SQLITE_BUSY after the configured wait and closes the observer', async t => {
  const { path, lock } = fixture(t);
  await lock();
  let observer;
  const started = performance.now();
  assert.throws(() => withReadOnlyDatabase(path, database => {
    observer = database;
    return database.prepare('SELECT value FROM saved_state').get();
  }, { timeoutMs: 100 }), error => error.errcode === 5);
  assert(performance.now() - started >= 75, 'The observer must wait for the configured busy timeout');
  assert.equal(observer.isOpen, false);
}, 10000);

test('observers default to a ten-second wait, reject writes, and preserve rows', t => {
  const { path } = fixture(t);
  let observer;
  const result = withReadOnlyDatabase(path, database => {
    observer = database;
    assert.equal(database.prepare('PRAGMA busy_timeout').get().timeout, 10000);
    assert.throws(() => database.exec('UPDATE saved_state SET value=9'), error => error.errcode === 8);
    return database.prepare('SELECT value FROM saved_state').get().value;
  });
  assert.equal(result, 1);
  assert.equal(observer.isOpen, false);
});

test('callback errors propagate unchanged and still close the observer', t => {
  const { path } = fixture(t);
  const failure = new Error('Expected assertion failure');
  let observer;
  assert.throws(() => withReadOnlyDatabase(path, database => {
    observer = database;
    throw failure;
  }), error => error === failure);
  assert.equal(observer.isOpen, false);
});

test('a missing database is not created and invalid timeouts are rejected', t => {
  const { path, root } = fixture(t);
  const missing = join(root, 'missing.sqlite');
  assert.throws(() => withReadOnlyDatabase(missing, () => assert.fail('Unexpected database creation')));
  assert.equal(existsSync(missing), false);
  for (const timeoutMs of [-1, 0.5, NaN, Infinity, 2147483648, '100']) {
    assert.throws(() => withReadOnlyDatabase(path, () => assert.fail('Unexpected database access'), { timeoutMs }), RangeError);
  }
});
