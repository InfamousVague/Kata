//! LLM-powered ingest commands.
//!
//! The pipeline runs as a specialist chain (see INGEST.md §Pipeline):
//!
//!   clean_code      — detect code regions + repair PDF wrap artifacts +
//!                     emit Markdown with properly fenced code blocks.
//!   outline_chapter — plan the lesson breakdown for a chapter.
//!   generate_lesson — fill in a single lesson from its outline stub.
//!   retry_exercise  — ask Claude to fix an exercise that failed validation,
//!                     with the diagnostic attached.
//!
//! Every command calls api.anthropic.com/v1/messages directly over reqwest
//! so the API key stays off the frontend and CORS doesn't apply.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::settings::SettingsState;

const ANTHROPIC_API: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
// Model is now picked per-user in Settings (anthropic_model) and read fresh
// on each call. Default set in settings::Settings::default is sonnet-4-5.
//
// Sonnet 4.5 supports up to 64k output tokens. 16k comfortably holds a full
// exercise lesson (prose + starter + solution + tests) with room to spare;
// if we hit this ceiling we bump it again. Under-sizing leads to truncated
// JSON and unparseable responses, so we err on the high side.
const MAX_TOKENS: u32 = 16384;

#[derive(Debug, Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: &'a str,
    messages: Vec<Msg<'a>>,
}

#[derive(Debug, Serialize)]
struct Msg<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    content: Vec<ContentBlock>,
    /// "end_turn" = normal. "max_tokens" = we capped it and the text is truncated
    /// — we need to surface that as a clear error instead of handing a
    /// half-written JSON string to serde.
    stop_reason: Option<String>,
    usage: Option<AnthropicUsage>,
}

#[derive(Debug, Deserialize)]
struct AnthropicUsage {
    input_tokens: u64,
    output_tokens: u64,
}

/// Structured return from every LLM command. Carries the generated text plus
/// accounting metadata the frontend uses to render live progress stats
/// (tokens, cost, elapsed, etc.).
#[derive(Debug, Serialize)]
pub struct LlmResponse {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    _kind: String,
    text: Option<String>,
}

// ---- Stage 1: clean + fence code in raw text --------------------------------

