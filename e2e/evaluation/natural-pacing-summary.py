#!/usr/bin/env python3
"""Summarize retained natural-speech results; no credentials or provider access."""
import hashlib
import json
from pathlib import Path
import statistics
import unicodedata

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "work/ai-evaluation/natural-pacing-20261011"


def read(name):
    return json.loads((WORK / name).read_text(encoding="utf-8"))


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def words(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text).casefold()
                   if c.isalnum() or c.isspace()).split()


def distance(reference, actual):
    row = list(range(len(actual) + 1))
    for i, expected in enumerate(reference, 1):
        next_row = [i]
        for j, got in enumerate(actual, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (got != expected)))
        row = next_row
    return row[-1]


fixture, local, runs = read("fixture.json"), read("local-results.json"), read("provider-results.json")
expected = words(fixture["reference"])
assert len(runs) == 6
results = []
for run in runs:
    request = run["request"]
    assert len(request["attempts"]) == 1
    attempt = request["attempts"][0]
    assert attempt["state"] == "settled" and attempt["usageState"] == "known"
    assert request["sourceAudioSha256"] == fixture["audioSha256"]
    assert all(item["finishReason"] == "STOP" for item in attempt["evidence"]["candidateDiagnostics"])
    cues = request["output"]["cues"]
    text = " ".join(cue["text"] for cue in cues)
    usage = attempt["usage"]
    prompt, output = usage["promptTokenCount"], usage["totalTokenCount"] - usage["promptTokenCount"]
    results.append({key: run[key] for key in ["index", "conditionFloorMs", "artificialWaitMs", "wallMs", "dispatchIntervalMs", "transportObservation"]} | {
        "jobId": request["id"], "digest": request["digest"], "requestBodySha256": request["requestBodySha256"],
        "attemptId": attempt["id"], "dispatchedAtMs": attempt["dispatchedAtMs"], "settledAtMs": attempt["settledAtMs"],
        "dispatchToSettlementMs": attempt["settledAtMs"] - attempt["dispatchedAtMs"],
        "usage": usage, "chargedMicrousd": attempt["chargedMicrousd"], "costState": attempt["costState"],
        "text": text, "cues": cues, "normalizedWordErrors": distance(expected, words(text)),
        "normalizedWordErrorRate": distance(expected, words(text)) / len(expected),
        "timeRangesValidWithin20msQuantization": all(0 <= cue["startMs"] < cue["endMs"] <= fixture["durationMs"] + 20 for cue in cues),
        "publishedRateEstimateUsdRange": [(prompt * .25 + output * 1.5) / 1e6, (prompt * .5 + output * 1.5) / 1e6]})
assert len({item["requestBodySha256"] for item in results}) == 1
assert all(previous["settledAtMs"] < current["dispatchedAtMs"] for previous, current in zip(results, results[1:]))
groups = []
for floor in [0, 10000]:
    selected = [item for item in results if item["conditionFloorMs"] == floor]
    intervals = [item["dispatchIntervalMs"] for item in selected if item["dispatchIntervalMs"] is not None]
    groups.append({"startFloorMs": floor, "requests": len(selected), "measuredInterStartIntervalsMs": intervals,
                   "meanInterStartMs": statistics.mean(intervals),
                   "meanCommandWallMs": statistics.mean(item["wallMs"] for item in selected),
                   "meanDispatchToSettlementMs": statistics.mean(item["dispatchToSettlementMs"] for item in selected),
                   "meanFirstTextMs": statistics.mean(item["transportObservation"]["firstTextMs"] for item in selected),
                   "observed429": 0, "unknownOutcomes": 0})
whisper = read("natural-whisper.json")
local_cues = [{"startMs": cue["offsets"]["from"], "endMs": cue["offsets"]["to"], "text": cue["text"]} for cue in whisper["transcription"]]
local.update(cues=local_cues, normalizedWordErrors=distance(expected, words(local["text"])),
             normalizedWordErrorRate=distance(expected, words(local["text"])) / len(expected),
             timeRangesValidWithin20msQuantization=all(0 <= cue["startMs"] < cue["endMs"] <= fixture["durationMs"] + 20 for cue in local_cues))
