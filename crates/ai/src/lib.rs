//! Paid work passes through an immutable plan and durable SQLite reservation.
//! Credentials and HTTP clients stay in native Rust, never in a renderer.
mod chunks;
mod credentials;
mod discovery;
mod execution;
mod ledger;
mod models;
mod prepare;
mod transcribe;
mod transcript_review;
mod vad;
mod vertex;

pub use chunks::*;
pub use credentials::{CredentialMetadata, CredentialVault};
pub use discovery::*;
pub use execution::*;
pub use ledger::*;
pub use models::*;
pub use prepare::*;
#[cfg(feature = "development-validation")]
pub use transcribe::reparse_validation_transcribe_evidence;
pub use transcript_review::*;
pub use vad::*;
pub use vertex::{ExecutionResult, VertexService};

use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("{0}")]
    Invalid(String),
    #[error("Paid work is disabled until nonzero daily, monthly, and job limits are configured")]
    BudgetDisabled,
    #[error("This request exceeds the configured {0} budget")]
    BudgetExceeded(&'static str),
    #[error("Approval is missing, expired, or belongs to a different preparation")]
    ApprovalRequired,
    #[error(
        "A request is running or its outcome is unknown; resolve it before sending another request"
    )]
    InFlight,
    #[error("The provider capability has not been qualified: {0}")]
    Unqualified(String),
    #[error("The price catalog expired; update and review it before paid work")]
    PriceExpired,
    #[error("Credentials could not be read, validated, or unlocked")]
    Credentials,
    #[error("The request may have been billed; automatic retry is disabled")]
    UnknownOutcome,
    #[error("Vertex rejected the request (HTTP {0}); inspect project, model availability, and permissions")]
    Provider(u16),
    #[error("Prepared input changed; prepare and approve a new job")]
    PreparationChanged,
    #[error("{0}")]
    Database(#[from] rusqlite::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("Invalid data: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, AiError>;

pub fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
