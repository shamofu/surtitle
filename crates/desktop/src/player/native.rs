use super::seeks::SeekEvent;
use super::*;
use libloading::Library;
use std::{
    ffi::{CStr, CString, c_char, c_void},
    ptr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use windows_sys::Win32::System::LibraryLoader::{
    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;
#[cfg(all(test, feature = "e2e-test"))]
#[path = "native/composition_tests.rs"]
mod composition_tests;
mod input;
mod regions;
type Handle = *mut c_void;
type Create = unsafe extern "C" fn() -> Handle;
type Init = unsafe extern "C" fn(Handle) -> i32;
type Set = unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> i32;
type Command = unsafe extern "C" fn(Handle, *const *const c_char) -> i32;
type ErrorString = unsafe extern "C" fn(i32) -> *const c_char;
type GetString = unsafe extern "C" fn(Handle, *const c_char) -> *mut c_char;
type Free = unsafe extern "C" fn(*mut c_void);
type Destroy = unsafe extern "C" fn(Handle);
type Get = unsafe extern "C" fn(Handle, *const c_char, i32, *mut c_void) -> i32;
type FreeNode = unsafe extern "C" fn(*mut Node);
type Wait = unsafe extern "C" fn(Handle, f64) -> *mut Event;
type AcquireSwapChain = unsafe extern "C" fn(Handle, *mut *mut c_void) -> i32;
#[repr(C)]
struct Event {
    event_id: i32,
    error: i32,
    reply_userdata: u64,
    data: *mut c_void,
}
#[repr(C)]
struct EndFile {
    reason: i32,
    error: i32,
    playlist_entry_id: i64,
    playlist_insert_id: i64,
    playlist_insert_num_entries: i32,
}
#[repr(C)]
union Value {
    string: *mut c_char,
    flag: i32,
    int64: i64,
    double: f64,
    list: *mut NodeList,
}
#[repr(C)]
struct Node {
    u: Value,
    format: i32,
}
#[repr(C)]
struct NodeList {
    num: i32,
    values: *mut Node,
    keys: *mut *mut c_char,
}
#[derive(Clone)]
struct VideoSnapshot {
    aspect: f64,
    surface: Option<gpui_windows::CompositionSwapChain>,
}
#[derive(Default)]
struct VideoSnapshotState {
    value: Option<VideoSnapshot>,
    dirty: bool,
    refresh_failed: bool,
}
impl VideoSnapshotState {
    fn clear(&mut self, repair: bool) {
        self.value = None;
        self.dirty = repair;
        self.refresh_failed = false;
    }
}
pub struct Mpv {
    _library: Arc<Library>,
    handle: Handle,
    child: windows_sys::Win32::Foundation::HWND,
    placement: Arc<Mutex<SurfacePlacement>>,
    composition: Option<AcquireSwapChain>,
    composition_size: [u32; 2],
    video_snapshot: Mutex<VideoSnapshotState>,
    set: Set,
    command: Command,
    error_string: ErrorString,
    get_string: GetString,
    free: Free,
    destroy: Destroy,
    get: Get,
    free_node: FreeNode,
    wait: Wait,
}
// libmpv is thread safe; all calls are further serialized by the owning mutex.
// The child window is created and geometrically updated only on the GUI thread.
unsafe impl Send for Mpv {}

#[cfg(test)]
mod loading_tests {
    use super::*;

    #[test]
    fn missing_bundled_library_still_reports_the_missing_file() {
        let directory = tempfile::tempdir().unwrap();
        let error = Mpv::new(&directory.path().join("mpv-2.dll"), 0)
            .err()
            .expect("A missing library must fail");
        assert!(error.to_string().contains("Bundled libmpv is missing"));
    }

    #[test]
    fn invalid_bundled_library_reaches_the_windows_loader() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mpv-2.dll");
        std::fs::write(&path, b"not a library").unwrap();
        let error = Mpv::new(&path, 0)
            .err()
            .expect("Invalid native bytes must fail to load");
        assert!(
            error.downcast_ref::<libloading::Error>().is_some(),
            "{error}"
        );
    }
}

impl Mpv {
    pub fn new(path: &Path, parent: isize) -> Result<Self> {
        ensure!(
            path.is_file(),
            "同梱 libmpv がありません。native runtime の準備が必要です / Bundled libmpv is missing"
        );
        let lib: Library = unsafe {
            libloading::os::windows::Library::load_with_flags(
                path,
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )?
            .into()
        };
        unsafe {
            let create: Create = *lib.get(b"mpv_create\0")?;
            let init: Init = *lib.get(b"mpv_initialize\0")?;
            let option: Set = *lib.get(b"mpv_set_option_string\0")?;
            let set: Set = *lib.get(b"mpv_set_property_string\0")?;
            let command: Command = *lib.get(b"mpv_command\0")?;
            let error_string: ErrorString = *lib.get(b"mpv_error_string\0")?;
            let get_string: GetString = *lib.get(b"mpv_get_property_string\0")?;
            let free: Free = *lib.get(b"mpv_free\0")?;
            let destroy: Destroy = *lib.get(b"mpv_terminate_destroy\0")?;
            let get: Get = *lib.get(b"mpv_get_property\0")?;
            let free_node: FreeNode = *lib.get(b"mpv_free_node_contents\0")?;
            let wait: Wait = *lib.get(b"mpv_wait_event\0")?;
            let composition = gpui_windows::window_frame_update(parent)
                .filter(|owner| owner.supports_composition_video())
                .map(|_| {
                    lib.get::<AcquireSwapChain>(b"mpv_surtitle_acquire_d3d11_swapchain\0")
                        .map(|symbol| *symbol)
                        .context(
                            "Bundled libmpv lacks the required owned composition swapchain bridge",
                        )
                })
                .transpose()?;
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let child = CreateWindowExW(
                0,
                class.as_ptr(),
                ptr::null(),
                // The native child sits below GPUI's composition tree. Its
                // ordered aperture reveals video while later UI stays above it.
                WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0,
                0,
                1,
                1,
                parent as _,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
            );
            ensure!(!child.is_null(), "failed to create native video window");
            let handle = create();
            if handle.is_null() {
                DestroyWindow(child);
                bail!("mpv_create failed");
            }
            let mut settings = vec![
                ("config", "no".to_string()),
                ("load-scripts", "no".into()),
                ("ytdl", "no".into()),
                ("input-default-bindings", "no".into()),
                ("input-vo-keyboard", "no".into()),
                ("input-cursor", "no".into()),
                // Captions are rendered by the study UI below the native video.
                // Keep subtitle tracks decoded for selection and study import.
                ("sub-visibility", "no".into()),
                ("secondary-sub-visibility", "no".into()),
                ("wid", (child as usize).to_string()),
                ("vo", "gpu-next".into()),
                ("gpu-api", "d3d11".into()),
                ("hwdec", "auto-safe".into()),
                ("force-window", "yes".into()),
                ("keep-open", "yes".into()),
                ("idle", "yes".into()),
            ];
            let mut composition_size = [0, 0];
            if composition.is_some() {
                // Keep this backing stable through companion-panel movement.
                // The compositor uniformly fits its letterboxed video content.
                use windows_sys::Win32::Graphics::Gdi::*;
                let monitor = MonitorFromWindow(parent as _, MONITOR_DEFAULTTONEAREST);
                let mut info = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                let (width, height) = if GetMonitorInfoW(monitor, &mut info) != 0 {
                    (
                        info.rcMonitor.right - info.rcMonitor.left,
                        info.rcMonitor.bottom - info.rcMonitor.top,
                    )
                } else {
                    (1920, 1080)
                };
                composition_size = [width.max(1) as u32, height.max(1) as u32];
                settings.retain(|(key, _)| *key != "wid");
                settings.extend([
                    ("gpu-context", "d3d11".into()),
                    ("d3d11-output-mode", "composition".into()),
                    (
                        "d3d11-composition-size",
                        format!("{}x{}", composition_size[0], composition_size[1]),
                    ),
                ]);
            }
            for (key, value) in settings {
                let (k, v) = (CString::new(key)?, CString::new(value.as_str())?);
                let result = option(handle, k.as_ptr(), v.as_ptr());
                if !accepts_mpv_option_result(key, &value, result) {
                    destroy(handle);
                    DestroyWindow(child);
                    bail!(
                        "libmpv rejected required option {key}: {}",
                        describe_error(error_string, result)
                    );
                }
            }
            #[cfg(feature = "e2e-test")]
            for (key, value) in [("hwdec", "no"), ("d3d11-warp", "yes"), ("ao", "null")] {
                // Opt-in desktop validation uses the shipped graphics path;
                // automated CI remains deterministic and audio stays muted.
                if key != "ao" && std::env::var("SURTITLE_E2E_REAL_RENDERER").as_deref() == Ok("1")
                {
                    continue;
                }
                let result = option(
                    handle,
                    CString::new(key)?.as_ptr(),
                    CString::new(value)?.as_ptr(),
                );
                if result < 0 {
                    destroy(handle);
                    DestroyWindow(child);
                    bail!(
                        "libmpv rejected required E2E option {key}: {}",
                        describe_error(error_string, result)
                    );
                }
            }
            let result = init(handle);
            if result < 0 {
                destroy(handle);
                DestroyWindow(child);
                bail!(
                    "libmpv initialization failed: {}",
                    describe_error(error_string, result)
                );
            }
            Ok(Self {
                _library: Arc::new(lib),
                handle,
                child,
                placement: Arc::default(),
                composition,
                composition_size,
                video_snapshot: Mutex::default(),
                set,
                command,
                error_string,
                get_string,
                free,
                destroy,
                get,
                free_node,
                wait,
            })
        }
    }
    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        let (k, v) = (CString::new(key)?, CString::new(value)?);
        let result = unsafe { (self.set)(self.handle, k.as_ptr(), v.as_ptr()) };
        ensure!(
            result >= 0,
            "mpv property {key} rejected: {}",
            describe_error(self.error_string, result)
        );
        Ok(())
    }
    pub fn command(&self, args: &[&str]) -> Result<()> {
        if matches!(args.first(), Some(&"stop" | &"loadfile")) {
            self.video_snapshot.lock().unwrap().clear(false);
            if self.composition.is_some() {
                self.hide();
            }
        }
        let strings = args
            .iter()
            .map(|s| CString::new(*s))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut ptrs: Vec<_> = strings.iter().map(|s| s.as_ptr()).collect();
        ptrs.push(ptr::null());
        let result = unsafe { (self.command)(self.handle, ptrs.as_ptr()) };
        ensure!(
            result >= 0,
            "mpv command {} failed: {}",
            args.first().copied().unwrap_or("<empty>"),
            describe_error(self.error_string, result)
        );
        Ok(())
    }
    pub fn string(&self, key: &str) -> Option<String> {
        let key = CString::new(key).ok()?;
        unsafe {
            let p = (self.get_string)(self.handle, key.as_ptr());
            if p.is_null() {
                None
            } else {
                let s = CStr::from_ptr(p).to_string_lossy().into_owned();
                (self.free)(p.cast());
                Some(s)
            }
        }
    }
    pub fn number(&self, key: &str) -> Option<f64> {
        self.string(key)?.parse().ok()
    }
    pub(super) fn diagnostic_properties(&self) -> diagnostics::Properties {
        let mut properties = diagnostics::Properties::default();
        for key in [
            "time-pos",
            "audio-pts",
            "avsync",
            "frame-drop-count",
            "decoder-frame-drop-count",
            "pause",
            "seeking",
            "idle-active",
            "eof-reached",
            "core-idle",
            "paused-for-cache",
            "current-vo",
            "current-ao",
            "hwdec-current",
            "container-fps",
            "video-sync",
            "display-sync-active",
            "speed",
            "audio-delay",
            "mpv-version",
        ] {
            properties.insert(key, self.diagnostic_property(key));
        }
        properties
    }
    fn diagnostic_property(&self, key: &str) -> std::result::Result<serde_json::Value, i32> {
        let key = CString::new(key).map_err(|_| -4)?;
        let mut node = Node {
            u: Value { int64: 0 },
            format: 0,
        };
        unsafe {
            let result = (self.get)(
                self.handle,
                key.as_ptr(),
                6,
                (&mut node as *mut Node).cast(),
            );
            if result < 0 {
                return Err(result);
            }
            let value = match node.format {
                1 if !node.u.string.is_null() => Ok(serde_json::Value::String(
                    CStr::from_ptr(node.u.string).to_string_lossy().into_owned(),
                )),
                3 => Ok(serde_json::Value::Bool(node.u.flag != 0)),
                4 => Ok(serde_json::Value::Number(node.u.int64.into())),
                5 => serde_json::Number::from_f64(node.u.double)
                    .map(serde_json::Value::Number)
                    .ok_or(-11),
                _ => Err(-9),
            };
            (self.free_node)(&mut node);
            value
        }
    }
    pub fn bounds(&self, b: &Bounds, media_ready: bool) -> Result<()> {
        input::set_blocked(self.child, b.input_blocked);
        let epoch = {
            let mut placement = self.placement.lock().unwrap();
            placement.epoch = placement.epoch.wrapping_add(1);
            placement.epoch
        };
        // Keep GPUI's Rc/Weak handle local to this GUI-thread operation; Mpv is
        // Send for serialized media commands, but GUI handles must not cross threads.
        let frame_update =
            unsafe { gpui_windows::window_frame_update(GetParent(self.child) as isize) };
        if let Some(frame_update) = frame_update {
            let shared_placement = self.placement.clone();
            if self.composition.is_some() {
                let frame = self.composition_frame(b, media_ready);
                self.placement
                    .lock()
                    .unwrap()
                    .composition_active
                    .store(frame.is_some(), Ordering::Release);
                return frame_update.stage_composition_video(frame, false);
            }
            let aspect = self
                .video_snapshot
                .lock()
                .unwrap()
                .value
                .as_ref()
                .map(|v| v.aspect);
            let bounds = composition_bounds(b, aspect);
            let child = self.child as isize;
            ensure!(
                frame_update.stage(move || {
                    apply_staged_video_geometry(child, epoch, &bounds, &shared_placement)
                }),
                "video parent window was destroyed"
            );
            Ok(())
        } else {
            // Standalone native consumers have no GPUI frame to join.
            let mut placement = self.placement.lock().unwrap();
            place_video_window(self.child, b, &mut placement.applied)
        }
    }
    fn composition_frame(
        &self,
        bounds: &Bounds,
        media_ready: bool,
    ) -> Option<gpui_windows::CompositionVideoFrame> {
        // Prepaint must not enter mpv's core lock: even a fast owned acquisition
        // can wait behind a loop seek. Only clone the last event-owned snapshot.
        let viewport = regions::physical_bounds(bounds);
        if !media_ready || viewport[2] <= 0 || viewport[3] <= 0 {
            return None;
        }
        let snapshot = self.video_snapshot.lock().unwrap().value.clone()?;
        let clip = bounds.clip.as_ref().map(|clip| {
            let mut clipped = bounds.clone();
            clipped.x = clip.x;
            clipped.y = clip.y;
            clipped.width = clip.width;
            clipped.height = clip.height;
            regions::physical_bounds(&clipped)
        });
        Some(gpui_windows::CompositionVideoFrame {
            surface: snapshot.surface?,
            viewport,
            content_aspect: snapshot.aspect,
            clip,
            active: self.placement.lock().unwrap().composition_active.clone(),
        })
    }
    fn refresh_video_snapshot(&self) -> Result<()> {
        // The pinned mpv emits VIDEO_RECONFIG for output dimensions, crop, PAR,
        // rotation and filter changes. FILE_LOADED also refreshes same-aspect VOs.
        // A force-window audio placeholder is not a selected video track.
        let aspect = self.number("vid").filter(|id| *id > 0.).and_then(|_| {
            let mut node = Node {
                u: Value { int64: 0 },
                format: 0,
            };
            unsafe {
                if (self.get)(
                    self.handle,
                    c"video-out-params".as_ptr(),
                    6,
                    (&mut node as *mut Node).cast(),
                ) < 0
                {
                    return None;
                }
                let aspect = aspect_from_node(&node);
                (self.free_node)(&mut node);
                aspect
            }
        });
        let snapshot = if let Some(aspect) = aspect {
            let surface = if let Some(acquire) = self.composition {
                let mut pointer = ptr::null_mut();
                let result = unsafe { acquire(self.handle, &mut pointer) };
                if result == -10 {
                    let mut cache = self.video_snapshot.lock().unwrap();
                    cache.value = None;
                    cache.dirty = true;
                    return Ok(());
                }
                ensure!(
                    result >= 0,
                    "owned video swapchain acquisition failed: {}",
                    describe_error(self.error_string, result)
                );
                Some(unsafe {
                    gpui_windows::CompositionSwapChain::from_owned_raw(
                        pointer,
                        self._library.clone(),
                        self.composition_size,
                    )
                }?)
            } else {
                None
            };
            Some(VideoSnapshot { aspect, surface })
        } else {
            None
        };
        let mut cache = self.video_snapshot.lock().unwrap();
        cache.value = snapshot;
        cache.dirty = false;
        cache.refresh_failed = false;
        Ok(())
    }
    pub fn on_surface_click(&self, callback: impl Fn() + Send + Sync + 'static) -> Result<()> {
        input::install(self.child, std::sync::Arc::new(callback))
    }
    #[cfg(all(test, feature = "e2e-test"))]
    pub(super) fn hold_file_load_for_test(&self, name: &str) -> Result<()> {
        // A dedicated test player keeps this hook for its entire lifetime.
        type AddHook = unsafe extern "C" fn(Handle, u64, *const c_char, i32) -> i32;
        let add: AddHook = unsafe { *self._library.get(b"mpv_hook_add\0")? };
        let name = CString::new(name)?;
        ensure!(
            unsafe { add(self.handle, 1, name.as_ptr(), 0) } >= 0,
            "could not install test load hook"
        );
        Ok(())
    }
    #[cfg(all(test, feature = "e2e-test"))]
    pub(super) fn wait_file_load_hook_for_test(&self) -> Result<u64> {
        #[repr(C)]
        struct Hook {
            name: *const c_char,
            id: u64,
        }
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        loop {
            unsafe {
                let event = (self.wait)(self.handle, 0.01);
                if !event.is_null() && (*event).event_id == 25 && !(*event).data.is_null() {
                    let hook = &*(*event).data.cast::<Hook>();
                    return Ok(hook.id);
                }
            }
            ensure!(Instant::now() < deadline, "test load hook was not reached");
        }
    }
    #[cfg(all(test, feature = "e2e-test"))]
    pub(super) fn resume_file_load_for_test(&self, id: u64) -> Result<()> {
        type ContinueHook = unsafe extern "C" fn(Handle, u64) -> i32;
        let resume: ContinueHook = unsafe { *self._library.get(b"mpv_hook_continue\0")? };
        ensure!(
            unsafe { resume(self.handle, id) } >= 0,
            "could not resume test load"
        );
        Ok(())
    }
    #[cfg(all(test, feature = "e2e-test"))]
    pub(super) fn surface_window(&self) -> windows_sys::Win32::Foundation::HWND {
        self.child
    }
    pub fn hide(&self) {
        let was_active = self.placement.lock().unwrap().invalidate(false);
        // An unready Study canvas can call this on every prepaint. Repeated
        // already-hidden calls must not create a perpetual frame request.
        if self.composition.is_some()
            && was_active
            && let Some(owner) =
                unsafe { gpui_windows::window_frame_update(GetParent(self.child) as isize) }
        {
            // Detach on the owning GUI thread. The renderer-held COM reference
            // also keeps the DLL loaded until its next matching submission.
            let _ = owner.stage_composition_video(None, true);
        }
        unsafe {
            ShowWindow(self.child, SW_HIDE);
        }
    }
    pub fn visible(&self) -> bool {
        if self.composition.is_some() {
            return self
                .placement
                .lock()
                .unwrap()
                .composition_active
                .load(Ordering::Acquire);
        }
        unsafe { IsWindowVisible(self.child) != 0 }
    }
    pub(super) fn drain_events(&self) -> (bool, Option<i32>, Vec<SeekEvent>) {
        let mut loaded = false;
        let mut error = None;
        let mut seeks = Vec::new();
        let mut drained = false;
        unsafe {
            for _ in 0..128 {
                let event = (self.wait)(self.handle, 0.);
                if event.is_null() || (*event).event_id == 0 {
                    drained = true;
                    break;
                }
                if (*event).event_id == 8 {
                    loaded = true;
                } // MPV_EVENT_FILE_LOADED
                match (*event).event_id {
                    6 | 7 | 24 => {
                        // Start/end supersede earlier reconfig notifications;
                        // overflow repairs from current state on the next drain.
                        self.video_snapshot
                            .lock()
                            .unwrap()
                            .clear((*event).event_id == 24);
                        self.hide();
                    }
                    8 | 17 => self.video_snapshot.lock().unwrap().dirty = true,
                    20 => seeks.push(SeekEvent::Started), // MPV_EVENT_SEEK
                    21 => seeks.push(SeekEvent::Restarted), // MPV_EVENT_PLAYBACK_RESTART
                    _ => {}
                }
                if (*event).event_id == 7 && !(*event).data.is_null() {
                    let end = &*(*event).data.cast::<EndFile>();
                    if end.reason == 4 {
                        error = Some(end.error);
                    }
                }
            }
        }
        // Never refresh from a partial event batch: a later start/end can retire
        // those notifications. Coalesce actual changes; loop seeks do not query.
        if drained && self.video_snapshot.lock().unwrap().dirty {
            if let Err(error) = self.refresh_video_snapshot() {
                let mut cache = self.video_snapshot.lock().unwrap();
                cache.value = None;
                if !cache.refresh_failed {
                    eprintln!("Could not refresh native video composition: {error:#}");
                }
                cache.refresh_failed = true;
                drop(cache);
                self.hide();
            }
            if self.video_snapshot.lock().unwrap().value.is_none() {
                self.hide();
            }
        }
        (loaded, error, seeks)
    }
    pub fn tracks(&self) -> Vec<Track> {
        unsafe {
            let mut node = Node {
                u: Value { int64: 0 },
                format: 0,
            };
            if (self.get)(
                self.handle,
                c"track-list".as_ptr(),
                6,
                (&mut node as *mut Node).cast(),
            ) < 0
            {
                return vec![];
            }
            let mut result = Vec::new();
            if node.format == 7 && !node.u.list.is_null() {
                let list = &*node.u.list;
                if list.num >= 0 && list.num <= 1024 && !list.values.is_null() {
                    for track in std::slice::from_raw_parts(list.values, list.num as usize) {
                        if track.format != 8 || track.u.list.is_null() {
                            continue;
                        }
                        let map = &*track.u.list;
                        if map.num < 0
                            || map.num > 128
                            || map.values.is_null()
                            || map.keys.is_null()
                        {
                            continue;
                        }
                        let mut out = Track {
                            id: 0,
                            kind: String::new(),
                            title: String::new(),
                            language: None,
                            selected: false,
                            ff_index: None,
                            external: false,
                        };
                        for i in 0..map.num as usize {
                            let key = *map.keys.add(i);
                            if key.is_null() {
                                continue;
                            }
                            let value = &*map.values.add(i);
                            let key = CStr::from_ptr(key).to_string_lossy();
                            match key.as_ref() {
                                "id" if value.format == 4 => out.id = value.u.int64,
                                "ff-index" if value.format == 4 => {
                                    out.ff_index = u32::try_from(value.u.int64).ok()
                                }
                                "external" if value.format == 3 => out.external = value.u.flag != 0,
                                "selected" if value.format == 3 => out.selected = value.u.flag != 0,
                                "type" | "title" | "lang"
                                    if value.format == 1 && !value.u.string.is_null() =>
                                {
                                    let s = CStr::from_ptr(value.u.string)
                                        .to_string_lossy()
                                        .into_owned();
                                    match key.as_ref() {
                                        "type" => out.kind = s,
                                        "title" => out.title = s,
                                        _ => out.language = Some(s),
                                    }
                                }
                                _ => {}
                            }
                        }
                        if out.title.is_empty() {
                            out.title = format!("{} {}", out.kind, out.id);
                        }
                        result.push(out);
                    }
                }
            }
            (self.free_node)(&mut node);
            result
        }
    }
}
fn describe_error(error_string: ErrorString, code: i32) -> String {
    // libmpv owns this static string; the loaded library outlives the call.
    let message = unsafe { error_string(code) };
    if message.is_null() {
        format!("unknown mpv error ({code})")
    } else {
        format!(
            "{} ({code})",
            unsafe { CStr::from_ptr(message) }.to_string_lossy()
        )
    }
}
#[derive(Default)]
struct SurfacePlacement {
    epoch: u64,
    retired: bool,
    applied: Option<AppliedGeometry>,
    composition_active: Arc<AtomicBool>,
}

