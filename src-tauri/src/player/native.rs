use super::seeks::SeekEvent;
use super::*;
use libloading::Library;
use std::{
    ffi::{CStr, CString, c_char, c_void},
    ptr,
};
use windows_sys::Win32::System::LibraryLoader::{
    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;
mod input;
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
pub struct Mpv {
    _library: Library,
    handle: Handle,
    child: windows_sys::Win32::Foundation::HWND,
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
impl Mpv {
    pub fn new(path: &Path, parent: isize) -> Result<Self> {
        ensure!(
            path.is_file(),
            "同梱 libmpv がありません。native runtime の準備が必要です / Bundled libmpv is missing"
        );
        ensure!(
            surtitle_tools::sha256_file(path)? == crate::application::runtime_hash("mpv-2.dll")?,
            "Bundled libmpv hash mismatch"
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
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let child = CreateWindowExW(
                0,
                class.as_ptr(),
                ptr::null(),
                WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
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
            let settings = [
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
                _library: lib,
                handle,
                child,
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
    pub fn bounds(&self, b: &Bounds) -> Result<()> {
        place_video_window(self.child, b)
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
        unsafe {
            ShowWindow(self.child, SW_HIDE);
        }
    }
    pub fn visible(&self) -> bool {
        unsafe { IsWindowVisible(self.child) != 0 }
    }
    pub(super) fn drain_events(&self) -> (bool, Option<i32>, Vec<SeekEvent>) {
        let mut loaded = false;
        let mut error = None;
        let mut seeks = Vec::new();
        unsafe {
            for _ in 0..128 {
                let event = (self.wait)(self.handle, 0.);
                if event.is_null() || (*event).event_id == 0 {
                    break;
                }
                if (*event).event_id == 8 {
                    loaded = true;
                } // MPV_EVENT_FILE_LOADED
                match (*event).event_id {
                    20 => seeks.push(SeekEvent::Started),   // MPV_EVENT_SEEK
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
fn place_video_window(child: windows_sys::Win32::Foundation::HWND, b: &Bounds) -> Result<()> {
    let positioned = unsafe {
        SetWindowPos(
            child,
            HWND_TOP,
            (b.x * b.scale_factor).round() as i32,
            (b.y * b.scale_factor).round() as i32,
            (b.width * b.scale_factor).round() as i32,
            (b.height * b.scale_factor).round() as i32,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
    };
    ensure!(
        positioned != 0,
        "could not show video: {}",
        std::io::Error::last_os_error()
    );
    Ok(())
}

impl Drop for Mpv {
    fn drop(&mut self) {
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
    fn video_is_above_sibling_after_resize_and_modal_restore() {
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
                place_video_window(video, &bounds).unwrap();
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
        };
        assert!(place_video_window(ptr::null_mut(), &bounds).is_err());
    }
}
