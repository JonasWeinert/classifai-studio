//! ClassifAI core: everything the desktop app and the CLI share.
//!
//! - [`ollaya`]: typed HTTP client for the Ollaya daemon (`/api/decide`, `/api/pull`, ...)
//! - [`engine`]: locate, install, start and stop the Ollaya binary
//! - [`dataset`]: parse CSV / TSV / JSON / JSONL files into rows
//! - [`store`]: SQLite persistence for datasets, experiments and predictions
//! - [`task`]: turn a dataset row + ground-truth mapping into an Ollaya question
//! - [`runner`]: execute an experiment (rows x models) with progress and cancellation
//! - [`eval`]: accuracy, F1, confusion matrices, calibration, latency
//! - [`catalog`]: curated list of decision models offered in the UI

pub mod catalog;
pub mod dataset;
pub mod engine;
pub mod error;
pub mod eval;
pub mod ollaya;
pub mod runner;
pub mod store;
pub mod task;

pub use error::{Error, Result};

/// Bundle identifier; the app data directory is `<platform data dir>/<APP_ID>`, as Tauri's
/// `app_data_dir()` resolves it, so the desktop app and the CLI share one database and engine.
pub const APP_ID: &str = "dev.classifai.app";

pub fn default_data_dir() -> std::path::PathBuf {
    dirs::data_dir().unwrap_or_else(|| std::path::PathBuf::from(".")).join(APP_ID)
}

pub const DB_FILE: &str = "classifai.db";

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
