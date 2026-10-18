// SPDX-License-Identifier: GPL-3.0-or-later
import { Transform } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

const statuses = { RUNNING: 'RUN', PASSED: 'PASS', FAILED: 'FAIL', RETRYING: 'RETRY' };
const platforms = { windows: 'Windows', linux: 'Linux' };

// WDIO's CLI owns these lines independently of its reporters. Match only its
// native spec status shape; leave diagnostics and future CLI formats intact.
export function formatNativeCliLine(line) {
  const ending = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
  const content = ending ? line.slice(0, -ending.length) : line;
  const match = stripVTControlCharacters(content).match(
    /^\[(\d+-\d+)\] (RUNNING|PASSED|FAILED|RETRYING) in [^\r\n]+ on (windows|linux) - (file:\/\/[^\r\n]+?)( \(\d+ retries\))?$/,
  );
  if (!match) return line;
  const [, cid, status, platform, files, retry = ''] = match;
  try {
    const names = files.split(', ').map(file => {
      const url = new URL(file);
      const name = decodeURIComponent(url.pathname.split('/').at(-1));
      if (url.protocol !== 'file:' || url.search || url.hash || !name.endsWith('.e2e.js')
          || /[\x00-\x1f\x7f/\\]/.test(name)) throw new Error('Unknown native spec path');
      return name.slice(0, -'.e2e.js'.length);
    });
    return `[${cid}] ${statuses[status]} SPEC ${names.join(', ')} | ${platforms[platform]}${retry}${ending}`;
  } catch {
    return line;
  }
}

export function createNativeCliOutput() {
  let pending = Buffer.alloc(0);
  const emit = (stream, line) => {
    const text = line.toString('utf8');
    const formatted = formatNativeCliLine(text);
    // Preserve unknown output byte for byte, including ANSI and invalid UTF-8.
    stream.push(formatted === text ? line : formatted);
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let end;
      while ((end = pending.indexOf(0x0a)) !== -1) {
        emit(this, pending.subarray(0, end + 1));
        pending = pending.subarray(end + 1);
      }
      callback();
    },
    flush(callback) {
      if (pending.length) emit(this, pending);
      callback();
    },
  });
}
