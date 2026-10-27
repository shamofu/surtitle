//! Small, exhaustive schedules over real Store transactions, not a model Store.
use super::*;

const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
type Interval = (u64, u64);

// No state deduplication: equal visible rows can hide different approval,
// protection, received-coverage, edition and restart histories.
fn legal_orders(prerequisites: &[&[usize]]) -> Vec<Vec<usize>> {
    fn visit(edges: &[&[usize]], path: &mut Vec<usize>, orders: &mut Vec<Vec<usize>>) {
        if path.len() == edges.len() {
            orders.push(path.clone());
        } else {
            for action in 0..edges.len() {
                if !path.contains(&action) && edges[action].iter().all(|p| path.contains(p)) {
                    path.push(action);
                    visit(edges, path, orders);
                    path.pop();
                }
            }
        }
    }
    let mut orders = Vec::new();
    visit(prerequisites, &mut Vec::new(), &mut orders);
    orders
}

fn same(a: &SubtitleSegment, b: &SubtitleSegment) -> bool {
    serde_json::to_value(a).unwrap() == serde_json::to_value(b).unwrap()
}

fn intersects(a: Interval, b: Interval) -> bool {
    // Half-open intervals; endpoint contact alone conveys no ownership.
    a.0.max(b.0) < a.1.min(b.1)
}

fn interval(row: &SubtitleSegment) -> Interval {
    (row.start_ms, row.end_ms)
}

fn effective(row: &SubtitleSegment, selection: Interval) -> Interval {
    if row.timing_precision == "source_block" {
        (row.start_ms.max(selection.0), row.end_ms.min(selection.1))
    } else {
        interval(row)
    }
}

// This oracle deliberately does not compute a replacement projection. It checks
// preservation and authority obligations against the actual before/after rows.
// Coverage uses elementary milliseconds, independently of production merging.
fn publication_contract(
    before: &[SubtitleSegment],
    after: &[SubtitleSegment],
    selection: Interval,
    received: &[bool],
    manual: &[Interval],
    claimed: &[Interval],
) -> Result<(), &'static str> {
    for row in before {
        let incomplete_precise = row.timing_precision == "cue"
            && (!(selection.0 <= row.start_ms && row.end_ms <= selection.1)
                || !(row.start_ms..row.end_ms).all(|ms| received[ms as usize]));
        let protected = manual.iter().any(|p| intersects(interval(row), *p))
            || claimed
                .iter()
                .any(|p| intersects(effective(row, selection), *p));
        if (incomplete_precise || protected) && !after.iter().any(|actual| same(row, actual)) {
            return Err("a protected or incomplete whole row changed");
        }
    }
    for row in after {
        if !before.iter().any(|old| same(old, row))
            && manual
                .iter()
                .chain(claimed)
                .any(|p| intersects(effective(row, selection), *p))
        {
            return Err("publication wrote into manual or newer approved ownership");
        }
    }
    Ok(())
}

fn quote(store: &mut Store, job: &str, selection: Interval) {
    let revision = subtitle_revision(&store.list_segments("media").unwrap()).unwrap();
    store
        .begin_transcript_publication(job, DIGEST, "media", &revision, selection.0, selection.1)
        .unwrap();
}

fn session(store: &Store, job: &str) -> PublicationSession {
    let json: String = store
        .conn
        .query_row(
            "SELECT data FROM transcript_publications WHERE job_id=?",
            [job],
            |r| r.get(0),
        )
        .unwrap();
    serde_json::from_str(&json).unwrap()
}

struct Audit {
    baseline: Vec<SubtitleSegment>,
    manual_ranges: Vec<Interval>,
    manual_row: Option<SubtitleSegment>,
    deleted: Option<String>,
    changed_jobs: HashSet<String>,
    coverage: BTreeMap<String, Vec<bool>>,
    publications: usize,
}

impl Audit {
    fn new(baseline: &[SubtitleSegment]) -> Self {
        Self {
            baseline: baseline.to_vec(),
            manual_ranges: Vec::new(),
            manual_row: None,
            deleted: None,
            changed_jobs: HashSet::new(),
            coverage: BTreeMap::new(),
            publications: 0,
        }
    }

