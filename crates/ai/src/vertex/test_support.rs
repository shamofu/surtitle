//! Offline application integration support, enabled only by a dev-dependency.
//! No socket, credential vault, endpoint override, or arbitrary response input.
//! The actual worker still reserves, validates, parses and settles each request.
use super::*;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;

#[derive(Clone, Copy)]
pub enum Scenario {
    Translation,
    SendFailure,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    BeforeDispatch,
    AfterSend,
}

pub struct Checkpoint {
    arrived: oneshot::Receiver<()>,
    resume: oneshot::Sender<()>,
}

impl Checkpoint {
    pub async fn reached(&mut self) {
        (&mut self.arrived)
            .await
            .expect("worker reached checkpoint");
    }

    pub fn resume(self) {
        self.resume
            .send(())
            .expect("worker is waiting at checkpoint");
    }
}

struct Pause {
    stage: Stage,
    ordinal: u32,
    arrived: oneshot::Sender<()>,
    resume: oneshot::Receiver<()>,
}

#[derive(Clone, Default)]
struct Gate(Arc<Mutex<Option<Pause>>>);

impl Gate {
    async fn wait(&self, stage: Stage, ordinal: u32) {
        let pause = {
            let mut pending = self.0.lock().unwrap();
            if pending
                .as_ref()
                .is_some_and(|pause| pause.stage == stage && pause.ordinal == ordinal)
            {
                pending.take()
            } else {
                None
            }
        };
        if let Some(pause) = pause {
            pause
                .arrived
                .send(())
                .expect("checkpoint observer is alive");
            pause.resume.await.expect("checkpoint was resumed");
        }
    }
}

struct OfflineAuthorization(Gate);

impl Authorization for OfflineAuthorization {
    async fn access_token(&self, request: &ReservedRequest) -> Result<Zeroizing<String>> {
        self.0.wait(Stage::BeforeDispatch, request.ordinal).await;
        Ok(Zeroizing::new("offline-test-token".into()))
    }
}

struct Reply {
    ordinal: u32,
    expected_body: Value,
    bytes: Vec<u8>,
}

struct OfflineTransport {
    scenario: Scenario,
    replies: Mutex<VecDeque<Reply>>,
    sent: Mutex<Vec<(u32, Value)>>,
    gate: Gate,
}

impl Transport for OfflineTransport {
    type Response = OfflineResponse;

    async fn send(
        &self,
        _: &str,
        _: &str,
        body: &Value,
    ) -> std::result::Result<Self::Response, ()> {
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected offline send or automatic retry");
        assert_eq!(body, &reply.expected_body, "worker must use frozen input");
        self.sent
            .lock()
            .unwrap()
            .push((reply.ordinal, body.clone()));
        self.gate.wait(Stage::AfterSend, reply.ordinal).await;
        match self.scenario {
            Scenario::Translation => Ok(OfflineResponse(Some(reply.bytes))),
            Scenario::SendFailure => Err(()),
        }
    }
}

struct OfflineResponse(Option<Vec<u8>>);

impl ResponseBody for OfflineResponse {
    fn status(&self) -> u16 {
        200
    }

    async fn chunk(&mut self) -> std::result::Result<Option<Vec<u8>>, ()> {
        Ok(self.0.take())
    }
}

/// Two fixed authored translation batches for fixture-cue-00 through -30.
/// Existing job preparation and approval must be performed by the application.
pub struct OfflineVertexService {
    store: AiStore,
    job_id: String,
    auth: OfflineAuthorization,
    transport: OfflineTransport,
}

impl OfflineVertexService {
    pub fn new(store: AiStore, job_id: &str, scenario: Scenario) -> Result<Self> {
        let plan = store.prepared_job(job_id)?;
        if plan.requests.len() != 2 {
            return Err(AiError::Invalid(
                "Offline fixture requires two translation batches".into(),
            ));
        }
        let mut replies = VecDeque::new();
        let remaining = store.quote(job_id)?.remaining_ordinals;
        for (ordinal, task) in plan.requests.iter().enumerate() {
            let RequestTask::Translation {
                target_language,
                cues,
            } = task
            else {
                return Err(AiError::Invalid(
                    "Offline fixture only supports translation".into(),
                ));
            };
            let indices = if ordinal == 0 { 0..30 } else { 30..31 };
            let expected_ids = indices
                .clone()
                .map(|index| format!("fixture-cue-{index:02}"))
                .collect::<Vec<_>>();
            if target_language != "ja" || cues.iter().map(|cue| &cue.id).ne(expected_ids.iter()) {
                return Err(AiError::Invalid(
                    "Offline fixture cue identities differ".into(),
                ));
            }
            let translations = indices
                .map(|index| {
                    serde_json::json!({
                        "id": format!("fixture-cue-{index:02}"),
                        "translation": format!("固定の翻訳 {index:02}。")
                    })
                })
                .collect::<Vec<_>>();
            let response = serde_json::json!({
                "candidates": [{"finishReason": "STOP", "content": {"parts": [{
                    "text": serde_json::to_string(&serde_json::json!({"translations": translations}))?
                }]}}],
                "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20}
            });
            if remaining.contains(&(ordinal as u32)) {
                replies.push_back(Reply {
                    ordinal: ordinal as u32,
                    expected_body: plan.request_body_snapshot(ordinal as u32)?.clone(),
                    bytes: serde_json::to_vec(&response)?,
                });
            }
        }
        let gate = Gate::default();
        Ok(Self {
            store,
            job_id: job_id.into(),
            auth: OfflineAuthorization(gate.clone()),
            transport: OfflineTransport {
                scenario,
                replies: Mutex::new(replies),
                sent: Mutex::new(vec![]),
                gate,
            },
        })
    }

    pub fn checkpoint(&self, stage: Stage, ordinal: u32) -> Checkpoint {
        let (arrived, observe) = oneshot::channel();
        let (resume, wait) = oneshot::channel();
        let mut pending = self.transport.gate.0.lock().unwrap();
        assert!(pending.is_none(), "only one checkpoint may be pending");
        *pending = Some(Pause {
            stage,
            ordinal,
            arrived,
            resume: wait,
        });
        Checkpoint {
            arrived: observe,
            resume,
        }
    }

    pub fn sent_ordinals(&self) -> Vec<u32> {
        self.transport
            .sent
            .lock()
            .unwrap()
            .iter()
            .map(|(ordinal, _)| *ordinal)
            .collect()
    }

    pub async fn execute_next_with_guard(
        &self,
        job_id: &str,
        before_send: impl FnOnce() -> Result<()>,
    ) -> Result<Option<ExecutionResult>> {
        if job_id != self.job_id {
            return Err(AiError::Invalid(
                "Offline fixture belongs to another job".into(),
            ));
        }
        execute_with_io(
            &self.store,
            &self.auth,
            &self.transport,
            job_id,
            before_send,
        )
        .await
    }
}
