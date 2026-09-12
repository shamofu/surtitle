# Text AI quality evaluation — 2026-09-09

The final **70-request, 189-item** text evaluation did **not** meet every quality gate. Five of six language/task groups passed; Japanese explanations averaged **1.767/2** for explanation quality, below the required **1.80**. These are automatic checks plus an AI review, not human confirmation or a general qualification of the model. The original 60-request assessment and its scores remain unchanged and are documented below alongside the ten-request coverage completion.

## Completed proficiency coverage

Ten additional B1 explanation requests covered T01 terms six through ten in each language. T01 now contains the same ten expressions at A2, B1, and C1 in both languages; the two English T02 split-cue explanations remain additional cases. This fills the previous sampling gap without changing the reference corpus, rubric, original outputs, or any of the original 179 item judgments.

All ten new outputs were read and separately scored. Eight received 2 in every dimension. Two explanation scores were 1: the English explanation of `figured out` again restricted `found out` to merely overhearing, and the Japanese explanation of 白紙に戻った overclaimed natural/mutual causation and restarting. Meanings and examples otherwise remained grounded in their source contexts.

| Final group | Items | Meaning | Example | Translation | Explanation | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| English explanation | 32 | 2.000 | 2.000 | 2.000 | 1.906 | Pass |
| Japanese explanation | 30 | 1.967 | 1.967 | 1.967 | **1.767** | **Fail** |

The four vocabulary/translation group scores below are unchanged. The combined assessment has 15 reduced items and 17 dimensions scored 1, with no score of 0, critical error, or missing review. Completing the requested level coverage does not establish independent statistical samples or universal CEFR suitability.

The new ten requests settled $0.018374, bringing the **70 text requests to $0.142765**. Their original request records and source/digest bindings were verified. The original 60 records compare equal to their copies in the latest provider snapshot.

The separate additions are `proficiency-results-only.json` and `proficiency-coverage-rubric.json`. The final combined artifacts are `text-results-complete.json`, `text-rubric-complete.json`, and `text-evaluation-complete.json`, all under the same private local evidence directory. Their source report is `proficiency-coverage-index-completed-report.json`. The merged rubric copies every prior score/comment unchanged and appends only the ten new judgments.

| Final artifact | SHA-256 |
| --- | --- |
| Additional ten results | `2c017d1a4cb544c3b29cd9f60371e2c4d64684d4bab482e673cf62076dbd196a` |
| Additional ten AI reviews | `9e87af3316fa79d6daf465037282ccd0ad20a9305d1f4bbd8dd0c80eba54b14f` |
| Combined 70 results | `bb3c04d4b7e7ecdd57fb81eb187013fcd30f0c69b2dec1253dca3e11e44b3c46` |
| Combined 189-item rubric | `92eda5d241bcddfda73b7c69edde109fa03ff77251fd869dee02847acb7ba0af` |

```powershell
node scripts/ai-tests/evaluate.mjs --manifest work/ai-evaluation-20260909/text-reference.json --results work/ai-evaluation-20260909/text-results-complete.json --rubric work/ai-evaluation-20260909/text-rubric-complete.json --output work/ai-evaluation-20260909/text-complete-reproduced.json
```

## Original 60-request evidence and scope

The target was `gemini-3.8-flash` in `global`, with explicitly selected `LOW` thinking and one candidate. The output setting was 4,096 tokens for 56 requests and 8,192 for four vocabulary requests. These are the recorded settings of this evaluation, not product defaults or a model allowlist.

The six independently prepared, authored reference cases were T01/T02/T03 in English and Japanese. Each contains 20 source cues. The reference review was recorded before the target outputs and accepted contextual paraphrases rather than exact reference-translation matches. The result review read every generated item, its cited source, and the reference context. Each of the 179 items has explicit dimension scores and an evidence note; scores were not filled from schema success.

| Task | Requests | Reviewed items | Coverage |
| --- | ---: | ---: | --- |
| Vocabulary | 4 | 47 | T01/T02 in both languages |
| Translation | 4 | 80 | T01/T03 in both languages |
| Explanation | 52 | 52 | T01 A2/B1/C1 in both languages, plus T02 English split-cue expression at A2/C1 |
| Total | 60 | 179 | Every text request in the saved snapshot |

English explanation coverage was 11 A2, five B1, and 11 C1 requests. Japanese coverage was ten A2, five B1, and ten C1 requests. Repeated expressions at different levels are correlated observations; this does not establish performance across independent proficiency populations. T03 vocabulary and T02 translation were not included.

All 60 job IDs and plan digests matched the quote index. Their source cue IDs, times, and text matched the reference file. All completed with exactly one settled attempt. The original snapshot also contains three audio requests; an explicitly scoped derivative preserves the 60 text records unchanged and lists the excluded audio IDs. Audio quality and timing are assessed separately. The authored subtitle times are not speech timing references.

## Scores

The rubric uses 0 = wrong, 1 = usable with correction, and 2 = good. Each language/task group requires at least 20 reviewed items, no score of 0, no critical error, complete coverage, and a mean of at least 1.80 in every applicable dimension.

