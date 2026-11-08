use crate::{
    application::tool_runtime::selection,
    application::{AppState, Preferences, Services, UpdateCheck, err},
};
use anyhow::{Result, ensure};
use std::{future::Future, time::Duration};
use surtitle_tools::{CancellationToken, ToolKind, ToolSelection};

const CACHE_AGE_MS: i64 = 24 * 3_600_000;
const WAKE_INTERVAL: Duration = Duration::from_secs(15 * 60);

pub(crate) fn latest_version(
    p: &Preferences,
    kind: ToolKind,
    install_id: Option<&str>,
) -> Option<String> {
    if !matches!(selection(p, kind), ToolSelection::Managed) {
        return None;
    }
    p.update_checks
        .get(kind.directory())
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
    check_with(state, force, |kind| async move {
        state
            .tools
            .manager
            .check_latest(kind, &state.tools.shutdown)
            .await
            .map(|release| release.version)
    })
    .await
}

async fn check_with<F, Fut>(state: &Services, force: bool, mut lookup: F) -> Result<()>
where
    F: FnMut(ToolKind) -> Fut,
    Fut: Future<Output = Result<String>>,
{
    let _checking = state.tools.update_check.lock().await;
    let kind = ToolKind::FfmpegPair;
    ensure!(
        !state.tools.shutdown.is_cancelled(),
        "Update check cancelled"
    );
    let p = state.preferences.read()?.clone();
    if !matches!(selection(&p, kind), ToolSelection::Managed) {
        return Ok(());
    }
    let installed = match state.tools.manager.installed(kind) {
        Ok(Some(installed)) => installed,
        Ok(None) => return Ok(()),
        Err(error) => {
            return Err(anyhow::anyhow!("{}: {error}", kind.directory()));
        }
    };
    let key = kind.directory().to_owned();
    if !force
        && cache_fresh(
            &p,
            &key,
            &installed.install_id,
            chrono::Utc::now().timestamp_millis(),
        )
    {
        return Ok(());
    }
    match lookup(kind).await {
        Ok(version) => {
            ensure!(
                !state.tools.shutdown.is_cancelled(),
                "Update check cancelled"
            );
            state.preferences.update_if(|p| {
                // A late result cannot change the newly selected provider.
                if !matches!(selection(p, kind), ToolSelection::Managed)
                    || state
                        .tools
                        .manager
                        .installed(kind)?
                        .is_none_or(|current| current.install_id != installed.install_id)
                {
                    return Ok(false);
                }
                p.update_checks.insert(
                    key,
                    UpdateCheck {
                        checked_at_ms: chrono::Utc::now().timestamp_millis(),
                        version,
                        install_id: installed.install_id,
                    },
                );
                Ok(true)
            })?;
            state
                .changes
                .publish(super::changes::ChangeDomain::Tools, None);
        }
        Err(error) => return Err(anyhow::anyhow!("{}: {error}", kind.directory())),
    }
    Ok(())
}

pub async fn check_tool_updates(state: AppState) -> std::result::Result<(), String> {
    check(&state, true).await.map_err(err)
}

pub(crate) async fn run(state: AppState) {
    periodic(&state.tools.shutdown, WAKE_INTERVAL, || {
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
