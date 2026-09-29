use super::*;
use std::io::ErrorKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaFileValidationReason {
    InvalidPath,
    Missing,
    Directory,
    Empty,
    Unsupported,
    Unreadable,
}

impl MediaFileValidationReason {
    fn message(self) -> &'static str {
        match self {
            Self::InvalidPath => "Select an absolute path to a media file",
            Self::Missing => "The selected file no longer exists",
            Self::Directory => "Choose individual media files instead of a folder",
            Self::Empty => "The selected file is empty",
            Self::Unsupported => "This file type is not supported for media import",
            Self::Unreadable => "The selected file could not be read",
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MediaFileValidation {
    Ready {
        input_path: String,
        canonical_path: String,
    },
    Existing {
        input_path: String,
        canonical_path: String,
        media_id: String,
    },
    Invalid {
        input_path: String,
        reason: MediaFileValidationReason,
    },
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMediaImportResult {
    pub media_id: String,
    pub created: bool,
}

fn file_error(error: std::io::Error) -> MediaFileValidationReason {
    match error.kind() {
        ErrorKind::NotFound => MediaFileValidationReason::Missing,
        ErrorKind::InvalidInput => MediaFileValidationReason::InvalidPath,
        _ => MediaFileValidationReason::Unreadable,
    }
}

fn checked_media_path(path: &Path) -> std::result::Result<PathBuf, MediaFileValidationReason> {
    if !path.is_absolute() {
        return Err(MediaFileValidationReason::InvalidPath);
    }
    let metadata = path.metadata().map_err(file_error)?;
    if metadata.is_dir() {
        return Err(MediaFileValidationReason::Directory);
    }
    if !metadata.is_file() {
        return Err(MediaFileValidationReason::InvalidPath);
    }
    if metadata.len() == 0 {
        return Err(MediaFileValidationReason::Empty);
    }
    let path = path.canonicalize().map_err(file_error)?;
    if !path.extension().is_some_and(|extension| {
        MEDIA_EXTENSIONS
            .iter()
            .any(|supported| extension.eq_ignore_ascii_case(supported))
    }) {
        return Err(MediaFileValidationReason::Unsupported);
    }
    // A file can have readable metadata while access to its contents is denied.
    std::fs::File::open(&path).map_err(file_error)?;
    Ok(path)
}

fn checked_languages<'a>(learning: &'a str, explanation: &'a str) -> Result<(&'a str, &'a str)> {
    let (learning, explanation) = (learning.trim(), explanation.trim());
    ensure!(
        !learning.is_empty()
            && !explanation.is_empty()
            && learning.len() <= 100
            && explanation.len() <= 100,
        "Media import requires learning and explanation languages"
    );
    Ok((learning, explanation))
}

fn existing_paths(media: Vec<Media>) -> Vec<(PathBuf, Media)> {
    media
        .into_iter()
        .filter_map(|media| {
            Path::new(&media.path)
                .canonicalize()
                .ok()
                .map(|path| (path, media))
        })
        .collect()
}

fn existing_media_id<'a>(
    existing: &'a [(PathBuf, Media)],
    path: &Path,
    learning: &str,
    explanation: &str,
) -> Option<&'a str> {
    existing.iter().find_map(|(candidate, media)| {
        (candidate == path
            && media
                .learning_language
                .trim()
                .eq_ignore_ascii_case(learning)
            && media
                .explanation_language
                .trim()
                .eq_ignore_ascii_case(explanation))
        .then_some(media.id.as_str())
    })
}

pub fn validate_media_files(
    state: AppState,
    paths: Vec<String>,
    learning_language: String,
    explanation_language: String,
) -> IpcResult<Vec<MediaFileValidation>> {
    (|| {
        let (learning, explanation) = checked_languages(&learning_language, &explanation_language)?;
        let media = lock(&state.db)?.list_media()?;
        let existing = existing_paths(media);
        Ok(paths
            .into_iter()
            .map(
                |input_path| match checked_media_path(Path::new(&input_path)) {
                    Ok(path) => {
                        let canonical_path = path.to_string_lossy().into_owned();
                        match existing_media_id(&existing, &path, learning, explanation) {
                            Some(media_id) => MediaFileValidation::Existing {
                                input_path,
                                canonical_path,
                                media_id: media_id.into(),
                            },
                            None => MediaFileValidation::Ready {
                                input_path,
                                canonical_path,
                            },
                        }
                    }
                    Err(reason) => MediaFileValidation::Invalid { input_path, reason },
                },
            )
            .collect())
    })()
    .map_err(err)
}

