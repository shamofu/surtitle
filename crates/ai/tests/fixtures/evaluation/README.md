# Authored regression and evaluation data

These original English/Japanese materials are GPL-3.0-or-later. They contain no external works, live credentials or speech recordings.

`text-corpus.json` contains T01/T02/T03 with 20 cues per language/case. The material includes adjacent-cue expressions, negation, quantities, names and quoted instructions/code. Translations and meanings are reference proposals; synthetic cue times are not speech annotation. Do not send answer keys to a target model.

`semantic-regressions.json` supplies vocabulary cases to Rust parser tests. `semantic-review-v2.json` provides semantic review guidance. `boundary-oracle.json` contains authored boundary examples; it is not recorded-speech evidence or actual output from the production stitcher. `transcribe-timestamp-contract-v1.json` contains parser timestamp input/output examples.

A passing deterministic test does not establish semantic accuracy or human review.
