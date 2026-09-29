//! Bounded diagnostics, cancellation, and cleanup for streaming FFmpeg.
use super::{check_cancel, local_error};
use crate::Result;
use std::{
    ffi::OsString,
    io::Read,
    process::{Child, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use surtitle_tools::ToolSnapshot;

pub(super) struct LocalChild {
    child: Arc<Mutex<Child>>,
    stop: Arc<AtomicBool>,
    timed_out: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    watcher: Option<JoinHandle<()>>,
    stderr: Option<JoinHandle<Vec<u8>>>,
}
impl LocalChild {
    pub(super) fn start(
        snapshot: &ToolSnapshot,
        args: &[OsString],
        pipe: bool,
        cancel: Arc<AtomicBool>,
        timeout: Duration,
    ) -> Result<(Self, Option<ChildStdout>)> {
        check_cancel(&cancel)?;
        snapshot.verify().map_err(local_error)?;
        let mut command = Command::new(&snapshot.tool.executable);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(if pipe { Stdio::piped() } else { Stdio::null() })
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn()?;
        let stdout = child.stdout.take();
        let mut error = child
            .stderr
            .take()
            .ok_or_else(|| local_error("stderr pipe missing"))?;
        let stderr = std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                match error.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let take = n.min(32768usize.saturating_sub(out.len()));
                        out.extend_from_slice(&buf[..take]);
                    }
                }
            }
            out
        });
        let child = Arc::new(Mutex::new(child));
        let stop = Arc::new(AtomicBool::new(false));
        let timed_out = Arc::new(AtomicBool::new(false));
        let (watch_child, watch_stop, watch_timeout, watch_cancel) = (
            child.clone(),
            stop.clone(),
            timed_out.clone(),
            cancel.clone(),
        );
        let watcher = std::thread::spawn(move || {
            let began = Instant::now();
            while !watch_stop.load(Ordering::Relaxed) {
                let expired = began.elapsed() > timeout;
                if expired || watch_cancel.load(Ordering::Relaxed) {
                    watch_timeout.store(expired, Ordering::Relaxed);
                    if let Ok(mut c) = watch_child.lock() {
                        let _ = c.kill();
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        Ok((
            Self {
                child,
                stop,
                timed_out,
                cancel,
                watcher: Some(watcher),
                stderr: Some(stderr),
            },
            stdout,
        ))
    }
    pub(super) fn finish(&mut self) -> Result<()> {
        let status = loop {
            if let Some(status) = self
                .child
                .lock()
                .map_err(|_| local_error("child lock"))?
                .try_wait()?
            {
                break status;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        self.stop.store(true, Ordering::Relaxed);
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
        let stderr = self
            .stderr
            .take()
            .and_then(|t| t.join().ok())
            .unwrap_or_default();
        check_cancel(&self.cancel)?;
        if self.timed_out.load(Ordering::Relaxed) {
            return Err(local_error("FFmpeg timed out"));
        }
        if !status.success() {
            return Err(local_error(format!(
                "FFmpeg failed: {}",
                String::from_utf8_lossy(&stderr)
            )));
        }
        Ok(())
    }
}
impl Drop for LocalChild {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.join();
        }
    }
}
