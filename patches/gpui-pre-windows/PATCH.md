# Windows accessibility and callback lifecycle

This is the acquired `gpui-pre-windows` 0.3.11 crate (Apache-2.0), corresponding
to Zed `gpui_windows` at `f816e1f9263e3a8ef63c4baaa02e1441ce1c6038`.
`Cargo.toml.orig` and `LICENSE-APACHE` retain its upstream metadata and license.
No generated Cargo cache files are included.
The acquired crates.io archive SHA-256 is
`5141a3db59bab761a16ab19529fe4117a86e91922e8fc00af6dfc4829cb1744d`.

Surtitle's accessibility change retires each window's AccessKit adapter at
`WM_DESTROY`, before close callbacks and before the HWND becomes invalid.
The slot is cleared before entering COM, so nested `WM_GETOBJECT` cannot
return the retiring provider. It also sends Microsoft's documented null
`UiaReturnRawElementProvider` destruction notification. This applies to main
and owned windows; it does not disable accessibility while a window is alive.

Without retirement, a retained UIA child can call `ClientToScreen` on a dead
HWND and abort inside AccessKit. Null notification alone reproduces that abort.
The hidden-window regression retains UIA children across destruction and expects
`UIA_E_ELEMENTNOTAVAILABLE`, including an owned-window case. It performs no
foreground activation or physical input. Run on Windows with:

`cargo test -p gpui-pre-windows --lib destroyed_window_retained_uia_provider_is_unavailable --locked`

The manifest adds `Win32_UI_Accessibility` for the documented destruction API.
Remove this accessibility change when upstream retires its adapter before HWND
destruction and passes the retained-provider regression. In-flight COM operations
are not cancelled; this does not resolve every concurrent AccessKit race.

## Deferred display notifications

Restoring saved window placement can synchronously deliver `WM_MOVE` while
`Application::run` still holds GPUI's mutable App borrow. A monitor change then
called GPUI's display observer immediately, causing a second App borrow and an
abort across the native window procedure. `WM_DISPLAYCHANGE` shares that path.

The backend now stores the current display immediately and schedules its observer
on the foreground executor, as it already does for activation and visibility.
The task retains only a weak window reference. Closing retires the observer;
queued notifications and a callback that closes its own window cannot invoke or
reinstall an observer after close. Remove this change when upstream provides
equivalent scheduling and passes the regression below.

The subprocess regression opens only hidden, unfocused GPUI windows and sends
`WM_DISPLAYCHANGE` during the real startup App borrow. It verifies deferred
delivery through GPUI's actual observer, immediate native display state, App
responsiveness, close before delivery, and close during delivery. It needs no
second monitor, physical input, or scaling change. Run on Windows with:

`cargo test -p gpui-pre-windows --lib startup_display_change_is_deferred_and_pending_notifications_respect_close --locked`

Sources:
- [Pinned GPUI backend](https://github.com/zed-industries/zed/blob/f816e1f9263e3a8ef63c4baaa02e1441ce1c6038/crates/gpui_windows/src/events.rs)
- [Microsoft destruction notification](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationcoreapi/nf-uiautomationcoreapi-uiareturnrawelementprovider#remarks)
