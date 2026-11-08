#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Verify actual composed pixels of the project-owned short playback fixture."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time


def verify_frame(pixels, width, height, references, reference_size, contrast):
    if len(pixels) != width * height * 3 or width < 32 or height < 32:
        raise ValueError('Invalid composed viewport pixels')
    rw, rh = reference_size
    if not references or any(len(ref) != rw * rh * 3 for ref in [*references, contrast]):
        raise ValueError('Missing decoded fixture references')
    # Saturated fixture pixels distinguish video from black letterboxing and
    # ordinary neutral GPUI surfaces. Require meaningful coverage on each axis.
    rows = [0] * height
    columns = [0] * width
    for y in range(height):
        for x in range(width):
            pos = (y * width + x) * 3
            color = pixels[pos:pos + 3]
            if max(color) >= 70 and max(color) - min(color) >= 30:
                rows[y] += 1
                columns[x] += 1
    xs = [x for x, count in enumerate(columns) if count >= height * 0.10]
    ys = [y for y, count in enumerate(rows) if count >= width * 0.10]
    if not xs or not ys:
        raise ValueError('No visible fixture image in the composed viewport')
    scale = min(width / rw, height / rh)
    iw, ih = round(rw * scale), round(rh * scale)
    left, top = (width - iw) // 2, (height - ih) // 2
    image_bounds = [xs[0], ys[0], xs[-1] - xs[0] + 1, ys[-1] - ys[0] + 1]
    if any(abs(actual - expected) > 2 for actual, expected in
           zip(image_bounds, [left, top, iw, ih])):
        raise ValueError(f'Composed video is shifted or clipped: {image_bounds}, expected {[left, top, iw, ih]}')
    sampled = bytearray(rw * rh * 3)
    for y in range(rh):
        for x in range(rw):
            sx = min(width - 1, left + int((x + 0.5) * iw / rw))
            sy = min(height - 1, top + int((y + 0.5) * ih / rh))
            pos = (sy * width + sx) * 3
            sampled[(y * rw + x) * 3:(y * rw + x) * 3 + 3] = pixels[pos:pos + 3]
    matches = []
    for reference in references:
        errors = [sum(abs(sampled[i + c] - reference[i + c]) for c in range(3)) / 3
                  for i in range(0, len(reference), 3)]
        mean = sum(errors) / len(errors)
        outliers = sum(error > 40 for error in errors) / len(errors)
        # Compare only pixels that actually change between the two known seek
        # positions. Static bars alone cannot certify the requested frame.
        motion = [i for i in range(0, len(reference), 3)
                  if sum(abs(reference[i + c] - contrast[i + c]) for c in range(3)) / 3 >= 35]
        if len(motion) < rw * rh * 0.01:
            raise ValueError('Fixture positions do not contain enough distinct moving pixels')
        target_error = sum(abs(sampled[i + c] - reference[i + c]) for i in motion for c in range(3)) / (3 * len(motion))
        stale_error = sum(abs(sampled[i + c] - contrast[i + c]) for i in motion for c in range(3)) / (3 * len(motion))
        if mean <= 14 and outliers <= 0.08 and target_error <= 24 and stale_error - target_error >= 8:
            matches.append(dict(meanRgbError=mean, outlierFraction=outliers,
                                movingPixelCount=len(motion), movingRgbError=target_error,
                                otherPositionRgbError=stale_error))
    if not matches:
        raise ValueError('Composed pixels do not match the requested fixture position (blank, stale, or incorrect video)')
    return dict(imageBounds=image_bounds, expectedImageBounds=[left, top, iw, ih],
                **min(matches, key=lambda match: match['meanRgbError']))


def run(executable, args, *, data=None, deadline=None):
    timeout = 15 if deadline is None else min(15, deadline - time.monotonic())
    if timeout <= 0:
        raise ValueError('Composed fixture probe exceeded its 25-second deadline')
    result = subprocess.run([str(executable), *args], input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout,
                            creationflags=0x08000000 if sys.platform == 'win32' else 0)
    if result.returncode:
        raise ValueError(f'{Path(executable).name} failed: {result.stderr.decode(errors="replace")[-3000:]}')
    return result.stdout