    fn check(&self, store: &Store) {
        if let Some(row) = &self.manual_row {
            assert!(
                same(&store.segment(&row.id).unwrap(), row),
                "manual edit was lost"
            );
        }
        if let Some(id) = &self.deleted {
            assert!(store.segment(id).is_err(), "deleted row was resurrected");
        }
        let versions = store.subtitle_versions("media").unwrap();
        assert_eq!(
            versions.len(),
            self.changed_jobs.len(),
            "each changing job saves its quoted edition once"
        );
        for version in versions {
            assert_eq!(
                serde_json::to_value(version.segments).unwrap(),
                serde_json::to_value(&self.baseline).unwrap()
            );
        }
        for job in ["older", "newer"] {
            let saved = session(store, job);
            assert_eq!(saved.version_saved, self.changed_jobs.contains(job));
            // Public edit_segment commits both sides of a move with the row.
            // A fixture SQL deletion is detected on the next publication instead.
            if self.deleted.is_none() {
                for protected in &self.manual_ranges {
                    assert!(
                        (protected.0..protected.1).all(|ms| {
                            saved
                                .protected_ranges
                                .iter()
                                .any(|r| r.start_ms <= ms && ms < r.end_ms)
                        }),
                        "manual row/protection did not commit together for {job}"
                    );
                }
            }
        }
    }

    fn publish(
        &mut self,
        store: &mut Store,
        target: (&str, Interval),
        received: Interval,
        projection: &[SubtitleSegment],
        claimed: &[Interval],
        trace: &str,
    ) {
        let (job, selection) = target;
        let before = store.list_segments("media").unwrap();
        let cells = self
            .coverage
            .entry(job.into())
            .or_insert_with(|| vec![false; 12000]);
        for ms in received.0..received.1 {
            cells[ms as usize] = true;
        }
        let report = publish(store, job, received.0, received.1, projection);
        let after = store.list_segments("media").unwrap();
        publication_contract(
            &before,
            &after,
            selection,
            cells,
            &self.manual_ranges,
            claimed,
        )
        .unwrap_or_else(|violation| panic!("{trace}: {violation}"));
        assert!(!report.detached, "{trace}");
        let changed =
            serde_json::to_value(&before).unwrap() != serde_json::to_value(&after).unwrap();
        assert_eq!(report.changed, changed, "{trace}");
        if changed {
            self.changed_jobs.insert(job.into());
        }
        let saved = session(store, job);
        assert_eq!(
            serde_json::to_value(saved.expected).unwrap(),
            serde_json::to_value(after).unwrap(),
            "{trace}: rows/session must commit together"
        );
        assert_eq!(
            serde_json::to_value(saved.latest_projection).unwrap(),
            serde_json::to_value(projection).unwrap(),
            "{trace}: deferred results remain inspectable"
        );
        for ms in selection.0..selection.1 {
            assert_eq!(
                saved
                    .received_ranges
                    .iter()
                    .any(|r| r.start_ms <= ms && ms < r.end_ms),
                cells[ms as usize],
                "{trace}: received coverage"
            );
        }
        for protected in &self.manual_ranges {
            assert!(
                (protected.0..protected.1).all(|ms| saved
                    .protected_ranges
                    .iter()
                    .any(|r| r.start_ms <= ms && ms < r.end_ms)),
                "{trace}: manual protection was not persisted"
            );
        }
        for row in projection
            .iter()
            .filter(|r| r.timing_precision == "source_block")
        {
            if let Ok(actual) = store.segment(&row.id) {
                assert_eq!(
                    interval(&actual),
                    interval(row),
                    "{trace}: source bounds were relabeled as cue timing"
                );
                assert_eq!(actual.timing_precision, "source_block");
            }
        }
        self.publications += 1;
        self.check(store);
    }

    fn edit(&mut self, store: &Store, kind: usize) {
        // This cue is either the original or its earlier provider replacement.
        // The other job's intervals never cover it, so the action is always legal.
        let mut row = store
            .list_segments("media")
            .unwrap()
            .into_iter()
            .find(|row| interval(row) == (1000, 2000))
            .unwrap();
        self.manual_ranges.push(interval(&row));
        match kind {
            0 => row.text = "Authored correction".into(),
            1 => row.translation = Some("Authored translation".into()),
            2 => {
                // There is no public single-row deletion API. As in the existing
                // deletion regression, mutate the real SQLite fixture directly;
                // publication must detect this missing row before replacing it.
                store
                    .conn
                    .execute("DELETE FROM segments WHERE id=?", [&row.id])
                    .unwrap();
                self.deleted = Some(row.id);
                return;
            }
            3 => {
                row.start_ms = 7000;
                row.end_ms = 7500;
                self.manual_ranges.push(interval(&row));
            }
            _ => unreachable!(),
        }
        store.edit_segment(&row).unwrap();
        self.manual_row = Some(row);
    }
}

