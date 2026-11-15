use super::*;
use std::time::Duration;

thread_local! {
    static EVENTS: std::cell::RefCell<(std::collections::VecDeque<i32>, Event)> = const { std::cell::RefCell::new((
        std::collections::VecDeque::new(),
        Event { event_id: 0, error: 0, reply_userdata: 0, data: ptr::null_mut() },
    )) };
}
unsafe extern "C" fn queued_event(_: Handle, _: f64) -> *mut Event {
    EVENTS.with(|events| {
        let mut events = events.borrow_mut();
        events.1.event_id = events.0.pop_front().unwrap_or(0);
        &mut events.1 as *mut Event
    })
}
fn queue_events(events: impl IntoIterator<Item = i32>) {
    EVENTS.with(|queue| queue.borrow_mut().0 = events.into_iter().collect());
}

fn snapshot_player() -> Mpv {
    let resources = std::env::var_os("SURTITLE_RESOURCE_DIR").expect("SURTITLE_RESOURCE_DIR");
    let path = Path::new(&resources).join("native/mpv-2.dll");
    unsafe {
        let library: Library = libloading::os::windows::Library::load_with_flags(
            path,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
        .unwrap()
        .into();
        let create: Create = *library.get(b"mpv_create\0").unwrap();
        let initialize: Init = *library.get(b"mpv_initialize\0").unwrap();
        let option: Set = *library.get(b"mpv_set_option_string\0").unwrap();
        let handle = create();
        assert!(!handle.is_null());
        let player = Mpv {
            handle,
            child: ptr::null_mut(),
            placement: Arc::default(),
            composition: Some(
                *library
                    .get(b"mpv_surtitle_acquire_d3d11_swapchain\0")
                    .unwrap(),
            ),
            composition_size: [160, 90],
            video_snapshot: Mutex::default(),
            set: *library.get(b"mpv_set_property_string\0").unwrap(),
            command: *library.get(b"mpv_command\0").unwrap(),
            error_string: *library.get(b"mpv_error_string\0").unwrap(),
            get_string: *library.get(b"mpv_get_property_string\0").unwrap(),
            free: *library.get(b"mpv_free\0").unwrap(),
            destroy: *library.get(b"mpv_terminate_destroy\0").unwrap(),
            get: *library.get(b"mpv_get_property\0").unwrap(),
            free_node: *library.get(b"mpv_free_node_contents\0").unwrap(),
            wait: *library.get(b"mpv_wait_event\0").unwrap(),
            _library: Arc::new(library),
        };
        for (key, value) in [
            ("config", "no"),
            ("load-scripts", "no"),
            ("ao", "null"),
            ("vo", "gpu-next"),
            ("gpu-api", "d3d11"),
            ("gpu-context", "d3d11"),
            ("hwdec", "no"),
            ("d3d11-output-mode", "composition"),
            ("d3d11-composition-size", "160x90"),
            ("idle", "yes"),
            ("keep-open", "yes"),
            ("pause", "yes"),
            ("force-window", "yes"),
        ] {
            assert!(
                accepts_mpv_option_result(
                    key,
                    value,
                    option(
                        handle,
                        CString::new(key).unwrap().as_ptr(),
                        CString::new(value).unwrap().as_ptr()
                    )
                ),
                "{key}"
            );
        }
        assert!(initialize(handle) >= 0);
        player
    }
}

fn wait_snapshot(player: &Mpv, aspect: Option<f64>) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        player.drain_events();
        let actual = player
            .video_snapshot
            .lock()
            .unwrap()
            .value
            .as_ref()
            .map(|v| v.aspect);
        if match (actual, aspect) {
            (Some(a), Some(b)) => (a - b).abs() < 0.0001,
            (None, None) => true,
            _ => false,
        } {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "snapshot {actual:?}, expected {aspect:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
#[ignore = "requires prepared patched native resources and a D3D11 adapter"]
fn composition_snapshot_follows_reconfiguration_without_prepaint_core_calls() {
    let fixture = tempfile::tempdir().unwrap();
    let path = fixture.path().join("snapshot.y4m");
    let mut video = b"YUV4MPEG2 W32 H18 F30:1 Ip A1:1 C420jpeg\n".to_vec();
    for _ in 0..60 {
        video.extend_from_slice(b"FRAME\n");
        video.extend(std::iter::repeat_n(128u8, 32 * 18 * 3 / 2));
    }
    std::fs::write(&path, video).unwrap();
    let mut player = snapshot_player();
    player
        .command(&["loadfile", path.to_str().unwrap()])
        .unwrap();
    wait_snapshot(&player, Some(16. / 9.));
    let bounds = Bounds {
        x: 10.,
        y: 20.,
        width: 300.,
        height: 180.,
        scale_factor: 1.,
        clip: None,
        occlusions: vec![],
        input_blocked: false,
    };
    let old = player.composition_frame(&bounds, true).unwrap();
    old.active.store(true, Ordering::Release);
    player.hide();
    assert!(!old.active.load(Ordering::Acquire));
    assert!(player.composition_frame(&bounds, false).is_none());
    assert!(
        player.composition_frame(&bounds, true).is_some(),
        "hide retains current media snapshot"
    );

    static CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    unsafe extern "C" fn forbidden_string(_: Handle, _: *const c_char) -> *mut c_char {
        CALLS.fetch_add(1, Ordering::Relaxed);
        ptr::null_mut()
    }
    unsafe extern "C" fn forbidden_get(_: Handle, _: *const c_char, _: i32, _: *mut c_void) -> i32 {
        CALLS.fetch_add(1, Ordering::Relaxed);
        -10
    }
    unsafe extern "C" fn forbidden_acquire(_: Handle, _: *mut *mut c_void) -> i32 {
        CALLS.fetch_add(1, Ordering::Relaxed);
        -10
    }
    unsafe extern "C" fn failed_acquire(_: Handle, _: *mut *mut c_void) -> i32 {
        -3
    }
    let original = (player.get_string, player.get, player.composition);
    player.get_string = forbidden_string;
    player.get = forbidden_get;
    player.composition = Some(forbidden_acquire);
    CALLS.store(0, Ordering::Relaxed);
    for width in 160..400 {
        let mut next = bounds.clone();
        next.width = width as f64;
        let frame = player.composition_frame(&next, true).unwrap();
        assert_eq!(frame.viewport[2], width);
        assert_eq!(frame.content_aspect, 16. / 9.);
        assert!(!Arc::ptr_eq(&frame.active, &old.active));
    }
    assert_eq!(
        CALLS.load(Ordering::Relaxed),
        0,
        "geometry-only frames must never enter mpv"
    );
    (player.get_string, player.get, player.composition) = original;

    // Exercise the real drain with a valid live VO, including a batch cap whose
    // unseen trailing END_FILE must supersede all earlier reconfig events.
    let wait = player.wait;
    player.wait = queued_event;
    queue_events([8, 17, 7]);
    player.drain_events();
    assert!(player.composition_frame(&bounds, true).is_none());
    queue_events([7, 6, 8, 17]);
    player.drain_events();
    assert!(player.composition_frame(&bounds, true).is_some());
    queue_events([8, 6]);
    player.drain_events();
    assert!(player.composition_frame(&bounds, true).is_none());
    queue_events([17]);
    player.drain_events();
    assert!(player.composition_frame(&bounds, true).is_some());
    player.get_string = forbidden_string;
    player.get = forbidden_get;
    player.composition = Some(forbidden_acquire);
    CALLS.store(0, Ordering::Relaxed);
    queue_events(std::iter::repeat_n(17, 128).chain([7]));
    player.drain_events();
    assert_eq!(
        CALLS.load(Ordering::Relaxed),
        0,
        "partial drain must defer refresh"
    );
    player.drain_events();
    assert!(player.composition_frame(&bounds, true).is_none());
    assert_eq!(
        CALLS.load(Ordering::Relaxed),
        0,
        "trailing END_FILE cancels stale refresh"
    );
    (player.get_string, player.get, player.composition) = original;
    queue_events([17]);
    player.drain_events();
    let before_overflow = player.composition_frame(&bounds, true).unwrap();
    before_overflow.active.store(true, Ordering::Release);
    queue_events([24]);
    player.drain_events();
    assert!(!before_overflow.active.load(Ordering::Acquire));
    assert!(
        player.composition_frame(&bounds, true).is_some(),
        "overflow repairs current media"
    );
    player.composition = Some(forbidden_acquire);
    queue_events([17]);
    player.drain_events();
    assert!(player.composition_frame(&bounds, true).is_none());
    assert!(player.video_snapshot.lock().unwrap().dirty);
    player.composition = original.2;
    player.drain_events();
    assert!(
        player.composition_frame(&bounds, true).is_some(),
        "unavailable VO retries on the existing poll without another event"
    );
    player.composition = Some(failed_acquire);
    queue_events([8]);
    player.drain_events();
    assert!(player.composition_frame(&bounds, true).is_none());
    assert!(player.video_snapshot.lock().unwrap().dirty);
    player.composition = original.2;
    player.drain_events();
    assert!(
        player.composition_frame(&bounds, true).is_some(),
        "acquisition error cannot leave stale content or strand a loaded same-aspect source"
    );
    player.wait = wait;

    player.set("video-rotate", "90").unwrap();
    wait_snapshot(&player, Some(9. / 16.));
    player.set("video-rotate", "270").unwrap();
    wait_snapshot(&player, Some(9. / 16.));
    player.set("video-rotate", "0").unwrap();
    wait_snapshot(&player, Some(16. / 9.));
    player.set("video-aspect-override", "2").unwrap();
    wait_snapshot(&player, Some(2.));
    player.set("video-aspect-override", "-1").unwrap();
    wait_snapshot(&player, Some(16. / 9.));
    player.set("video-crop", "16x18+0+0").unwrap();
    wait_snapshot(&player, Some(8. / 9.));
    player.set("video-crop", "").unwrap();
    wait_snapshot(&player, Some(16. / 9.));

    player.set("ab-loop-a", "0").unwrap();
    player.set("ab-loop-b", "0.2").unwrap();
    player.set("pause", "no").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut loops = 0;
    while loops < 3 {
        let (_, _, events) = player.drain_events();
        loops += events
            .iter()
            .filter(|e| matches!(e, SeekEvent::Started))
            .count();
        assert!(player.composition_frame(&bounds, true).is_some());
        assert!(Instant::now() < deadline, "native loop did not repeat");
        std::thread::sleep(Duration::from_millis(5));
    }
    player.set("pause", "yes").unwrap();
    player.command(&["stop"]).unwrap();
    assert!(player.composition_frame(&bounds, true).is_none());
    old.surface.validate_reference().unwrap();
    player.set("vo", "null").unwrap();
    player.set("vo", "gpu-next").unwrap();
    player
        .command(&["loadfile", path.to_str().unwrap()])
        .unwrap();
    assert!(player.composition_frame(&bounds, true).is_none());
    wait_snapshot(&player, Some(16. / 9.));
    player.set("vid", "no").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        player.drain_events();
        if player.composition_frame(&bounds, true).is_none() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "audio/idle placeholder retained video snapshot"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    player.set("vid", "auto").unwrap();
    wait_snapshot(&player, Some(16. / 9.));
    let audio_path = fixture.path().join("audio.wav");
    let samples = 16_000u32;
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + samples * 2).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&8_000u32.to_le_bytes());
    wav.extend_from_slice(&16_000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(samples * 2).to_le_bytes());
    wav.resize(44 + samples as usize * 2, 0);
    std::fs::write(&audio_path, wav).unwrap();
    player
        .command(&["loadfile", audio_path.to_str().unwrap()])
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (loaded, error, _) = player.drain_events();
        assert!(error.is_none());
        assert!(
            player.composition_frame(&bounds, true).is_none(),
            "audio-only force-window must not resurrect old video"
        );
        if loaded {
            break;
        }
        assert!(Instant::now() < deadline, "audio-only file did not load");
        std::thread::sleep(Duration::from_millis(5));
    }
    player
        .command(&["loadfile", path.to_str().unwrap()])
        .unwrap();
    wait_snapshot(&player, Some(16. / 9.));
    player.command(&["stop"]).unwrap();
    player.drain_events();
    assert!(player.composition_frame(&bounds, true).is_none());
}