def probe(ffmpeg, fixture, output, geometry, fraction):
    deadline = time.monotonic() + 25
    ffprobe = ffmpeg.with_name('ffprobe.exe' if ffmpeg.suffix.lower() == '.exe' else 'ffprobe')
    meta = json.loads(run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
                                   'stream=width,height,r_frame_rate:format=duration', '-of', 'json', str(fixture)], deadline=deadline))
    stream = meta['streams'][0]
    duration = float(meta['format']['duration'])
    if (stream['width'], stream['height'], stream['r_frame_rate']) != (640, 360, '24/1') or not 11.9 <= duration <= 12.1:
        raise ValueError('Expected the authored 640x360, 24fps, twelve-second fixture')
    if not (0.08 <= fraction <= 0.15 or 0.65 <= fraction <= 0.75):
        raise ValueError('Seek to a known distinct fixture position before capturing')
    x, y, width, height, mx, my, mw, mh = geometry
    if width < 32 or height < 32 or x < mx or y < my or x + width > mx + mw or y + height > my + mh:
        raise ValueError('Viewport is not fully inside the verified monitor')
    args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
    # The caller verifies a single active primary monitor and exclusive app
    # ownership of this exact rectangle both before and after this capture.
    capture = run(ffmpeg, [*args, '-f', 'lavfi', '-i',
                          f'ddagrab=output_idx=0:output_fmt=bgra:draw_mouse=0:framerate=10:video_size={width}x{height}:offset_x={x-mx}:offset_y={y-my}',
                          '-vf', 'hwdownload,format=bgra,format=rgb24', '-frames:v', '1',
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], deadline=deadline)
    if len(capture) != width * height * 3:
        raise ValueError('Desktop Duplication returned incomplete viewport pixels')
    if output.exists():
        raise ValueError('Existing pixel evidence is protected')
    # Retain the actual crop even if comparison fails; never save a full desktop.
    run(ffmpeg, [*args, '-n', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size',
                 f'{width}x{height}', '-i', 'pipe:0', '-frames:v', '1', str(output)], data=capture, deadline=deadline)
    frame_bytes = 160 * 90 * 3
    def decode(position, count):
        raw = run(ffmpeg, [*args, '-ss', f'{position:.6f}', '-i', str(fixture), '-an',
                           '-vf', 'scale=160:90:flags=neighbor', '-frames:v', str(count),
                           '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], deadline=deadline)
        if len(raw) != frame_bytes * count:
            raise ValueError('Incomplete decoded fixture reference')
        return [raw[i:i + frame_bytes] for i in range(0, len(raw), frame_bytes)]
    timestamp = fraction * duration
    references = decode(max(0, timestamp - 0.125), 7)
    contrast_time = duration * (0.7 if fraction < 0.5 else 0.1)
    result = verify_frame(capture, width, height, references, (160, 90), decode(contrast_time, 1)[0])
    return dict(method='DXGI Desktop Duplication / FFmpeg ddagrab',
                viewportBounds=dict(x=x, y=y, width=width, height=height),
                positionFraction=fraction, fixtureTimestampSeconds=timestamp,
                fixtureSha256=hashlib.sha256(fixture.read_bytes()).hexdigest(),
                path=output.name, sha256=hashlib.sha256(output.read_bytes()).hexdigest(),
                **result)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg', type=Path, required=True)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--geometry', type=int, nargs=8, required=True)
    parser.add_argument('--fraction', type=float, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(probe(args.ffmpeg, args.fixture, args.output, args.geometry, args.fraction)))
    except (ValueError, OSError, subprocess.TimeoutExpired, KeyError, IndexError) as error:
        raise SystemExit(f'Composed fixture verification failed: {error}')
