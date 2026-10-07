//! Chunk boundaries are transport boundaries, never claims about sentence endings.
//! VAD supplies pause candidates only; no detected "silence" is deleted from audio.
mod planning;
mod reconcile;
mod word_reconcile;

pub use planning::{
    plan_chunks, total_request_samples, AudioChunk, BoundaryKind, ChunkOptions, Pause,
    PauseDetector,
};
pub use reconcile::{
    stitch_chunks, BoundaryConflict, BoundaryGroupJoin, ChunkTranscript, StitchedTranscript,
    TimedText,
};

#[cfg(test)]
mod tests;
