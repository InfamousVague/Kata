import type { WorkbenchFile } from "../data/types";
import type { RunResult, LogLine, TestResult } from "./types";

/// Solidity runtime — loads the official `solc-js` compiler from
/// binaries.soliditylang.org, compiles the learner's `.sol` source via
/// the standard JSON I/O interface, and (when a test file is supplied)
/// runs JS tests with access to the compilation output.
///
/// The compiler is the real `solidity_compile` C function compiled to
/// asm.js / wasm — it is the same artifact `solc` ships, just running
/// in the browser. So semantics, error messages, and ABI shapes match
/// the canonical compiler exactly.
///
/// **First-run cost:** the soljson bundle is ~14 MB. We cache the loaded
/// `solidity_compile` function in module-level state so subsequent runs
/// skip the download.
///
/// **Test format:** the supplied test code runs as a normal async JS
/// function with three globals injected:
///   - `compiled` — the parsed solc output (`{ contracts, errors, sources }`)
///   - `expect` — a small Jest-compatible matcher set
///   - `test(name, fn)` — register a test row; failures land in the
///     RunResult's `tests` array exactly like the JS runtime.
///
/// Example test (asserts a `Counter` contract exposes an `increment`
/// function):
/// ```js
/// test("compiles", () => {
///   expect(compiled.errors?.some(e => e.severity === "error")).toBeFalsy();
/// });
/// test("exposes increment()", () => {
///   const abi = compiled.contracts["Contract.sol"].Counter.abi;
///   const inc = abi.find(e => e.type === "function" && e.name === "increment");
///   expect(inc).toBeDefined();
/// });
/// ```

/// Pinned solc version. Match the docs the course is authored against —
/// 0.8.26 is the latest stable as of authoring. Bumping is a one-line
/// edit; CI tests will catch any new compiler diagnostics.
const SOLC_VERSION = "v0.8.26+commit.8a97fa7a";
const SOLC_URL = `https://binaries.soliditylang.org/bin/soljson-${SOLC_VERSION}.js`;

type SolcCompile = (input: string) => string;

/// Singleton compiler promise. Created on first call to `runSolidity`,
/// reused thereafter. Reject states stay rejected (no auto-retry) — if
/// the CDN was unreachable on first run, asking the learner to reload
/// is more honest than silently masking a network failure.
let solcReady: Promise<SolcCompile> | null = null;

