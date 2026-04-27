//! OAuth identity-token verifiers (Apple + Google).
//!
//! Both flows are the same idea — the client gets an `id_token` JWT
//! from the provider's native SDK, hands it to us, and we verify it by:
//!   1. Decoding the header to find the `kid`
//!   2. Fetching the provider's JWKS
//!   3. Verifying the signature against the matching key
//!   4. Confirming `iss` and `aud` claims
//!   5. Pulling out `sub` (provider-stable user id), `email`, `name`
//!
//! We use `jsonwebtoken` for the signature work — it understands
//! RSA + JWKS natively, so we don't have to roll our own RSA verify.

use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use once_cell::sync::Lazy;
use serde::Deserialize;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub struct OauthIdentity {
    /// Provider-stable user id (`sub` claim). Apple's `sub` is opaque;
    /// Google's `sub` is a numeric string.
    pub subject: String,
    pub email: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AppleClaims {
    sub: String,
    email: Option<String>,
    #[allow(dead_code)]
    iss: String,
}

#[derive(Debug, Deserialize)]
struct GoogleClaims {
    sub: String,
    email: Option<String>,
    name: Option<String>,
    #[allow(dead_code)]
    iss: String,
}

const APPLE_JWKS_URL: &str = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER: &str = "https://appleid.apple.com";
const GOOGLE_JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS: &[&str] = &["accounts.google.com", "https://accounts.google.com"];

/// Cached JWKS fetch. Apple + Google rotate keys infrequently; refetch
/// every 6 hours so a key rollover during normal operation doesn't
/// brick auth between deploys. One mutex per provider keyed on the
/// JWKS URL so stale lookups don't pile up under load.
struct JwksCache {
    jwks: Option<JwkSet>,
    fetched_at: Option<Instant>,
}

impl JwksCache {
    const fn empty() -> Self {
        Self { jwks: None, fetched_at: None }
    }
    fn is_fresh(&self) -> bool {
        match self.fetched_at {
            Some(t) => t.elapsed() < Duration::from_secs(6 * 3600),
            None => false,
        }
    }
}

static APPLE_JWKS: Lazy<Mutex<JwksCache>> = Lazy::new(|| Mutex::new(JwksCache::empty()));
static GOOGLE_JWKS: Lazy<Mutex<JwksCache>> = Lazy::new(|| Mutex::new(JwksCache::empty()));

async fn fetch_jwks(cache: &Mutex<JwksCache>, url: &str) -> anyhow::Result<JwkSet> {
    {
        let guard = cache.lock().await;
        if guard.is_fresh() {
            if let Some(j) = &guard.jwks {
                return Ok(j.clone());
            }
        }
    }
    let res: JwkSet = reqwest::Client::new()
        .get(url)
        .send()
        .await?
        .json()
        .await?;
    let mut guard = cache.lock().await;
    guard.jwks = Some(res.clone());
    guard.fetched_at = Some(Instant::now());
    Ok(res)
}

/// Verify an Apple `id_token`. Audience is the Service ID configured
/// in the relay's environment as `APPLE_CLIENT_ID` (e.g.
/// `com.mattssoftware.fishbones.signin`).
pub async fn verify_apple(token: &str, audience: &str) -> anyhow::Result<OauthIdentity> {
    let header = decode_header(token)?;
    let kid = header
        .kid
        .ok_or_else(|| anyhow::anyhow!("Apple token missing 'kid' header"))?;

    let jwks = fetch_jwks(&APPLE_JWKS, APPLE_JWKS_URL).await?;
    let key = jwks
        .find(&kid)
        .ok_or_else(|| anyhow::anyhow!("No matching Apple JWK for kid {}", kid))?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[APPLE_ISSUER]);
    validation.set_audience(&[audience]);
    let data = decode::<AppleClaims>(token, &DecodingKey::from_jwk(key)?, &validation)?;

    Ok(OauthIdentity {
        subject: data.claims.sub,
        email: data.claims.email,
        name: None,
    })
}

/// Verify a Google `id_token`. Audience is the Web/iOS client id
/// (`GOOGLE_CLIENT_ID`).
pub async fn verify_google(token: &str, audience: &str) -> anyhow::Result<OauthIdentity> {
    let header = decode_header(token)?;
    let kid = header
        .kid
        .ok_or_else(|| anyhow::anyhow!("Google token missing 'kid' header"))?;

    let jwks = fetch_jwks(&GOOGLE_JWKS, GOOGLE_JWKS_URL).await?;
    let key = jwks
        .find(&kid)
        .ok_or_else(|| anyhow::anyhow!("No matching Google JWK for kid {}", kid))?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(GOOGLE_ISSUERS);
    validation.set_audience(&[audience]);
    let data = decode::<GoogleClaims>(token, &DecodingKey::from_jwk(key)?, &validation)?;

    Ok(OauthIdentity {
        subject: data.claims.sub,
        email: data.claims.email,
        name: data.claims.name,
    })
}
