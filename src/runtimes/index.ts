import type { LanguageId } from "../data/types";
import { runJavaScript, runTypeScript } from "./javascript";
import type { RunResult } from "./types";

export type { RunResult, LogLine } from "./types";

/// Dispatch to the right in-browser runtime for a language. Languages that
/// don't yet have a runtime (python, rust, swift) return a clear "not
/// supported" error so the UI can render it.
export async function runCode(language: LanguageId, code: string): Promise<RunResult> {
  switch (language) {
    case "javascript":
      return runJavaScript(code);
    case "typescript":
      return runTypeScript(code);
    case "python":
    case "rust":
    case "swift":
      return {
        logs: [],
        error: `${language} runtime not implemented yet — coming in a later step`,
        durationMs: 0,
      };
  }
}
