// SPDX-License-Identifier: GPL-3.0-or-later
// Optional diagnostic captures only the host's own HWND using public WinRT APIs.
use anyhow::{Context, Result};
use std::path::Path;
use windows::{
    core::{factory, Interface},
    Graphics::{
        Capture::*,
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Win32::{
        Foundation::HWND,
        Graphics::{Direct3D11::*, Dxgi::IDXGIDevice},
        System::WinRT::{
            Direct3D11::*, Graphics::Capture::IGraphicsCaptureItemInterop, RoInitialize,
            RO_INIT_SINGLETHREADED,
        },
    },
};

pub struct Capture {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
}
impl Capture {
    pub unsafe fn start(
        hwnd: HWND,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
    ) -> Result<Self> {
        RoInitialize(RO_INIT_SINGLETHREADED)?;
        let interop: IGraphicsCaptureItemInterop =
            factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd)?;
        let dxgi: IDXGIDevice = device.cast()?;
        let runtime_device: IDirect3DDevice =
            CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &runtime_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            item.Size()?,
        )?;
        let session = pool.CreateCaptureSession(&item)?;
        session.SetIsCursorCaptureEnabled(false)?;
        session.StartCapture()?;
        Ok(Self {
            pool,
            session,
            device: device.clone(),
            context: context.clone(),
        })
    }
    pub unsafe fn save_if_ready(&self, path: &Path) -> Result<bool> {
        let Ok(frame) = self.pool.TryGetNextFrame() else {
            return Ok(false);
        };
        let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
        let texture: ID3D11Texture2D = access.GetInterface()?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.MiscFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        let mut staging = None;
        self.device
            .CreateTexture2D(&desc, None, Some(&mut staging))?;
        let staging = staging.context("Capture staging texture")?;
        self.context.CopyResource(&staging, &texture);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        self.context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let size = frame.ContentSize()?;
        let mut ppm = format!("P6\n{} {}\n255\n", size.Width, size.Height).into_bytes();
        for y in 0..size.Height as usize {
            let row = std::slice::from_raw_parts(
                (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                size.Width as usize * 4,
            );
            for pixel in row.chunks_exact(4) {
                ppm.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
            }
        }
        self.context.Unmap(&staging, 0);
        frame.Close()?;
        std::fs::write(path, ppm)?;
        self.session.Close()?;
        self.pool.Close()?;
        Ok(true)
    }
}
