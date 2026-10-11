#!/usr/bin/env python3
"""Prepare an isolated FFmpeg/mpv compatibility build, reusing codec-independent cache.

Download signed-tag metadata and exact commit archives into
work/ffmpeg-native-evaluation/downloads first. No production inputs are changed.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("version", choices=["9.0.2", "8.1.3"])
args = parser.parse_args()
work = root / "work/ffmpeg-native-evaluation"
downloads = work / "downloads"
tag = json.loads((downloads / f"tag-{args.version}.json").read_text(encoding="utf-8-sig"))
if tag["tag"] != f"n{args.version}" or not tag["verification"]["verified"]:
    raise SystemExit("Expected a verified official release tag")
commit = tag["object"]["sha"]
archive = downloads / f"ffmpeg-{commit}.tar.gz"
sha256 = hashlib.file_digest(archive.open("rb"), "sha256").hexdigest()
context = work / f"context-{args.version}"
destination = context / "native/build"
destination.mkdir(parents=True, exist_ok=True)
for source in (root / "work/rendering-evaluation/gl-context/native/build").iterdir():
    if source.is_file():
        shutil.copyfile(source, destination / source.name)

# Keep the existing dependency stage's input bytes for Docker cache reuse.
# The actual candidate recipe below uses the production D3D11 configuration.
shutil.copyfile(root / "native/build/native-build.sh", destination / "native-build.sh")
manifest = json.loads((root / "native/build/sources.json").read_text(encoding="utf-8-sig"))
source = next(item for item in manifest["sources"] if item["id"] == "ffmpeg")
source.update(ref=f"n{args.version}", commit=commit, sha256=sha256)
candidate = context / "candidate"
candidate.mkdir(exist_ok=True)
shutil.copyfile(archive, candidate / archive.name)
(candidate / "sources.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

docker = (destination / "Dockerfile").read_text(encoding="utf-8")
marker = "COPY native/build/native-build.sh native/build/native-build-evidence.py native/build/native_source_archive.py /workspace/native/build/"
if docker.count(marker) != 1:
    raise SystemExit("Dependency-cache Docker recipe changed")
replacement = f"""COPY candidate/sources.json /workspace/native/build/sources.json
COPY candidate/{archive.name} /build/source-cache/{archive.name}
# All paths below belong to this isolated container's disposable build tree.
# Remove old FFmpeg headers/libraries too, so removed APIs cannot pass by accident.
RUN rm -rf /build/sources/ffmpeg /build/objects/ffmpeg /build/objects/mpv \\
    /build/prefix/include/libavcodec /build/prefix/include/libavdevice \\
    /build/prefix/include/libavfilter /build/prefix/include/libavformat \\
    /build/prefix/include/libavutil /build/prefix/include/libswresample \\
    /build/prefix/include/libswscale \\
    /build/prefix/lib/libav*.a /build/prefix/lib/libsw*.a \\
    /build/prefix/lib/pkgconfig/libav*.pc /build/prefix/lib/pkgconfig/libsw*.pc
COPY Dockerfile.ffmpeg /workspace/native/build/Dockerfile.ffmpeg
{marker}"""
(context / "Dockerfile.ffmpeg").write_text(docker.replace(marker, replacement), encoding="utf-8", newline="\n")
evidence = destination / "native-build-evidence.py"
text = evidence.read_text(encoding="utf-8")
needle = "'native/build/native-build-deps.sh',"
if text.count(needle) != 1:
    raise SystemExit("Dependency-cache evidence recipe changed")
evidence.write_text(text.replace(needle, needle + " 'native/build/Dockerfile.ffmpeg',"), encoding="utf-8", newline="\n")
print(json.dumps({"context": str(context), "version": args.version, "commit": commit, "sourceSha256": sha256}))
