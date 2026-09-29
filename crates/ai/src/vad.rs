//! Silero VAD v6-compatible ONNX streaming inference. Audio stays local.
use crate::{hash_file, AiError, Pause, PauseDetector, Result};
use ort::{session::Session, value::Tensor};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadAssets {
    pub runtime_path: PathBuf,
    pub runtime_sha256: String,
    pub model_path: PathBuf,
    pub model_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadAnalysis {
    pub sample_rate: u32,
    pub total_samples: u64,
    pub pauses: Vec<Pause>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub low_probability_pauses: Vec<Pause>,
    pub model_sha256: String,
}

pub struct SileroVad {
    session: Session,
    state: Vec<f32>,
    context: [f32; 64],
    model_sha256: String,
}

static RUNTIME: OnceLock<Mutex<Option<(PathBuf, String)>>> = OnceLock::new();

impl SileroVad {
    /// The application supplies digests from its pinned asset manifest, never from a
    /// renderer-selected arbitrary download. Only the verified absolute DLL is loaded.
    pub fn open(assets: VadAssets) -> Result<Self> {
        let runtime_path = assets.runtime_path.canonicalize()?;
        let model_path = assets.model_path.canonicalize()?;
        if hash_file(&runtime_path)? != assets.runtime_sha256
            || hash_file(&model_path)? != assets.model_sha256
        {
            return Err(AiError::Invalid(
                "VAD runtime/model checksum mismatch".into(),
            ));
        }
        let mut runtime = RUNTIME
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| vad_error("runtime lock"))?;
        if let Some((path, hash)) = &*runtime {
            if path != &runtime_path || hash != &assets.runtime_sha256 {
                return Err(vad_error("restart required after runtime replacement"));
            }
        } else {
            #[cfg(windows)]
            preload_windows_runtime(&runtime_path)?;
            let path = runtime_path
                .to_str()
                .ok_or_else(|| vad_error("runtime path is not UTF-8"))?;
            let created = std::panic::catch_unwind(|| {
                ort::init_from(path)
                    .with_name("surtitle-local-vad")
                    .with_telemetry(false)
                    .commit()
            })
            .map_err(|_| vad_error("DLL could not initialize"))?
            .map_err(vad_error)?;
            if !created {
                return Err(vad_error(
                    "ONNX environment was initialized outside the verified asset loader",
                ));
            }
            *runtime = Some((runtime_path, assets.runtime_sha256));
        }
        drop(runtime);
        // Load model bytes already verified, avoiding a second path-based open in ORT.
        let bytes = std::fs::read(&model_path)?;
        if crate::sha256_bytes(&bytes) != assets.model_sha256 {
            return Err(AiError::PreparationChanged);
        }
        let session = Session::builder()
            .map_err(vad_error)?
            .with_intra_threads(1)
            .map_err(vad_error)?
            .with_inter_threads(1)
            .map_err(vad_error)?
            .commit_from_memory(&bytes)
            .map_err(vad_error)?;
        if session.inputs.len() != 3
            || !["input", "state", "sr"]
                .iter()
                .all(|n| session.inputs.iter().any(|i| i.name == *n))
            || session.outputs.len() != 2
        {
            return Err(vad_error("unsupported Silero input/output signature"));
        }
        Ok(Self {
            session,
            state: vec![0.0; 256],
            context: [0.0; 64],
            model_sha256: assets.model_sha256,
        })
    }

    pub fn reset(&mut self) {
        self.state.fill(0.0);
        self.context.fill(0.0);
    }

    fn infer_frame(&mut self, frame: &[f32; 512]) -> Result<f32> {
        let mut input = Vec::with_capacity(576);
        input.extend_from_slice(&self.context);
        input.extend_from_slice(frame);
        let audio = Tensor::from_array(([1usize, 576], input)).map_err(vad_error)?;
        let state =
            Tensor::from_array(([2usize, 1, 128], self.state.clone())).map_err(vad_error)?;
        let sr = Tensor::from_array(([] as [usize; 0], vec![16_000_i64])).map_err(vad_error)?;
        let outputs = self
            .session
            .run(ort::inputs!["input"=>audio,"state"=>state,"sr"=>sr])
            .map_err(vad_error)?;
        let (_, prob) = outputs[0].try_extract_tensor::<f32>().map_err(vad_error)?;
        let (_, state) = outputs[1].try_extract_tensor::<f32>().map_err(vad_error)?;
        if prob.len() != 1
            || state.len() != 256
            || !prob[0].is_finite()
            || !(0.0..=1.0).contains(&prob[0])
            || state.iter().any(|v| !v.is_finite())
        {
            return Err(vad_error("invalid model posterior or recurrent state"));
        }
        self.state.copy_from_slice(state);
        self.context.copy_from_slice(&frame[448..]);
        Ok(prob[0])
    }

    /// Raw signed little-endian PCM, exactly one channel at 16 kHz. The reader is
    /// consumed in bounded frames; no duration-sized audio allocation is made.
    /// Caller must terminate its FFmpeg child on cancellation to unblock pipe reads.
    pub fn analyze_pcm16(
        &mut self,
        mut reader: impl Read,
        cancel: &AtomicBool,
        mut progress: impl FnMut(u64),
    ) -> Result<VadAnalysis> {
        self.reset();
        let mut detector = PauseDetector::new(16_000)?;
        let mut conservative = PauseDetector::new(16_000)?;
        let mut total_samples = 0;
        let mut next_progress = 16_000_u64;
        loop {
            let Some((frame, valid)) = read_pcm_frame(&mut reader, cancel)? else {
                break;
            };
            let probability = self.infer_frame(&frame)?;
            detector.push(probability, valid)?;
            // Use the same inference, but end the review-only pause at any
            // uncertain frame. Chunk planning keeps its original hysteresis.
            conservative.push(conservative_probability(probability), valid)?;
            total_samples += valid as u64;
            if total_samples >= next_progress {
                progress(total_samples);
                next_progress = total_samples + 16_000;
            }
        }
        if total_samples == 0 {
            return Err(vad_error("audio stream is empty"));
        }
        progress(total_samples);
        Ok(VadAnalysis {
            sample_rate: 16_000,
            total_samples,
            pauses: detector.finish(),
            low_probability_pauses: conservative.finish(),
            model_sha256: self.model_sha256.clone(),
        })
    }
}

