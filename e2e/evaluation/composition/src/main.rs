// SPDX-License-Identifier: GPL-3.0-or-later
// Isolated feasibility prototype; not a replacement for Tauri's window backend.
use anyhow::{bail, Context, Result};
mod capture;
use std::{
    cell::RefCell,
    ffi::{c_char, c_void, CStr, CString},
    ptr,
    rc::Rc,
    sync::mpsc,
    time::{Duration, Instant},
};
use webview2_com::{Microsoft::Web::WebView2::Win32::*, *};
use windows::{
    core::{s, w, Interface, PCSTR, PCWSTR, PWSTR},
    Win32::{
        Foundation::*,
        Graphics::{
            Direct3D::*, Direct3D11::*, DirectComposition::*, Dxgi::Common::*, Dxgi::*, Gdi::*,
            OpenGL::*,
        },
        System::{Com::*, LibraryLoader::*},
        UI::{HiDpi::*, WindowsAndMessaging::*},
    },
};
thread_local! {static WEB:RefCell<Option<ICoreWebView2CompositionController>>=const{RefCell::new(None)};static RESIZE:RefCell<Option<(u32,u32)>>=const{RefCell::new(None)};}
unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_DESTROY {
        PostQuitMessage(0);
        return LRESULT(0);
    }
    if msg == WM_SIZE && w.0 != SIZE_MINIMIZED as usize {
        let width = l.0 as u16 as u32;
        let height = (l.0 >> 16) as u16 as u32;
        if width > 0 && height > 0 {
            RESIZE.with(|cell| *cell.borrow_mut() = Some((width, height)));
        }
    }
    if [
        WM_MOUSEMOVE,
        WM_LBUTTONDOWN,
        WM_LBUTTONUP,
        WM_RBUTTONDOWN,
        WM_RBUTTONUP,
        WM_MOUSEWHEEL,
    ]
    .contains(&msg)
    {
        WEB.with(|cell| {
            if let Some(web) = cell.borrow().as_ref() {
                if msg == WM_LBUTTONDOWN {
                    if let Ok(controller) = web.cast::<ICoreWebView2Controller>() {
                        let _ = controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                    }
                }
                let point = POINT {
                    x: l.0 as i16 as i32,
                    y: (l.0 >> 16) as i16 as i32,
                };
                let kind = COREWEBVIEW2_MOUSE_EVENT_KIND(msg as i32);
                let _ = web.SendMouseInput(
                    kind,
                    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS((w.0 & 0xffff) as i32),
                    0,
                    point,
                );
            }
        });
    }
    DefWindowProcW(hwnd, msg, w, l)
}
#[repr(C)]
struct Param {
    kind: i32,
    data: *mut c_void,
}
#[repr(C)]
struct Init {
    get_proc: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
    context: *mut c_void,
}
#[repr(C)]
struct Fbo {
    id: i32,
    width: i32,
    height: i32,
    format: i32,
}
unsafe extern "C" fn get_proc(_: *mut c_void, name: *const c_char) -> *mut c_void {
    if let Some(proc) = wglGetProcAddress(PCSTR(name.cast())) {
        let p = proc as *mut c_void;
        if p as usize > 4 && p as isize != -1 {
            return p;
        }
    }
    GetModuleHandleA(s!("opengl32.dll"))
        .ok()
        .and_then(|m| GetProcAddress(m, PCSTR(name.cast())))
        .map_or(ptr::null_mut(), |p| p as *mut c_void)
}
unsafe fn gl<T: Copy>(name: &str) -> Result<T> {
    let c = CString::new(name)?;
    let p = get_proc(ptr::null_mut(), c.as_ptr());
    if p.is_null() {
        bail!("Missing GL entry point {name}")
    }
    Ok(std::mem::transmute_copy(&p))
}
type OpenDevice = unsafe extern "system" fn(*mut c_void) -> *mut c_void;
type RegisterObject =
    unsafe extern "system" fn(*mut c_void, *mut c_void, u32, u32, u32) -> *mut c_void;
