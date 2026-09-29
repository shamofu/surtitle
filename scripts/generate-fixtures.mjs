// SPDX-License-Identifier: GPL-3.0-or-later
// Generated signals and subtitle text are project-owned test data, not third-party media.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateMultitrackFixture } from './generate-multitrack-fixture.mjs';
const dir = resolve(process.argv[2] || 'test-results/fixtures');
mkdirSync(dir, { recursive: true });
const mediaPath = resolve(dir, '日本語 & sample.mp4');
const longMediaPath = resolve(dir, 'six-hour-silence.flac');
const result = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12', '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac', '-shortest', mediaPath], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Fixture generation failed (${result.status})`);
const longResult = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=16000', '-t', '21600', '-c:a', 'flac', longMediaPath], { stdio: 'inherit', windowsHide: true });
if (longResult.error) throw longResult.error;
if (longResult.status !== 0) throw new Error(`Six-hour fixture generation failed (${longResult.status})`);
writeFileSync(resolve(dir, 'sample.srt'), '1\n00:00:00,500 --> 00:00:02,000\nEvery little phrase makes a difference.\n\n2\n00:00:02,100 --> 00:00:04,000\nOne step at a time.\n', 'utf8');
const multitrackPath = generateMultitrackFixture(dir);
console.log(JSON.stringify({ mediaPath, longMediaPath, multitrackPath, subtitlePath: resolve(dir, 'sample.srt') }));
