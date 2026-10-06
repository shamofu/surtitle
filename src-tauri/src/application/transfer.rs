use super::*;
use anyhow::{Context, Result, bail, ensure};
use std::path::Path;
type IpcResult<T> = std::result::Result<T, String>;
use super::playback::restore_learning_archive;
use serde::Serialize;
mod transfer_dialog;
pub async fn export_learning(
    state: AppState,
    format: String,
    media_id: Option<String>,
) -> IpcResult<Vec<String>> {
    ensure_export_format(&format).map_err(err)?;
    let Some(path) = transfer_dialog::export_path(&state, &format)
        .await
        .map_err(err)?
    else {
        return Ok(vec![]);
    };
    export_to_path(&state, &format, media_id.as_deref(), path.as_path()).map_err(err)
}
fn export_to_path(
    state: &AppState,
    format: &str,
    media_id: Option<&str>,
    path: &Path,
) -> Result<Vec<String>> {
    let db = lock(&state.db)?;
    let archive = db.archive()?;
    let mut paths = vec![path.to_string_lossy().into_owned()];
    match format {
        "json" => surtitle_core::transfer::export_json(&archive, path)?,
        "zip" => {
            surtitle_core::transfer::export_zip(&archive, &state.root.join("card-audio"), path)?
        }
        "csv" | "tsv" => std::fs::write(
            path,
            surtitle_core::transfer::export_delimited(
                &archive.cards,
                if format == "csv" { ',' } else { '\t' },
            ),
        )?,
        "srt" | "vtt" => {
            let media_id = media_id.context("select a media item for subtitle export")?;
            let segments = db.list_segments(media_id)?;
            let translated = if segments.iter().any(|s| s.translation.is_some()) {
                let stem = path.file_stem().unwrap_or_default().to_string_lossy();
                let translated = path.with_file_name(format!("{stem}.translation.{format}"));
                ensure!(
                    !translated.exists(),
                    "translation output already exists; choose a different filename"
                );
                Some(translated)
            } else {
                None
            };
            // Validate both destinations before modifying the chosen original output.
            std::fs::write(
                path,
                surtitle_core::subtitles::format(&segments, format == "vtt", false),
            )?;
            if let Some(translated) = translated {
                std::fs::write(
                    &translated,
                    surtitle_core::subtitles::format(&segments, format == "vtt", true),
                )?;
                paths.push(translated.to_string_lossy().into_owned());
            }
        }
        _ => bail!("invalid export format"),
    };
    Ok(paths)
}

pub fn reveal_export_file(path: String) -> IpcResult<()> {
    (|| -> Result<()> {
        let path = std::path::PathBuf::from(path);
        ensure!(
            path.is_absolute() && path.is_file(),
            "Exported file could not be found"
        );
        #[cfg(windows)]
        {
            let windows = std::env::var_os("WINDIR").context("Windows directory is unavailable")?;
            std::process::Command::new(Path::new(&windows).join("explorer.exe"))
                .arg(path.parent().context("Export folder could not be found")?)
                .spawn()
                .context("Could not open the export folder")?;
        }
        #[cfg(not(windows))]
        bail!("Opening the export folder is only available in the Windows desktop app");
        #[cfg(windows)]
        Ok(())
    })()
    .map_err(err)
}
fn ensure_export_format(format: &str) -> Result<()> {
    ensure!(
        ["json", "zip", "csv", "tsv", "srt", "vtt"].contains(&format),
        "invalid export format"
    );
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    token: String,
    media_count: usize,
    card_count: usize,
    review_count: usize,
    audio_count: usize,
    warnings: Vec<String>,
}
pub async fn preview_restore(state: AppState) -> IpcResult<Option<RestorePreview>> {
    let Some(path) = transfer_dialog::restore_path(&state).await.map_err(err)? else {
        return Ok(None);
    };
    preview_restore_at(&state, &path).map(Some).map_err(err)
}
fn preview_restore_at(state: &AppState, path: &Path) -> Result<RestorePreview> {
    // Keep one current preview plus at most one serialized incoming snapshot.
    // A rejected file leaves the previously displayed preview usable.
    let mut restores = lock(&state.restores)?;
    let snapshot = crate::restore_snapshot::RestoreSnapshot::capture(&state.root, path)?;
    let archive = surtitle_core::transfer::read_archive(snapshot.path())?;
    snapshot.verify_snapshot()?;
    restores.clear();
    let token = surtitle_core::id();
    let warnings = if state.settings()?.locale == "en" {
        vec![
                "Current learning data will be replaced after creating a backup. Cost ledgers, credentials, execution approvals, and tool settings are not imported.".into(),
                "Media files that have moved must be selected again.".into(),
            ]
    } else {
        vec![
                "現在の学習データを置換し、直前のバックアップを作成します。費用台帳・鍵・実行承認・ツール設定はインポートしません。".into(),
                "移動した教材はファイルの再指定が必要です。".into(),
            ]
    };
    let result = RestorePreview {
        token: token.clone(),
        media_count: archive.media.len(),
        card_count: archive.cards.len(),
        review_count: archive.reviews.len(),
        audio_count: archive
            .cards
            .iter()
            .filter(|c| c.audio_path.is_some())
            .count(),
        warnings,
    };
    restores.insert(token, RestorePlan { snapshot, archive });
    Ok(result)
}
pub fn discard_restore_preview(state: AppState, token: String) -> IpcResult<()> {
    lock(&state.restores)
        .map(|mut plans| {
            plans.remove(&token);
        })
        .map_err(err)
}
pub async fn restore_learning(
    app: tauri::AppHandle,
    state: AppState,
    token: String,
) -> IpcResult<()> {
    let state = state.clone();
    let archive = take_restore_archive(&state, &token).map_err(err)?;
    on_main(app, move || restore_learning_archive(&state, &archive))
        .await
        .map_err(err)
}
fn take_restore_archive(state: &AppState, token: &str) -> Result<surtitle_core::LearningArchive> {
    let plan = take_restore_plan(state, token)?;
    materialize_restore_plan(state, plan)
}
fn take_restore_plan(state: &AppState, token: &str) -> Result<RestorePlan> {
    let plan = lock(&state.restores)?
        .remove(token)
        .context("restore preview expired")?;
    plan.snapshot.verify_original()?;
    plan.snapshot.verify_snapshot()?;
    Ok(plan)
}
fn materialize_restore_plan(
    state: &AppState,
    mut plan: RestorePlan,
) -> Result<surtitle_core::LearningArchive> {
    surtitle_core::transfer::materialize_audio(
        plan.snapshot.path(),
        &mut plan.archive,
        &state.root.join("card-audio"),
    )?;
    Ok(plan.archive)
}

#[cfg(test)]
mod export_tests;
#[cfg(test)]
mod restore_tests;
