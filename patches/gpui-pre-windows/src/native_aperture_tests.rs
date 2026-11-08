use super::*;
use windows::{
    Win32::{System::Com::*, UI::WindowsAndMessaging::*},
    core::w,
};

#[::core::prelude::v1::test]
fn native_aperture_preserves_alpha_clip_and_later_overlay_on_both_gpu_paths() {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
    }
    struct NativeWindow(HWND);
    impl Drop for NativeWindow {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.0);
                CoUninitialize();
            }
        }
    }
    let hwnd = NativeWindow(unsafe {
        CreateWindowExW(
            Default::default(),
            w!("STATIC"),
            w!("aperture GPU regression"),
            WS_POPUP,
            0,
            0,
            64,
            64,
            None,
            None,
            None,
            None,
        )
        .unwrap()
    });
    let devices = DirectXDevices::new().unwrap();
    let mut renderer = DirectXRenderer::new(hwnd.0, &devices, false).unwrap();
    renderer
        .resize(size(DevicePixels(64), DevicePixels(64)))
        .unwrap();
    let rect = |x, y, width, height| {
        Bounds::new(
            point(ScaledPixels(x), ScaledPixels(y)),
            size(ScaledPixels(width), ScaledPixels(height)),
        )
    };
    let full = rect(0., 0., 64., 64.);
    let mut scene = Scene::default();
    scene.insert_primitive(Quad {
        bounds: full,
        content_mask: ContentMask { bounds: full },
        background: hsla(0., 1., 0.5, 1.).into(),
        ..Default::default()
    });
    scene.insert_primitive(NativeAperture {
        order: 0,
        bounds: rect(8., 8., 48., 48.),
        content_mask: ContentMask {
            bounds: rect(16., 12., 32., 36.),
        },
    });
    scene.insert_primitive(Quad {
        bounds: rect(28., 24., 12., 12.),
        content_mask: ContentMask { bounds: full },
        background: hsla(1. / 3., 1., 0.5, 1.).into(),
        ..Default::default()
    });
    scene.finish();
    let supported = renderer
        .devices
        .as_ref()
        .unwrap()
        .clear_view_context
        .is_some();
    eprintln!("native ClearView supported: {supported}; overwrite fallback always exercised");
    let hardware = renderer
        .render_to_image(&scene, WindowBackgroundAppearance::Opaque)
        .unwrap();
    renderer.devices.as_mut().unwrap().clear_view_context = None;
    let fallback = renderer
        .render_to_image(&scene, WindowBackgroundAppearance::Opaque)
        .unwrap();
    for pixels in [&hardware, &fallback] {
        assert_eq!(
            pixels.get_pixel(20, 20).0,
            [0, 0, 0, 0],
            "aperture erases existing opaque pixels"
        );
        assert_eq!(
            pixels.get_pixel(10, 20).0,
            [255, 0, 0, 255],
            "content mask clips aperture"
        );
        assert_eq!(
            pixels.get_pixel(32, 28).0,
            [0, 255, 0, 255],
            "later overlay remains opaque"
        );
    }
    assert_eq!(
        hardware, fallback,
        "ClearView and overwrite fallback must match"
    );
    assert!(
        renderer
            .direct_composition
            .as_ref()
            .unwrap()
            .native_backing
            .is_some()
    );
}
