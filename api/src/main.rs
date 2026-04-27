//! Fishbones API — entry point.
//!
//! Startup sequence:
//!   1. Load .env (best-effort; production deploys that pass env vars
//!      directly via systemd EnvironmentFile aren't broken by a
//!      missing file).
//!   2. Init tracing.
//!   3. Read provider config from env. Empty values are treated as
//!      unset so a half-configured deploy surfaces 503s on the
//!      relevant routes instead of silently failing closed.
//!   4. Open SQLite + run migrations.
//!   5. Build router, bind, serve.
//!
//! Everything but the env loading runs on the tokio runtime; the
//! initial `dotenvy::dotenv()` is sync so its failure mode (file
//! missing) doesn't even surface as a tracing line.

mod auth;
mod db;
mod routes;
mod state;

use std::path::PathBuf;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

use crate::db::Database;
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Best-effort .env loading — walks up from cwd, silently ignores
    // a missing file. Production reads env from systemd's
    // EnvironmentFile=, dev reads it from the .env in this crate.
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("fishbones_api=info".parse()?),
        )
        .init();

    tracing::info!("Starting Fishbones API v{}", env!("CARGO_PKG_VERSION"));

    // ── Provider config ─────────────────────────────────────────
    // Empty strings are treated as unset so an env file with a
    // half-edited line (`APPLE_CLIENT_ID=`) doesn't accidentally pass
    // an empty audience into the JWT validator.
    let apple_audience = read_env("APPLE_CLIENT_ID");
    let google_audience = read_env("GOOGLE_CLIENT_ID");

    if apple_audience.is_none() {
        tracing::info!("Apple sign-in disabled (APPLE_CLIENT_ID unset)");
    } else {
        tracing::info!("Apple sign-in enabled");
    }
    if google_audience.is_none() {
        tracing::info!("Google sign-in disabled (GOOGLE_CLIENT_ID unset)");
    } else {
        tracing::info!("Google sign-in enabled");
    }

    let google_client_secret = read_env("GOOGLE_CLIENT_SECRET");
    let apple_team_id = read_env("APPLE_TEAM_ID");
    let apple_key_id = read_env("APPLE_KEY_ID");
    // Apple's .p8 content is multi-line; supporting both an inline
    // env var (for ephemeral container deploys) and a file path (for
    // bind-mounted secret stores) keeps every deploy shape happy.
    let apple_private_key_pem = read_env("APPLE_PRIVATE_KEY_PEM").or_else(|| {
        read_env("APPLE_PRIVATE_KEY_FILE")
            .and_then(|p| std::fs::read_to_string(&p).ok())
    });
    let public_url = read_env("PUBLIC_URL");
    let apple_domain_association_file = read_env("APPLE_DOMAIN_ASSOCIATION_FILE");

    let oauth_flow_ready = public_url.is_some()
        && (google_client_secret.is_some() || apple_private_key_pem.is_some());
    if !oauth_flow_ready {
        tracing::info!(
            "Browser-OAuth flow disabled — needs PUBLIC_URL plus a Google client secret and/or Apple .p8 key. Direct id_token endpoints (POST /auth/{{apple,google}}) still work."
        );
    } else {
        tracing::info!("Browser-OAuth flow enabled");
    }

    // ── Database ────────────────────────────────────────────────
    let database_path = read_env("DATABASE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/var/lib/fishbones-api/api.sqlite"));
    let db = Database::open(&database_path)?;
    db.run_migrations()?;
    tracing::info!("Database initialized at {}", database_path.display());

    // ── App state ───────────────────────────────────────────────
    let state = Arc::new(AppState {
        db,
        apple_audience,
        google_audience,
        google_client_secret,
        apple_team_id,
        apple_key_id,
        apple_private_key_pem,
        public_url,
        apple_domain_association_file,
    });

    // ── Router ──────────────────────────────────────────────────
    let app = routes::build_router(Arc::clone(&state));

    // ── Bind + serve ────────────────────────────────────────────
    let host = read_env("HOST").unwrap_or_else(|| "127.0.0.1".to_string());
    let port = read_env("PORT")
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(9443);
    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("Fishbones API listening on {addr}");

    axum::serve(listener, app).await?;

    Ok(())
}

/// Read an env var; treat empty / whitespace-only values as unset.
/// Centralised here so every config knob applies the same heuristic.
fn read_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.trim().is_empty())
}