| Language / task | Items | Meaning | Example | Translation | Explanation | Naturalness | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| English vocabulary | 22 | 2.000 | 2.000 | 2.000 | 1.955 | — | Pass |
| Japanese vocabulary | 25 | 2.000 | 2.000 | 2.000 | 2.000 | — | Pass |
| English translation | 40 | 2.000 | — | — | — | 1.975 | Pass |
| Japanese translation | 40 | 1.975 | — | — | — | 1.975 | Pass |
| English explanation | 27 | 2.000 | 2.000 | 2.000 | 1.926 | — | Pass |
| Japanese explanation | 25 | 1.960 | 1.960 | 1.960 | **1.760** | — | **Fail** |

Thirteen items received at least one reduced score, totaling 15 dimensions scored 1. No item was scored 0 or flagged as a critical error. There were no missing, extra, or invalid rubric items. Overall failure is retained even though most items were useful.

## Findings from the actual outputs

The dictionary form **白紙に戻る** correctly retained the intransitive meaning of the source **白紙に戻った**. It was not replaced by the transitive **白紙に戻す**. The C1 explanation preserved that distinction. However, the A2 explanation added that the plan was “restarted” or had to start over; the source only establishes that the previous plan has been set aside. Its meaning, translation, and explanation therefore each received 1.

Both A2 and C1 explanations of **look forward to** cited the two adjacent cues that jointly contain the expression. The vocabulary result also retained both citations. A2 gave a usable simple pattern; C1 supplied register and grammatical detail. This resolves the earlier missing-citation failure in these observed responses without weakening validation.

The most frequent weakness was an overly absolute C1 contrast between related expressions. Examples include treating `watch` as merely directing one's gaze, treating `find out` as necessarily accidental, restricting 辞退する too narrowly, and implying that 見つける must be deliberate. These explanations are useful starting points but require qualified distinctions. The Japanese B1 example for 手を貸す also contained an unnatural construction.

Quoted instructions were treated as material to translate. **鍵を明かせ** became “reveal the key,” preserving disclosure rather than changing it to unlocking. URLs containing Japanese paths and query strings, script literals, JSON, and placeholder text stayed intact. Negation and numeric contrasts were preserved in the inspected cases. Remaining defects include the ambiguous “Follow me” for **私に従え** in an obedience context, an unnecessary translator parenthesis, and awkward English phrasing around a quoted command. These received reduced scores rather than being concealed by the successful request status.

## Cost and reproducibility

The text requests recorded **81,438 input tokens**, **16,873 candidate output tokens**, and **zero reported thought tokens**. Their settled cost was **124,391 microUSD ($0.124391)** under the recorded price snapshots. The original 63-request snapshot, generated at `2026-09-09T03:17:53.445Z`, recorded $0.125864 including its three audio requests, with no unknown outcomes, unpriced attempts, or held reservations at that time. These are snapshot figures, not the final cost of subsequent audio evaluation. This review issued no requests and changed no ledger entries.

Private local evidence is retained under `work/ai-evaluation-20260909/`:

- `text-completed-report.json`: original 63-request provider report.
- `text-results-only.json`: documented, unchanged 60-request text subset.
- `text-reference.json` and `text-reference-review.json`: independently fixed source/reference evidence.
- `text-quote-index.json`: approved plan bindings.
- `text-review-decisions.txt` and `text-rubric.json`: explicit AI judgments and comments.
- `text-evaluation-v2.json`: current machine-readable evaluation. The earlier report is retained; v2 fixes per-request group-status display, without changing scores or the overall failed gate.

| Artifact | SHA-256 |
| --- | --- |
| Original provider report | `8b3613f37d56b9819f0adbf3f1437a08b51cdf7b59153640ea5c0414d90276ec` |
| Text subset | `698a5e86482f5598e1a8b44fd3df7d93080050ef8a2382a008e9478d4ca12c7a` |
| Reference manifest | `afc1b5c2a354e2df596b98e68627a8867c4d83db109e8273b13e06e39ae13879` |
| AI rubric | `be29b6597e10553370c053955649e037e6fc577a5e29571b3b451834ef28de46` |

Reproduce the evaluation with a new output filename; the command intentionally exits with a failed-gate status:

```powershell
node scripts/ai-tests/evaluate.mjs --manifest work/ai-evaluation-20260909/text-reference.json --results work/ai-evaluation-20260909/text-results-only.json --rubric work/ai-evaluation-20260909/text-rubric.json --output work/ai-evaluation-20260909/text-evaluation-reproduced.json
pnpm test:scripts scripts/ai-tests
```

The evaluator's 33 offline tests pass, including separate language/task outcomes, critical-error gates, explicit AI provenance, source/hash binding, and quantized point-word timing handling. A passing structural test does not erase a semantic defect. These judgments remain an AI assessment of this bounded corpus; they neither declare human approval nor guarantee future model output quality.

## Post-evaluation prompt refinement — not re-evaluated live

After the 70-request evaluation, the general explanation instruction was refined to qualify contrasts by context and avoid inferring intention, agency, necessity, causes, or later events that the cited source does not entail. The earlier instruction already discouraged invented advanced-sounding distinctions; the addition makes these recurring failure modes explicit without naming a model, corpus answer, or particular expression.

An offline shared-worker regression prepares both the earlier and refined instruction snapshots, persists/reopens the SQLite ledger, requires each snapshot's own digest approval, and verifies the exact complete request body sent through the fake transport. The old prepared body remains unchanged and cannot authorize the new prompt; successful work is not resent. This tests prompt freezing and approval integrity, not semantic quality.

**The refined prompt has not been evaluated through additional paid requests.** Every prior provider result, reference, score, rubric, and failed quality gate remains unchanged. No quality improvement is claimed from this instruction change.
