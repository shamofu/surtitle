//! User-visible lifecycle evidence. Only provider answer text is kept in memory;
//! persisted history contains bounded, typed phases, never prompts or diagnostics.
use crate::application::{AppState, err, lock};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use surtitle_ai::{ExecutionEvent, ExecutionObserver, ExecutionStage};

const MAX_PREVIEW_BYTES: usize = 1024 * 1024;
const MAX_HISTORY_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    id: String,
    timestamp: String,
    phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ordinal: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePreview {
    attempt_id: String,
    ordinal: u32,
    text: String,
    state: String,
    truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    job_id: String,
    approval_id: String,
    revision: u64,
    events: Vec<RuntimeEvent>,
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    preview: Option<RuntimePreview>,
}

type Publisher = Arc<dyn Fn(&RuntimeSnapshot) + Send + Sync>;
#[derive(Default)]
pub(crate) struct RuntimeRegistry {
    ordering: Mutex<()>,
    values: Mutex<HashMap<String, RuntimeSnapshot>>,
    last_published: Mutex<HashMap<String, Instant>>,
    publisher: Mutex<Option<Publisher>>,
}

pub(crate) fn install_publisher(
    state: &AppState,
    publish: impl Fn(&RuntimeSnapshot) + Send + Sync + 'static,
) -> Result<()> {
    *lock(&state.ai_session.runtime.publisher)? = Some(Arc::new(publish));
    Ok(())
}

fn history_path(state: &AppState, job_id: &str) -> std::path::PathBuf {
    state.root.join("ai-progress").join(format!(
        "{}.json",
        surtitle_ai::sha256_bytes(job_id.as_bytes())
    ))
}

fn read_history(state: &AppState, job_id: &str) -> Result<Option<RuntimeSnapshot>> {
    let path = history_path(state, job_id);
    if !path.is_file() {
        return Ok(None);
    }
    ensure!(
        path.metadata()?.len() <= MAX_HISTORY_BYTES,
        "AI progress history is too large"
    );
    let snapshot: RuntimeSnapshot = serde_json::from_reader(std::fs::File::open(path)?)?;
    ensure!(
        snapshot.job_id == job_id,
        "AI progress history does not match this job"
    );
    Ok(Some(snapshot))
}

pub fn get_ai_runtime(
    state: AppState,
    job_id: String,
) -> std::result::Result<Option<RuntimeSnapshot>, String> {
    (|| {
        state.ai.quote(&job_id)?;
        if let Some(snapshot) = lock(&state.ai_session.runtime.values)?
            .get(&job_id)
            .cloned()
        {
            return Ok(Some(snapshot));
        }
        read_history(&state, &job_id)
    })()
    .map_err(err)
}

pub(crate) fn observer(state: AppState) -> ExecutionObserver {
    Arc::new(move |event| {
        // Progress cannot alter the charge ledger or hide an execution result.
        // Accounting and validated results are independently durable.
        let _ = record_provider(&state, event);
    })
}

pub(crate) fn begin(state: &AppState, job_id: &str, approval_id: &str) -> Result<()> {
    let _ordering = lock(&state.ai_session.runtime.ordering)?;
    if !state.ai.approval_is_current(job_id, approval_id)? {
        return Ok(());
    }
    // Approval changes are visible before source verification or the first
    // reservation, so a reconnect cannot show the preceding attempt's preview.
    record_detail(
        state,
        job_id,
        approval_id,
        "preparing",
        EventDetail::default(),
    )
}

