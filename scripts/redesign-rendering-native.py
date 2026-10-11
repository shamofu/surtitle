"""Isolated Windows rendering capability probe; never opens the app/profile.

The HWND is hidden: output proves GPU initialization/decoding, not visible
composition, focus, accessibility, or presentation quality. WARP is forbidden.
Generated media and reports belong in work/rendering-evaluation.
"""
import argparse
import ctypes as c
from ctypes import wintypes as w
import hashlib
import json
from pathlib import Path
import time
import uuid


def com_method(pointer, index, result, *arguments):
    table = c.cast(pointer, c.POINTER(c.POINTER(c.c_void_p))).contents
    return c.WINFUNCTYPE(result, c.c_void_p, *arguments)(table[index])


def release(pointer):
    if pointer:
        com_method(pointer, 2, c.c_ulong)(pointer)


class AdapterDesc(c.Structure):
    _fields_ = [("Description", w.WCHAR * 128), ("VendorId", w.UINT),
                ("DeviceId", w.UINT), ("SubSysId", w.UINT), ("Revision", w.UINT),
                ("DedicatedVideoMemory", c.c_size_t), ("DedicatedSystemMemory", c.c_size_t),
                ("SharedSystemMemory", c.c_size_t), ("AdapterLuid", c.c_longlong)]


def hardware_device():
    device, context, dxgi, adapter = (c.c_void_p() for _ in range(4))
    level = w.UINT()
    create = c.WinDLL("d3d11").D3D11CreateDevice
    create.argtypes = [c.c_void_p, w.UINT, c.c_void_p, w.UINT, c.c_void_p,
                       w.UINT, w.UINT, c.POINTER(c.c_void_p), c.POINTER(w.UINT), c.POINTER(c.c_void_p)]
    create.restype = c.c_long
    # D3D_DRIVER_TYPE_HARDWARE; no retry with WARP or reference rasterizer.
    hr = create(None, 1, None, 0x20, None, 0, 7, c.byref(device), c.byref(level), c.byref(context))
    result = {"hresult": f"0x{hr & 0xffffffff:08x}", "hardwareOnly": True,
              "created": hr >= 0, "featureLevel": hex(level.value)}
    try:
        if hr < 0:
            return result
        iid = (c.c_byte * 16).from_buffer_copy(uuid.UUID("54ec77fa-1377-44e6-8c32-88fd5f44c84c").bytes_le)
        hr = com_method(device, 0, c.c_long, c.c_void_p, c.POINTER(c.c_void_p))(device, iid, c.byref(dxgi))
        if hr < 0:
            raise RuntimeError(f"IDXGIDevice QueryInterface: {hr}")
        hr = com_method(dxgi, 7, c.c_long, c.POINTER(c.c_void_p))(dxgi, c.byref(adapter))
        if hr < 0:
            raise RuntimeError(f"GetAdapter: {hr}")
        desc = AdapterDesc()
        hr = com_method(adapter, 8, c.c_long, c.POINTER(AdapterDesc))(adapter, c.byref(desc))
        if hr < 0:
            raise RuntimeError(f"GetDesc: {hr}")
        result.update(adapter=desc.Description, vendorId=hex(desc.VendorId), deviceId=hex(desc.DeviceId),
                      dedicatedVideoMemory=desc.DedicatedVideoMemory)
        return result
    finally:
        for pointer in (adapter, dxgi, context, device):
            release(pointer)


