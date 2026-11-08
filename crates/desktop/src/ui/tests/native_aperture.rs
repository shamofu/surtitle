// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use gpui_kit::{ContentMask, NativeAperture, Quad, ScaledPixels, Scene, canvas, fill, rgb};

const BEFORE: u32 = 0x132435;
const AFTER: u32 = 0x465768;
const OUTSIDE_LAYER: u32 = 0x798a9b;

struct ApertureCanvas;

impl Render for ApertureCanvas {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        canvas(
            |_, _, _| (),
            |_, _, window, _| {
                let bounds = Bounds::new(point(px(10.2), px(20.2)), size(px(100.4), px(80.6)));
                let clip = Bounds::new(point(px(15.3), px(25.1)), size(px(90.4), px(60.6)));
                window.with_content_mask(Some(ContentMask { bounds: clip }), |window| {
                    window.paint_layer(bounds, |window| {
                        window.paint_quad(fill(bounds, rgb(BEFORE)));
                        window.paint_native_aperture(bounds);
                        window.paint_quad(fill(bounds, rgb(AFTER)));
                    });
                    window.paint_quad(fill(bounds, rgb(OUTSIDE_LAYER)));
                });
            },
        )
        .size_full()
    }
}

fn coordinates(bounds: Bounds<ScaledPixels>) -> [f32; 4] {
    [
        bounds.left().0,
        bounds.top().0,
        bounds.right().0,
        bounds.bottom().0,
    ]
}

fn colored_quad(quads: &[Quad], color: u32) -> &Quad {
    quads
        .iter()
        .find(|quad| quad.background.as_solid() == Some(rgb(color).into()))
        .expect("painted marker quad")
}

#[gpui_kit::test]
fn native_aperture_canvas_keeps_clip_and_overlay_order_at_three_dpi_scales(
    cx: &mut TestAppContext,
) {
    let (_, visual) = cx.add_window_view(|_, _| ApertureCanvas);
    for (scale, bounds, clip) in [
        (1., [10., 20., 111., 101.], [15., 25., 106., 86.]),
        (1.25, [13., 25., 138., 126.], [19., 31., 133., 108.]),
        (1.5, [15., 30., 166., 151.], [22., 37., 159., 129.]),
    ] {
        visual.simulate_scale_factor_change(scale);
        visual.update(|window, app| {
            window.render_frame(app);
            assert_eq!(window.scale_factor(), scale);
            let apertures = window.painted_native_apertures();
            assert_eq!(apertures.len(), 1);
            let aperture = apertures[0];
            assert_eq!(coordinates(aperture.bounds), bounds);
            assert_eq!(coordinates(aperture.content_mask.bounds), clip);
            let quads = window.painted_quads();
            assert!(colored_quad(&quads, BEFORE).order < aperture.order);
            assert!(aperture.order < colored_quad(&quads, AFTER).order);
            assert!(colored_quad(&quads, AFTER).order < colored_quad(&quads, OUTSIDE_LAYER).order);
        });
    }
}

fn scaled_bounds(x: f32, y: f32, width: f32, height: f32) -> Bounds<ScaledPixels> {
    Bounds::new(
        point(ScaledPixels(x), ScaledPixels(y)),
        size(ScaledPixels(width), ScaledPixels(height)),
    )
}

fn quad(bounds: Bounds<ScaledPixels>, color: u32) -> Quad {
    Quad {
        bounds,
        content_mask: ContentMask { bounds },
        background: rgb(color).into(),
        ..Default::default()
    }
}

fn aperture(bounds: Bounds<ScaledPixels>) -> NativeAperture {
    NativeAperture {
        bounds,
        content_mask: ContentMask { bounds },
        ..Default::default()
    }
}

fn assert_scene_order(scene: &Scene) {
    assert_eq!(scene.native_apertures.len(), 1);
    let cutout = scene.native_apertures[0].order;
    let before = colored_quad(&scene.quads, BEFORE).order;
    let after = colored_quad(&scene.quads, AFTER).order;
    let outside = colored_quad(&scene.quads, OUTSIDE_LAYER).order;
    assert!(before < cutout && cutout < after && after < outside);
}

#[test]
fn native_aperture_cached_scene_replays_barriers_and_clear_resets_them() {
    let bounds = scaled_bounds(10., 20., 100., 80.);
    let mut source = Scene::default();
    source.push_layer(bounds);
    source.insert_primitive(quad(bounds, BEFORE));
    source.insert_primitive(aperture(bounds));
    source.insert_primitive(quad(bounds, AFTER));
    source.pop_layer();
    source.insert_primitive(quad(bounds, OUTSIDE_LAYER));
    source.finish();
    assert_scene_order(&source);

    let mut replay = Scene::default();
    replay.replay(0..source.len(), &source);
    replay.finish();
    assert_scene_order(&replay);
    assert_eq!(replay.len(), source.len());
    assert_eq!(replay.native_apertures[0].bounds, bounds);
    assert_eq!(replay.native_apertures[0].content_mask.bounds, bounds);

    replay.clear();
    assert_eq!(replay.len(), 0);
    assert!(replay.native_apertures.is_empty());
    replay.replay(0..source.len(), &source);
    replay.finish();
    assert_scene_order(&replay);
    assert_eq!(
        replay.native_apertures[0].order,
        source.native_apertures[0].order
    );
}

#[test]
fn native_aperture_barrier_preserves_later_relative_orders_and_ignores_empty_clip() {
    let bounds = scaled_bounds(10., 20., 100., 80.);
    let mut scene = Scene::default();
    scene.push_layer(bounds);
    scene.insert_primitive(quad(bounds, BEFORE));
    scene.insert_primitive(aperture(bounds));
    scene.pop_layer();
    scene.insert_primitive(quad(bounds, AFTER));
    scene.insert_primitive(quad(bounds, OUTSIDE_LAYER));
    scene.finish();
    assert_scene_order(&scene);
    assert_eq!(
        colored_quad(&scene.quads, OUTSIDE_LAYER).order,
        colored_quad(&scene.quads, AFTER).order + 1,
        "a barrier must offset raw overlap orders rather than collapse them to one floor"
    );

    scene.clear();
    scene.insert_primitive(quad(bounds, BEFORE));
    let mut empty = aperture(bounds);
    empty.content_mask.bounds = scaled_bounds(200., 200., 10., 10.);
    scene.insert_primitive(empty);
    scene.insert_primitive(quad(bounds, AFTER));
    scene.finish();
    let mut baseline = Scene::default();
    baseline.insert_primitive(quad(bounds, BEFORE));
    baseline.insert_primitive(quad(bounds, AFTER));
    baseline.finish();
    assert!(scene.native_apertures.is_empty());
    assert_eq!(scene.len(), baseline.len());
    assert_eq!(
        scene
            .quads
            .iter()
            .map(|quad| quad.order)
            .collect::<Vec<_>>(),
        baseline
            .quads
            .iter()
            .map(|quad| quad.order)
            .collect::<Vec<_>>()
    );
}