fn record_provider(state: &AppState, event: ExecutionEvent) -> Result<()> {
    // Serialize the approval check with all runtime publications: an older
    // callback cannot overwrite a newer approval after waiting for the cache.
    let _ordering = lock(&state.ai_session.runtime.ordering)?;
    let Some(approval_id) = event.approval_id.as_deref() else {
        return Ok(());
    };
    if !state.ai.approval_is_current(&event.job_id, approval_id)? {
        return Ok(());
    }
    let phase = match event.stage {
        ExecutionStage::Preparing => "preparing",
        ExecutionStage::Sending => "sending",
        ExecutionStage::Receiving => "receiving",
        ExecutionStage::Validating => "validating",
        ExecutionStage::Settled => "settled",
        ExecutionStage::Rejected => "rejected",
        ExecutionStage::Unknown => "unknown",
    };
    record_detail(
        state,
        &event.job_id,
        approval_id,
        phase,
        EventDetail {
            request: Some((event.ordinal, &event.attempt_id)),
            delta: event.text_delta.as_deref(),
            reason: event.rejection_reason.map(|reason| reason.code()),
            http_status: event.http_status,
        },
    )
}

pub(crate) fn finish(state: &AppState, job_id: &str, approval_id: &str, phase: &str) -> Result<()> {
    let _ordering = lock(&state.ai_session.runtime.ordering)?;
    ensure!(
        ["completed", "partial", "failed", "stopped"].contains(&phase),
        "Invalid runtime outcome"
    );
    if !state.ai.approval_is_current(job_id, approval_id)? {
        return Ok(());
    }
    let issue = state.ai.job_issue(job_id)?;
    record_detail(
        state,
        job_id,
        approval_id,
        phase,
        EventDetail {
            reason: issue.as_ref().map(|issue| issue.code.as_str()),
            http_status: issue.as_ref().and_then(|issue| issue.http_status),
            ..Default::default()
        },
    )
}

#[derive(Default)]
struct EventDetail<'a> {
    request: Option<(u32, &'a str)>,
    delta: Option<&'a str>,
    reason: Option<&'a str>,
    http_status: Option<u16>,
}

#[cfg(test)]
fn record(
    state: &AppState,
    job_id: &str,
    approval_id: &str,
    phase: &str,
    request: Option<(u32, &str)>,
    delta: Option<&str>,
) -> Result<()> {
    record_detail(
        state,
        job_id,
        approval_id,
        phase,
        EventDetail {
            request,
            delta,
            ..Default::default()
        },
    )
}

