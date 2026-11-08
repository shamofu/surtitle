//! Real DWM pixels, rather than offscreen GPUI readback, verify publication.
use super::*;
use std::{
    collections::BTreeSet,
    fs::File,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Graphics::{Dwm::DwmFlush, Gdi::ClientToScreen},
        System::Com::*,
        UI::{HiDpi::*, WindowsAndMessaging::*},
    },
    core::w,
};

const WIDTH: u32 = 320;
const HEIGHT: u32 = 160;
const VIDEO_WIDTH: u32 = 160;
const VIDEO_HEIGHT: u32 = 90;

struct TestWindow {
    hwnd: HWND,
    previous_dpi: DPI_AWARENESS_CONTEXT,
}
impl TestWindow {
    fn new(x: i32, y: i32, visible: bool) -> Self {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            let previous_dpi =
                SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let hwnd = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
                w!("STATIC"),
                w!("Owned composition pixel regression"),
                WS_POPUP,
                x,
                y,
                WIDTH as i32,
                HEIGHT as i32,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            if visible {
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
            Self { hwnd, previous_dpi }
        }
    }
}
impl Drop for TestWindow {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.hwnd);
            // -1 is the valid UNAWARE context, despite the generic generated
            // handle helper classifying it as invalid.
            if !self.previous_dpi.0.is_null() {
                SetThreadDpiAwarenessContext(self.previous_dpi);
            }
            CoUninitialize();
        }
    }
}

fn video_chain(devices: &DirectXDevices) -> IDXGISwapChain1 {
    let chain = create_swap_chain_for_composition(
        &devices.dxgi_factory,
        &devices.device,
        VIDEO_WIDTH,
        VIDEO_HEIGHT,
    )
    .unwrap();
    // Static source pixels keep content-Present timing out of the placement
    // oracle. The stable centerline moves only with the composition visual.
    let mut pixels = vec![0u8; (VIDEO_WIDTH * VIDEO_HEIGHT * 4) as usize];
    for y in 0..VIDEO_HEIGHT {
        for x in 0..VIDEO_WIDTH {
            let color = if (78..82).contains(&x) {
                [255, 255, 255, 255]
            } else if x < 4 || x >= VIDEO_WIDTH - 4 {
                [0, 0, 255, 255]
            } else {
                [0, 200, 0, 255]
            };
            let i = ((y * VIDEO_WIDTH + x) * 4) as usize;
            pixels[i..i + 4].copy_from_slice(&color);
        }
    }
    unsafe {
        let buffer: ID3D11Texture2D = chain.GetBuffer(0).unwrap();
        devices.device_context.UpdateSubresource(
            &buffer,
            0,
            None,
            pixels.as_ptr().cast(),
            VIDEO_WIDTH * 4,
            0,
        );
        chain.Present(0, DXGI_PRESENT(0)).ok().unwrap();
    }
    chain
}

fn scene(viewport_width: i32) -> Scene {
    let rect = |x, y, width, height| {
        Bounds::new(
            point(ScaledPixels(x), ScaledPixels(y)),
            size(ScaledPixels(width), ScaledPixels(height)),
        )
    };
    let full = rect(0., 0., WIDTH as f32, HEIGHT as f32);
    let mut scene = Scene::default();
    let mut quad = |bounds, color| {
        scene.insert_primitive(Quad {
            bounds,
            content_mask: ContentMask { bounds: full },
            background: color,
            ..Default::default()
        });
    };
    quad(full, hsla(2. / 3., 1., 0.2, 1.).into());
    // Ownership sentinels survive every pose and are outside every aperture.
    for bounds in [
        rect(0., 0., WIDTH as f32, 4.),
        rect(0., 156., WIDTH as f32, 4.),
        rect(0., 0., 4., HEIGHT as f32),
        rect(316., 0., 4., HEIGHT as f32),
    ] {
        quad(bounds, hsla(5. / 6., 1., 0.5, 1.).into());
    }
    quad(
        rect((8 + viewport_width / 2 - 2) as f32, 114., 4., 12.),
        hsla(0., 0., 1., 1.).into(),
    );
    scene.insert_primitive(NativeAperture {
        order: 0,
        bounds: rect(8., 16., viewport_width as f32, VIDEO_HEIGHT as f32),
        content_mask: ContentMask { bounds: full },
    });
    scene.finish();
    scene
}

fn frame(chain: &IDXGISwapChain1, width: i32) -> CompositionVideoFrame {
    CompositionVideoFrame {
        surface: CompositionSwapChain {
            chain: chain.clone(),
            backing: [VIDEO_WIDTH, VIDEO_HEIGHT],
            _lifetime: Arc::new(()),
        },
        viewport: [8, 16, width, VIDEO_HEIGHT as i32],
        content_aspect: VIDEO_WIDTH as f64 / VIDEO_HEIGHT as f64,
        clip: None,
        active: Arc::new(AtomicBool::new(true)),
    }
}

