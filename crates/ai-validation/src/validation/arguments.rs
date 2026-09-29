//! Strict named argument parsing and explicit model/budget settings.
use super::files::{absolute, read_document};
use super::{MAX_AUDIO_SECONDS, Result, ai_error};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use surtitle_ai::{ExecutionConfig, PriceSnapshot, ThinkingConfig};

pub(super) struct Arguments {
    values: BTreeMap<String, OsString>,
}
impl Arguments {
    pub(super) fn parse(items: Vec<OsString>) -> Result<Self> {
        let mut values = BTreeMap::new();
        let mut iter = items.into_iter();
        while let Some(option) = iter.next() {
            let option = option.into_string().map_err(|_| "Invalid option name")?;
            if !option.starts_with("--") || option == "--" {
                return Err("Use named --options only".into());
            }
            let value = if ["--retry", "--approve-unpriced", "--acknowledge-unqualified"]
                .contains(&option.as_str())
            {
                OsString::from("true")
            } else {
                iter.next().ok_or("Option value missing")?
            };
            if value.is_empty() || values.insert(option, value).is_some() {
                return Err("Empty or duplicate option".into());
            }
        }
        Ok(Self { values })
    }
    pub(super) fn take(&mut self, name: &str) -> Option<OsString> {
        self.values.remove(name)
    }
    pub(super) fn required(&mut self, name: &str) -> Result<OsString> {
        self.take(name)
            .ok_or_else(|| format!("Required option: {name}"))
    }
    pub(super) fn string(&mut self, name: &str) -> Result<String> {
        self.required(name)?
            .into_string()
            .map_err(|_| "Option must be UTF-8 text".into())
    }
    pub(super) fn path(&mut self, name: &str) -> Result<PathBuf> {
        let path = PathBuf::from(self.required(name)?);
        absolute(&path)?;
        Ok(path)
    }
    pub(super) fn money(&mut self, name: &str) -> Result<u64> {
        usd(&self.string(name)?)
    }
    pub(super) fn finish(self) -> Result<()> {
        if self.values.is_empty() {
            Ok(())
        } else {
            Err("Unrecognized or incompatible option".into())
        }
    }
}

pub(super) fn parse_execution(args: &mut Arguments) -> Result<ExecutionConfig> {
    let model_id = args.string("--model-id")?;
    let location = args.string("--location")?;
    let max_output_tokens = args
        .string("--max-output-tokens")?
        .parse()
        .map_err(|_| "Invalid output token limit")?;
    let level = args.take("--thinking-level");
    let budget = args.take("--thinking-budget");
    let thinking = match (level, budget) {
        (None, None) => ThinkingConfig::Omit,
        (Some(level), None) => ThinkingConfig::Level {
            level: level.into_string().map_err(|_| "Invalid thinking level")?,
        },
        (None, Some(budget)) => ThinkingConfig::Budget {
            tokens: budget
                .into_string()
                .map_err(|_| "Invalid thinking budget")?
                .parse()
                .map_err(|_| "Invalid thinking budget")?,
        },
        _ => return Err("Thinking level and budget are mutually exclusive".into()),
    };
    let price = args
        .take("--price-file")
        .map(|path| {
            let path = PathBuf::from(path);
            absolute(&path)?;
            read_document::<PriceSnapshot>(&path)
        })
        .transpose()?;
    let config = ExecutionConfig {
        model_id,
        location,
        max_output_tokens,
        thinking,
        price,
    };
    config.validate().map_err(ai_error)?;
    Ok(config)
}

pub(super) fn parse_audio_seconds(value: &str) -> Result<u32> {
    let seconds = value
        .parse::<u32>()
        .map_err(|_| "Audio limit must be an integer from 1 to 240 seconds")?;
    if seconds == 0 || seconds > MAX_AUDIO_SECONDS {
        return Err("Audio limit must be from 1 to 240 seconds".into());
    }
    Ok(seconds)
}

pub(super) fn format_usd(value: u64) -> String {
    format!("{}.{:06}", value / 1_000_000, value % 1_000_000)
}

pub(super) fn usd(value: &str) -> Result<u64> {
    let (whole, fractional) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || fractional.len() > 6
        || !fractional.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("USD must be a positive decimal with at most six fractional digits".into());
    }
    let whole = whole
        .parse::<u64>()
        .map_err(|_| "USD amount is too large")?;
    let fraction = if fractional.is_empty() {
        0
    } else {
        fractional
            .parse::<u64>()
            .map_err(|_| "Invalid USD fraction")?
            * 10u64.pow(6 - fractional.len() as u32)
    };
    let amount = whole
        .checked_mul(1_000_000)
        .and_then(|n| n.checked_add(fraction))
        .ok_or("USD amount is too large")?;
    if amount == 0 || amount > 1_000_000_000_000 {
        return Err("USD amount is outside the supported positive range".into());
    }
    Ok(amount)
}
