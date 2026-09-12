//! Read-only Google metadata lookup. No generation probes or application model catalog.
use crate::{AiError, CredentialVault, PriceSnapshot, Result};
use gcp_auth::TokenProvider;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
    pub id: String,
    pub display_name: String,
    pub launch_stage: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceCandidate {
    pub sku: String,
    pub description: String,
    pub direction: String,
    pub microusd_per_million: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingLookup {
    pub price: Option<PriceSnapshot>,
    pub candidates: Vec<PriceCandidate>,
    pub observed_at_ms: i64,
    pub complete: bool,
}

pub struct VertexDiscovery {
    vault: CredentialVault,
    client: reqwest::Client,
}

impl VertexDiscovery {
    pub fn new(vault: CredentialVault) -> Result<Self> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| AiError::Invalid("Unable to initialize Google metadata client".into()))?;
        Ok(Self { vault, client })
    }

    async fn token(&self, credential_id: &str) -> Result<Zeroizing<String>> {
        let (key, _) = self.vault.load_json(credential_id)?;
        let auth =
            gcp_auth::CustomServiceAccount::from_json(&key).map_err(|_| AiError::Credentials)?;
        drop(key);
        let token = auth
            .token(&["https://www.googleapis.com/auth/cloud-platform"])
            .await
            .map_err(|_| AiError::Credentials)?;
        Ok(Zeroizing::new(token.as_str().to_owned()))
    }

    async fn get(&self, url: &str, token: &str, query: &[(&str, &str)]) -> Result<Value> {
        let mut target = reqwest::Url::parse(url)
            .map_err(|_| AiError::Invalid("Invalid Google metadata endpoint".into()))?;
        target.query_pairs_mut().extend_pairs(query.iter().copied());
        let mut response = self
            .client
            .get(target)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| AiError::Invalid("Google metadata lookup failed".into()))?;
        if !response.status().is_success() {
            return Err(AiError::Invalid(format!("Google metadata request returned HTTP {}. Check API enablement and service-account permissions.", response.status().as_u16())));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AiError::Invalid("Google metadata response was interrupted".into()))?
        {
            if chunk.len() > 8 * 1024 * 1024 - bytes.len() {
                return Err(AiError::Invalid(
                    "Google metadata response exceeded its size limit".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| AiError::Invalid("Invalid Google metadata response".into()))
    }

    pub async fn list_models(
        &self,
        credential_id: &str,
        location: &str,
    ) -> Result<Vec<DiscoveredModel>> {
        let host = endpoint(location)?;
        let token = self.token(credential_id).await?;
        let url = format!("https://{host}/v1beta1/publishers/google/models");
        let mut page = String::new();
        let mut models = std::collections::BTreeMap::new();
        for _ in 0..50 {
            let value = self
                .get(
                    &url,
                    &token,
                    &[
                        ("pageSize", "100"),
                        ("pageToken", &page),
                        ("listAllVersions", "true"),
                    ],
                )
                .await?;
            let items = value["publisherModels"]
                .as_array()
                .ok_or_else(|| AiError::Invalid("Google did not return a model list".into()))?;
            for item in items {
                if let Some(model) = parse_model(item) {
                    models.insert(model.id.clone(), model);
                }
            }
            let next = value["nextPageToken"].as_str().unwrap_or("");
            if next.is_empty() {
                return Ok(models.into_values().collect());
            }
            if next == page {
                break;
            }
            page = next.to_owned();
        }
        Err(AiError::Invalid(
            "Google model list exceeded its page limit; enter a model ID directly".into(),
        ))
    }

    /// Public list prices only. Ambiguous SKU units or incomplete pagination never
    /// become an automatic price. A maximum across input modalities/tiers is used.
    pub async fn pricing(
        &self,
        credential_id: &str,
        model_id: &str,
        location: &str,
    ) -> Result<PricingLookup> {
        endpoint(location)?;
        if !valid_model_id(model_id) {
            return Err(AiError::Invalid("Enter a Google Gemini model ID".into()));
        }
        let token = self.token(credential_id).await?;
        let mut services = Vec::new();
        let mut page = String::new();
        let mut complete = false;
        for _ in 0..20 {
            let value = self
                .get(
                    "https://cloudbilling.googleapis.com/v1/services",
                    &token,
                    &[("pageSize", "200"), ("pageToken", &page)],
                )
                .await?;
            if let Some(items) = value["services"].as_array() {
                for item in items {
                    let display = item["displayName"]
                        .as_str()
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    let name = item["name"].as_str().unwrap_or("");
                    if (display.contains("vertex") || display.contains("gemini"))
                        && valid_service(name)
                    {
                        services.push(name.to_owned());
                    }
                }
            }
            let next = value["nextPageToken"].as_str().unwrap_or("");
            if next.is_empty() {
                complete = true;
                break;
            }
            if next == page {
                break;
            }
            page = next.to_owned();
        }
        let observed_at_ms = crate::now_ms();
        let mut candidates = Vec::new();
        let mut ambiguous = false;
        for service in services.iter().take(10) {
            page.clear();
            let mut service_complete = false;
            for _ in 0..50 {
                let value = self
                    .get(
                        &format!("https://cloudbilling.googleapis.com/v1/{service}/skus"),
                        &token,
                        &[
                            ("pageSize", "1000"),
                            ("pageToken", &page),
                            ("currencyCode", "USD"),
                        ],
                    )
                    .await?;
                if let Some(items) = value["skus"].as_array() {
                    for item in items {
                        if !matches_model(item["description"].as_str().unwrap_or(""), model_id) {
                            continue;
                        }
                        match parse_price(item, location, observed_at_ms) {
                            Some(candidate) => candidates.push(candidate),
                            None => ambiguous = true,
                        }
                    }
                }
                if candidates.len() > 200 {
                    break;
                }
                let next = value["nextPageToken"].as_str().unwrap_or("");
                if next.is_empty() {
                    service_complete = true;
                    break;
                }
                if next == page {
                    break;
                }
                page = next.to_owned();
            }
            complete &= service_complete;
        }
        complete &= services.len() <= 10 && !services.is_empty() && !ambiguous;
        let input = candidates
            .iter()
            .filter(|c| c.direction == "input")
            .map(|c| c.microusd_per_million)
            .max();
        let output = candidates
            .iter()
            .filter(|c| c.direction == "output")
            .map(|c| c.microusd_per_million)
            .max();
        let price = match (complete, input, output) {
            (true, Some(input), Some(output)) => Some(PriceSnapshot {
                id: format!("google-billing-{model_id}-{observed_at_ms}"),
                source: "google_billing_public_maximum".into(),
                observed_at_ms,
                input_microusd_per_million: input,
                output_microusd_per_million: output,
            }),
            _ => None,
        };
        Ok(PricingLookup {
            price,
            candidates,
            observed_at_ms,
            complete,
        })
    }
}

fn endpoint(location: &str) -> Result<String> {
    if location.is_empty()
        || location.len() > 63
        || !location
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(AiError::Invalid("Invalid Vertex location".into()));
    }
    Ok(if location == "global" {
        "aiplatform.googleapis.com".into()
    } else {
        format!("{location}-aiplatform.googleapis.com")
    })
}

