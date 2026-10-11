# Frontend scaling comparison

Measured in Chromium at 1440×900, reduced motion, local Vite development server, deterministic native request interception. The same 20 alternating search/clear actions ran before and after the card-list change. Timings include Playwright input/assertion delivery and two animation frames. They are scripted interaction measurements, **not browser INP**, and are a single run per case without statistical confidence intervals.

| Dataset | Before median / p95 | After median / p95 | Initially mounted cards | Initial DOM nodes |
| --- | --- | --- | --- | --- |
| 100 phrases | 129.3 / 215.0ms | 62.8 / 96.4ms | 100 → 7 | 4,509 → 417 |
| 1,000 phrases | 1,363.8 / 1,514.2ms | 63.1 / 96.5ms | 1,000 → 7 | 44,109 → 417 |

The measured bottleneck justified retaining TanStack Virtual and using it for phrase lists above 40 results. Smaller lists keep ordinary document rendering. Dynamic row measurements account for wrapping; the open editor/menu and focused row stay mounted for keyboard/focus continuity. Search resets the scroll position, and due-card checks/media lookup use a Set/Map instead of repeated per-card scans. Filtering and initial snapshot serialization still scale with the complete dataset; virtualization does not replace database pagination.

The final measurement uses React-batched virtualizer updates. The first post-virtualization pass, before that integration fix, measured 47.3/81.1ms and 50.9/96.7ms respectively; the difference between those short runs is not interpreted as a measured regression or improvement. Raw final files use the label `final-batched-clean`. Its initial 1,000-card navigation failed before loading the app with Chromium `ERR_NO_BUFFER_SPACE`; the isolated retry passed and produced the reported result.

The subtitle virtualizer was retained, with cached measurements while the inspector hides the list and centering updated after row measurement. The final app rendered 17 subtitle rows for both 120 and 10,000 subtitles. Search median/p95 was 77.8/162.7ms for 120 and 96.4/145.0ms for 10,000. The earlier pass measured 79.2/162.8ms and 112.8/181.5ms. These noisy, single-run values show bounded rendering at both sizes; the lower final 10,000-row p95 does not establish faster scaling.

All five final diagnostic cases passed with explicit assertions that no browser exceptions or console errors occurred. A 65-second simulated idle interval produced one change-checkpoint request and no snapshot request. One hundred player events produced no IPC requests, 50 operation events produced one operation-list request, and 20 job events produced one snapshot patch request. The large-card keyboard case also passes immediate Escape and focus return without extra waits. Transcript follow centering and return-to-manual-position checks pass in English and Japanese with the original 2px tolerance; the manual baseline is captured at the actual inspection click, after browser actionability scrolling.

Reproduce with `SURTITLE_PERFORMANCE=<label>` and `playwright test e2e/browser/redesign-performance.spec.ts --workers=1`. Raw JSON is written to ignored `work/ui-evaluation/performance/<label>-*.json`. Normal CI skips these timing diagnostics; `card-virtualization.spec.ts` checks bounded rendering, distant row access, keyboard editor activation, return focus and clearing a filtered search. Structure tests cover Japanese/light and English/dark at 1024×700. Native video geometry and packaged-app acceptance are documented separately.
