#!/usr/bin/env python3
"""Acquire the exact public inputs for the opt-in windows-spoken suite.

No test hashes are changed. Original audio, alignment and text stay untouched;
the PCM16 rewrap must match the already-pinned test file and preserve every sample.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[2]
COMMIT = "5143690d1a6ebcd37b7f4d1b0f9fa8c83944aba5"
BASE = f"https://raw.githubusercontent.com/MontrealCorpusTools/aligned-librispeech/{COMMIT}/"
INPUTS = [
    ("1089-134686-0001", 52400,
     "6b0b24796a1017a65007d392b9f8d6e64e030cdafbf82d8ffa4235fe4b371443",
     "c65ee5ee7bd8acab3ac6b97a29100187f397cccc4d1b00ae4ec31f39f3f7d3ab",
     "0a82f678afe953b8ac316479bbe3548169e249817dfc236153c5aad966da92b3",
     "7af2a45d42e7ca8fcad6310fd2e2089adf883cf346873c138c1a0815ea1aa0e6"),
    ("1089-134686-0003", 42880,
     "2db232f2d626af81adb8b224bdcc72d71ed94e9f7180194a6279e532a08c9115",
     "6786f692cd28a02b4c26d5bb5683b778fb2c6ae09bb6243355f1bc30e66eb5e3",
     "47ad56a9f71a9af9df360a3825070def4355bc4bf65defe6a180237f1d90677e",
     "7b10f440fa9b2d662e0b3bf3bd330a4181eea3c57ef3a93d03041cb18cced9f3"),
]


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def pcm(path):
    with wave.open(str(path), "rb") as audio:
        assert (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, 16000)
        return audio.readframes(audio.getnframes())


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--ffmpeg", type=Path, required=True)
parser.add_argument("--directory", type=Path, default=ROOT / "work/spoken-fixture-acquisition")
args = parser.parse_args()
directory = args.directory.resolve()
if not directory.is_relative_to((ROOT / "work").resolve()):
    raise SystemExit("Use an isolated fixture directory inside this worktree's work directory")
directory.mkdir(parents=True, exist_ok=True)
ffmpeg = args.ffmpeg.resolve(strict=True)
version = subprocess.run([str(ffmpeg), "-version"], check=True, capture_output=True, text=True, timeout=30).stdout.splitlines()[0]
inputs = []
for stem, samples, source_hash, target_hash, text_hash, alignment_hash in INPUTS:
    files = []
    for suffix, upstream, expected in [
        ("wav", "librispeech_test_clean", source_hash),
        ("lab", "librispeech_test_clean", text_hash),
        ("TextGrid", "librispeech_aligned", alignment_hash),
    ]:
        target = directory / f"{stem}.{suffix}"
        url = BASE + f"{upstream}/1089/{target.name}"
        if not target.exists():
            with urllib.request.urlopen(url, timeout=30) as response:
                data = response.read(1024 * 1024 + 1)
            if len(data) > 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected:
                raise SystemExit(f"Upstream fixture differs: {url}")
            target.write_bytes(data)
        if sha(target) != expected:
            raise SystemExit(f"Existing fixture differs; preserving it: {target}")
        files.append({"url": url, "file": target.name, "sha256": expected, "bytes": target.stat().st_size})
    source = directory / f"{stem}.wav"
    output = directory / f"{stem}-pcm16.wav"
    command = [str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(source),
               "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", str(output)]
    subprocess.run(command, check=True, timeout=30)
    if sha(output) != target_hash:
        raise SystemExit("PCM16 rewrap differs from the existing pinned fixture. Do not bypass the test hash; retain the FFmpeg version and investigate.")
    original_pcm, output_pcm = pcm(source), pcm(output)
    assert original_pcm == output_pcm and len(original_pcm) == samples * 2
    shutil.copyfile(directory / f"{stem}.lab", directory / f"{stem}.txt")
    inputs.append({"stem": stem, "originals": files, "conversionCommand": command,
                   "preparedFile": output.name, "preparedSha256": target_hash, "samples": samples,
                   "pcmSha256": hashlib.sha256(original_pcm).hexdigest(), "pcmUnchanged": True})
report = {"schemaVersion": 1, "commit": COMMIT, "source": "MontrealCorpusTools/aligned-librispeech",
          "dataset": "LibriSpeech test-clean", "license": "CC-BY-4.0", "licenseSource": "https://www.openslr.org/12",
          "alignment": "Upstream automatic MFA alignment; not human timing ground truth",
          "ffmpeg": {"path": str(ffmpeg), "version": version, "sha256": sha(ffmpeg)}, "inputs": inputs}
destination = directory / "acquisition.json"
destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"fixtureDirectory": str(directory), "provenance": str(destination), "verifiedFiles": 6}))
