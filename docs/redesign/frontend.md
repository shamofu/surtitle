# Frontend technology evaluation

Date: 2026-10-11 (Asia/Tokyo). This is measured implementation evidence, not a claim that a dependency upgrade fixes the learning layout.

## Decisions

| Layer | Decision | Evidence and boundary |
| --- | --- | --- |
| React 19, TanStack Query/Router/Virtual | Retain; change subscription and data ownership where the redesign requires it | Existing typed routes, query selectors and virtualization are usable. No experiment established that replacing the frameworks would improve the learning flow. Broad snapshot invalidation and redundant polling are application architecture issues, not a reason to exchange Query for another cache. |
| Vite / React plugin | Update to Vite 8.3.4 and plugin-react 6.1.2 | Actual production build passes, bundled JS is smaller. Vite 6.4 receives security patches only; 8.3 receives regular patches. |
| TypeScript | Update from 5.8.3 to 7.0.2 | Actual `tsc -b` passes. This repository invokes the compiler CLI and no compiler-API incompatibility was observed. TS7 does not expose the old programmatic API; future tooling that needs it must be assessed separately. |
| Vitest | Update from 3.2.7 to 5.0.3 | Same 445-test UI suite runs with the same three existing checkbox-expectation failures, with no additional migration failures. No speed improvement is claimed. |
| Shared accessible primitives | Adopt React Aria Components 1.22.1 for shared dialogs | Browser and actual HWND-host workflows pass, including physical Windows Japanese IME. The measured incremental bundle cost is lower than the two other external candidates. Production integration is verified separately below. |
| Base UI / Radix | Keep only as development dependencies of the reproducible isolated comparison | Both are real implementations on Chromium and the selected native host. They are not imported by the production app. Base UI remains viable. Radix closed on the synthetic composing-Escape probe, but retained the dialog during actual Windows IME cancellation. |
| Existing animation abstractions | Reduce during production redesign | Status updates do not need animated height or retained hidden controls. The comparison does not establish that Motion itself causes frame drops. |

The manifest's minimum ranges were not mistaken for resolved dependencies. The baseline lock resolves React 19.2.8, Query 5.102.8, Router 1.170.33, Virtual 3.14.10, Motion 14.0.0 and Vite 6.4.3. pnpm 12 writes two YAML documents: its environment graph followed by the application graph. Both are present; the JavaScript lock was never missing.

## Baseline and toolchain result

Machine: this Windows workspace, Node 24.21.0, pnpm 12.4.2. Installed the committed dependency graph with `pnpm install --frozen-lockfile --config.cargo.enabled=false`; the flag scopes this frontend measurement and does not change the workspace's Cargo installation policy. The sandbox cannot traverse all pnpm dependency links, so the successful build/test measurements used the approved execution environment. The first sandboxed type-check failure was a dependency-access artifact, not recorded as a source failure.

| Measurement | Baseline | Updated toolchain |
| --- | ---: | ---: |
| `tsc -b` plus production Vite build, wall time | 8.38 s | 3.05 s |
| Vite-reported build time | 3.37 s | 0.758 s |
| Main JS | 802.21 kB | 787.99 kB |
| Main JS gzip | 252.71 kB | 245.93 kB |
| CSS | 73.90 kB | 73.77 kB |
| CSS gzip | 14.20 kB | 14.13 kB |
| UI tests | 442 pass, 3 fail | 442 pass, 3 fail |
| UI runner time / wall time | 45.28 / 45.95 s | 45.10 / 46.26 s |

These are single runs, with different cache warmth and other concurrent work; the baseline build overlapped a UI test run. They establish compatibility and artifact-size differences, not a statistically controlled speedup. No native runtime CPU, packaged startup or memory gain is claimed.

All three UI failures were in `job-motion.test.tsx`, where tests expected a checkbox that the checked-in quote surface no longer rendered. At the end of the baseline suite, no source files were modified in Git status. The same failure set occurred under Vitest 5. The interaction redesign must update these obsolete assertions and rerun the full suite; this report does not label that suite green.

Current Vite configuration continues to work, including the Windows worker bound and UI/script projects. The compiler's ES2022 browser target remains explicit. Updating these tools did not require a broader production-code rewrite.

