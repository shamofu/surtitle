use crate::*;
use anyhow::{Context, Result, ensure};
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

const MAX_JSON: u64 = 256 * 1024 * 1024;
const MAX_AUDIO: u64 = 64 * 1024 * 1024;
const MAX_TOTAL: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone, Copy)]
struct ExportLimits {
    json: u64,
    audio: u64,
    total: u64,
}
const EXPORT_LIMITS: ExportLimits = ExportLimits {
    json: MAX_JSON,
    audio: MAX_AUDIO,
    total: MAX_TOTAL,
};

/// Count bytes actually written, including a source that grows after metadata
/// inspection. ZIP budgets refer to uncompressed contents, as the importer does.
struct LimitedWriter<'a, W> {
    inner: &'a mut W,
    limit: u64,
    written: u64,
}
impl<W: Write> Write for LimitedWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() as u64 > self.limit.saturating_sub(self.written) {
            return Err(std::io::Error::other(
                "backup content exceeds its restore limit",
            ));
        }
        let written = self.inner.write(bytes)?;
        self.written += written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Only a successfully finished export replaces the destination. Cleanup is
/// limited to the uniquely created temporary file, never an existing backup.
struct PendingExport {
    path: Option<PathBuf>,
    file: Option<File>,
}
impl PendingExport {
    fn create(destination: &Path) -> Result<Self> {
        let parent = destination
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let path = parent.join(format!(".surtitle-export-{}.tmp", uuid::Uuid::new_v4()));
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        Ok(Self {
            path: Some(path),
            file: Some(file),
        })
    }
    fn persist(mut self, destination: &Path) -> Result<()> {
        self.file
            .take()
            .context("export file is closed")?
            .sync_all()?;
        std::fs::rename(
            self.path.as_ref().context("export file is missing")?,
            destination,
        )
        .context("Cannot replace the backup; choose a writable destination")?;
        self.path = None;
        Ok(())
    }
}
impl Drop for PendingExport {
    fn drop(&mut self) {
        self.file.take();
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub fn validate(a: &LearningArchive) -> Result<()> {
    ensure!(
        a.format == "surtitle.learning" && a.schema_version == 1,
        "unsupported backup format"
    );
    ensure!(
        a.media.len() <= 100_000 && a.cards.len() <= 1_000_000 && a.segments.len() <= 2_000_000,
        "backup exceeds limits"
    );
    let unique = |items: Vec<&str>| -> Result<HashSet<String>> {
        let mut set = HashSet::new();
        for item in items {
            ensure!(
                !item.is_empty() && item.len() < 256 && set.insert(item.to_owned()),
                "duplicate or invalid identifier"
            );
        }
        Ok(set)
    };
    let media = unique(a.media.iter().map(|x| x.id.as_str()).collect())?;
    ensure!(
        a.draft_study_selections.len() <= 1_000_000,
        "Too many draft study selections"
    );
    unique(
        a.draft_study_selections
            .iter()
            .map(|x| x.id.as_str())
            .collect(),
    )?;
    let media_by_id: std::collections::HashMap<_, _> = a
        .media
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    for selection in &a.draft_study_selections {
        let source = media_by_id
            .get(selection.media_id.as_str())
            .context("Orphan draft study selection")?;
        crate::store::draft_study::validate(selection, source)?;
    }
    unique(a.segments.iter().map(|x| x.id.as_str()).collect())?;
    let cards = unique(a.cards.iter().map(|x| x.id.as_str()).collect())?;
    unique(a.subtitle_versions.iter().map(|x| x.id.as_str()).collect())?;
    ensure!(
        a.subtitle_versions.len() <= 100_000,
        "too many saved subtitle versions"
    );
    let mut version_segments = 0usize;
    for version in &a.subtitle_versions {
        ensure!(
            media.contains(&version.media_id) && version.label.len() <= 4096,
            "invalid subtitle version"
        );
        chrono::DateTime::parse_from_rfc3339(&version.created_at)?;
        version_segments = version_segments
            .checked_add(version.segments.len())
            .context("subtitle version size overflow")?;
        ensure!(
            version_segments <= 2_000_000,
            "too many saved version subtitles"
        );
        unique(version.segments.iter().map(|s| s.id.as_str()).collect())?;
        for s in &version.segments {
            crate::store::validate_segment(s)?;
            ensure!(
                s.media_id == version.media_id,
                "wrong subtitle version media"
            );
        }
    }
    unique(a.reviews.iter().map(|x| x.id.as_str()).collect())?;
    for s in &a.segments {
        crate::store::validate_segment(s)?;
        ensure!(media.contains(&s.media_id), "orphan subtitle");
    }
    for c in &a.cards {
        if let Some(range) = c.audio_clip_range {
            range.validate_source(c.start_ms, c.end_ms)?;
        }
        ensure!(c.source_cues.len() <= 64, "too many card source subtitles");
        unique(c.source_cues.iter().map(|s| s.id.as_str()).collect())?;
        for source in &c.source_cues {
            crate::store::validate_segment(source)?;
            ensure!(
                source.media_id == c.media_id && source.status == "confirmed",
                "invalid card source subtitle"
            );
        }
        if let Some(first) = c.source_cues.first() {
            ensure!(
                first.id == c.segment_id
                    && first.start_ms == c.start_ms
                    && c.source_cues.iter().map(|s| s.end_ms).max() == Some(c.end_ms),
                "card source range mismatch"
            );
        }
        ensure!(
            !c.term.trim().is_empty() && c.term.len() < 4096 && c.meaning.len() < 64 * 1024,
            "invalid card"
        );
        chrono::DateTime::parse_from_rfc3339(&c.due_at)?;
        chrono::DateTime::parse_from_rfc3339(&c.created_at)?;
        if let Some(last) = &c.last_review {
            chrono::DateTime::parse_from_rfc3339(last)?;
        }
        if let Some(memory) = c.memory {
            ensure!(
                memory.stability.is_finite()
                    && memory.difficulty.is_finite()
                    && memory.stability > 0.
                    && (1.0..=10.0).contains(&memory.difficulty),
                "invalid FSRS memory"
            );
        }
    }
    for r in &a.reviews {
        chrono::DateTime::parse_from_rfc3339(&r.reviewed_at)?;
        ensure!(cards.contains(&r.card_id), "orphan review");
        ensure!(
            ["again", "hard", "good", "easy"].contains(&r.rating.as_str()),
            "invalid rating"
        );
    }
    Ok(())
}

pub fn export_json(archive: &LearningArchive, path: &Path) -> Result<()> {
    export_json_with_limits(archive, path, EXPORT_LIMITS)
}
fn export_json_with_limits(
    archive: &LearningArchive,
    path: &Path,
    limits: ExportLimits,
) -> Result<()> {
    validate(archive)?;
    let mut portable = archive.clone();
    portable.draft_study_selections = portable
        .draft_study_selections
        .iter()
        .map(DraftStudySelection::detached)
        .collect();
    // No arbitrary machine-local file can be reactivated through a backup.
    for card in &mut portable.cards {
        card.audio_path = None;
    }
    let mut pending = PendingExport::create(path)?;
    serde_json::to_writer_pretty(
        LimitedWriter {
            inner: pending.file.as_mut().context("export file is closed")?,
            limit: limits.json.min(limits.total),
            written: 0,
        },
        &portable,
    )
    .context("Learning JSON could not be exported within the restore size limit")?;
    pending.persist(path)
}

pub fn export_zip(archive: &LearningArchive, audio_root: &Path, path: &Path) -> Result<()> {
    export_zip_with_limits(archive, audio_root, path, EXPORT_LIMITS)
}
fn export_zip_with_limits(
    archive: &LearningArchive,
    audio_root: &Path,
    path: &Path,
    limits: ExportLimits,
) -> Result<()> {
    validate(archive)?;
    let mut portable = archive.clone();
    portable.draft_study_selections = portable
        .draft_study_selections
        .iter()
        .map(DraftStudySelection::detached)
        .collect();
    let audio_context = |card: &StudyCard| {
        format!(
            "Saved audio for card '{}' ({}) is unavailable or invalid; restore its clip before creating an audio backup",
            card.term, card.id,
        )
    };
    let root = portable
        .cards
        .iter()
        .find(|card| card.audio_path.is_some())
        .map(|card| {
            audio_root
                .canonicalize()
                .with_context(|| audio_context(card))
        })
        .transpose()?;
    let mut pending = PendingExport::create(path)?;
    let mut zip = ZipWriter::new(pending.file.as_mut().context("export file is closed")?);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o600);
    let mut total = 0u64;
    for card in &mut portable.cards {
        let source = card.audio_path.take();
        if let Some(source) = source {
            let context = audio_context(card);
            let source = Path::new(&source)
                .canonicalize()
                .with_context(|| context.clone())?;
            ensure!(
                source.starts_with(root.as_ref().context("missing audio root")?),
                "{context}: outside managed storage"
            );
            ensure!(
                source
                    .metadata()
                    .with_context(|| context.clone())?
                    .is_file(),
                "{context}: not a regular file"
            );
            let mut file = File::open(source).with_context(|| context.clone())?;
            let metadata = file.metadata().with_context(|| context.clone())?;
            ensure!(metadata.is_file(), "{context}: not a regular file");
            ensure!(
                metadata.len() <= limits.audio,
                "Audio for card '{}' ({}) exceeds the per-clip restore size limit",
                card.term,
                card.id
            );
            let remaining = limits
                .total
                .checked_sub(total)
                .context("backup exceeds total restore size limit")?;
            ensure!(
                metadata.len() <= remaining,
                "backup exceeds total restore size limit"
            );
            let name = format!("audio/{}.wav", uuid::Uuid::new_v4());
            zip.start_file(&name, options)?;
            let limit = limits.audio.min(remaining);
            let copied = std::io::copy(
                &mut (&mut file).take(limit.saturating_add(1)),
                &mut LimitedWriter {
                    inner: &mut zip,
                    limit,
                    written: 0,
                },
            )
            .with_context(|| context.clone())?;
            ensure!(
                copied == metadata.len(),
                "{context}: size changed during export"
            );
            total = total.checked_add(copied).context("archive size overflow")?;
            card.audio_path = Some(name);
        }
    }
    zip.start_file("learning.json", options)?;
    serde_json::to_writer_pretty(
        LimitedWriter {
            inner: &mut zip,
            limit: limits.json.min(
                limits
                    .total
                    .checked_sub(total)
                    .context("backup exceeds total restore size limit")?,
            ),
            written: 0,
        },
        &portable,
    )
    .context("Learning JSON exceeds the JSON or total restore size limit")?;
    zip.finish()?;
    pending.persist(path)
}

/// Preview performs no writes. Every entry is checked before extraction or DB replacement.
pub fn read_archive(path: &Path) -> Result<LearningArchive> {
    let is_zip = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"));
    let mut archive: LearningArchive = if is_zip {
        let mut zip = ZipArchive::new(File::open(path)?)?;
        ensure!(zip.len() <= 1_000_001, "too many archive entries");
        let mut total = 0u64;
        let mut names = HashSet::new();
        for i in 0..zip.len() {
            let entry = zip.by_index(i)?;
            let name = entry.name();
            ensure!(names.insert(name.to_owned()), "duplicate ZIP entry");
            ensure!(
                entry.enclosed_name().is_some() && !name.contains('\\') && !name.contains(':'),
                "unsafe ZIP path"
            );
            ensure!(
                entry.unix_mode().is_none_or(|m| m & 0o170000 != 0o120000),
                "symlinks not allowed"
            );
            let valid = name == "learning.json" || valid_audio_name(name);
            ensure!(valid, "unexpected file in learning backup");
            ensure!(
                entry.size()
                    <= if name == "learning.json" {
                        MAX_JSON
                    } else {
                        MAX_AUDIO
                    },
                "oversized ZIP entry"
            );
            total = total
                .checked_add(entry.size())
                .context("archive size overflow")?;
            ensure!(total <= MAX_TOTAL, "archive exceeds size limit");
        }
        let entry = zip.by_name("learning.json")?;
        let parsed: LearningArchive = serde_json::from_reader(entry.take(MAX_JSON + 1))?;
        for card in &parsed.cards {
            if let Some(audio) = &card.audio_path {
                ensure!(
                    valid_audio_name(audio) && names.contains(audio),
                    "missing or invalid card audio"
                );
            }
        }
        parsed
    } else {
        ensure!(path.metadata()?.len() <= MAX_JSON, "backup too large");
        let mut parsed: LearningArchive =
            serde_json::from_reader(File::open(path)?.take(MAX_JSON + 1))?;
        // JSON contains no audio payload: never trust an arbitrary path from another machine.
        for card in &mut parsed.cards {
            card.audio_path = None;
        }
        parsed
    };
    validate(&archive)?;
    archive.draft_study_selections = archive
        .draft_study_selections
        .iter()
        .map(DraftStudySelection::detached)
        .collect();
    Ok(archive)
}

fn valid_audio_name(name: &str) -> bool {
    name.strip_prefix("audio/")
        .and_then(|s| s.strip_suffix(".wav"))
        .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
}

/// Extracts to a new independent directory. Caller restores DB only after this succeeds.
pub fn materialize_audio(
    path: &Path,
    archive: &mut LearningArchive,
    audio_root: &Path,
) -> Result<PathBuf> {
    let target = audio_root.join(format!("restore-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&target)?;
    if !archive.cards.iter().any(|c| c.audio_path.is_some()) {
        return Ok(target);
    }
    let mut zip = ZipArchive::new(File::open(path)?)?;
    for card in &mut archive.cards {
        if let Some(name) = card.audio_path.take() {
            ensure!(valid_audio_name(&name), "unsafe audio path");
            let destination =
                target.join(Path::new(&name).file_name().context("missing filename")?);
            let mut source = zip.by_name(&name)?;
            ensure!(source.size() <= MAX_AUDIO, "card audio too large");
            let mut output = File::create(&destination)?;
            std::io::copy(&mut (&mut source).take(MAX_AUDIO + 1), &mut output)?;
            ensure!(
                output.metadata()?.len() <= MAX_AUDIO,
                "card audio too large"
            );
            output.sync_all()?;
            card.audio_path = Some(destination.to_string_lossy().into_owned());
        }
    }
    Ok(target)
}

pub fn export_delimited(cards: &[StudyCard], separator: char) -> String {
    fn field(value: &str) -> String {
        // Spreadsheet consumers must not interpret user or model text as formulas.
        let value = if value
            .trim_start()
            .starts_with(['=', '+', '-', '@', '\t', '\r'])
        {
            format!("'{value}")
        } else {
            value.to_owned()
        };
        format!("\"{}\"", value.replace('"', "\"\""))
    }
    let sep = separator.to_string();
    let mut out = vec![
        [
            "term",
            "meaning",
            "example",
            "translation",
            "explanation",
            "language",
            "source",
            "source_url",
            "start_ms",
            "end_ms",
            "due_at",
        ]
        .join(&sep),
    ];
    for c in cards {
        out.push(
            [
                c.term.clone(),
                c.meaning.clone(),
                c.example.clone(),
                c.translation.clone().unwrap_or_default(),
                c.explanation.clone().unwrap_or_default(),
                c.language.clone(),
                c.source_title.clone(),
                c.source_url.clone().unwrap_or_default(),
                c.start_ms.to_string(),
                c.end_ms.to_string(),
                c.due_at.clone(),
            ]
            .iter()
            .map(|s| field(s))
            .collect::<Vec<_>>()
            .join(&sep),
        );
    }
    out.join("\r\n") + "\r\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn setup() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Store::open(dir.path().join("learning.sqlite")).unwrap();
        let media = Media {
            id: "m".into(),
            title: "日本語 & media".into(),
            path: dir.path().join("media.mp4").to_string_lossy().into(),
            source_url: None,
            kind: "video".into(),
            duration_ms: 21_600_000,
            learning_language: "en".into(),
            explanation_language: "ja".into(),
            created_at: now(),
            last_position_ms: 0,
            audio_stream_index: None,
            subtitle_stream_index: None,
            segment_count: 0,
            card_count: 0,
            status: "ready".into(),
            error: None,
        };
        db.put_media(&media).unwrap();
        let s = crate::subtitles::parse("1\n00:00:01,000 --> 00:00:02,000\nOriginal", "m").unwrap();
        db.set_segments("m", &s).unwrap();
        db.save_card(
            &SaveCard {
                media_id: "m".into(),
                segment_id: s[0].id.clone(),
                source_cue_ids: vec![],
                term: "=1+1".into(),
                meaning: "Meaning".into(),
                example: "Original".into(),
                translation: Some("元の文".into()),
                explanation: Some("Saved explanation".into()),
            },
            None,
        )
        .unwrap();
        (dir, db)
    }

    fn no_export_temps(directory: &Path) {
        assert!(std::fs::read_dir(directory).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".surtitle-export-")
        }));
    }

    #[test]
    fn clip_context_roundtrips_without_changing_source_and_invalid_ranges_fail() {
        let (dir, db) = setup();
        let mut archive = db.archive().unwrap();
        archive.cards[0].audio_clip_range = Some(crate::AudioClipRange {
            start_ms: 850,
            end_ms: 2150,
        });
        let destination = dir.path().join("context.json");
        export_json(&archive, &destination).unwrap();
        let restored = read_archive(&destination).unwrap();
        assert_eq!(
            restored.cards[0].audio_clip_range,
            archive.cards[0].audio_clip_range
        );
        assert_eq!(
            (restored.cards[0].start_ms, restored.cards[0].end_ms),
            (1000, 2000)
        );
        assert_eq!(
            serde_json::to_value(&restored.cards[0].source_cues).unwrap(),
            serde_json::to_value(&archive.cards[0].source_cues).unwrap()
        );
        archive.cards[0].audio_clip_range.as_mut().unwrap().start_ms = 1001;
        assert!(validate(&archive).is_err());
    }

    fn failed_export_preserves_destinations(
        directory: &Path,
        extension: &str,
        export: impl Fn(&Path) -> Result<()>,
    ) -> String {
        let existing = directory.join(format!("existing.{extension}"));
        let absent = directory.join(format!("new.{extension}"));
        std::fs::write(&existing, b"previous complete backup").unwrap();
        let error = export(&existing).unwrap_err();
        assert_eq!(
            std::fs::read(&existing).unwrap(),
            b"previous complete backup"
        );
        assert!(export(&absent).is_err());
        assert!(!absent.exists());
        no_export_temps(directory);
        format!("{error:#}")
    }

    #[test]
    fn missing_or_invalid_registered_audio_cannot_silently_become_an_audio_less_backup() {
        let (dir, db) = setup();
        let audio = dir.path().join("audio");
        std::fs::create_dir(&audio).unwrap();
        let outside = dir.path().join("outside.wav");
        std::fs::write(&outside, b"owned source clip").unwrap();
        for path in [audio.join("missing.wav"), audio.clone(), outside.clone()] {
            let mut archive = db.archive().unwrap();
            archive.cards[0].audio_path = Some(path.to_string_lossy().into_owned());
            let original = serde_json::to_vec(&archive).unwrap();
            let error = failed_export_preserves_destinations(dir.path(), "zip", |destination| {
                export_zip(&archive, &audio, destination)
            });
            assert!(error.contains(&archive.cards[0].id));
            assert!(error.contains(&archive.cards[0].term));
            assert!(error.contains("restore its clip"));
            assert_eq!(serde_json::to_vec(&archive).unwrap(), original);
        }
        assert_eq!(std::fs::read(outside).unwrap(), b"owned source clip");
    }

    #[test]
    fn json_export_enforces_exact_serialized_size_without_replacing_previous_backup() {
        let (dir, db) = setup();
        let archive = db.archive().unwrap();
        let size = serde_json::to_vec_pretty(&archive).unwrap().len() as u64;
        failed_export_preserves_destinations(dir.path(), "json", |destination| {
            export_json_with_limits(
                &archive,
                destination,
                ExportLimits {
                    json: size - 1,
                    ..EXPORT_LIMITS
                },
            )
        });
        let destination = dir.path().join("existing.json");
        export_json_with_limits(
            &archive,
            &destination,
            ExportLimits {
                json: size,
                total: size,
                ..EXPORT_LIMITS
            },
        )
        .unwrap();
        assert_eq!(destination.metadata().unwrap().len(), size);
        assert_eq!(
            serde_json::to_vec(&read_archive(&destination).unwrap()).unwrap(),
            serde_json::to_vec(&archive).unwrap()
        );
        no_export_temps(dir.path());
    }

    #[test]
    fn zip_export_limits_cover_audio_json_and_their_uncompressed_sum() {
        let (dir, db) = setup();
        let audio = dir.path().join("audio");
        std::fs::create_dir(&audio).unwrap();
        let clip = audio.join("clip.wav");
        let samples = vec![0u8; 1024];
        std::fs::write(&clip, &samples).unwrap();
        let mut archive = db.archive().unwrap();
        archive.cards[0].audio_path = Some(clip.to_string_lossy().into_owned());
        let reference = dir.path().join("reference.zip");
        export_zip(&archive, &audio, &reference).unwrap();
        let mut zip = ZipArchive::new(File::open(&reference).unwrap()).unwrap();
        let json_size = zip.by_name("learning.json").unwrap().size();
        let audio_size = samples.len() as u64;
        let exact = ExportLimits {
            json: json_size,
            audio: audio_size,
            total: json_size + audio_size,
        };
        for limits in [
            ExportLimits {
                audio: audio_size - 1,
                ..exact
            },
            ExportLimits {
                json: json_size - 1,
                ..exact
            },
            ExportLimits {
                total: exact.total - 1,
                ..exact
            },
            ExportLimits {
                total: audio_size - 1,
                ..exact
            },
        ] {
            failed_export_preserves_destinations(dir.path(), "zip", |destination| {
                export_zip_with_limits(&archive, &audio, destination, limits)
            });
        }
        let destination = dir.path().join("existing.zip");
        export_zip_with_limits(&archive, &audio, &destination, exact).unwrap();
        let restored = read_archive(&destination).unwrap();
        assert_eq!(restored.cards.len(), 1);
        let mut zip = ZipArchive::new(File::open(destination).unwrap()).unwrap();
        let mut actual = Vec::new();
        zip.by_name(restored.cards[0].audio_path.as_ref().unwrap())
            .unwrap()
            .read_to_end(&mut actual)
            .unwrap();
        assert_eq!(actual, samples);
        assert_eq!(std::fs::read(clip).unwrap(), samples);
        no_export_temps(dir.path());
    }

    #[test]
    fn failed_final_rename_preserves_directory_and_removes_only_owned_temporary_file() {
        let (dir, db) = setup();
        let archive = db.archive().unwrap();
        let destination = dir.path().join("occupied");
        std::fs::create_dir(&destination).unwrap();
        let sentinel = destination.join("keep.txt");
        std::fs::write(&sentinel, b"existing directory content").unwrap();
        assert!(export_json(&archive, &destination).is_err());
        assert!(export_zip(&archive, &dir.path().join("unused-audio"), &destination).is_err());
        assert_eq!(
            std::fs::read(sentinel).unwrap(),
            b"existing directory content"
        );
        no_export_temps(dir.path());
    }

    #[test]
    fn streaming_budget_rejects_extra_bytes_after_a_successful_partial_write() {
        let mut bytes = Vec::new();
        let mut writer = LimitedWriter {
            inner: &mut bytes,
            limit: 4,
            written: 0,
        };
        writer.write_all(b"clip").unwrap();
        assert!(writer.write_all(b"grew").is_err());
        assert_eq!(writer.written, 4);
        assert_eq!(bytes, b"clip");
    }

    #[test]
    fn snapshots_review_restore_and_backup() {
        let (dir, mut db) = setup();
        let card = db.list_cards().unwrap().remove(0);
        let mut segment = db.list_segments("m").unwrap().remove(0);
        segment.text = "Changed".into();
        db.edit_segment(&segment).unwrap();
        assert_eq!(db.card(&card.id).unwrap().example, "Original");
        assert_eq!(
            db.card(&card.id).unwrap().explanation.as_deref(),
            Some("Saved explanation")
        );
        assert_eq!(
            db.card(&card.id).unwrap().translation.as_deref(),
            Some("元の文")
        );
        let rated = db
            .rate_card(&card.id, "good", 0.9, chrono::Utc::now())
            .unwrap();
        assert!(rated.memory.is_some());
        assert_eq!(rated.review_count, 1);
        let archive = db.archive().unwrap();
        db.rate_card(&card.id, "again", 0.9, chrono::Utc::now())
            .unwrap();
        let backup = dir.path().join("before.sqlite");
        db.restore(&archive, &backup).unwrap();
        assert_eq!(db.card(&card.id).unwrap().review_count, 1);
        assert_eq!(
            Store::open(backup)
                .unwrap()
                .card(&card.id)
                .unwrap()
                .review_count,
            2
        );
        assert!(export_delimited(&[card], ',').contains("'=1+1"));
    }
    #[test]
    fn failed_restore_keeps_current_database() {
        let (dir, mut db) = setup();
        let mut a = db.archive().unwrap();
        a.reviews.push(Review {
            id: id(),
            card_id: "absent".into(),
            rating: "good".into(),
            reviewed_at: now(),
            scheduled_days: 1,
        });
        assert!(db.restore(&a, &dir.path().join("backup.sqlite")).is_err());
        assert_eq!(db.list_cards().unwrap().len(), 1);
    }
    #[test]
    fn result_application_markers_stay_local_and_restore_clears_them() {
        let (dir, mut db) = setup();
        let mut segment = db.list_segments("m").unwrap().remove(0);
        segment.translation = Some("保存済み翻訳".into());
        let hash = "a".repeat(64);
        db.apply_translations_once("local-paid-job", 0, &hash, &[segment])
            .unwrap();
        assert!(db.ai_result_applied("local-paid-job", 0, &hash).unwrap());
        let archive = db.archive().unwrap();
        assert!(
            !serde_json::to_string(&archive)
                .unwrap()
                .contains("local-paid-job")
        );
        let backup = dir.path().join("before-restore.sqlite");
        db.restore(&archive, &backup).unwrap();
        assert!(!db.ai_result_applied("local-paid-job", 0, &hash).unwrap());
        assert!(
            Store::open(backup)
                .unwrap()
                .ai_result_applied("local-paid-job", 0, &hash)
                .unwrap()
        );
        assert_eq!(
            db.list_segments("m").unwrap()[0].translation.as_deref(),
            Some("保存済み翻訳")
        );
    }
    #[test]
    fn zip_roundtrip_and_path_traversal() {
        let (dir, mut db) = setup();
        let audio = dir.path().join("audio");
        std::fs::create_dir(&audio).unwrap();
        let original_audio = audio.join("snapshot.wav");
        let samples = b"RIFF\x28\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data\x04\0\0\0\x01\0\x02\0";
        std::fs::write(&original_audio, samples).unwrap();
        let mut card = db.list_cards().unwrap().remove(0);
        card.audio_path = Some(original_audio.to_string_lossy().into_owned());
        db.put_card(&card).unwrap();
        let path = dir.path().join("backup.zip");
        export_zip(&db.archive().unwrap(), &audio, &path).unwrap();
        let mut restored = read_archive(&path).unwrap();
        assert_eq!(restored.cards.len(), 1);
        assert!(
            restored.cards[0]
                .audio_path
                .as_deref()
                .unwrap()
                .starts_with("audio/")
        );
        let extraction = materialize_audio(&path, &mut restored, &audio).unwrap();
        let restored_audio = Path::new(restored.cards[0].audio_path.as_ref().unwrap());
        assert!(restored_audio.starts_with(&extraction));
        assert_eq!(std::fs::read(restored_audio).unwrap(), samples);
        db.restore(&restored, &dir.path().join("before-audio-restore.sqlite"))
            .unwrap();
        assert_eq!(db.card(&card.id).unwrap().explanation, card.explanation);
        assert_eq!(std::fs::read(original_audio).unwrap(), samples);
        let json = dir.path().join("learning.json");
        export_json(&db.archive().unwrap(), &json).unwrap();
        assert!(read_archive(&json).unwrap().cards[0].audio_path.is_none());
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        zip.start_file("../evil.exe", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"evil").unwrap();
        zip.finish().unwrap();
        assert!(read_archive(&path).is_err());
    }
}