/// Read one coherent post-filter map while its libmpv-owned node is alive.
unsafe fn aspect_from_node(node: &Node) -> Option<f64> {
    if node.format != 8 {
        return None;
    }
    let list = unsafe { node.u.list.as_ref()? };
    if !(0..=1024).contains(&list.num) || list.values.is_null() || list.keys.is_null() {
        return None;
    }
    let (mut width, mut height, mut rotation) = (None, None, 0.);
    for index in 0..list.num as usize {
        let key = unsafe { *list.keys.add(index) };
        if key.is_null() {
            continue;
        }
        let value = unsafe { &*list.values.add(index) };
        let number = match value.format {
            4 => unsafe { value.u.int64 as f64 },
            5 => unsafe { value.u.double },
            _ => continue,
        };
        match unsafe { CStr::from_ptr(key).to_bytes() } {
            b"dw" => width = Some(number),
            b"dh" => height = Some(number),
            b"rotate" => rotation = number,
            _ => {}
        }
    }
    display_aspect(width?, height?, rotation)
}

fn display_aspect(width: f64, height: f64, rotation: f64) -> Option<f64> {
    if !width.is_finite() || !height.is_finite() || width <= 0. || height <= 0. {
        return None;
    }
    let rotation = rotation.rem_euclid(360.);
    let aspect = if rotation == 90. || rotation == 270. {
        height / width
    } else {
        width / height
    };
    (aspect.is_finite() && aspect > 0.).then_some(aspect)
}

