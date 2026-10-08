//! One entry point for decisions, local or cloud. A model id starting with `@` goes to a cloud
//! provider ([`crate::cloud`]), anything else to the Ollaya daemon. Every successful request is
//! written to the usage log with its tokens and cost.
//!
//! The decider also manages providers, their models and API keys, since keys are cached here.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use crate::ollaya::{Answer, Client, DecideRequest, Question, Routing, Usage};
use crate::providers::{
    self, parse_model_id, CloudModel, CloudModelInput, CloudModelView, ModelRef, Provider, ProviderInput, ProviderKind,
    ProviderView,
};
use crate::secrets::SecretStore;
use crate::store::{Store, UsageEntry};
use crate::{cloud, Error, Result};

/// Who asked, for the usage log.
#[derive(Debug, Clone)]
pub struct UsageContext {
    /// `quick`, `experiment` or `test`
    pub source: &'static str,
    pub experiment_id: Option<String>,
}

impl UsageContext {
    pub fn quick() -> Self {
        Self { source: "quick", experiment_id: None }
    }
    pub fn experiment(id: impl Into<String>) -> Self {
        Self { source: "experiment", experiment_id: Some(id.into()) }
    }
    pub fn test() -> Self {
        Self { source: "test", experiment_id: None }
    }
}