fn valid_model_id(id: &str) -> bool {
    id.starts_with("gemini-")
        && id.len() <= 200
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'@'))
}

fn valid_service(name: &str) -> bool {
    name.strip_prefix("services/").is_some_and(|id| {
        !id.is_empty()
            && id.len() < 80
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

fn parse_model(value: &Value) -> Option<DiscoveredModel> {
    let id = value["name"]
        .as_str()?
        .strip_prefix("publishers/google/models/")?;
    if !valid_model_id(id) {
        return None;
    }
    Some(DiscoveredModel {
        id: id.into(),
        display_name: value["displayName"].as_str().unwrap_or(id).into(),
        launch_stage: value["launchStage"].as_str().map(str::to_owned),
        version: value["versionId"].as_str().map(str::to_owned),
    })
}

fn words(value: &str) -> Vec<String> {
    value
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

fn matches_model(description: &str, model_id: &str) -> bool {
    let description = words(description);
    let model = words(model_id);
    if model.is_empty()
        || description.iter().any(|w| {
            [
                "batch",
                "flex",
                "cached",
                "cache",
                "tuning",
                "training",
                "grounding",
                "priority",
            ]
            .contains(&w.as_str())
        })
    {
        return false;
    }
    description
        .windows(model.len())
        .enumerate()
        .any(|(i, window)| {
            window == model
                && description.get(i + model.len()).is_none_or(|word| {
                    !["lite", "image", "live", "preview", "experimental", "exp"]
                        .contains(&word.as_str())
                })
        })
}

fn parse_price(value: &Value, location: &str, now_ms: i64) -> Option<PriceCandidate> {
    let description = value["description"].as_str()?;
    let terms = words(description);
    if !terms.iter().any(|w| w == "token" || w == "tokens") {
        return None;
    }
    let input = terms.iter().any(|w| w == "input");
    let output = terms.iter().any(|w| w == "output");
    if input == output {
        return None;
    }
    let global = value["geoTaxonomy"]["type"] == "GLOBAL";
    if !global
        && !value["serviceRegions"]
            .as_array()?
            .iter()
            .any(|v| v.as_str() == Some(location))
    {
        return None;
    }
    let info = value["pricingInfo"]
        .as_array()?
        .iter()
        .filter_map(|item| {
            let time = chrono::DateTime::parse_from_rfc3339(item["effectiveTime"].as_str()?)
                .ok()?
                .timestamp_millis();
            (time <= now_ms).then_some((time, item))
        })
        .max_by_key(|(time, _)| *time)?
        .1;
    let expression = &info["pricingExpression"];
    if expression["baseUnit"].as_str()? != "count" {
        return None;
    }
    let scale = expression["baseUnitConversionFactor"].as_f64()?;
    if !scale.is_finite() || !(1.0..=1_000_000_000.0).contains(&scale) || scale.fract() != 0.0 {
        return None;
    }
    let rates = expression["tieredRates"].as_array()?;
    let mut maximum = None;
    for tier in rates {
        let money = &tier["unitPrice"];
        if money["currencyCode"] != "USD" {
            return None;
        }
        let units: u128 = money["units"].as_str()?.parse().ok()?;
        let nanos = match money.get("nanos") {
            Some(v) => v.as_u64()? as u128,
            None => 0,
        };
        if nanos >= 1_000_000_000 {
            return None;
        }
        let nano_usd = units.checked_mul(1_000_000_000)?.checked_add(nanos)?;
        let micro_per_million: u64 = nano_usd
            .checked_mul(1000)?
            .div_ceil(scale as u128)
            .try_into()
            .ok()?;
        maximum = Some(maximum.unwrap_or(0).max(micro_per_million));
    }
    Some(PriceCandidate {
        sku: value["name"].as_str()?.into(),
        description: description.into(),
        direction: if input { "input" } else { "output" }.into(),
        microusd_per_million: maximum?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn metadata_cannot_supply_an_endpoint_or_non_google_model() {
        assert!(endpoint("global").unwrap().starts_with("aiplatform"));
        assert!(endpoint("us-central1").unwrap().starts_with("us-central1-"));
        assert!(endpoint("a/b?token=x").is_err());
        assert!(parse_model(&json!({"name":"publishers/google/models/gemini-99-flash"})).is_some());
        assert!(parse_model(&json!({"name":"publishers/other/models/gemini-99-flash"})).is_none());
        assert!(!valid_model_id("gemini-99/../../anything"));
    }

    #[test]
    fn sku_matching_does_not_substitute_other_models_or_discount_modes() {
        assert!(matches_model(
            "Gemini 3.8 Flash short input text tokens",
            "gemini-3.8-flash"
        ));
        assert!(!matches_model(
            "Gemini 3.8 Flash Lite input tokens",
            "gemini-3.8-flash"
        ));
        assert!(!matches_model(
            "Gemini 3.8 Flash preview input tokens",
            "gemini-3.8-flash"
        ));
        assert!(!matches_model(
            "Gemini 3.8 Flash batch input tokens",
            "gemini-3.8-flash"
        ));
        assert!(!matches_model(
            "Gemini 3.8 Flash input tokens",
            "gemini-3.8-flash-preview"
        ));
    }

    #[test]
    fn price_uses_current_tiers_units_and_region_without_guessing() {
        let mut sku = json!({"name":"services/test/skus/test","description":"Gemini 3.8 Flash input tokens",
            "geoTaxonomy":{"type":"GLOBAL"},"pricingInfo":[{"effectiveTime":"2026-01-01T00:00:00Z",
            "pricingExpression":{"baseUnit":"count","baseUnitConversionFactor":1000,
            "tieredRates":[{"unitPrice":{"currencyCode":"USD","units":"0","nanos":1500000}},
            {"unitPrice":{"currencyCode":"USD","units":"0","nanos":2500000}}]}}]});
        let now = 1_788_825_600_000;
        assert_eq!(
            parse_price(&sku, "global", now)
                .unwrap()
                .microusd_per_million,
            2_500_000
        );
        sku["pricingInfo"][0]["pricingExpression"]["baseUnit"] = json!("s");
        assert!(parse_price(&sku, "global", now).is_none());
        sku["pricingInfo"][0]["pricingExpression"]["baseUnit"] = json!("count");
        sku["geoTaxonomy"]["type"] = json!("REGIONAL");
        sku["serviceRegions"] = json!(["us-central1"]);
        assert!(parse_price(&sku, "global", now).is_none());
        assert!(parse_price(&sku, "us-central1", now).is_some());
    }
}
