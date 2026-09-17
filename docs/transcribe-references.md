# Transcript reference guidance

References are needed for quality claims, not for using the application. The former AMI/Koniwa conversion and research-readiness programs have been removed with `scripts/ai-tests/`. Their source and historical output identities remain recoverable from commit `d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0` and [AI evaluation history](ai-evaluation-history.md#references-and-unexecuted-preparation--12-september-2026).

## What to retain for a new evaluation

- The exact recording, source URL/license, audio hash, selected sample interval and unchanged original annotations.
- The reference's origin: publisher text, human corpus annotation, automatic alignment or separately performed listening. Mechanical conversion does not create new human review.
- All overlapping speakers, repetitions, annotation levels, non-lexical events and partially clipped words. Do not silently trim inconvenient reference material after seeing an output.
- Coverage and timing level. Cue timestamps, utterance boundaries, word anchors and a source block are distinct. A good matched-subset timing result cannot stand in for missing words or absent Japanese word references.

Source/license verification, recognition-reference completeness and acoustic timing accuracy are separate observations. A reference may support one claim without supporting the others. Never use a transcript for a different recording as an exact source reference.

## Retained material

Historical local work verified AMI ES2002a/ES2004a annotations and Koniwa Amagasaki 2011-04-20. The original pilot cut through several words/utterances; competing Koniwa text levels and absent word anchors remained unresolved. The six-request English candidate selected a different, complete four-minute AMI interval and did not replace the frozen pilot.

Five references in the independent source selection were still missing at the last dated investigation. NICT downloads returned maintenance pages; alternative MIT captions were not approved replacements and had different licensing constraints. These are historical retrieval results, not current availability claims. Exact sources, checks and retained artifact paths are in [evaluation history](ai-evaluation-history.md).

Product tests retain their own [authored fixtures](../crates/ai/tests/fixtures/README.md). Synthetic subtitle timing and fixed responses test code behavior; they are not speech annotation or evidence of model accuracy.
