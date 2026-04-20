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
const MODEL: &str = "claude-sonnet-4-5";
const MAX_TOKENS: u32 = 8192;

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
) -> Result<String, String> {
    let system = r#"You are a PDF-to-Markdown repair tool. Given the raw text of one chapter of a programming book, return a clean Markdown version where:

  - Every code sample is wrapped in a ```lang fenced block with the correct language.
  - Code that was broken across lines by PDF layout is joined back onto the right lines (watch for the classic pattern: a comment ending mid-sentence, then the continuation on the next line).
  - Chapter + section headings become # / ## / ### Markdown headings.
  - Figures and tables become placeholder lines like `[figure: …description…]`.
  - Page numbers, running headers, and "Early Release ebooks" boilerplate are stripped.

Return ONLY the repaired Markdown. No commentary, no code fences around the whole response."#;

    call_llm(
        &settings,
        system,
        &format!("Chapter: {chapter_title}\n\n---\n\n{raw_text}"),
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
) -> Result<String, String> {
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
    call_llm(&settings, system, &prompt).await
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
) -> Result<String, String> {
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
    call_llm(&settings, system, &prompt).await
}

// ---- Retry: fix an exercise that failed validation --------------------------

#[tauri::command]
pub async fn retry_exercise(
    settings: State<'_, SettingsState>,
    original_lesson: String, // JSON string of the previous attempt
    failure_reason: String,  // human-readable description of what went wrong
) -> Result<String, String> {
    let system = r#"You are fixing a Kata exercise lesson that failed automated validation. The user will send you the original lesson JSON and a description of the failure. Return a corrected lesson JSON matching the same schema.

Common failures:
  - "solution did not pass test X" — fix the solution to satisfy that assertion.
  - "starter already passes every test" — add a TODO/stub to the starter so the user has something to implement.
  - "tests reference an identifier the solution does not export" — align the module.exports with the require('./user') in tests.

Return ONLY the corrected JSON object. No preamble, no code fences."#;

    let prompt = format!(
        "Failure: {failure_reason}\n\nOriginal lesson JSON:\n{original_lesson}"
    );
    call_llm(&settings, system, &prompt).await
}

// ---- Shared helper ----------------------------------------------------------

async fn call_llm(
    settings: &State<'_, SettingsState>,
    system: &str,
    user: &str,
) -> Result<String, String> {
    let api_key = {
        let s = settings.0.lock();
        s.anthropic_api_key.clone()
    };
    let api_key = api_key
        .ok_or_else(|| "No Anthropic API key configured — add one in Settings first.".to_string())?;

    let body = AnthropicRequest {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: vec![Msg { role: "user", content: user }],
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(ANTHROPIC_API)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Anthropic API {status}: {text}"));
    }

    let parsed: AnthropicResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad response json: {e}"))?;

    let text: String = parsed
        .content
        .into_iter()
        .filter_map(|b| b.text)
        .collect::<Vec<_>>()
        .join("");

    Ok(extract_body(&text))
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
) -> Result<String, String> {
    // Short-path fallback: just outline+generate through the old one-shot
    // prompt. The specialist chain is the preferred path; frontend should
    // call clean_code / outline_chapter / generate_lesson directly.
    let legacy_system = r#"You are a single-pass legacy adapter. Return a JSON array of lessons for the Kata app given a chapter of raw text and a target language. Each lesson is either reading or exercise with the schema described in the generate_lesson system prompt. Keep it simple — 6 to 10 lessons."#;
    let prompt = format!("Language: {language}\nSection: {section_title}\n\n{section_text}");
    call_llm(&settings, legacy_system, &prompt).await
}
