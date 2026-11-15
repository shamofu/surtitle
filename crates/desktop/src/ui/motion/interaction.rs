// SPDX-License-Identifier: GPL-3.0-or-later
use gpui_kit::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, Window,
};

/// Preserves layout and painting while removing outgoing controls from all
/// interaction trees. Use the same wrapper while active to retain element IDs.
pub(crate) fn interactive(child: impl IntoElement, enabled: bool) -> impl IntoElement {
    Interaction {
        child: child.into_any_element(),
        enabled,
    }
}

struct Interaction {
    child: AnyElement,
    enabled: bool,
}
impl IntoElement for Interaction {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for Interaction {
    type RequestLayoutState = ();
    type PrepaintState = ();
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let layout = window.with_inert(!self.enabled, |window| {
            self.child.request_layout(window, cx)
        });
        (layout, ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        window.with_inert(!self.enabled, |window| self.child.prepaint(window, cx));
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        window.with_inert(!self.enabled, |window| self.child.paint(window, cx));
    }
}