fn composition_bounds(viewport: &Bounds, aspect: Option<f64>) -> Bounds {
    let mut fitted = viewport.clone();
    // The ordered GPUI composition layer owns popup opacity and clipping. A
    // second native popup hole could outlive its fading/sliding GPUI overlay.
    fitted.occlusions.clear();
    let [left, top, width, height] = regions::physical_bounds(viewport);
    let scale = viewport.scale_factor;
    let viewport_clip = SurfaceRect {
        x: left as f64 / scale,
        y: top as f64 / scale,
        width: width as f64 / scale,
        height: height as f64 / scale,
    };
    fitted.clip = Some(if let Some(clip) = &viewport.clip {
        let x = viewport_clip.x.max(clip.x);
        let y = viewport_clip.y.max(clip.y);
        SurfaceRect {
            x,
            y,
            width: ((viewport_clip.x + viewport_clip.width).min(clip.x + clip.width) - x).max(0.),
            height: ((viewport_clip.y + viewport_clip.height).min(clip.y + clip.height) - y)
                .max(0.),
        }
    } else {
        viewport_clip
    });
    if let Some(aspect) = aspect.filter(|aspect| aspect.is_finite() && *aspect > 0.)
        && width > 0
        && height > 0
    {
        // Fit the actual post-filter display aspect, not the letterboxed
        // viewport. Height-limited motion now moves the HWND without stretching
        // an old mpv swapchain; width-limited changes scale both axes together.
        let (video_width, video_height) = if width as f64 / height as f64 > aspect {
            (
                ((height as f64 * aspect).round() as i32).clamp(1, width),
                height,
            )
        } else {
            (
                width,
                ((width as f64 / aspect).round() as i32).clamp(1, height),
            )
        };
        fitted.x = (left + (width - video_width) / 2) as f64 / scale;
        fitted.y = (top + (height - video_height) / 2) as f64 / scale;
        fitted.width = video_width as f64 / scale;
        fitted.height = video_height as f64 / scale;
    }
    fitted
}
impl SurfacePlacement {
    /// Returns whether hiding needs a new composition submission. An already
    /// inactive generation must not re-arm the owner's frame demand.
    fn invalidate(&mut self, retired: bool) -> bool {
        let was_active = self.composition_active.load(Ordering::Acquire);
        self.epoch = self.epoch.wrapping_add(1);
        self.retired |= retired;
        self.applied = None;
        self.composition_active.store(false, Ordering::Release);
        self.composition_active = Arc::default();
        was_active
    }
    fn accepts(&self, epoch: u64) -> bool {
        !self.retired && self.epoch == epoch
    }
}