sources = [{"stem": source["stem"], "originals": source["originals"], "samples": source["samples"], "pcmSha256": source["pcmSha256"]} for source in fixture["sources"]]
report = {"schemaVersion": 1, "date": "2026-10-11", "kind": "matched public natural English speech and bounded serial dispatch comparison",
    "fixture": {key: fixture[key] for key in ["sourceCommit", "insertedSilenceSamples", "samples", "durationMs", "audioSha256", "reference", "automaticMfaWords"]} | {"sources": sources, "referenceWords": len(expected)},
    "settings": {"model": "gemini-3.1-flash-lite", "location": "global", "maxOutputTokens": 2048, "maxAudioSeconds": 15, "thinking": "omit", "responseMode": "stream_generate_content"},
    "maximumPaidRequests": 6, "actualPaidDispatches": 6, "automaticRetries": 0, "concurrency": 1,
    "conditionOrderMs": [item["conditionFloorMs"] for item in results], "conditions": groups,
    "local": local, "provider": results, "cleanup": read("cleanup.json"),
    "httpObservation": {"successfulSettledResponses": 6, "observed429": 0, "retryAfterHeadersCaptured": False,
                        "note": "All six native calls settled successfully; non-2xx cannot settle in this path. No 429 occurred. The current validation CLI does not retain raw Retry-After headers, so header absence is not asserted."},
    "pricing": {"catalogStatus": 403, "invoicedCostKnown": False, "totalPublishedRateEstimateUsdRange": [sum(item["publishedRateEstimateUsdRange"][index] for item in results) for index in [0, 1]],
                "source": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing", "note": "Published-rate estimate only; prompt usage omits modality breakdown. Ledger charge remains null/unpriced."},
    "productionPacingChangedDuringMeasurement": False,
    "adoptedPolicy": {"healthyLaneStartFloorMs": 0, "first429CooldownMs": 20000,
                      "maximumAdaptiveIntervalMs": 60000, "longerRetryAfterPreserved": True,
                      "concurrentDispatches": 1, "approvalAndUnknownOutcomeGuardsPreserved": True},
    "limitations": ["Six requests total, three per condition, one account/region/model and one short repeated English fixture; not a quota or sustained-throughput guarantee.",
        "Alternating intervals begin with no-floor; its first request has no preceding interval, leaving two measured no-floor gaps and three10s-floor gaps.",
        "Repetition, server caching, shared-host load, OAuth/network startup and time-varying provider load can affect latency.",
        "Development-validation preserves native one-request approval/accounting/manifest guards but intentionally excludes desktop client pacing. The harness adds a10s gate using actual previous dispatch timestamps; it does not execute the desktop queue.",
        "Whisper and Vertex receive identical recorded speech, but two clean audiobook utterances from one English speaker do not cover conversation, other languages, accents, noise or music.",
        "Strict word edits include British/American orthographic variants. MFA automatic word intervals are reference anchors, not human ground truth; cue-bound checks do not prove alignment accuracy."],
    "rawEvidence": [{"file": str(path.relative_to(ROOT)).replace("\\", "/"), "sha256": sha(path)} for path in [WORK / "fixture.json", WORK / "local-results.json", WORK / "provider-results.json", WORK / "final-report.stdout.log", WORK / "cleanup.json", WORK / "provider-started.json"]]}
destination = ROOT / "docs/redesign/evidence/natural-pacing-2026-10-11.json"
destination.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(json.dumps({"durationMs": fixture["durationMs"], "referenceWords": len(expected), "localErrors": local["normalizedWordErrors"],
                  "providerErrors": [item["normalizedWordErrors"] for item in results], "localWallMs": local["wallMs"],
                  "firstProviderWallMs": results[0]["wallMs"], "conditions": groups,
                  "estimateUsdRange": report["pricing"]["totalPublishedRateEstimateUsdRange"]}, indent=2))
