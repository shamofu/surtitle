"""Summarize the two generated fixtures; no credential access or provider calls."""
import hashlib
import json
import sys
import unicodedata
import wave
from pathlib import Path

root = Path(sys.argv[1])
read = lambda name: json.loads((root / name).read_text(encoding="utf-8-sig"))
references = {item["id"]: item for item in read("references.json")}
local = {item["language"]: item for item in read("local-results.json")}
provider = read("vertex-report.json") if (root / "vertex-report.json").exists() else None


def normalize(text, language):
    text = unicodedata.normalize("NFKC", text).casefold()
    cleaned = "".join(c if c.isalnum() or c.isspace() else "" for c in text)
    return cleaned.split() if language == "en" else list("".join(cleaned.split()))


def edits(reference, actual):
    costs = list(range(len(actual) + 1))
    for i, expected in enumerate(reference, 1):
        next_costs = [i]
        for j, got in enumerate(actual, 1):
            next_costs.append(min(next_costs[-1] + 1, costs[j] + 1, costs[j - 1] + (got != expected)))
        costs = next_costs
    return costs[-1]


rows = []
for language in ("en", "ja"):
    audio = root / f"{language}.wav"
    with wave.open(str(audio)) as wav:
        duration_ms = wav.getnframes() * 1000 / wav.getframerate()
    reference = references[language]["text"]
    expected = normalize(reference, language)
    whisper = read(f"whisper-{language}.json")
    chunks = [{"startMs": c["offsets"]["from"], "endMs": c["offsets"]["to"], "text": c["text"]}
              for c in whisper["transcription"]]
    candidates = [{"engine": "whisper.cpp 1.9.5 / multilingual base / CPU 4 threads", "wallMs": local[language]["wallMs"],
                   "text": local[language]["text"], "cues": chunks, "providerCostUsd": 0, "costNote": "Local inference; hardware/electricity excluded"}]
    if provider:
        result = next(r for r in provider["requests"] if r["caseId"] == f"recognition-{language}")
        attempt = result["attempts"][0]
        assert len(result["attempts"]) == 1 and attempt["state"] == "settled", "Never silently retry or ignore an unknown outcome"
        timing = read(f"vertex-{language}-timing.json")
        execution = read(f"vertex-{language}.json")
        usage = attempt["usage"]
        prompt, output = usage["promptTokenCount"], usage["totalTokenCount"] - usage["promptTokenCount"]
        candidates.append({"engine": result["model"], "wallMs": timing["wallMs"], "firstTextMs": execution["transportObservation"]["firstTextMs"],
                           "text": " ".join(c["text"] for c in result["output"]["cues"]), "cues": result["output"]["cues"],
                           "providerCostUsd": None, "usage": usage, "costState": attempt["costState"],
                           "publishedRateEstimateUsdRange": [(prompt * .25 + output * 1.5) / 1_000_000, (prompt * .50 + output * 1.5) / 1_000_000],
                           "costNote": "Catalog returned HTTP 403. Ledger charge is unknown. Range uses published text/audio rates because reported prompt tokens lack modality breakdown; not an invoice."})
    for candidate in candidates:
        actual = normalize(candidate["text"], language)
        candidate["normalizedErrorCount"] = edits(expected, actual)
        candidate["normalizedErrorRate"] = candidate["normalizedErrorCount"] / len(expected)
        candidate["timeRangeValidWith20msQuantization"] = all(0 <= c["startMs"] < c["endMs"] <= duration_ms + 20 for c in candidate["cues"])
    rows.append({"language": language, "voice": references[language]["voice"], "reference": reference, "referenceUnits": len(expected),
                 "metric": "word edit rate" if language == "en" else "character edit rate", "audioDurationMs": duration_ms,
                 "audioSha256": hashlib.sha256(audio.read_bytes()).hexdigest(), "results": candidates})
report = {"date": "2026-10-11", "kind": "two matched synthetic speech fixtures", "rows": rows,
          "providerRequests": 2 if provider else 0, "automaticRetries": 0,
          "whisperArchiveSha256": "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
          "whisperModelSha256": "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
          "whisperModelBytes": 147951465, "pricingSource": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing",
          "limitations": "Single run per engine/language, clean synthesized desktop voices, no accent/noise/music coverage. Timing bounds are checked, not word-alignment ground truth. End-to-end process timing includes startup and provider auth/network. Local installation remains an evaluation prototype, not an installed application feature."}
(root / "recognition-summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"providerRequests": report["providerRequests"], "normalizedErrors": [r["normalizedErrorCount"] for row in rows for r in row["results"]]}))
