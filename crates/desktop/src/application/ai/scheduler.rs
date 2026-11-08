//! One native dispatch lane, with interactive work preferred at request boundaries.
//! This queue grants no billing authority: every turn still enters the ledger.
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

#[derive(Clone, Default)]
pub(crate) struct DispatchQueue(Arc<Shared>);
#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Notify,
}
#[derive(Default)]
struct State {
    next: u64,
    active: Option<u64>,
    waiting: Vec<Entry>,
    workers: HashSet<String>,
    interactive_streak: usize,
}
struct Entry {
    id: u64,
    job: String,
    interactive: bool,
}
pub(crate) struct Worker {
    queue: DispatchQueue,
    approval: String,
}
pub(crate) struct Ticket {
    queue: DispatchQueue,
    id: u64,
}
pub(crate) struct Permit {
    queue: DispatchQueue,
    id: u64,
}

impl DispatchQueue {
    pub(crate) fn worker(&self, approval: &str) -> Option<Worker> {
        if !self
            .0
            .state
            .lock()
            .unwrap()
            .workers
            .insert(approval.to_owned())
        {
            return None;
        }
        Some(Worker {
            queue: self.clone(),
            approval: approval.to_owned(),
        })
    }
    pub(crate) fn enqueue(&self, job: &str, interactive: bool) -> Ticket {
        let mut state = self.0.state.lock().unwrap();
        state.next += 1;
        let id = state.next;
        state.waiting.push(Entry {
            id,
            job: job.to_owned(),
            interactive,
        });
        Ticket {
            queue: self.clone(),
            id,
        }
    }
    pub(crate) fn is_waiting(&self, job: &str) -> bool {
        self.0
            .state
            .lock()
            .unwrap()
            .waiting
            .iter()
            .any(|entry| entry.job == job)
    }
}
impl Ticket {
    pub(crate) fn try_acquire(&self) -> Option<Permit> {
        let mut state = self.queue.0.state.lock().unwrap();
        if state.active.is_some() {
            return None;
        }
        // Three interactive turns at most before an already waiting bulk turn.
        // This keeps phrase explanations responsive without starving transcription.
        let background_due =
            state.interactive_streak >= 3 && state.waiting.iter().any(|entry| !entry.interactive);
        let selected = state.waiting.iter().min_by_key(|entry| {
            (
                if background_due {
                    entry.interactive
                } else {
                    !entry.interactive
                },
                entry.id,
            )
        })?;
        if selected.id != self.id {
            return None;
        }
        let interactive = selected.interactive;
        state.waiting.retain(|entry| entry.id != self.id);
        state.active = Some(self.id);
        state.interactive_streak = if interactive {
            state.interactive_streak + 1
        } else {
            0
        };
        Some(Permit {
            queue: self.queue.clone(),
            id: self.id,
        })
    }
    pub(crate) async fn changed(&self) {
        // A bounded wait also checks pause/cancel/source changes if no lane event arrives.
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            self.queue.0.changed.notified(),
        )
        .await;
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        self.queue
            .0
            .state
            .lock()
            .unwrap()
            .waiting
            .retain(|entry| entry.id != self.id);
        self.queue.0.changed.notify_waiters();
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self.queue.0.state.lock().unwrap();
        if state.active == Some(self.id) {
            state.active = None;
        }
        drop(state);
        self.queue.0.changed.notify_waiters();
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.queue
            .0
            .state
            .lock()
            .unwrap()
            .workers
            .remove(&self.approval);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interactive_waits_for_current_request_then_preempts_next_bulk_chunk() {
        let queue = DispatchQueue::default();
        let first = queue.enqueue("transcribe", false);
        let active = first.try_acquire().unwrap();
        let bulk = queue.enqueue("transcribe", false);
        let phrase = queue.enqueue("explain", true);
        assert!(phrase.try_acquire().is_none());
        assert!(bulk.try_acquire().is_none());
        drop(active);
        assert!(bulk.try_acquire().is_none());
        let interactive = phrase.try_acquire().unwrap();
        assert!(bulk.try_acquire().is_none());
        drop(interactive);
        assert!(bulk.try_acquire().is_some());
    }
    #[test]
    fn cancelled_waiters_and_duplicate_workers_do_not_block_and_bulk_cannot_starve() {
        let queue = DispatchQueue::default();
        let worker = queue.worker("approval").unwrap();
        assert!(queue.worker("approval").is_none());
        let cancelled = queue.enqueue("cancelled", true);
        drop(cancelled);
        assert!(!queue.is_waiting("cancelled"));
        let bulk = queue.enqueue("bulk", false);
        for index in 0..3 {
            let ticket = queue.enqueue(&format!("phrase-{index}"), true);
            drop(ticket.try_acquire().unwrap());
        }
        let next = queue.enqueue("next", true);
        assert!(next.try_acquire().is_none());
        drop(bulk.try_acquire().unwrap());
        assert!(next.try_acquire().is_some());
        drop(worker);
        assert!(queue.worker("approval").is_some());
    }
}
