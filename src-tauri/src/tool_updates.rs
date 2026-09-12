use crate::{
    service::{AppState, Preferences, Services, UpdateCheck, err, lock},
    tool_commands::{channel, selection},
};
use anyhow::{Result, ensure};
use std::{future::Future, time::Duration};
use surtitle_tools::{CancellationToken, ToolKind, ToolSelection, YtDlpChannel};
use tauri::State;

const CACHE_AGE_MS: i64 = 24 * 3_600_000;
const WAKE_INTERVAL: Duration = Duration::from_secs(15 * 60);

fn cache_key(kind: ToolKind, selected_channel: YtDlpChannel) -> String {
    if kind == ToolKind::YtDlp {
        match selected_channel {
            YtDlpChannel::Nightly => "yt-dlp/nightly",
            YtDlpChannel::Stable => "yt-dlp/stable",
        }
        .into()
    } else {
        kind.directory().into()
    }
}

pub(crate) fn latest_version(
    p: &Preferences,
    kind: ToolKind,
    install_id: Option<&str>,
) -> Option<String> {
    if !matches!(selection(p, kind), ToolSelection::Managed) {
        return None;
    }
    p.update_checks
        .get(&cache_key(kind, channel(p)))
        .filter(|entry| {
            !entry.install_id.is_empty() && Some(entry.install_id.as_str()) == install_id
        })
        .map(|entry| entry.version.clone())
}

fn cache_fresh(p: &Preferences, key: &str, install_id: &str, now: i64) -> bool {
    p.update_checks.get(key).is_some_and(|entry| {
        entry.install_id == install_id
            && now
                .checked_sub(entry.checked_at_ms)
                .is_some_and(|age| (0..CACHE_AGE_MS).contains(&age))
    })
}

/// Only public release metadata is read. Installation stays an explicit command.
async fn check(state: &Services, force: bool) -> Result<()> {
    check_with(state, force, |kind, selected_channel| async move {
        state
            .tools
            .check_latest(kind, selected_channel, &state.tool_update_shutdown)
            .await
            .map(|release| release.version)
    })
    .await
}

async fn check_with<F, Fut>(state: &Services, force: bool, mut lookup: F) -> Result<()>
where
    F: FnMut(ToolKind, YtDlpChannel) -> Fut,
    Fut: Future<Output = Result<String>>,
{
    let _checking = state.tool_update_check.lock().await;
    let mut failures = Vec::new();
    for kind in [ToolKind::FfmpegPair, ToolKind::YtDlp, ToolKind::Deno] {
        ensure!(
            !state.tool_update_shutdown.is_cancelled(),
            "Update check cancelled"
        );
        let p = lock(&state.preferences)?.clone();
        if !matches!(selection(&p, kind), ToolSelection::Managed) {
            continue;
        }
        let installed = match state.tools.installed(kind) {
            Ok(Some(installed)) => installed,
            Ok(None) => continue,
            Err(error) => {
                failures.push(format!("{}: {error}", kind.directory()));
                continue;
            }
        };
        let selected_channel = channel(&p);
        let key = cache_key(kind, selected_channel);
        if !force
            && cache_fresh(
                &p,
                &key,
                &installed.install_id,
                chrono::Utc::now().timestamp_millis(),
            )
        {
            continue;
        }
        match lookup(kind, selected_channel).await {
            Ok(version) => {
                ensure!(
                    !state.tool_update_shutdown.is_cancelled(),
                    "Update check cancelled"
                );
                let mut p = lock(&state.preferences)?;
                // A late result cannot change the newly selected provider/channel.
                if !matches!(selection(&p, kind), ToolSelection::Managed)
                    || cache_key(kind, channel(&p)) != key
                    || state
                        .tools
                        .installed(kind)?
                        .is_none_or(|current| current.install_id != installed.install_id)
                {
                    continue;
                }
                let mut updated = p.clone();
                updated.update_checks.insert(
                    key,
                    UpdateCheck {
                        checked_at_ms: chrono::Utc::now().timestamp_millis(),
                        version,
                        install_id: installed.install_id,
                    },
                );
                state.save_preferences(&updated)?;
                *p = updated;
            }
            Err(error) => failures.push(format!("{}: {error}", kind.directory())),
        }
    }
    ensure!(failures.is_empty(), "{}", failures.join("; "));
    Ok(())
}

#[tauri::command]
pub async fn check_tool_updates(state: State<'_, AppState>) -> std::result::Result<(), String> {
    check(state.inner(), true).await.map_err(err)
}

pub(crate) async fn run(state: AppState) {
    periodic(&state.tool_update_shutdown, WAKE_INTERVAL, || {
        check(&state, false)
    })
    .await;
}

async fn periodic<F, Fut>(shutdown: &CancellationToken, interval: Duration, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<()>>,
{
    while !shutdown.is_cancelled() {
        let _ = check().await;
        if tokio::time::timeout(interval, shutdown.cancelled())
            .await
            .is_ok()
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests;
