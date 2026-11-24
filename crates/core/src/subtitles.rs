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

/// Strip known SRT/WebVTT/ASS inline markup while keeping bare `&` and non-tag `<` intact.
pub fn clean_cue_text(raw: &str) -> String {
    let without_ass = strip_ass_overrides(raw);
    let without_ruby_notes = strip_ruby_annotations(&without_ass);
    let without_tags = strip_known_tags(&without_ruby_notes);
    let decoded = decode_entities(&without_tags);
    decoded
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_ass_overrides(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find("{\\") {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 2..];
        if let Some(close) = after.find('}') {
            rest = &after[close + 1..];
        } else {
            out.push_str("{\\");
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

fn find_closing_tag(haystack: &str, name: &str) -> Option<usize> {
    let mut offset = 0;
    while let Some(pos) = haystack[offset..].find("</") {
        let start = offset + pos;
        let after = &haystack[start + 2..];
        if after.len() > name.len() && after[..name.len()].eq_ignore_ascii_case(name) {
            let tail = &after[name.len()..];
            let trimmed = tail.trim_start_matches(|c: char| c.is_ascii_whitespace());
            if trimmed.starts_with('>') {
                let consumed = after.len() - trimmed.len() + 1;
                return Some(start + 2 + consumed);
            }
        }
        offset = start + 2;
    }
    None
}

fn strip_ruby_annotations(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find('<') {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 1..];
        let matched = ["rt", "rp"].into_iter().find(|name| {
            after.len() > name.len()
                && after[..name.len()].eq_ignore_ascii_case(name)
                && after[name.len()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c == '>' || c.is_ascii_whitespace())
        });
        if let Some(name) = matched
            && let Some(open_end) = after.find('>')
            && !after[..open_end].contains('<')
            && let Some(close_end) = find_closing_tag(&after[open_end + 1..], name)
        {
            rest = &after[open_end + 1 + close_end..];
            continue;
        }
        out.push('<');
        rest = after;
    }
    out.push_str(rest);
    out
}

fn is_known_inline_tag(inner: &str) -> bool {
    if inner.contains('<') || inner.contains('\n') {
        return false;
    }
    let inner = inner.trim_end_matches(|c: char| c.is_ascii_whitespace());
    if inner.is_empty() {
        return false;
    }
    if let Some(closing) = inner.strip_prefix('/') {
        let name = closing.trim_end_matches(|c: char| c.is_ascii_whitespace());
        return [
            "i", "b", "u", "s", "font", "c", "v", "lang", "ruby", "rb", "rt", "rp",
        ]
        .iter()
        .any(|known| name.eq_ignore_ascii_case(known));
    }
    if inner.contains('.') && !inner.contains(',') && timestamp(inner).is_ok() {
        return true;
    }
    let name_len = inner
        .find(|c: char| c == '.' || c.is_ascii_whitespace())
        .unwrap_or(inner.len());
    let name = &inner[..name_len];
    ["i", "b", "u", "s", "font", "c", "v", "lang", "ruby", "rb"]
        .iter()
        .any(|known| name.eq_ignore_ascii_case(known))
}

fn strip_known_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find('<') {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 1..];
        if let Some(close) = after.find('>') {
            let candidate = &after[..close];
            if !candidate.contains('<') && is_known_inline_tag(candidate) {
                rest = &after[close + 1..];
                continue;
            }
        }
        out.push('<');
        rest = after;
    }
    out.push_str(rest);
    out
}

fn decode_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let after = &rest[pos..];
        let matched = [
            ("&amp;", "&"),
            ("&lt;", "<"),
            ("&gt;", ">"),
            ("&nbsp;", " "),
            ("&quot;", "\""),
            ("&#39;", "'"),
            ("&apos;", "'"),
            ("&lrm;", ""),
            ("&rlm;", ""),
        ]
        .into_iter()
        .find(|(entity, _)| {
            after.len() >= entity.len() && after[..entity.len()].eq_ignore_ascii_case(entity)
        });
        if let Some((entity, replacement)) = matched {
            out.push_str(replacement);
            rest = &after[entity.len()..];
        } else {
            out.push('&');
            rest = &after[1..];
        }
    }
    out.push_str(rest);
    out
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
        let text = clean_cue_text(&lines[index + 1..].join("\n"));
        if text.trim().is_empty() {
            continue;
        }
        segments.push(SubtitleSegment {
            timing_precision: "cue".into(),
            id: uuid::Uuid::new_v4().to_string(),
            media_id: media_id.to_owned(),
            start_ms,
            end_ms,
            text,
            translation: None,
            status: "confirmed".into(),
            review_issues: vec![],
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
    for (index, segment) in segments
        .iter()
        .filter(|segment| segment.timing_precision == "cue")
        .enumerate()
    {
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

    #[test]
    fn inline_markup_ruby_ass_and_entities_are_cleaned_without_breaking_plain_symbols() {
        let srt = "1\n00:00:01,000 --> 00:00:03,000\n{\\an8}<i><font color=\"#fff\">Hello</font></i> &amp; <b>world</b>\n";
        assert_eq!(parse(srt, "m").unwrap()[0].text, "Hello & world");

        let vtt = "WEBVTT\n\n00:01.000 --> 00:04.500\n<v.loud Alice><c.yellow>Take</c> <00:01.500>care &lt;3 &amp;lt;tag&gt;</v>\n";
        assert_eq!(parse(vtt, "m").unwrap()[0].text, "Take care <3 &lt;tag>");

        let ruby = "1\n00:00:01,000 --> 00:00:03,000\n<ruby>約束<rp>(</rp><rt>やくそく</rt><rp>)</rp></ruby>を守る\n";
        assert_eq!(parse(ruby, "m").unwrap()[0].text, "約束を守る");

        let math = "1\n00:00:01,000 --> 00:00:03,000\nx < 5 & y > 2 &lrm;done\n";
        assert_eq!(parse(math, "m").unwrap()[0].text, "x < 5 & y > 2 done");

        let empty_after_strip = "1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>   </i>\n";
        assert!(parse(empty_after_strip, "m").unwrap().is_empty());
    }
}