#[tauri::command]
pub async fn clean_code(
    settings: State<'_, SettingsState>,
    chapter_title: String,
    raw_text: String,
) -> Result<LlmResponse, String> {
    let system = r#"You are a PDF-to-Markdown repair tool. Given the raw text of one chapter of a programming book, return a clean Markdown version where:

  - Every code sample is wrapped in a ```lang fenced block with the correct language.
  - Code that was broken across lines by PDF layout is joined back onto the right lines (watch for the classic pattern: a comment ending mid-sentence, then the continuation on the next line).
  - Chapter + section headings become # / ## / ### Markdown headings.
  - Figures and tables become placeholder lines like `[figure: …description…]`.
  - Page numbers, running headers, and "Early Release ebooks" boilerplate are stripped.

Return ONLY the repaired Markdown. No commentary, no code fences around the whole response."#;

    // clean_code is a mechanical reformat (strip boilerplate, fence code,
    // rewrite headings). Sonnet is optimal for this — Opus adds no quality
    // here, just cost + wall-clock time (Opus is ~2x slower at generating
    // output). Pin Sonnet regardless of the user's model pick.
    call_llm(
        &settings,
        system,
        &format!("Chapter: {chapter_title}\n\n---\n\n{raw_text}"),
        Some("claude-sonnet-4-5"),
        &format!("clean_code[{chapter_title}]"),
    )
    .await
}

// ---- Stage 2: outline the chapter into lesson stubs -------------------------

#[tauri::command]
pub async fn outline_chapter(
    settings: State<'_, SettingsState>,
    chapter_title: String,
    cleaned_markdown: String,
    language: String,
) -> Result<LlmResponse, String> {
    let system = r#"You plan Codecademy-style interactive lessons from technical-book chapters. Given a cleaned Markdown version of one chapter, return a JSON array of lesson stubs that together cover the chapter. Aim for 8–14 stubs.

Each stub is:

  { "id": "kebab-case-slug", "kind": "reading" | "exercise" | "quiz", "title": "...", "intent": "one sentence summary of what the lesson teaches or asks" }

Guidelines:
  - Alternate reading ⇄ exercise so the user is always either learning or practicing.
  - Insert a "quiz" stub roughly every 4–6 lessons as a checkpoint.
  - Exercises should have a clear, testable task — ideally tied to a concrete API or pattern from the source text.
  - Reading lessons should each cover ONE concept — don't merge multiple topics into a single stub.
  - Ids must be unique within the chapter.

Return ONLY the JSON array. No preamble, no markdown fences."#;

    let prompt = format!(
        "Language (target for exercises): {language}\nChapter title: {chapter_title}\n\n---\n\n{cleaned_markdown}"
    );
    call_llm(
        &settings,
        system,
        &prompt,
        None,
        &format!("outline_chapter[{chapter_title}]"),
    )
    .await
}

// ---- Stage 3: generate the full content for one lesson stub -----------------

#[tauri::command]
pub async fn generate_lesson(
    settings: State<'_, SettingsState>,
    chapter_title: String,
    cleaned_markdown: String,
    language: String,
    stub: String,                    // JSON string: { id, kind, title, intent }
    prior_solution: Option<String>,  // if section-progressive and this is a continuation
) -> Result<LlmResponse, String> {
    let system = r#"You author one Codecademy-style lesson at a time for the Kata app. Given the chapter's cleaned Markdown as reference, the target language, and a lesson stub (id, kind, title, intent), return a single JSON object matching one of these shapes depending on kind:

READING:
  { "id": "...", "kind": "reading", "title": "...", "body": "markdown with fenced code blocks" }

EXERCISE:
  {
    "id": "...", "kind": "exercise", "title": "...",
    "language": "...",
    "body": "markdown prompt explaining the task",
    "starter": "runnable file ending with module.exports = { ... } (JS) or equivalent",
    "solution": "reference solution — must pass every test",
    "tests": "test file using the harness below"
  }

QUIZ:
  {
    "id": "...", "kind": "quiz", "title": "...",
    "body": "optional short intro (may be empty)",
    "questions": [
      { "kind": "mcq", "prompt": "...", "options": ["a","b","c","d"], "correctIndex": 0, "explanation": "..." },
      { "kind": "short", "prompt": "...", "accept": ["answer-1","alt"], "explanation": "..." }
    ]
  }

Writing guidelines:
  - Rewrite tight in Kata voice — friendly, terse, no filler. Do not quote long passages from the source verbatim.
  - Use `backticks` for identifiers and ```lang fences for code in lesson bodies.
  - Exercise starters MUST be runnable (no TODO syntax that errors on load) — use comments for TODOs. End with module.exports so require('./user') works.
  - Tests use this jest-compatible harness:
      test(name, fn)
      expect(x).toBe(y)
      expect(x).toEqual(y)
      expect(x).toBeTruthy() / toBeFalsy()
      expect(x).toBeGreaterThan(n) / toBeLessThan(n)
      expect(x).toContain(item)
      expect(x).toBeCloseTo(v, digits)
      expect(fn).toThrow()
      require('./user')   // returns the user's module.exports
  - Quizzes: 3–5 questions, mix of mcq (4 options, one correct) and short-answer. `accept` is a list of equally-valid answers (case/punctuation-insensitive match).

Return ONLY the JSON object. No preamble, no code fences."#;

    let prior = prior_solution
        .as_deref()
        .map(|s| format!("\n\nPrior lesson's solution (use this as the starter for continuity):\n```\n{s}\n```"))
        .unwrap_or_default();

    let prompt = format!(
        "Language: {language}\nChapter: {chapter_title}\nStub: {stub}{prior}\n\n---\n\nChapter source:\n\n{cleaned_markdown}"
    );
    call_llm(
        &settings,
        system,
        &prompt,
        None,
        &format!("generate_lesson[{}]", &stub),
    )
    .await
}

