// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { installLearningFixture } from './learning-fixture';

// Opt-in real frame observations. Shared CI must not enforce machine timing.
test.skip(!process.env.SURTITLE_MOTION_PERFORMANCE, 'Run explicitly for motion cadence measurements');
test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference',
  baseURL: process.env.SURTITLE_MOTION_URL || 'http://127.0.0.1:1420', screenshot: 'off', trace: 'off', video: 'off' });

for (const segmentCount of [120, 10000]) test(`study motion cadence with ${segmentCount} subtitles`, async ({ page }, info) => {
  test.setTimeout(120000);
  await installLearningFixture(page, 'en', 'light', { segmentCount });
  await page.goto('/study/visual-fixture');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.native-player-viewport')).toHaveAttribute('data-native-placement', 'ready');
  // Run CPU attribution separately: enabling sampling can change the cadence.
  const cpuSession = process.env.SURTITLE_MOTION_CPU_PROFILE ? await page.context().newCDPSession(page) : undefined;
  if (cpuSession) {
    await cpuSession.send('Profiler.enable');
    await cpuSession.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cpuSession.send('Profiler.start');
  }
  const observation = await page.evaluate(async () => {
    const fixture = (window as any).__learningFixture;
    const dock = document.querySelector<HTMLElement>('.study-companion-dock')!;
    const video = document.querySelector<HTMLElement>('.native-player-viewport')!;
    const toggle = document.querySelector<HTMLButtonElement>('.study-transcript-toggle')!;
    const panel = document.querySelector<HTMLElement>('#study-companion')!;
    const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
    const longTasks: { start: number; duration: number; attribution: Record<string, unknown>[] }[] = [];
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration,
        attribution: ((entry as any).attribution ?? []).map((item: any) => ({ name: item.name,
          containerType: item.containerType, containerId: item.containerId, containerName: item.containerName, containerSrc: item.containerSrc })) });
    });
    observer.observe({ type: 'longtask', buffered: false });
    const longAnimationFrames: { start: number; duration: number; blockingDuration: number;
      renderStart: number; styleAndLayoutStart: number; scripts: Record<string, unknown>[] }[] = [];
    const animationObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries() as any) longAnimationFrames.push({ start: entry.startTime, duration: entry.duration,
        blockingDuration: entry.blockingDuration, renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart,
        scripts: entry.scripts.map((script: any) => ({ sourceURL: script.sourceURL, sourceFunctionName: script.sourceFunctionName,
          invoker: script.invoker, invokerType: script.invokerType, start: script.startTime, duration: script.duration,
          forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration })) });
    });
    if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) animationObserver.observe({ type: 'long-animation-frame', buffered: false });
    const calls: { id: number; command: string; action?: string; start: number; duration: number }[] = [];
    const playerStateEvents: { at: number; placementId?: number }[] = [];
    let placementId: number | undefined, nextCallId = 0;
    const unsubscribe = fixture.subscribe('player-state', () => playerStateEvents.push({ at: performance.now(), placementId }));
    const original = fixture.call;
    fixture.call = async (command: string, args: any = {}) => {
      const call = { id: ++nextCallId, command, action: args.request?.action, start: performance.now(), duration: 0 };
      const previousPlacementId = placementId;
      if (command === 'player_control' && call.action === 'bounds') placementId = call.id;
      calls.push(call);
      try { return await original.call(fixture, command, args); }
      finally { call.duration = performance.now() - call.start; placementId = previousPlacementId; }
    };
    type Endpoint = { open?: boolean; minimum?: number; ready?: () => boolean };
    const sample = (at: number, start: number, endpoint: Endpoint) => {
      const rect = video.getBoundingClientRect(), panelVisibility = getComputedStyle(panel).visibility;
      const moving = dock.dataset.moving === 'true', pending = video.dataset.nativePlacement === 'pending';
      const expanded = toggle.getAttribute('aria-expanded') === 'true', elapsed = at - start;
      const endpointReady = endpoint.open === undefined || (expanded === endpoint.open && panel.hidden === !endpoint.open);
      const phase = endpoint.open === undefined ? 'content-motion' : moving
        ? panelVisibility === 'hidden' ? 'resizing-or-native-wait' : 'panel-slide'
        : !endpointReady ? 'awaiting-commit' : pending ? 'native-placement' : 'settled';
      return { at, sampledAt: performance.now(), elapsed, phase, moving, pending, expanded, panelHidden: panel.hidden,
        panelVisibility, panelInert: panel.inert, toggleDisabled: toggle.disabled, width: rect.width, height: rect.height,
        x: rect.x, y: rect.y, documentHidden: document.hidden,
        active: endpoint.open === undefined ? elapsed >= 0 && elapsed < (endpoint.minimum ?? 0) : moving };
    };
    const actions: { name: string; start: number; end: number; expectedOpen?: boolean; minimumMs: number;
      samples: ReturnType<typeof sample>[] }[] = [];
    const observe = async (name: string, action: () => void | Promise<unknown>, endpoint: Endpoint = {}) => {
      const before = await frame(), start = performance.now();
      const observed = { name, start, end: start, expectedOpen: endpoint.open, minimumMs: endpoint.minimum ?? 0,
        samples: [sample(before, start, endpoint)] };
      actions.push(observed);
      await action();
      let settledFrames = 0;
      do {
        const current = sample(await frame(), start, endpoint);
        observed.samples.push(current); observed.end = performance.now();
        const endpointReady = endpoint.open === undefined || (current.expanded === endpoint.open && current.panelHidden === !endpoint.open);
        const settled = endpointReady && !current.moving && !current.pending && (endpoint.ready?.() ?? true)
          && current.elapsed >= (endpoint.minimum ?? 0);
        settledFrames = settled ? settledFrames + 1 : 0;
        if (observed.end - start > 5000) throw new Error(`${name} did not settle: ${JSON.stringify(current)}`);
      } while (settledFrames < 3);
    };
    let problem: string | undefined;
    try {
      // Warm the retained transcript and font/layout caches before measurement.
      await observe('warm-open', () => toggle.click(), { open: true });
      await observe('warm-close', () => toggle.click(), { open: false });
      actions.length = 0; calls.length = 0; longTasks.length = 0; longAnimationFrames.length = 0; playerStateEvents.length = 0;
      for (let index = 0; index < 20; index++) {
        await observe('panel-open', () => toggle.click(), { open: true });
        await observe('panel-close', () => toggle.click(), { open: false });
      }
      await observe('prepare-tabs', () => toggle.click(), { open: true });
      const tabs = [...document.querySelectorAll<HTMLButtonElement>('.transcript-tabs [role="tab"]')];
      const suggestions = tabs.find(tab => tab.textContent === 'Suggestions')!, transcript = tabs.find(tab => tab.textContent === 'Transcript')!;
      for (let index = 0; index < 10; index++) {
        await observe('tab-suggestions', () => suggestions.click(), { minimum: 220, ready: () => suggestions.getAttribute('aria-selected') === 'true' });
        await observe('tab-transcript', () => transcript.click(), { minimum: 220, ready: () => transcript.getAttribute('aria-selected') === 'true' });
      }
      const translation = document.querySelector<HTMLButtonElement>('.caption-actions button[aria-pressed]')!;
      await observe('translation-open', () => translation.click(), { minimum: 220, ready: () => translation.getAttribute('aria-pressed') === 'true' });
      for (let index = 0; index < 20; index++) {
        await observe('caption-and-follow', () => fixture.call('player_control', { request: { action: 'seek', value: (10 + index) * 7000 + 100 } }), { minimum: 220 });
      }
      await observe('translation-close', () => translation.click(), { minimum: 220, ready: () => translation.getAttribute('aria-pressed') === 'false' });
      // Allow buffered observers to deliver the final animation frame.
      await frame(); await frame();
    } catch (error) { problem = error instanceof Error ? error.message : String(error); }
    finally {
      observer.disconnect(); animationObserver.disconnect(); unsubscribe(); fixture.call = original;
    }
    return { problem, actions, longTasks, longAnimationFrames, calls, playerStateEvents, devicePixelRatio, userAgent: navigator.userAgent };
  });
  if (cpuSession) {
    const { profile } = await cpuSession.send('Profiler.stop');
    const profilePath = info.outputPath('study-motion.cpuprofile');
    await writeFile(profilePath, JSON.stringify(profile), 'utf8');
    await info.attach('study-motion.cpuprofile', { path: profilePath, contentType: 'application/json' });
    await cpuSession.detach();
  }
  const summary = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { count: sorted.length, p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? 0,
      maximumMs: sorted.at(-1) ?? 0, over25Ms: sorted.filter(value => value > 25).length,
      over50Ms: sorted.filter(value => value > 50).length };
  };
  const names = [...new Set(observation.actions.map(action => action.name))];
  const intervals = observation.actions.flatMap((action, cycle) => action.samples.slice(1).map((sample, index) => {
    const previous = action.samples[index];
    const overlaps = (start: number, duration: number) => start < sample.at && start + duration > previous.at;
    return { name: action.name, cycle, start: previous.at, end: sample.at, duration: sample.at - previous.at,
      kind: previous.active && sample.active ? 'active' : previous.active || sample.active ? 'boundary' : 'inactive',
      fromPhase: previous.phase, toPhase: sample.phase, previousWidth: previous.width, width: sample.width,
      previousMoving: previous.moving, moving: sample.moving,
      longTasks: observation.longTasks.filter(task => overlaps(task.start, task.duration)),
      longAnimationFrames: observation.longAnimationFrames.filter(task => overlaps(task.start, task.duration)),
      calls: observation.calls.filter(call => overlaps(call.start, call.duration)),
      playerStateEvents: observation.playerStateEvents.filter(event => event.at >= previous.at && event.at < sample.at) };
  }));
  const report = { phase: process.env.SURTITLE_MOTION_PERFORMANCE, segmentCount, cpuProfileEnabled: Boolean(cpuSession),
    // Panel active intervals have moving=true at both ends. Content uses its explicit 220ms observation window.
    frames: Object.fromEntries(names.map(name => [name, Object.fromEntries(['full', 'active', 'boundary', 'inactive'].map(kind =>
      [kind, summary(intervals.filter(item => item.name === name && (kind === 'full' || item.kind === kind)).map(item => item.duration))]))])),
    fixturePlacementRoundTrip: summary(observation.calls.filter(call => call.command === 'player_control' && call.action === 'bounds').map(item => item.duration)),
    fixturePlayerStateEventsDuringPlacement: observation.playerStateEvents.filter(event => event.placementId !== undefined).length,
    intervals, ...observation };
  const reportPath = info.outputPath('study-motion-cadence.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  await info.attach('study-motion-cadence.json', { path: reportPath, contentType: 'application/json' });
  console.log(JSON.stringify({ phase: report.phase, segmentCount, frames: report.frames,
    fixturePlayerStateEventsDuringPlacement: report.fixturePlayerStateEventsDuringPlacement,
    intervalsOver50Ms: intervals.filter(item => item.duration > 50), reportPath }));
  expect(observation.problem).toBeUndefined();
  expect(observation.actions.filter(action => action.name === 'panel-open')).toHaveLength(20);
  expect(observation.actions.filter(action => action.name === 'panel-close')).toHaveLength(20);
  await expect(page.locator('.study-companion-dock')).toHaveAttribute('data-moving', 'false');
});
