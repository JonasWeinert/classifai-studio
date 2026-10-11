//! LLMs as decision models. The primitive questions become one JSON schema; the model fills it
//! through structured output and the answers are turned into the same types a decision model
//! returns, so the rest of the app treats an LLM like any other model.
//!
//! | Question | The LLM fills in | Answer |
//! |---|---|---|
//! | `choice` | `{probabilities: {option: p}}` | most likely option, normalized distribution |
//! | `score` | `{probabilities: {"0": p, …}}` (levels by index) | expected level, distribution |
//! | `noul` | `{probability_true: p}` | `noul = p` |
//! | `text` | `{answer: "…"}` | the text |
//!
//! Every question also gets `quote`: one verbatim passage of the input supporting the answer (or
//! ""), which the app finds in the input to show why.
//!
//! Probabilities are the model's own estimates ("verbalized"), not read from token
//! likelihoods, so they are usually less calibrated than a decision model's.
//!
//! | Kind | Request | Structured output |
//! |---|---|---|
//! | `chat` | `POST {base}/v1/chat/completions` (OpenAI-compatible) | `response_format: json_schema` (strict); servers that refuse it get `json_object` with the schema in the prompt |
//! | `anthropic` | `POST {base}/v1/messages` | a forced tool call whose input schema is the answer schema |

use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use crate::cloud::{self, Auth, CloudAnswers};
use crate::ollaya::{Answer, Question, Usage};
use crate::providers::{Provider, ProviderKind};
use crate::{Error, Result};

const MAX_TOKENS: u32 = 4096;

const SYSTEM: &str = "You classify texts. You get an input and questions about it. \
For a question with options, give every option a probability between 0 and 1 that it is the right answer; the probabilities of one question add up to 1. \
Be calibrated: put most of the weight on one option only when the input clearly supports it, and spread it when you are unsure. \
For a statement, give the probability that it is true of the input. For an open question, answer briefly in plain words. \
Judge only from the input, and follow each question's instructions and context. \
For every question also give `quote`: the one continuous passage of the input that best supports your answer, copied exactly (same words, same order, no ellipsis), as short as still makes the point — or an empty string when no passage does.";

