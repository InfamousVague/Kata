/// Shared return type for all language runtimes.
///
/// `logs` is the captured console.{log,info,warn,error} output, each entry one
/// call. `error` is set when the code threw. `durationMs` helps surface
/// suspiciously slow runs.
export interface RunResult {
  logs: LogLine[];
  error?: string;
  tests?: TestResult[];
  durationMs: number;
}

export interface LogLine {
  level: "log" | "info" | "warn" | "error";
  text: string;
}

export interface TestResult {
  name: string;
  passed: boolean;
  /** Populated when `passed` is false — message + truncated stack. */
  error?: string;
}

/**
 * Whether a RunResult represents an overall pass. An exercise passes when:
 *   1. The user code didn't throw
 *   2. If tests were present, every one passed
 */
export function isPassing(r: RunResult): boolean {
  if (r.error) return false;
  if (r.tests && r.tests.some((t) => !t.passed)) return false;
  return true;
}
