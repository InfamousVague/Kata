import type { RunResult, LogLine } from "./types";

/// In-browser JavaScript / TypeScript runtime.
///
/// User code runs inside a fresh Web Worker so an infinite loop or runaway
/// allocation can't take down the UI (we terminate the worker on timeout).
/// Console methods are proxied so `console.log`, `info`, `warn`, and `error`
/// all surface in the OutputPane instead of the DevTools console.
///
/// V1 supports plain JavaScript. TypeScript is accepted but isn't actually
/// type-stripped — we rely on Monaco to flag errors in the editor, and at
/// runtime we treat TS as JS (types are erased via regex for very simple
/// cases; a full transpile pass would need sucrase/esbuild and is overkill
/// for V1 exercises that don't use decorators/enums).

const TIMEOUT_MS = 5000;

export async function runJavaScript(code: string): Promise<RunResult> {
  return runInWorker(code, /* stripTypes */ false);
}

export async function runTypeScript(code: string): Promise<RunResult> {
  return runInWorker(stripTypeAnnotations(code), /* stripTypes */ true);
}

function runInWorker(code: string, _isTs: boolean): Promise<RunResult> {
  const workerSource = `
    self.onmessage = async (e) => {
      const logs = [];
      const makeLogger = (level) => (...args) => {
        const text = args.map(formatArg).join(' ');
        logs.push({ level, text });
      };
      function formatArg(v) {
        if (v === null) return 'null';
        if (v === undefined) return 'undefined';
        if (typeof v === 'string') return v;
        if (typeof v === 'object') {
          try { return JSON.stringify(v, null, 2); } catch { return String(v); }
        }
        return String(v);
      }
      self.console = {
        log:   makeLogger('log'),
        info:  makeLogger('info'),
        warn:  makeLogger('warn'),
        error: makeLogger('error'),
        debug: makeLogger('log'),
        trace: makeLogger('log'),
      };

      // Provide a tiny CommonJS shim so starter code like
      //   module.exports = { add };
      // doesn't blow up at runtime.
      const module = { exports: {} };
      const exports = module.exports;

      const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      try {
        // AsyncFunction so top-level await works inside exercises.
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const fn = new AsyncFunction('module', 'exports', 'console', e.data.code);
        const result = await fn(module, exports, self.console);

        const end = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        self.postMessage({ logs, durationMs: end - start });

        // Expose the last expression / module.exports in case the test harness
        // (Step 6) wants them. Leaves the worker running briefly for any
        // follow-up invocation; main thread terminates either way.
        void result;
      } catch (err) {
        const end = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        self.postMessage({
          logs,
          error: (err && (err.stack || err.message)) || String(err),
          durationMs: end - start,
        });
      }
    };
  `;

  const blob = new Blob([workerSource], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);

  return new Promise<RunResult>((resolve) => {
    const cleanup = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve({
        logs: [] as LogLine[],
        error: `execution timed out after ${TIMEOUT_MS}ms`,
        durationMs: TIMEOUT_MS,
      });
    }, TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent<RunResult>) => {
      clearTimeout(timeout);
      cleanup();
      resolve(e.data);
    };
    worker.onerror = (e: ErrorEvent) => {
      clearTimeout(timeout);
      cleanup();
      resolve({
        logs: [] as LogLine[],
        error: e.message || "worker error",
        durationMs: 0,
      });
    };

    worker.postMessage({ code });
  });
}

/// Very narrow type-annotation stripper for V1. Handles the simple shapes
/// our exercise starters use: `: string`, `: number`, `: boolean`, and
/// `as Type` casts. A real implementation would use sucrase / esbuild-wasm.
function stripTypeAnnotations(source: string): string {
  return source
    .replace(/\bas\s+[A-Za-z_$][\w$]*\b/g, "") // `as Foo`
    .replace(/:\s*[A-Za-z_$][\w$]*(\[\])?(?=\s*[,)=;]|\s*$)/gm, "");
}
