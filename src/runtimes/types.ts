/// Shared return type for all language runtimes.
///
/// `logs` is the captured console.{log,info,warn,error} output, each entry one
/// call. `error` is set when the code threw. `durationMs` helps surface
/// suspiciously slow runs.
export interface RunResult {
  logs: LogLine[];
  error?: string;
  durationMs: number;
}

export interface LogLine {
  level: "log" | "info" | "warn" | "error";
  text: string;
}
