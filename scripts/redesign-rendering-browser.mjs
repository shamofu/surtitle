// Isolated browser baseline. This is Edge headless, not the app's WebView2 host.
// Uses the repository's Playwright package because Python Playwright is absent.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve('work/rendering-evaluation');
const output = join(root, 'results');
await mkdir(output, { recursive: true });
const cases = [
  ['h264-aac.mp4', 'video/mp4; codecs="avc1.42E01F, mp4a.40.2"'],
  ['mpeg4-aac.mp4', 'video/mp4; codecs="mp4v.20.9, mp4a.40.2"'],
  ['hevc-aac.mp4', 'video/mp4; codecs="hvc1.1.6.L93.B0, mp4a.40.2"'],
  ['vp9-opus.webm', 'video/webm; codecs="vp9, opus"'],
];
const allowed = new Map(cases.map(([name, type]) => [name, type.split(';')[0]]));
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Isolated rendering evaluation</title>
<style>*{box-sizing:border-box}body{margin:0;background:#111;color:white;font-family:system-ui}main{position:relative;width:100vw;height:calc(100vh - 88px);background:#000}video{width:100%;height:100%;object-fit:contain}aside{position:absolute;inset:0 0 0 auto;width:320px;background:#20232a;display:none;padding:24px}aside.open{display:block}footer{height:88px;padding:12px}button,input{padding:10px}dialog{padding:24px}</style>
<main><video muted playsinline></video><aside><label>Translation <input value="日本語"></label><button id="action">Save phrase</button></aside></main>
<footer><button id="toggle">Translation</button><button id="modal">Options</button><output></output></footer>
<dialog><form method="dialog"><input value="練習"><button>Close</button></form></dialog>
<script>const v=document.querySelector('video');document.querySelector('#toggle').onclick=()=>document.querySelector('aside').classList.toggle('open');document.querySelector('#modal').onclick=()=>document.querySelector('dialog').showModal();document.querySelector('#action').onclick=()=>document.querySelector('output').textContent='saved';</script>`;
const server = createServer(async (request, response) => {
  const name = decodeURIComponent((request.url || '/').slice(1));
  if (name === '') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
  if (!allowed.has(name)) { response.writeHead(404).end(); return; }
  const path = join(root, 'fixtures', name);
  try {
    const { size } = await stat(path);
    const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    response.writeHead(match ? 206 : 200, { 'Content-Type': allowed.get(name), 'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1, ...(match ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    createReadStream(path, { start, end }).pipe(response);
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForLoadState('networkidle');
  const report = { schemaVersion: 1, testedAt: new Date().toISOString(), environment: 'installed Edge headless; not WebView2',
    version: browser.version(), realNativeCompositionTested: false, media: [] };
  report.gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null };
  });
  for (const [file, mime] of cases) {
    report.media.push(await page.evaluate(async ({ file, mime }) => {
      const video = document.querySelector('video');
      const result = { file, declaredMime: mime, canPlayType: video.canPlayType(mime) };
      video.pause(); video.removeAttribute('src'); video.load();
      const outcome = new Promise(resolve => {
        const timer = setTimeout(() => finish('timeout'), 8000);
        const error = () => finish('error');
        const advance = () => { if (video.currentTime >= 0.6) finish('advanced'); };
        function finish(outcome) {
          clearTimeout(timer); video.removeEventListener('error', error); video.removeEventListener('timeupdate', advance);
          resolve({ outcome, videoDisplayed: video.videoWidth > 0 && video.videoHeight > 0 &&
              (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) > 0,
            errorCode: video.error?.code || null, currentTime: video.currentTime,
            width: video.videoWidth, height: video.videoHeight, audioTracks: video.audioTracks?.length ?? null,
            videoFrames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null });
        }
        video.addEventListener('error', error); video.addEventListener('timeupdate', advance);
      });
      video.src = '/' + file;
      video.play().catch(() => {});
      return { ...result, ...await outcome };
    }, { file, mime }));
  }
  await page.evaluate(() => { const v = document.querySelector('video'); v.src = '/h264-aac.mp4'; v.loop = true; return v.play(); });
  const video = page.locator('video');
  const before = await video.boundingBox();
  await page.getByRole('button', { name: 'Translation', exact: true }).click();
  await page.getByRole('button', { name: 'Save phrase' }).click();
  report.panel = { videoBefore: before, videoAfter: await video.boundingBox(),
    actionDelivered: await page.locator('output').textContent() === 'saved' };
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  report.dialog = await page.locator('dialog').evaluate(el => ({ open: el.open, focusInside: el.contains(document.activeElement) }));
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  report.dialog.focusReturned = await page.getByRole('button', { name: 'Options', exact: true }).evaluate(el => document.activeElement === el);
  await page.screenshot({ path: join(output, 'browser-panel.png') });
  await writeFile(join(output, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
