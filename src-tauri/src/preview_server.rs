//! Local HTTP server that exposes the Playground's rendered web output
//! at a stable `http://127.0.0.1:<port>` URL — and (since we vendored
//! every CDN dep) also serves shipped browser-runtime bundles under
//! `/vendor/*` so the iframe-hosted runtimes (RN preview, React /
//! Three.js / HTMX templates, Svelte) can reference them with a
//! relative URL while staying fully offline.
//!
//! Path map:
//!
//!   `/vendor/<file>`  — Read from `<resources>/vendor/<file>`. 404 if
//!                       the file doesn't exist or `<file>` would
//!                       escape the vendor dir (the path-sanitisation
//!                       check below).
//!   anything else    — Return the most-recently-`serve_web_preview`'d
//!                       HTML. We respond on every other path (not just
//!                       `/`) so relative asset references inside
//!                       inlined demos still resolve.
//!
//! The server is lazy and single-shot: one background listener for the
//! lifetime of the app, bound to `127.0.0.1:0` so the OS assigns a free
//! port. Every `serve_web_preview` call just swaps the held HTML and
//! returns the pre-chosen URL. The vendor dir is captured once on
//! first init from the AppHandle so we don't need to thread it through
//! every request.

use std::io::Cursor;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use serde::Serialize;
use tauri::Manager;

/// Shared between the Tauri command handler and the listener thread.
/// The HTML mutex carries the most-recent preview snapshot; the vendor
/// dir is captured at init time and never changes.
struct PreviewState {
    html: Mutex<String>,
    addr: SocketAddr,
    vendor_dir: PathBuf,
}

static STATE: OnceLock<Arc<PreviewState>> = OnceLock::new();

/// Lazily start the preview server. First call binds `127.0.0.1:0`,
/// resolves the vendor resource dir, and spawns the request loop.
/// Subsequent calls return the same handle.
fn state(app: &tauri::AppHandle) -> Result<Arc<PreviewState>, String> {
    if let Some(s) = STATE.get() {
        return Ok(s.clone());
    }

    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("failed to start preview server: {e}"))?;
    let addr = match server.server_addr() {
        tiny_http::ListenAddr::IP(a) => a,
        tiny_http::ListenAddr::Unix(_) => {
            return Err("preview server bound to a unix socket, expected TCP".into());
        }
    };

    // Resolve the shipped vendor directory once. In a packaged build
    // it's `<bundle>/Resources/resources/vendor/`; in dev it's
    // `src-tauri/resources/vendor/` (resolved relative to the dev
    // server's cwd by Tauri). If either fails we still start the
    // server — the runtime URLs will just 404 for vendor lookups,
    // and the user sees "couldn't load …" instead of a hard crash.
    let vendor_dir = app
        .path()
        .resource_dir()
        .map(|p| p.join("resources").join("vendor"))
        .unwrap_or_else(|_| PathBuf::from("resources/vendor"));

    let state = Arc::new(PreviewState {
        html: Mutex::new(String::new()),
        addr,
        vendor_dir,
    });

    // Background listener. Runs forever — we don't support stopping
    // it because the app shouldn't outlive the preview need. If the
    // user force-quits, the OS reclaims the port.
    let thread_state = state.clone();
    thread::Builder::new()
        .name("fishbones-preview-server".into())
        .spawn(move || {
            for request in server.incoming_requests() {
                handle_request(&thread_state, request);
            }
        })
        .map_err(|e| format!("failed to spawn preview server thread: {e}"))?;

    let _ = STATE.set(state.clone());
    Ok(state)
}

