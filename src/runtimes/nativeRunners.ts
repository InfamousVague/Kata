import { invoke } from "@tauri-apps/api/core";
import type { LogLine, RunResult, TestResult } from "./types";

/// Shared wrapper for the 6 shell-out runners in the Rust backend
/// (C / C++ / Java / Kotlin / C# / Assembly). Each one returns the
/// same `SubprocessResult` shape as `run_swift`, so the conversion to
/// `RunResult` is identical — swift, these six, and any future
/// native-toolchain language can all route through the same code path
/// instead of copy-pasting 40 lines per language.

interface RawResult {
  stdout: string;
  stderr: string;
  success: boolean;
  duration_ms: number;
  launch_error: string | null;
}

/// Dispatch to a Rust subprocess runner and normalise its result.
///
/// `toolchainLabel` identifies the shell-out binary in user-facing
/// error messages ("cc exited with a non-zero status") so the learner
/// knows which toolchain is complaining. `language` is the canonical
/// `LanguageId` string (`"java"`, `"kotlin"`, etc.) — we tag the
/// RunResult with it when the Rust side reports a `launch_error`, so
/// OutputPane can render the missing-toolchain banner with the right
/// install recipe instead of a wall of red stderr.
async function runNative(
  command: string,
  code: string,
  toolchainLabel: string,
  language: string,
  testCode?: string,
): Promise<RunResult> {
  // Concatenate solution + tests when tests are present — challenge
  // packs for C/C++/Java/Kotlin/C# ship a separate `tests` field that
  // defines a main() emitting `KATA_TEST::name::PASS|FAIL` lines we
  // parse below. The Rust backend doesn't know about that split; it
  // just compiles whatever source blob we hand it.
  const merged = testCode ? `${code}\n${testCode}\n` : code;
  const raw = await invoke<RawResult>(command, { code: merged });

  if (raw.launch_error) {
    // Toolchain couldn't start (not on PATH, permission issue, or the
    // macOS stub `java` that sends people to java.com). Surface the
    // hint from the Rust side directly AND flag the language so
    // OutputPane can render the MissingToolchainBanner inline —
    // otherwise the learner sees "Unable to locate a Java Runtime"
    // and has no install button to click.
    return {
      logs: [],
      error: raw.launch_error,
      durationMs: raw.duration_ms,
      testsExpected: testCode !== undefined,
      missingToolchainLanguage: language,
    };
  }

  // `isLessonRun` distinguishes exercise lessons (which always pass a
  // `testCode` — even if empty string for run-only convention) from
  // pure playground runs (where testCode is undefined). Only lesson
  // runs get a synthetic "passed" result on success, so the playground
  // doesn't accidentally render pass pills for code that has no tests.
  const isLessonRun = testCode !== undefined;

  let tests: TestResult[] | undefined = undefined;
  if (isLessonRun) {
    // Parse KATA_TEST::name::PASS / FAIL lines from BOTH streams.
    // Most languages emit on stdout (puts/println/printf), but Zig's
    // synthesized harness uses `std.debug.print` which writes to
    // stderr because Zig 0.16 removed `std.io.getStdOut()` and the
    // newer `std.fs.File.stdout()` writer pattern is verbose enough
    // that going through `std.debug.print` is materially simpler.
    // Scanning both streams is harmless for the other languages —
    // their stderr never carries KATA_TEST lines, so the parser
    // returns an empty list from that side and we get the same
    // behaviour as before.
    tests = parseKataTests(raw.stdout);
    if (tests.length === 0) {
      tests = parseKataTests(raw.stderr);
    }
    if (tests.length === 0) {
      // Run-only convention: lesson with empty tests passes iff the
      // program exited cleanly. Synthesize a single result so (a) the
      // OutputPane renders a visible "passed" pill instead of a blank
      // body, and (b) `isPassing()` correctly flips this to complete.
      tests = raw.success
        ? [{ name: "program exited cleanly", passed: true }]
        : [
            {
              name: "program exited cleanly",
              passed: false,
              error:
                raw.stderr.trim().slice(0, 500) ||
                "non-zero exit — see logs",
            },
          ];
    }
  }

  // Strip KATA_TEST lines from BOTH visible streams so the user sees
  // only their own prints, not the test protocol. (Zig pumps the
  // protocol on stderr — see the comment above — so we have to filter
  // there too or the learner sees the whole KATA_TEST::name::PASS
  // ledger in their warnings panel.)
  const stripKata = (s: string) =>
    s.split("\n").filter((l) => !/^KATA_TEST::/.test(l)).join("\n").replace(/\n+$/, "");
  const displayStdout = isLessonRun
    ? stripKata(raw.stdout)
    : raw.stdout.replace(/\n+$/, "");
  const displayStderr = isLessonRun ? stripKata(raw.stderr) : raw.stderr;

  const logs: LogLine[] = [];
  if (displayStdout) logs.push({ level: "log", text: displayStdout });
  if (displayStderr && !raw.success) {
    // Non-zero exit usually means a compile-time or runtime error on
    // stderr — fold it into the log stream as an "error" so it renders
    // in the red tint in OutputPane.
    logs.push({ level: "error", text: displayStderr.trimEnd() });
  } else if (displayStderr) {
    // Warnings or informational notes — compiler may emit these on a
    // successful build (e.g. `-Wall` diagnostics on clean C). Render
    // as warn so they're visible but don't scream failure.
    logs.push({ level: "warn", text: displayStderr.trimEnd() });
  }

  // When we have any captured output (stderr, stdout) the user gets the
  // real diagnostic in the logs. A generic "<tool> exited with a non-zero
  // status" summary line on TOP of that is just noise — prefer silence
  // and let the actual compiler message speak for itself. Only show the
  // summary when the logs AND tests are both empty (rare but possible:
  // the toolchain crashed with no output).
  const haveUsefulLogs = logs.length > 0;
  const haveTests = tests && tests.length > 0;
  return {
    logs,
    tests,
    error: raw.success
      ? undefined
      : haveUsefulLogs || haveTests
        ? undefined
        : `${toolchainLabel} exited with a non-zero status (no output captured)`,
    durationMs: raw.duration_ms,
    testsExpected: isLessonRun,
  };
}

