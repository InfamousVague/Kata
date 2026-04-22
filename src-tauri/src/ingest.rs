//! In-app PDF ingest plumbing.
//!
//! The frontend picks a file via the Tauri dialog plugin, then calls
//! `extract_pdf_text(path)` which shells out to the system `pdftotext`
//! (poppler-utils). We return the raw text; the frontend (TypeScript)
//! handles chapter / section splitting using the same logic as the standalone
//! ingest CLI. This keeps the parsing code in one language.
//!
//! If `pdftotext` isn't installed we return a clear error so the UI can
//! show a one-click-install hint.

use std::process::Command;
use tauri::Manager;

#[derive(Debug, serde::Serialize)]
pub struct ExtractResult {
    pub text: String,
    /// Populated when pdftotext isn't on PATH so the UI can prompt the user.
    pub error: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct StatResult {
    pub bytes: u64,
}

#[derive(Debug, serde::Serialize)]
pub struct ExtractImagesResult {
    /// Relative file names (not full paths) of the images that were written
    /// into `dest_dir`. Ordered by page, then by position on page — the
    /// pipeline's prose can reference them as figure-N.ext if it wants a
    /// stable identifier.
    pub images: Vec<String>,
    /// Directory the images were written to. Absolute path.
    pub dir: String,
    /// Populated when `pdfimages` isn't available on PATH so the UI can
    /// prompt the user to install poppler-utils.
    pub error: Option<String>,
}

/// Cheap metadata read for the ingest progress UI so we can show "reading
/// 142 MB PDF" before handing off to pdftotext (which otherwise runs silent
/// for tens of seconds on large books).
#[tauri::command]
pub fn stat_file(path: String) -> Result<StatResult, String> {
    match std::fs::metadata(&path) {
        Ok(m) => Ok(StatResult { bytes: m.len() }),
        Err(e) => Err(format!("stat {path}: {e}")),
    }
}

/// Extract every image embedded in the PDF into `dest_dir`, using the
/// `pdfimages` binary (poppler-utils) with `-all` so native-format (PNG,
/// JPEG, etc.) images come through without a lossy re-encode. Returns the
/// list of written filenames so the ingest pipeline can reference them
/// from lesson markdown.
///
/// Runs as a Tauri command rather than a Node subprocess because the
/// pipeline runs inside the webview and can't shell out directly; the same
/// reason `extract_pdf_text` lives here.
#[tauri::command]
pub fn extract_pdf_images(
    app: tauri::AppHandle,
    path: String,
    book_id: String,
) -> ExtractImagesResult {
    // Images live inside the same ingest-cache tree the pipeline already
    // uses, so clearing a book's cache nukes its images too. Per-book dir
    // keeps the cache browsable if someone opens it in Finder.
    let dest_dir: String = match app.path().app_data_dir() {
        Ok(d) => d
            .join("ingest-cache")
            .join(&book_id)
            .join("images")
            .to_string_lossy()
            .into_owned(),
        Err(e) => {
            return ExtractImagesResult {
                images: Vec::new(),
                dir: String::new(),
                error: Some(format!("couldn't resolve app data dir: {e}")),
            };
        }
    };
    if let Err(e) = std::fs::create_dir_all(&dest_dir) {
        return ExtractImagesResult {
            images: Vec::new(),
            dir: dest_dir,
            error: Some(format!("couldn't create dest dir: {e}")),
        };
    }
    // `-all` writes each image in its native format with a `-N-M` suffix
    // (page-index, per-page-index). `img` is the filename prefix we
    // strip when building the returned list.
    let prefix = "img";
    let output = match Command::new("pdfimages")
        .arg("-all")
        .arg(&path)
        .arg(format!("{dest_dir}/{prefix}"))
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            let hint = if e.kind() == std::io::ErrorKind::NotFound {
                "pdfimages not found on PATH — install poppler-utils first (on macOS: `brew install poppler`).".to_string()
            } else {
                format!("failed to launch pdfimages: {e}")
            };
            return ExtractImagesResult {
                images: Vec::new(),
                dir: dest_dir,
                error: Some(hint),
            };
        }
    };
    if !output.status.success() {
        return ExtractImagesResult {
            images: Vec::new(),
            dir: dest_dir,
            error: Some(format!(
                "pdfimages exited with status {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            )),
        };
    }

    // Read the dir and return everything matching our prefix, sorted for a
    // stable reference order across runs. We don't filter by extension —
    // `pdfimages -all` can emit PNG, JPG, TIFF, JBIG2, etc depending on
    // what's embedded; downstream consumers get to decide what's renderable.
    let mut images: Vec<String> = match std::fs::read_dir(&dest_dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.starts_with(prefix))
            .collect(),
        Err(e) => {
            return ExtractImagesResult {
                images: Vec::new(),
                dir: dest_dir,
                error: Some(format!("couldn't list dest dir: {e}")),
            };
        }
    };
    images.sort();

    ExtractImagesResult {
        images,
        dir: dest_dir,
        error: None,
    }
}

/// Common Homebrew prefixes where `pdftotext` might live. macOS GUI apps
/// launched from Finder/Launchpad get a minimal inherited PATH (`/usr/bin:
/// /bin:/usr/sbin:/sbin`) that does NOT include Homebrew. When the bare
/// `pdftotext` lookup fails we try each of these in order before giving
/// up. Covers Apple Silicon (/opt/homebrew), Intel Macs (/usr/local), and
/// Linuxbrew.
const BREW_PATHS: &[&str] = &[
    "/opt/homebrew/bin/pdftotext",
    "/usr/local/bin/pdftotext",
    "/home/linuxbrew/.linuxbrew/bin/pdftotext",
];

/// Locate a runnable `pdftotext` binary. Returns the first candidate that
/// actually exists on disk, or `None` if nothing matched (user hasn't
/// installed poppler at all).
fn find_pdftotext() -> Option<String> {
    // Try the plain name first — works when the app was launched from a
    // shell (`npm run tauri:dev`) that already has brew on PATH.
    if Command::new("pdftotext")
        .arg("-v")
        .output()
        .is_ok()
    {
        return Some("pdftotext".to_string());
    }
    // Fall back to common Homebrew prefixes. This is the path for a
    // notarized .app launched from /Applications where PATH is stripped.
    for candidate in BREW_PATHS {
        if std::path::Path::new(candidate).exists() {
            return Some((*candidate).to_string());
        }
    }
    None
}

#[tauri::command]
pub fn extract_pdf_text(path: String) -> ExtractResult {
    let binary = match find_pdftotext() {
        Some(b) => b,
        None => {
            return ExtractResult {
                text: String::new(),
                error: Some(
                    "pdftotext not found — install poppler first (on macOS: `brew install poppler`). \
                     If poppler IS installed but you're seeing this, please report the Homebrew \
                     prefix you use so we can include it in the lookup fallback list."
                        .to_string(),
                ),
            };
        }
    };

    // -layout preserves column boundaries + form feeds (chapter breaks) which
    // the downstream parser relies on.
    let output = match Command::new(&binary)
        .arg("-layout")
        .arg(&path)
        .arg("-") // write to stdout
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            return ExtractResult {
                text: String::new(),
                error: Some(format!("failed to launch {binary}: {e}")),
            };
        }
    };

    if !output.status.success() {
        return ExtractResult {
            text: String::new(),
            error: Some(format!(
                "pdftotext exited with status {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            )),
        };
    }

    ExtractResult {
        text: String::from_utf8_lossy(&output.stdout).into_owned(),
        error: None,
    }
}