// ---- Retry: fix an exercise that failed validation --------------------------

#[tauri::command]
pub async fn retry_exercise(
    settings: State<'_, SettingsState>,
    original_lesson: String, // JSON string of the previous attempt
    failure_reason: String,  // human-readable description of what went wrong
) -> Result<LlmResponse, String> {
    let system = r#"You are fixing a Kata exercise lesson that failed automated validation. The user will send you the original lesson JSON and a description of the failure. Return a corrected lesson JSON matching the same schema.

Common failures:
  - "solution did not pass test X" — fix the solution to satisfy that assertion.
  - "starter already passes every test" — add a TODO/stub to the starter so the user has something to implement.
  - "tests reference an identifier the solution does not export" — align the module.exports with the require('./user') in tests.

Return ONLY the corrected JSON object. No preamble, no code fences."#;

    let prompt = format!(
        "Failure: {failure_reason}\n\nOriginal lesson JSON:\n{original_lesson}"
    );
    call_llm(&settings, system, &prompt, None, "retry_exercise").await
}

// ---- Shared helper ----------------------------------------------------------

/// How many times to retry a single call on retriable statuses (429 rate limit,
/// 529 overloaded, 5xx server errors). Exponential backoff with jitter between
/// attempts. Most overload spikes clear within a minute, so 5 retries gives the
/// pipeline up to ~2 minutes to recover without human intervention.
const MAX_RETRIES: u32 = 5;

async fn call_llm(
    settings: &State<'_, SettingsState>,
    system: &str,
    user: &str,
    model_override: Option<&str>,
    label: &str,
) -> Result<LlmResponse, String> {
    let (api_key, user_model) = {
        let s = settings.0.lock();
        (s.anthropic_api_key.clone(), s.anthropic_model.clone())
    };
    let api_key = api_key
        .ok_or_else(|| "No Anthropic API key configured — add one in Settings first.".to_string())?;
    let model = model_override.map(|s| s.to_string()).unwrap_or(user_model);

    eprintln!(
        "[llm] → {} model={} system_chars={} user_chars={}",
        label,
        model,
        system.len(),
        user.len()
    );

    let body = AnthropicRequest {
        model: &model,
        max_tokens: MAX_TOKENS,
        system,
        messages: vec![Msg { role: "user", content: user }],
    };

    let client = reqwest::Client::new();
    let start = std::time::Instant::now();

    for attempt in 0..=MAX_RETRIES {
        eprintln!(
            "[llm]   {} attempt {}/{} sending request…",
            label,
            attempt + 1,
            MAX_RETRIES + 1
        );
        let send_started = std::time::Instant::now();
        let resp = client
            .post(ANTHROPIC_API)
            .header("x-api-key", &api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await;

        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[llm] ✗ {} network error (after {}ms): {e}", label, send_started.elapsed().as_millis());
                if attempt < MAX_RETRIES {
                    sleep_backoff(attempt).await;
                    continue;
                }
                return Err(format!("network error: {e}"));
            }
        };

        let status = resp.status();
        eprintln!("[llm]   {} response {} after {}ms", label, status, send_started.elapsed().as_millis());
        if status.is_success() {
            let parsed: AnthropicResponse = resp
                .json()
                .await
                .map_err(|e| format!("bad response json: {e}"))?;

            if parsed.stop_reason.as_deref() == Some("max_tokens") {
                eprintln!("[llm] ✗ {} truncated at max_tokens", label);
                return Err(format!(
                    "Claude hit the {MAX_TOKENS}-token output cap before finishing — \
                     response was truncated. Raise MAX_TOKENS in llm.rs or split the \
                     prompt into smaller chunks."
                ));
            }

            let text: String = parsed
                .content
                .into_iter()
                .filter_map(|b| b.text)
                .collect::<Vec<_>>()
                .join("");
            let (input_tokens, output_tokens) = parsed
                .usage
                .map(|u| (u.input_tokens, u.output_tokens))
                .unwrap_or((0, 0));
            eprintln!(
                "[llm] ✓ {} done in {}ms · {}in / {}out tokens · {} response chars",
                label,
                start.elapsed().as_millis(),
                input_tokens,
                output_tokens,
                text.len(),
            );
            return Ok(LlmResponse {
                text: extract_body(&text),
                input_tokens,
                output_tokens,
                elapsed_ms: start.elapsed().as_millis() as u64,
            });
        }

        // Retriable: 429 (rate limit), 529 (overloaded), 5xx. Non-retriable:
        // 4xx auth/validation — those need human intervention.
        let is_retriable = status.as_u16() == 429
            || status.as_u16() == 529
            || status.is_server_error();

        if !is_retriable || attempt == MAX_RETRIES {
            let text = resp.text().await.unwrap_or_default();
            eprintln!("[llm] ✗ {} {} (non-retriable or exhausted): {}", label, status, text.chars().take(200).collect::<String>());
            return Err(format!("Anthropic API {status}: {text}"));
        }

        eprintln!(
            "[llm] ! {} Anthropic {} (attempt {}/{}). Backing off…",
            label, status, attempt + 1, MAX_RETRIES + 1
        );
        sleep_backoff(attempt).await;
    }

    // Loop should always return; this is unreachable but satisfies the
    // compiler when it can't prove the loop exits.
    Err("exhausted retries without a terminal result".to_string())
}