pub(crate) async fn decide(
    http: &reqwest::Client,
    provider: &Provider,
    key: Option<&str>,
    model: &str,
    state: &Value,
    questions: &IndexMap<String, Question>,
) -> Result<CloudAnswers> {
    let base = provider
        .base_url()
        .ok_or_else(|| Error::invalid(format!("{} has no base URL; set one under Providers", provider.name)))?;
    let user = prompt(state, questions);
    let schema = schema(questions);
    let (output, usage, answered_by) = match provider.kind {
        ProviderKind::Anthropic => {
            let body = json!({
                "model": model,
                "max_tokens": MAX_TOKENS,
                "system": SYSTEM,
                "messages": [{ "role": "user", "content": user }],
                "tools": [{ "name": "answer", "description": "Submit the answers to every question.", "input_schema": schema }],
                "tool_choice": { "type": "tool", "name": "answer" },
            });
            let url = format!("{}/v1/messages", api_root(base));
            let v = parse_json(provider, &cloud::send(http, provider, &url, key, &body, Auth::Anthropic).await?)?;
            let input = v
                .get("content")
                .and_then(Value::as_array)
                .and_then(|c| c.iter().find(|b| b.get("type").and_then(Value::as_str) == Some("tool_use")))
                .and_then(|b| b.get("input"))
                .cloned()
                .unwrap_or(Value::Null);
            let usage = Usage { input_tokens: num(&v, &["usage", "input_tokens"]), output_tokens: num(&v, &["usage", "output_tokens"]) };
            (input, usage, str_at(&v, "model"))
        }
        _ => {
            let url = format!("{}/v1/chat/completions", api_root(base));
            let messages = |user: &str| json!([{ "role": "system", "content": SYSTEM }, { "role": "user", "content": user }]);
            let strict = json!({
                "model": model,
                "messages": messages(&user),
                "response_format": { "type": "json_schema", "json_schema": { "name": "answers", "strict": true, "schema": schema } },
            });
            let text = match cloud::send(http, provider, &url, key, &strict, Auth::Bearer).await {
                // Some OpenAI-compatible servers know only JSON mode: the schema goes into the prompt.
                Err(Error::Api { status: 400 | 422, .. }) => {
                    let loose = json!({
                        "model": model,
                        "messages": messages(&format!("{user}\n\nReply with one JSON object matching this JSON schema, and nothing else:\n{schema}")),
                        "response_format": { "type": "json_object" },
                    });
                    cloud::send(http, provider, &url, key, &loose, Auth::Bearer).await?
                }
                other => other?,
            };
            let v = parse_json(provider, &text)?;
            let message = v.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message")).cloned().unwrap_or(Value::Null);
            if message.get("refusal").and_then(Value::as_str).is_some_and(|r| !r.trim().is_empty()) {
                return Ok(CloudAnswers { model: str_at(&v, "model"), answers: IndexMap::new(), refused: questions.keys().cloned().collect(), usage: chat_usage(&v), quotes: IndexMap::new() });
            }
            let content = message.get("content").and_then(Value::as_str).unwrap_or_default();
            let output = parse_json(provider, strip_fences(content))?;
            (output, chat_usage(&v), str_at(&v, "model"))
        }
    };
    let (answers, refused) = answers(&output, questions);
    if answers.is_empty() && !questions.is_empty() {
        return Err(Error::Api {
            status: 200,
            code: "BAD_RESPONSE".into(),
            message: format!("{}: the model's reply had none of the answers (it may not support structured output)", provider.name),
        });
    }
    let quotes = quotes(&output, questions);
    Ok(CloudAnswers { model: answered_by, answers, refused, usage, quotes })
}

/// `https://x/v1` and `https://x` both mean the API root `https://x`.
fn api_root(base: &str) -> &str {
    let b = base.trim_end_matches('/');
    b.strip_suffix("/v1").unwrap_or(b)
}

fn parse_json(provider: &Provider, text: &str) -> Result<Value> {
    serde_json::from_str(text).map_err(|e| Error::Api {
        status: 200,
        code: "BAD_RESPONSE".into(),
        message: format!("{}: the reply is not valid JSON ({e})", provider.name),
    })
}

/// Models sometimes wrap JSON in a Markdown code fence.
fn strip_fences(s: &str) -> &str {
    let t = s.trim();
    let Some(rest) = t.strip_prefix("```") else { return t };
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_alphabetic());
    rest.strip_suffix("```").unwrap_or(rest).trim()
}

fn num(v: &Value, path: &[&str]) -> u64 {
    path.iter().try_fold(v, |v, k| v.get(k)).and_then(Value::as_u64).unwrap_or(0)
}

