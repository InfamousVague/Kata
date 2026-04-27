//! Bearer-token middleware.
//!
//! Argon2id-verifies the inbound `Authorization: Bearer <token>`
//! against every stored hash, then injects `UserId` and `TokenId`
//! into request extensions for the handlers downstream. The brute
//! O(n) scan is fine at this scale (one Argon2 verify per stored
//! token per request) — a future tightening would key the lookup by
//! a SHA-256 prefix stored alongside the Argon2 hash.

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use std::sync::Arc;

use crate::auth::verify_token;
use crate::state::AppState;

/// Authenticated user, lifted from a verified Bearer token and
/// pushed into request extensions for downstream handlers.
#[derive(Clone, Debug)]
pub struct UserId(pub String);

/// The id of the token used to authenticate this request — the
/// logout handler reads it to know which row to delete.
#[derive(Clone, Debug)]
pub struct TokenId(pub String);

pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let token_hashes = state
        .db
        .all_token_hashes()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut matched: Option<(String, String)> = None;
    for (id, user_id, hash) in &token_hashes {
        if verify_token(token, hash) {
            matched = Some((id.clone(), user_id.clone()));
            break;
        }
    }
    let (token_id, user_id) = matched.ok_or(StatusCode::UNAUTHORIZED)?;

    let _ = state.db.update_token_last_used(&token_id);

    req.extensions_mut().insert(UserId(user_id));
    req.extensions_mut().insert(TokenId(token_id));
    Ok(next.run(req).await)
}
