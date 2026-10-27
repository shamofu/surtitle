import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessTlc, acquireTlc } from './formal.mjs';

const completed = 'Model checking completed. No error has been found.\n42 states generated, 20 distinct states found, 0 states left on queue.\nFinished in 1s at (2026-10-27 00:00:00)\n';
const violation = 'Invariant NoStaleAuthority is violated.\nThe behavior up to this point is:\nState 1: <Initial predicate>\nState 2: <Reserve>\nFinished in 1s at (2026-10-27 00:00:00)\n';
const result = (stdout, exitCode = 0) => ({ stdout, stderr: '', exitCode, signal: null, timedOut: false });

test('accepts only a completed successful state-space exploration', () => {
  assert.equal(assessTlc(result(completed), null).passed, true);
  for (const r of [result(completed, 1), result('Finished in 1s'), result(completed.replace('0 states left', '3 states left')),
    { ...result(completed), timedOut: true }, { ...result(completed), signal: 'SIGTERM' }]) {
    assert.equal(assessTlc(r, null).passed, false);
  }
});

test('a negative control requires its named invariant and a normal violation exit', () => {
  assert.equal(assessTlc(result(violation, 12), 'NoStaleAuthority').passed, true);
  for (const r of [result(violation, 1), result(violation, 0), result(completed),
    result(violation.replace('NoStaleAuthority', 'TypeOK'), 12), result('Parsing or semantic analysis failed.', 150),
    { ...result(violation, 12), timedOut: true }, result(violation.replace(/Finished[^\n]+/, ''), 12)]) {
    assert.equal(assessTlc(r, 'NoStaleAuthority').passed, false);
  }
  assert.equal(assessTlc(result(violation, 12), null).passed, false);
});

test('setup reuses verified bytes and never replaces a cache with a corrupt download', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'surtitle-tlc-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('authored tool fixture');
  const pin = { version: 'fixture', url: 'https://example.invalid/tlc.jar', sha256: createHash('sha256').update(bytes).digest('hex') };
  const destination = join(directory, 'tlc.jar');
  let downloads = 0;
  const download = async () => { downloads++; return bytes; };
  await acquireTlc(pin, destination, download);
  await acquireTlc(pin, destination, async () => assert.fail('verified cache must not download'));
  assert.equal(downloads, 1);
  await writeFile(destination, 'old corrupt cache');
  await assert.rejects(acquireTlc(pin, destination, async () => Buffer.from('wrong bytes')), /checksum/i);
  assert.equal(await readFile(destination, 'utf8'), 'old corrupt cache');
  await acquireTlc(pin, destination, download);
  assert.deepEqual(await readFile(destination), bytes);
});
