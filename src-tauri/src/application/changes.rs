//! Revisioned resource notifications. Playback positions never enter this channel.
use super::lock;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeDomain {
    Media,
    Cards,
    Settings,
    Tools,
    Jobs,
    Budget,
    Subtitles,
    Drafts,
    Review,
    Operations,
    Restore,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataChange {
    pub version: u8,
    pub epoch: String,
    pub revision: u64,
    pub domain: ChangeDomain,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DomainRevision {
    pub domain: ChangeDomain,
    pub revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeCheckpoint {
    pub version: u8,
    pub epoch: String,
    pub revision: u64,
    pub domains: Vec<DomainRevision>,
}
type Publisher = Arc<dyn Fn(&DataChange) + Send + Sync>;
struct State {
    epoch: String,
    revision: u64,
    domains: BTreeMap<ChangeDomain, u64>,
    publisher: Option<Publisher>,
}
#[derive(Clone)]
pub struct Changes(Arc<Mutex<State>>, Arc<Mutex<()>>);
impl Default for Changes {
    fn default() -> Self {
        Self(
            Arc::new(Mutex::new(State {
                epoch: surtitle_core::id(),
                revision: 0,
                domains: BTreeMap::new(),
                publisher: None,
            })),
            Arc::default(),
        )
    }
}
impl Changes {
    pub fn install(&self, publisher: impl Fn(&DataChange) + Send + Sync + 'static) -> Result<()> {
        lock(&self.0)?.publisher = Some(Arc::new(publisher));
        Ok(())
    }
    pub fn publish(&self, domain: ChangeDomain, entity_id: Option<String>) {
        // Keep emit order equal to revision order across worker threads. The
        // callback only publishes to the app bridge, never mutates these changes.
        let Ok(_publishing) = lock(&self.1) else {
            return;
        };
        let (event, publish) = {
            let Ok(mut state) = lock(&self.0) else { return };
            state.revision += 1;
            let revision = state.revision;
            state.domains.insert(domain, revision);
            (
                DataChange {
                    version: 1,
                    epoch: state.epoch.clone(),
                    revision,
                    domain,
                    entity_id,
                },
                state.publisher.clone(),
            )
        };
        // Never run an app callback while a revision mutex is held.
        if let Some(publish) = publish {
            publish(&event);
        }
    }
    pub fn checkpoint(&self) -> Result<ChangeCheckpoint> {
        let state = lock(&self.0)?;
        Ok(ChangeCheckpoint {
            version: 1,
            epoch: state.epoch.clone(),
            revision: state.revision,
            domains: state
                .domains
                .iter()
                .map(|(&domain, &revision)| DomainRevision { domain, revision })
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkpoint_covers_dropped_events_without_repeating_unchanged_domains() {
        let changes = Changes::default();
        changes.publish(ChangeDomain::Cards, Some("card-1".into()));
        changes.publish(ChangeDomain::Tools, Some("tool-1".into()));
        changes.publish(ChangeDomain::Cards, Some("card-2".into()));
        let checkpoint = changes.checkpoint().unwrap();
        assert_eq!(checkpoint.revision, 3);
        assert_eq!(
            checkpoint.domains,
            vec![
                DomainRevision {
                    domain: ChangeDomain::Cards,
                    revision: 3
                },
                DomainRevision {
                    domain: ChangeDomain::Tools,
                    revision: 2
                }
            ]
        );
        assert_ne!(
            checkpoint.epoch,
            Changes::default().checkpoint().unwrap().epoch
        );
    }
    #[test]
    fn event_wire_format_matches_frontend_fixture() {
        let fixture = include_str!("../../fixtures/data-change.json");
        let event: DataChange = serde_json::from_str(fixture).unwrap();
        assert_eq!(
            event,
            DataChange {
                version: 1,
                epoch: "session-1".into(),
                revision: 7,
                domain: ChangeDomain::Subtitles,
                entity_id: Some("media-1".into())
            }
        );
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::from_str::<serde_json::Value>(fixture).unwrap()
        );
        assert!(
            serde_json::from_str::<DataChange>(&fixture.replace("subtitles", "playback")).is_err()
        );
    }
    #[test]
    fn response_fixtures_use_the_actual_native_serializers() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/command-results.json")).unwrap();
        let checkpoint = ChangeCheckpoint {
            version: 1,
            epoch: "session-1".into(),
            revision: 7,
            domains: vec![DomainRevision {
                domain: ChangeDomain::Subtitles,
                revision: 7,
            }],
        };
        assert_eq!(
            serde_json::to_value(checkpoint).unwrap(),
            fixture["get_change_checkpoint"]
        );
        let patch = crate::application::ai::snapshot::SnapshotPatch {
            media: Some(vec![]),
            cards: Some(vec![]),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(patch).unwrap(),
            fixture["get_snapshot_patch"]
        );
        assert_eq!(
            serde_json::to_value(Vec::<surtitle_core::workspace::UiDraft>::new()).unwrap(),
            fixture["list_ui_drafts"]
        );
        let archive = surtitle_core::workspace::UiDraft {
            kind: "card".into(),
            entity_id: "card-1".into(),
            revision: 8,
            fields: [("term".into(), "unfinished".into())].into(),
            updated_at: "2026-10-11T00:00:00Z".into(),
            stale: true,
            archive_id: Some("archive-1".into()),
        };
        assert_eq!(
            serde_json::to_value(archive).unwrap(),
            fixture["archive_ui_draft"]
        );
        assert_eq!(
            serde_json::to_value(true).unwrap(),
            fixture["import_subtitles"]
        );
        assert_eq!(
            serde_json::to_value(None::<String>).unwrap(),
            fixture["commit_subtitle_editor_draft"]
        );
        assert_eq!(
            serde_json::to_value(vec!["C:/lesson.mp4"]).unwrap(),
            fixture["select_media_files"]
        );
    }
}
