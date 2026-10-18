// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { finished } from 'node:stream/promises';
import { test } from 'vitest';
import { createNativeCliOutput, formatNativeCliLine } from './native-cli-output.mjs';

test('native CLI status lines identify the spec and platform, including retries and grouped specs', () => {
  const windows = 'in windows on windows - file:///C:/checkout/e2e/native/study.e2e.js';
  assert.equal(formatNativeCliLine(`[0-0] RUNNING ${windows}\r\n`), '[0-0] RUN SPEC study | Windows\r\n');
  assert.equal(formatNativeCliLine(`[0-1] PASSED ${windows}\n`), '[0-1] PASS SPEC study | Windows\n');
  assert.equal(formatNativeCliLine(`[0-2] FAILED ${windows}`), '[0-2] FAIL SPEC study | Windows');
  assert.equal(formatNativeCliLine('[1-3] RETRYING in linux on linux - file:///repo/e2e/native/ai-recovery.e2e.js (2 retries)\n'),
    '[1-3] RETRY SPEC ai-recovery | Linux (2 retries)\n');
  assert.equal(formatNativeCliLine('[0-4] PASSED in windows on windows - file:///C:/repo%20name/first.e2e.js, file:///C:/repo%20name/e2e/native/%E5%AD%97%E5%B9%95%20test.e2e.js (1 retries)\n'),
    '[0-4] PASS SPEC first, 字幕 test | Windows (1 retries)\n');
});

test('only known native spec status lines are rewritten', () => {
  const lines = [
    '[0-0] WARN webdriver: request failed\n',
    '\u001b[31mError: assertion failed\u001b[39m\r\n',
    '    at settings (file:///repo/e2e/native/study.e2e.js:22:3)\n',
    '[0-0] RUNNING in linux on linux - https://example.com/study.e2e.js\n',
    '[0-0] RUNNING in linux on linux - file:///repo/study.spec.js\n',
    '[0-0] RUNNING in linux on linux - file:///repo/%ZZ.e2e.js\n',
    '[0-0] RUNNING in linux on linux - file:///repo/%0Ahidden.e2e.js\n',
    '[0-0] RUNNING in linux on linux - file:///repo/study.e2e.js?unknown\n',
    '[0-0] RUNNING in linux on linux - file:///repo/study.e2e.js, unrecognized\n',
    '[0-0] RUNNING in linux on linux - file:///repo/study.e2e.js (changed format)\n',
  ];
  for (const line of lines) assert.equal(formatNativeCliLine(line), line);
});

test('split UTF-8, ANSI and CRLF chunks retain diagnostics and flush the last line at EOF', async () => {
  const input = Buffer.concat([
    Buffer.from('\u001b[31m[0-0] FAILED\u001b[39m in windows on windows - file:///C:/repo/字幕.e2e.js\r\n'),
    Buffer.from('\u001b[33m警告\u001b[39m\r\n    at assertion (test.js:1:2)\n'),
    Buffer.from([0xff, 0xfe, 0x0a]),
    Buffer.from('[0-1] PASSED in linux on linux - file:///repo/study.e2e.js'),
  ]);
  const output = createNativeCliOutput();
  const chunks = [];
  output.on('data', chunk => chunks.push(chunk));
  const done = finished(output);
  for (const byte of input) output.write(Buffer.from([byte]));
  output.end();
  await done;
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([
    Buffer.from('[0-0] FAIL SPEC 字幕 | Windows\r\n\u001b[33m警告\u001b[39m\r\n    at assertion (test.js:1:2)\n'),
    Buffer.from([0xff, 0xfe, 0x0a]),
    Buffer.from('[0-1] PASS SPEC study | Linux'),
  ]));
});

test('several lines in one chunk and an unfinished unknown line are preserved', async () => {
  const output = createNativeCliOutput();
  const chunks = [];
  output.on('data', chunk => chunks.push(chunk));
  const done = finished(output);
  output.end('setup\n[0-0] RUNNING in linux on linux - file:///repo/study.e2e.js\nError without a newline');
  await done;
  assert.equal(Buffer.concat(chunks).toString(), 'setup\n[0-0] RUN SPEC study | Linux\nError without a newline');
});
