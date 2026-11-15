// SPDX-License-Identifier: GPL-3.0-or-later
//! FLIP for visible rows. The owner explicitly arms changes caused by filters;
//! virtualization and snapshot refreshes simply record new painted bounds.
use gpui_kit::*;
use std::{cell::RefCell, collections::BTreeMap, rc::Rc, time::Instant};

#[derive(Clone, Default)]
pub(crate) struct ListMotion(Rc<RefCell<State>>);
#[derive(Default)]
struct State {
    rows: BTreeMap<String, Bounds<Pixels>>,
    from: BTreeMap<String, Bounds<Pixels>>,
    starts: BTreeMap<String, (Point<Pixels>, Instant)>,
    viewport: Option<(Size<Pixels>, Point<Pixels>)>,
    first_layout_after_filter: bool,
}
impl ListMotion {
    /// Programmatic source/follow changes adopt layout immediately.
    pub fn settle(&self) {
        let mut state = self.0.borrow_mut();
        state.from.clear();
        state.starts.clear();
        state.first_layout_after_filter = false;
    }
    pub fn filter_changed(&self) {
        let mut state = self.0.borrow_mut();
        state.from = state.rows.clone();
        state.rows.clear();
        state.starts.clear();
        state.first_layout_after_filter = true;
    }
    /// Owners call this once before producing the complete visible layout batch.
    /// Eligibility belongs to that batch, never to wall-clock timestamps.
    pub fn begin_layout(&self) {
        let mut state = self.0.borrow_mut();
        if !state.first_layout_after_filter {
            state.from.clear();
        }
        state.first_layout_after_filter = false;
        let visible = state
            .rows
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        state.starts.retain(|id, _| visible.contains(id));
        state.rows.clear();
    }
    /// Scroll and resize invalidate screen-space measurements; no stale pose
    /// may pull a row back to where it was before a wheel/viewport change.
    pub fn viewport(&self, size: Size<Pixels>, offset: Point<Pixels>) {
        let mut state = self.0.borrow_mut();
        if state
            .viewport
            .is_some_and(|previous| previous != (size, offset))
        {
            state.from.clear();
            state.starts.clear();
        }
        state.viewport = Some((size, offset));
    }
    pub fn row(&self, id: impl Into<String>, child: impl IntoElement) -> Row {
        Row {
            id: id.into(),
            motion: self.clone(),
            child: child.into_any_element(),
            offset: Point::default(),
        }
    }
}

/// Prefer the same top row; when it was removed, retain its nearest surviving
/// successor (then predecessor) instead of keeping an unrelated numeric index.
pub(crate) fn retained_anchor(
    previous: &[String],
    index: usize,
    current: &[String],
) -> Option<usize> {
    previous
        .iter()
        .skip(index)
        .chain(previous.iter().take(index).rev())
        .find_map(|id| current.iter().position(|current| current == id))
}
pub(crate) struct Row {
    id: String,
    motion: ListMotion,
    child: AnyElement,
    offset: Point<Pixels>,
}
impl IntoElement for Row {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for Row {
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
        (self.child.request_layout(window, cx), ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let now = cx.background_executor().now();
        let mut state = self.motion.0.borrow_mut();
        if cx.reduce_motion() {
            state.from.clear();
            state.starts.clear();
        }
        if !state.starts.contains_key(&self.id)
            && let Some(previous) = state.from.remove(&self.id)
            && previous.size.width == bounds.size.width
            && previous.origin != bounds.origin
        {
            state
                .starts
                .insert(self.id.clone(), (previous.origin - bounds.origin, now));
        }
        if let Some((delta, started)) = state.starts.get(&self.id).copied() {
            let elapsed = now.saturating_duration_since(started).as_secs_f32()
                / super::motion::SELECTION.as_secs_f32();
            if elapsed < 1. {
                let eased = super::motion::entering_easing().sample(elapsed);
                self.offset = point(delta.x * (1. - eased), delta.y * (1. - eased));
                window.request_animation_frame();
            } else {
                state.starts.remove(&self.id);
            }
        }
        if !bounds.intersect(&window.content_mask().bounds).is_empty() {
            state.rows.insert(
                self.id.clone(),
                Bounds::new(bounds.origin + self.offset, bounds.size),
            );
        }
        drop(state);
        window.with_element_offset(self.offset, |window| self.child.prepaint(window, cx));
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
        self.child.paint(window, cx);
    }
}