/// Per-request dispatcher. Splits `/vendor/...` lookups from the
/// fallback "serve the current HTML" path. Errors at this level are
/// always best-effort `respond` calls — a dropped client connection
/// shouldn't kill the listener thread.
fn handle_request(state: &PreviewState, request: tiny_http::Request) {
    let url = request.url().to_string();

    // `/vendor/<filename>` → static asset from the shipped resources
    // dir. The path-sanitisation check refuses any segment containing
    // `..` so an attacker-controlled URL can't `GET /vendor/../../../etc/passwd`.
    if let Some(rel) = url.strip_prefix("/vendor/") {
        // Strip query strings — runtime imports may add `?v=...` cache
        // busters; the file lookup just wants the bare name.
        let rel = rel.split('?').next().unwrap_or(rel);
        if rel.is_empty() || rel.contains("..") || rel.starts_with('/') {
            respond_404(request);
            return;
        }
        let full = state.vendor_dir.join(rel);
        match std::fs::read(&full) {
            Ok(bytes) => respond_asset(request, rel, bytes),
            Err(_) => respond_404(request),
        }
        return;
    }

    // Default: serve the most-recent preview HTML. Snapshot under the
    // lock then drop it before sending so concurrent commands don't
    // serialize on the response write.
    let body = {
        let guard = state.html.lock().unwrap_or_else(|p| p.into_inner());
        guard.clone()
    };
    let response = tiny_http::Response::new(
        tiny_http::StatusCode(200),
        vec![
            tiny_http::Header::from_bytes(
                &b"Content-Type"[..],
                &b"text/html; charset=utf-8"[..],
            )
            .unwrap(),
            // Disable caching so each run serves the latest HTML
            // even though the URL is stable.
            tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..])
                .unwrap(),
        ],
        Cursor::new(body.clone().into_bytes()),
        Some(body.len()),
        None,
    );
    let _ = request.respond(response);
}

fn respond_asset(request: tiny_http::Request, rel: &str, bytes: Vec<u8>) {
    let content_type = guess_content_type(rel);
    let len = bytes.len();
    let response = tiny_http::Response::new(
        tiny_http::StatusCode(200),
        vec![
            tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes())
                .unwrap(),
            // Vendored assets are immutable — the bundle hash is the
            // file path. Cache hard so a repeated preview reload
            // doesn't re-stream the (potentially multi-MB) JS each
            // time. `immutable` is honoured by Chrome/Webkit; older
            // engines fall back to the standard 1-year TTL.
            tiny_http::Header::from_bytes(
                &b"Cache-Control"[..],
                &b"public, max-age=31536000, immutable"[..],
            )
            .unwrap(),
        ],
        Cursor::new(bytes),
        Some(len),
        None,
    );
    let _ = request.respond(response);
}

fn respond_404(request: tiny_http::Request) {
    let body = b"not found";
    let response = tiny_http::Response::new(
        tiny_http::StatusCode(404),
        vec![tiny_http::Header::from_bytes(
            &b"Content-Type"[..],
            &b"text/plain; charset=utf-8"[..],
        )
        .unwrap()],
        Cursor::new(body.to_vec()),
        Some(body.len()),
        None,
    );
    let _ = request.respond(response);
}

/// Pick a Content-Type from the file extension. Covers everything the
/// vendor pipeline currently produces; unknown extensions get
/// `application/octet-stream` which the browser handles fine for raw
/// asset fetches but which doesn't trigger script execution — adding
/// a small belt-and-suspenders against an attacker who somehow drops
/// an `.exe` into the vendor dir.
fn guess_content_type(rel: &str) -> &'static str {
    let lower = rel.to_lowercase();
    if lower.ends_with(".js") || lower.ends_with(".mjs") {
        "application/javascript; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".html") || lower.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".json") || lower.ends_with(".map") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".wasm") {
        "application/wasm"
    } else if lower.ends_with(".woff2") {
        "font/woff2"
    } else if lower.ends_with(".woff") {
        "font/woff"
    } else if lower.ends_with(".ttf") {
        "font/ttf"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    }
}

#[derive(Debug, Serialize)]
pub struct PreviewHandle {
    /// The base URL the caller should surface to the user. Always
    /// `http://127.0.0.1:<port>/` so the page also handles the root
    /// request cleanly. Vendored assets live under `<base>/vendor/`.
    pub url: String,
}

/// Tauri command: swap in new preview HTML and return the URL it'll
/// be served from. Safe to call repeatedly — the server starts on
/// first use and subsequent calls just update the held HTML.
#[tauri::command]
pub fn serve_web_preview(
    app: tauri::AppHandle,
    html: String,
) -> Result<PreviewHandle, String> {
    let state = state(&app)?;
    {
        let mut guard = state.html.lock().unwrap_or_else(|p| p.into_inner());
        *guard = html;
    }
    Ok(PreviewHandle {
        url: format!("http://{}/", state.addr),
    })
}