/// Exercises the packaged bridge itself, not the unsafe public raw property.
#[test]
#[ignore = "requires prepared patched native resources and a D3D11 adapter"]
fn owned_composition_swapchain_survives_stop_reconfigure_and_player_destruction() {
    let resources = std::env::var_os("SURTITLE_RESOURCE_DIR").expect("SURTITLE_RESOURCE_DIR");
    let path = Path::new(&resources).join("native/mpv-2.dll");
    let library: Library = unsafe {
        libloading::os::windows::Library::load_with_flags(
            &path,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
        .unwrap()
        .into()
    };
    let library = Arc::new(library);
    let weak_library = Arc::downgrade(&library);
    unsafe {
        let create: Create = *library.get(b"mpv_create\0").unwrap();
        let initialize: Init = *library.get(b"mpv_initialize\0").unwrap();
        let option: Set = *library.get(b"mpv_set_option_string\0").unwrap();
        let property: Set = *library.get(b"mpv_set_property_string\0").unwrap();
        let command: Command = *library.get(b"mpv_command\0").unwrap();
        let destroy: Destroy = *library.get(b"mpv_terminate_destroy\0").unwrap();
        let wait: Wait = *library.get(b"mpv_wait_event\0").unwrap();
        let acquire: AcquireSwapChain = *library
            .get(b"mpv_surtitle_acquire_d3d11_swapchain\0")
            .unwrap();
        let handle = create();
        assert!(!handle.is_null());
        struct PlayerGuard(Handle, Destroy);
        impl Drop for PlayerGuard {
            fn drop(&mut self) {
                unsafe { (self.1)(self.0) }
            }
        }
        let player = PlayerGuard(handle, destroy);
        for (key, value) in [
            ("config", "no"),
            ("load-scripts", "no"),
            ("ao", "null"),
            ("vo", "gpu-next"),
            ("gpu-api", "d3d11"),
            ("gpu-context", "d3d11"),
            ("hwdec", "no"),
            ("d3d11-output-mode", "composition"),
            ("d3d11-composition-size", "160x90"),
            ("idle", "yes"),
            ("keep-open", "yes"),
            ("pause", "yes"),
        ] {
            assert!(
                accepts_mpv_option_result(
                    key,
                    value,
                    option(
                        handle,
                        CString::new(key).unwrap().as_ptr(),
                        CString::new(value).unwrap().as_ptr()
                    )
                ),
                "{key}"
            );
        }
        assert!(initialize(handle) >= 0);
        let run = |arguments: &[&str]| {
            let values: Vec<_> = arguments
                .iter()
                .map(|v| CString::new(*v).unwrap())
                .collect();
            let mut pointers: Vec<_> = values.iter().map(|v| v.as_ptr()).collect();
            pointers.push(ptr::null());
            assert!(command(handle, pointers.as_ptr()) >= 0, "{arguments:?}");
        };
        // A tiny raw Y4M input needs no encoder, network, or external fixture.
        let fixture = tempfile::tempdir().unwrap();
        let video_path = fixture.path().join("bridge-lifetime.y4m");
        let mut video = b"YUV4MPEG2 W32 H18 F30:1 Ip A1:1 C420jpeg\n".to_vec();
        for _ in 0..4 {
            video.extend_from_slice(b"FRAME\n");
            video.extend(std::iter::repeat_n(128u8, 32 * 18 * 3 / 2));
        }
        std::fs::write(&video_path, video).unwrap();
        let acquire_ready = || {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let mut pointer = ptr::null_mut();
                let result = acquire(handle, &mut pointer);
                if result == 0 {
                    let identity = pointer as usize;
                    let owned = gpui_windows::CompositionSwapChain::from_owned_raw(
                        pointer,
                        library.clone(),
                        [160, 90],
                    )
                    .unwrap();
                    return (identity, owned);
                }
                assert!(pointer.is_null());
                assert_eq!(result, -10);
                assert!(
                    Instant::now() < deadline,
                    "composition VO never became ready"
                );
                wait(handle, 0.01);
            }
        };
        run(&["loadfile", video_path.to_str().unwrap()]);
        let (first_identity, first) = acquire_ready();
        first.validate_reference().unwrap();
        run(&["stop"]);
        first.validate_reference().unwrap();
        // Force VO recreation while retaining the previously acquired object.
        assert!(property(handle, c"vo".as_ptr(), c"null".as_ptr()) >= 0);
        assert!(property(handle, c"vo".as_ptr(), c"gpu-next".as_ptr()) >= 0);
        run(&["loadfile", video_path.to_str().unwrap()]);
        let (second_identity, second) = acquire_ready();
        assert_ne!(
            first_identity, second_identity,
            "VO recreation must rebind a fresh live swapchain while the previous owned reference stays valid"
        );
        second.validate_reference().unwrap();
        run(&["stop"]);
        drop(player);
        first.validate_reference().unwrap();
        second.validate_reference().unwrap();
        drop(library);
        assert!(
            weak_library.upgrade().is_some(),
            "COM owners retain the native library"
        );
        drop(first);
        drop(second);
        assert!(
            weak_library.upgrade().is_none(),
            "last COM owner releases the native library"
        );
    }
}
