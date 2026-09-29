# Fixed AI responses

`structured-responses.json` contains fictional responses authored for Surtitle tests under GPL-3.0-or-later. It contains no live service responses, credentials, tokens or external media.

`models::fixture_tests` passes valid and invalid responses through the production parser. Worker/ledger tests cover authentication, transport, usage, reservations, cancellation, recovery and replay failures without keys or network access.

Run `cargo test -p surtitle-ai --locked`. These fixtures test code behavior; live model accuracy requires separate evaluation. See [authored regression and evaluation data](evaluation/README.md) for the additional fixtures.
