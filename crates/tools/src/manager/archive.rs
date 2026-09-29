use super::*;

pub(super) fn safe_relative(path: &Path) -> Result<()> {
    ensure!(
        !path.as_os_str().is_empty()
            && path.components().all(|c| matches!(c, Component::Normal(_))),
        "unsafe package-relative path"
    );
    ensure!(
        !path.to_string_lossy().contains([':', '\0']),
        "unsafe package path"
    );
    Ok(())
}
pub(super) fn unpack(
    archive: &Path,
    output: &Path,
    kind: ToolKind,
) -> Result<(PathBuf, Option<PathBuf>)> {
    if kind == ToolKind::YtDlp {
        let relative = PathBuf::from(kind.executable());
        fs::copy(archive, output.join(&relative))?;
        return Ok((relative, None));
    }
    let mut zip = zip::ZipArchive::new(File::open(archive)?).context("invalid tool ZIP package")?;
    ensure!(zip.len() <= 5000, "too many package entries");
    let mut total = 0u64;
    let mut executable = None;
    let mut companion = None;
    let mut seen = HashSet::new();
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index)?;
        ensure!(
            !entry.name().contains(['\\', ':']),
            "unsafe ZIP member path"
        );
        let relative = entry.enclosed_name().context("ZIP entry escapes package")?;
        safe_relative(&relative)?;
        ensure!(
            entry
                .unix_mode()
                .is_none_or(|mode| mode & 0o170000 != 0o120000),
            "ZIP symbolic links are unsupported"
        );
        let key = relative.to_string_lossy().to_lowercase();
        ensure!(seen.insert(key), "duplicate ZIP member");
        total = total
            .checked_add(entry.size())
            .context("ZIP size overflow")?;
        ensure!(
            total <= 1024 * 1024 * 1024,
            "uncompressed package exceeds 1 GiB"
        );
        let destination = output.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(destination)?;
            continue;
        }
        fs::create_dir_all(destination.parent().context("ZIP member has no parent")?)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)?;
        let copied = std::io::copy(&mut entry.by_ref().take(512 * 1024 * 1024 + 1), &mut file)?;
        ensure!(
            copied <= 512 * 1024 * 1024 && copied == entry.size(),
            "invalid ZIP member size"
        );
        file.sync_all()?;
        let name = relative.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.eq_ignore_ascii_case(kind.executable()) {
            ensure!(executable.is_none(), "multiple tool executables in package");
            executable = Some(relative.clone());
        }
        if kind == ToolKind::FfmpegPair
            && name.eq_ignore_ascii_case(if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            })
        {
            ensure!(companion.is_none(), "multiple ffprobe executables");
            companion = Some(relative);
        }
    }
    let executable = executable.context("package lacks the expected executable")?;
    if kind == ToolKind::FfmpegPair {
        ensure!(
            companion
                .as_ref()
                .is_some_and(|p| p.parent() == executable.parent()),
            "FFmpeg package lacks matching ffprobe"
        );
    }
    Ok((executable, companion))
}
