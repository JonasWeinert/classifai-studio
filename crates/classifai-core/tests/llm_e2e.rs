//! End-to-end: LLM providers (an OpenAI-compatible chat endpoint and Anthropic) answering typed
//! questions through structured output, against the bundled fake server.
//!
//!     python3 scripts/fake_ollaya.py 11999 &
//!     CLASSIFAI_TEST_OLLAYA=http://127.0.0.1:11999 cargo test -p classifai-core -- --include-ignored

use std::sync::Arc;

use classifai_core::decider::{Decider, UsageContext};
use classifai_core::ollaya::{Answer, Client, NoulCriteria, Question};
use classifai_core::providers::{CloudModelInput, ProviderInput, ProviderKind};
use classifai_core::secrets::MemorySecrets;
use classifai_core::store::Store;
use indexmap::IndexMap;
use serde_json::Value;

fn questions() -> IndexMap<String, Question> {
    let mut q = IndexMap::new();
    q.insert("team".into(), Question::Choice { instructions: Some("Which team?".into()), criteria: [("billing".to_string(), None), ("technical".to_string(), Some("Bugs".into()))].into_iter().collect() });
    q.insert("mood".into(), Question::Score { instructions: None, criteria: vec!["calm".into(), "angry".into(), "furious".into()] });
    q.insert("spam".into(), Question::Noul { instructions: Some("This is spam.".into()), criteria: Some(NoulCriteria::default()) });
    q.insert("summary".into(), Question::Text { instructions: Some("Summarise in one sentence.".into()) });
    q
}

#[tokio::test]
#[ignore]
async fn llms_answer_through_structured_output() {
    let base = std::env::var("CLASSIFAI_TEST_OLLAYA").unwrap_or_else(|_| "http://127.0.0.1:11999".into());
    let client = Client::new(&base);
    assert!(client.is_alive().await, "no fake server reachable at {base}");
    let store = Arc::new(Store::open_in_memory().unwrap());
    let decider = Decider::new(client, store.clone(), Arc::new(MemorySecrets::new()));

    // A chat provider without a key (like a local Ollama), with a strict and a JSON-mode-only model.
    let chat = decider
        .save_provider(ProviderInput { id: None, kind: ProviderKind::Chat, name: "Local LLM".into(), base_url: Some(format!("{base}/v1")), account_id: None, api_key: None })
        .unwrap();
    assert_eq!(chat.provider.kind, ProviderKind::Chat);
    for m in ["fake-llm", "json-only"] {
        decider
            .save_cloud_model(CloudModelInput { provider_id: chat.provider.id.clone(), model: m.into(), display_name: None, input_price_per_mtok: 1.0, output_price_per_mtok: 2.0, enabled: true })
            .unwrap();
    }
    // Anthropic, pointed at the fake server, with a key.
    decider
        .save_provider(ProviderInput { id: Some("anthropic".into()), kind: ProviderKind::Anthropic, name: "Anthropic".into(), base_url: Some(base.clone()), account_id: None, api_key: Some("sk-ant-fake-0001".into()) })
        .unwrap();

    let input = Value::String("Win a free billing voucher!".into());
    for model in [format!("@{}/fake-llm", chat.provider.id), format!("@{}/json-only", chat.provider.id), "@anthropic/claude-haiku-4-5-20251001".into()] {
        let d = decider.decide(&model, input.clone(), questions(), &UsageContext::test()).await.unwrap_or_else(|e| panic!("{model}: {e}"));
        assert!(d.refused.is_empty(), "{model}: {:?}", d.refused);
        match &d.answers["team"] {
            Answer::Choice { choice, probabilities, .. } => {
                assert_eq!(choice, "billing", "{model}");
                assert!((probabilities.values().sum::<f64>() - 1.0).abs() < 1e-9);
            }
            other => panic!("{model}: {other:?}"),
        }
        assert!(matches!(&d.answers["mood"], Answer::Score { legend, .. } if legend.len() == 3), "{model}");
        assert_eq!(d.answers["spam"], Answer::Noul { noul: 0.9 }, "{model}");
        assert_eq!(d.answers["summary"], Answer::Text { text: "Fake answer.".into() }, "{model}");
        assert!(d.usage.output_tokens > 0 && d.cost_usd > 0.0, "{model}: output tokens are billed");
        assert_eq!(d.quotes.get("team").map(String::as_str), Some("Win  a  free"), "{model}: quotes come back");
    }

    // Model lists, to pick from instead of typing a name.
    let listed = decider.provider_models(&chat.provider.id).await.unwrap();
    assert_eq!(listed.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["fake-llm", "json-only"]);
    assert_eq!((listed[0].input_price_per_mtok, listed[0].structured_output), (Some(1.0), Some(true)));
    let claude = decider.provider_models("anthropic").await.unwrap();
    assert_eq!(claude[0].name, "Claude Haiku 4.5");

    // The connection test works for LLM providers too.
    let t = decider.test_provider(&chat.provider.id).await.unwrap();
    assert!(t.ok, "{}", t.message);
    // Decision models refuse free text with a clear message.
    let mut text_only = IndexMap::new();
    text_only.insert("summary".to_string(), Question::Text { instructions: None });
    let err = decider.decide("laya", input, text_only, &UsageContext::test()).await.unwrap_err();
    assert!(err.to_string().contains("free-text"), "{err}");
}