function loadSolc(): Promise<SolcCompile> {
  if (solcReady) return solcReady;

  solcReady = new Promise<SolcCompile>((resolve, reject) => {
    // soljson-vX.Y.Z.js declares `var Module = ...` at the top level.
    // We piggy-back on the host page's globals so `cwrap` can reach into
    // the emscripten heap. Without `script.async = false` the script's
    // synchronous globals occasionally race with our access — keep it
    // sync to make the order deterministic.
    const script = document.createElement("script");
    script.src = SOLC_URL;
    script.async = false;
    script.onerror = () =>
      reject(
        new Error(
          `Failed to download Solidity compiler from ${SOLC_URL}. Check your network connection.`,
        ),
      );
    script.onload = () => {
      const Module = (globalThis as unknown as {
        Module?: {
          cwrap: <Args extends string[], Ret extends string>(
            symbol: string,
            returnType: Ret,
            argTypes: Args,
          ) => (...args: unknown[]) => unknown;
          onRuntimeInitialized?: () => void;
        };
      }).Module;

      if (!Module) {
        reject(
          new Error(
            "Solidity compiler loaded but the global Module is missing — soljson layout may have changed.",
          ),
        );
        return;
      }

      const onReady = () => {
        try {
          // `solidity_compile(input_json, callbacks_ptr)` is the canonical
          // C export. Passing `0` for callbacks tells the compiler not
          // to call any import-resolution hook (we feed all sources
          // up-front via the input JSON).
          const compile = Module.cwrap(
            "solidity_compile",
            "string",
            ["string", "number"],
          ) as (input: string, callbacks: number) => string;
          resolve((input: string) => compile(input, 0));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };

      // Two cases: (1) the compiler emscripten heap is already
      // initialized when our `onload` fires (small / cached binaries),
      // (2) it isn't — chain on top of `onRuntimeInitialized`.
      // `cwrap` is ready immediately when the heap is up.
      if (typeof Module.cwrap === "function") {
        onReady();
      } else {
        const prev = Module.onRuntimeInitialized;
        Module.onRuntimeInitialized = () => {
          if (typeof prev === "function") prev();
          onReady();
        };
      }
    };
    document.head.appendChild(script);
  });

  return solcReady;
}

/// Build the standard JSON input solc accepts. Mirrors the official
/// `solc --standard-json` shape so our error messages + bytecode are
/// byte-identical to what a learner would see if they piped the same
/// sources through the CLI.
function buildSolcInput(files: WorkbenchFile[]): string {
  const sources: Record<string, { content: string }> = {};
  for (const f of files) {
    if (/\.sol$/i.test(f.name)) {
      sources[f.name] = { content: f.content ?? "" };
    }
  }
  // Fallback: no `.sol` extension on any file — use the first file
  // verbatim under the conventional name. Keeps the runtime tolerant
  // of single-string lessons that didn't carry a filename through.
  if (Object.keys(sources).length === 0) {
    sources["Contract.sol"] = { content: files[0]?.content ?? "" };
  }

  return JSON.stringify({
    language: "Solidity",
    sources,
    settings: {
      // Ask for ABI + deployed bytecode + gas estimates. We don't need
      // sourcemaps, AST, or method identifiers — adding them slows the
      // compile noticeably without value to a learner-facing harness.
      outputSelection: {
        "*": {
          "*": [
            "abi",
            "evm.bytecode.object",
            "evm.deployedBytecode.object",
            "evm.gasEstimates",
          ],
        },
      },
      optimizer: { enabled: false, runs: 200 },
      // Pin EVM version to the latest stable so deterministic bytecode
      // matches the docs. Cancun is the post-Dencun activated set in
      // 2024+. Older targets (paris, london, etc.) opt the learner into
      // a different opcode subset which would surprise them.
      evmVersion: "cancun",
    },
  });
}

/// Convert solc's diagnostic stream into runtime LogLines. solc's
/// `formattedMessage` is the human-readable form (matches what `solc`
/// prints to stderr); `message` is the bare reason. Prefer the
/// formatted form so learners get caret-pointing snippets in errors.
function diagnosticsToLogs(
  errors: Array<{
    severity: "error" | "warning" | "info";
    formattedMessage?: string;
    message?: string;
    type?: string;
    errorCode?: string;
  }>,
): { logs: LogLine[]; hasErrors: boolean } {
  const logs: LogLine[] = [];
  let hasErrors = false;
  for (const err of errors) {
    const level: LogLine["level"] =
      err.severity === "error" ? "error" : err.severity === "warning" ? "warn" : "info";
    const text =
      err.formattedMessage ??
      `${err.severity.toUpperCase()} (${err.errorCode ?? err.type ?? "?"}): ${err.message ?? ""}`;
    logs.push({ level, text: text.trim() });
    if (err.severity === "error") hasErrors = true;
  }
  return { logs, hasErrors };
}

/// One-line summary per compiled contract — handy in the playground
/// where there's no test file. Surfaces "your code compiled and here's
/// what came out" without the learner needing to ask. Matches the
/// shape `truffle compile` prints.
function summarizeContracts(
  contracts: Record<string, Record<string, {
    abi?: Array<{ type: string; name?: string }>;
    evm?: { bytecode?: { object?: string } };
  }>>,
): LogLine[] {
  const out: LogLine[] = [];
  for (const [file, perFile] of Object.entries(contracts)) {
    for (const [name, info] of Object.entries(perFile)) {
      const abi = info.abi ?? [];
      const fns = abi.filter((e) => e.type === "function").length;
      const events = abi.filter((e) => e.type === "event").length;
      const errs = abi.filter((e) => e.type === "error").length;
      const bc = info.evm?.bytecode?.object ?? "";
      const sizeKb = (bc.length / 2 / 1024).toFixed(2);
      out.push({
        level: "log",
        text: `✓ Compiled ${name} (${file}) — ${fns} fn · ${events} event · ${errs} error · ${sizeKb} KB bytecode`,
      });
    }
  }
  return out;
}

/// Tiny Jest-like `expect` factory for the test harness. Mirrors the
/// matcher set the JS runtime exposes so course authors can write tests
/// that look identical between runtimes.
function makeExpect() {
  // The wrapper is the value returned per `expect(actual)` call.
  // `not` flips every matcher; we implement it by rebuilding the
  // wrapper with a flag.
  const make = (actual: unknown, negated: boolean) => {
    const fail = (msg: string) => {
      throw new Error(negated ? `not: ${msg}` : msg);
    };
    const wrap = {
      get not() {
        return make(actual, !negated);
      },
      toBe(expected: unknown) {
        const ok = Object.is(actual, expected);
        if (ok === negated) fail(`Expected ${jsonish(actual)} to be ${jsonish(expected)}`);
      },
      toEqual(expected: unknown) {
        const ok = JSON.stringify(actual) === JSON.stringify(expected);
        if (ok === negated)
          fail(`Expected ${jsonish(actual)} to equal ${jsonish(expected)}`);
      },
      toBeTruthy() {
        const ok = !!actual;
        if (ok === negated) fail(`Expected ${jsonish(actual)} to be truthy`);
      },
      toBeFalsy() {
        const ok = !actual;
        if (ok === negated) fail(`Expected ${jsonish(actual)} to be falsy`);
      },
      toBeDefined() {
        const ok = actual !== undefined;
        if (ok === negated) fail(`Expected value to be defined`);
      },
      toBeUndefined() {
        const ok = actual === undefined;
        if (ok === negated) fail(`Expected value to be undefined`);
      },
      toContain(needle: unknown) {
        const arr = actual as Array<unknown> | string;
        const ok = arr != null && (arr as Array<unknown>).includes(needle as never);
        if (ok === negated)
          fail(`Expected ${jsonish(actual)} to contain ${jsonish(needle)}`);
      },
      toHaveLength(len: number) {
        const a = actual as { length?: number };
        const ok = a != null && a.length === len;
        if (ok === negated)
          fail(`Expected length ${a?.length} to be ${len}`);
      },
      toHaveProperty(path: string) {
        const obj = actual as Record<string, unknown> | null;
        const ok = !!obj && path in obj;
        if (ok === negated) fail(`Expected object to have property "${path}"`);
      },
      toMatch(pattern: RegExp | string) {
        const text = String(actual);
        const ok =
          pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
        if (ok === negated) fail(`Expected ${jsonish(text)} to match ${pattern}`);
      },
      toBeGreaterThan(n: number) {
        const ok = typeof actual === "number" && actual > n;
        if (ok === negated) fail(`Expected ${actual} > ${n}`);
      },
      toBeGreaterThanOrEqual(n: number) {
        const ok = typeof actual === "number" && actual >= n;
        if (ok === negated) fail(`Expected ${actual} >= ${n}`);
      },
      toBeLessThan(n: number) {
        const ok = typeof actual === "number" && actual < n;
        if (ok === negated) fail(`Expected ${actual} < ${n}`);
      },
    };
    return wrap;
  };
  return (actual: unknown) => make(actual, false);
}

function jsonish(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export async function runSolidity(
  files: WorkbenchFile[],
  testCode?: string,
): Promise<RunResult> {
  const started = Date.now();
  const logs: LogLine[] = [];
  const tests: TestResult[] = [];

  // Step 1: load the compiler. Slow on first call, instant after.
  let compile: SolcCompile;
  try {
    compile = await loadSolc();
  } catch (e) {
    return {
      logs: [
        {
          level: "error",
          text: `Couldn't load Solidity compiler: ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      ],
      error: "Compiler load failed",
      durationMs: Date.now() - started,
    };
  }

  // Step 2: compile the user's source.
  let outputJson: string;
  try {
    outputJson = compile(buildSolcInput(files));
  } catch (e) {
    return {
      logs: [
        {
          level: "error",
          text: `Compiler crashed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      ],
      error: "Compiler crashed",
      durationMs: Date.now() - started,
    };
  }

  let output: {
    errors?: Array<{
      severity: "error" | "warning" | "info";
      formattedMessage?: string;
      message?: string;
      type?: string;
      errorCode?: string;
    }>;
    contracts?: Record<string, Record<string, {
      abi?: Array<{ type: string; name?: string }>;
      evm?: { bytecode?: { object?: string } };
    }>>;
    sources?: Record<string, unknown>;
  };
  try {
    output = JSON.parse(outputJson);
  } catch (e) {
    return {
      logs: [
        {
          level: "error",
          text: `Compiler returned non-JSON output (${
            e instanceof Error ? e.message : String(e)
          })`,
        },
      ],
      error: "Compiler output unparseable",
      durationMs: Date.now() - started,
    };
  }

  // Step 3: turn diagnostics into logs (warnings first, errors fatal).
  const { logs: diagLogs, hasErrors } = diagnosticsToLogs(output.errors ?? []);
  logs.push(...diagLogs);

  // Step 4: if compilation succeeded, summarize each contract for the
  // playground / no-tests case. Tests don't need this — they assert on
  // `compiled` directly.
  if (!hasErrors && output.contracts) {
    logs.push(...summarizeContracts(output.contracts));
  }

  // Step 5: run the test harness if one was supplied.
  if (testCode) {
    const testRows: TestResult[] = [];
    const testFn = (name: string, body: () => void | Promise<void>) => {
      // Sync + async tests both supported. We collect rows synchronously
      // first, then await any promises one at a time so a failing test
      // doesn't short-circuit later ones. Matches the JS runtime's
      // behaviour exactly.
      let pending: void | Promise<void>;
      try {
        pending = body();
      } catch (e) {
        testRows.push({
          name,
          passed: false,
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      if (pending && typeof (pending as Promise<void>).then === "function") {
        // Defer — the test row gets pushed inside the resolved/rejected
        // branch.
        (pending as Promise<void>)
          .then(() => testRows.push({ name, passed: true }))
          .catch((e) =>
            testRows.push({
              name,
              passed: false,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
      } else {
        testRows.push({ name, passed: true });
      }
    };

    const expect = makeExpect();

    // Run the test code with `compiled`, `expect`, `test` injected as
    // ambient globals. AsyncFunction lets the body use `await` — useful
    // for tests that fetch ABIs from libraries or do heavier crunching.
    try {
      const AsyncFunction = Object.getPrototypeOf(
        async function () {},
      ).constructor;
      const fn = new AsyncFunction(
        "compiled",
        "expect",
        "test",
        testCode,
      );
      await fn(output, expect, testFn);
      // Wait for any tests whose bodies returned a promise to settle.
      // Microtask hop is enough because we awaited the harness already;
      // the resolved/rejected handlers above are queued as microtasks.
      await new Promise((r) => setTimeout(r, 0));
    } catch (e) {
      logs.push({
        level: "error",
        text: `Test harness error: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }

    tests.push(...testRows);
  }

  const durationMs = Date.now() - started;

  return {
    logs,
    tests: testCode ? tests : undefined,
    testsExpected: !!testCode,
    error: hasErrors ? "Compilation failed" : undefined,
    durationMs,
  };
}