/// Exponential backoff: 2^attempt seconds + up to 1s jitter. Capped at 30s.
/// Attempt 0 → ~1s, 1 → ~2s, 2 → ~4s, 3 → ~8s, 4 → ~16s, 5 → ~30s (capped).
async fn sleep_backoff(attempt: u32) {
    use rand::Rng;
    let base = (1u64 << attempt.min(5)) as u64; // cap exponent at 5 (32s)
    let cap = base.min(30);
    let jitter_ms = rand::thread_rng().gen_range(0..1000);
    let total_ms = cap * 1000 + jitter_ms;
    tokio::time::sleep(std::time::Duration::from_millis(total_ms)).await;
}


/// Strip ```json or ``` fences and trailing whitespace from an LLM reply.
fn extract_body(text: &str) -> String {
    let trimmed = text.trim();
    if let Some(rest) = trimmed.strip_prefix("```json") {
        if let Some(end) = rest.rfind("```") {
            return rest[..end].trim().to_string();
        }
    }
    if let Some(rest) = trimmed.strip_prefix("```") {
        if let Some(end) = rest.rfind("```") {
            return rest[..end].trim().to_string();
        }
    }
    trimmed.to_string()
}

// ---- Back-compat: old command kept as a facade so existing ImportDialog works
//      until it's rewritten to use the three specialist commands.

#[tauri::command]
pub async fn structure_with_llm(
    settings: State<'_, SettingsState>,
    section_title: String,
    section_text: String,
    language: String,
) -> Result<LlmResponse, String> {
    // Legacy single-pass entry point; runPipeline is the preferred path.
    let legacy_system = r#"You are a single-pass legacy adapter. Return a JSON array of lessons for the Kata app given a chapter of raw text and a target language. Each lesson is either reading or exercise with the schema described in the generate_lesson system prompt. Keep it simple — 6 to 10 lessons."#;
    let prompt = format!("Language: {language}\nSection: {section_title}\n\n{section_text}");
    call_llm(
        &settings,
        legacy_system,
        &prompt,
        None,
        &format!("legacy_structure_with_llm[{section_title}]"),
    )
    .await
}