struct OwnedCapture {
    duplication: IDXGIOutputDuplication,
    staging: ID3D11Texture2D,
    region: D3D11_BOX,
    devices: DirectXDevices,
}
impl OwnedCapture {
    fn new(devices: &DirectXDevices, output: &IDXGIOutput1, hwnd: HWND) -> Self {
        let desc = unsafe { output.GetDesc() }.unwrap();
        assert_eq!(
            desc.Rotation, DXGI_MODE_ROTATION_IDENTITY,
            "pixel test requires an unrotated output"
        );
        let mut origin = POINT::default();
        unsafe { ClientToScreen(hwnd, &mut origin).ok().unwrap() };
        let x = origin.x - desc.DesktopCoordinates.left;
        let y = origin.y - desc.DesktopCoordinates.top;
        assert!(x >= 0 && y >= 0);
        let region = D3D11_BOX {
            left: x as u32,
            top: y as u32,
            front: 0,
            right: x as u32 + WIDTH,
            bottom: y as u32 + HEIGHT,
            back: 1,
        };
        let duplication = unsafe { output.DuplicateOutput(&devices.device) }.unwrap();
        let desc = D3D11_TEXTURE2D_DESC {
            Width: WIDTH,
            Height: HEIGHT,
            MipLevels: 1,
            ArraySize: 1,
            Format: RENDER_TARGET_FORMAT,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            ..Default::default()
        };
        let mut staging = None;
        unsafe {
            devices
                .device
                .CreateTexture2D(&desc, None, Some(&mut staging))
        }
        .unwrap();
        Self {
            duplication,
            staging: staging.unwrap(),
            region,
            devices: devices.clone(),
        }
    }

    fn next(&self, timeout: u32) -> Option<image::RgbaImage> {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource = None;
        match unsafe {
            self.duplication
                .AcquireNextFrame(timeout, &mut info, &mut resource)
        } {
            Ok(()) => {}
            Err(error) if error.code() == DXGI_ERROR_WAIT_TIMEOUT => return None,
            Err(error) => panic!("owned output acquisition: {error}"),
        }
        // Never map, inspect, save, or log the rest of the desktop. Only the
        // known test HWND's client pixels are copied into CPU-readable storage.
        let result = (|| -> Result<image::RgbaImage> {
            unsafe {
                let texture: ID3D11Texture2D = resource.unwrap().cast()?;
                self.devices.device_context.CopySubresourceRegion(
                    &self.staging,
                    0,
                    0,
                    0,
                    0,
                    &texture,
                    0,
                    Some(&self.region),
                );
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                self.devices.device_context.Map(
                    &self.staging,
                    0,
                    D3D11_MAP_READ,
                    0,
                    Some(&mut mapped),
                )?;
                let mut pixels = vec![0; (WIDTH * HEIGHT * 4) as usize];
                for row in 0..HEIGHT as usize {
                    let src = (mapped.pData as *const u8).add(row * mapped.RowPitch as usize);
                    let dst = pixels.as_mut_ptr().add(row * WIDTH as usize * 4);
                    std::ptr::copy_nonoverlapping(src, dst, WIDTH as usize * 4);
                }
                self.devices.device_context.Unmap(&self.staging, 0);
                for pixel in pixels.chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                }
                Ok(image::RgbaImage::from_raw(WIDTH, HEIGHT, pixels).unwrap())
            }
        })();
        unsafe { self.duplication.ReleaseFrame() }.unwrap();
        Some(result.unwrap())
    }

    fn wait_owned(&self, expected_center: Option<i32>) -> image::RgbaImage {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Some(image) = self.next(50) {
                if !owned(&image) {
                    continue;
                }
                if expected_center.is_none_or(|x| center(&image, 120) == x) {
                    return image;
                }
            }
        }
        panic!("owned composition pixels did not arrive before deadline");
    }
}