#[derive(Clone, PartialEq, Eq)]
struct AppliedGeometry {
    rect: [i32; 4],
    region: regions::Shape,
}
impl AppliedGeometry {
    fn new(bounds: &Bounds) -> Self {
        Self {
            rect: regions::physical_bounds(bounds),
            region: regions::shape(bounds),
        }
    }
}

fn place_video_window(
    child: windows_sys::Win32::Foundation::HWND,
    b: &Bounds,
    applied: &mut Option<AppliedGeometry>,
) -> Result<()> {
    let geometry = AppliedGeometry::new(b);
    apply_video_geometry(child, geometry, applied)
}

fn apply_video_geometry(
    child: windows_sys::Win32::Foundation::HWND,
    geometry: AppliedGeometry,
    applied: &mut Option<AppliedGeometry>,
) -> Result<()> {
    apply_video_geometry_with(child, geometry, applied, |child, [x, y, width, height]| {
        let positioned = unsafe {
            SetWindowPos(
                child,
                HWND_TOP,
                x,
                y,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        };
        ensure!(
            positioned != 0,
            "could not show video: {}",
            std::io::Error::last_os_error()
        );
        Ok(())
    })
}

fn apply_video_geometry_with(
    child: windows_sys::Win32::Foundation::HWND,
    geometry: AppliedGeometry,
    applied: &mut Option<AppliedGeometry>,
    position: impl FnOnce(windows_sys::Win32::Foundation::HWND, [i32; 4]) -> Result<()>,
) -> Result<()> {
    // Native mutations can partially succeed. Until the whole update succeeds,
    // never let the cache claim the previous region still matches the HWND.
    let previous = applied.take();
    if previous
        .as_ref()
        .is_none_or(|last| last.region != geometry.region)
    {
        geometry.region.apply(child)?;
    }
    if previous
        .as_ref()
        .is_none_or(|last| last.rect != geometry.rect)
        || unsafe { IsWindowVisible(child) == 0 }
    {
        position(child, geometry.rect)?;
    }
    *applied = Some(geometry);
    Ok(())
}

fn apply_staged_video_geometry(
    child: isize,
    epoch: u64,
    bounds: &Bounds,
    shared_placement: &Arc<Mutex<SurfacePlacement>>,
) -> Result<Option<gpui_windows::FrameUpdateRollback>> {
    let mut placement = shared_placement.lock().unwrap();
    if !placement.accepts(epoch) {
        return Ok(None);
    }
    let previous = placement.applied.clone();
    if let Err(error) = place_video_window(child as _, bounds, &mut placement.applied) {
        drop(placement);
        rollback_video_window(child as _, epoch, previous, shared_placement);
        return Err(error);
    }
    drop(placement);
    let placement = shared_placement.clone();
    Ok(Some(Box::new(move || {
        rollback_video_window(child as _, epoch, previous, &placement)
    })))
}

fn rollback_video_window(
    child: windows_sys::Win32::Foundation::HWND,
    epoch: u64,
    previous: Option<AppliedGeometry>,
    placement: &Mutex<SurfacePlacement>,
) {
    let mut placement = placement.lock().unwrap();
    if !placement.accepts(epoch) {
        return;
    }
    if let Some(previous) = previous {
        if let Err(error) = apply_video_geometry(child, previous, &mut placement.applied) {
            placement.applied = None;
            eprintln!("video frame geometry rollback failed: {error:#}");
        }
    } else {
        // No accepted geometry exists yet. Do not expose an initial native
        // surface against a parent frame that failed to submit.
        unsafe {
            ShowWindow(child, SW_HIDE);
        }
        placement.applied = None;
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        self.hide();
        // A queued closure must never touch a recycled child HWND.
        self.placement.lock().unwrap().invalidate(true);
        unsafe {
            (self.destroy)(self.handle);
            DestroyWindow(self.child);
        }
    }
}

#[cfg(test)]
mod surface_tests {
    use super::*;

    #[test]
    fn repeated_unready_prepaint_hides_settle_without_reviving_old_content() {
        let mut placement = SurfacePlacement::default();
        assert!(
            !placement.invalidate(false),
            "initially hidden needs no submission"
        );
        placement.composition_active.store(true, Ordering::Release);
        let outgoing = placement.composition_active.clone();
        assert!(
            placement.invalidate(false),
            "visible content needs one detach submission"
        );
        for _ in 0..120 {
            assert!(
                !placement.invalidate(false),
                "an unready canvas must not keep requesting frames"
            );
        }
        placement.composition_active.store(true, Ordering::Release);
        assert!(
            !outgoing.load(Ordering::Acquire),
            "new content cannot reactivate the retired generation"
        );
        assert!(placement.invalidate(true));
        assert!(!placement.invalidate(true));
    }

    fn viewport(width: f64) -> Bounds {
        Bounds {
            x: 20.,
            y: 40.,
            width,
            height: 326.,
            scale_factor: 1.,
            clip: None,
            occlusions: vec![],
            input_blocked: false,
        }
    }

    #[test]
    fn composition_child_keeps_display_aspect_during_width_motion_and_resize() {
        let aspect = display_aspect(640., 360., 0.).unwrap();
        for width in [1200., 1100., 900., 800., 700.] {
            let fitted = composition_bounds(&viewport(width), Some(aspect));
            let [left, top, width_px, height_px] = regions::physical_bounds(&fitted);
            assert_eq!([width_px, height_px], [580, 326]);
            assert_eq!(left, 20 + ((width as i32 - 580) / 2));
            assert_eq!(top, 40);
        }
        for width in [550., 500., 400., 200.] {
            let fitted = composition_bounds(&viewport(width), Some(aspect));
            let [left, top, width_px, height_px] = regions::physical_bounds(&fitted);
            assert_eq!(width_px, width as i32);
            assert_eq!(left, 20);
            assert!((height_px as f64 - width / aspect).abs() <= 0.5);
            assert!(top >= 40 && top + height_px <= 366);
        }
    }

    #[test]
    fn composition_fit_uses_display_rotation_clips_and_owns_overlay_visibility() {
        assert_eq!(display_aspect(768., 576., 0.), Some(4. / 3.));
        assert_eq!(display_aspect(640., 360., 90.), Some(9. / 16.));
        assert_eq!(display_aspect(640., 360., 270.), Some(9. / 16.));
        assert_eq!(display_aspect(640., 360., 180.), Some(16. / 9.));
        assert_eq!(display_aspect(0., 0., 0.), None);
        assert_eq!(display_aspect(f64::NAN, 360., 0.), None);
        for scale_factor in [1., 1.25, 1.5, 2.] {
            let mut original = viewport(900.);
            original.scale_factor = scale_factor;
            original.clip = Some(SurfaceRect {
                x: 100.,
                y: 60.,
                width: 500.,
                height: 280.,
            });
            original.occlusions.push(SurfaceOcclusion {
                rect: SurfaceRect {
                    x: 200.,
                    y: 80.,
                    width: 100.,
                    height: 80.,
                },
                border_radius: 12.,
            });
            let fitted = composition_bounds(&original, display_aspect(640., 360., 90.));
            let [_, _, width_px, height_px] = regions::physical_bounds(&fitted);
            assert!((width_px as f64 - height_px as f64 * 9. / 16.).abs() <= 0.5);
            assert_eq!(height_px, regions::physical_bounds(&original)[3]);
            assert!(
                fitted.occlusions.is_empty(),
                "GPUI owns every overlay, not a stale native hole"
            );
            let clip = fitted.clip.unwrap();
            assert_eq!(
                [clip.x, clip.y, clip.width, clip.height],
                [100., 60., 500., 280.]
            );
            assert_eq!(
                original.occlusions.len(),
                1,
                "standalone bounds remain unchanged"
            );
            let audio = composition_bounds(&original, None);
            assert_eq!(
                regions::physical_bounds(&audio),
                regions::physical_bounds(&original)
            );
        }
        let mut clipped = viewport(900.);
        clipped.clip = Some(SurfaceRect {
            x: 0.,
            y: 0.,
            width: 100.,
            height: 100.,
        });
        let clip = composition_bounds(&clipped, None).clip.unwrap();
        assert_eq!(
            [clip.x, clip.y, clip.width, clip.height],
            [20., 40., 80., 60.]
        );
    }

    #[test]
    fn video_stays_above_client_after_resize_and_restore_without_taking_focus() {
        unsafe {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let create = |parent, style| {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    ptr::null(),
                    style,
                    0,
                    0,
                    100,
                    100,
                    parent,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null(),
                )
            };
            let parent = create(ptr::null_mut(), WS_POPUP);
            assert!(!parent.is_null());
            let webview = create(parent, WS_CHILD);
            let video = create(parent, WS_CHILD);
            assert!(!webview.is_null() && !video.is_null());
            let active = GetForegroundWindow();
            let mut bounds = Bounds {
                x: 10.,
                y: 20.,
                width: 80.,
                height: 60.,
                scale_factor: 1.5,
                clip: None,
                occlusions: vec![],
                input_blocked: false,
            };
            for width in [80., 90.] {
                ShowWindow(video, SW_HIDE);
                SetWindowPos(
                    webview,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                bounds.width = width;
                place_video_window(video, &bounds, &mut None).unwrap();
                assert_eq!(GetTopWindow(parent), video);
                assert_ne!(GetWindowLongPtrW(video, GWL_STYLE) as u32 & WS_VISIBLE, 0);
                assert_eq!(GetForegroundWindow(), active);
            }
            DestroyWindow(parent);
        }
    }

    #[test]
    fn invalid_video_window_reports_placement_failure() {
        let bounds = Bounds {
            x: 0.,
            y: 0.,
            width: 10.,
            height: 10.,
            scale_factor: 1.,
            clip: None,
            occlusions: vec![],
            input_blocked: false,
        };
        assert!(place_video_window(ptr::null_mut(), &bounds, &mut None).is_err());
    }

    #[test]
    fn staged_native_geometry_rolls_back_and_cannot_reappear_after_hide_or_destroy() {
        unsafe {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let child = CreateWindowExW(
                0,
                class.as_ptr(),
                ptr::null(),
                WS_POPUP,
                10,
                20,
                100,
                80,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
            );
            assert!(!child.is_null());
            let mut bounds = Bounds {
                x: 10.,
                y: 20.,
                width: 100.,
                height: 80.,
                scale_factor: 1.,
                clip: None,
                occlusions: vec![],
                input_blocked: false,
            };
            let placement = Arc::new(Mutex::new(SurfacePlacement::default()));
            place_video_window(child, &bounds, &mut placement.lock().unwrap().applied).unwrap();
            let previous = placement.lock().unwrap().applied.clone();
            bounds.clip = Some(SurfaceRect {
                x: 10.,
                y: 20.,
                width: 50.,
                height: 80.,
            });
            bounds.width = 150.;
            assert!(
                apply_video_geometry_with(
                    child,
                    AppliedGeometry::new(&bounds),
                    &mut placement.lock().unwrap().applied,
                    |_, _| anyhow::bail!("injected SetWindowPos failure after region mutation"),
                )
                .is_err()
            );
            assert!(
                placement.lock().unwrap().applied.is_none(),
                "partial mutation invalidates cache"
            );
            let region_has_right_half = || {
                use windows_sys::Win32::Graphics::Gdi::*;
                let region = CreateRectRgn(0, 0, 0, 0);
                assert_ne!(GetWindowRgn(child, region), RGN_ERROR);
                let contains = PtInRegion(region, 75, 40) != 0;
                DeleteObject(region);
                contains
            };
            assert!(
                !region_has_right_half(),
                "first native mutation took effect"
            );
            rollback_video_window(child, 0, previous, &placement);
            assert!(
                region_has_right_half(),
                "rollback must not trust the stale region cache"
            );
            bounds.clip = None;
            let rollback = apply_staged_video_geometry(child as isize, 0, &bounds, &placement)
                .unwrap()
                .unwrap();
            let width = || {
                let mut rect = windows_sys::Win32::Foundation::RECT::default();
                assert_ne!(GetWindowRect(child, &mut rect), 0);
                rect.right - rect.left
            };
            assert_eq!(width(), 150);
            rollback();
            assert_eq!(width(), 100);
            let late_rollback = apply_staged_video_geometry(child as isize, 0, &bounds, &placement)
                .unwrap()
                .unwrap();
            placement.lock().unwrap().invalidate(false);
            ShowWindow(child, SW_HIDE);
            late_rollback();
            assert_eq!(IsWindowVisible(child), 0);
            assert!(
                apply_staged_video_geometry(child as isize, 0, &bounds, &placement)
                    .unwrap()
                    .is_none()
            );
            placement.lock().unwrap().invalidate(true);
            DestroyWindow(child);
            assert!(
                apply_staged_video_geometry(child as isize, 2, &bounds, &placement)
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn physical_geometry_ignores_subpixel_and_input_only_changes() {
        let mut bounds = Bounds {
            x: 10.2,
            y: 20.,
            width: 100.,
            height: 80.,
            scale_factor: 1.25,
            clip: None,
            occlusions: vec![],
            input_blocked: false,
        };
        let before = AppliedGeometry::new(&bounds);
        bounds.x += 0.1;
        bounds.width += 0.1;
        bounds.input_blocked = true;
        assert!(before == AppliedGeometry::new(&bounds));
        bounds.width += 1.;
        assert!(before != AppliedGeometry::new(&bounds));
        bounds.width = 100.;
        bounds.occlusions.push(SurfaceOcclusion {
            rect: SurfaceRect {
                x: 20.,
                y: 30.,
                width: 20.,
                height: 20.,
            },
            border_radius: 4.,
        });
        assert!(before != AppliedGeometry::new(&bounds));
    }
}
