import { invoke } from "@tauri-apps/api/core";
import type { WorkbenchFile } from "../data/types";
import type { LogLine, RunResult } from "./types";

/// SvelteKit runtime — dispatches to the Rust `start_sveltekit`
/// command which scaffolds a project under `<app-data>/sveltekit-runs`,
/// runs `npm install` once, and spawns a long-lived `vite dev` whose
/// 127.0.0.1 URL we surface back to the caller via `result.previewUrl`.
///
/// Detection: `runFiles` falls through to here when the file set
/// contains a `+page.svelte` / `+layout.svelte` / `+server.{js,ts}` /
/// `hooks.server.{js,ts}` / `svelte.config.js` etc., i.e. anything
/// with the SvelteKit shape that the in-browser Svelte compiler
/// can't handle. The detection helper is exported so `index.ts`'s
/// dispatch table can ask "is this SvelteKit?" without rebuilding
/// the heuristic per call site.
///
/// Lifecycle: each lesson gets its own dev server keyed on
/// `lessonId`. Subsequent runs of the same lesson hot-reload via
/// Vite (the file write the runner does is enough — Vite picks it
/// up). Switching lessons doesn't kill the old server until the
/// next start for that lesson — leaks one process per ever-opened
/// lesson, but Vite is small and HMR-only so the cost is bounded.
/// A future refactor can add an explicit `stop_sveltekit` on
/// lesson-tab close.

interface StartResult {
  url: string | null;
  project_dir: string;
  stdout: string;
  stderr: string;
  install_ran: boolean;
  duration_ms: number;
}

/// SvelteKit-shape file paths we detect. `+`-prefixed routes are
/// SvelteKit-only conventions; svelte.config.js is the project-
/// level marker. Any one is enough to trip the dispatch.
const SVELTEKIT_PATH_HINTS = [
  /(^|\/)\+page\.svelte$/,
  /(^|\/)\+page\.(server\.)?(js|ts)$/,
  /(^|\/)\+layout\.svelte$/,
  /(^|\/)\+layout\.(server\.)?(js|ts)$/,
  /(^|\/)\+server\.(js|ts)$/,
  /(^|\/)\+error\.svelte$/,
  /^svelte\.config\.js$/,
  /^src\/hooks\.(server|client)\.(js|ts)$/,
];

export function looksLikeSvelteKit(files: WorkbenchFile[]): boolean {
  return files.some((f) =>
    SVELTEKIT_PATH_HINTS.some((re) => re.test(f.name)),
  );
}

export async function runSvelteKit(
  files: WorkbenchFile[],
  lessonId: string,
): Promise<RunResult> {
  const started = Date.now();
  // Translate the workbench's flat file list into the runner's
  // expected shape. `name` is the project-relative path; the
  // runner's path-sanitisation rejects `..` / leading `/`, so we
  // can hand the list over untouched.
  const payload = files.map((f) => ({ path: f.name, content: f.content }));
  try {
    const result = await invoke<StartResult>("start_sveltekit", {
      lessonId,
      files: payload,
    });
    const logs: LogLine[] = [];
    if (result.install_ran) {
      logs.push({
        level: "log",
        text: `Installed dependencies in ${result.project_dir} (${result.duration_ms}ms)`,
      });
    }
    if (result.stderr.trim()) {
      logs.push({ level: "warn", text: result.stderr.trim() });
    }
    if (result.stdout.trim()) {
      logs.push({ level: "log", text: result.stdout.trim() });
    }
    return {
      logs,
      previewUrl: result.url ?? undefined,
      previewKind: "web",
      durationMs: Date.now() - started,
      error: result.url
        ? undefined
        : "Vite started but didn't print a Local: URL within 30s. See logs above.",
    };
  } catch (e) {
    return {
      logs: [],
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - started,
    };
  }
}

/// Tear down the dev server for a lesson. Idempotent — the backend
/// no-ops when there's nothing running. Called by the lesson-tab
/// close handler so we don't leak Node processes across sessions.
export async function stopSvelteKit(lessonId: string): Promise<void> {
  try {
    await invoke("stop_sveltekit", { lessonId });
  } catch {
    /* best-effort */
  }
}
