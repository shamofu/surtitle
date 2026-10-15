#!/usr/bin/env python3
"""Fetch and verify the two original WAVs used by required Windows native CI."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import tempfile
import time
import urllib.error
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[2]
COMMIT = "5143690d1a6ebcd37b7f4d1b0f9fa8c83944aba5"
BASE = f"https://raw.githubusercontent.com/MontrealCorpusTools/aligned-librispeech/{COMMIT}/librispeech_test_clean/1089/"
INPUTS = [
    ("1089-134686-0001.wav", 52400,
     "6b0b24796a1017a65007d392b9f8d6e64e030cdafbf82d8ffa4235fe4b371443"),
    ("1089-134686-0003.wav", 42880,
     "2db232f2d626af81adb8b224bdcc72d71ed94e9f7180194a6279e532a08c9115"),
]
MAX_BYTES = 1024 * 1024


def download(url):
    # Retry only transport failures during acquisition, never failed assertions.
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                return response.read(MAX_BYTES + 1)
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def acquire(directory):
    directory.mkdir(parents=True, exist_ok=True)
    inputs = []
    for filename, samples, expected in INPUTS:
        target = directory / filename
        url = BASE + filename
        if target.exists() and target.stat().st_size > MAX_BYTES:
            raise ValueError(f"Oversized existing speech fixture: {target}")
        data = target.read_bytes() if target.exists() else download(url)
        if len(data) > MAX_BYTES or hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"Speech fixture differs: {filename}; expected {expected}")
        with wave.open(io.BytesIO(data), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getnframes()) != (1, 2, 16000, samples):
                raise ValueError(f"Unexpected original PCM format: {filename}")
            pcm = audio.readframes(samples)
        if not target.exists():
            with tempfile.NamedTemporaryFile(dir=directory, delete=False) as output:
                partial = Path(output.name)
                output.write(data)
            try:
                partial.replace(target)
            finally:
                partial.unlink(missing_ok=True)
        inputs.append({"url": url, "file": filename, "sha256": expected,
                       "bytes": len(data), "samples": samples,
                       "pcmSha256": hashlib.sha256(pcm).hexdigest()})
    report = {"schemaVersion": 1, "commit": COMMIT,
              "source": "MontrealCorpusTools/aligned-librispeech",
              "dataset": "LibriSpeech test-clean", "license": "CC-BY-4.0",
              "licenseSource": "https://www.openslr.org/12", "inputs": inputs}
    provenance = directory / "acquisition.json"
    provenance.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return {"fixtureDirectory": str(directory), "provenance": str(provenance), "verifiedFiles": len(inputs)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / "work/spoken-fixtures")
    directory = parser.parse_args().directory.resolve()
    if not directory.is_relative_to((ROOT / "work").resolve()):
        raise SystemExit("Use a fixture directory inside this worktree's work directory")
    print(json.dumps(acquire(directory)))


if __name__ == "__main__":
    main()
