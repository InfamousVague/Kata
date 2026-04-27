//! Apple's domain-verification well-known endpoint.
//!
//! When you configure Sign in with Apple on a Service ID, Apple gives
//! you a small text file (`apple-developer-domain-association.txt`)
//! that must be served at:
//!
//!   https://<your-domain>/.well-known/apple-developer-domain-association.txt
//!
//! Apple fetches that URL when you click "Verify" in the developer
//! portal. We serve the file from disk (path in
//! `APPLE_DOMAIN_ASSOCIATION_FILE` — defaulting to
//! `/etc/fishbones-api/apple-domain-association.txt`) so a fresh
//! verification token can be dropped in by `scp` without rebuilding
//! the API server.
//!
//! If the file isn't present we 404; Apple's verifier reports the
//! domain as unverified and the user knows to upload the file.

use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use std::sync::Arc;

use crate::state::AppState;

pub async fn apple_domain_association(State(state): State<Arc<AppState>>) -> Response {
    let path = state
        .apple_domain_association_file
        .clone()
        .unwrap_or_else(|| {
            "/etc/fishbones-api/apple-domain-association.txt".to_string()
        });

    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            bytes,
        )
            .into_response(),
        Err(e) => {
            tracing::warn!(
                "apple-developer-domain-association.txt missing at {}: {}",
                path,
                e
            );
            StatusCode::NOT_FOUND.into_response()
        }
    }
}