fn owned(image: &image::RgbaImage) -> bool {
    [(2, 2), (317, 2), (2, 157), (317, 157)]
        .into_iter()
        .all(|(x, y)| {
            let p = image.get_pixel(x, y).0;
            p[0] > 240 && p[1] < 12 && p[2] > 240
        })
}
fn center(image: &image::RgbaImage, y: u32) -> i32 {
    let xs: Vec<_> = (4..WIDTH - 4)
        .filter(|&x| {
            let p = image.get_pixel(x, y).0;
            p[0] > 240 && p[1] > 240 && p[2] > 240
        })
        .collect();
    assert!(!xs.is_empty(), "missing position marker at row{y}");
    (xs[0] + xs[xs.len() - 1] + 1) as i32 / 2
}
fn assert_coherent(image: &image::RgbaImage) -> i32 {
    assert!(
        owned(image),
        "test window ownership was lost; do not inspect other pixels"
    );
    let video = center(image, 60);
    let ui = center(image, 120);
    assert!(
        (video - ui).abs() <= 1,
        "video/UI composed marker centers differ: video{video}, UI{ui}"
    );
    // Stable source width/aspect and opaque letterboxes, at every captured pose.
    let colored: Vec<_> = (4..WIDTH - 4)
        .filter(|&x| {
            let p = image.get_pixel(x, 60).0;
            p[0] > 150 || p[1] > 150
        })
        .collect();
    assert_eq!(
        colored.last().unwrap() - colored.first().unwrap() + 1,
        VIDEO_WIDTH
    );
    let ys: Vec<_> = (4..110)
        .filter(|&y| {
            let p = image.get_pixel(video as u32, y).0;
            p[0] > 150 || p[1] > 150
        })
        .collect();
    assert_eq!(ys.first(), Some(&16), "video top must remain fixed");
    assert_eq!(ys.last(), Some(&105), "video bottom must remain fixed");
    assert_eq!(ys.len(), VIDEO_HEIGHT as usize);
    for x in 10..(ui - VIDEO_WIDTH as i32 / 2 - 2).max(10) as u32 {
        let p = image.get_pixel(x, 60).0;
        assert!(
            p[0] < 8 && p[1] < 8 && p[2] < 8,
            "letterbox must stay opaque black"
        );
    }
    ui
}

#[::core::prelude::v1::test]
fn shared_transaction_keeps_video_and_ui_markers_together_in_dwm_pixels() {
    const CHILD: &str = "GPUI_COMPOSITION_PIXEL_CHILD";
    if std::env::var_os(CHILD).is_some() {
        run_composed_pixels();
        return;
    }
    let log = std::env::temp_dir().join(format!(
        "gpui-composition-pixels-{}.log",
        std::process::id()
    ));
    let output = File::create(&log).unwrap();
    let mut child=Command::new(std::env::current_exe().unwrap())
        .args(["--exact","directx_renderer::composition_video_tests::shared_transaction_keeps_video_and_ui_markers_together_in_dwm_pixels","--nocapture"])
        .env(CHILD,"1").stdout(Stdio::from(output.try_clone().unwrap())).stderr(Stdio::from(output)).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let _ = child.wait();
            panic!("owned compositor pixel test timed out; {}", log.display());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let child_log = std::fs::read_to_string(log).unwrap();
    assert!(
        status.success(),
        "owned compositor pixel test failed: {status}\n{}",
        child_log
    );
    eprintln!("{child_log}");
}