/// Same KATA_TEST stdout protocol that `go.ts` and the test-suite
/// runners parse. One line per test: `KATA_TEST::<name>::PASS` or
/// `KATA_TEST::<name>::FAIL::<one-line reason>`.
function parseKataTests(stdout: string): TestResult[] {
  const results: TestResult[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^KATA_TEST::([\w-]+)::(PASS|FAIL)(?:::(.*))?$/.exec(line);
    if (!m) continue;
    if (m[2] === "PASS") {
      results.push({ name: m[1], passed: true });
    } else {
      results.push({ name: m[1], passed: false, error: m[3] || "test failed" });
    }
  }
  return results;
}

export function runC(code: string, testCode?: string): Promise<RunResult> {
  return runNative("run_c", code, "cc", "c", testCode);
}

export function runCpp(code: string, testCode?: string): Promise<RunResult> {
  return runNative("run_cpp", code, "c++", "cpp", testCode);
}

export function runJava(code: string, testCode?: string): Promise<RunResult> {
  return runNative("run_java", code, "javac/java", "java", testCode);
}

export function runKotlin(code: string, testCode?: string): Promise<RunResult> {
  return runNative("run_kotlin", code, "kotlinc", "kotlin", testCode);
}

export function runCSharp(code: string, testCode?: string): Promise<RunResult> {
  return runNative("run_csharp", code, "dotnet script", "csharp", testCode);
}

export function runAssembly(code: string, testCode?: string): Promise<RunResult> {
  return runNative("run_asm", code, "as/ld", "assembly", testCode);
}

// ── 2026 expansion: simple-CLI runners ────────────────────────────
// Single-binary languages — `ruby <file>`, `elixir <file>`, etc. The
// Rust side (native_runners.rs::simple_run_one_file) just writes a
// temp file and execs the binary; SubprocessResult shape is identical
// to the C/Java/etc. runners above so the same `runNative` wrapper
// handles output capture, KATA_TEST parsing, and missing-toolchain
// banner routing for free.
//
// Web build: `runtimes/index.ts`'s isWeb gate short-circuits these
// to the desktop-upsell banner before the IPC even fires, so the
// frontend never has to handle Tauri-not-available errors here.

export function runRuby(code: string, testCode?: string): Promise<RunResult> {
  return runNative("run_ruby", code, "ruby", "ruby", testCode);
}

export function runElixir(code: string, testCode?: string): Promise<RunResult> {
  return runNative("run_elixir", code, "elixir", "elixir", testCode);
}

export function runHaskell(code: string, testCode?: string): Promise<RunResult> {
  return runNative("run_haskell", code, "runghc", "haskell", testCode);
}

export function runScala(code: string, testCode?: string): Promise<RunResult> {
  return runNative("run_scala", code, "scala-cli", "scala", testCode);
}

export function runDart(code: string, testCode?: string): Promise<RunResult> {
  return runNative("run_dart", code, "dart", "dart", testCode);
}

export function runZig(code: string, testCode?: string): Promise<RunResult> {
  // Zig has a very strict "no duplicate top-level names" rule. The default
  // KATA_TEST harness for our Zig packs starts test code with
  // `const std = @import("std");` so that references like
  // `std.mem.eql` resolve. The user's solution / starter usually ALSO
  // declares `const std = @import("std");` at the top. When `runNative`
  // concatenates them, Zig fails with:
  //
  //   error: duplicate struct member name 'std'
  //
  // …pointing at the second declaration. Strip the redundant import
  // from the test code if the user's code already has one. The test
  // code's `std.foo` references still resolve to the user's import
  // because they share the same file scope after concatenation.
  return runNative("run_zig", code, "zig", "zig", dedupeZigStdImport(code, testCode));
}

/// Drop a leading `const std = @import("std");` from `testCode` when
/// the user's `code` already declares it. This is a Zig-specific
/// hazard — most other languages let you re-import a module without
/// erroring (Rust hides duplicates behind module scopes, Go forbids
/// imports outside the import block so the merger never has to look).
/// Keeping the helper here (rather than in runNative) means
/// non-Zig languages keep their straight-through merge.
function dedupeZigStdImport(code: string, testCode?: string): string | undefined {
  if (testCode == null) return testCode;
  const importRe = /^[ \t]*const\s+std\s*=\s*@import\(\s*"std"\s*\)\s*;[ \t]*\r?\n?/m;
  if (!importRe.test(code)) return testCode; // user didn't import; harness import is fine
  return testCode.replace(importRe, "");
}