fn str_at(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn chat_usage(v: &Value) -> Usage {
    Usage { input_tokens: num(v, &["usage", "prompt_tokens"]), output_tokens: num(v, &["usage", "completion_tokens"]) }
}

/// The input and every question in words: instructions, options with their meaning, levels.
pub(crate) fn prompt(state: &Value, questions: &IndexMap<String, Question>) -> String {
    let input = match state {
        Value::String(s) => s.clone(),
        v => serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string()),
    };
    let mut out = format!("<input>\n{}\n</input>\n\nQuestions (answer each under its key):\n", input.trim());
    let text = |s: &Option<String>| s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    for (id, q) in questions {
        out.push_str(&format!("\n### {id}\n"));
        match q {
            Question::Choice { instructions, criteria } => {
                out.push_str(&text(instructions).unwrap_or_else(|| "Which option fits best?".into()));
                out.push_str("\nOptions (exactly one is right):\n");
                for (label, desc) in criteria {
                    match text(desc) {
                        Some(d) => out.push_str(&format!("- \"{label}\": {d}\n")),
                        None => out.push_str(&format!("- \"{label}\"\n")),
                    }
                }
            }
            Question::Score { instructions, criteria } => {
                out.push_str(&text(instructions).unwrap_or_else(|| "Which level fits best?".into()));
                out.push_str("\nLevels, from lowest to highest (give probabilities by level number):\n");
                for (i, level) in criteria.iter().enumerate() {
                    out.push_str(&format!("- \"{i}\": {level}\n"));
                }
            }
            Question::Noul { instructions, criteria } => {
                out.push_str("Statement — give the probability that it is true:\n");
                out.push_str(&text(instructions).unwrap_or_default());
                if let Some(c) = criteria {
                    if let Some(t) = text(&c.when_true) {
                        out.push_str(&format!("\nTrue means: {t}"));
                    }
                    if let Some(f) = text(&c.when_false) {
                        out.push_str(&format!("\nFalse means: {f}"));
                    }
                }
                out.push('\n');
            }
            Question::Text { instructions } => {
                out.push_str("Open question — answer in a few words or sentences:\n");
                out.push_str(&text(instructions).unwrap_or_default());
                out.push('\n');
            }
        }
    }
    out
}

fn probability_object(keys: impl Iterator<Item = String>) -> Value {
    let keys: Vec<String> = keys.collect();
    let props: Map<String, Value> = keys.iter().map(|k| (k.clone(), json!({ "type": "number" }))).collect();
    json!({
        "type": "object",
        "properties": {
            "probabilities": { "type": "object", "properties": props, "required": keys, "additionalProperties": false }
        },
        "required": ["probabilities"],
        "additionalProperties": false
    })
}

/// Adds the required `quote` string to a question's answer object.
fn with_quote(mut s: Value) -> Value {
    if let Some(p) = s.get_mut("properties").and_then(Value::as_object_mut) {
        p.insert("quote".into(), json!({ "type": "string" }));
    }
    if let Some(r) = s.get_mut("required").and_then(Value::as_array_mut) {
        r.push(json!("quote"));
    }
    s
}

/// The supporting passage the model quoted per question (non-empty ones only).
pub(crate) fn quotes(output: &Value, questions: &IndexMap<String, Question>) -> IndexMap<String, String> {
    questions
        .keys()
        .filter_map(|id| {
            let q = output.get(id)?.get("quote")?.as_str()?.trim().trim_matches(|c| c == '"' || c == '“' || c == '”').trim();
            (!q.is_empty()).then(|| (id.clone(), q.to_string()))
        })
        .collect()
}

/// One object with a property per question (see the table at the top).
pub(crate) fn schema(questions: &IndexMap<String, Question>) -> Value {
    let props: Map<String, Value> = questions
        .iter()
        .map(|(id, q)| {
            let s = match q {
                Question::Choice { criteria, .. } => probability_object(criteria.keys().cloned()),
                Question::Score { criteria, .. } => probability_object((0..criteria.len()).map(|i| i.to_string())),
                Question::Noul { .. } => json!({
                    "type": "object",
                    "properties": { "probability_true": { "type": "number" } },
                    "required": ["probability_true"],
                    "additionalProperties": false
                }),
                Question::Text { .. } => json!({
                    "type": "object",
                    "properties": { "answer": { "type": "string" } },
                    "required": ["answer"],
                    "additionalProperties": false
                }),
            };
            (id.clone(), with_quote(s))
        })
        .collect();
    json!({ "type": "object", "properties": props, "required": questions.keys().collect::<Vec<_>>(), "additionalProperties": false })
}

/// A non-negative number, also when sent as a string or a percentage ("70%"). Used as a weight:
/// a question's values are normalized together, so 70/30 and 0.7/0.3 mean the same.
fn as_weight(v: &Value) -> Option<f64> {
    let x = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => {
            let t = s.trim();
            match t.strip_suffix('%') {
                Some(p) => p.trim().parse::<f64>().ok()? / 100.0,
                None => t.parse().ok()?,
            }
        }
        _ => return None,
    };
    x.is_finite().then(|| x.max(0.0))
}