def probe_mpv(dll, fixture, directory, seconds=2.0, audio_output="null"):
    api = c.CDLL(str(dll), winmode=0x100 | 0x800)
    signatures = {
        "mpv_create": (c.c_void_p, []),
        "mpv_initialize": (c.c_int, [c.c_void_p]),
        "mpv_set_option_string": (c.c_int, [c.c_void_p, c.c_char_p, c.c_char_p]),
        "mpv_get_property_string": (c.c_void_p, [c.c_void_p, c.c_char_p]),
        "mpv_command": (c.c_int, [c.c_void_p, c.POINTER(c.c_char_p)]),
        "mpv_free": (None, [c.c_void_p]),
        "mpv_terminate_destroy": (None, [c.c_void_p]),
        "mpv_error_string": (c.c_char_p, [c.c_int]),
    }
    for name, (restype, argtypes) in signatures.items():
        function = getattr(api, name)
        function.restype, function.argtypes = restype, argtypes
    user = c.WinDLL("user32", use_last_error=True)
    user.CreateWindowExW.restype = w.HWND
    user.CreateWindowExW.argtypes = [w.DWORD, w.LPCWSTR, w.LPCWSTR, w.DWORD, c.c_int, c.c_int,
                                   c.c_int, c.c_int, w.HWND, w.HMENU, w.HINSTANCE, c.c_void_p]
    user.DestroyWindow.argtypes = [w.HWND]
    user.SetWindowRgn.argtypes = [w.HWND, w.HRGN, w.BOOL]
    user.GetWindowRgn.argtypes = [w.HWND, w.HRGN]
    gdi = c.WinDLL("gdi32", use_last_error=True)
    gdi.CreateRectRgn.argtypes = [c.c_int, c.c_int, c.c_int, c.c_int]
    gdi.CreateRectRgn.restype = w.HRGN
    gdi.CombineRgn.argtypes = [w.HRGN, w.HRGN, w.HRGN, c.c_int]
    gdi.PtInRegion.argtypes = [w.HRGN, c.c_int, c.c_int]
    gdi.DeleteObject.argtypes = [c.c_void_p]
    host = user.CreateWindowExW(0, "STATIC", "Surtitle isolated rendering probe", 0x02000000,
                                0, 0, 1280, 720, None, None, None, None)
    if not host:
        raise c.WinError(c.get_last_error())
    handle = api.mpv_create()
    if not handle:
        user.DestroyWindow(host)
        raise RuntimeError("mpv_create returned null")
    log = directory / f"{fixture.stem}-mpv.log"
    result = {"fixture": fixture.name, "hiddenHost": True, "audioOutput": audio_output, "warpAllowed": False}

    def check(code, name):
        if code < 0:
            raise RuntimeError(f"{name}: {api.mpv_error_string(code).decode()}")

    def get(name):
        pointer = api.mpv_get_property_string(handle, name.encode())
        if not pointer:
            return None
        try:
            return c.string_at(pointer).decode("utf-8", "replace")
        finally:
            api.mpv_free(pointer)

    def command(*args):
        values = (c.c_char_p * (len(args) + 1))(*(str(value).encode("utf-8") for value in args), None)
        check(api.mpv_command(handle, values), args[0])

    try:
        options = {"config": "no", "load-scripts": "no", "ytdl": "no", "terminal": "no",
                   "input-default-bindings": "no", "input-vo-keyboard": "no", "input-cursor": "no",
                   "sub-visibility": "no", "secondary-sub-visibility": "no", "wid": str(host),
                   "vo": "gpu-next", "gpu-api": "d3d11", "d3d11-warp": "no", "hwdec": "auto-safe",
                   "force-window": "yes", "keep-open": "yes", "idle": "yes", "ao": audio_output, "volume": "0",
                   "log-file": str(log), "msg-level": "all=v"}
        for name, value in options.items():
            code = api.mpv_set_option_string(handle, name.encode(), value.encode("utf-8"))
            if name in ("load-scripts", "ytdl") and value == "no" and code == -5:
                continue
            check(code, name)
        check(api.mpv_initialize(handle), "initialize")
        result.update(mpvVersion=get("mpv-version"), ffmpegVersion=get("ffmpeg-version"))
        command("loadfile", fixture)
        deadline = time.monotonic() + seconds + 10
        samples = []
        while time.monotonic() < deadline:
            position = get("time-pos")
            if position is not None:
                samples.append(float(position))
                if float(position) >= seconds:
                    break
            time.sleep(0.05)
        result["properties"] = {key: get(key) for key in ["current-vo", "hwdec-current", "video-format",
                                  "video-codec", "video-params/w", "video-params/h", "time-pos",
                                  "duration", "frame-drop-count", "decoder-frame-drop-count",
                                  "vo-delayed-frame-count", "estimated-vf-fps"]}
        result["playbackAdvanced"] = len(samples) >= 2 and samples[-1] > samples[0] + 0.5
        # Real Win32 region operation on the native video host. The compositor
        # clips descendant HWNDs to their parent's region. This remains a hidden
        # host test, not evidence of visible WebView2 overlay/focus correctness.
        full = gdi.CreateRectRgn(0, 0, 1280, 720)
        popup = gdi.CreateRectRgn(900, 40, 1250, 300)
        if gdi.CombineRgn(full, full, popup, 4) == 0:  # RGN_DIFF
            raise c.WinError(c.get_last_error())
        gdi.DeleteObject(popup)
        if user.SetWindowRgn(host, full, True) == 0:
            gdi.DeleteObject(full)
            raise c.WinError(c.get_last_error())
        # Windows owns `full` following successful SetWindowRgn.
        returned = gdi.CreateRectRgn(0, 0, 0, 0)
        kind = user.GetWindowRgn(host, returned)
        result["clipping"] = {"regionKind": kind,
          "videoPointRetained": bool(gdi.PtInRegion(returned, 400, 300)),
          "popupPointExcluded": not bool(gdi.PtInRegion(returned, 1000, 100))}
        gdi.DeleteObject(returned)
        previous_position = float(get("time-pos") or 0)
        time.sleep(0.25)
        result["clipping"]["playbackContinued"] = float(get("time-pos") or 0) > previous_position
        if user.SetWindowRgn(host, None, True) == 0:
            raise c.WinError(c.get_last_error())
        command("seek", "0.5", "absolute+exact")
        time.sleep(0.2)
        result["seekPosition"] = get("time-pos")
        command("set", "pause", "yes")
        command("seek", "1.25", "absolute+exact")
        time.sleep(0.25)
        result["pausedExactSeek"] = {"position": get("time-pos"), "paused": get("pause")}
        command("set", "speed", "1.5")
        result["speed"] = get("speed")
        tracks = json.loads(get("track-list") or "[]")
        result["tracks"] = [{key: track.get(key) for key in ["id", "type", "codec", "lang", "selected"]} for track in tracks]
        audio = [track for track in tracks if track.get("type") == "audio"]
        if len(audio) > 1:
            command("set", "aid", str(audio[1]["id"]))
            result["selectedSecondAudio"] = get("aid") == str(audio[1]["id"])
        command("set", "ab-loop-a", "0.5")
        command("set", "ab-loop-b", "1.0")
        command("seek", "0.5", "absolute+exact")
        command("set", "pause", "no")
        positions = []
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            positions.append(float(get("time-pos") or 0))
            time.sleep(0.05)
        result["loop"] = {"wraps": sum(b < a - .1 for a, b in zip(positions, positions[1:])), "minimum": min(positions), "maximum": max(positions)}
        command("set", "ab-loop-a", "no")
        command("set", "ab-loop-b", "no")
        command("set", "speed", "1")
        if audio_output == "wasapi":
            result["audioClock"] = {"driver": get("current-ao"), "volume": get("volume"), "phases": []}
            for name, speed, position in [("normal", "1", "0.5"), ("faster", "1.5", "0.5"), ("afterSeek", "1", "3.0")]:
                command("set", "speed", speed)
                command("seek", position, "absolute+exact")
                command("set", "pause", "no")
                time.sleep(0.25)
                samples = []
                began = time.monotonic()
                while time.monotonic() - began < 2.0:
                    sample = {"wallSeconds": time.monotonic() - began}
                    for key in ["avsync", "audio-pts", "time-pos", "frame-drop-count", "decoder-frame-drop-count"]:
                        value = get(key)
                        sample[key] = float(value) if value is not None else None
                    samples.append(sample)
                    time.sleep(0.05)
                sync = sorted(abs(sample["avsync"]) for sample in samples if sample["avsync"] is not None)
                audio = [sample["audio-pts"] for sample in samples if sample["audio-pts"] is not None]
                video = [sample["time-pos"] for sample in samples if sample["time-pos"] is not None]
                result["audioClock"]["phases"].append({"name": name, "speed": float(speed), "seekSeconds": float(position),
                    "settlingSeconds": 0.25, "sampleCount": len(samples), "samples": samples,
                    "maximumAbsoluteAvsyncSeconds": max(sync) if sync else None,
                    "p95AbsoluteAvsyncSeconds": sync[int((len(sync) - 1) * .95)] if sync else None,
                    "audioAdvancedSeconds": audio[-1] - audio[0] if len(audio) > 1 else None,
                    "videoAdvancedSeconds": video[-1] - video[0] if len(video) > 1 else None})
        result["surfaceCompositionTested"] = False
    finally:
        api.mpv_terminate_destroy(handle)
        user.DestroyWindow(host)
    return result