fn record_detail(
    state: &AppState,
    job_id: &str,
    approval_id: &str,
    phase: &str,
    detail: EventDetail<'_>,
) -> Result<()> {
    let EventDetail {
        request,
        delta,
        reason,
        http_status,
    } = detail;
    let registry = &state.ai_session.runtime;
    let mut values = lock(&registry.values)?;
    if !values.contains_key(job_id) {
        let prior = read_history(state, job_id)?.unwrap_or_else(|| RuntimeSnapshot {
            job_id: job_id.into(),
            approval_id: approval_id.into(),
            revision: 0,
            events: vec![],
            preview: None,
        });
        values.insert(job_id.into(), prior);
    }
    let value = values.get_mut(job_id).expect("runtime initialized");
    if value.approval_id != approval_id {
        value.approval_id = approval_id.into();
        value.preview = None;
    }
    value.revision += 1;
    let changed_phase = value.events.last().is_none_or(|last| {
        last.phase != phase
            || last.attempt_id.as_deref() != request.map(|(_, id)| id)
            || last.reason.as_deref() != reason
            || last.http_status != http_status
    });
    if changed_phase {
        value.events.push(RuntimeEvent {
            id: value.revision.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            phase: phase.into(),
            ordinal: request.map(|(ordinal, _)| ordinal),
            attempt_id: request.map(|(_, id)| id.into()),
            reason: reason.map(str::to_owned),
            http_status,
        });
    }
    if let Some((ordinal, attempt_id)) = request {
        if value
            .preview
            .as_ref()
            .is_some_and(|preview| preview.attempt_id != attempt_id)
        {
            value.preview = None;
        }
        if let Some(delta) = delta {
            let preview = value.preview.get_or_insert_with(|| RuntimePreview {
                attempt_id: attempt_id.into(),
                ordinal,
                text: String::new(),
                state: "streaming".into(),
                truncated: false,
            });
            let mut end = delta
                .len()
                .min(MAX_PREVIEW_BYTES.saturating_sub(preview.text.len()));
            while !delta.is_char_boundary(end) {
                end -= 1;
            }
            preview.truncated |= end < delta.len();
            preview.text.push_str(&delta[..end]);
        }
    }
    if let Some(preview) = value.preview.as_mut() {
        if phase == "settled" {
            preview.state = "validated".into();
        }
        if ["rejected", "unknown", "failed", "stopped"].contains(&phase)
            && preview.state != "validated"
        {
            preview.state = "rejected".into();
        }
    }
    // Never persist provisional generated text. Lifecycle events alone survive restart.
    let persisted = if changed_phase {
        let mut durable = value.clone();
        durable.preview = None;
        let path = history_path(state, job_id);
        (|| -> Result<()> {
            std::fs::create_dir_all(path.parent().expect("history directory"))?;
            surtitle_core::store::write_json_atomic(&path, &durable)?;
            Ok(())
        })()
    } else {
        Ok(())
    };
    let snapshot = value.clone();
    drop(values);
    let mut last = lock(&registry.last_published)?;
    let now = Instant::now();
    let publish = changed_phase
        || last
            .get(job_id)
            .is_none_or(|at| now.duration_since(*at) >= Duration::from_millis(100));
    if publish {
        last.insert(job_id.into(), now);
    }
    drop(last);
    if publish && let Some(publish) = lock(&registry.publisher)?.as_ref() {
        publish(&snapshot);
    }
    // Cache invalidation and live publication still take effect if writing the
    // optional history fails. Telemetry failure never revokes approval.
    persisted
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lifecycle_is_durable_but_preview_is_session_only() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::application::Services::open(root.path().to_path_buf()).unwrap();
        record(
            &state,
            "job",
            "approval",
            "receiving",
            Some((0, "attempt")),
            Some("{\"term\":\"秘密\"}"),
        )
        .unwrap();
        record(
            &state,
            "job",
            "approval",
            "receiving",
            Some((0, "attempt")),
            Some("more"),
        )
        .unwrap();
        let snapshot = lock(&state.ai_session.runtime.values)
            .unwrap()
            .get("job")
            .unwrap()
            .clone();
        assert_eq!(snapshot.events.len(), 1);
        assert_eq!(snapshot.revision, 2);
        assert!(snapshot.preview.unwrap().text.contains("秘密"));
        let saved = std::fs::read_to_string(history_path(&state, "job")).unwrap();
        assert!(!saved.contains("秘密"));
        assert!(
            read_history(&state, "job")
                .unwrap()
                .unwrap()
                .preview
                .is_none()
        );
    }
    #[test]
    fn new_attempt_or_approval_cannot_inherit_an_old_preview() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::application::Services::open(root.path().to_path_buf()).unwrap();
        record(
            &state,
            "job",
            "first",
            "receiving",
            Some((0, "a")),
            Some("old"),
        )
        .unwrap();
        record(&state, "job", "first", "rejected", Some((0, "a")), None).unwrap();
        record(&state, "job", "first", "sending", Some((1, "b")), None).unwrap();
        assert!(
            lock(&state.ai_session.runtime.values).unwrap()["job"]
                .preview
                .is_none()
        );
        record(
            &state,
            "job",
            "first",
            "receiving",
            Some((1, "b")),
            Some("new"),
        )
        .unwrap();
        record(&state, "job", "second", "preparing", Some((1, "c")), None).unwrap();
        let values = lock(&state.ai_session.runtime.values).unwrap();
        assert!(values["job"].preview.is_none());
        assert_eq!(values["job"].approval_id, "second");
        assert_eq!(values["job"].events.len(), 5);
    }
}