/// A single probability: 0–1, or 0–100 read as a percentage.
fn as_prob(v: &Value) -> Option<f64> {
    let x = as_weight(v)?;
    Some(if x > 1.0 && x <= 100.0 { x / 100.0 } else { x.min(1.0) })
}

/// Probabilities over `keys` from a question's output, normalized to sum to 1 (uniform when the
/// model gave nothing usable). A bare answer ("billing") counts as certainty for that option.
fn distribution(out: &Value, keys: &[String]) -> Option<IndexMap<String, f64>> {
    let probs = out.get("probabilities").or_else(|| out.get("probs"));
    let mut d: IndexMap<String, f64> = match probs {
        Some(Value::Object(o)) => {
            let find = |k: &str| o.get(k).or_else(|| o.iter().find(|(x, _)| x.trim().eq_ignore_ascii_case(k)).map(|(_, v)| v));
            keys.iter().map(|k| (k.clone(), find(k).and_then(as_weight).unwrap_or(0.0))).collect()
        }
        _ => {
            let pick = [out.get("answer"), out.get("choice"), out.get("level"), Some(out)]
                .into_iter()
                .flatten()
                .find_map(|v| v.as_str().map(str::to_string).or_else(|| v.as_u64().map(|n| n.to_string())))?;
            keys.iter().map(|k| (k.clone(), if k.trim().eq_ignore_ascii_case(pick.trim()) { 1.0 } else { 0.0 })).collect()
        }
    };
    let sum: f64 = d.values().sum();
    if sum <= 0.0 {
        let u = 1.0 / keys.len().max(1) as f64;
        d.values_mut().for_each(|p| *p = u);
    } else {
        d.values_mut().for_each(|p| *p /= sum);
    }
    Some(d)
}

/// (K·p_max − 1)/(K − 1): 0 for a uniform distribution, 1 for a certain one.
fn normalized_confidence(d: &IndexMap<String, f64>) -> f64 {
    let k = d.len() as f64;
    let top = d.values().copied().fold(0.0, f64::max);
    if k < 2.0 { 1.0 } else { ((k * top - 1.0) / (k - 1.0)).clamp(0.0, 1.0) }
}

