//! User settings stored in <app_data_dir>/settings.json, mirrored in memory
//! as a tauri-managed state so command handlers (particularly the LLM ingest)
//! can read the API key without re-opening the file on every call.

use std::fs;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub anthropic_api_key: Option<String>,
}

pub struct SettingsState(pub Mutex<Settings>);

fn settings_path(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

/// Read settings.json from disk. Used once at setup to hydrate SettingsState.
pub fn read_from_disk(app: &tauri::AppHandle) -> anyhow::Result<Settings> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let raw = fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw)?)
}

#[tauri::command]
pub fn load_settings(state: State<'_, SettingsState>) -> Settings {
    state.0.lock().clone()
}

#[tauri::command]
pub fn save_settings(
    app: tauri::AppHandle,
    state: State<'_, SettingsState>,
    settings: Settings,
) -> Result<(), String> {
    let path = settings_path(&app).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    *state.0.lock() = settings;
    Ok(())
}
