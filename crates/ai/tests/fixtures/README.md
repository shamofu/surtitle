# Fixed AI responses

`structured-responses.json` contains fictional responses authored for Surtitle tests under GPL-3.0-or-later. It contains no live service responses, credentials, tokens, or external media.

`models::fixture_tests` passes valid and invalid structured responses through the production parser. Coverage includes vocabulary citations and required fields, selected expressions, translation ID coverage, silence, repetitions, English/Japanese text, and invalid timestamps. Worker and ledger tests exercise authentication, transport, usage, reservation, cancellation, recovery, and replay failures without real keys or network access.

Run `cargo test -p surtitle-ai --locked`. These fixtures establish parser behavior, not live model accuracy. The [evaluation fixtures](evaluation/README.md) and [offline evaluation tools](../../../../scripts/ai-tests/README.md) cover authored reference data and the separate process for reviewing recorded provider results.
