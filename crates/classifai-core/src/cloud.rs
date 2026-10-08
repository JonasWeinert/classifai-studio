//! HTTP clients for cloud decision models. Every provider is translated to and from Ollaya's
//! question and answer types, so the rest of the app does not care where a model runs.
//!
//! | Kind | Request | Notes |
//! |---|---|---|
//! | `typesafe`, `custom` | `POST {base}/v1/systemone`, TypeSafe System One body | same shape as Ollaya |
//! | `cloudflare` | `POST {base}/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}` | System One body, response may be wrapped in `{result, success, errors}` |
//! | `openai` | `POST {base}/v1/decisions` | questions as a list; `noul` → `predicate` |
//!
//! 429 / 503 / 529 are retried with backoff (honouring `retry-after`), up to [`MAX_ATTEMPTS`].

use std::time::Duration;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ollaya::{Answer, NoulCriteria, Question, Usage};
use crate::providers::{Provider, ProviderKind};
use crate::{Error, Result};

pub const MAX_ATTEMPTS: u32 = 4;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RETRY_WAIT: Duration = Duration::from_secs(30);

/// A provider's answers in Ollaya's types.
#[derive(Debug, Clone)]
pub struct CloudAnswers {
    /// The model the provider says answered (may be a dated version); empty when not reported.
    pub model: String,
    pub answers: IndexMap<String, Answer>,
    /// Questions the provider declined to answer; they have no entry in `answers`.
    pub refused: Vec<String>,
    pub usage: Usage,
}

pub async fn decide(
    http: &reqwest::Client,
    provider: &Provider,
    key: Option<&str>,
    model: &str,
    state: &Value,
    questions: &IndexMap<String, Question>,
) -> Result<CloudAnswers> {
    if questions.is_empty() {
        return Err(Error::invalid("add at least one question"));
    }
    let max = provider.kind.max_questions();
    if questions.len() > max {
        return Err(Error::invalid(format!(
            "{} accepts at most {max} questions per request; this one has {}",
            provider.name,
            questions.len()
        )));
    }
    let base = provider
        .base_url()
        .ok_or_else(|| Error::invalid(format!("{} has no base URL; set one under Providers", provider.name)))?;
    let systemone = || serde_json::to_value(SystemOneRequest { model, state, questions });
    let (url, body) = match provider.kind {
        ProviderKind::Typesafe | ProviderKind::Custom => (format!("{}/v1/systemone", api_root(base)), systemone()?),
        ProviderKind::Cloudflare => {
            let account = provider
                .account_id
                .as_deref()
                .filter(|a| !a.trim().is_empty())
                .ok_or_else(|| Error::invalid(format!("{} needs an account id", provider.name)))?;
            (format!("{base}/client/v4/accounts/{}/ai/run/@cf/cloudflare/{model}", account.trim()), systemone()?)
        }
        ProviderKind::Openai => {
            (format!("{}/v1/decisions", api_root(base)), serde_json::to_value(openai_request(model, state, questions))?)
        }
    };
    let text = send(http, provider, &url, key, &body).await?;
    let v: Value = serde_json::from_str(&text).map_err(|e| bad_response(provider, e))?;
    match provider.kind {
        ProviderKind::Openai => openai_response(v, questions),
        ProviderKind::Cloudflare => systemone_response(unwrap_cloudflare(v)?),
        ProviderKind::Typesafe | ProviderKind::Custom => systemone_response(v),
    }
    .map_err(|e| match e {
        Error::Json(e) => bad_response(provider, e),
        e => e,
    })
}

/// `https://x/v1` and `https://x` both mean the API root `https://x`.
fn api_root(base: &str) -> &str {
    let b = base.trim_end_matches('/');
    b.strip_suffix("/v1").unwrap_or(b)
}

fn bad_response(provider: &Provider, e: impl std::fmt::Display) -> Error {
    Error::Api { status: 200, code: "BAD_RESPONSE".into(), message: format!("{}: unexpected response: {e}", provider.name) }
}

