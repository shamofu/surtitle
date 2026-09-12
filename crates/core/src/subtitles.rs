//! Text-only subtitle parsing. No media tools or network access is needed.
use crate::SubtitleSegment;
use anyhow::{Context, Result, bail, ensure};

fn timestamp(value: &str) -> Result<u64> {
    let normalized = value.replace(',', ".");
    let fields: Vec<_> = normalized.split(':').collect();
    ensure!(
        (2..=3).contains(&fields.len()),
        "invalid subtitle timestamp"
    );
    let (h, m, sec) = if fields.len() == 3 {
        (
            fields[0].parse::<u64>()?,
            fields[1].parse::<u64>()?,
            fields[2],
        )
    } else {
        (0, fields[0].parse::<u64>()?, fields[1])
    };
    let (s, ms) = sec
        .split_once('.')
        .context("timestamp requires milliseconds")?;
    ensure!(
        ms.len() == 3 && ms.chars().all(|c| c.is_ascii_digit()),
        "invalid milliseconds"
    );
    let s: u64 = s.parse()?;
    ensure!(m < 60 && s < 60 && h < 100_000, "timestamp out of range");
    Ok(((h * 60 + m) * 60 + s) * 1000 + ms.parse::<u64>()?)
}

pub fn parse(input: &str, media_id: &str) -> Result<Vec<SubtitleSegment>> {
    ensure!(
        input.len() <= 64 * 1024 * 1024,
        "subtitle file is too large"
    );
    let normalized = input
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut segments = Vec::new();
    let lines: Vec<_> = normalized.lines().collect();
    for lines in lines.split(|line| line.trim().is_empty()) {
        if lines.is_empty()
            || lines[0].starts_with("NOTE")
            || lines[0] == "STYLE"
            || lines[0] == "REGION"
        {
            continue;
        }
        let Some(index) = lines.iter().position(|line| line.contains("-->")) else {
            if lines.is_empty() || lines[0].starts_with("WEBVTT") {
                continue;
            }
            bail!("subtitle block has no time range");
        };
        let (start, end) = lines[index]
            .split_once("-->")
            .context("invalid time range")?;
        let start_ms = timestamp(start.trim())?;
        let end_ms = timestamp(end.split_whitespace().next().context("missing end time")?)?;
        ensure!(end_ms > start_ms, "subtitle must have positive duration");
        let text = lines[index + 1..].join("\n");
        if text.trim().is_empty() {
            continue;
        }
        segments.push(SubtitleSegment {
            id: uuid::Uuid::new_v4().to_string(),
            media_id: media_id.to_owned(),
            start_ms,
            end_ms,
            text,
            translation: None,
            status: "confirmed".into(),
        });
    }
    segments.sort_by_key(|s| s.start_ms);
    Ok(segments)
}

fn format_time(ms: u64, vtt: bool) -> String {
    format!(
        "{:02}:{:02}:{:02}{}{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        if vtt { '.' } else { ',' },
        ms % 1000
    )
}

pub fn format(segments: &[SubtitleSegment], vtt: bool, translated: bool) -> String {
    let mut out = if vtt {
        "WEBVTT\n\n".into()
    } else {
        String::new()
    };
    for (index, segment) in segments.iter().enumerate() {
        if !vtt {
            out.push_str(&format!("{}\n", index + 1));
        }
        out.push_str(&format!(
            "{} --> {}\n{}\n\n",
            format_time(segment.start_ms, vtt),
            format_time(segment.end_ms, vtt),
            if translated {
                segment.translation.as_deref().unwrap_or("")
            } else {
                &segment.text
            }
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multilingual_overlap_roundtrip() {
        let input = "\u{feff}1\r\n00:00:01,000 --> 00:00:02,050\r\n日本語 & hello\r\nsecond line\r\n\r\n2\r\n00:00:01,500 --> 06:00:00,000\r\nrepeat repeat\r\n";
        let parsed = parse(input, "a").unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].end_ms, 21_600_000);
        let again = parse(&format(&parsed, true, false), "a").unwrap();
        assert_eq!(again[0].text, parsed[0].text);
        assert_eq!(again[1].start_ms, 1500);
    }
    #[test]
    fn vtt_headers_settings_and_invalid_timestamps() {
        let input =
            "WEBVTT\n\nNOTE comment\nignored\n\ncue\n01:00.000 --> 01:03.000 align:start\nHello\n";
        assert_eq!(parse(input, "a").unwrap()[0].start_ms, 60_000);
        assert!(parse("1\n00:60:00,000 --> 01:00:01,000\nx", "a").is_err());
        assert!(parse("1\n00:00:02,000 --> 00:00:01,000\nx", "a").is_err());
    }

    #[test]
    fn whitespace_only_separator_is_a_cue_boundary() {
        let input = "1\n00:00:01,000 --> 00:00:02,000\nFirst\n \t\n2\n00:00:02,000 --> 00:00:03,000\nSecond";
        let parsed = parse(input, "m").unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].text, "First");
    }
    #[test]
    fn twenty_thousand_subtitles() {
        let input: String = (0..20_000)
            .map(|i| {
                format!(
                    "{}\n{} --> {}\nline {}\n\n",
                    i + 1,
                    format_time(i * 1000, false),
                    format_time(i * 1000 + 900, false),
                    i
                )
            })
            .collect();
        assert_eq!(parse(&input, "six-hour").unwrap().len(), 20_000);
    }
}
