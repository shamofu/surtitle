# Authored quality-evaluation references

`text-corpus.json` contains original English and Japanese material authored for this project under GPL-3.0-or-later. It contains no external works, live service responses, credentials, or speech recordings.

T01, T02, and T03 each contain 20 cues per language: 120 cues in total, with at least ten vocabulary examples per case. T02 covers ambiguous words, negation, quantities, names, and expressions spanning adjacent cues. T03 commands, JSON, HTML, and URLs are quoted learning material.

Translations and meanings are reference proposals, not completed review scores. Cue times use synthetic four-second slots and are not speech timing references. Preserve `evidenceKind: authored-oracle`. Before evaluating actual provider results, review the reference independently of those results and bind that review to the exact reference-file hash. Semantic scoring combines automatic structural checks with explicit AI review; it never claims human confirmation. Accurate alternative translations are accepted rather than graded by exact string matching.

`semantic-regressions.json` records review guidance and authored examples for previously observed problems: dictionary forms that preserve transitivity, A2/B1/C1 explanation depth, faithful translation of quoted commands, and literal URL/code preservation. Do not include reference answers in target-model request data.

`boundary-oracle.json` contains 20 authored boundary examples covering repetitions, false starts, negation, and quantities. It tests the evaluator; it is not real speech annotation or output from the stitching implementation. Live boundary assessment needs distinct recorded locations, both raw responses, their actual stitched output, and independent references.

See the [evaluation tool guide](../../../../../scripts/ai-tests/README.md) for report contracts and commands. Run `node --test scripts/ai-tests/*.test.mjs` for dependency-free offline tests. Ordinary tests make zero API calls.