fn originals() -> Vec<SubtitleSegment> {
    vec![
        cue("local", 1000, 2000, "Original local"),
        cue(
            "whole",
            3500,
            6500,
            "Original crossing the receive boundary",
        ),
        cue("outside", 9000, 10000, "Original outside"),
    ]
}

#[test]
fn bounded_approval_edit_and_delayed_publication_orders() {
    // Actions: old approval, new approval, local mutation, old partial,
    // old complete, new complete. Only causal dependencies are encoded:
    // old approval < new approval; approval < own result; partial < complete.
    let orders = legal_orders(&[&[], &[0], &[], &[0], &[3], &[1]]);
    assert_eq!(orders.len(), 36);
    let classes = [
        ("disjoint", (9000, 11000), (9200, 9800)),
        ("touching", (8000, 10000), (9200, 9800)),
        ("overlap", (6000, 10000), (7000, 7500)),
        ("containment", (2000, 7000), (4000, 5000)),
    ];
    let mut reached = HashSet::new();
    let mut publication_count = 0;
    for (class, newer, new_cue) in classes {
        for edit in 0..4 {
            for block in [false, true] {
                for order in &orders {
                    let baseline = originals();
                    let (_directory, mut store) = fixture(&baseline);
                    quote(&mut store, "older", (0, 8000));
                    quote(&mut store, "newer", newer);
                    let mut audit = Audit::new(&baseline);
                    let first = cue("older:first", 1000, 2000, "Old job first");
                    let mut middle = cue("older:middle", 3500, 6500, "Old job middle");
                    if block {
                        middle.start_ms = 3000;
                        middle.end_ms = 8500;
                        middle.timing_precision = "source_block".into();
                    }
                    let projection = [
                        first.clone(),
                        middle,
                        cue("older:last", 7000, 7500, "Old job last"),
                    ];
                    let mut approved = false;
                    for &action in order {
                        let trace = format!(
                            "{class}, edit={edit}, block={block}, order={order:?}, action={action}"
                        );
                        match action {
                            0 => store
                                .activate_transcript_publication("older", DIGEST)
                                .unwrap(),
                            1 => {
                                store
                                    .activate_transcript_publication("newer", DIGEST)
                                    .unwrap();
                                approved = true;
                            }
                            2 => audit.edit(&store, edit),
                            3 | 4 => {
                                let claims = if approved { vec![newer] } else { vec![] };
                                let end = if action == 3 { 4000 } else { 8000 };
                                audit.publish(
                                    &mut store,
                                    ("older", (0, 8000)),
                                    (0, end),
                                    &projection,
                                    &claims,
                                    &trace,
                                );
                                if !approved && class == "containment" && action == 4 && !block {
                                    assert!(
                                        store.segment("older:middle").is_ok(),
                                        "a quote alone claimed ownership"
                                    );
                                    reached.insert("quote_without_ownership");
                                }
                                if approved && class == "containment" {
                                    assert!(
                                        store.segment("older:middle").is_err()
                                            || store
                                                .transcript_publication_candidates("older", DIGEST)
                                                .unwrap()
                                                .iter()
                                                .any(|r| r.id == "older:middle")
                                    );
                                    reached.insert("new_approval_blocks_late_old");
                                }
                                if action == 3 && store.segment("whole").is_ok() {
                                    reached.insert("incomplete_whole_cue_retained");
                                    if block
                                        && !approved
                                        && !audit
                                            .manual_ranges
                                            .iter()
                                            .any(|p| intersects(*p, (3000, 8000)))
                                    {
                                        assert!(
                                            store.segment("older:middle").is_ok(),
                                            "partially received source blocks must coexist with the retained precise cue: {trace}"
                                        );
                                        reached.insert("partial_block_coexists_with_whole_cue");
                                    }
                                }
                            }
                            5 => {
                                audit.publish(
                                    &mut store,
                                    ("newer", newer),
                                    newer,
                                    &[cue(
                                        "newer:result",
                                        new_cue.0,
                                        new_cue.1,
                                        "New approved job",
                                    )],
                                    &[],
                                    &trace,
                                );
                                if !audit.manual_ranges.iter().any(|p| intersects(*p, new_cue)) {
                                    assert!(
                                        store.segment("newer:result").is_ok(),
                                        "approved unprotected result did not publish: {trace}"
                                    );
                                }
                            }
                            _ => unreachable!(),
                        }
                        audit.check(&store);
                    }
                    if order.iter().position(|a| *a == 2) < order.iter().position(|a| *a == 3) {
                        reached.insert("edit_before_partial");
                    } else {
                        reached.insert("edit_after_partial");
                    }
                    publication_count += audit.publications;
                }
            }
        }
    }
    assert_eq!(publication_count, 4 * 4 * 2 * 36 * 3);
    assert_eq!(
        reached.len(),
        6,
        "mandatory approval/edit/whole-cue/source-block branches must actually execute"
    );
}