def probe_render_apis(dll):
    api = c.CDLL(str(dll), winmode=0x100 | 0x800)
    class Param(c.Structure):
        _fields_ = [("type", c.c_int), ("data", c.c_void_p)]
    api.mpv_create.restype = c.c_void_p
    api.mpv_initialize.argtypes = [c.c_void_p]
    api.mpv_set_option_string.argtypes = [c.c_void_p, c.c_char_p, c.c_char_p]
    api.mpv_render_context_create.argtypes = [c.POINTER(c.c_void_p), c.c_void_p, c.POINTER(Param)]
    api.mpv_render_context_free.argtypes = [c.c_void_p]
    api.mpv_terminate_destroy.argtypes = [c.c_void_p]
    api.mpv_error_string.restype = c.c_char_p
    results = {}
    for backend in (b"d3d11", b"opengl", b"sw"):
        handle = api.mpv_create()
        context = c.c_void_p()
        try:
            for name, value in ((b"config", b"no"), (b"vo", b"libmpv"), (b"ao", b"null")):
                if api.mpv_set_option_string(handle, name, value) < 0:
                    raise RuntimeError("Render probe option failed")
            if api.mpv_initialize(handle) < 0:
                raise RuntimeError("Render probe initialization failed")
            kind = c.create_string_buffer(backend)
            params = (Param * 2)(Param(1, c.cast(kind, c.c_void_p)), Param(0, None))
            code = api.mpv_render_context_create(c.byref(context), handle, params)
            results[backend.decode()] = {"code": code, "message": api.mpv_error_string(code).decode(),
                "contextCreated": bool(context)}
        finally:
            if context:
                api.mpv_render_context_free(context)
            api.mpv_terminate_destroy(handle)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dll", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=2.0)
    parser.add_argument("--audio-output", choices=["null", "wasapi"], default="null")
    args = parser.parse_args()
    if not 0.1 <= args.seconds <= 180: parser.error("--seconds must be between 0.1 and 180")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    dll = args.dll.resolve(strict=True)
    report = {"schemaVersion": 1, "testedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "dll": str(dll), "dllSha256": hashlib.sha256(dll.read_bytes()).hexdigest(),
              "d3d11": hardware_device(), "renderApis": probe_render_apis(dll), "mpv": []}
    for fixture in args.fixture:
        try:
            report["mpv"].append(probe_mpv(dll, fixture.resolve(strict=True), output, args.seconds, args.audio_output))
        except Exception as error:
            report["mpv"].append({"fixture": fixture.name, "error": str(error)})
    (output / "native.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
