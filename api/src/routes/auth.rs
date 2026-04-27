//! Auth handlers — signup, login, Apple, Google, me, logout, delete.
//!
//! All four sign-in flows (email signup/login, Apple, Google) end at
//! the same `mint_token` step, which generates a `fb_*` Bearer token
//! and stores its Argon2 hash in `tokens`. Failure modes collapse to
//! `401 UNAUTHORIZED` so the client can't infer whether an email
//! exists from a wrong-password response.

use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::middleware::{TokenId, UserId};
use super::oauth;
use crate::auth::{hash_password, hash_token, verify_password};
use crate::state::AppState;

/// Generate a Fishbones-prefixed Bearer token. Distinct prefix from
/// other internal services so logs make it obvious which subsystem a
/// leaked token belongs to. Same `fb_*` shape the desktop already
/// recognises — clients written against the old relay don't need
/// changes.
fn mint_token() -> String {
    use base64::Engine;
    let bytes: [u8; 32] = rand::random();
    format!(
        "fb_{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

/// Issue a fresh Bearer token for `user_id`, label it with the
/// caller-supplied `device_label`, and return the plaintext (the only
/// chance the client has to capture it — we only store the hash).
fn issue_token(
    state: &AppState,
    user_id: &str,
    device_label: &str,
) -> Result<String, StatusCode> {
    let token = mint_token();
    let token_hash =
        hash_token(&token).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let id = uuid::Uuid::new_v4().to_string();
    state
        .db
        .store_token(&id, user_id, device_label, &token_hash)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(token)
}

#[derive(Deserialize)]
pub struct SignupRequest {
    pub email: String,
    pub password: String,
    pub display_name: Option<String>,
    pub device_label: Option<String>,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: crate::db::User,
}

pub async fn signup(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SignupRequest>,
) -> Result<Json<AuthResponse>, StatusCode> {
    let email = body.email.trim().to_lowercase();
    if !email.contains('@') || body.password.len() < 8 {
        return Err(StatusCode::BAD_REQUEST);
    }
    if state
        .db
        .email_exists(&email)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        return Err(StatusCode::CONFLICT);
    }
    let pw_hash = hash_password(&body.password)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let user_id = state
        .db
        .create_password_user(&email, &pw_hash, body.display_name.as_deref())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let token = issue_token(
        &state,
        &user_id,
        body.device_label.as_deref().unwrap_or("desktop"),
    )?;
    let user = state
        .db
        .get_user(&user_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(AuthResponse { token, user }))
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    pub device_label: Option<String>,
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, StatusCode> {
    let email = body.email.trim().to_lowercase();
    let row = state
        .db
        .get_password_login(&email)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !verify_password(&body.password, &row.1) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let token = issue_token(
        &state,
        &row.0,
        body.device_label.as_deref().unwrap_or("desktop"),
    )?;
    let user = state
        .db
        .get_user(&row.0)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(AuthResponse { token, user }))
}

#[derive(Deserialize)]
pub struct OauthRequest {
    pub identity_token: String,
    pub display_name: Option<String>,
    pub device_label: Option<String>,
}

pub async fn apple(
    State(state): State<Arc<AppState>>,
    Json(body): Json<OauthRequest>,
) -> Result<Json<AuthResponse>, StatusCode> {
    let audience = state
        .apple_audience
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let identity = oauth::verify_apple(&body.identity_token, audience)
        .await
        .map_err(|e| {
            tracing::warn!("Apple verify failed: {e}");
            StatusCode::UNAUTHORIZED
        })?;
    let display = body.display_name.as_deref().or(identity.name.as_deref());
    let user_id = state
        .db
        .find_or_create_apple_user(
            &identity.subject,
            identity.email.as_deref(),
            display,
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let token = issue_token(
        &state,
        &user_id,
        body.device_label.as_deref().unwrap_or("desktop · apple"),
    )?;
    let user = state
        .db
        .get_user(&user_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(AuthResponse { token, user }))
}

pub async fn google(
    State(state): State<Arc<AppState>>,
    Json(body): Json<OauthRequest>,
) -> Result<Json<AuthResponse>, StatusCode> {
    let audience = state
        .google_audience
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let identity = oauth::verify_google(&body.identity_token, audience)
        .await
        .map_err(|e| {
            tracing::warn!("Google verify failed: {e}");
            StatusCode::UNAUTHORIZED
        })?;
    let display = body.display_name.as_deref().or(identity.name.as_deref());
    let user_id = state
        .db
        .find_or_create_google_user(
            &identity.subject,
            identity.email.as_deref(),
            display,
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let token = issue_token(
        &state,
        &user_id,
        body.device_label.as_deref().unwrap_or("desktop · google"),
    )?;
    let user = state
        .db
        .get_user(&user_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(AuthResponse { token, user }))
}

pub async fn me(
    State(state): State<Arc<AppState>>,
    Extension(UserId(user_id)): Extension<UserId>,
) -> Result<Json<crate::db::User>, StatusCode> {
    state
        .db
        .get_user(&user_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

pub async fn logout(
    State(state): State<Arc<AppState>>,
    Extension(UserId(user_id)): Extension<UserId>,
    Extension(TokenId(token_id)): Extension<TokenId>,
) -> Result<StatusCode, StatusCode> {
    state
        .db
        .revoke_token(&token_id, &user_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_account(
    State(state): State<Arc<AppState>>,
    Extension(UserId(user_id)): Extension<UserId>,
) -> Result<StatusCode, StatusCode> {
    state
        .db
        .delete_user(&user_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}