async fn send(http: &reqwest::Client, provider: &Provider, url: &str, key: Option<&str>, body: &Value) -> Result<String> {
    let mut attempt = 1;
    loop {
        let mut req = http.post(url).json(body).timeout(REQUEST_TIMEOUT);
        if let Some(k) = key.filter(|k| !k.is_empty()) {
            req = req.bearer_auth(k);
        }
        let resp = req.send().await.map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                Error::Api {
                    status: 0,
                    code: "PROVIDER_UNREACHABLE".into(),
                    message: format!("{} could not be reached: {e}", provider.name),
                }
            } else {
                Error::Http(e)
            }
        })?;
        let status = resp.status().as_u16();
        if resp.status().is_success() {
            return Ok(resp.text().await?);
        }
        if matches!(status, 429 | 503 | 529) && attempt < MAX_ATTEMPTS {
            let wait = retry_after(resp.headers()).unwrap_or(Duration::from_millis(500 << (attempt - 1)));
            tokio::time::sleep(wait.min(MAX_RETRY_WAIT)).await;
            attempt += 1;
            continue;
        }
        let text = resp.text().await.unwrap_or_default();
        return Err(api_error(provider, status, &text));
    }
}

fn retry_after(h: &reqwest::header::HeaderMap) -> Option<Duration> {
    let secs: f64 = h.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?.trim().parse().ok()?;
    (secs.is_finite() && secs >= 0.0).then(|| Duration::from_secs_f64(secs))
}

fn api_error(provider: &Provider, status: u16, body: &str) -> Error {
    let (message, body_code) = error_detail(body);
    let code = match status {
        401 | 403 => "UNAUTHORIZED".to_string(),
        429 => "RATE_LIMITED".to_string(),
        529 => "OVERLOADED".to_string(),
        _ => body_code.unwrap_or_else(|| status.to_string()),
    };
    let message = message.unwrap_or_else(|| format!("HTTP {status}"));
    let hint = if code == "UNAUTHORIZED" { " Check the API key under Providers." } else { "" };
    Error::Api { status, code, message: format!("{}: {}.{hint}", provider.name, message.trim_end_matches('.')) }
}

/// Message and code from the error bodies the providers use: `{error: "..."}` (Ollaya),
/// `{error: {message, code|type}}` (OpenAI), `{errors: [{message, code}]}` (Cloudflare),
/// `{detail: "..." | [{loc, msg}]}` (FastAPI / TypeSafe).
pub(crate) fn error_detail(body: &str) -> (Option<String>, Option<String>) {
    let text = body.trim();
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        let t: String = text.chars().take(300).collect();
        return ((!t.is_empty()).then_some(t), None);
    };
    let as_code = |v: Option<&Value>| match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    };
    let str_of = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_string);
    if let Some(e) = v.get("error") {
        if let Some(s) = e.as_str() {
            return (Some(s.into()), as_code(v.get("code")));
        }
        if e.is_object() {
            return (str_of(e.get("message")), as_code(e.get("code")).or_else(|| as_code(e.get("type"))));
        }
    }
    if let Some(first) = v.get("errors").and_then(Value::as_array).and_then(|a| a.first()) {
        return (str_of(first.get("message")), as_code(first.get("code")));
    }
    match v.get("detail") {
        Some(Value::String(s)) => return (Some(s.clone()), None),
        Some(Value::Array(items)) => {
            let msgs: Vec<String> = items
                .iter()
                .map(|i| {
                    let loc: Vec<String> = i
                        .get("loc")
                        .and_then(Value::as_array)
                        .map(|l| l.iter().map(|p| p.as_str().map(str::to_string).unwrap_or_else(|| p.to_string())).collect())
                        .unwrap_or_default();
                    let msg = i.get("msg").and_then(Value::as_str).unwrap_or("invalid");
                    if loc.is_empty() { msg.to_string() } else { format!("{}: {msg}", loc.join(".")) }
                })
                .collect();
            return (Some(msgs.join("; ")), Some("VALIDATION".into()));
        }
        _ => {}
    }
    (str_of(v.get("message")), None)
}

// ---- TypeSafe System One (typesafe, custom, cloudflare) -------------------------------------

#[derive(Serialize)]
struct SystemOneRequest<'a> {
    model: &'a str,
    state: &'a Value,
    questions: &'a IndexMap<String, Question>,
}

#[derive(Deserialize)]
struct SystemOneResponse {
    #[serde(default)]
    model: String,
    answers: IndexMap<String, Answer>,
    #[serde(default)]
    usage: Usage,
}

fn systemone_response(v: Value) -> Result<CloudAnswers> {
    let r: SystemOneResponse = serde_json::from_value(v)?;
    Ok(CloudAnswers { model: r.model, answers: r.answers, refused: Vec::new(), usage: r.usage })
}

