# Implementation and verification status

Surtitle is a Windows 11 x64 development application. Local media/subtitle workflows, interval playback, immutable audio cards, FSRS review, learning export/restore and optional Vertex AI requests are implemented. [Draft study](draft-study.md) supports useful available ranges while other transcript ranges remain disputed or missing.

## Current behavior

- Local corrections and adoption preserve original provider responses, unresolved warnings, manual revisions and cost holds. Saving a card binds its text and audio to the reviewed selection.
- Models are user-selected; discovery does not certify access or quality. Priced and unpriced scopes require explicit approval. Unknown outcomes retain holds and are not automatically retried.
- Export/restore validates learning data without importing credentials, charge ledgers, execution approvals or external-tool selections.
- Windows playback uses real libmpv. Linux is a development/test environment with an E2E-only playback adapter.

See [architecture](architecture.md), [AI behavior](ai.md), [tool management](tools.md) and [learning transfer](data-transfer.md) for current interfaces.

## Verification and known limits

CI runs the full application verification flow on Ubuntu and Windows, then tests standard Tauri packaging and the installer lifecycle. Native compilation uses Docker cache layers keyed by its own inputs; it does not require rebuilding unchanged dependencies for every application edit. The optional Dev Container is for local work. Commands and coverage are in the [test guide](ai-test-plan.md), [E2E guide](../e2e/README.md) and [native runtime guide](native-runtime.md).

The [verification history](verification-history.md) records candidate-specific local results. Its latest historical Linux full E2E run failed, followed by a passing focused draft-study rerun; the focused result is not a full-suite pass. Earlier installer records establish extraction/audit only, not installation or hosted CI success. New verification must be assessed against its actual source and artifacts.

AI quality remains incomplete. The retained English dialogue pilot had provisional WER 22.41%/18.46% and matched-subset endpoint p95 570/600 ms. No chunk profile was promoted. Earlier Japanese explanations failed their semantic threshold, Flash failed non-speech controls, and local Whisper was not adopted. [AI evaluation history](ai-evaluation-history.md) preserves scopes, denominators, failures and the cumulative USD 1.313156 in charges/holds. Removing research scripts does not change those findings.

## Remaining work

- Measure actual contextual listening, saved-item correctness and human correction effort. Automated playback, saved-response tests and synthetic silence do not measure these outcomes. Independent Japanese timing references and broader language/genre coverage remain missing for the corresponding quality claims.
- Verify each release's disposable install/overwrite/uninstall and data retention, production playback, prerequisites and UAC behavior. Local builds or extracted-package audits alone are insufficient.
- Complete the hosted CI flow for the release source and inspect its artifacts before claiming a tested publication. Audible speaker output and hardware decoding are separate from software-rendered E2E checks.

Further live model experiments need a concrete reviewed scope. The historical research campaign is not a mandatory application CI stage or an automatic model-qualification gate.
