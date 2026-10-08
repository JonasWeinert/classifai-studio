//! End-to-end: import a dataset, run an experiment against an Ollaya-compatible server, score it.
//!
//! Needs a server, so it is ignored by default. Against the bundled fake:
//!
//!     python3 scripts/fake_ollaya.py 11999 &
//!     CLASSIFAI_TEST_OLLAYA=http://127.0.0.1:11999 cargo test -p classifai-core -- --ignored
//!
//! Against a real Ollaya with `laya` pulled, point the variable at http://127.0.0.1:11435.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use classifai_core::dataset::parse_delimited;
use classifai_core::eval;
use classifai_core::ollaya::Client;
use classifai_core::runner;
use classifai_core::store::{ExperimentConfig, ExperimentStatus, Store};
use classifai_core::task::{LabelSpec, TaskKind, TaskSpec};

#[tokio::test]
#[ignore]
async fn experiment_runs_and_scores() {
    let base = std::env::var("CLASSIFAI_TEST_OLLAYA").unwrap_or_else(|_| "http://127.0.0.1:11999".into());
    let client = Client::new(base);
    assert!(client.is_alive().await, "no Ollaya-compatible server reachable");

    let store = Arc::new(Store::open_in_memory().unwrap());
    let csv = "text,label\n\
        Please refund the billing error,billing\n\
        The app shows a technical error,technical\n\
        I cannot log into my account,account\n\
        Billing charged me twice,billing\n\
        My account password reset fails,account\n\
        Weird,???\n";
    let d = store.insert_dataset("tickets", None, &parse_delimited(csv, b',').unwrap()).unwrap();

    let config = ExperimentConfig {
        name: "e2e".into(),
        dataset_id: d.id,
        task: TaskSpec {
            kind: TaskKind::Choice,
            instructions: "Which team should handle this?".into(),
            input_columns: vec!["text".into()],
            label_column: "label".into(),
            labels: ["billing", "technical", "account"]
                .into_iter()
                .map(|v| LabelSpec { value: v.into(), description: None })
                .collect(),
            positive_label: None,
            threshold: None,
        },
        models: vec!["laya".into(), "missing-model".into()],
        sample_size: None,
        concurrency: Some(2),
    };
    let id = runner::create(&store, &config).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev2 = events.clone();
    let status = runner::execute(store.clone(), client, id.clone(), Arc::new(AtomicBool::new(false)), move |e| {
        ev2.lock().unwrap().push(e)
    })
    .await
    .unwrap();

    assert_eq!(status, ExperimentStatus::Completed);
    let exp = store.get_experiment(&id).unwrap();
    assert_eq!(exp.row_indices.len(), 5, "the ??? row is excluded");
    let preds = store.predictions(&id).unwrap();
    assert_eq!(preds.len(), 10);

    let report = eval::report(&config.task.label_values(), &config.models, &preds);
    let laya = &report.models[0];
    assert_eq!(laya.errors, 0);
    assert!(laya.accuracy > 0.5, "accuracy {}", laya.accuracy);
    let missing = &report.models[1];
    assert_eq!(missing.errors, 5, "an unknown model fails every row, not the experiment");
    assert!(events.lock().unwrap().iter().any(|e| e.status == ExperimentStatus::Completed));
    println!("laya accuracy {:.3} macro-F1 {:.3}", laya.accuracy, laya.macro_f1);
}
