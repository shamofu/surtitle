#!/usr/bin/env python3
"""Bounded real-speech recognition/pacing prototype; no production configuration edits.

The provider path requires explicit opt-in, a fresh isolated ledger, six immutable
one-request approvals, and never retries. Reusing a started directory is refused.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import wave

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "work/ai-evaluation/recognition-20261011"
FIXTURES = ROOT / "work/spoken-fixture-acquisition"
DIRECTORY = ROOT / "work/ai-evaluation/natural-pacing-20261011"
MODEL = "gemini-3.1-flash-lite"
CONDITIONS = [0, 10000, 0, 10000, 0, 10000]


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save(path, value, exclusive=False):
    with path.open("x" if exclusive else "w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write("\n")


def command(args, name, require_success=True):
    started = time.perf_counter()
    result = subprocess.run([str(arg) for arg in args], capture_output=True, timeout=180,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    (DIRECTORY / f"{name}.stdout.log").write_bytes(result.stdout)
    (DIRECTORY / f"{name}.stderr.log").write_bytes(result.stderr)
    elapsed = (time.perf_counter() - started) * 1000
    if require_success and result.returncode:
        raise RuntimeError(f"{name} exited {result.returncode}; stopped without retry; inspect retained logs")
    return result, elapsed


def local_fixture():
    assert sha(BASE / "whisper-bin-x64.zip") == "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb"
    assert sha(BASE / "ggml-base.bin") == "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"
    acquisition = read(FIXTURES / "acquisition.json")
    audio = bytearray()
    references = []
    spans = []
    for index, source in enumerate(acquisition["inputs"]):
        path = FIXTURES / source["preparedFile"]
        assert sha(path) == source["preparedSha256"]
        with wave.open(str(path), "rb") as wav:
            assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 16000)
            pcm = wav.readframes(wav.getnframes())
        assert hashlib.sha256(pcm).hexdigest() == source["pcmSha256"]
        if index:
            audio.extend(bytes(8000 * 2))
        offset = len(audio) // 2
        audio.extend(pcm)
        text_path = FIXTURES / (source["stem"] + ".lab")
        text_source = next(item for item in source["originals"] if item["file"].endswith(".lab"))
        assert sha(text_path) == text_source["sha256"]
        references.append(text_path.read_text(encoding="utf-8").strip())
        # Independent upstream MFA words, not human timing ground truth.
        alignment = FIXTURES / (source["stem"] + ".TextGrid")
        alignment_source = next(item for item in source["originals"] if item["file"].endswith(".TextGrid"))
        assert sha(alignment) == alignment_source["sha256"]
        words = alignment.read_text(encoding="utf-8").split("item [2]:")[0]
        matches = re.findall(r'intervals \[\d+\]:\s*xmin = ([0-9.]+)\s*xmax = ([0-9.]+)\s*text = "([^"]*)"', words)
        spans.extend({"startMs": offset / 16 + float(start) * 1000,
                      "endMs": offset / 16 + float(end) * 1000, "text": text}
                     for start, end, text in matches if text and text != "<eps>")
    path = DIRECTORY / "natural-en.wav"
    if not path.exists():
        with wave.open(str(path), "wb") as wav:
            wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            wav.writeframes(audio)
    with wave.open(str(path), "rb") as wav:
        assert wav.readframes(wav.getnframes()) == audio
    fixture = {"sourceCommit": acquisition["commit"], "sources": acquisition["inputs"],
               "insertedSilenceSamples": 8000, "samples": len(audio) // 2,
               "durationMs": len(audio) / 32, "audioSha256": sha(path),
               "reference": " ".join(references), "automaticMfaWords": spans}
    save(DIRECTORY / "fixture.json", fixture)
    if not (DIRECTORY / "local-results.json").exists():
        cli = BASE / "whisper/Release/whisper-cli.exe"
        _, elapsed = command([cli, "-m", BASE / "ggml-base.bin", "-f", path, "-l", "en", "-t", "4",
                              "-ojf", "-otxt", "-of", DIRECTORY / "natural-whisper"], "whisper")
        save(DIRECTORY / "local-results.json", {"engine": "whisper.cpp 1.9.5 / multilingual base / CPU4",
             "wallMs": elapsed, "audioSha256": sha(path), "binarySha256": sha(cli),
             "modelSha256": sha(BASE / "ggml-base.bin"),
             "text": (DIRECTORY / "natural-whisper.txt").read_text(encoding="utf-8").strip()})
    return path


def provider(audio, profile):
    marker = DIRECTORY / "provider-started.json"
    if marker.exists():
        raise RuntimeError("This bounded evaluation has already started; no paid rerun or automatic retry is allowed")
    cli = ROOT / "target/debug/surtitle-ai-validation.exe"
    root = DIRECTORY / "vertex"
    preferences = read(profile / "preferences.json")
    credential_id = preferences["credential_id"]
    if not re.fullmatch(r"[a-fA-F0-9]{64}", credential_id):
        raise RuntimeError("Invalid configured credential identifier")
    original = profile / "credentials" / (credential_id + ".dpapi")
    original_hash = sha(original)
    save(marker, {"maximumPaidRequests": 6, "maximumAudioSecondsPerRequest": 15,
         "maximumOutputTokensPerRequest": 2048, "model": MODEL, "conditionsMs": CONDITIONS,
         "sourceSha256": sha(audio), "validationBinarySha256": sha(cli),
         "automaticRetries": 0, "productionPacingChanged": False}, exclusive=True)
    command([cli, "init", "--data-root", root, "--total-usd", "2", "--per-job-usd", "1",
             "--daily-usd", "2", "--monthly-usd", "2"], "init")
    copied = root / "credentials" / (credential_id + ".dpapi")
    runs = []
    try:
        shutil.copyfile(original, copied)
        command([cli, "list-models", "--data-root", root, "--credential-id", credential_id,
                 "--location", "global"], "model-discovery")
        command([cli, "lookup-price", "--data-root", root, "--credential-id", credential_id,
                 "--location", "global", "--model-id", MODEL], "price-discovery", False)
        plans = []
        for index, floor in enumerate(CONDITIONS):
            result, _ = command([cli, "prepare", "--data-root", root, "--credential-id", credential_id,
                "--case-id", f"natural-pacing-{index + 1}", "--audio-file", audio,
                "--adapter", "audio", "--language", "en", "--max-audio-seconds", "15",
                "--model-id", MODEL, "--location", "global", "--max-output-tokens", "2048",
                "--response-mode", "stream"], f"prepare-{index + 1}")
            plan = json.loads(result.stdout)
            assert len(plan["manifest"]["prepared"]["requests"]) == 1
            assert plan["manifest"]["maxAudioSeconds"] == 15
            assert plan["quote"]["execution"]["model_id"] == MODEL
            assert plan["quote"]["execution"]["max_output_tokens"] == 2048
            assert plan["quote"]["binding"]["source_sha256"] == sha(audio)
            plans.append(plan)
        last_dispatch = None
        request_body = None
        for index, (floor, plan) in enumerate(zip(CONDITIONS, plans)):
            wait_ms = max(0, last_dispatch + floor - int(time.time() * 1000)) if last_dispatch else 0
            if wait_ms:
                time.sleep(wait_ms / 1000)
            started = int(time.time() * 1000)
            save(DIRECTORY / f"intent-{index + 1}.json", {"index": index + 1, "jobId": plan["quote"]["id"],
                 "digest": plan["quote"]["digest"], "startFloorMs": floor, "waitMs": wait_ms,
                 "commandStartedAtMs": started, "approvedMaximumRequests": 1}, exclusive=True)
            result, wall_ms = command([cli, "run", "--data-root", root, "--job-id", plan["quote"]["id"],
                "--digest", plan["quote"]["digest"], "--acknowledge-unqualified", "--approve-unpriced"],
                f"run-{index + 1}", False)
            report_result, _ = command([cli, "report", "--data-root", root], f"report-{index + 1}")
            report = json.loads(report_result.stdout)
            save(DIRECTORY / f"receipt-{index + 1}.json", report, exclusive=True)
            current = next(item for item in report["requests"] if item["id"] == plan["quote"]["id"])
            if result.returncode or len(current["attempts"]) != 1:
                raise RuntimeError(f"Request {index + 1} did not settle normally; stopped without retry")
            attempt = current["attempts"][0]
            assert attempt["state"] == "settled" and attempt["usageState"] == "known"
            assert current["state"] == "completed" and current["sourceAudioSha256"] == sha(audio)
            assert report["validation"]["attemptedRequests"] == index + 1
            assert not report["budget"]["unknown_attempts"]
            request_body = request_body or current["requestBodySha256"]
            assert current["requestBodySha256"] == request_body
            dispatch = attempt["dispatchedAtMs"]
            if last_dispatch is not None:
                assert dispatch - last_dispatch >= floor
            runs.append({"index": index + 1, "conditionFloorMs": floor, "artificialWaitMs": wait_ms,
                "commandStartedAtMs": started, "wallMs": wall_ms,
                "dispatchIntervalMs": dispatch - last_dispatch if last_dispatch else None,
                "request": current, "transportObservation": json.loads(result.stdout)["transportObservation"]})
            save(DIRECTORY / "provider-results.json", runs)
            last_dispatch = dispatch
            print(json.dumps({"request": index + 1, "floorMs": floor, "state": attempt["state"],
                              "dispatchIntervalMs": runs[-1]["dispatchIntervalMs"]}), flush=True)
    finally:
        try:
            command([cli, "report", "--data-root", root], "final-report", False)
        finally:
            assert copied.resolve().is_relative_to(DIRECTORY.resolve())
            copied.unlink(missing_ok=True)
            assert sha(original) == original_hash
            save(DIRECTORY / "cleanup.json", {"copiedEncryptedCredentialRemoved": not copied.exists(),
                 "originalEncryptedCredentialUnchanged": True, "completedNormalRequests": len(runs)})


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--execute-provider", action="store_true")
parser.add_argument("--provider-profile", type=Path, default=Path(os.environ["LOCALAPPDATA"]) / "app.surtitle.desktop")
args = parser.parse_args()
DIRECTORY.mkdir(parents=True, exist_ok=True)
audio = local_fixture()
if args.execute_provider:
    provider(audio, args.provider_profile)
print(json.dumps({"directory": str(DIRECTORY), "providerOptIn": args.execute_provider}))
