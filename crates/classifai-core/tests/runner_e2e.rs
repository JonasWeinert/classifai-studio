//! End-to-end: import a dataset, run an experiment against an Ollaya-compatible server, score it.
//!
//! Needs a server, so it is ignored by default. Against the bundled fake:
//!
//!     python3 scripts/fake_ollaya.py 11999 &
//!     CLASSIFAI_TEST_OLLAYA=http://127.0.0.1:11999 cargo test -p classifai-core -- --include-ignored
//!
//! Against a real Ollaya with `laya` pulled, point the variable at http://127.0.0.1:11435.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use classifai_core::dataset::parse_delimited;
use classifai_core::decider::Decider;
use classifai_core::eval;
use classifai_core::ollaya::Client;
use classifai_core::runner;
use classifai_core::secrets::MemorySecrets;
use classifai_core::store::{ExperimentConfig, ExperimentStatus, Store};
use classifai_core::task::{LabelSpec, TaskKind, TaskSpec};

#[tokio::test]
#[ignore]
async fn experiment_runs_and_scores() {
    let client = Client::new(base_url());
    assert!(client.is_alive().await, "no Ollaya-compatible server reachable");

    let store = Arc::new(Store::open_in_memory().unwrap());
    let decider = Arc::new(Decider::new(client, store.clone(), Arc::new(MemorySecrets::new())));
    // Two questions: `team` (choice) and `refund` (binary). Some rows only have one ground truth.
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
    let config = ExperimentConfig {
        name: "e2e".into(),
        dataset_id: d.id,
        input_columns: vec!["text".into()],
        context: Some("Support tickets of an online shop.".into()),
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
            },
            TaskSpec {
                id: "refund".into(),
                kind: TaskKind::Binary,
                instructions: "The customer asks for money back.".into(),
                context: Some("Vouchers do not count.".into()),
                label_column: "refund".into(),
                labels: labels(&["yes", "no"]),
                positive_label: Some("yes".into()),
                threshold: None,
            },
        ],
        models: vec!["laya".into(), "missing-model".into()],
        sample_size: None,
        concurrency: Some(2),
    };
    let id = runner::create(&store, &config).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev2 = events.clone();
    let status = runner::execute(store.clone(), decider.clone(), id.clone(), Arc::new(AtomicBool::new(false)), move |e| {
        ev2.lock().unwrap().push(e)
    })
    .await
    .unwrap();

    assert_eq!(status, ExperimentStatus::Completed);
    let exp = store.get_experiment(&id).unwrap();
    assert_eq!(exp.row_indices, vec![0, 1, 2, 3, 4, 6], "the row without any ground truth is excluded");
    assert_eq!(exp.progress["laya"], 6);
    assert_eq!(exp.progress["missing-model"], 6);
    // 5 team + 5 refund ground truths, for each of 2 models
    assert_eq!(store.predictions(&id).unwrap().len(), 20);
    {
        let events = events.lock().unwrap();
        assert!(events.iter().any(|e| e.status == ExperimentStatus::Completed));
        assert!(events.iter().filter(|e| e.model.is_some()).all(|e| e.total == 6 && e.done <= 6));
    }

    for task in &config.tasks {
        let preds = store.predictions_for(&id, &task.id).unwrap();
        assert_eq!(preds.len(), 10, "{}", task.id);
        let report = eval::report(&task.id, &task.label_values(), &config.models, &preds);
        assert_eq!(report.question_id, task.id);
        let laya = &report.models[0];
        assert_eq!(laya.errors, 0);
        assert!(laya.accuracy > 0.5, "{} accuracy {}", task.id, laya.accuracy);
        let missing = &report.models[1];
        assert_eq!(missing.errors, 5, "an unknown model fails every row, not the experiment");
        println!("{}: laya accuracy {:.3} macro-F1 {:.3}", task.id, laya.accuracy, laya.macro_f1);
    }
    let refund = store.predictions_for(&id, "refund").unwrap();
    assert!(refund.iter().filter(|p| p.model == "laya").all(|p| p.predicted.as_deref() == Some(p.ground_truth.as_str())));

    // resuming a finished experiment asks nothing again
    let again = runner::execute(store.clone(), decider, id.clone(), Arc::new(AtomicBool::new(false)), |_| {})
        .await
        .unwrap();
    assert_eq!(again, ExperimentStatus::Completed);
    assert_eq!(store.predictions(&id).unwrap().len(), 20);

    // a human correction changes the report without re-running; the review queue and the
    // written report see it too
    let e = store.get_experiment(&id).unwrap();
    let team = e.config.task("team").unwrap();
    let before = classifai_core::analysis::report(&store, &e, team).unwrap();
    store.set_label_correction(&e.dataset_id, 1, "label", "account", Some("misfiled")).unwrap();
    let after = classifai_core::analysis::report(&store, &e, team).unwrap();
    assert_eq!(after.reviewed_rows, 1);
    assert!(after.models[0].accuracy < before.models[0].accuracy, "laya answered technical for row 1");
    let queue = classifai_core::analysis::review_queue(&store, &e, team, "wrong", 0, 10, None).unwrap();
    assert_eq!(queue.rows.last().map(|r| (r.row_idx, r.corrected)), Some((1, true)));
    let md = classifai_core::export::render_report(&store, &id, classifai_core::export::Format::Markdown).unwrap();
    assert!(md.contains("1 row was manually adjudicated (1 corrected, 0 confirmed)"), "{md}");
}

fn base_url() -> String {
    std::env::var("CLASSIFAI_TEST_OLLAYA").unwrap_or_else(|_| "http://127.0.0.1:11999".into())
}
