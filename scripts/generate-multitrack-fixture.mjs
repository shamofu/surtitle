// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export function generateMultitrackFixture(directory) {
  const dir = resolve(directory); mkdirSync(dir, { recursive: true });
  const en = resolve(dir, 'tracks-en.srt'), ja = resolve(dir, 'tracks-ja.srt');
  writeFileSync(en, '1\n00:00:00,500 --> 00:00:02,000\nEnglish track one.\n\n2\n00:00:02,200 --> 00:00:04,500\nKeep the original meaning.\n', 'utf8');
  writeFileSync(ja, '1\n00:00:00,500 --> 00:00:02,000\n日本語の字幕です。\n\n2\n00:00:02,200 --> 00:00:04,500\n元の意味を保ちます。\n', 'utf8');
  const path = resolve(dir, '多言語 & tracks.mkv');
  // Interleaving deliberately prevents mpv audio IDs from equalling FFmpeg indices:
  // video=0, English subtitles=1, English audio=2, Japanese subtitles=3, Japanese audio=4.
  const result = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=5:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000:duration=8', '-i', en, '-i', ja, '-map', '0:v', '-map', '3:s', '-map', '1:a', '-map', '4:s', '-map', '2:a', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=jpn', '-disposition:a:0', '0', '-disposition:a:1', 'default', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', '-c:s', 'srt', '-t', '8', path], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Multitrack fixture generation failed (${result.status})`);
  return path;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(generateMultitrackFixture(process.argv[2] || 'test-results/fixtures'));