/// The model's output turned into answers; questions it left out are reported as refused.
pub(crate) fn answers(output: &Value, questions: &IndexMap<String, Question>) -> (IndexMap<String, Answer>, Vec<String>) {
    let mut answers = IndexMap::new();
    let mut refused = Vec::new();
    for (id, q) in questions {
        let Some(out) = output.get(id) else {
            refused.push(id.clone());
            continue;
        };
        let answer = match q {
            Question::Choice { criteria, .. } => {
                let keys: Vec<String> = criteria.keys().cloned().collect();
                distribution(out, &keys).map(|d| {
                    let choice = d.iter().fold((String::new(), -1.0), |b, (k, &p)| if p > b.1 { (k.clone(), p) } else { b }).0;
                    Answer::Choice { choice, confidence: normalized_confidence(&d), probabilities: d }
                })
            }
            Question::Score { criteria, .. } => {
                let keys: Vec<String> = (0..criteria.len()).map(|i| i.to_string()).collect();
                distribution(out, &keys).map(|d| Answer::Score {
                    score: d.iter().map(|(k, p)| k.parse::<f64>().unwrap_or(0.0) * p).sum(),
                    confidence: normalized_confidence(&d),
                    legend: criteria.iter().enumerate().map(|(i, c)| (i.to_string(), c.clone())).collect(),
                    probabilities: d,
                })
            }
            Question::Noul { .. } => {
                let p = out.get("probability_true").or_else(|| out.get("probability")).or(Some(out)).and_then(as_prob);
                let p = p.or_else(|| match out.get("answer").and_then(Value::as_bool).or_else(|| out.as_bool()) {
                    Some(b) => Some(if b { 1.0 } else { 0.0 }),
                    None => None,
                });
                p.map(|noul| Answer::Noul { noul })
            }
            Question::Text { .. } => {
                let t = out.get("answer").and_then(Value::as_str).or_else(|| out.as_str()).map(str::trim).filter(|t| !t.is_empty());
                t.map(|text| Answer::Text { text: text.into() })
            }
        };
        match answer {
            Some(a) => {
                answers.insert(id.clone(), a);
            }
            None => refused.push(id.clone()),
        }
    }
    (answers, refused)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ollaya::NoulCriteria;

    fn qs() -> IndexMap<String, Question> {
        let mut q = IndexMap::new();
        q.insert("team".into(), Question::Choice { instructions: Some("Which team?".into()), criteria: [("billing".to_string(), Some("Payments".into())), ("tech".to_string(), None)].into_iter().collect() });
        q.insert("mood".into(), Question::Score { instructions: None, criteria: vec!["calm".into(), "angry".into()] });
        q.insert("refund".into(), Question::Noul { instructions: Some("Asks for a refund.".into()), criteria: Some(NoulCriteria { when_true: Some("explicitly".into()), when_false: None }) });
        q.insert("summary".into(), Question::Text { instructions: Some("Summarise.".into()) });
        q
    }

    #[test]
    fn schema_has_a_property_per_question() {
        let s = schema(&qs());
        assert_eq!(s["required"], json!(["team", "mood", "refund", "summary"]));
        assert_eq!(s["properties"]["team"]["properties"]["probabilities"]["required"], json!(["billing", "tech"]));
        assert_eq!(s["properties"]["mood"]["properties"]["probabilities"]["required"], json!(["0", "1"]));
        assert!(s["properties"]["refund"]["properties"]["probability_true"].is_object());
        assert_eq!(s["properties"]["refund"]["required"], json!(["probability_true", "quote"]));
        let qt = quotes(&json!({ "team": { "quote": " “charged twice” " }, "mood": { "quote": "" } }), &qs());
        assert_eq!(qt.len(), 1);
        assert_eq!(qt["team"], "charged twice");
        let p = prompt(&Value::String("I was charged twice".into()), &qs());
        assert!(p.contains("<input>\nI was charged twice\n</input>") && p.contains("- \"billing\": Payments") && p.contains("True means: explicitly") && p.contains("- \"1\": angry"));
    }

    #[test]
    fn answers_are_normalized_and_lenient() {
        let out = json!({
            "team": { "probabilities": { "billing": 3, "Tech": 1 } },
            "mood": { "probabilities": { "0": "20%", "1": 0.8 } },
            "refund": { "probability_true": 90 },
            "summary": { "answer": " Double charge. " }
        });
        let (a, refused) = answers(&out, &qs());
        assert!(refused.is_empty());
        match &a["team"] {
            Answer::Choice { choice, probabilities, confidence } => {
                assert_eq!(choice, "billing");
                // weights, normalized
                assert!((probabilities["billing"] - 0.75).abs() < 1e-9 && (probabilities["tech"] - 0.25).abs() < 1e-9);
                assert!((confidence - 0.5).abs() < 1e-9);
            }
            other => panic!("{other:?}"),
        }
        match &a["mood"] {
            Answer::Score { score, legend, .. } => assert!((score - 0.8).abs() < 1e-9 && legend["1"] == "angry"),
            other => panic!("{other:?}"),
        }
        assert_eq!(a["refund"], Answer::Noul { noul: 0.9 });
        assert_eq!(a["summary"], Answer::Text { text: "Double charge.".into() });

        // a bare answer counts as certain; a missing question is refused
        let (a, refused) = answers(&json!({ "team": { "answer": "tech" } }), &qs());
        assert!(matches!(&a["team"], Answer::Choice { choice, .. } if choice == "tech"));
        assert_eq!(refused, vec!["mood", "refund", "summary"]);
        assert_eq!(strip_fences("```json\n{\"a\":1}\n```"), "{\"a\":1}");
    }
}
