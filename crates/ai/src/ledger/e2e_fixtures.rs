//! Fixed recovery fixture compiled only into explicit native E2E builds.
//! It seeds an already received result; it never impersonates a paid HTTP send.
use super::*;

impl AiStore {
    /// Strict authored transcript preset for local review/adoption E2E only.
    /// The saved responses represent no provider execution or user approval.
    pub fn seed_transcript_review_fixture(
        &self,
        plan: PreparedJob,
        pending: bool,
    ) -> Result<JobQuote> {
        plan.validate()?;
        let media_id = if pending {
            "e2e-transcript-pending"
        } else {
            "e2e-transcript-review"
        };
        let expected_audio = transcript_fixture_wav();
        if plan.project_id != "e2e-project"
            || plan.credential_id != "unused-e2e-fixture"
            || plan.binding.media_id != media_id
            || plan.requests.len() != 2
        {
            return Err(AiError::Invalid(
                "Only the fixed offline transcript review fixture is allowed".into(),
            ));
        }
        for (ordinal, request) in plan.requests.iter().enumerate() {
            let RequestTask::TranscribePreview { language, audio } = request else {
                return Err(AiError::Invalid("Invalid transcript fixture task".into()));
            };
            if language != "en"
                || !audio.path.is_absolute()
                || audio.source_start_ms != ordinal as u64 * 1000
                || audio.duration_ms != 7000
                || audio.mime_type != "audio/wav"
                || audio.verified_bytes()? != expected_audio
            {
                return Err(AiError::Invalid(
                    "Transcript fixture requires its fixed seven-second silence inputs".into(),
                ));
            }
        }
        let outputs = [
            ParsedOutput::Transcript {
                cues: vec![
                    GeneratedCue {
                        start_ms: 500,
                        end_ms: 1000,
                        text: "Hello.".into(),
                    },
                    GeneratedCue {
                        start_ms: 3500,
                        end_ms: 4500,
                        text: "No, no.".into(),
                    },
                ],
            },
            ParsedOutput::Transcript {
                cues: vec![
                    GeneratedCue {
                        start_ms: 3500,
                        end_ms: 4500,
                        text: "No.".into(),
                    },
                    GeneratedCue {
                        start_ms: 7500,
                        end_ms: 7900,
                        text: "Goodbye.".into(),
                    },
                ],
            },
        ];
        let received = if pending { 1 } else { 2 };
        let quote = self.prepare(plan)?;
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let attempts: i64 = tx.query_row(
            "SELECT COUNT(*) FROM ai_attempts WHERE job_id=?",
            [&quote.id],
            |r| r.get(0),
        )?;
        let mut existing = Vec::new();
        for ordinal in 0..2 {
            let row: (String, Option<String>) = tx.query_row(
                "SELECT state,response_json FROM ai_requests WHERE job_id=? AND ordinal=?",
                params![quote.id, ordinal],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            existing.push(row);
        }
        let usage = r#"{"offlineFixture":true,"paidRequests":0,"fixtureKind":"transcript-review"}"#;
        if attempts > 0 {
            let free_attempts: i64 = tx.query_row(
                "SELECT COUNT(*) FROM ai_attempts WHERE job_id=? AND state='settled' AND reserve_microusd=0 AND charged_microusd=0 AND usage_json=?",
                params![quote.id, usage],
                |r| r.get(0),
            )?;
            let correct = existing
                .iter()
                .enumerate()
                .all(|(ordinal, (state, response))| {
                    if ordinal < received {
                        state == "completed"
                            && response.as_deref()
                                == serde_json::to_string(&outputs[ordinal]).ok().as_deref()
                    } else {
                        state == "pending" && response.is_none()
                    }
                });
            if attempts != received as i64 || free_attempts != attempts || !correct {
                return Err(AiError::Invalid(
                    "Transcript fixture must not replace existing attempts or results".into(),
                ));
            }
            tx.commit()?;
            return self.quote(&quote.id);
        }
        if existing
            .iter()
            .any(|(state, output)| state != "pending" || output.is_some())
        {
            return Err(AiError::Invalid(
                "Transcript fixture requires untouched pending requests".into(),
            ));
        }
        let at = self.now_ms();
        for (ordinal, output) in outputs.iter().enumerate().take(received) {
            tx.execute("INSERT INTO ai_attempts(id,job_id,ordinal,state,reserve_microusd,charged_microusd,created_at_ms,settled_at_ms,usage_json) VALUES (?, ?, ?, 'settled', 0, 0, ?, ?, ?)", params![uuid::Uuid::new_v4().to_string(), quote.id, ordinal as i64, at, at, usage])?;
            tx.execute(
                "UPDATE ai_requests SET state='completed',response_json=? WHERE job_id=? AND ordinal=?",
                params![serde_json::to_string(output)?, quote.id, ordinal as i64],
            )?;
        }
        tx.execute(
            "UPDATE ai_jobs SET state=? WHERE id=?",
            params![if pending { "needs_review" } else { "completed" }, quote.id],
        )?;
        audit(
            &tx,
            at,
            "offline_transcript_fixture",
            Some(&quote.id),
            "Authored variants for local review only; no credential, network or approval",
        )?;
        tx.commit()?;
        self.quote(&quote.id)
    }

    pub fn seed_translation_recovery_fixture(&self, plan: PreparedJob) -> Result<JobQuote> {
        plan.validate()?;
        let expected = vec![
            SourceCue {
                id: "e2e-ai-recovery-1".into(),
                start_ms: 0,
                end_ms: 1000,
                text: "Hello.".into(),
            },
            SourceCue {
                id: "e2e-ai-recovery-2".into(),
                start_ms: 1000,
                end_ms: 2000,
                text: "See you tomorrow.".into(),
            },
        ];
        if plan.project_id != "e2e-project"
            || plan.credential_id != "unused-e2e-fixture"
            || plan.binding.media_id != "e2e-ai-recovery"
            || plan.requests
                != vec![RequestTask::Translation {
                    target_language: "ja".into(),
                    cues: expected,
                }]
        {
            return Err(AiError::Invalid(
                "Only the fixed offline translation recovery fixture is allowed".into(),
            ));
        }
        let quote = self.prepare(plan)?;
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state: String = tx.query_row(
            "SELECT state FROM ai_requests WHERE job_id=? AND ordinal=0",
            [&quote.id],
            |r| r.get(0),
        )?;
        if state == "completed" {
            tx.commit()?;
            return self.quote(&quote.id);
        }
        let attempts: i64 = tx.query_row(
            "SELECT COUNT(*) FROM ai_attempts WHERE job_id=?",
            [&quote.id],
            |r| r.get(0),
        )?;
        if state != "pending" || attempts != 0 {
            return Err(AiError::Invalid(
                "Recovery fixture must not overwrite an existing attempt".into(),
            ));
        }
        let output = ParsedOutput::Translation {
            translations: vec![
                CueTranslation {
                    id: "e2e-ai-recovery-1".into(),
                    translation: "こんにちは。".into(),
                },
                CueTranslation {
                    id: "e2e-ai-recovery-2".into(),
                    translation: "また明日。".into(),
                },
            ],
        };
        let at = self.now_ms();
        tx.execute("INSERT INTO ai_attempts(id,job_id,ordinal,state,reserve_microusd,charged_microusd,created_at_ms,settled_at_ms,usage_json) VALUES (?, ?, 0, 'settled', 0, 0, ?, ?, ?)", params![uuid::Uuid::new_v4().to_string(), quote.id, at, at, r#"{"offlineFixture":true,"paidRequests":0}"#])?;
        tx.execute(
            "UPDATE ai_requests SET state='completed',response_json=? WHERE job_id=? AND ordinal=0",
            params![serde_json::to_string(&output)?, quote.id],
        )?;
        tx.execute(
            "UPDATE ai_jobs SET state='completed' WHERE id=?",
            [&quote.id],
        )?;
        audit(
            &tx,
            at,
            "offline_recovery_fixture",
            Some(&quote.id),
            "No network request, credential, or budget approval",
        )?;
        tx.commit()?;
        self.quote(&quote.id)
    }
}

fn transcript_fixture_wav() -> Vec<u8> {
    let mut bytes = vec![0u8; 44 + 7 * 16000 * 2];
    bytes[0..4].copy_from_slice(b"RIFF");
    bytes[4..8].copy_from_slice(&(36u32 + 224000).to_le_bytes());
    bytes[8..16].copy_from_slice(b"WAVEfmt ");
    bytes[16..20].copy_from_slice(&16u32.to_le_bytes());
    bytes[20..22].copy_from_slice(&1u16.to_le_bytes());
    bytes[22..24].copy_from_slice(&1u16.to_le_bytes());
    bytes[24..28].copy_from_slice(&16000u32.to_le_bytes());
    bytes[28..32].copy_from_slice(&32000u32.to_le_bytes());
    bytes[32..34].copy_from_slice(&2u16.to_le_bytes());
    bytes[34..36].copy_from_slice(&16u16.to_le_bytes());
    bytes[36..40].copy_from_slice(b"data");
    bytes[40..44].copy_from_slice(&224000u32.to_le_bytes());
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> PreparedJob {
        PreparedJob::fixture(
            "Offline recovery".into(),
            "e2e-project".into(),
            "unused-e2e-fixture".into(),
            PreparationBinding {
                media_id: "e2e-ai-recovery".into(),
                transcript_revision: "fixture".into(),
                source_sha256: crate::sha256_bytes(b"source"),
                settings_sha256: crate::sha256_bytes(b"settings"),
            },
            vec![RequestTask::Translation {
                target_language: "ja".into(),
                cues: vec![
                    SourceCue {
                        id: "e2e-ai-recovery-1".into(),
                        start_ms: 0,
                        end_ms: 1000,
                        text: "Hello.".into(),
                    },
                    SourceCue {
                        id: "e2e-ai-recovery-2".into(),
                        start_ms: 1000,
                        end_ms: 2000,
                        text: "See you tomorrow.".into(),
                    },
                ],
            }],
        )
    }

    fn transcript_plan(root: &std::path::Path, pending: bool) -> PreparedJob {
        let path = root.join("transcript-fixture.wav");
        std::fs::write(&path, transcript_fixture_wav()).unwrap();
        let mut prepared = plan();
        prepared.binding.media_id = if pending {
            "e2e-transcript-pending"
        } else {
            "e2e-transcript-review"
        }
        .into();
        prepared.requests = (0..2)
            .map(|ordinal| RequestTask::TranscribePreview {
                language: "en".into(),
                audio: AudioAttachment::from_file(path.clone(), ordinal * 1000, 7000).unwrap(),
            })
            .collect();
        prepared.refreeze()
    }

    #[test]
    fn transcript_presets_retain_raw_disagreement_and_pending_output_without_approval() {
        let directory = tempfile::tempdir().unwrap();
        let store = AiStore::open(directory.path().join("charges.sqlite")).unwrap();
        for pending in [false, true] {
            let plan = transcript_plan(directory.path(), pending);
            let quote = store
                .seed_transcript_review_fixture(plan.clone(), pending)
                .unwrap();
            assert_eq!(
                quote.state,
                if pending { "needs_review" } else { "completed" }
            );
            assert_eq!(
                store
                    .seed_transcript_review_fixture(plan, pending)
                    .unwrap()
                    .id,
                quote.id
            );
            let ParsedOutput::Transcript { cues } = store.response(&quote.id, 0).unwrap().unwrap()
            else {
                panic!("transcript expected")
            };
            assert_eq!(cues[1].text, "No, no.");
            if pending {
                assert!(store.response(&quote.id, 1).unwrap().is_none());
            } else {
                let ParsedOutput::Transcript { cues } =
                    store.response(&quote.id, 1).unwrap().unwrap()
                else {
                    panic!("transcript expected")
                };
                assert_eq!(cues[0].text, "No.");
            }
            assert!(store.reserve_next(&quote.id).is_err());
        }
        let connection = store.connect().unwrap();
        let (attempts, approved): (u32, u32) = connection.query_row(
            "SELECT (SELECT COUNT(*) FROM ai_attempts), (SELECT COUNT(*) FROM ai_jobs WHERE approved_at_ms IS NOT NULL)", [], |r| Ok((r.get(0)?, r.get(1)?))
        ).unwrap();
        assert_eq!(attempts, 3);
        assert_eq!(approved, 0);
        assert_eq!(store.summary().unwrap().limits, BudgetLimits::default());
        assert_eq!(store.summary().unwrap().monthly_charged_or_held_microusd, 0);
    }

    #[test]
    fn transcript_preset_rejects_arbitrary_audio_or_task_before_creating_jobs() {
        let directory = tempfile::tempdir().unwrap();
        let store = AiStore::open(directory.path().join("charges.sqlite")).unwrap();
        let mut changed = transcript_plan(directory.path(), false);
        if let RequestTask::TranscribePreview { language, .. } = &mut changed.requests[0] {
            *language = "ja".into();
        }
        assert!(store
            .seed_transcript_review_fixture(changed, false)
            .is_err());
        let mut changed = transcript_plan(directory.path(), false);
        if let RequestTask::TranscribePreview { audio, .. } = &mut changed.requests[0] {
            let mut data = transcript_fixture_wav();
            *data.last_mut().unwrap() = 1;
            std::fs::write(&audio.path, data).unwrap();
            *audio = AudioAttachment::from_file(audio.path.clone(), 0, 7000).unwrap();
        }
        assert!(store
            .seed_transcript_review_fixture(changed, false)
            .is_err());
        let count: u32 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ai_jobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn preset_is_idempotent_offline_and_does_not_change_budget() {
        let dir = tempfile::tempdir().unwrap();
        let store = AiStore::open(dir.path().join("charges.sqlite")).unwrap();
        let q = store.seed_translation_recovery_fixture(plan()).unwrap();
        assert_eq!(
            store.seed_translation_recovery_fixture(plan()).unwrap().id,
            q.id
        );
        assert_eq!(q.state, "completed");
        assert!(store.response(&q.id, 0).unwrap().is_some());
        let summary = store.summary().unwrap();
        assert_eq!(summary.limits, BudgetLimits::default());
        assert_eq!(summary.monthly_charged_or_held_microusd, 0);
        assert!(store.reserve_next(&q.id).is_err());
    }

    #[test]
    fn arbitrary_fixture_input_is_rejected_before_preparation() {
        let dir = tempfile::tempdir().unwrap();
        let store = AiStore::open(dir.path().join("charges.sqlite")).unwrap();
        let mut changed = plan();
        if let RequestTask::Translation { cues, .. } = &mut changed.requests[0] {
            cues[0].text = "Arbitrary data".into();
        }
        assert!(store.seed_translation_recovery_fixture(changed).is_err());
        let count: i64 = store
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ai_jobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
