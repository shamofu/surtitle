use super::*;

pub(super) fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS transcript_issues (
            id TEXT PRIMARY KEY,
            media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
            source_id TEXT NOT NULL, start_ms INTEGER NOT NULL, data TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS transcript_issues_media_time ON transcript_issues(media_id,start_ms);",
    )?;
    Ok(())
}

pub(crate) fn validate(record: &TranscriptIssueRecord) -> Result<()> {
    ensure!(
        [&record.id, &record.media_id, &record.source_id]
            .iter()
            .all(|value| !value.is_empty()
                && value.len() <= 256
                && !value.chars().any(char::is_control))
            && !record.kind.is_empty()
            && record.kind.len() <= 128
            && record.start_ms < record.end_ms
            && record.end_ms < 360_000_000_000
            && record.alternatives.len() <= 100_000,
        "Invalid transcript range note"
    );
    for alternative in &record.alternatives {
        ensure!(
            alternative.start_ms < alternative.end_ms
                && alternative.end_ms < 360_000_000_000
                && !alternative.text.trim().is_empty()
                && alternative.text.len() < 1024 * 1024,
            "Invalid transcript range alternative"
        );
    }
    Ok(())
}

/// Call within the adoption or restore transaction so notes and cues commit together.
pub(super) fn upsert_transcript_issues_on(
    connection: &Connection,
    records: &[TranscriptIssueRecord],
) -> Result<()> {
    ensure!(records.len() <= 100_000, "Too many transcript range notes");
    let mut ids = std::collections::HashSet::new();
    for record in records {
        validate(record)?;
        ensure!(ids.insert(&record.id), "Duplicate transcript range note");
        let media_json: String = connection.query_row(
            "SELECT data FROM media WHERE id=?",
            [&record.media_id],
            |row| row.get(0),
        )?;
        let media: Media = serde_json::from_str(&media_json)?;
        ensure!(
            !record.active || record.end_ms <= media.duration_ms,
            "Transcript range note exceeds media duration"
        );
        let existing: Option<(String, String)> = connection
            .query_row(
                "SELECT media_id,source_id FROM transcript_issues WHERE id=?",
                [&record.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        ensure!(
            existing.is_none_or(
                |(media, source)| media == record.media_id && source == record.source_id
            ),
            "Transcript range note identity changed"
        );
        connection.execute(
            "INSERT INTO transcript_issues(id,media_id,source_id,start_ms,data) VALUES(?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET start_ms=excluded.start_ms,data=excluded.data",
            params![
                record.id,
                record.media_id,
                record.source_id,
                record.start_ms as i64,
                serde_json::to_string(record)?
            ],
        )?;
    }
    Ok(())
}

impl Store {
    pub fn list_transcript_issues(&self, media_id: &str) -> Result<Vec<TranscriptIssueRecord>> {
        let mut query = self
            .conn
            .prepare("SELECT data FROM transcript_issues WHERE media_id=? ORDER BY start_ms,id")?;
        let rows = query
            .query_map([media_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let records = rows
            .iter()
            .map(|json| {
                let record: TranscriptIssueRecord = serde_json::from_str(json)?;
                validate(&record)?;
                Ok(record)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(records.into_iter().filter(|record| record.active).collect())
    }

    pub fn upsert_transcript_issues(&self, records: &[TranscriptIssueRecord]) -> Result<()> {
        let transaction = self.conn.unchecked_transaction()?;
        upsert_transcript_issues_on(&transaction, records)?;
        transaction.commit()?;
        Ok(())
    }
}

/// Keep original notes portable, but stop showing them against replaced or reviewed content.
pub(super) fn deactivate_transcript_issues_on(
    connection: &Connection,
    media_id: &str,
    start_ms: u64,
    end_ms: u64,
    contained_only: bool,
) -> Result<()> {
    let mut statement =
        connection.prepare("SELECT data FROM transcript_issues WHERE media_id=?")?;
    let json = statement
        .query_map([media_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for json in json {
        let mut record: TranscriptIssueRecord = serde_json::from_str(&json)?;
        let affected = if contained_only {
            record.start_ms >= start_ms && record.end_ms <= end_ms
        } else {
            record.start_ms < end_ms && record.end_ms > start_ms
        };
        if record.active && affected {
            record.active = false;
            connection.execute(
                "UPDATE transcript_issues SET data=? WHERE id=?",
                params![serde_json::to_string(&record)?, record.id],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path().join("learning.sqlite")).unwrap();
        let media: Media = serde_json::from_value(serde_json::json!({
            "id":"media", "title":"Silent source", "path":directory.path().join("source.mp4"),
            "kind":"video", "durationMs":5000, "learningLanguage":"en", "explanationLanguage":"ja",
            "createdAt":now(), "lastPositionMs":0, "segmentCount":0, "cardCount":0, "status":"ready"
        }))
        .unwrap();
        store.put_media(&media).unwrap();
        (directory, store)
    }

    fn record() -> TranscriptIssueRecord {
        TranscriptIssueRecord {
            id: "range-note".into(),
            media_id: "media".into(),
            source_id: "preparation".into(),
            kind: "no_speech".into(),
            start_ms: 0,
            end_ms: 5000,
            active: true,
            alternatives: vec![],
        }
    }

    #[test]
    fn cue_less_ranges_and_discarded_alternatives_survive_restart_and_portable_archives() {
        let (directory, store) = fixture();
        let silent = record();
        let mut alternative = record();
        alternative.id = "unselected-alternative".into();
        alternative.kind = "boundary_conflict".into();
        alternative.alternatives.push(SubtitleReviewAlternative {
            start_ms: 125,
            end_ms: 875,
            text: "Original unselected text".into(),
        });
        store
            .upsert_transcript_issues(&[silent, alternative])
            .unwrap();
        drop(store);
        let mut store = Store::open(directory.path().join("learning.sqlite")).unwrap();
        assert!(store.list_segments("media").unwrap().is_empty());
        assert_eq!(store.list_transcript_issues("media").unwrap().len(), 2);
        let archive = store.archive().unwrap();
        assert_eq!(archive.schema_version, 3);
        for extension in ["json", "zip"] {
            let path = directory.path().join(format!("notes.{extension}"));
            if extension == "json" {
                crate::transfer::export_json(&archive, &path).unwrap();
            } else {
                crate::transfer::export_zip(&archive, directory.path(), &path).unwrap();
            }
            let restored = crate::transfer::read_archive(&path).unwrap();
            assert_eq!(
                serde_json::to_value(&restored.transcript_issues).unwrap(),
                serde_json::to_value(&archive.transcript_issues).unwrap()
            );
            store
                .restore(
                    &restored,
                    &directory.path().join(format!("before-{extension}.sqlite")),
                )
                .unwrap();
            assert_eq!(store.list_transcript_issues("media").unwrap().len(), 2);
            assert!(store.list_segments("media").unwrap().is_empty());
        }
        let mut legacy = serde_json::to_value(&archive).unwrap();
        legacy["schemaVersion"] = 1.into();
        legacy.as_object_mut().unwrap().remove("transcriptIssues");
        let legacy: LearningArchive = serde_json::from_value(legacy).unwrap();
        crate::transfer::validate(&legacy).unwrap();
        assert!(legacy.transcript_issues.is_empty());
    }

    #[test]
    fn invalid_note_rolls_back_the_whole_batch_and_cannot_enter_an_archive() {
        let (_directory, store) = fixture();
        let valid = record();
        let mut invalid = record();
        invalid.id = "bad".into();
        invalid.end_ms = 5001;
        assert!(
            store
                .upsert_transcript_issues(&[valid.clone(), invalid.clone()])
                .is_err()
        );
        assert!(store.list_transcript_issues("media").unwrap().is_empty());
        let mut archive = store.archive().unwrap();
        archive.transcript_issues = vec![invalid];
        assert!(crate::transfer::validate(&archive).is_err());
        archive.transcript_issues = vec![valid.clone(), valid];
        assert!(crate::transfer::validate(&archive).is_err());
    }

    #[test]
    fn issue_insert_failure_rolls_back_adoption_and_silent_adoption_is_idempotent() {
        let (_directory, mut store) = fixture();
        let issue = record();
        let revision = subtitle_revision(&[]).unwrap();
        store
            .conn
            .execute_batch(
                "CREATE TEMP TRIGGER fail_issue BEFORE INSERT ON transcript_issues
            BEGIN SELECT RAISE(ABORT,'test issue failure'); END;",
            )
            .unwrap();
        assert!(
            store
                .adopt_transcript_with_issues_once(
                    "job",
                    &"a".repeat(64),
                    &"b".repeat(64),
                    "media",
                    &revision,
                    0,
                    5000,
                    &[],
                    std::slice::from_ref(&issue)
                )
                .is_err()
        );
        assert!(
            store
                .transcript_adopted("job", &"a".repeat(64))
                .unwrap()
                .is_none()
        );
        assert!(store.list_transcript_issues("media").unwrap().is_empty());
        store
            .conn
            .execute_batch("DROP TRIGGER fail_issue;")
            .unwrap();
        assert!(
            store
                .adopt_transcript_with_issues_once(
                    "job",
                    &"a".repeat(64),
                    &"b".repeat(64),
                    "media",
                    &revision,
                    0,
                    5000,
                    &[],
                    std::slice::from_ref(&issue)
                )
                .unwrap()
        );
        assert!(
            !store
                .adopt_transcript_with_issues_once(
                    "job",
                    &"a".repeat(64),
                    &"b".repeat(64),
                    "media",
                    &revision,
                    0,
                    5000,
                    &[],
                    &[issue]
                )
                .unwrap()
        );
        assert!(store.list_segments("media").unwrap().is_empty());
        assert_eq!(store.list_transcript_issues("media").unwrap().len(), 1);
    }

    #[test]
    fn edits_and_source_replacements_retire_notices_but_preserve_original_alternatives() {
        let (directory, mut store) = fixture();
        let mut cue: SubtitleSegment = serde_json::from_value(serde_json::json!({
            "id":"cue", "mediaId":"media", "startMs":1000, "endMs":2000,
            "text":"Original generated text", "status":"generated_review"
        }))
        .unwrap();
        store
            .set_segments("media", std::slice::from_ref(&cue))
            .unwrap();
        let mut local = record();
        local.id = "local".into();
        local.start_ms = 1000;
        local.end_ms = 2000;
        local.alternatives.push(SubtitleReviewAlternative {
            start_ms: 1000,
            end_ms: 2000,
            text: "Preserve this alternative".into(),
        });
        let broad = record();
        store.upsert_transcript_issues(&[local, broad]).unwrap();
        cue.status = "confirmed".into();
        cue.text = "Corrected text".into();
        store.edit_segment(&cue).unwrap();
        let active = store.list_transcript_issues("media").unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "range-note"); // One corrected cue cannot resolve a whole-video warning.
        let archived = store.archive().unwrap();
        let retired = archived
            .transcript_issues
            .iter()
            .find(|issue| issue.id == "local")
            .unwrap();
        assert!(!retired.active);
        assert_eq!(retired.alternatives[0].text, "Preserve this alternative");
        store
            .replace_subtitles(
                "media",
                std::slice::from_ref(&cue),
                None,
                true,
                "Imported subtitles",
            )
            .unwrap();
        assert!(store.list_transcript_issues("media").unwrap().is_empty());
        let archived = store.archive().unwrap();
        assert_eq!(archived.transcript_issues.len(), 2);
        assert!(archived.transcript_issues.iter().all(|issue| !issue.active));
        store
            .restore(&archived, &directory.path().join("before-restore.sqlite"))
            .unwrap();
        assert!(store.list_transcript_issues("media").unwrap().is_empty());
        let mut new = record();
        new.id = "new-source".into();
        new.source_id = "new-preparation".into();
        store
            .adopt_transcript_with_issues_once(
                "new-job",
                &"c".repeat(64),
                &"d".repeat(64),
                "media",
                &subtitle_revision(&[cue]).unwrap(),
                0,
                5000,
                &[],
                &[new],
            )
            .unwrap();
        assert_eq!(
            store.list_transcript_issues("media").unwrap()[0].id,
            "new-source"
        );
        assert_eq!(store.archive().unwrap().transcript_issues.len(), 3);
        store.set_segments("media", &[]).unwrap();
        assert!(store.list_transcript_issues("media").unwrap().is_empty());
    }

    #[test]
    fn replacing_media_keeps_old_warning_times_portable_without_showing_them_on_the_new_source() {
        let (directory, store) = fixture();
        store.upsert_transcript_issues(&[record()]).unwrap();
        let mut media = store.media("media").unwrap();
        media.path = directory
            .path()
            .join("shorter-source.mp4")
            .to_string_lossy()
            .into_owned();
        media.duration_ms = 1000;
        store.put_media(&media).unwrap();
        assert!(store.list_transcript_issues("media").unwrap().is_empty());
        let archive = store.archive().unwrap();
        crate::transfer::validate(&archive).unwrap();
        assert_eq!(archive.transcript_issues[0].end_ms, 5000);
        assert!(!archive.transcript_issues[0].active);
    }
}
