#!/usr/bin/env python3
"""Summarize retained FFmpeg compatibility measurements without adopting artifacts."""
import hashlib
import json
from pathlib import Path
import tarfile

root = Path(__file__).resolve().parents[2]
work = root / "work/ffmpeg-native-evaluation"
def sha(path):
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()

def summarize(name, expected):
    path = work / name / "native.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["d3d11"]["created"] and data["d3d11"]["hardwareOnly"]
    rows = []
    for row in data["mpv"]:
        assert "error" not in row, row
        assert row["ffmpegVersion"] == expected
        assert row["playbackAdvanced"] and row["selectedSecondAudio"]
        assert row["properties"]["hwdec-current"] == "d3d11va"
        assert row["audioClock"]["driver"] == "wasapi"
        assert row["pausedExactSeek"]["paused"] == "yes"
        assert abs(float(row["pausedExactSeek"]["position"]) - 1.25) <= 1 / 30 + .001
        assert row["loop"]["wraps"] >= 1
        phases = []
        for phase in row["audioClock"]["phases"]:
            assert phase["sampleCount"] >= 30
            assert phase["maximumAbsoluteAvsyncSeconds"] is not None
            assert phase["audioAdvancedSeconds"] >= 1.5 * phase["speed"]
            phases.append({key: value for key, value in phase.items() if key != "samples"})
        rows.append({key: row[key] for key in ["fixture", "ffmpegVersion", "mpvVersion", "playbackAdvanced", "properties", "pausedExactSeek", "selectedSecondAudio", "loop", "clipping"]} | {"audioClockPhases": phases})
    assert len(rows) == 6
    return {"rawReport": str(path.relative_to(root)), "rawSha256": sha(path), "dllSha256": data["dllSha256"], "hardware": data["d3d11"], "fixtures": rows}

candidate = work / "candidate-9.0.2"
bundle = candidate / "libmpv-candidate-source.tar.gz"
notices = (root / "native/libmpv-ThirdPartyNotices.txt").read_text(encoding="utf-8").replace("\r\n", "\n")
notice_results = []
with tarfile.open(bundle, "r:gz") as archive:
    for entry in archive:
        if entry.isfile() and (entry.name.startswith("notices/") or entry.name.startswith("evidence/toolchain-notices/")):
            text = archive.extractfile(entry).read().decode("utf-8").replace("\r\n", "\n")
            notice_results.append({"path": entry.name, "includedInCurrentNotice": text.strip() in notices})

releases = []
for version in ["9.0.2", "8.1.3"]:
    tag = json.loads((work / "downloads" / f"tag-{version}.json").read_text(encoding="utf-8-sig"))
    source = work / "downloads" / f"ffmpeg-{tag['object']['sha']}.tar.gz"
    releases.append({"version": version, "tag": tag["tag"], "commit": tag["object"]["sha"], "signedTagVerifiedByGitHub": tag["verification"]["verified"], "sourceSha256": sha(source), "tagUrl": f"https://api.github.com/repos/FFmpeg/FFmpeg/git/ref/tags/n{version}"})

report = {"schemaVersion": 1, "date": "2026-10-11", "releaseSource": "https://ffmpeg.org/download.html", "releases": releases,
    "build": {"result": "passed", "mpv": "0.41.0", "candidateFfmpeg": "9.0.2", "compatibilityPatches": [], "productionFlagsUnchanged": True, "oldHeadersAndLibrariesRemovedBeforeBuild": True,
              "image": "surtitle-redesign-ffmpeg-9.0.2", "log": str((work / "build-9.0.2.log").relative_to(root)), "logSha256": sha(work / "build-9.0.2.log"),
              "dllSha256": sha(candidate / "runtime/mpv-2.dll"), "dllBytes": (candidate / "runtime/mpv-2.dll").stat().st_size,
              "correspondingSourceSha256": sha(bundle), "correspondingSourceBytes": bundle.stat().st_size, "noticeComparison": notice_results},
    "baseline": summarize("baseline-runtime", "8.1.2"), "candidate": summarize("candidate-runtime", "9.0.2"),
    "decision": "FFmpeg 9.0.2 passed the unpatched build and matched playback/clock checks; 8.1.3 fallback was not needed.",
    "limitations": ["Synthetic8-second fixtures and one Windows/NVIDIA host; not a general decoder performance benchmark.", "Hidden native window does not test WebView composition or visible overlay behavior.", "WASAPI volume0 exercises the audio driver clock; mpv-reported avsync is not an acoustic or perceptual lip-sync measurement.", "No installed application profile, paid API, production DLL, or production manifest changed by this summarizer."]}
selected_dll = root / "src-tauri/resources/native/mpv-2.dll"
selected_source = root / "work/native-ci-artifact/libmpv-source.tar.gz"
selected_manifest = json.loads((root / "native/build/sources.json").read_text(encoding="utf-8"))
selected_ffmpeg = next(source for source in selected_manifest["sources"] if source["id"] == "ffmpeg")
report["adoption"] = {
    "worktreeRuntimeMatchesCandidate": selected_dll.is_file() and sha(selected_dll) == report["build"]["dllSha256"],
    "stagedCorrespondingSourceMatchesCandidate": selected_source.is_file() and sha(selected_source) == report["build"]["correspondingSourceSha256"],
    "selectedSource": selected_ffmpeg,
    "previousCandidate": "work/rendering-evaluation/hardware-candidate/",
    "installedApplicationChanged": False,
}
destination = root / "docs/redesign/evidence/ffmpeg-native-2026-10-11.json"
destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"report": str(destination), "noticeFiles": len(notice_results), "missingNotices": [row["path"] for row in notice_results if not row["includedInCurrentNotice"]]}))
