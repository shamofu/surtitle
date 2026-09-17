# Authored regression and evaluation data

These original English/Japanese materials are GPL-3.0-or-later. They contain no external works, live credentials or speech recordings. Keep fixtures referenced by Rust product tests even though the former `scripts/ai-tests/` scoring tools have been removed.

`text-corpus.json` contains T01/T02/T03 with 20 cues per language/case. The material includes adjacent-cue expressions, negation, quantities, names and quoted instructions/code. Translations and meanings are reference proposals; synthetic cue times are not speech annotation. Do not send answer keys to a target model.

`semantic-regressions.json` and the semantic review data preserve historical examples and review guidance. `boundary-oracle.json` contains authored boundary examples; it is not recorded-speech evidence or actual output from the production stitcher. Parser timestamp fixtures remain input/output regression data.

Historical research code, commands and schemas are recoverable from commit `d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0`. Conclusions and evidence identities are summarized in [AI evaluation history](../../../../../docs/ai-evaluation-history.md). A passing deterministic test does not establish semantic accuracy or human review.