## Component comparison

The candidates address a real gap in the previous custom dialog: application code had to coordinate focus, dismissal, composition and accessible structure itself. [Base UI's stated design](https://base-ui.com/react/overview/about), from creators of Radix, Material UI and Floating UI, combines unstyled components with access to each constituent node. Its practical benefit here is retaining Surtitle's layout and native-surface adapter while replacing interaction plumbing. That makes it a serious candidate, rather than a name added to a comparison table. [Radix](https://www.radix-ui.com/primitives/docs/overview/introduction) targets the same missing or insufficiently customizable platform patterns with accessible, composable primitives. [React Aria](https://react-aria.adobe.com/) supplies style-independent behavior, focus management and internationalized interactions. These documented capabilities motivate the prototypes; they do not establish which one behaves best in this application.

Reproducible source: `e2e/evaluation/ui-primitives/`. The HTML entry is independent of production routes. It renders a dialog, popover, editable Japanese/English text, two tabs and an outside action using the current Modal/AnimatedDetails implementation, Base UI 1.9.0, React Aria Components 1.22.1 or Radix Dialog/Popover 1.2.0 with Tabs 1.1.22. The current tab code reproduces the application's existing hand-written arrow-key behavior; there is no existing reusable tab primitive to import.

The original Modal implementation is archived only for this comparison in `baseline-ui.tsx`, from commit `fdb839b91d51c3aab9bb183783838205019dc1d9`. This keeps the baseline column meaningful after replacing the production Modal. Shared providers and styles continue to evolve, so exact historical byte sizes require the baseline commit's source state plus the evaluated toolchain; a later rerun measures the current common provider baseline.

Headless Chromium from Playwright 1.63.0, 1024x700, reduced motion. Each scenario opens a real DOM dialog, edits both-language text, changes a tab with ArrowRight, traverses 12 Tab presses, sends a composing-Escape event, closes with Escape and checks trigger focus, then repeats dismissal/focus checks for a popover. Focus assertions allow the libraries' deferred focus work to settle. Base UI explicitly uses `activateOnFocus`, since its default is manual activation; initial unsynchronized observations were not used for selection.

| Behavior | Current | Base UI | React Aria | Radix |
| --- | --- | --- | --- | --- |
| Text entry retained | Pass | Pass | Pass | Pass |
| Arrow key selects tab | Pass | Pass | Pass | Pass |
| Focus remains within dialog for all 12 Tab presses | Body receives focus twice | Pass | Pass | Pass |
| Background action remains unreachable by Tab | Pass | Pass | Pass | Pass |
| Synthetic composing-Escape preserves dialog | Pass | Pass | Pass | Closes |
| Ordinary Escape closes dialog; returns trigger focus | Pass | Pass | Pass | Pass |
| Popover Escape closes; returns trigger focus | Pass | Pass | Pass | Pass |
| Horizontal overflow / page exceptions | None | None | None | None |

The current native dialog's focus reaching `body` did not make the outside action reachable; this is not reported as escaped background interaction. Synthetic composition events test the DOM handling only. They do not emulate a real Windows IME candidate window. Chromium is not a replacement for packaged WebView2/HWND integration tests.

Separate production builds compile one statically selected candidate with the same providers, fields and styling. Sizes include that shared application/provider baseline, not just the libraries' npm archive sizes:

| Entry | JS bytes | gzip bytes | gzip difference from current |
| --- | ---: | ---: | ---: |
| Current | 477,259 | 149,937 | — |
| Base UI | 571,779 | 180,895 | +30,958 |
| React Aria | 521,006 | 163,940 | +14,003 |
| Radix | 532,378 | 167,999 | +18,062 |

React Aria and Base UI both pass the exercised behavior. React Aria adds less measured JavaScript in this equal entry, so it is the selected foundation. This conclusion does not depend on noisy single-click latency samples and does not claim universal library superiority. New production primitives must still adapt accessible overlays to the application's native video, modal stack, notifications and shortcuts.

Raw browser results, screenshots and standalone candidate builds are under ignored `work/ui-evaluation/`; summarized evidence above is retained with source. To reproduce: install Python Playwright 1.63.0, run the Vite dev server on 127.0.0.1:1421, then `python e2e/evaluation/ui-primitives/smoke.py`. Run `node e2e/evaluation/ui-primitives/bundle.mjs` for individual production sizes. The smoke script records expected candidate differences instead of treating all candidates as production-ready.

## Comparison on the selected native drawing host

The browser-only gap was closed with `native.tsx`, an isolated frontend embedded
in a separately identified Tauri executable. It shares the production
`NativePlayer`, `SurfaceProvider`, opaque HWND exclusions and acknowledgment/focus
adapter across all four candidates. It uses real native playback commands,
`save_card`, SQLite and source-audio extraction, with a generated local clip and a
workspace-only profile. It does not replace the shipping frontend or use the
user's library. Reproduction and limits are in the evaluation README; exact
executable, DLL and asset hashes are retained in
[the native report](evidence/ui-primitives-native.json).

WebView2 154.0.4258.62 ran at 100% Windows scale, with a 1440×900 client area.
Every candidate retained the same 1100×430 video viewport. Each showed a nonempty
partial HWND region while the opaque editor overlapped the video; uncovered
video continued playing. All four completed play → select/pause/seek → edit
meaning → save a real card with an extracted audio file → resume. The generated
MPEG-4 Part 2 fixture does not establish hardware decoding; this run tests actual
hardware video presentation and interaction, with WARP forbidden.

| Native-host behavior | Current | Base UI | React Aria | Radix |
| --- | --- | --- | --- | --- |
| Immediate Escape after region acknowledgment; trigger focus restored | Pass | Pass | Pass | Pass |
| Video geometry unchanged and partial exclusion retains visible video | Pass | Pass | Pass | Pass |
| Native SQLite/audio save and resumed playback | Pass | Pass | Pass | Pass |
| Ten Tab focus samples stay inside dialog | One BODY sample | Pass | Pass | Pass |
| Arrow key selects tab; Unicode value retained | Pass | Pass | Pass | Pass |
| Synthetic composing-Escape retains dialog | Pass | Pass | Pass | Closes |
| Actual Windows IME candidate popup, conversion cancellation and commit | Pass | Pass | Pass | Pass |

The automatic comparison completed every save/resume workflow, then reported its
two candidate differences as failed assertions. It is not a claim that all four
candidates passed every check. The original dialog's BODY focus sample did not
establish access to a background control. React Aria's force-mounted tab panels
were both visible in the evaluation stylesheet: this probe checks tab selection
and keys, not equivalent panel visibility/lifecycle. Only Dialog is adopted in
production.

Physical IME testing used Computer Use key presses in each actual evaluation
window, not Unicode fill: `Alt+grave`, `nihon`, Space twice showed the Windows
日本 / 二本 / 二品 candidate list; Escape returned to にほん without dismissing
the dialog; Space and Return committed 日本. Playback remained paused and its
surface remained visible. Base, React Aria and Radix also recorded a subsequent
ArrowLeft before restoring Latin input mode; the current implementation recorded
the restoring Alt. Every run recorded a trusted composition start and ten trusted
updates. The observed `compositionend` was **untrusted**, even at window capture,
and its origin was not established. The report preserves that limitation rather
than labeling the event native. The visible OS popup, trusted Process/start/update
events, cancellation/commit and later non-composing keys support the observed
workflow. Current's earlier collector stopped at the then-required trusted-end
assertion; its raw observations satisfy the same revised checks as the resumed
three-candidate run. See [the complete IME evidence](evidence/ui-primitives-native-ime.json)
and [the committed-text native capture](evidence/ui-primitives-native-aria-ime.png).

These results preserve the React Aria choice on a stronger basis: both it and
Base UI passed the exercised native dialog behavior, while React Aria added
14,003 gzip bytes versus Base UI's 30,958 in the separate equal-entry browser
build. This is a scoped interaction/size decision, not an argument from release
age or migration already completed. Radix's actual OS IME passed; its synthetic
event handling remains an additional application-guard consideration. None of
these isolated entries proves a full alternative production migration.

## Production dialog integration

`src/shared/ui/index.tsx` now uses React Aria `ModalOverlay`, `Modal`, `Dialog` and a close `Button`. React Aria owns portal creation, focus containment/restoration, outside dismissal, background accessibility and composition-aware Escape. The native `showModal()`/`close()` calls and custom focus-restoration queue were removed. Existing native form controls and button event APIs remain because migrating those wrappers adds no demonstrated behavior benefit.

The actual opaque dialog card registers with `Surface` before paint. `occludingElements` exposes its bounds separately from modal input blocking; the native rendering integration consumes those bounds. Transparent overlay hit-testing blocks background actions, while the card has no translucent backdrop, shadow, rounded cutout or geometry/opacity animation that an HWND rectangle cannot reproduce. The modal waits for native region acknowledgement via `data-native-occlusion="pending"` when a native player is present. There is no artificial animation delay on accepted close. Its focus scope, draft DOM and notification host remain alive until asynchronous work settles, so failures reopen the same inputs. The notification portal is marked as a React Aria toast top layer to avoid stale `aria-hidden` during host moves.

Validation of production components (not the candidate reimplementation):

- `src/test/modal-lifecycle.test.tsx` and `surface-interactions.test.tsx`: 10 passing tests for registration/release, once-only accepted commits, busy dismissal, retained uncontrolled Japanese drafts on failure, unmount handling, nested Escape and one movable notification host.
- `e2e/evaluation/production-dialog/smoke.py`: passed in headless Chromium at 1024×700 and 1366×768. Both passed 12 Tab containment checks, synthetic composing-Escape retention, locked Escape/outside dismissal, nested Escape/focus restoration/notification accessibility, ordinary Escape with trigger restoration, outside-click dismissal, no horizontal overflow and no page exceptions. Screenshots and JSON are under `work/ui-evaluation/production/`.
- A whole-UI run during concurrent settings/AI/native redesign was not green (315 pass, 132 fail of 447, one stale card mock unhandled rejection). This is recorded separately from the isolated toolchain baseline above. The historical source state was not accepted; later integration checkpoints and the frozen final-source run below update the flow fixtures and pass the complete suite.

These browser results do not validate real Windows IME candidates or HWND pixel clipping. Native integration evidence is tracked in the rendering audit.

## Integration follow-up

The historical failure counts above describe intermediate source states. A subsequent whole UI checkpoint passed 451/451 tests, and the standalone script suite passed 125/125 (`work/ui-evaluation/ui-final-review.json` and `scripts-final-review.json`). A later checkpoint passed 461/461 UI tests. After the close-race regressions below, that expanded UI checkpoint passed **467/467**, TypeScript passed, and the whole browser suite passed **181** with zero failures and five opt-in diagnostics skipped. Those diagnostics were exercised separately as documented in the performance record. A script rerun under simultaneous Rust/browser load had three child-process timeouts; the subsequent one-worker rerun passed **125/125** in 46.20 seconds. That Rust 1.99 all-features workspace checkpoint passed **545** tests, and Clippy passed with warnings denied. See [acceptance.md](acceptance.md) for scope and native/runtime boundaries.

The retained virtualization stack required application integration fixes. Installed TanStack React Virtual supports `useFlushSync: false`; its [official React adapter documentation](https://tanstack.com/virtual/latest/docs/framework/react/react-virtual#useflushsync) identifies React 19 lifecycle re-entry as a reason to use it. All three measured lists now allow React to batch updates. The transcript keeps cached row sizes while hidden and recenters when the active row is measured. The [ResizeObserver option documentation](https://tanstack.com/virtual/latest/docs/api/virtualizer#useanimationframewithresizeobserver) cautions against adding animation-frame delay without demonstrated need. That option remains disabled: final large-list diagnostics pass without lifecycle warnings or ResizeObserver exceptions. Updated measurements are in [performance.md](performance.md).

A production keyboard test exposed a gap not caught by the initial isolated comparison: an async card editor's initially disabled fields could leave focus on `body` after the opener became inert, losing the first Escape. The opaque card now receives initial focus during layout registration if no child already owns focus. React Aria retains focus containment, IME handling and return focus. The unmodified immediate-Escape/return-focus check passes for a distant item in a 1,000-card list. Activity/motion/portal browser tests passed 22/22, and the subsequent targeted transcript/keyboard/measurement batch passed 13/13.

Durable-input review reproduced two application races: initialization replacing an import URL typed during a slow read, and a competing draft writer leaving retries permanently stuck on a stale revision. Import initialization now merges early input and postpones writes until its revision is known; failed reads keep that input. Draft conflicts preserve immutable UUID archives in a separate device-local table, leaving the competing active draft untouched. Explicit reuse archives the other draft before acquiring its revision. Archives appear as read-only text in Settings, are never automatically loaded as active drafts, and have no mutation or execution API. Repeated content conflicts archive an older recovery before merging another value for the same field. Archive write failure retains in-memory input and keeps pending closure blocked. Native tests cover restart/readback, validation, immutable separation, archive failure and unfinished model numeric strings; UI tests cover competing writers, third collisions, newer typing, explicit reuse and read-only access to both versions.

The final independent close review reproduced a real bypass: finishing a detached card task could call `closeWindow()` while a separate Study guard was still saving a phrase. Preventing the original close event did not protect the later direct destruction. Phrase persistence is now registered globally, Study's explicit save participates in the same close-task registry, and destruction waits until registered tasks and pending input are stable. Tests cover a slower save, failed persistence after Study unmount, newer typing after a faster editor flushes, a newly registered task, and a dirty guard without a persistence handler. The native failure screen offers continued editing or a save retry instead of a nonfunctional discard action. The seven focused suites passed 93/93 and TypeScript checking passed after this fix.

The subsequent installed Japanese screenshot run exposed another real integration gap: opening playback settings and pressing Escape before clicking any child left the modal open. Temporarily applying `visibility:hidden` during native-region acknowledgment moved focus to `body`. Revealing the current top modal now restores only this lost focus, retaining a connected enabled descendant when possible and preserving newer child/nested-modal focus and selection. A separate failed-placement regression showed that an old rejection cleared the newly queued emergency-hide completion; the queue now clears the old slot before calling completion. All 34 native-player surface tests pass. The subsequent whole UI checkpoint passed **474/474**, and its whole browser rerun passed **181** with five opt-in diagnostics skipped and zero failures. These superseded the 467-test checkpoint above and precede the frozen final run below; actual installed immediate-Escape proof is recorded separately in the rendering report.

CI/container configuration was inspected rather than assumed incompatible: `.node-version` pins 24.21.0, the browser image pins Playwright 1.63.0, and container scripts read the manifest's pnpm version and install the frozen graph. No mismatch with the adopted frontend tools was found. This session did not execute the Linux Docker build, so that platform remains CI validation, not a claimed local result. React and Router remain inspection-based retention decisions; only the component primitives and toolchain were exercised as replacement/update comparisons.

## Frozen final-source checks

After adaptive pacing, compact-height layout, stale-query race recovery and completed-restore warning handling, the whole UI suite passed **479/479**, the script suite **125/125**, and the Rust workspace **555** with zero failures. TypeScript, generated IPC contracts, formatting and strict Clippy passed. The one-worker whole browser run passed **192/192** in **457.03 seconds**, with zero skipped, flaky or failed tests, including all five opt-in diagnostics. Machine-readable counts are in [final source checks](evidence/final-source-checks.json).

An intermediate browser run during source edits had a transcript measurement failure after Vite remounted the application and a browser resource-exhaustion startup failure. Both isolated retries passed unchanged; the frozen whole run above then passed. A temporary test-file rename also interrupted one UI discovery run before the final 479-test pass. These interrupted runs are retained as historical evidence, not silently included in the passing totals. The controlled performance comparisons remain in the performance record; noisy concurrent runs do not replace those measurements.

## Primary references checked

- [Vite support policy](https://vite.dev/releases) and [Vite 8 migration](https://vite.dev/guide/migration): active maintenance and Rolldown/Oxc compatibility considerations.
- [Vitest 5 migration](https://vitest.dev/guide/migration/): Node/Vite requirements and test behavior changes.
- [TypeScript 7 release](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/): CLI improvements and programmatic API limitation.
- [Base UI Dialog](https://base-ui.com/react/components/dialog), [React Aria Modal](https://react-aria.adobe.com/Modal), [Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog): implemented APIs, not a checklist-only comparison.
- [pnpm lockfile format](https://pnpm.io/lockfile): both lockfile documents matter.
