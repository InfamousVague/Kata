//! Argon2id-based password + token hashing.
//!
//! Two helpers each for passwords and tokens — separate fns rather
//! than a generic so a future audit can pin the exact param tuple per
//! use case. Passwords get the default Argon2id params (memory cost
//! ~19 MB, t=2) which the user only pays once per session; tokens
//! also use defaults but a future tightening could lower them since
//! we verify on every authenticated request.

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand::rngs::OsRng;

/// Hash a password for storage. Generates a fresh random salt per
/// call — never reuse one across users.
pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon = Argon2::default();
    Ok(argon
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("hash failed: {e}"))?
        .to_string())
}

/// Constant-time verify of a plaintext password against an
/// Argon2-encoded hash. Returns false on any parse error so a
/// malformed hash row never panics the auth path.
pub fn verify_password(password: &str, hash: &str) -> bool {
    let parsed = match PasswordHash::new(hash) {
        Ok(h) => h,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// Hash a Bearer token for storage. Same Argon2id params as
/// `hash_password` for now; split into its own fn so that can change
/// independently later.
pub fn hash_token(token: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon = Argon2::default();
    let hash = argon
        .hash_password(token.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("hash failed: {e}"))?;
    Ok(hash.to_string())
}

/// Constant-time verify of a Bearer token against an Argon2-encoded
/// hash. Returns false on any parse error.
pub fn verify_token(token: &str, hash: &str) -> bool {
    let parsed = match PasswordHash::new(hash) {
        Ok(h) => h,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(token.as_bytes(), &parsed)
        .is_ok()
}