/// Workers AI wraps results as `{result, success, errors, messages}`; a failure becomes an error.
pub(crate) fn unwrap_cloudflare(v: Value) -> Result<Value> {
    let Value::Object(mut obj) = v else { return Ok(v) };
    if obj.get("success") == Some(&Value::Bool(false)) {
        let (message, code) = error_detail(&Value::Object(obj).to_string());
        return Err(Error::Api {
            status: 200,
            code: code.unwrap_or_else(|| "CLOUDFLARE_ERROR".into()),
            message: format!("Cloudflare: {}", message.unwrap_or_else(|| "request failed".into())),
        });
    }
    match obj.remove("result") {
        Some(r) => Ok(r),
        None => Ok(Value::Object(obj)),
    }
}

// ---- OpenAI Decisions -----------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub(crate) struct OaiRequest {
    model: String,
    /// Text, or the JSON state serialized to a string.
    input: String,
    questions: Vec<OaiQuestion>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum OaiQuestion {
    Predicate {
        name: String,
        instructions: String,
    },
    Choice {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        choices: Vec<OaiChoice>,
    },
    Score {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        levels: Vec<OaiLevel>,
    },
}

#[derive(Debug, Serialize)]
struct OaiChoice {
    value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

#[derive(Debug, Serialize)]
struct OaiLevel {
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

/// A predicate has no criteria, so what true and false mean is folded into the instructions.
fn predicate_instructions(instructions: Option<&str>, criteria: Option<&NoulCriteria>) -> String {
    let mut parts: Vec<String> = non_empty(instructions).map(str::to_string).into_iter().collect();
    if let Some(c) = criteria {
        if let Some(t) = non_empty(c.when_true.as_deref()) {
            parts.push(format!("True means: {t}"));
        }
        if let Some(f) = non_empty(c.when_false.as_deref()) {
            parts.push(format!("False means: {f}"));
        }
    }
    parts.join("\n")
}

pub(crate) fn openai_request(model: &str, state: &Value, questions: &IndexMap<String, Question>) -> OaiRequest {
    let input = match state {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    };
    let questions = questions
        .iter()
        .map(|(name, q)| {
            let name = name.clone();
            match q {
                Question::Noul { instructions, criteria } => OaiQuestion::Predicate {
                    name,
                    instructions: predicate_instructions(instructions.as_deref(), criteria.as_ref()),
                },
                Question::Choice { instructions, criteria } => OaiQuestion::Choice {
                    name,
                    instructions: non_empty(instructions.as_deref()).map(Into::into),
                    choices: criteria
                        .iter()
                        .map(|(value, desc)| OaiChoice {
                            value: value.clone(),
                            description: non_empty(desc.as_deref()).map(Into::into),
                        })
                        .collect(),
                },
                Question::Score { instructions, criteria } => OaiQuestion::Score {
                    name,
                    instructions: non_empty(instructions.as_deref()).map(Into::into),
                    levels: criteria.iter().map(|l| OaiLevel { label: l.clone(), description: None }).collect(),
                },
            }
        })
        .collect();
    OaiRequest { model: model.into(), input, questions }
}

#[derive(Deserialize)]
struct OaiResponse {
    #[serde(default)]
    model: String,
    answers: Vec<OaiAnswer>,
    #[serde(default)]
    usage: Usage,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum OaiAnswer {
    Predicate {
        name: String,
        probability: f64,
    },
    Choice {
        name: String,
        choice: Value,
        #[serde(default)]
        probabilities: Vec<OaiProbability>,
        #[serde(default)]
        confidence: Option<f64>,
    },
    Score {
        name: String,
        score: f64,
        #[serde(default)]
        probabilities: Vec<OaiProbability>,
        #[serde(default)]
        confidence: Option<f64>,
    },
    Refusal {
        #[serde(default)]
        name: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize)]
struct OaiProbability {
    value: Value,
    #[serde(default)]
    label: Option<String>,
    probability: f64,
}

fn value_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

/// 0 for a uniform distribution, 1 for a certain one; used when the provider sends none.
fn normalized_confidence(probs: &IndexMap<String, f64>) -> f64 {
    let k = probs.len() as f64;
    let top = probs.values().copied().fold(0.0, f64::max);
    if k < 2.0 { 1.0 } else { ((k * top - 1.0) / (k - 1.0)).clamp(0.0, 1.0) }
}

/// Answers come back keyed by our question ids, with choice probabilities in our option order and
/// score probabilities keyed `"0"`..`"n-1"`, exactly as Ollaya returns them.
pub(crate) fn openai_response(v: Value, questions: &IndexMap<String, Question>) -> Result<CloudAnswers> {
    let r: OaiResponse = serde_json::from_value(v)?;
    let mut answers = IndexMap::new();
    let mut refused = Vec::new();
    let mut unnamed_refusal = false;
    for a in r.answers {
        match a {
            OaiAnswer::Predicate { name, probability } => {
                answers.insert(name, Answer::Noul { noul: probability });
            }
            OaiAnswer::Choice { name, choice, probabilities, confidence } => {
                let Some(Question::Choice { criteria, .. }) = questions.get(&name) else { continue };
                let probs: IndexMap<String, f64> = criteria
                    .keys()
                    .map(|k| {
                        let p = probabilities.iter().find(|p| value_str(&p.value) == *k).map(|p| p.probability);
                        (k.clone(), p.unwrap_or(0.0))
                    })
                    .collect();
                let confidence = confidence.unwrap_or_else(|| normalized_confidence(&probs));
                answers.insert(name, Answer::Choice { choice: value_str(&choice), confidence, probabilities: probs });
            }
            OaiAnswer::Score { name, score, probabilities, confidence } => {
                let Some(Question::Score { criteria, .. }) = questions.get(&name) else { continue };
                let mut probs = IndexMap::new();
                let mut legend = IndexMap::new();
                for (i, level) in criteria.iter().enumerate() {
                    let p = probabilities.iter().find(|p| p.value.as_u64() == Some(i as u64) || value_str(&p.value) == i.to_string());
                    probs.insert(i.to_string(), p.map(|p| p.probability).unwrap_or(0.0));
                    legend.insert(i.to_string(), p.and_then(|p| p.label.clone()).unwrap_or_else(|| level.clone()));
                }
                let confidence = confidence.unwrap_or_else(|| normalized_confidence(&probs));
                answers.insert(name, Answer::Score { score, confidence, legend, probabilities: probs });
            }
            OaiAnswer::Refusal { name: Some(name) } => refused.push(name),
            OaiAnswer::Refusal { name: None } => unnamed_refusal = true,
            OaiAnswer::Unknown => {}
        }
    }
    if unnamed_refusal {
        for id in questions.keys() {
            if !answers.contains_key(id) && !refused.contains(id) {
                refused.push(id.clone());
            }
        }
    }
    Ok(CloudAnswers { model: r.model, answers, refused, usage: r.usage })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn questions() -> IndexMap<String, Question> {
        serde_json::from_value(json!({
            "urgent": {"type": "noul", "instructions": "Is this urgent?", "criteria": {"true": "Time-sensitive", "false": "Can wait"}},
            "team": {"type": "choice", "instructions": "Which team?", "criteria": {"billing": "Payments", "technical": null, "sales": "  "}},
            "severity": {"type": "score", "criteria": ["Cosmetic", "Workaround", "Blocked"]},
            "plain": {"type": "noul", "instructions": "Mentions a colour."}
        }))
        .unwrap()
    }

    #[test]
    fn openai_request_translation() {
        let state = json!({"subject": "Help", "body": "Checkout fails"});
        let r = serde_json::to_value(openai_request("gpt-6-luna", &state, &questions())).unwrap();
        assert_eq!(
            r,
            json!({
                "model": "gpt-6-luna",
                "input": "{\"subject\":\"Help\",\"body\":\"Checkout fails\"}",
                "questions": [
                    {"type": "predicate", "name": "urgent", "instructions": "Is this urgent?\nTrue means: Time-sensitive\nFalse means: Can wait"},
                    {"type": "choice", "name": "team", "instructions": "Which team?", "choices": [
                        {"value": "billing", "description": "Payments"}, {"value": "technical"}, {"value": "sales"}
                    ]},
                    {"type": "score", "name": "severity", "levels": [{"label": "Cosmetic"}, {"label": "Workaround"}, {"label": "Blocked"}]},
                    {"type": "predicate", "name": "plain", "instructions": "Mentions a colour."}
                ]
            })
        );
        let r = openai_request("m", &json!("plain text"), &questions());
        assert_eq!(r.input, "plain text");
    }

    #[test]
    fn openai_response_translation() {
        let body = json!({
            "id": "dec_1", "model": "gpt-6-luna-2026-09-01",
            "answers": [
                {"type": "predicate", "name": "urgent", "probability": 0.92},
                {"type": "choice", "name": "team", "choice": "technical", "confidence": 0.6, "probabilities": [
                    {"value": "sales", "probability": 0.05}, {"value": "technical", "probability": 0.8}, {"value": "billing", "probability": 0.15}
                ]},
                {"type": "score", "name": "severity", "score": 1.1, "confidence": 0.55, "probabilities": [
                    {"value": 0, "label": "Cosmetic", "probability": 0.1},
                    {"value": 2, "label": "Blocked", "probability": 0.2},
                    {"value": 1, "label": "Workaround", "probability": 0.7}
                ]},
                {"type": "refusal", "name": "plain", "refusal": "I can't help with that."}
            ],
            "usage": {"input_tokens": 321, "output_tokens": 0, "total_tokens": 321}
        });
        let r = openai_response(body, &questions()).unwrap();
        assert_eq!(r.model, "gpt-6-luna-2026-09-01");
        assert_eq!(r.usage, Usage { input_tokens: 321, output_tokens: 0 });
        assert_eq!(r.refused, vec!["plain".to_string()]);
        assert_eq!(r.answers.len(), 3);
        assert_eq!(r.answers["urgent"], Answer::Noul { noul: 0.92 });
        match &r.answers["team"] {
            Answer::Choice { choice, confidence, probabilities } => {
                assert_eq!(choice, "technical");
                assert_eq!(*confidence, 0.6);
                // our option order, not the provider's
                assert_eq!(probabilities.keys().collect::<Vec<_>>(), vec!["billing", "technical", "sales"]);
                assert_eq!(probabilities["billing"], 0.15);
            }
            other => panic!("{other:?}"),
        }
        match &r.answers["severity"] {
            Answer::Score { score, legend, probabilities, .. } => {
                assert_eq!(*score, 1.1);
                assert_eq!(probabilities.iter().map(|(k, v)| (k.as_str(), *v)).collect::<Vec<_>>(), vec![("0", 0.1), ("1", 0.7), ("2", 0.2)]);
                assert_eq!(legend["2"], "Blocked");
            }
            other => panic!("{other:?}"),
        }

        // a refusal without a name covers every unanswered question
        let body = json!({"answers": [{"type": "predicate", "name": "urgent", "probability": 0.1}, {"type": "refusal"}]});
        let r = openai_response(body, &questions()).unwrap();
        assert_eq!(r.refused, vec!["team", "severity", "plain"]);
        assert_eq!(r.usage, Usage::default());
    }

    #[test]
    fn cloudflare_envelope() {
        let inner = json!({"model": "clef-flash", "answers": {"q": {"type": "noul", "noul": 0.3}}, "usage": {"input_tokens": 12, "output_tokens": 0}});
        let wrapped = json!({"result": inner, "success": true, "errors": [], "messages": []});
        let r = systemone_response(unwrap_cloudflare(wrapped).unwrap()).unwrap();
        assert_eq!(r.answers["q"], Answer::Noul { noul: 0.3 });
        assert_eq!(r.usage.input_tokens, 12);
        // unwrapped bodies pass through
        assert_eq!(unwrap_cloudflare(inner.clone()).unwrap(), inner);

        let failed = json!({"result": null, "success": false, "errors": [{"code": 5007, "message": "No such model"}], "messages": []});
        match unwrap_cloudflare(failed).unwrap_err() {
            Error::Api { code, message, .. } => {
                assert_eq!(code, "5007");
                assert_eq!(message, "Cloudflare: No such model");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn error_bodies() {
        assert_eq!(
            error_detail(r#"{"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}"#),
            (Some("Incorrect API key provided".into()), Some("invalid_api_key".into()))
        );
        assert_eq!(error_detail(r#"{"error":"model not found","code":"MODEL_NOT_FOUND"}"#).1.as_deref(), Some("MODEL_NOT_FOUND"));
        assert_eq!(
            error_detail(r#"{"detail":[{"loc":["body","state"],"msg":"Field required","type":"missing"}]}"#).0.as_deref(),
            Some("body.state: Field required")
        );
        assert_eq!(error_detail(r#"{"errors":[{"code":10000,"message":"Authentication error"}],"success":false}"#).1.as_deref(), Some("10000"));
        assert_eq!(error_detail("Bad Gateway").0.as_deref(), Some("Bad Gateway"));
        assert_eq!(error_detail(""), (None, None));

        let p = crate::providers::builtin_providers().remove(1);
        let e = api_error(&p, 401, r#"{"error":{"message":"Incorrect API key provided."}}"#);
        assert_eq!(e.code(), "UNAUTHORIZED");
        assert_eq!(e.to_string(), "OpenAI: Incorrect API key provided. Check the API key under Providers. (UNAUTHORIZED)");
    }

    #[test]
    fn api_roots() {
        assert_eq!(api_root("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api");
        assert_eq!(api_root("https://api.typesafe.ai"), "https://api.typesafe.ai");
    }
}
