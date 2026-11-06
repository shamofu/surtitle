use std::{collections::HashMap, sync::mpsc};

use accesskit::{Node, NodeId, Rect, Role, Tree, TreeId, TreeUpdate};
use windows::{Win32::UI::Accessibility::*, core::w};

use super::*;

type Slot = Rc<RefCell<Option<A11yState>>>;
thread_local! {
    static SLOTS: RefCell<HashMap<usize, Slot>> = RefCell::new(HashMap::new());
}

fn slot(hwnd: HWND) -> Option<Slot> {
    SLOTS.with(|slots| slots.borrow().get(&(hwnd.0 as usize)).cloned())
}

extern "system" fn procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if let Some(slot) = slot(hwnd) {
        match message {
            WM_GETOBJECT => {
                let result = {
                    let mut state = slot.borrow_mut();
                    state.as_mut().and_then(|state| {
                        state.adapter.handle_wm_getobject(
                            wparam,
                            lparam,
                            &mut state.activation_handler,
                        )
                    })
                };
                if let Some(result) = result {
                    return result.into();
                }
            }
            WM_DESTROY => A11yState::retire(&slot, hwnd),
            _ => {}
        }
    }
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

fn tree() -> Option<TreeUpdate> {
    let mut root = Node::new(Role::Window);
    root.set_children(vec![NodeId(2)]);
    root.set_bounds(Rect::new(0., 0., 400., 300.));
    let mut child = Node::new(Role::Button);
    child.set_label("Retained lifecycle child");
    child.set_bounds(Rect::new(10., 10., 110., 50.));
    Some(TreeUpdate {
        nodes: vec![(NodeId(1), root), (NodeId(2), child)],
        tree: Some(Tree::new(NodeId(1))),
        tree_id: TreeId::ROOT,
        focus: NodeId(2),
    })
}

fn pump_until(mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !done() {
        unsafe {
            let mut message = MSG::default();
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        assert!(Instant::now() < deadline, "UIA fixture timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[::core::prelude::v1::test]
fn destroyed_window_retained_uia_provider_is_unavailable() -> windows::core::Result<()> {
    let instance = HINSTANCE(unsafe { GetModuleHandleW(None) }?.0);
    let class = w!("GpuiHiddenAccessibilityLifecycleRegression");
    assert_ne!(
        unsafe {
            RegisterClassW(&WNDCLASSW {
                lpfnWndProc: Some(procedure),
                hInstance: instance,
                lpszClassName: class,
                ..Default::default()
            })
        },
        0
    );
    let mut windows = Vec::new();
    // A hidden main HWND and a hidden owned HWND exercise the shared backend
    // teardown. Keep their host slots alive after destruction, as async close
    // work can keep WindowsWindowInner alive in production.
    for owner in [None, Some(0usize)] {
        let parent = owner.map(|index| windows[index]);
        let hwnd = unsafe {
            CreateWindowExW(
                Default::default(),
                class,
                w!("Hidden UIA regression"),
                WS_POPUP,
                -32000,
                -32000,
                400,
                300,
                parent,
                None,
                Some(instance),
                None,
            )
        }?;
        assert!(!unsafe { IsWindowVisible(hwnd) }.as_bool());
        let state = A11yState {
            adapter: accesskit_windows::Adapter::new(
                hwnd,
                false,
                A11yActionHandler(Box::new(|_| {})),
            ),
            activation_handler: A11yActivationHandler {
                callback: Box::new(tree),
            },
        };
        SLOTS.with(|slots| {
            slots
                .borrow_mut()
                .insert(hwnd.0 as usize, Rc::new(RefCell::new(Some(state))))
        });
        windows.push(hwnd);
    }
    for hwnd in windows.into_iter().rev() {
        let (ready_tx, ready_rx) = mpsc::channel();
        let (closed_tx, closed_rx) = mpsc::channel();
        let address = hwnd.0 as usize;
        let client = std::thread::spawn(move || -> windows::core::Result<()> {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok()?;
            let automation: IUIAutomation =
                unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }?;
            let root = unsafe { automation.ElementFromHandle(HWND(address as _)) }?;
            let child =
                unsafe { root.FindFirst(TreeScope_Children, &automation.CreateTrueCondition()?) }?;
            assert_eq!(
                unsafe { child.CurrentName() }?.to_string(),
                "Retained lifecycle child"
            );
            let bounds = unsafe { child.CurrentBoundingRectangle() }?;
            assert_eq!(bounds.right - bounds.left, 100);
            ready_tx.send(()).unwrap();
            closed_rx.recv_timeout(Duration::from_secs(15)).unwrap();
            let error = unsafe { child.CurrentBoundingRectangle() }
                .expect_err("destroyed provider must be unavailable");
            assert_eq!(error.code().0 as u32, UIA_E_ELEMENTNOTAVAILABLE);
            drop(child);
            drop(root);
            drop(automation);
            unsafe { CoUninitialize() };
            Ok(())
        });
        pump_until(|| ready_rx.try_recv().is_ok() || client.is_finished());
        assert!(
            !client.is_finished(),
            "UIA client failed before acquiring the child"
        );
        unsafe { DestroyWindow(hwnd) }?;
        assert!(!unsafe { IsWindow(Some(hwnd)) }.as_bool());
        assert!(slot(hwnd).unwrap().borrow().is_none());
        closed_tx.send(()).unwrap();
        pump_until(|| client.is_finished());
        client.join().unwrap()?;
        SLOTS.with(|slots| slots.borrow_mut().remove(&(hwnd.0 as usize)));
    }
    unsafe { UnregisterClassW(class, Some(instance)) }?;
    Ok(())
}
