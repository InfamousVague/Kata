//! LLM-powered ingest step.
//!
//! Takes a chunk of extracted book text plus a target language and asks
//! Claude to return a structured JSON array of Codecademy-style lessons
//! (reading + exercise mix, with starter/solution/tests).
//!
//! We call Anthropic's HTTP API directly from Rust to keep CORS out of the
//! picture and keep the API key off the frontend — it never leaves disk
//! except in the outgoing request to api.anthropic.com.

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
    messages: Vec<AnthropicMessage<'a>>,
    system: &'a str,
}

#[derive(Debug, Serialize)]
struct AnthropicMessage<'a> {
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

/// Ask Claude to structure a section of book text into lessons. Returns the
/// raw JSON string Claude produced; the frontend parses it into LessonSpec[].
#[tauri::command]
pub async fn structure_with_llm(
    settings: State<'_, SettingsState>,
    section_title: String,
    section_text: String,
    language: String,
) -> Result<String, String> {
    let api_key = {
        let s = settings.0.lock();
        s.anthropic_api_key.clone()
    };
    let api_key = api_key.ok_or_else(|| {
        "No Anthropic API key configured — add one in Settings first.".to_string()
    })?;

    let system = system_prompt();
    let user_prompt = user_prompt(&section_title, &section_text, &language);

    let body = AnthropicRequest {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: &system,
        messages: vec![AnthropicMessage {
            role: "user",
            content: &user_prompt,
        }],
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

    let text = parsed
        .content
        .into_iter()
        .filter_map(|b| b.text)
        .collect::<Vec<_>>()
        .join("");

    Ok(extract_json(&text))
}

/// Strip ```json fences and surrounding prose from Claude's reply so the
/// frontend can JSON.parse it directly.
fn extract_json(text: &str) -> String {
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

fn system_prompt() -> String {
    r#"You are turning technical-book chapter text into Codecademy-style interactive lessons for a learn-to-code app called Kata. Output is strict JSON — a single array of lesson objects.

Each lesson is either reading (concept explanation) or exercise (runnable code with hidden tests that drive completion). Aim for roughly alternating reading → exercise → reading → exercise, with 8–12 total lessons per chapter. Keep lessons focused: one concept each.

Exercise lessons MUST include a starter the user will complete, a reference solution, and a tests string that uses this tiny Jest-compatible harness available in the sandbox:

  test(name, fn)
  expect(x).toBe(y)
  expect(x).toEqual(y)
  expect(x).toBeTruthy()
  expect(x).toBeFalsy()
  expect(x).toBeGreaterThan(n)
  expect(x).toBeLessThan(n)
  expect(x).toContain(item)
  expect(x).toBeCloseTo(v, digits)
  expect(x).toBeNull()
  expect(fn).toThrow()
  require('./user')   // returns the user's module.exports

The starter MUST end with module.exports = { ... } so tests can require('./user') and read the symbols. The starter must be a runnable file (no stray placeholder syntax) — use // comments for TODOs. Tests run against the user's solution, not the starter.

Lesson body is Markdown. Use `backticks` for identifiers, ```lang fences for code blocks, and headings (#, ##). Keep prose tight. Don't quote long passages from the source text verbatim — rewrite in your own words.

Return ONLY the JSON array. No preamble, no commentary, no markdown fences."#
        .to_string()
}

fn user_prompt(section_title: &str, section_text: &str, language: &str) -> String {
    format!(
        r#"Language for exercises: {language}
Chapter title: {section_title}

Chapter text (raw PDF extraction — code blocks may have line wrap artifacts):

{section_text}

Produce a JSON array of lesson objects matching this TypeScript shape:

type Lesson =
  | {{ id: string; kind: "reading"; title: string; body: string }}
  | {{
      id: string;
      kind: "exercise";
      title: string;
      language: string;     // the target language for this exercise
      body: string;         // the prompt the user sees
      starter: string;      // code the editor loads with
      solution: string;     // hidden reference solution
      tests: string;        // hidden test file using the harness above
    }};

Ids should be kebab-case, unique within the chapter, and descriptive. Produce 8–12 lessons for this chapter."#
    )
}
