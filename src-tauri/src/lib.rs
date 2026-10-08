mod commands;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use classifai_core::engine::Engine;
use classifai_core::ollaya::Client;
use classifai_core::store::Store;
use tauri::Manager;

pub struct AppState {
    pub store: Arc<Store>,
    pub engine: Arc<Engine>,
    /// experiment id -> cancel flag of the running task
    pub running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    pub fn client(&self) -> Client {
        self.engine.client().clone()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let store = Store::open(&data_dir.join(classifai_core::DB_FILE))?;
            let host = std::env::var("OLLAYA_HOST").ok();
            let client = Client::new(match host.as_deref() {
                Some(h) if h.starts_with("http") => h.to_string(),
                Some(h) if !h.is_empty() => format!("http://{h}"),
                _ => classifai_core::ollaya::DEFAULT_BASE_URL.to_string(),
            });
            let engine = Engine::new(&data_dir, client);
            app.manage(AppState {
                store: Arc::new(store),
                engine: Arc::new(engine),
                running: Mutex::new(HashMap::new()),
            });

            // Start the engine in the background if it is installed but not running.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                if state.engine.find_binary().is_some() {
                    let _ = state.engine.start().await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::engine_status,
            commands::engine_install,
            commands::engine_start,
            commands::engine_stop,
            commands::models_installed,
            commands::models_catalog,
            commands::model_pull,
            commands::model_delete,
            commands::presets_list,
            commands::quick_classify,
            commands::dataset_import,
            commands::dataset_list,
            commands::dataset_get,
            commands::dataset_rows,
            commands::dataset_value_counts,
            commands::dataset_rename,
            commands::dataset_delete,
            commands::experiment_create,
            commands::experiment_start,
            commands::experiment_cancel,
            commands::experiment_list,
            commands::experiment_get,
            commands::experiment_report,
            commands::experiment_predictions,
            commands::experiment_delete,
            commands::experiment_export_csv,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                let engine = state.engine.clone();
                tauri::async_runtime::block_on(async move {
                    let _ = engine.stop().await;
                });
            }
        });
}