fn run_composed_pixels() {
    let devices = DirectXDevices::new().unwrap();
    let output: IDXGIOutput1 = unsafe { devices.adapter.EnumOutputs(0) }
        .unwrap()
        .cast()
        .unwrap();
    let output_desc = unsafe { output.GetDesc() }.unwrap();
    assert!(
        output_desc.AttachedToDesktop.as_bool(),
        "pixel regression requires an interactive desktop"
    );
    assert!(
        output_desc.DesktopCoordinates.right - output_desc.DesktopCoordinates.left
            > WIDTH as i32 + 64
    );
    assert!(
        output_desc.DesktopCoordinates.bottom - output_desc.DesktopCoordinates.top
            > HEIGHT as i32 + 64
    );
    let window = TestWindow::new(
        output_desc.DesktopCoordinates.left + 32,
        output_desc.DesktopCoordinates.top + 32,
        true,
    );
    let mut renderer = DirectXRenderer::new(window.hwnd, &devices, false).unwrap();
    renderer
        .resize(size(
            DevicePixels(WIDTH as i32),
            DevicePixels(HEIGHT as i32),
        ))
        .unwrap();
    let chain = video_chain(&devices);
    let capture = OwnedCapture::new(&devices, &output, window.hwnd);

    // A real independently published baseline makes the oracle meaningful:
    // video moves in its own Commit while the UI swapchain still has old pixels.
    let composition = renderer.direct_composition.as_ref().unwrap();
    let root = unsafe { composition.comp_device.CreateVisual() }.unwrap();
    let video = unsafe { composition.comp_device.CreateVisual() }.unwrap();
    unsafe {
        // The legacy UI visual is currently a target root, so detach that
        // ownership before making it a child of the baseline's combined tree.
        composition.comp_target.SetRoot(None).unwrap();
        video.SetContent(&chain).unwrap();
        video.SetOffsetX2(28.).unwrap();
        video.SetOffsetY2(16.).unwrap();
        root.AddVisual(&video, false, None).unwrap();
        root.AddVisual(&composition.comp_visual, true, None)
            .unwrap();
        composition.comp_target.SetRoot(&root).unwrap();
        composition.comp_device.Commit().unwrap();
    }
    assert!(
        renderer
            .render_frame(&scene(200), WindowBackgroundAppearance::Opaque)
            .unwrap()
    );
    renderer.present().unwrap();
    unsafe { DwmFlush() }.unwrap();
    let initial = capture.wait_owned(Some(108));
    assert_eq!(assert_coherent(&initial), 108);
    unsafe {
        video.SetOffsetX2(68.).unwrap();
        renderer
            .direct_composition
            .as_ref()
            .unwrap()
            .comp_device
            .Commit()
            .unwrap();
        DwmFlush().unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut split_error = None;
    while Instant::now() < deadline {
        if let Some(image) = capture.next(50) {
            assert!(owned(&image), "owned baseline was obscured");
            let error = center(&image, 60) - center(&image, 120);
            if error.abs() >= 30 {
                split_error = Some(error);
                break;
            }
        }
    }
    assert!(
        split_error.is_some(),
        "pixel oracle must reproduce independent-publication center mismatch"
    );

    // Finish the intentionally split baseline and drain it before evaluating
    // the shared path. No first-frame exception is allowed in the real test.
    assert!(
        renderer
            .render_frame(&scene(280), WindowBackgroundAppearance::Opaque)
            .unwrap()
    );
    renderer.present().unwrap();
    unsafe { DwmFlush() }.unwrap();
    assert_eq!(assert_coherent(&capture.wait_owned(Some(148))), 148);

    let mut poses = BTreeSet::new();
    let mut samples = 0;
    let widths = [280, 200, 264, 184, 248, 216, 288, 192];
    for width in widths.into_iter().cycle().take(64) {
        renderer
            .stage_composition_video(Some(frame(&chain, width)))
            .unwrap();
        assert!(
            renderer
                .render_frame(&scene(width), WindowBackgroundAppearance::Opaque)
                .unwrap()
        );
        renderer.present().unwrap();
        if let Some(image) = capture.next(25) {
            poses.insert(assert_coherent(&image));
            samples += 1;
        }
    }
    assert!(
        samples >= 24,
        "too few actual compositor frames sampled: {samples}"
    );
    assert!(
        poses.len() >= 6,
        "moving-frame assertion was vacuous: {poses:?}"
    );
    eprintln!(
        "owned DWM samples={samples}; distinct coherent centers={poses:?}; independent baseline center mismatch={split_error:?}px"
    );
}

#[::core::prelude::v1::test]
fn published_video_keeps_native_lifetime_until_detach_commit_or_target_retirement() {
    struct Lifetime(Arc<AtomicUsize>);
    impl Drop for Lifetime {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    for retirement in ["detach Commit", "target retirement", "lease invalidation"] {
        let window = TestWindow::new(0, 0, false);
        let devices = DirectXDevices::new().unwrap();
        let mut renderer = DirectXRenderer::new(window.hwnd, &devices, false).unwrap();
        renderer
            .resize(size(
                DevicePixels(WIDTH as i32),
                DevicePixels(HEIGHT as i32),
            ))
            .unwrap();
        let chain = video_chain(&devices);
        let dropped = Arc::new(AtomicUsize::new(0));
        let mut video = frame(&chain, 200);
        let active = video.active.clone();
        video.surface._lifetime = Arc::new(Lifetime(dropped.clone()));
        renderer.stage_composition_video(Some(video)).unwrap();
        assert!(
            renderer
                .render_frame(&scene(200), WindowBackgroundAppearance::Opaque)
                .unwrap()
        );
        renderer.present().unwrap();
        if retirement == "lease invalidation" {
            active.store(false, Ordering::Release);
            assert!(
                renderer
                    .render_frame(&scene(200), WindowBackgroundAppearance::Opaque)
                    .unwrap()
            );
            renderer.present().unwrap();
            // Clearing the desired owner now releases the final reference only
            // if the inactive submission really retired its published owner.
            renderer.stage_composition_video(None).unwrap();
            assert_eq!(
                dropped.load(Ordering::SeqCst),
                1,
                "an invalidated lease must not remain published after Commit"
            );
            continue;
        }
        renderer.stage_composition_video(None).unwrap();
        assert_eq!(
            dropped.load(Ordering::SeqCst),
            0,
            "staging detach must retain published library lifetime"
        );
        if retirement == "detach Commit" {
            assert!(
                renderer
                    .render_frame(&scene(200), WindowBackgroundAppearance::Opaque)
                    .unwrap()
            );
            renderer.present().unwrap();
        } else {
            drop(renderer);
        }
        assert_eq!(
            dropped.load(Ordering::SeqCst),
            1,
            "successful detach Commit or target retirement releases lifetime"
        );
    }
}
