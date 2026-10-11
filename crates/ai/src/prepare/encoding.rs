//! Bounded local encoding. No unfinished worker can outlive the preparation directory.
use super::{check_cancel, local_error, LocalChild};
use crate::{plan_chunks, AudioAttachment, AudioChunk, ChunkOptions, Pause, Result};
use std::{
    collections::VecDeque,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::JoinHandle,
    time::Duration,
};
use surtitle_tools::ToolSnapshot;

/// Only closed pause evidence inside a fully observed decision window is final.
/// A still-growing pause may change duration tie breaks, so wait for its end.
/// The final tail is always planned after EOF by the authoritative full analysis.
pub(super) fn next_mature_chunk(
    selection_start: u64,
    next_start: u64,
    observed_end: u64,
    pauses: &[Pause],
    options: ChunkOptions,
    index: u32,
) -> Result<Option<AudioChunk>> {
    let samples = |ms: u64| ms * options.sample_rate as u64 / 1000;
    let hard = next_start + samples(options.hard_maximum_ms);
    if observed_end <= hard + samples(options.context_ms)
        || pauses
            .iter()
            .any(|p| p.end_sample == observed_end && p.start_sample <= hard)
    {
        return Ok(None);
    }
    let mut chunk = plan_chunks(next_start, observed_end, pauses, options)?
        .into_iter()
        .next()
        .ok_or_else(|| local_error("missing mature chunk"))?;
    chunk.index = index;
    chunk.request_start_sample = next_start
        .saturating_sub(samples(options.context_ms))
        .max(selection_start);
    Ok(Some(chunk))
}

pub(super) struct Encoders {
    active: VecDeque<JoinHandle<Result<AudioAttachment>>>,
    completed: Vec<AudioAttachment>,
    cancel: Arc<AtomicBool>,
    limit: usize,
}

impl Encoders {
    pub fn new(cancel: Arc<AtomicBool>, limit: usize) -> Self {
        Self {
            active: VecDeque::new(),
            completed: Vec::new(),
            cancel,
            limit,
        }
    }
    pub fn completed(&self) -> u32 {
        self.completed.len() as u32
    }
    fn reap_one(&mut self) -> Result<()> {
        if let Some(worker) = self.active.pop_front() {
            let audio = worker
                .join()
                .map_err(|_| local_error("audio encoder worker failed"))??;
            self.completed.push(audio);
        }
        Ok(())
    }
    pub fn reap_ready(&mut self) -> Result<()> {
        while self.active.front().is_some_and(JoinHandle::is_finished) {
            self.reap_one()?;
        }
        Ok(())
    }
    pub fn enqueue(
        &mut self,
        spool: &Path,
        directory: &Path,
        selection_start: u64,
        chunk: &AudioChunk,
        tool: &ToolSnapshot,
    ) -> Result<()> {
        check_cancel(&self.cancel)?;
        while self.active.len() >= self.limit {
            self.reap_one()?;
        }
        let mut input = std::fs::File::open(spool)?;
        input.seek(SeekFrom::Start(
            (chunk.request_start_sample - selection_start) * 2,
        ))?;
        let byte_count = (chunk.request_end_sample - chunk.request_start_sample) * 2;
        let mut pcm = tempfile::NamedTempFile::new_in(directory)?;
        let copied = std::io::copy(&mut input.take(byte_count), pcm.as_file_mut())?;
        if copied != byte_count {
            return Err(local_error("decoded PCM ended before the prepared span"));
        }
        pcm.flush()?;
        let output = directory.join(format!("chunk-{:05}.flac", chunk.index));
        let tool = tool.clone();
        let chunk = chunk.clone();
        let cancel = self.cancel.clone();
        self.active.push_back(std::thread::spawn(move || {
            encode(pcm, output, &chunk, &tool, cancel)
        }));
        Ok(())
    }
    pub fn finish(mut self, mut progress: impl FnMut(u32)) -> Result<Vec<AudioAttachment>> {
        while !self.active.is_empty() {
            self.reap_one()?;
            progress(self.completed());
        }
        Ok(std::mem::take(&mut self.completed))
    }
}