type LockObjects = unsafe extern "system" fn(*mut c_void, i32, *const *mut c_void) -> i32;
type Gen = unsafe extern "system" fn(i32, *mut u32);
type Bind = unsafe extern "system" fn(u32, u32);
type Attach = unsafe extern "system" fn(u32, u32, u32, u32);
type Check = unsafe extern "system" fn(u32) -> u32;
type GlString = unsafe extern "system" fn(u32) -> *const u8;
unsafe fn shared_target(device: &ID3D11Device, width: u32, height: u32) -> Result<ID3D11Texture2D> {
    let mut texture = None;
    device.CreateTexture2D(
        &D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            ..Default::default()
        },
        None,
        Some(&mut texture),
    )?;
    texture.context("Stable shared render target")
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e:#}");
        std::process::exit(1)
    }
}
fn run() -> Result<()> {
    unsafe {
        let args: Vec<String> = std::env::args().collect();
        if args.len() < 4 {
            bail!("usage: host DLL FIXTURE OUTPUT_DIRECTORY [SECONDS]")
        }
        let output = std::path::PathBuf::from(&args[3]);
        std::fs::create_dir_all(&output)?;
        let output = std::fs::canonicalize(output)?;
        let duration = args
            .get(4)
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(60);
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let module = GetModuleHandleW(None)?;
        RegisterClassW(&WNDCLASSW {
            style: CS_OWNDC,
            lpfnWndProc: Some(window_proc),
            hInstance: HINSTANCE(module.0),
            lpszClassName: w!("SurtitleCompositionEvaluation"),
            ..Default::default()
        });
        let hwnd = CreateWindowExW(
            WS_EX_NOREDIRECTIONBITMAP,
            w!("SurtitleCompositionEvaluation"),
            w!("Surtitle GPU Composition Evaluation"),
            WS_OVERLAPPEDWINDOW,
            100,
            100,
            1300,
            790,
            None,
            None,
            Some(HINSTANCE(module.0)),
            None,
        )?;
        // WGL owns a separate hidden context window; presentation goes only through DXGI+DComp.
        let gl_hwnd = CreateWindowExW(
            Default::default(),
            w!("SurtitleCompositionEvaluation"),
            w!("Hidden GL context"),
            WS_OVERLAPPED,
            0,
            0,
            1,
            1,
            None,
            None,
            Some(HINSTANCE(module.0)),
            None,
        )?;
        let dc = GetDC(Some(gl_hwnd));
        let descriptor = PIXELFORMATDESCRIPTOR {
            nSize: std::mem::size_of::<PIXELFORMATDESCRIPTOR>() as u16,
            nVersion: 1,
            dwFlags: PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER,
            iPixelType: PFD_TYPE_RGBA,
            cColorBits: 32,
            cAlphaBits: 8,
            ..Default::default()
        };
        let format = ChoosePixelFormat(dc, &descriptor);
        if format == 0 {
            bail!("ChoosePixelFormat failed")
        }
        SetPixelFormat(dc, format, &descriptor)?;
        let context = wglCreateContext(dc)?;
        wglMakeCurrent(dc, context)?;
        let string: GlString = gl("glGetString")?;
        let renderer = CStr::from_ptr(string(0x1f01).cast())
            .to_string_lossy()
            .into_owned();
        let version = CStr::from_ptr(string(0x1f02).cast())
            .to_string_lossy()
            .into_owned();
        println!("GL renderer: {renderer}; version: {version}");
        if renderer.to_lowercase().contains("software") || renderer.contains("GDI Generic") {
            bail!("Software GL is not accepted")
        }
        let mut device = None;
        let mut device_context = None;
        let mut level = D3D_FEATURE_LEVEL::default();
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut level),
            Some(&mut device_context),
        )?;
        let device = device.context("D3D device")?;
        let dxgi: IDXGIDevice = device.cast()?;
        let adapter = dxgi.GetAdapter()?;
        let desc = adapter.GetDesc()?;
        let adapter_name = String::from_utf16_lossy(&desc.Description)
            .trim_end_matches('\0')
            .to_string();
        println!("D3D adapter: {adapter_name}; feature level: {:x}", level.0);
        let factory: IDXGIFactory2 = adapter.GetParent()?;
        let mut bounds = RECT::default();
        GetClientRect(hwnd, &mut bounds)?;
        let (width, height) = (bounds.right as u32, bounds.bottom as u32);
        let swap = factory.CreateSwapChainForComposition(
            &device,
            &DXGI_SWAP_CHAIN_DESC1 {
                Width: width,
                Height: height,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
                BufferCount: 2,
                Scaling: DXGI_SCALING_STRETCH,
                SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
                AlphaMode: DXGI_ALPHA_MODE_IGNORE,
                ..Default::default()
            },
            None,
        )?;
        let mut present_buffer: Option<ID3D11Texture2D> = Some(swap.GetBuffer(0)?);
        // Interop owns a stable texture, never a rotating flip-swapchain buffer.
        let mut buffer: Option<ID3D11Texture2D> = Some(shared_target(&device, width, height)?);
        let open: OpenDevice = gl("wglDXOpenDeviceNV")?;
        let register: RegisterObject = gl("wglDXRegisterObjectNV")?;
        let lock: LockObjects = gl("wglDXLockObjectsNV")?;
        let unlock: LockObjects = gl("wglDXUnlockObjectsNV")?;
        let interop = open(device.as_raw());
        if interop.is_null() {
            bail!("wglDXOpenDeviceNV failed: {:?}", GetLastError())
        }
        let gen: Gen = gl("glGenRenderbuffers")?;
        let mut rb = 0;
        gen(1, &mut rb);
        let mut object = register(interop, buffer.as_ref().unwrap().as_raw(), rb, 0x8d41, 1);
        if object.is_null() {
            bail!("Register D3D11 backbuffer failed: {:?}", GetLastError())
        }
        let gen_fbo: Gen = gl("glGenFramebuffers")?;
        let bind: Bind = gl("glBindFramebuffer")?;
        let attach: Attach = gl("glFramebufferRenderbuffer")?;
        let check: Check = gl("glCheckFramebufferStatus")?;
        let mut fbo = 0;
        gen_fbo(1, &mut fbo);
        if lock(interop, 1, &object) == 0 {
            bail!("Initial interop lock failed")
        };
        bind(0x8d40, fbo);
        attach(0x8d40, 0x8ce0, 0x8d41, rb);
        let status = check(0x8d40);
        unlock(interop, 1, &object);
        if status != 0x8cd5 {
            bail!("Incomplete shared framebuffer {status:x}")
        }
        let dcomp: IDCompositionDevice = DCompositionCreateDevice(&dxgi)?;
        let target = dcomp.CreateTargetForHwnd(hwnd, true)?;
        let root = dcomp.CreateVisual()?;
        let video = dcomp.CreateVisual()?;
        let html = dcomp.CreateVisual()?;
        video.SetContent(&swap)?;
        root.AddVisual(&video, false, None)?;
        root.AddVisual(&html, true, Some(&video))?;
        target.SetRoot(&root)?;
        dcomp.Commit()?;
        let profile = output.join("webview-profile");
        let wide: Vec<u16> = profile
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let (tx, rx) = mpsc::channel();
        CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| {
                CreateCoreWebView2EnvironmentWithOptions(
                    PCWSTR::null(),
                    PCWSTR(wide.as_ptr()),
                    None,
                    &handler,
                )
                .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |hr, env| {
                hr?;
                tx.send(env).unwrap();
                Ok(())
            }),
        )?;
        let env: ICoreWebView2Environment3 = rx.recv()?.context("WebView environment")?.cast()?;
        let (tx, rx) = mpsc::channel();
        CreateCoreWebView2CompositionControllerCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| {
                env.CreateCoreWebView2CompositionController(hwnd, &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |hr, c| {
                hr?;
                tx.send(c).unwrap();
                Ok(())
            }),
        )?;
        let composition = rx.recv()?.context("Composition controller")?;
        composition.SetRootVisualTarget(&html)?;
        let controller: ICoreWebView2Controller = composition.cast()?;
        controller.SetBounds(bounds)?;
        controller.SetIsVisible(true)?;
        controller
            .cast::<ICoreWebView2Controller2>()?
            .SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                A: 0,
                R: 0,
                G: 0,
                B: 0,
            })?;
        let web = controller.CoreWebView2()?;
        let messages = Rc::new(RefCell::new(Vec::<String>::new()));
        let received = messages.clone();
        let mut token = 0;
        web.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut s = PWSTR::null();
                    args.WebMessageAsJson(&mut s)?;
                    let text = CoTaskMemPWSTR::from(s).to_string();
                    println!("UI: {text}");
                    received.borrow_mut().push(text);
                }
                Ok(())
            })),
            &mut token,
        )?;
        let document = include_str!("../fixture.html");
        let wide: Vec<u16> = document.encode_utf16().chain(Some(0)).collect();
        web.NavigateToString(PCWSTR(wide.as_ptr()))?;
        WEB.with(|cell| *cell.borrow_mut() = Some(composition.clone()));
        dcomp.Commit()?;
        let _ = ShowWindow(hwnd, SW_SHOW);
        if args.iter().any(|argument| argument == "video-only") {
            root.RemoveVisual(&html)?;
            dcomp.Commit()?;
        }
        let library = libloading::Library::new(std::fs::canonicalize(&args[1])?)?;
        let create: libloading::Symbol<unsafe extern "C" fn() -> *mut c_void> =
            library.get(b"mpv_create\0")?;
        let option: libloading::Symbol<
            unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> i32,
        > = library.get(b"mpv_set_option_string\0")?;
        let initialize: libloading::Symbol<unsafe extern "C" fn(*mut c_void) -> i32> =
            library.get(b"mpv_initialize\0")?;
        let render_create: libloading::Symbol<
            unsafe extern "C" fn(*mut *mut c_void, *mut c_void, *const Param) -> i32,
        > = library.get(b"mpv_render_context_create\0")?;
        let render: libloading::Symbol<unsafe extern "C" fn(*mut c_void, *const Param) -> i32> =
            library.get(b"mpv_render_context_render\0")?;
        let report_swap: libloading::Symbol<unsafe extern "C" fn(*mut c_void)> =
            library.get(b"mpv_render_context_report_swap\0")?;
        let command: libloading::Symbol<
            unsafe extern "C" fn(*mut c_void, *const *const c_char) -> i32,
        > = library.get(b"mpv_command\0")?;
        let property: libloading::Symbol<
            unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char,
        > = library.get(b"mpv_get_property_string\0")?;
        let free: libloading::Symbol<unsafe extern "C" fn(*mut c_void)> =
            library.get(b"mpv_free\0")?;
        let mpv = create();
        if mpv.is_null() {
            bail!("mpv_create failed")
        }
        for (k, v) in [
            ("vo", "libmpv"),
            ("hwdec", "auto-safe"),
            ("ao", "null"),
            ("loop-file", "inf"),
            ("terminal", "yes"),
            ("msg-level", "all=warn,vo=debug"),
            ("config", "no"),
        ] {
            let k = CString::new(k)?;
            let v = CString::new(v)?;
            let code = option(mpv, k.as_ptr(), v.as_ptr());
            if code < 0 {
                bail!("mpv option failed {code}")
            }
        }
        let log = CString::new(output.join("mpv.log").to_string_lossy().to_string())?;
        option(mpv, c"log-file".as_ptr(), log.as_ptr());
        let code = initialize(mpv);
        if code < 0 {
            bail!("mpv_initialize {code}")
        }
        wglMakeCurrent(dc, context)?;
        let mut init = Init {
            get_proc,
            context: ptr::null_mut(),
        };
        let mut render_context = ptr::null_mut();
        let params = [
            Param {
                kind: 1,
                data: c"opengl".as_ptr().cast_mut().cast(),
            },
            Param {
                kind: 2,
                data: (&mut init as *mut Init).cast(),
            },
            Param {
                kind: 0,
                data: ptr::null_mut(),
            },
        ];
        let code = render_create(&mut render_context, mpv, params.as_ptr());
        if code < 0 {
            bail!("GL mpv_render_context_create {code}")
        }
        let file = CString::new(
            std::fs::canonicalize(&args[2])?
                .to_string_lossy()
                .replace("\\\\?\\", ""),
        )?;
        let command_args = [c"loadfile".as_ptr(), file.as_ptr(), ptr::null()];
        let code = command(mpv, command_args.as_ptr());
        if code < 0 {
            bail!("loadfile {code}")
        }
        let started = Instant::now();
        let mut frames = 0;
        let mut msg = MSG::default();
        let mut flip = 0_i32;
        let mut target_fbo = Fbo {
            id: fbo as i32,
            width: width as i32,
            height: height as i32,
            format: 0,
        };
        let mut resize_count = 0;
        let unregister: unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32 =
            gl("wglDXUnregisterObjectNV")?;
        let delete_fbo: Gen = gl("glDeleteFramebuffers")?;
        let delete_rb: Gen = gl("glDeleteRenderbuffers")?;
        let params = [
            Param {
                kind: 3,
                data: (&mut target_fbo as *mut Fbo).cast(),
            },
            Param {
                kind: 4,
                data: (&mut flip as *mut i32).cast(),
            },
            Param {
                kind: 0,
                data: ptr::null_mut(),
            },
        ];
        let mut handled_messages = 0;
        let mut receipts = Vec::new();
        let capture_target = args
            .get(5)
            .is_some_and(|argument| argument == "capture-target");
        let mut target_capture = None;
        let capture_window = args
            .get(5)
            .is_some_and(|argument| argument == "capture-window");
        let mut window_capture = None;
        let mut window_captured = false;
        let run_command = |arguments: &[&str]| -> Result<()> {
            let strings: Vec<CString> = arguments
                .iter()
                .map(|v| CString::new(*v))
                .collect::<std::result::Result<_, _>>()?;
            let mut pointers: Vec<_> = strings.iter().map(|v| v.as_ptr()).collect();
            pointers.push(ptr::null());
            let result = command(mpv, pointers.as_ptr());
            if result < 0 {
                bail!("Fixture native command failed {result}")
            }
            Ok(())
        };
        while started.elapsed() < Duration::from_secs(duration) {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if msg.message == WM_QUIT {
                break;
            }
            let pending: Vec<_> = messages
                .borrow()
                .iter()
                .skip(handled_messages)
                .cloned()
                .collect();
            handled_messages += pending.len();
            for message in pending {
                let value: serde_json::Value = serde_json::from_str(&message)?;
                let Some(action) = value.get("action").and_then(|value| value.as_str()) else {
                    continue;
                };
                match action {
                    "play" | "resume" => run_command(&["set", "pause", "no"])?,
                    "pause" | "meaning" => run_command(&["set", "pause", "yes"])?,
                    "select" => {
                        run_command(&["set", "pause", "yes"])?;
                        run_command(&["seek", "2", "absolute+exact"])?;
                    }
                    "save" => std::fs::write(
                        output.join("saved-phrase.json"),
                        serde_json::to_vec_pretty(&value)?,
                    )?,
                    "state" => (),
                    _ => continue,
                }
                let paused = property(mpv, c"pause".as_ptr());
                let paused_value = if paused.is_null() {
                    "unknown".into()
                } else {
                    let value = CStr::from_ptr(paused).to_string_lossy().into_owned();
                    free(paused.cast());
                    value
                };
                let position = property(mpv, c"time-pos".as_ptr());
                let position_value = if position.is_null() {
                    None
                } else {
                    let value = CStr::from_ptr(position)
                        .to_string_lossy()
                        .parse::<f64>()
                        .ok();
                    free(position.cast());
                    value
                };
                let receipt = serde_json::json!({"action":action,"paused":paused_value,"position":position_value,"saved":output.join("saved-phrase.json").exists()});
                let json: Vec<u16> = receipt.to_string().encode_utf16().chain(Some(0)).collect();
                web.PostWebMessageAsJson(PCWSTR(json.as_ptr()))?;
                receipts.push(receipt);
            }
            if let Some((width, height)) = RESIZE.with(|cell| cell.borrow_mut().take()) {
                if width as i32 != target_fbo.width || height as i32 != target_fbo.height {
                    bind(0x8d40, 0);
                    if unregister(interop, object) == 0 {
                        bail!("Interop unregister before resize failed")
                    }
                    delete_fbo(1, &mut fbo);
                    delete_rb(1, &mut rb);
                    buffer.take();
                    present_buffer.take();
                    swap.ResizeBuffers(
                        2,
                        width,
                        height,
                        DXGI_FORMAT_B8G8R8A8_UNORM,
                        DXGI_SWAP_CHAIN_FLAG(0),
                    )?;
                    present_buffer = Some(swap.GetBuffer(0)?);
                    buffer = Some(shared_target(&device, width, height)?);
                    gen(1, &mut rb);
                    object = register(interop, buffer.as_ref().unwrap().as_raw(), rb, 0x8d41, 1);
                    if object.is_null() {
                        bail!("Resized interop registration failed")
                    }
                    if lock(interop, 1, &object) == 0 {
                        bail!("Resized interop lock failed")
                    };
                    gen_fbo(1, &mut fbo);
                    bind(0x8d40, fbo);
                    attach(0x8d40, 0x8ce0, 0x8d41, rb);
                    let status = check(0x8d40);
                    unlock(interop, 1, &object);
                    if status != 0x8cd5 {
                        bail!("Resized framebuffer incomplete")
                    }
                    target_fbo.id = fbo as i32;
                    target_fbo.width = width as i32;
                    target_fbo.height = height as i32;
                    controller.SetBounds(RECT {
                        left: 0,
                        top: 0,
                        right: width as i32,
                        bottom: height as i32,
                    })?;
                    dcomp.Commit()?;
                    resize_count += 1;
                }
            }
            if lock(interop, 1, &object) == 0 {
                bail!("Interop lock failed at frame {frames}")
            }
            let code = render(render_context, params.as_ptr());
            // Optional one-frame diagnostic, never used by presentation. This
            // distinguishes a black render target from a capture API omitting
            // DirectComposition visuals; it is explicitly reported as readback.
            if capture_target && frames == 60 {
                let read_pixels: unsafe extern "system" fn(
                    i32,
                    i32,
                    i32,
                    i32,
                    u32,
                    u32,
                    *mut c_void,
                ) = gl("glReadPixels")?;
                bind(0x8d40, fbo);
                let mut pixels = vec![0_u8; (target_fbo.width * target_fbo.height * 4) as usize];
                read_pixels(
                    0,
                    0,
                    target_fbo.width,
                    target_fbo.height,
                    0x1908,
                    0x1401,
                    pixels.as_mut_ptr().cast(),
                );
                let mut ppm =
                    format!("P6\n{} {}\n255\n", target_fbo.width, target_fbo.height).into_bytes();
                for row in pixels.chunks_exact((target_fbo.width * 4) as usize).rev() {
                    for pixel in row.chunks_exact(4) {
                        ppm.extend_from_slice(&pixel[..3]);
                    }
                }
                std::fs::write(output.join("render-target.ppm"), ppm)?;
                let colors: std::collections::HashSet<_> = pixels
                    .chunks_exact(4)
                    .map(|pixel| [pixel[0], pixel[1], pixel[2]])
                    .collect();
                target_capture = Some(
                    serde_json::json!({"diagnosticOnly":true,"cpuReadback":true,"distinctRgbColors":colors.len(),"size":[target_fbo.width,target_fbo.height]}),
                );
            }
            if unlock(interop, 1, &object) == 0 {
                bail!("Interop unlock failed")
            }
            if code < 0 {
                bail!("mpv render failed {code}")
            }
            if args.iter().any(|argument| argument == "diagnostic-clear") {
                let mut view = None;
                device.CreateRenderTargetView(buffer.as_ref().unwrap(), None, Some(&mut view))?;
                device_context
                    .as_ref()
                    .unwrap()
                    .ClearRenderTargetView(&view.unwrap(), &[1.0, 0.3, 0.0, 1.0]);
                device_context.as_ref().unwrap().Flush();
            }
            device_context
                .as_ref()
                .unwrap()
                .CopyResource(present_buffer.as_ref().unwrap(), buffer.as_ref().unwrap());
            swap.Present(1, DXGI_PRESENT(0)).ok()?;
            report_swap(render_context);
            frames += 1;
            if capture_window && frames == 60 {
                window_capture = Some(capture::Capture::start(
                    hwnd,
                    &device,
                    device_context.as_ref().context("Capture device context")?,
                )?);
            }
            if let Some(capture) = &window_capture {
                if capture.save_if_ready(&output.join("composed-window.ppm"))? {
                    window_captured = true;
                    window_capture = None;
                }
            }
        }
        let mut properties = serde_json::Map::new();
        for name in [
            "video-params/w",
            "video-params/h",
            "time-pos",
            "hwdec-current",
            "frame-drop-count",
            "decoder-frame-drop-count",
            "vo-delayed-frame-count",
        ] {
            let key = CString::new(name)?;
            let value = property(mpv, key.as_ptr());
            if !value.is_null() {
                properties.insert(
                    name.into(),
                    CStr::from_ptr(value).to_string_lossy().into_owned().into(),
                );
                free(value.cast());
            }
        }
        std::fs::write(
            output.join("result.json"),
            serde_json::to_vec_pretty(
                &serde_json::json!({"renderer":renderer,"glVersion":version,"adapter":adapter_name,"framesPresented":frames,"seconds":started.elapsed().as_secs_f64(),"resizes":resize_count,"finalSize":[target_fbo.width,target_fbo.height],"properties":properties,"webMessages":*messages.borrow(),"nativeReceipts":receipts,"renderedTargetCpuReadback":false,"gpuTextureCopyPerFrame":true,"optionalTargetDiagnostic":target_capture,"diagnosticModes":args.iter().skip(5).collect::<Vec<_>>(),"optionalOwnedWindowCapture":window_captured,"decoderCopyBack":properties.get("hwdec-current").and_then(|v|v.as_str()).is_some_and(|v|v.ends_with("-copy")),"perFrameJsIpc":false,"route":"WGL_NV_DX_interop2 stable D3D11 texture + GPU CopyResource + composition swapchain + WebView2 visual host","limitations":["WGL NV extension route; other vendors untested","Prototype only; no Tauri integration","No device-loss recovery yet"]}),
            )?,
        )?;
        controller.Close()?;
        let render_free: libloading::Symbol<unsafe extern "C" fn(*mut c_void)> =
            library.get(b"mpv_render_context_free\0")?;
        render_free(render_context);
        let destroy: libloading::Symbol<unsafe extern "C" fn(*mut c_void)> =
            library.get(b"mpv_terminate_destroy\0")?;
        destroy(mpv);
        unregister(interop, object);
        let close: unsafe extern "system" fn(*mut c_void) -> i32 = gl("wglDXCloseDeviceNV")?;
        close(interop);
        wglMakeCurrent(HDC::default(), HGLRC::default())?;
        wglDeleteContext(context)?;
        let _ = DestroyWindow(gl_hwnd);
        let _ = DestroyWindow(hwnd);
        println!(
            "Presented {frames} GPU frames; report {}",
            output.join("result.json").display()
        );
        Ok(())
    }
}
