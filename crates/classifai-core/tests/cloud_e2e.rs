//! End-to-end: one experiment over a local model and three cloud providers (custom, OpenAI,
//! Cloudflare), all pointed at the bundled fake server, then usage and cost from the log.
//!
//!     python3 scripts/fake_ollaya.py 11999 &
//!     CLASSIFAI_TEST_OLLAYA=http://127.0.0.1:11999 cargo test -p classifai-core -- --include-ignored

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use classifai_core::dataset::parse_delimited;
use classifai_core::decider::{Decider, UsageContext};
use classifai_core::eval;
use classifai_core::ollaya::{Answer, Client, Question};
use classifai_core::providers::{CloudModelInput, ProviderInput, ProviderKind};
use classifai_core::runner;
use classifai_core::secrets::{MemorySecrets, SecretStore};
use classifai_core::store::{AppSettings, ExperimentConfig, ExperimentStatus, Store};
use classifai_core::task::{LabelSpec, TaskKind, TaskSpec};
use indexmap::IndexMap;

#[tokio::test]
#[ignore]
async fn experiment_across_local_and_cloud_models() {
    let base = std::env::var("CLASSIFAI_TEST_OLLAYA").unwrap_or_else(|_| "http://127.0.0.1:11999".into());
    let client = Client::new(&base);
    assert!(client.is_alive().await, "no fake server reachable at {base}");

    let store = Arc::new(Store::open_in_memory().unwrap());
    let secrets = Arc::new(MemorySecrets::new());
    let decider = Arc::new(Decider::new(client, store.clone(), secrets.clone()));

    // Point the built-in providers at the fake server; keys go to the (in-memory) secret store.
    let save = |id: Option<&str>, kind, name: &str, account: Option<&str>, key: Option<&str>| {
        decider
            .save_provider(ProviderInput {
                id: id.map(Into::into),
                kind,
                name: name.into(),
                base_url: Some(base.clone()),
                account_id: account.map(Into::into),
                api_key: key.map(Into::into),
            })
            .unwrap()
    };
    save(Some("openai"), ProviderKind::Openai, "OpenAI", None, Some("sk-fake-openai-0001"));
    save(Some("cloudflare"), ProviderKind::Cloudflare, "Cloudflare", Some("acct123"), Some("cf-fake-token-0002"));
    let custom = save(None, ProviderKind::Custom, "Custom", None, None);
    assert_eq!(custom.provider.id, "custom");
    assert!(!custom.provider.has_key, "a custom endpoint may go without a key");
    assert_eq!(secrets.get("openai").unwrap().as_deref(), Some("sk-fake-openai-0001"));
    decider
        .save_cloud_model(CloudModelInput {
            provider_id: "custom".into(),
            model: "jev-latest".into(),
            display_name: Some("Jev via custom".into()),
            input_price_per_mtok: 1.0,
            output_price_per_mtok: 0.5,
            enabled: true,
        })
        .unwrap();

    let test = decider.test_provider("openai").await.unwrap();
    assert!(test.ok, "{}", test.message);

    let csv = "text,label,refund\n\
        Please refund the billing error so I win my money back,billing,yes\n\
        The app shows a technical error,technical,no\n\
        I cannot log into my account,account,no\n\
        Billing charged me twice,billing,\n\
        My account password reset fails,account,no\n\
        Weird,???,\n\
        Win a prize,???,yes\n";
    let d = store.insert_dataset("tickets", None, &parse_delimited(csv, b',').unwrap()).unwrap();
    let labels = |vs: &[&str]| vs.iter().map(|v| LabelSpec { value: v.to_string(), description: None, aliases: vec![] }).collect();
    let models = ["laya", "@custom/jev-latest", "@openai/gpt-6-luna", "@cloudflare/clef-flash", "@typesafe/jev-latest"];
    let config = ExperimentConfig {
        name: "cloud e2e".into(),
        dataset_id: d.id,
        input_columns: vec!["text".into()],
        context: None,
        tasks: vec![
            TaskSpec {
                id: "team".into(),
                kind: TaskKind::Choice,
                instructions: "Which team should handle this?".into(),
                context: None,
                label_column: "label".into(),
                labels: labels(&["billing", "technical", "account"]),
                positive_label: None,
                threshold: None,
                when: None,
            },
            TaskSpec {
                id: "refund".into(),
                kind: TaskKind::Binary,
                instructions: "The customer asks for money back.".into(),
                context: None,
                label_column: "refund".into(),
                labels: labels(&["yes", "no"]),
                positive_label: Some("yes".into()),
                threshold: None,
                when: None,
            },
        ],
        models: models.iter().map(|m| m.to_string()).collect(),
        sample_size: None,
        concurrency: Some(2),
    };
    let id = runner::create(&store, &config).unwrap();
    let status = runner::execute(store.clone(), decider.clone(), id.clone(), Arc::new(AtomicBool::new(false)), |_| {})
        .await
        .unwrap();
    assert_eq!(status, ExperimentStatus::Completed);

    for task in &config.tasks {
        let preds = store.predictions_for(&id, &task.id).unwrap();
        let report = eval::report(&task.id, &task.label_values(), &config.models, &preds);
        for m in &report.models[..4] {
            assert_eq!(m.errors, 0, "{} / {}", task.id, m.model);
            assert!(m.accuracy > 0.5, "{} / {} accuracy {}", task.id, m.model, m.accuracy);
        }
        // TypeSafe has no key: every row fails up front, the experiment does not
        assert_eq!(report.models[4].errors, 5, "{}", task.id);
    }
    let typesafe = store.predictions_for(&id, "team").unwrap();
    let err = typesafe.iter().find(|p| p.model == "@typesafe/jev-latest").unwrap().error.clone().unwrap();
    assert!(err.contains("no API key"), "{err}");
    // every model answers the binary question the same way
    let refund = store.predictions_for(&id, "refund").unwrap();
    for p in refund.iter().filter(|p| p.model != "@typesafe/jev-latest") {
        assert_eq!(p.predicted.as_deref(), Some(p.ground_truth.as_str()), "{} row {}", p.model, p.row_idx);
    }

    // 6 rows per model, 10 input tokens each; cost from the model's prices
    let usage = store.experiment_usage(&id).unwrap();
    let row = |m: &str| usage.iter().find(|r| r.model == m).unwrap_or_else(|| panic!("no usage for {m}"));
    for m in &models[..4] {
        assert_eq!(row(m).requests, 6, "{m}");
        assert_eq!(row(m).input_tokens, 60, "{m}");
    }
    assert!(usage.iter().all(|r| r.model != "@typesafe/jev-latest"));
    assert_eq!(row("laya").cost_usd, 0.0);
    let close = |a: f64, b: f64| (a - b).abs() < 1e-12;
    assert!(close(row("@custom/jev-latest").cost_usd, 60.0 * 1.0 / 1e6));
    assert!(close(row("@openai/gpt-6-luna").cost_usd, 60.0 * 0.10 / 1e6));
    assert!(close(row("@cloudflare/clef-flash").cost_usd, 60.0 * 0.09 / 1e6));
    assert_eq!(usage[0].model, "@custom/jev-latest", "most expensive first");
    // the provider test is logged too, but not against the experiment
    let all = store.usage_summary(None).unwrap();
    assert_eq!(all.iter().find(|r| r.model == "@openai/gpt-6-luna").unwrap().requests, 7);

    // refusals come back per question
    let mut questions = IndexMap::new();
    questions.insert("ok".to_string(), Question::Noul { instructions: Some("Mentions a prize.".into()), criteria: None });
    questions.insert("no".to_string(), Question::Noul { instructions: Some("[refuse] Anything.".into()), criteria: None });
    let dec = decider
        .decide("@openai/gpt-6-luna", "Win a prize".into(), questions, &UsageContext::quick())
        .await
        .unwrap();
    assert_eq!(dec.refused, vec!["no"]);
    assert!(matches!(dec.answers["ok"], Answer::Noul { noul } if noul > 0.5));
    assert_eq!(dec.usage.input_tokens, 10);

    // a wrong Cloudflare model surfaces the envelope's error
    decider
        .save_cloud_model(CloudModelInput {
            provider_id: "cloudflare".into(),
            model: "clef-pro".into(),
            display_name: None,
            input_price_per_mtok: 0.0,
            output_price_per_mtok: 0.0,
            enabled: true,
        })
        .unwrap();
    let mut q = IndexMap::new();
    q.insert("x".to_string(), Question::Noul { instructions: Some("?".into()), criteria: None });
    let err = decider.decide("@cloudflare/clef-pro", "hi".into(), q, &UsageContext::quick()).await.unwrap_err();
    assert!(err.to_string().contains("No such model"), "{err}");

    // the estimate prices the cloud models from their stored prices
    let est = classifai_core::analysis::estimate(&store, &config).unwrap();
    assert_eq!(est.rows, 6);
    assert_eq!(est.per_model[0].est_cost_usd, 0.0, "local models are free");
    assert!(est.per_model[1].est_cost_usd > 0.0);

    // with the monthly budget used up and the hard stop on, cloud models are refused without a
    // request while the local model still runs
    let spent = store.budget_status().unwrap().month_spend_usd;
    assert!(spent > 0.0);
    store.save_settings(&AppSettings { monthly_budget_usd: Some(spent / 2.0), budget_hard_stop: true }).unwrap();
    let requests_before: u64 = store.usage_summary(None).unwrap().iter().map(|r| r.requests).sum();
    let config2 = ExperimentConfig { name: "over budget".into(), models: vec!["laya".into(), "@openai/gpt-6-luna".into()], ..config.clone() };
    let id2 = runner::create(&store, &config2).unwrap();
    let status = runner::execute(store.clone(), decider.clone(), id2.clone(), Arc::new(AtomicBool::new(false)), |_| {})
        .await
        .unwrap();
    assert_eq!(status, ExperimentStatus::Completed);
    let preds = store.predictions_for(&id2, "team").unwrap();
    assert!(preds.iter().filter(|p| p.model == "laya").all(|p| p.error.is_none()));
    let cloud: Vec<_> = preds.iter().filter(|p| p.model == "@openai/gpt-6-luna").collect();
    assert_eq!(cloud.len(), 5);
    assert!(cloud.iter().all(|p| p.error.as_deref().is_some_and(|e| e.contains("BUDGET_EXCEEDED"))), "{:?}", cloud[0].error);
    let requests_after: u64 = store.usage_summary(None).unwrap().iter().map(|r| r.requests).sum();
    assert_eq!(requests_after - requests_before, 6, "only the local model's 6 requests were sent");
}