/// Answers of one request, normalized across providers.
#[derive(Debug, Clone, Serialize)]
pub struct Decision {
    /// The model the server says answered (Ollaya resolves tags and routers; clouds report versions).
    pub model_answered: String,
    pub answers: IndexMap<String, Answer>,
    /// Questions the provider declined to answer; they are missing from `answers`.
    pub refused: Vec<String>,
    pub routing: Option<Routing>,
    pub usage: Usage,
    pub cost_usd: f64,
    /// Ollaya's eval time when it reports one, else wall clock.
    pub latency_ms: f64,
    pub load_ms: f64,
    pub state_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderTest {
    pub ok: bool,
    pub message: String,
    pub latency_ms: f64,
}

pub struct Decider {
    ollaya: Client,
    store: Arc<Store>,
    secrets: Arc<dyn SecretStore>,
    http: reqwest::Client,
    /// provider id -> key (None: none stored), so the keychain is read once per provider
    keys: Mutex<HashMap<String, Option<String>>>,
}

fn elapsed_ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

impl Decider {
    pub fn new(ollaya: Client, store: Arc<Store>, secrets: Arc<dyn SecretStore>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .user_agent(concat!("ClassifAI/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client");
        Self { ollaya, store, secrets, http, keys: Mutex::new(HashMap::new()) }
    }

    pub fn ollaya(&self) -> &Client {
        &self.ollaya
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.store
    }

    pub async fn decide(
        &self,
        model: &str,
        state: Value,
        questions: IndexMap<String, Question>,
        ctx: &UsageContext,
    ) -> Result<Decision> {
        self.run(model, state, Some(questions), None, ctx).await
    }

    /// An Ollaya preset (plus optional extra questions). Presets live in the local daemon.
    pub async fn decide_preset(
        &self,
        model: &str,
        state: Value,
        preset: String,
        questions: Option<IndexMap<String, Question>>,
        ctx: &UsageContext,
    ) -> Result<Decision> {
        self.run(model, state, questions, Some(preset), ctx).await
    }

    async fn run(
        &self,
        model: &str,
        state: Value,
        questions: Option<IndexMap<String, Question>>,
        preset: Option<String>,
        ctx: &UsageContext,
    ) -> Result<Decision> {
        match parse_model_id(model)? {
            ModelRef::Local(name) => {
                let req = DecideRequest { model: name.into(), state: Some(state), questions, preset, keep_alive: None };
                let started = Instant::now();
                let resp = self.ollaya.decide(&req).await?;
                let wall = elapsed_ms(started);
                self.log(ctx, model, resp.usage, 0.0);
                Ok(Decision {
                    model_answered: resp.model,
                    answers: resp.answers,
                    refused: Vec::new(),
                    routing: resp.routing,
                    usage: resp.usage,
                    cost_usd: 0.0,
                    latency_ms: if resp.eval_duration > 0 { resp.eval_duration as f64 / 1e6 } else { wall },
                    load_ms: resp.load_duration as f64 / 1e6,
                    state_truncated: resp.state_truncated,
                })
            }
            ModelRef::Cloud { provider, model: name } => {
                if preset.is_some() {
                    return Err(Error::invalid("presets are only available for local models"));
                }
                let questions = questions.ok_or_else(|| Error::invalid("add at least one question"))?;
                let (p, m) = self.resolve(provider, name)?;
                let key = self.key_for(&p)?;
                let started = Instant::now();
                let r = cloud::decide(&self.http, &p, key.as_deref(), name, &state, &questions).await?;
                let latency_ms = elapsed_ms(started);
                let cost_usd = m.cost(r.usage);
                self.log(ctx, model, r.usage, cost_usd);
                Ok(Decision {
                    model_answered: if r.model.is_empty() { name.to_string() } else { r.model },
                    answers: r.answers,
                    refused: r.refused,
                    routing: None,
                    usage: r.usage,
                    cost_usd,
                    latency_ms,
                    load_ms: 0.0,
                    state_truncated: false,
                })
            }
        }
    }

    /// Load a local model into memory. For a cloud model, check that it can be called (known,
    /// enabled, key and account id present) without sending a request.
    pub async fn load(&self, model: &str) -> Result<()> {
        match parse_model_id(model)? {
            ModelRef::Local(name) => self.ollaya.load(name).await.map(|_| ()),
            ModelRef::Cloud { provider, model } => {
                let (p, _) = self.resolve(provider, model)?;
                self.key_for(&p)?;
                if p.kind == ProviderKind::Cloudflare && p.account_id.as_deref().is_none_or(|a| a.trim().is_empty()) {
                    return Err(Error::invalid(format!("{} needs an account id; set it under Providers", p.name)));
                }
                Ok(())
            }
        }
    }

    fn resolve(&self, provider_id: &str, model: &str) -> Result<(Provider, CloudModel)> {
        let id = providers::cloud_model_id(provider_id, model);
        let p = match self.store.get_provider(provider_id) {
            Err(Error::NotFound(_)) => return Err(Error::invalid(format!("{id}: unknown provider \"{provider_id}\""))),
            other => other?,
        };
        let m = self
            .store
            .get_cloud_model(provider_id, model)?
            .ok_or_else(|| Error::invalid(format!("{id} is not set up; add the model under Providers")))?;
        if !m.enabled {
            return Err(Error::invalid(format!("{id} is disabled; enable it under Providers")));
        }
        Ok((p, m))
    }

    /// The keychain is only read when the store says a key was saved, so providers without one
    /// never touch it.
    fn key_for(&self, p: &Provider) -> Result<Option<String>> {
        let key = if !p.has_key {
            None
        } else {
            let cached = self.keys.lock().unwrap_or_else(|e| e.into_inner()).get(&p.id).cloned();
            match cached {
                Some(k) => k,
                None => {
                    let k = self.secrets.get(&p.id)?.filter(|k| !k.is_empty());
                    self.keys.lock().unwrap_or_else(|e| e.into_inner()).insert(p.id.clone(), k.clone());
                    k
                }
            }
        };
        if key.is_none() && p.kind.requires_key() {
            return Err(Error::Api {
                status: 0,
                code: "NO_API_KEY".into(),
                message: format!("{} has no API key; add one under Providers", p.name),
            });
        }
        Ok(key)
    }

    /// A failed log write must not fail a request that was already paid for.
    fn log(&self, ctx: &UsageContext, model: &str, usage: Usage, cost_usd: f64) {
        let _ = self.store.log_usage(&UsageEntry {
            source: ctx.source.into(),
            experiment_id: ctx.experiment_id.clone(),
            model: model.into(),
            requests: 1,
            usage,
            cost_usd,
        });
    }

    // ---- providers ---------------------------------------------------------------------------

    pub fn providers(&self) -> Result<Vec<ProviderView>> {
        self.store.list_providers()?.into_iter().map(|p| self.view(p)).collect()
    }

    pub fn provider(&self, id: &str) -> Result<ProviderView> {
        self.view(self.store.get_provider(id)?)
    }

    fn view(&self, provider: Provider) -> Result<ProviderView> {
        let models = self.store.list_cloud_models(Some(&provider.id))?.into_iter().map(Into::into).collect();
        Ok(ProviderView { provider, models })
    }

    /// Create a custom provider (`id` None) or update one; see [`ProviderInput::api_key`].
    pub fn save_provider(&self, input: ProviderInput) -> Result<ProviderView> {
        let base_url = providers::normalize_base_url(input.base_url.as_deref())?;
        let account_id = input.account_id.as_deref().map(str::trim).filter(|a| !a.is_empty()).map(String::from);
        let name = input.name.trim();
        let provider = match input.id.as_deref().map(str::trim).filter(|i| !i.is_empty()) {
            None => {
                if input.kind != ProviderKind::Custom {
                    return Err(Error::invalid("only custom providers can be added; the built-in ones already exist"));
                }
                if name.is_empty() {
                    return Err(Error::invalid("give the provider a name"));
                }
                if base_url.is_none() {
                    return Err(Error::invalid("a custom provider needs a base URL"));
                }
                let slug = providers::slugify(name);
                let mut id = slug.clone();
                let mut n = 2;
                while self.store.get_provider(&id).is_ok() {
                    id = format!("{slug}-{n}");
                    n += 1;
                }
                let p = Provider {
                    id,
                    kind: ProviderKind::Custom,
                    name: name.into(),
                    base_url,
                    account_id,
                    has_key: false,
                    key_hint: None,
                    builtin: false,
                };
                self.store.insert_provider(&p)?;
                p
            }
            Some(id) => {
                let mut p = self.store.get_provider(id)?;
                if input.kind != p.kind {
                    return Err(Error::invalid("the kind of a provider cannot be changed"));
                }
                if !name.is_empty() {
                    p.name = name.into();
                }
                if p.kind == ProviderKind::Custom && base_url.is_none() {
                    return Err(Error::invalid("a custom provider needs a base URL"));
                }
                p.base_url = base_url;
                p.account_id = account_id;
                self.store.update_provider(&p)?;
                p
            }
        };
        if let Some(key) = input.api_key {
            self.set_key(&provider.id, Some(key.trim()))?;
        }
        self.provider(&provider.id)
    }

    /// Store (or with None / `""`, remove) a provider's key in the keychain.
    pub fn set_key(&self, provider_id: &str, key: Option<&str>) -> Result<()> {
        let key = key.filter(|k| !k.is_empty());
        match key {
            Some(k) => {
                self.secrets.set(provider_id, k)?;
                self.store.set_provider_key_state(provider_id, true, providers::key_hint(k).as_deref())?;
            }
            None => {
                self.secrets.delete(provider_id)?;
                self.store.set_provider_key_state(provider_id, false, None)?;
            }
        }
        self.keys.lock().unwrap_or_else(|e| e.into_inner()).insert(provider_id.into(), key.map(String::from));
        Ok(())
    }

    /// Custom providers only; their key and models go too.
    pub fn delete_provider(&self, id: &str) -> Result<()> {
        let p = self.store.get_provider(id)?;
        if p.builtin {
            return Err(Error::invalid(format!("{} is built in and cannot be deleted", p.name)));
        }
        self.secrets.delete(id)?;
        self.store.delete_provider(id)?;
        self.keys.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        Ok(())
    }

    /// One tiny request against the provider's first enabled model. API errors are reported in
    /// the result, not as an error.
    pub async fn test_provider(&self, id: &str) -> Result<ProviderTest> {
        let p = self.store.get_provider(id)?;
        let Some(m) = self.store.list_cloud_models(Some(id))?.into_iter().find(|m| m.enabled) else {
            return Ok(ProviderTest {
                ok: false,
                message: format!("{} has no enabled model to test with", p.name),
                latency_ms: 0.0,
            });
        };
        let mut questions = IndexMap::new();
        questions.insert(
            "colour".to_string(),
            Question::Noul { instructions: Some("The text mentions a colour.".into()), criteria: None },
        );
        let started = Instant::now();
        let result = self.decide(&m.id(), Value::String("The sky is blue.".into()), questions, &UsageContext::test()).await;
        let latency_ms = elapsed_ms(started);
        Ok(match result {
            Ok(d) => {
                let message = match d.answers.get("colour") {
                    Some(Answer::Noul { noul }) => {
                        format!("{} answered in {latency_ms:.0} ms (P(mentions a colour) = {noul:.2})", m.id())
                    }
                    _ if !d.refused.is_empty() => format!("{} is reachable but refused the test question", m.id()),
                    _ => format!("{} answered in {latency_ms:.0} ms", m.id()),
                };
                ProviderTest { ok: true, message, latency_ms }
            }
            Err(e) => ProviderTest { ok: false, message: e.to_string(), latency_ms },
        })
    }

    /// Add a model or change its name, prices and switch. Built-in models stay built in.
    pub fn save_cloud_model(&self, input: CloudModelInput) -> Result<CloudModelView> {
        let provider = self.store.get_provider(input.provider_id.trim())?;
        let model = input.model.trim();
        if model.is_empty() || model.chars().any(char::is_whitespace) {
            return Err(Error::invalid("enter the model name exactly as the provider expects it (no spaces)"));
        }
        for price in [input.input_price_per_mtok, input.output_price_per_mtok] {
            if !price.is_finite() || price < 0.0 {
                return Err(Error::invalid("prices must be zero or more (USD per million tokens)"));
            }
        }
        let existing = self.store.get_cloud_model(&provider.id, model)?;
        let display_name = input
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(String::from)
            .or_else(|| existing.as_ref().map(|m| m.display_name.clone()))
            .unwrap_or_else(|| model.to_string());
        let m = CloudModel {
            provider_id: provider.id,
            model: model.into(),
            display_name,
            description: existing.as_ref().and_then(|m| m.description.clone()),
            input_price_per_mtok: input.input_price_per_mtok,
            output_price_per_mtok: input.output_price_per_mtok,
            enabled: input.enabled,
            builtin: existing.is_some_and(|m| m.builtin),
        };
        self.store.upsert_cloud_model(&m)?;
        Ok(m.into())
    }

    /// `id` is `@provider/model`; built-in models can only be disabled.
    pub fn delete_cloud_model(&self, id: &str) -> Result<()> {
        let ModelRef::Cloud { provider, model } = parse_model_id(id)? else {
            return Err(Error::invalid(format!("\"{id}\" is not a cloud model id")));
        };
        let m = self.store.get_cloud_model(provider, model)?.ok_or_else(|| Error::NotFound(format!("model {id}")))?;
        if m.builtin {
            return Err(Error::invalid(format!("{id} is built in; disable it instead")));
        }
        self.store.delete_cloud_model(provider, model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemorySecrets;

    fn decider() -> (Decider, Arc<MemorySecrets>) {
        let secrets = Arc::new(MemorySecrets::new());
        let store = Arc::new(Store::open_in_memory().unwrap());
        // nothing listens here; local models are not used in these tests
        (Decider::new(Client::new("http://127.0.0.1:9"), store, secrets.clone()), secrets)
    }

    fn input(id: Option<&str>, kind: ProviderKind, name: &str) -> ProviderInput {
        ProviderInput { id: id.map(Into::into), kind, name: name.into(), base_url: None, account_id: None, api_key: None }
    }

    #[test]
    fn keys_go_to_the_secret_store() {
        let (d, secrets) = decider();
        let v = d
            .save_provider(ProviderInput { api_key: Some(" sk-test-1234WXYZ ".into()), ..input(Some("openai"), ProviderKind::Openai, "") })
            .unwrap();
        assert!(v.provider.has_key);
        assert_eq!(v.provider.key_hint.as_deref(), Some("WXYZ"));
        assert_eq!(v.provider.name, "OpenAI", "an empty name keeps the old one");
        assert_eq!(secrets.get("openai").unwrap().as_deref(), Some("sk-test-1234WXYZ"));
        assert_eq!(v.models[0].id, "@openai/gpt-6-luna");

        // None keeps the key, "" removes it
        let v = d.save_provider(input(Some("openai"), ProviderKind::Openai, "OpenAI EU")).unwrap();
        assert!(v.provider.has_key);
        assert_eq!(v.provider.name, "OpenAI EU");
        let v = d.save_provider(ProviderInput { api_key: Some(String::new()), ..input(Some("openai"), ProviderKind::Openai, "") }).unwrap();
        assert!(!v.provider.has_key && v.provider.key_hint.is_none());
        assert_eq!(secrets.get("openai").unwrap(), None);
    }

    #[test]
    fn custom_providers_and_models() {
        let (d, secrets) = decider();
        assert!(d.save_provider(input(None, ProviderKind::Openai, "Another OpenAI")).is_err(), "built-ins exist once");
        assert!(d.save_provider(input(None, ProviderKind::Custom, "Router")).is_err(), "base URL required");
        let mk = |name: &str| ProviderInput {
            base_url: Some("https://openrouter.ai/api/".into()),
            api_key: Some("or-key-12345678".into()),
            ..input(None, ProviderKind::Custom, name)
        };
        let a = d.save_provider(mk("My OpenRouter")).unwrap();
        let b = d.save_provider(mk("My OpenRouter")).unwrap();
        assert_eq!(a.provider.id, "my-openrouter");
        assert_eq!(b.provider.id, "my-openrouter-2");
        assert_eq!(a.provider.base_url.as_deref(), Some("https://openrouter.ai/api"));
        assert!(d.save_provider(input(Some("my-openrouter"), ProviderKind::Typesafe, "x")).is_err(), "kind is fixed");

        let m = d
            .save_cloud_model(CloudModelInput {
                provider_id: "my-openrouter".into(),
                model: "jev-latest".into(),
                display_name: None,
                input_price_per_mtok: 0.05,
                output_price_per_mtok: 0.0,
                enabled: true,
            })
            .unwrap();
        assert_eq!(m.id, "@my-openrouter/jev-latest");
        assert_eq!(m.model.display_name, "jev-latest");
        assert!(!m.model.builtin);
        assert_eq!(d.provider("my-openrouter").unwrap().models.len(), 1);

        // a built-in model keeps its flag and description; it can be disabled but not deleted
        let jev = d
            .save_cloud_model(CloudModelInput {
                provider_id: "typesafe".into(),
                model: "jev-latest".into(),
                display_name: None,
                input_price_per_mtok: 0.05,
                output_price_per_mtok: 0.0,
                enabled: false,
            })
            .unwrap();
        assert!(jev.model.builtin && !jev.model.enabled);
        assert_eq!(jev.model.display_name, "Jev");
        assert!(d.delete_cloud_model("@typesafe/jev-latest").is_err());
        d.delete_cloud_model("@my-openrouter/jev-latest").unwrap();
        assert!(d.delete_cloud_model("laya").is_err());

        assert!(d.delete_provider("typesafe").is_err());
        d.delete_provider("my-openrouter").unwrap();
        assert_eq!(secrets.get("my-openrouter").unwrap(), None);
        assert!(d.provider("my-openrouter").is_err());
    }

    #[tokio::test]
    async fn cloud_models_are_checked_before_any_request() {
        let (d, _) = decider();
        let code = |r: Result<()>| r.unwrap_err().code().to_string();
        assert_eq!(code(d.load("@nope/x").await), "INVALID");
        assert_eq!(code(d.load("@typesafe/unknown").await), "INVALID");
        assert_eq!(code(d.load("@typesafe/jev-latest").await), "NO_API_KEY");
        d.set_key("typesafe", Some("ts-key-12345678")).unwrap();
        d.load("@typesafe/jev-latest").await.unwrap();

        d.set_key("cloudflare", Some("cf-token-12345678")).unwrap();
        assert!(d.load("@cloudflare/clef-flash").await.unwrap_err().to_string().contains("account id"));

        let mut jev = d.store.get_cloud_model("typesafe", "jev-latest").unwrap().unwrap();
        jev.enabled = false;
        d.store.upsert_cloud_model(&jev).unwrap();
        assert!(d.load("@typesafe/jev-latest").await.unwrap_err().to_string().contains("disabled"));

        // presets are an Ollaya feature
        let err = d
            .decide_preset("@openai/gpt-6-luna", Value::Null, "triage".into(), None, &UsageContext::quick())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("only available for local models"));
    }
}