#[test]
fn bounded_partial_restart_edit_and_duplicate_orders() {
    // Approve < partial < {restart, edit, duplicate}; duplicate < complete.
    // Restart and edit can occur on either side of the other received results.
    let orders = legal_orders(&[&[], &[0], &[1], &[1], &[1], &[4]]);
    assert_eq!(orders.len(), 12);
    let mut branches = HashSet::new();
    for edit in [0, 1, 3] {
        for order in &orders {
            let baseline = originals();
            let (directory, mut store) = fixture(&baseline);
            quote(&mut store, "older", (0, 8000));
            quote(&mut store, "newer", (2000, 7000)); // unapproved across restart
            let mut audit = Audit::new(&baseline);
            let first = cue("older:first", 1000, 2000, "First received");
            let complete = [
                first.clone(),
                cue("older:middle", 3500, 6500, "Later received"),
            ];
            for &action in order {
                let trace = format!("restart, edit={edit}, order={order:?}, action={action}");
                match action {
                    0 => store
                        .activate_transcript_publication("older", DIGEST)
                        .unwrap(),
                    1 | 4 => audit.publish(
                        &mut store,
                        ("older", (0, 8000)),
                        (0, 4000),
                        std::slice::from_ref(&first),
                        &[],
                        &trace,
                    ),
                    2 => {
                        drop(store);
                        store = Store::open(directory.path().join("learning.sqlite")).unwrap();
                    }
                    3 => audit.edit(&store, edit),
                    5 => audit.publish(
                        &mut store,
                        ("older", (0, 8000)),
                        (4000, 8000),
                        &complete,
                        &[],
                        &trace,
                    ),
                    _ => unreachable!(),
                }
                audit.check(&store);
                if action == 1 || action == 4 {
                    assert!(store.segment("whole").is_ok());
                }
            }
            assert!(store.segment("older:middle").is_ok());
            assert_eq!(audit.changed_jobs.len(), 1);
            branches
                .insert(order.iter().position(|a| *a == 2) < order.iter().position(|a| *a == 4));
        }
    }
    assert_eq!(branches, [false, true].into_iter().collect());
}

fn authority_snapshot(store: &Store) -> serde_json::Value {
    let sessions: Vec<(String, bool, bool, bool, String)> = store.conn.prepare(
        "SELECT job_id,activated,detached,finished,data FROM transcript_publications ORDER BY job_id"
    ).unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).unwrap()
        .collect::<rusqlite::Result<_>>().unwrap();
    let adoptions: i64 = store
        .conn
        .query_row("SELECT count(*) FROM transcript_adoptions", [], |r| {
            r.get(0)
        })
        .unwrap();
    serde_json::json!({"rows": store.list_segments("media").unwrap(), "sessions": sessions,
        "versions": store.subtitle_versions("media").unwrap(), "adoptions": adoptions})
}

