//! Top-level router.
//!
//! The Fishbones routes live under `/fishbones/` so the same host
//! (`api.mattssoftware.com`) can serve other APIs alongside this one
//! without collisions. Public endpoints (signup, login, the OAuth
//! start/callback dance, the public course feed) are merged at the
//! top; authenticated endpoints get the bearer-token middleware via
//! `route_layer`. `/health` and the Apple `.well-known` file stay at
//! the literal root — health is cheap to leave there for monitoring,
//! and Apple insists on the root path for domain verification.
//!
//! Endpoint summary:
//!   POST   /fishbones/auth/signup                    — email + password
//!   POST   /fishbones/auth/login                     — email + password
//!   POST   /fishbones/auth/apple                     — Apple identity_token
//!   POST   /fishbones/auth/google                    — Google id_token
//!   GET    /fishbones/auth/google/start              — browser OAuth
//!   GET    /fishbones/auth/google/callback           — provider redirect
//!   GET    /fishbones/auth/apple/start               — browser OAuth
//!   POST   /fishbones/auth/apple/callback            — provider form_post
//!   GET    /fishbones/auth/apple/callback            —   (also tolerated)
//!   GET    /fishbones/me                             — current user
//!   POST   /fishbones/auth/logout                    — revoke this device
//!   DELETE /fishbones/auth/account                   — delete account
//!   GET    /fishbones/progress                       — full dump
//!   PUT    /fishbones/progress                       — bulk upsert
//!   POST   /fishbones/courses                        — upload .fishbones
//!   GET    /fishbones/courses                        — own courses
//!   GET    /fishbones/courses/public                 — public feed
//!   GET    /fishbones/courses/:id                    — download archive
//!   DELETE /fishbones/courses/:id                    — delete
//!   GET    /health                                   — liveness (root)
//!   GET    /.well-known/apple-developer-domain-association.txt (root)

mod auth;
mod courses;
mod middleware;
mod oauth;
mod oauth_flow;
mod progress;
mod well_known;

pub use middleware::auth_middleware;

use axum::{
    middleware as axum_middleware,
    routing::{delete, get, post},
    Json, Router,
};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::state::AppState;

/// Build the full router. CORS is permissive — Caddy is the only thing
/// in front of us and the desktop / web clients cross-origin against
/// this server, so blocking origins here would just create false
/// negatives.
pub fn build_router(state: Arc<AppState>) -> Router {
    let public = Router::new()
        .route("/health", get(health_check))
        .route("/fishbones/auth/signup", post(auth::signup))
        .route("/fishbones/auth/login", post(auth::login))
        // Direct id_token paths — clients call these when they have a
        // native-SDK token in hand.
        .route("/fishbones/auth/apple", post(auth::apple))
        .route("/fishbones/auth/google", post(auth::google))
        // Browser-OAuth start endpoints. Desktop opens these in the
        // system browser; the `start` redirects to the provider, the
        // provider redirects back to `callback`, and the callback
        // redirects into `fishbones://oauth/done?token=…`.
        .route(
            "/fishbones/auth/google/start",
            get(oauth_flow::google_start),
        )
        .route(
            "/fishbones/auth/google/callback",
            get(oauth_flow::google_callback),
        )
        .route(
            "/fishbones/auth/apple/start",
            get(oauth_flow::apple_start),
        )
        // Apple uses `response_mode=form_post`; tolerate GET too for
        // dev-mode hand-built URLs.
        .route(
            "/fishbones/auth/apple/callback",
            post(oauth_flow::apple_callback_post).get(oauth_flow::apple_callback_get),
        )
        .route("/fishbones/courses/public", get(courses::list_public))
        // Apple domain verification — must live at the literal root
        // path Apple fetches.
        .route(
            "/.well-known/apple-developer-domain-association.txt",
            get(well_known::apple_domain_association),
        );

    let protected = Router::new()
        .route("/fishbones/me", get(auth::me))
        .route("/fishbones/auth/logout", post(auth::logout))
        .route("/fishbones/auth/account", delete(auth::delete_account))
        .route(
            "/fishbones/progress",
            get(progress::list).put(progress::upsert),
        )
        .route(
            "/fishbones/courses",
            get(courses::list_mine).post(courses::upload),
        )
        .route(
            "/fishbones/courses/:id",
            get(courses::download).delete(courses::delete_course),
        )
        .route_layer(axum_middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    public
        .merge(protected)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// GET /health — public liveness endpoint. Same shape as Tap's so any
/// existing uptime-monitor wiring keeps working.
async fn health_check() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "relay": "ok",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}