fn conservative_probability(probability: f32) -> f32 {
    if (0.35..0.5).contains(&probability) {
        0.5
    } else {
        probability
    }
}

#[cfg(windows)]
fn preload_windows_runtime(path: &std::path::Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::{
        LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: verified canonical absolute path is null terminated and stays alive.
    // Restrict dependencies to this DLL's directory and Windows System32; exclude
    // process CWD/PATH. Keep one reference for process lifetime, so ort/libloading
    // subsequently opens the already loaded exact module and installed System32 runtime.
    let module = unsafe {
        LoadLibraryExW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    };
    if module.is_null() {
        return Err(vad_error(format!(
            "verified ONNX DLL/dependency load failed: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(())
}

fn vad_error(error: impl std::fmt::Display) -> AiError {
    AiError::Invalid(format!("Local speech detection failed: {error}"))
}

fn read_pcm_frame(
    reader: &mut impl Read,
    cancel: &AtomicBool,
) -> Result<Option<([f32; 512], usize)>> {
    let mut bytes = [0_u8; 1024];
    let mut filled = 0;
    while filled < bytes.len() {
        if cancel.load(Ordering::Relaxed) {
            return Err(AiError::Invalid("Audio preparation cancelled".into()));
        }
        match reader.read(&mut bytes[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        }
    }
    if filled == 0 {
        return Ok(None);
    }
    if filled % 2 != 0 {
        return Err(vad_error("truncated PCM sample"));
    }
    let mut frame = [0_f32; 512];
    for (i, s) in bytes[..filled].as_chunks::<2>().0.iter().enumerate() {
        frame[i] = i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0;
    }
    Ok(Some((frame, filled / 2)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn review_pause_ends_at_uncertain_frames_without_changing_chunk_hysteresis() {
        for uncertain in [0.35, 0.4, 0.4999, 0.5] {
            let mut planning = PauseDetector::new(16_000).unwrap();
            let mut review = PauseDetector::new(16_000).unwrap();
            for posterior in std::iter::repeat_n(0.1, 64)
                .chain([uncertain])
                .chain(std::iter::repeat_n(0.1, 64))
            {
                planning.push(posterior, 512).unwrap();
                review
                    .push(conservative_probability(posterior), 512)
                    .unwrap();
            }
            assert_eq!(
                review.finish(),
                vec![
                    Pause {
                        start_sample: 0,
                        end_sample: 32_768
                    },
                    Pause {
                        start_sample: 33_280,
                        end_sample: 66_048
                    },
                ]
            );
            let planned = planning.finish();
            assert_eq!(planned.len(), if uncertain < 0.5 { 1 } else { 2 });
            assert_eq!(planned.first().unwrap().start_sample, 0);
            assert_eq!(planned.last().unwrap().end_sample, 66_048);
        }
        let mut invalid = PauseDetector::new(16_000).unwrap();
        assert!(invalid
            .push(conservative_probability(f32::NAN), 512)
            .is_err());
    }
    #[test]
    fn partial_reads_and_padding_keep_sample_count() {
        struct OneByte(std::io::Cursor<Vec<u8>>);
        impl Read for OneByte {
            fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
                self.0.read(&mut b[..1])
            }
        }
        let mut reader = OneByte(std::io::Cursor::new(vec![0, 128, 255, 127, 0, 0]));
        let (frame, n) = read_pcm_frame(&mut reader, &AtomicBool::new(false))
            .unwrap()
            .unwrap();
        assert_eq!(n, 3);
        assert_eq!(frame[0], -1.0);
        assert!(frame[1] > 0.999);
        assert!(frame[3..].iter().all(|v| *v == 0.0));
    }
    #[test]
    fn truncated_pcm_is_rejected() {
        assert!(read_pcm_frame(&mut &b"x"[..], &AtomicBool::new(false)).is_err());
    }
    #[test]
    fn cancellation_precedes_read() {
        assert!(read_pcm_frame(&mut &b"xx"[..], &AtomicBool::new(true)).is_err());
    }
}