#[test]
fn bounded_detach_restart_late_results_and_local_adoption_orders() {
    // A common real prefix provides two approved jobs, a partially received
    // edition and a saved original. Detach precedes the four late local actions;
    // restart may happen before or after any result/application attempt.
    let orders = legal_orders(&[&[], &[0], &[0], &[0], &[0]]);
    assert_eq!(orders.len(), 24);
    for detach in ["import", "edition", "learning"] {
        for order in &orders {
            let baseline = originals();
            let (directory, mut store) = fixture(&baseline);
            let archive = store.archive().unwrap();
            begin(&mut store, "older", 0, 12000);
            publish(
                &mut store,
                "older",
                0,
                4000,
                &[cue("first", 1000, 2000, "Received")],
            );
            let edition = store.subtitle_versions("media").unwrap()[0].id.clone();
            begin(&mut store, "newer", 4000, 12000);
            let mut detached = None;
            for &action in order {
                match action {
                    0 => {
                        match detach {
                            "import" => store
                                .replace_subtitles(
                                    "media",
                                    &[cue("import", 1000, 2000, "Imported")],
                                    None,
                                    true,
                                    "Import",
                                )
                                .unwrap(),
                            "edition" => store.restore_subtitle_version("media", &edition).unwrap(),
                            "learning" => store
                                .restore(&archive, &directory.path().join("before-restore.sqlite"))
                                .unwrap(),
                            _ => unreachable!(),
                        }
                        for job in ["older", "newer"] {
                            assert!(!store.transcript_publication_active(job, DIGEST).unwrap());
                            assert_eq!(
                                store.transcript_publication_exists(job, DIGEST).unwrap(),
                                detach != "learning"
                            );
                        }
                        detached = Some(authority_snapshot(&store));
                    }
                    1 => {
                        drop(store);
                        store = Store::open(directory.path().join("learning.sqlite")).unwrap();
                    }
                    2 | 3 => {
                        let job = if action == 2 { "older" } else { "newer" };
                        let start = if action == 2 { 0 } else { 4000 };
                        let late = store.publish_transcript_progress(
                            job,
                            DIGEST,
                            &[TranscriptPublicationRange {
                                start_ms: start,
                                end_ms: 12000,
                            }],
                            &[cue("late", 7000, 7500, "Late result")],
                            &[],
                        );
                        if detach == "learning" {
                            assert!(late.is_err());
                        } else {
                            let report = late.unwrap();
                            assert!(report.detached && !report.changed);
                        }
                    }
                    4 => {
                        for job in ["older", "newer"] {
                            assert!(
                                store
                                    .record_published_transcript_adoption(
                                        job,
                                        DIGEST,
                                        &"b".repeat(64)
                                    )
                                    .is_err()
                            );
                        }
                    }
                    _ => unreachable!(),
                }
                assert_eq!(
                    authority_snapshot(&store),
                    *detached.as_ref().unwrap(),
                    "{detach}: {order:?}, action={action}"
                );
            }
        }
    }
}

#[test]
fn publication_contract_oracle_rejects_deliberate_violations() {
    let original = cue("original", 1000, 2000, "Manual text");
    let mut replaced = original.clone();
    replaced.text = "Forbidden overwrite".into();
    let received = vec![true; 12000];
    assert!(
        publication_contract(
            std::slice::from_ref(&original),
            std::slice::from_ref(&replaced),
            (0, 8000),
            &received,
            &[(1000, 2000)],
            &[]
        )
        .is_err()
    );
    assert!(
        publication_contract(
            &[],
            &[cue("old-late", 4000, 5000, "Old job")],
            (0, 8000),
            &received,
            &[],
            &[(2000, 7000)]
        )
        .is_err()
    );
    assert!(
        publication_contract(
            std::slice::from_ref(&original),
            &[],
            (0, 8000),
            &vec![false; 12000],
            &[],
            &[]
        )
        .is_err()
    );
    assert!(
        publication_contract(
            &[],
            &[cue("moved-place", 7000, 7500, "Old job")],
            (0, 8000),
            &received,
            &[(1000, 2000), (7000, 7500)],
            &[]
        )
        .is_err()
    );
    assert!(
        publication_contract(
            std::slice::from_ref(&original),
            std::slice::from_ref(&original),
            (0, 8000),
            &received,
            &[],
            &[]
        )
        .is_ok()
    );
    assert!(
        publication_contract(
            &[],
            &[cue("touch", 7000, 7500, "Endpoint contact")],
            (0, 8000),
            &received,
            &[],
            &[(2000, 7000)]
        )
        .is_ok()
    );
}