pub fn import_local_media(
    state: AppState,
    request: ImportRequest,
) -> IpcResult<LocalMediaImportResult> {
    (|| {
        ensure!(request.kind == "local", "invalid import kind");
        let (learning, explanation) =
            checked_languages(&request.learning_language, &request.explanation_language)?;
        let path = checked_media_path(Path::new(&request.path_or_url))
            .map_err(|reason| anyhow::anyhow!(reason.message()))?;
        // Keep duplicate detection and insertion within the same lock. Validation
        // in the dialog is only a preview and may be stale when this runs.
        let db = lock(&state.db)?;
        let existing = existing_paths(db.list_media()?);
        if let Some(media_id) = existing_media_id(&existing, &path, learning, explanation) {
            return Ok(LocalMediaImportResult {
                media_id: media_id.into(),
                created: false,
            });
        }
        let media = imported_media(&path, None, request.title, learning, explanation);
        db.put_media(&media)?;
        Ok(LocalMediaImportResult {
            media_id: media.id,
            created: true,
        })
    })()
    .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, AppState) {
        let directory = tempfile::tempdir().unwrap();
        let state =
            Services::open_with_tool_path(directory.path().join("data"), std::ffi::OsStr::new(""))
                .unwrap();
        (directory, state)
    }

    fn request(path: &Path) -> ImportRequest {
        ImportRequest {
            kind: "local".into(),
            path_or_url: path.to_string_lossy().into_owned(),
            title: None,
            learning_language: "en".into(),
            explanation_language: "ja".into(),
        }
    }

    #[test]
    fn mixed_selection_reports_each_problem_without_importing() {
        let (directory, state) = fixture();
        let valid = directory.path().join("日本語 video.MP4");
        let folder = directory.path().join("folder.mp4");
        let empty = directory.path().join("empty.mp3");
        let unsupported = directory.path().join("notes.txt");
        let missing = directory.path().join("missing.webm");
        std::fs::write(&valid, b"video").unwrap();
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(&empty, []).unwrap();
        std::fs::write(&unsupported, b"notes").unwrap();
        let paths: Vec<String> = [&valid, &folder, &empty, &unsupported, &missing]
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .chain(["relative.mp4".into()])
            .collect();
        let results =
            validate_media_files(state.clone(), paths.clone(), "en".into(), "ja".into()).unwrap();
        assert_eq!(
            results[0],
            MediaFileValidation::Ready {
                input_path: paths[0].clone(),
                canonical_path: valid.canonicalize().unwrap().to_string_lossy().into_owned(),
            }
        );
        for (index, reason) in [
            MediaFileValidationReason::Directory,
            MediaFileValidationReason::Empty,
            MediaFileValidationReason::Unsupported,
            MediaFileValidationReason::Missing,
            MediaFileValidationReason::InvalidPath,
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(
                results[index + 1],
                MediaFileValidation::Invalid {
                    input_path: paths[index + 1].clone(),
                    reason,
                }
            );
        }
        assert!(lock(&state.db).unwrap().list_media().unwrap().is_empty());
    }

    #[test]
    fn canonical_duplicate_preserves_media_and_language_pair_controls_identity() {
        let (directory, state) = fixture();
        let source = directory.path().join("video.mkv");
        std::fs::write(&source, b"video").unwrap();
        let mut original_request = request(&source);
        original_request.title = Some("Original title".into());
        original_request.learning_language = " EN ".into();
        original_request.explanation_language = " JA ".into();
        let first = import_local_media(state.clone(), original_request).unwrap();
        assert!(first.created);
        let subdirectory = directory.path().join("subdirectory");
        std::fs::create_dir(&subdirectory).unwrap();
        let alias = subdirectory.join("..").join("video.mkv");
        let mut duplicate_request = request(&alias);
        duplicate_request.title = Some("Do not overwrite".into());
        let duplicate = import_local_media(state.clone(), duplicate_request).unwrap();
        assert_eq!(duplicate.media_id, first.media_id);
        assert!(!duplicate.created);
        let saved = lock(&state.db).unwrap().media(&first.media_id).unwrap();
        assert_eq!(saved.title, "Original title");
        assert_eq!(saved.learning_language, "EN");
        assert_eq!(saved.explanation_language, "JA");
        let results = validate_media_files(
            state.clone(),
            vec![alias.to_string_lossy().into_owned()],
            " en ".into(),
            "ja".into(),
        )
        .unwrap();
        assert!(matches!(
            &results[0],
            MediaFileValidation::Existing { media_id, .. } if media_id == &first.media_id
        ));
        for (learning, explanation) in [("fr", "ja"), ("en", "de")] {
            let mut other_language = request(&source);
            other_language.learning_language = learning.into();
            other_language.explanation_language = explanation.into();
            assert!(
                import_local_media(state.clone(), other_language)
                    .unwrap()
                    .created
            );
        }
        assert_eq!(lock(&state.db).unwrap().list_media().unwrap().len(), 3);
    }

    #[test]
    fn simultaneous_local_imports_create_one_media() {
        let (directory, state) = fixture();
        let source = directory.path().join("video.mp4");
        std::fs::write(&source, b"video").unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(4));
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let (state, barrier, request) = (state.clone(), barrier.clone(), request(&source));
                std::thread::spawn(move || {
                    barrier.wait();
                    import_local_media(state, request).unwrap()
                })
            })
            .collect();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.created).count(), 1);
        assert!(
            results
                .iter()
                .all(|result| result.media_id == results[0].media_id)
        );
        assert_eq!(lock(&state.db).unwrap().list_media().unwrap().len(), 1);
    }

    #[test]
    fn submit_rechecks_file_and_rejects_invalid_requests() {
        let (directory, state) = fixture();
        let source = directory.path().join("video.mp4");
        std::fs::write(&source, b"video").unwrap();
        assert!(matches!(
            validate_media_files(
                state.clone(),
                vec![source.to_string_lossy().into_owned()],
                "en".into(),
                "ja".into(),
            )
            .unwrap()[0],
            MediaFileValidation::Ready { .. }
        ));
        std::fs::remove_file(&source).unwrap();
        assert!(import_local_media(state.clone(), request(&source)).is_err());
        std::fs::write(&source, b"video").unwrap();
        let mut invalid = request(&source);
        invalid.learning_language = " ".into();
        assert!(import_local_media(state.clone(), invalid).is_err());
        let mut invalid = request(&source);
        invalid.kind = "url".into();
        assert!(import_local_media(state.clone(), invalid).is_err());
        assert!(lock(&state.db).unwrap().list_media().unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn selection_reports_locked_file_as_unreadable() {
        use std::os::windows::fs::OpenOptionsExt;
        let (directory, state) = fixture();
        let source = directory.path().join("locked.mp4");
        std::fs::write(&source, b"video").unwrap();
        let _exclusive_file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&source)
            .unwrap();
        let results = validate_media_files(
            state,
            vec![source.to_string_lossy().into_owned()],
            "en".into(),
            "ja".into(),
        )
        .unwrap();
        assert!(matches!(
            results[0],
            MediaFileValidation::Invalid {
                reason: MediaFileValidationReason::Unreadable,
                ..
            }
        ));
    }

    #[test]
    fn validation_wire_contract_uses_frontend_discriminants_and_camel_case() {
        let ready = MediaFileValidation::Ready {
            input_path: "input".into(),
            canonical_path: "canonical".into(),
        };
        assert_eq!(
            serde_json::to_value(ready).unwrap(),
            serde_json::json!({
                "status": "ready", "inputPath": "input", "canonicalPath": "canonical"
            })
        );
        let invalid = MediaFileValidation::Invalid {
            input_path: "input".into(),
            reason: MediaFileValidationReason::InvalidPath,
        };
        assert_eq!(
            serde_json::to_value(invalid).unwrap(),
            serde_json::json!({
                "status": "invalid", "inputPath": "input", "reason": "invalidPath"
            })
        );
        assert_eq!(
            serde_json::to_value(LocalMediaImportResult {
                media_id: "media".into(),
                created: true,
            })
            .unwrap(),
            serde_json::json!({ "mediaId": "media", "created": true })
        );
    }
}
