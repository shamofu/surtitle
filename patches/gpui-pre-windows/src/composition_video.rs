//! Video placement and its matching GPUI pixels in one DComp transaction.
use super::*;

/// One owned reference to a composition swapchain, never a borrowed mpv property.
#[derive(Clone)]
pub struct CompositionSwapChain {
    pub(crate) chain: IDXGISwapChain1,
    // The producer's fixed composition-size option, never queried concurrently
    // with its immediate context through DXGI GetDesc1.
    pub(crate) backing: [u32; 2],
    // Fields drop in declaration order: release COM before its native library.
    pub(crate) _lifetime: Arc<dyn std::any::Any + Send + Sync>,
}
impl CompositionSwapChain {
    /// QueryInterface is explicitly safe alongside DXGI presentation. This
    /// validates the owned reference without touching producer-thread state.
    pub fn validate_reference(&self) -> Result<()> {
        let _: IDXGISwapChain1 = self.chain.cast()?;
        Ok(())
    }
    /// Adopt the reference returned by the pinned native acquisition bridge.
    /// `backing` is the producer's configured composition size and must remain
    /// fixed while this wrapper is used; descriptor reads belong to the producer.
    ///
    /// # Safety
    /// `pointer` must be a live IDXGISwapChain1 pointer with one reference owned
    /// by the caller. This function consumes that reference, including on error.
    pub unsafe fn from_owned_raw(
        pointer: *mut std::ffi::c_void,
        lifetime: Arc<dyn std::any::Any + Send + Sync>,
        backing: [u32; 2],
    ) -> Result<Self> {
        anyhow::ensure!(!pointer.is_null(), "missing owned composition swapchain");
        let chain = unsafe { IDXGISwapChain1::from_raw(pointer) };
        anyhow::ensure!(backing[0] > 0 && backing[1] > 0, "empty video swapchain");
        let result = Self {
            chain,
            backing,
            _lifetime: lifetime,
        };
        result.validate_reference()?;
        Ok(result)
    }
}

#[derive(Clone)]
pub struct CompositionVideoFrame {
    pub surface: CompositionSwapChain,
    /// Original video viewport, in physical parent-client pixels.
    pub viewport: [i32; 4],
    /// Post-filter, pixel-aspect-corrected and oriented media aspect.
    pub content_aspect: f64,
    pub clip: Option<[i32; 4]>,
    /// Invalidated by a retired/hidden playback generation, including off the
    /// GUI thread. Never reuse a retired lease for a subsequent generation.
    pub active: Arc<std::sync::atomic::AtomicBool>,
}

struct UiSurface {
    surface: IDCompositionSurface,
    width: u32,
    height: u32,
}

pub(super) struct VideoComposition {
    root: IDCompositionVisual,
    clip: IDCompositionVisual,
    video: IDCompositionVisual,
    ui: IDCompositionVisual,
    clip_shape: IDCompositionRectangleClip,
    scale: IDCompositionScaleTransform,
    surface: Option<UiSurface>,
    pub(super) frame: Option<CompositionVideoFrame>,
    // Staging a replacement must not release the native-library lifetime of
    // content still retained by the published composition graph.
    published: Option<CompositionVideoFrame>,
    // SetContent can succeed before a later mutation/Commit fails. Keep that
    // queued reference's owner until SetContent replaces it or Commit succeeds.
    pending: Option<CompositionVideoFrame>,
}
impl VideoComposition {
    pub(super) fn new(device: &IDCompositionDevice) -> Result<Self> {
        unsafe {
            let root = device.CreateVisual()?;
            let clip = device.CreateVisual()?;
            let video = device.CreateVisual()?;
            let ui = device.CreateVisual()?;
            let clip_shape = device.CreateRectangleClip()?;
            let scale = device.CreateScaleTransform()?;
            clip.AddVisual(&video, false, None)?;
            root.AddVisual(&clip, false, None)?;
            root.AddVisual(&ui, true, None)?;
            Ok(Self {
                root,
                clip,
                video,
                ui,
                clip_shape,
                scale,
                surface: None,
                frame: None,
                published: None,
                pending: None,
            })
        }
    }