impl Drop for Encoders {
    fn drop(&mut self) {
        if !self.active.is_empty() {
            self.cancel.store(true, Ordering::Relaxed);
            for worker in self.active.drain(..) {
                let _ = worker.join();
            }
        }
    }
}

fn encode(
    pcm: tempfile::NamedTempFile,
    output: PathBuf,
    chunk: &AudioChunk,
    tool: &ToolSnapshot,
    cancel: Arc<AtomicBool>,
) -> Result<AudioAttachment> {
    let args = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-n".into(),
        "-f".into(),
        "s16le".into(),
        "-ar".into(),
        "16000".into(),
        "-ac".into(),
        "1".into(),
        "-i".into(),
        pcm.path().as_os_str().to_owned(),
        "-c:a".into(),
        "flac".into(),
        output.as_os_str().to_owned(),
    ];
    let (mut child, _) =
        LocalChild::start(tool, &args, false, cancel.clone(), Duration::from_secs(600))?;
    child.finish()?;
    check_cancel(&cancel)?;
    AudioAttachment::from_file(
        output,
        chunk.request_start_ms(),
        chunk.request_duration_ms(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mature_prefix_matches_final_plans_with_context_and_source_offsets() {
        let o = ChunkOptions::default();
        let base = 17_000 * 16;
        for spans in [
            vec![],
            vec![(119_800, 120_500), (239_900, 240_300)],
            vec![(119_800, 120_050)],
            vec![(0, 360_000)],
            vec![(175_000, 190_000)],
        ] {
            let all = spans
                .iter()
                .map(|&(a, b)| Pause {
                    start_sample: base + a * 16,
                    end_sample: base + b * 16,
                })
                .collect::<Vec<_>>();
            for actual_ms in [100_000, 181_000, 260_000, 360_000] {
                let end = base + actual_ms * 16;
                let final_pauses = all
                    .iter()
                    .filter(|p| p.start_sample < end)
                    .map(|p| Pause {
                        start_sample: p.start_sample,
                        end_sample: p.end_sample.min(end),
                    })
                    .collect::<Vec<_>>();
                let exact = plan_chunks(base, end, &final_pauses, o).unwrap();
                let mut mature = Vec::<AudioChunk>::new();
                for elapsed_ms in (1000..actual_ms).step_by(1000) {
                    let observed = base + elapsed_ms * 16;
                    let partial = final_pauses
                        .iter()
                        .filter(|p| p.start_sample < observed)
                        .map(|p| Pause {
                            start_sample: p.start_sample,
                            end_sample: p.end_sample.min(observed),
                        })
                        .collect::<Vec<_>>();
                    let next = mature.last().map_or(base, |c| c.core_end_sample);
                    if let Some(chunk) =
                        next_mature_chunk(base, next, observed, &partial, o, mature.len() as u32)
                            .unwrap()
                    {
                        mature.push(chunk);
                    }
                    assert_eq!(
                        mature,
                        exact[..mature.len()],
                        "duration={actual_ms}, observed={elapsed_ms}"
                    );
                }
            }
        }
    }
    #[test]
    fn active_workers_are_joined_and_cancelled_on_unwind() {
        let cancel = Arc::new(AtomicBool::new(false));
        let stopped = Arc::new(AtomicBool::new(false));
        let mut encoders = Encoders::new(cancel.clone(), 2);
        let observer = cancel.clone();
        let done = stopped.clone();
        encoders.active.push_back(std::thread::spawn(move || {
            while !observer.load(Ordering::Relaxed) {
                std::thread::yield_now();
            }
            done.store(true, Ordering::Relaxed);
            Err(local_error("cancelled"))
        }));
        drop(encoders);
        assert!(cancel.load(Ordering::Relaxed));
        assert!(stopped.load(Ordering::Relaxed));
    }
}
