//! Typed client for the Ollaya daemon. The contract is Ollaya's `docs/api.md`.

use std::time::Duration;

use futures_util::StreamExt;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Error, Result};

pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:11435";

/// One typed question (TypeSafe wire schema, §5.2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Question {
    Choice {
        #[serde(skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        /// label -> description (null = no description)
        criteria: IndexMap<String, Option<String>>,
    },
    Score {
        #[serde(skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        /// level descriptions, level 0 first
        criteria: Vec<String>,
    },
    Noul {
        #[serde(skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        criteria: Option<NoulCriteria>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct NoulCriteria {
    #[serde(rename = "true", skip_serializing_if = "Option::is_none")]
    pub when_true: Option<String>,
    #[serde(rename = "false", skip_serializing_if = "Option::is_none")]
    pub when_false: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Answer {
    Choice {
        choice: String,
        confidence: f64,
        probabilities: IndexMap<String, f64>,
    },
    Score {
        score: f64,
        confidence: f64,
        #[serde(default)]
        legend: IndexMap<String, String>,
        probabilities: IndexMap<String, f64>,
    },
    Noul {
        noul: f64,
    },
}

/// Tokens billed for one request (Ollaya and the TypeSafe wire format report the same shape).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

impl Answer {
    /// Highest class probability: the quantity used for calibration (ECE).
    pub fn top_probability(&self) -> f64 {
        match self {
            Answer::Choice { probabilities, .. } | Answer::Score { probabilities, .. } => {
                probabilities.values().copied().fold(0.0, f64::max)
            }
            Answer::Noul { noul } => noul.max(1.0 - noul),
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DecideRequest {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub questions: Option<IndexMap<String, Question>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_alive: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Routing {
    pub router: String,
    pub model: String,
    pub route: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecideResponse {
    pub model: String,
    pub answers: IndexMap<String, Answer>,
    #[serde(default)]
    pub usage: Usage,
    #[serde(default)]
    pub routing: Option<Routing>,
    #[serde(default)]
    pub state_truncated: bool,
    #[serde(default)]
    pub total_duration: u64,
    #[serde(default)]
    pub load_duration: u64,
    #[serde(default)]
    pub eval_duration: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelDetails {
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub family: String,
    #[serde(default)]
    pub parameter_size: String,
    #[serde(default)]
    pub quantization_level: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalModel {
    pub name: String,
    #[serde(default)]
    pub modified_at: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub details: ModelDetails,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullProgress {
    pub status: String,
    #[serde(default)]
    pub digest: Option<String>,
    #[serde(default)]
    pub total: Option<u64>,
    #[serde(default)]
    pub completed: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetSummary {
    pub name: String,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub questions: Vec<String>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
    #[serde(default)]
    code: Option<String>,
}

#[derive(Clone)]
pub struct Client {
    base: String,
    http: reqwest::Client,
}

impl Default for Client {
    fn default() -> Self {
        Self::new(DEFAULT_BASE_URL)
    }
}

impl Client {
    pub fn new(base: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .build()
            .expect("reqwest client");
        Self { base: base.into().trim_end_matches('/').to_string(), http }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    fn map_send_err(&self, e: reqwest::Error) -> Error {
        if e.is_connect() || e.is_timeout() {
            Error::EngineOffline(self.base.clone())
        } else {
            Error::Http(e)
        }
    }

    async fn check(resp: reqwest::Response) -> Result<reqwest::Response> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let text = resp.text().await.unwrap_or_default();
        let (message, code) = match serde_json::from_str::<ErrorBody>(&text) {
            Ok(b) => (b.error, b.code.unwrap_or_else(|| status.as_u16().to_string())),
            Err(_) => (text, status.as_u16().to_string()),
        };
        Err(Error::Api { status: status.as_u16(), code, message })
    }

    /// `GET /`: true when the daemon answers.
    pub async fn is_alive(&self) -> bool {
        self.http
            .get(self.url("/"))
            .timeout(Duration::from_millis(800))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    pub async fn version(&self) -> Result<String> {
        #[derive(Deserialize)]
        struct V {
            version: String,
        }
        let r = self.http.get(self.url("/api/version")).send().await.map_err(|e| self.map_send_err(e))?;
        Ok(Self::check(r).await?.json::<V>().await?.version)
    }

    pub async fn tags(&self) -> Result<Vec<LocalModel>> {
        #[derive(Deserialize)]
        struct Tags {
            models: Vec<LocalModel>,
        }
        let r = self.http.get(self.url("/api/tags")).send().await.map_err(|e| self.map_send_err(e))?;
        Ok(Self::check(r).await?.json::<Tags>().await?.models)
    }

    pub async fn presets(&self) -> Result<Vec<PresetSummary>> {
        #[derive(Deserialize)]
        struct P {
            presets: Vec<PresetSummary>,
        }
        let r = self.http.get(self.url("/api/presets")).send().await.map_err(|e| self.map_send_err(e))?;
        Ok(Self::check(r).await?.json::<P>().await?.presets)
    }

    /// `POST /api/presets/show`: a preset's question set (TypeSafe question schema).
    pub async fn preset_questions(&self, name: &str) -> Result<IndexMap<String, Value>> {
        #[derive(Deserialize)]
        struct P {
            questions: IndexMap<String, Value>,
        }
        let r = self
            .http
            .post(self.url("/api/presets/show"))
            .json(&serde_json::json!({ "name": name }))
            .send()
            .await
            .map_err(|e| self.map_send_err(e))?;
        Ok(Self::check(r).await?.json::<P>().await?.questions)
    }

    pub async fn decide(&self, req: &DecideRequest) -> Result<DecideResponse> {
        let r = self
            .http
            .post(self.url("/api/decide"))
            .json(req)
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .map_err(|e| self.map_send_err(e))?;
        Ok(Self::check(r).await?.json().await?)
    }

    /// Load a model into memory (a decide request without state, §7.3).
    pub async fn load(&self, model: &str) -> Result<DecideResponse> {
        self.decide(&DecideRequest { model: model.into(), ..Default::default() }).await
    }

    pub async fn delete(&self, model: &str) -> Result<()> {
        let r = self
            .http
            .delete(self.url("/api/delete"))
            .json(&serde_json::json!({ "model": model }))
            .send()
            .await
            .map_err(|e| self.map_send_err(e))?;
        Self::check(r).await?;
        Ok(())
    }

    /// `POST /api/pull`, streaming NDJSON progress to `on_progress`.
    pub async fn pull(&self, model: &str, mut on_progress: impl FnMut(PullProgress)) -> Result<()> {
        let r = self
            .http
            .post(self.url("/api/pull"))
            .json(&serde_json::json!({ "model": model, "stream": true }))
            .send()
            .await
            .map_err(|e| self.map_send_err(e))?;
        let r = Self::check(r).await?;
        let mut stream = r.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut finished = false;
        while let Some(chunk) = stream.next().await {
            buf.extend_from_slice(&chunk?);
            while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line);
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let v: Value = serde_json::from_str(line)?;
                if let Some(err) = v.get("error").and_then(Value::as_str) {
                    let code = v.get("code").and_then(Value::as_str).unwrap_or("PULL_FAILED");
                    return Err(Error::Api { status: 200, code: code.into(), message: err.into() });
                }
                let p: PullProgress = serde_json::from_value(v)?;
                finished |= p.status == "success";
                on_progress(p);
            }
        }
        if !finished {
            return Err(Error::invalid("pull stream ended without success; try again"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn question_wire_format() {
        let mut criteria = IndexMap::new();
        criteria.insert("billing".to_string(), Some("Payments".to_string()));
        criteria.insert("technical".to_string(), None);
        let q = Question::Choice { instructions: Some("Which team?".into()), criteria };
        let v = serde_json::to_value(&q).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"type":"choice","instructions":"Which team?","criteria":{"billing":"Payments","technical":null}})
        );
    }

    #[test]
    fn parses_decide_response() {
        let body = r#"{"model":"laya:en","answers":{
            "department":{"type":"choice","choice":"billing","confidence":0.77,"probabilities":{"billing":0.85,"technical":0.06,"account":0.09}},
            "refund":{"type":"noul","noul":0.91}},
            "usage":{"input_tokens":1,"output_tokens":0},"routing":null,"state_truncated":false,
            "done_reason":"decide","created_at":"x","total_duration":10,"load_duration":0,"eval_duration":5}"#;
        let r: DecideResponse = serde_json::from_str(body).unwrap();
        assert_eq!(r.answers.len(), 2);
        assert_eq!(r.usage, Usage { input_tokens: 1, output_tokens: 0 });
        assert!((r.answers["department"].top_probability() - 0.85).abs() < 1e-9);
        assert!((r.answers["refund"].top_probability() - 0.91).abs() < 1e-9);
    }
}