    pub(super) fn present(
        &mut self,
        composition: &IDCompositionDevice,
        target: &IDCompositionTarget,
        devices: &DirectXRendererDevices,
        source: &ID3D11Texture2D,
        width: u32,
        height: u32,
    ) -> Result<()> {
        let submitted = self
            .frame
            .as_ref()
            .filter(|frame| frame.active.load(std::sync::atomic::Ordering::Acquire))
            .cloned();
        // Nonvirtual surfaces are fixed-size. Keep the currently displayed
        // surface alive until a completely initialized replacement is committed.
        let candidate = if self
            .surface
            .as_ref()
            .is_none_or(|s| s.width != width || s.height != height)
        {
            Some(UiSurface {
                surface: unsafe {
                    composition.CreateSurface(
                        width,
                        height,
                        RENDER_TARGET_FORMAT,
                        DXGI_ALPHA_MODE_PREMULTIPLIED,
                    )
                }?,
                width,
                height,
            })
        } else {
            None
        };
        let surface = &candidate
            .as_ref()
            .or(self.surface.as_ref())
            .unwrap()
            .surface;
        copy_scene(surface, devices, source, width, height)?;
        // Every submission reasserts the entire matching state. A failed Commit
        // has no discard API; no helper may publish a partial pending transaction.
        unsafe {
            self.ui.SetContent(surface)?;
            if let Some(frame) = &submitted {
                let (scale, x, y) =
                    fit_video(frame.viewport, frame.surface.backing, frame.content_aspect)?;
                self.scale.SetScaleX2(scale)?;
                self.scale.SetScaleY2(scale)?;
                self.video.SetTransform(&self.scale)?;
                self.video.SetOffsetX2(x)?;
                self.video.SetOffsetY2(y)?;
                self.video.SetContent(&frame.surface.chain)?;
                self.pending = Some(frame.clone());
                let [left, top, width, height] = intersect_clip(frame.viewport, frame.clip);
                self.clip_shape.SetLeft2(left as f32)?;
                self.clip_shape.SetTop2(top as f32)?;
                self.clip_shape.SetRight2((left + width) as f32)?;
                self.clip_shape.SetBottom2((top + height) as f32)?;
                self.clip.SetClip(&self.clip_shape)?;
            } else {
                self.video.SetContent(None)?;
                self.pending = None;
            }
            target.SetRoot(&self.root)?;
            composition.Commit()?;
        }
        if let Some(candidate) = candidate {
            self.surface = Some(candidate);
        }
        self.published = self.pending.take();
        Ok(())
    }
}

fn copy_scene(
    surface: &IDCompositionSurface,
    devices: &DirectXRendererDevices,
    source: &ID3D11Texture2D,
    width: u32,
    height: u32,
) -> Result<()> {
    unsafe {
        let mut offset = POINT::default();
        let drawing: IDXGISurface = surface.BeginDraw(None, &mut offset)?;
        let copied = (|| -> Result<()> {
            let texture: ID3D11Texture2D = drawing.cast()?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut desc);
            anyhow::ensure!(
                offset.x >= 0
                    && offset.y >= 0
                    && offset.x as u64 + width as u64 <= desc.Width as u64
                    && offset.y as u64 + height as u64 <= desc.Height as u64
                    && desc.Format == RENDER_TARGET_FORMAT,
                "invalid DirectComposition update allocation"
            );
            devices.device_context.OMSetRenderTargets(None, None);
            let region = D3D11_BOX {
                left: 0,
                top: 0,
                front: 0,
                right: width,
                bottom: height,
                back: 1,
            };
            devices.device_context.CopySubresourceRegion(
                &texture,
                0,
                offset.x as u32,
                offset.y as u32,
                0,
                source,
                0,
                Some(&region),
            );
            Ok(())
        })();
        // Even a validation/copy setup error must release the BeginDraw session.
        let ended = surface.EndDraw();
        copied?;
        ended?;
    }
    Ok(())
}

fn fit_video(viewport: [i32; 4], backing: [u32; 2], aspect: f64) -> Result<(f32, f32, f32)> {
    let [left, top, width, height] = viewport;
    anyhow::ensure!(
        width > 0
            && height > 0
            && backing[0] > 0
            && backing[1] > 0
            && aspect.is_finite()
            && aspect > 0.,
        "invalid composition video geometry"
    );
    let (bw, bh) = (backing[0] as f64, backing[1] as f64);
    let content = if bw / bh > aspect {
        [bh * aspect, bh]
    } else {
        [bw, bw / aspect]
    };
    let scale = (width as f64 / content[0]).min(height as f64 / content[1]);
    Ok((
        scale as f32,
        (left as f64 + width as f64 * 0.5 - bw * scale * 0.5) as f32,
        (top as f64 + height as f64 * 0.5 - bh * scale * 0.5) as f32,
    ))
}

fn intersect_clip(viewport: [i32; 4], clip: Option<[i32; 4]>) -> [i32; 4] {
    let Some(clip) = clip else {
        return viewport;
    };
    let left = viewport[0].max(clip[0]);
    let top = viewport[1].max(clip[1]);
    [
        left,
        top,
        (viewport[0] + viewport[2])
            .min(clip[0] + clip[2])
            .saturating_sub(left)
            .max(0),
        (viewport[1] + viewport[3])
            .min(clip[1] + clip[3])
            .saturating_sub(top)
            .max(0),
    ]
}
