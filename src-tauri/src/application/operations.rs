//! Session-only progress for native work that does not have a durable job store.
use super::{AppState, err, lock};
use anyhow::{Result, ensure};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationProgress {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub phase: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_id: Option<String>,
}

#[derive(Default)]
pub(crate) struct OperationContext<'a> {
    pub id: Option<String>,
    pub media_id: Option<&'a str>,
    pub tool_id: Option<&'a str>,
    pub parent_id: Option<&'a str>,
}

#[derive(Default)]
struct RegistryState {
    sequence: u64,
    entries: HashMap<String, (u64, OperationProgress)>,
}

#[derive(Default, Clone)]
pub(crate) struct OperationRegistry(Arc<Mutex<RegistryState>>);

impl OperationRegistry {
    pub fn start(
        &self,
        kind: &str,
        label: &str,
        context: OperationContext<'_>,
    ) -> Result<Operation> {
        let id = context.id.unwrap_or_else(surtitle_core::id);
        ensure!(uuid::Uuid::parse_str(&id).is_ok(), "Invalid operation ID");
        let mut state = lock(&self.0)?;
        ensure!(
            !state.entries.contains_key(&id),
            "Operation ID is already in use"
        );
        state.sequence += 1;
        let sequence = state.sequence;
        state.entries.insert(
            id.clone(),
            (
                sequence,
                OperationProgress {
                    id: id.clone(),
                    kind: kind.into(),
                    status: "running".into(),
                    phase: "preparing".into(),
                    label: label.into(),
                    media_id: context.media_id.map(str::to_owned),
                    tool_id: context.tool_id.map(str::to_owned),
                    parent_id: context.parent_id.map(str::to_owned),
                    completed: None,
                    total: None,
                    unit: None,
                    error: None,
                    updated_at: surtitle_core::now(),
                    result_id: None,
                },
            ),
        );
        Ok(Operation {
            reporter: OperationReporter {
                registry: self.clone(),
                id,
            },
            finished: false,
        })
    }

    pub fn list(&self) -> Result<Vec<OperationProgress>> {
        let state = lock(&self.0)?;
        let mut entries = state.entries.values().collect::<Vec<_>>();
        entries.sort_by_key(|(sequence, _)| std::cmp::Reverse(*sequence));
        Ok(entries
            .into_iter()
            .map(|(_, snapshot)| snapshot.clone())
            .collect())
    }

    fn update(&self, id: &str, update: impl FnOnce(&mut OperationProgress)) {
        let Ok(mut state) = lock(&self.0) else { return };
        if !state
            .entries
            .get(id)
            .is_some_and(|(_, entry)| entry.status == "running")
        {
            return;
        }
        state.sequence += 1;
        let sequence = state.sequence;
        if let Some((order, entry)) = state.entries.get_mut(id) {
            update(entry);
            entry.updated_at = surtitle_core::now();
            *order = sequence;
        }
        // Preserve every active operation. Terminal entries survive at least until
        // twenty newer operations finish, including work shorter than one poll.
        let mut terminal = state
            .entries
            .iter()
            .filter(|(_, (_, entry))| entry.status != "running")
            .map(|(id, (order, _))| (id.clone(), *order))
            .collect::<Vec<_>>();
        terminal.sort_by_key(|(_, order)| std::cmp::Reverse(*order));
        for (id, _) in terminal.into_iter().skip(20) {
            state.entries.remove(&id);
        }
    }
}

#[derive(Clone)]
pub(crate) struct OperationReporter {
    registry: OperationRegistry,
    id: String,
}
impl OperationReporter {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn progress(
        &self,
        phase: &str,
        completed: Option<u64>,
        total: Option<u64>,
        unit: Option<&str>,
    ) {
        self.registry.update(&self.id, |entry| {
            entry.phase = phase.into();
            entry.completed = completed;
            entry.total = total.filter(|total| *total > 0);
            entry.unit = unit.map(str::to_owned);
        });
    }
}

pub(crate) struct Operation {
    reporter: OperationReporter,
    finished: bool,
}
impl Operation {
    pub fn reporter(&self) -> OperationReporter {
        self.reporter.clone()
    }
    pub fn finish<T>(mut self, result: &Result<T>, cancelled: bool, result_id: Option<&str>) {
        self.reporter.registry.update(&self.reporter.id, |entry| {
            entry.status = match result {
                Ok(_) => "completed",
                Err(_) if cancelled => "cancelled",
                Err(_) => "failed",
            }
            .into();
            if result.is_ok() {
                entry.phase = "completed".into();
            }
            entry.error = result.as_ref().err().map(ToString::to_string);
            entry.result_id = result_id.map(str::to_owned);
        });
        self.finished = true;
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if !self.finished {
            self.reporter.registry.update(&self.reporter.id, |entry| {
                entry.status = "failed".into();
                entry.error = Some("Operation interrupted before completion".into());
            });
        }
    }
}

pub fn list_operation_progress(
    state: AppState,
) -> std::result::Result<Vec<OperationProgress>, String> {
    state.operations.list().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_clear_measurements_and_late_updates_cannot_revive_completion() {
        let registry = OperationRegistry::default();
        let operation = registry
            .start("tool", "FFmpeg", OperationContext::default())
            .unwrap();
        let reporter = operation.reporter();
        reporter.progress("downloading", Some(50), Some(100), Some("bytes"));
        assert_eq!(registry.list().unwrap()[0].completed, Some(50));
        reporter.progress("verifying", None, None, None);
        assert_eq!(registry.list().unwrap()[0].total, None);
        operation.finish(&Ok(()), false, None);
        reporter.progress("downloading", Some(90), Some(100), Some("bytes"));
        let entry = &registry.list().unwrap()[0];
        assert_eq!(entry.status, "completed");
        assert_eq!(entry.phase, "completed");
    }

    #[test]
    fn keeps_active_work_and_twenty_recent_terminal_results_with_unique_identity() {
        let registry = OperationRegistry::default();
        let active = registry
            .start("preparation", "media", OperationContext::default())
            .unwrap();
        let active_id = active.reporter().id().to_owned();
        for _ in 0..25 {
            let op = registry
                .start("tool", "same tool", OperationContext::default())
                .unwrap();
            op.finish(&Ok(()), false, None);
        }
        let entries = registry.list().unwrap();
        assert_eq!(entries.len(), 21);
        assert!(
            entries
                .iter()
                .any(|entry| entry.id == active_id && entry.status == "running")
        );
        assert!(
            registry
                .start(
                    "tool",
                    "duplicate",
                    OperationContext {
                        id: Some(active_id),
                        ..Default::default()
                    }
                )
                .is_err()
        );
    }

    #[test]
    fn cancellation_failures_and_abandoned_work_have_terminal_outcomes() {
        let registry = OperationRegistry::default();
        for cancelled in [false, true] {
            let op = registry
                .start("tool", "test", OperationContext::default())
                .unwrap();
            op.finish::<()>(&Err(anyhow::anyhow!("stopped")), cancelled, None);
            let entry = &registry.list().unwrap()[0];
            assert_eq!(entry.status, if cancelled { "cancelled" } else { "failed" });
            assert_eq!(entry.error.as_deref(), Some("stopped"));
        }
        drop(
            registry
                .start("preparation", "abandoned", OperationContext::default())
                .unwrap(),
        );
        assert_eq!(registry.list().unwrap()[0].status, "failed");
    }
}
