// SPDX-License-Identifier: GPL-3.0-or-later
//! Completion barrier for foreground-initiated operations and their callbacks.
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;

#[derive(Clone, Default)]
pub(crate) struct InFlight(Arc<Inner>);
#[derive(Default)]
struct Inner {
    count: AtomicUsize,
    changed: Notify,
}
pub(crate) struct Operation(InFlight);
impl InFlight {
    pub fn begin(&self) -> Operation {
        self.0.count.fetch_add(1, Ordering::AcqRel);
        Operation(self.clone())
    }
    pub async fn drained(&self) {
        loop {
            let notified = self.0.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.0.count.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if self.0.0.count.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.0.changed.notify_waiters();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn barrier_includes_work_started_by_a_completion_callback() {
        let pending = InFlight::default();
        let first = pending.begin();
        let copy = pending.clone();
        let waiter = tokio::spawn(async move { copy.drained().await });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        let followup = pending.begin();
        drop(first);
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        drop(followup);
        waiter.await.unwrap();
    }
    #[tokio::test]
    async fn operation_drop_releases_all_waiters_without_a_lost_wakeup() {
        let pending = InFlight::default();
        let operation = pending.begin();
        let a = pending.clone();
        let b = pending.clone();
        let first = tokio::spawn(async move { a.drained().await });
        let second = tokio::spawn(async move { b.drained().await });
        drop(operation);
        first.await.unwrap();
        second.await.unwrap();
        pending.drained().await;
    }
}
