//! Cloud decision-model providers, their models and prices.
//!
//! A model id that starts with `@` is a cloud model, `@{provider_id}/{model}` (Ollaya names never
//! start with `@`); anything else is a local Ollaya model. Cloud ids are stored in
//! `ExperimentConfig::models` like any other model name.
//!
//! The built-in providers (`typesafe`, `openai`, `cloudflare`) and their models are seeded into the
//! store on open; users add `custom` providers for any TypeSafe-compatible endpoint. API keys live
//! in the OS keychain ([`crate::secrets`]); the store only remembers whether a key is set.

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    /// TypeSafe System One (`POST /v1/systemone`).
    Typesafe,
    /// OpenAI Decisions API (`POST /v1/decisions`).
    Openai,
    /// Cloudflare Workers AI (`POST /client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}`).
    Cloudflare,
    /// Any TypeSafe-compatible endpoint (OpenRouter, an AI gateway, a remote Ollaya, ...).
    Custom,
    /// An LLM behind an OpenAI-compatible Chat Completions API (`POST /v1/chat/completions`) —
    /// OpenAI, OpenRouter, Groq, a local Ollama or LM Studio — answering through a JSON schema.
    Chat,
    /// An Anthropic model (`POST /v1/messages`), answering through a forced tool call.
    Anthropic,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Typesafe => "typesafe",
            Self::Openai => "openai",
            Self::Cloudflare => "cloudflare",
            Self::Custom => "custom",
            Self::Chat => "chat",
            Self::Anthropic => "anthropic",
        }
    }

    /// An LLM provider: answers come from structured output (see [`crate::llm`]), probabilities
    /// are the model's own estimates, and free-text questions are answered.
    pub fn is_llm(self) -> bool {
        matches!(self, Self::Chat | Self::Anthropic)
    }

    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "typesafe" => Ok(Self::Typesafe),
            "openai" => Ok(Self::Openai),
            "cloudflare" => Ok(Self::Cloudflare),
            "custom" => Ok(Self::Custom),
            "chat" => Ok(Self::Chat),
            "anthropic" => Ok(Self::Anthropic),
            other => Err(Error::invalid(format!("unknown provider kind \"{other}\""))),
        }
    }

    /// Hosted providers refuse requests without a key; a custom or chat endpoint (e.g. a local
    /// Ollama) may not need one.
    pub fn requires_key(self) -> bool {
        !matches!(self, Self::Custom | Self::Chat)
    }

    /// Base URL used when the provider has no override.
    pub fn default_base_url(self) -> Option<&'static str> {
        match self {
            Self::Typesafe => Some("https://api.typesafe.ai"),
            Self::Openai => Some("https://api.openai.com"),
            Self::Cloudflare => Some("https://api.cloudflare.com"),
            Self::Custom => None,
            Self::Chat => Some("https://api.openai.com"),
            Self::Anthropic => Some("https://api.anthropic.com"),
        }
    }

    /// Most questions one request may carry.
    pub fn max_questions(self) -> usize {
        match self {
            Self::Cloudflare => 64,
            _ => 256,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Provider {
    pub id: String,
    pub kind: ProviderKind,
    pub name: String,
    /// Overrides the kind's default URL; required for `custom`.
    pub base_url: Option<String>,
    /// Cloudflare account id.
    pub account_id: Option<String>,
    pub has_key: bool,
    /// Last four characters of the key, for display.
    pub key_hint: Option<String>,
    pub builtin: bool,
}

impl Provider {
    pub fn base_url(&self) -> Option<&str> {
        self.base_url.as_deref().or(self.kind.default_base_url())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CloudModel {
    pub provider_id: String,
    /// Model name as the provider expects it.
    pub model: String,
    pub display_name: String,
    pub description: Option<String>,
    /// USD per million input tokens.
    pub input_price_per_mtok: f64,
    /// USD per million output tokens.
    pub output_price_per_mtok: f64,
    pub enabled: bool,
    pub builtin: bool,
}

impl CloudModel {
    pub fn id(&self) -> String {
        cloud_model_id(&self.provider_id, &self.model)
    }

    pub fn cost(&self, usage: crate::ollaya::Usage) -> f64 {
        cost_usd(usage, self.input_price_per_mtok, self.output_price_per_mtok)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CloudModelView {
    /// `@{provider_id}/{model}`
    pub id: String,
    /// Price the built-in model shipped with (for "reset to default"); None for custom models.
    pub default_input_price_per_mtok: Option<f64>,
    pub default_output_price_per_mtok: Option<f64>,
    #[serde(flatten)]
    pub model: CloudModel,
}

impl From<CloudModel> for CloudModelView {
    fn from(model: CloudModel) -> Self {
        let seed = builtin_models().into_iter().find(|b| b.provider_id == model.provider_id && b.model == model.model);
        Self {
            id: model.id(),
            default_input_price_per_mtok: seed.as_ref().map(|b| b.input_price_per_mtok),
            default_output_price_per_mtok: seed.as_ref().map(|b| b.output_price_per_mtok),
            model,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderView {
    #[serde(flatten)]
    pub provider: Provider,
    pub models: Vec<CloudModelView>,
}

/// What the settings form sends to create or update a provider.
#[derive(Debug, Clone, Deserialize)]
pub struct ProviderInput {
    /// None creates a new (custom) provider.
    #[serde(default)]
    pub id: Option<String>,
    pub kind: ProviderKind,
    pub name: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    /// None keeps the stored key, `""` removes it, anything else replaces it.
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CloudModelInput {
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub input_price_per_mtok: f64,
    pub output_price_per_mtok: f64,
    pub enabled: bool,
}

/// A parsed model id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelRef<'a> {
    Local(&'a str),
    Cloud { provider: &'a str, model: &'a str },
    /// A model fine-tuned in the app (`ft:<slug>`), served by llama.cpp ([`crate::finetune`]).
    FineTuned(&'a str),
}

pub fn parse_model_id(id: &str) -> Result<ModelRef<'_>> {
    if let Some(slug) = id.strip_prefix(crate::finetune::MODEL_PREFIX) {
        if slug.trim().is_empty() {
            return Err(Error::invalid("fine-tuned model name is empty"));
        }
        return Ok(ModelRef::FineTuned(slug));
    }
    let Some(rest) = id.strip_prefix('@') else {
        if id.trim().is_empty() {
            return Err(Error::invalid("model name is empty"));
        }
        return Ok(ModelRef::Local(id));
    };
    match rest.split_once('/') {
        Some((provider, model)) if !provider.is_empty() && !model.is_empty() => Ok(ModelRef::Cloud { provider, model }),
        _ => Err(Error::invalid(format!("\"{id}\" is not a cloud model id; expected @provider/model"))),
    }
}

pub fn is_cloud_model(id: &str) -> bool {
    id.starts_with('@')
}

pub fn cloud_model_id(provider_id: &str, model: &str) -> String {
    format!("@{provider_id}/{model}")
}

pub fn cost_usd(usage: crate::ollaya::Usage, input_per_mtok: f64, output_per_mtok: f64) -> f64 {
    usage.input_tokens as f64 * input_per_mtok / 1e6 + usage.output_tokens as f64 * output_per_mtok / 1e6
}

/// Lowercase ASCII letters, digits and single dashes: a provider name as an id.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "custom".into()
    } else {
        out
    }
}

/// Trimmed, without a trailing slash; must be http(s). Empty means none.
pub fn normalize_base_url(url: Option<&str>) -> Result<Option<String>> {
    let Some(u) = url.map(str::trim).filter(|u| !u.is_empty()) else { return Ok(None) };
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err(Error::invalid(format!("base URL must start with http:// or https:// (got \"{u}\")")));
    }
    Ok(Some(u.trim_end_matches('/').to_string()))
}

/// Last four characters of a key, shown as `…abcd`. Short keys get no hint.
pub fn key_hint(key: &str) -> Option<String> {
    let chars: Vec<char> = key.chars().collect();
    (chars.len() >= 8).then(|| chars[chars.len() - 4..].iter().collect())
}

pub fn builtin_providers() -> Vec<Provider> {
    let p = |id: &str, kind, name: &str| Provider {
        id: id.into(),
        kind,
        name: name.into(),
        base_url: None,
        account_id: None,
        has_key: false,
        key_hint: None,
        builtin: true,
    };
    vec![
        p("typesafe", ProviderKind::Typesafe, "TypeSafe"),
        p("openai", ProviderKind::Openai, "OpenAI"),
        p("cloudflare", ProviderKind::Cloudflare, "Cloudflare Workers AI"),
        p("anthropic", ProviderKind::Anthropic, "Anthropic"),
        p("openai-chat", ProviderKind::Chat, "OpenAI (LLM)"),
    ]
}

pub fn builtin_models() -> Vec<CloudModel> {
    let m = |provider: &str, model: &str, display: &str, desc: &str, input: f64| CloudModel {
        provider_id: provider.into(),
        model: model.into(),
        display_name: display.into(),
        description: Some(desc.into()),
        input_price_per_mtok: input,
        output_price_per_mtok: 0.0,
        enabled: true,
        builtin: true,
    };
    vec![
        m("typesafe", "jev-latest", "Jev", "TypeSafe's flagship System One model.", 0.042),
        m("openai", "gpt-6-luna", "GPT-6 Luna", "OpenAI Decisions API (public beta).", 0.10),
        m("cloudflare", "clef-flash", "Clef Flash", "Fast 9B multimodal decision model on Workers AI.", 0.09),
        m("cloudflare", "clef", "Clef", "Larger decision model on Workers AI.", 0.24),
        CloudModel {
            output_price_per_mtok: 5.0,
            ..m("anthropic", "claude-haiku-4-5-20251001", "Claude Haiku 4.5", "Fast, inexpensive LLM; answers through structured output.", 1.0)
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ollaya::Usage;

    #[test]
    fn model_ids() {
        assert_eq!(parse_model_id("laya:en").unwrap(), ModelRef::Local("laya:en"));
        assert_eq!(
            parse_model_id("@typesafe/jev-latest").unwrap(),
            ModelRef::Cloud { provider: "typesafe", model: "jev-latest" }
        );
        // only the first slash separates the provider
        assert_eq!(
            parse_model_id("@my-openrouter/typesafe/jev").unwrap(),
            ModelRef::Cloud { provider: "my-openrouter", model: "typesafe/jev" }
        );
        for bad in ["@typesafe", "@/jev", "@typesafe/", ""] {
            assert!(parse_model_id(bad).is_err(), "{bad}");
        }
        assert_eq!(cloud_model_id("openai", "gpt-6-luna"), "@openai/gpt-6-luna");
        assert!(is_cloud_model("@openai/gpt-6-luna") && !is_cloud_model("laya"));
        assert_eq!(parse_model_id("ft:pubmed-sections").unwrap(), ModelRef::FineTuned("pubmed-sections"));
    }

    #[test]
    fn cost() {
        let u = Usage { input_tokens: 2_000_000, output_tokens: 500_000 };
        assert!((cost_usd(u, 0.042, 0.0) - 0.084).abs() < 1e-12);
        assert!((cost_usd(u, 0.10, 2.0) - 1.2).abs() < 1e-12);
        assert_eq!(cost_usd(Usage::default(), 1.0, 1.0), 0.0);
    }

    #[test]
    fn slugs_urls_hints() {
        assert_eq!(slugify("My OpenRouter!"), "my-openrouter");
        assert_eq!(slugify("  Vercel  AI -- Gateway "), "vercel-ai-gateway");
        assert_eq!(slugify("äöü"), "custom");
        assert_eq!(normalize_base_url(Some(" https://x.dev/ ")).unwrap().as_deref(), Some("https://x.dev"));
        assert_eq!(normalize_base_url(Some("  ")).unwrap(), None);
        assert!(normalize_base_url(Some("x.dev")).is_err());
        assert_eq!(key_hint("sk-1234567890abcd").as_deref(), Some("abcd"));
        assert_eq!(key_hint("short"), None);
    }

    #[test]
    fn views_carry_default_prices() {
        let mut jev = builtin_models().remove(0);
        jev.input_price_per_mtok = 9.0;
        let v = serde_json::to_value(CloudModelView::from(jev)).unwrap();
        assert_eq!(v["default_input_price_per_mtok"], 0.042);
        assert_eq!(v["default_output_price_per_mtok"], 0.0);
        assert_eq!(v["input_price_per_mtok"], 9.0);
        let mut custom = builtin_models().remove(0);
        custom.provider_id = "router".into();
        let v = serde_json::to_value(CloudModelView::from(custom)).unwrap();
        assert!(v["default_input_price_per_mtok"].is_null());
        assert_eq!(v["id"], "@router/jev-latest");
    }
}
