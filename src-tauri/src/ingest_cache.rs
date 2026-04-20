//! Cache helpers for the ingest pipeline.
//!
//! Each book ingest writes intermediate results to
//! `<app_data_dir>/ingest-cache/<book-id>/` so an interrupted run resumes
//! from the last completed stage. The frontend drives the stages; this
//! module just handles filesystem read/write.

use std::fs;
use std::path::PathBuf;

use tauri::Manager;

fn cache_dir_for(app: &tauri::AppHandle, book_id: &str) -> anyhow::Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("app_data_dir: {e}"))?
        .join("ingest-cache")
        .join(book_id);
    fs::create_dir_all(&base)?;
    Ok(base)
}

/// Store `contents` at `<cache>/<book_id>/<key>`. Key may contain `/` to
/// denote subdirs (`"lessons/chapter-01/foo.json"`). Returns the absolute
/// path that was written.
#[tauri::command]
pub fn cache_write(
    app: tauri::AppHandle,
    book_id: String,
    key: String,
    contents: String,
) -> Result<String, String> {
    let dir = cache_dir_for(&app, &book_id).map_err(|e| e.to_string())?;
    let path = dir.join(&key);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Returns the cached value if present, or None. Callers use this at the
/// start of a stage: `let cached = cache_read(...); if cached.is_some() { skip }`.
#[tauri::command]
pub fn cache_read(
    app: tauri::AppHandle,
    book_id: String,
    key: String,
) -> Result<Option<String>, String> {
    let dir = cache_dir_for(&app, &book_id).map_err(|e| e.to_string())?;
    let path = dir.join(&key);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// Wipe the cache for a given book (or the entire cache if `book_id` is empty).
#[tauri::command]
pub fn cache_clear(app: tauri::AppHandle, book_id: String) -> Result<(), String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ingest-cache");
    let target = if book_id.is_empty() {
        base
    } else {
        base.join(&book_id)
    };
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    }
    Ok(())
}
