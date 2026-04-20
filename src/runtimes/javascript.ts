import type { RunResult, LogLine, TestResult } from "./types";

/// In-browser JavaScript / TypeScript runtime.
///
/// User code runs inside a fresh Web Worker so an infinite loop or runaway
/// allocation can't take down the UI (we terminate the worker on timeout).
/// Console methods are proxied so `console.log`, `info`, `warn`, and `error`
/// all surface in the OutputPane instead of the DevTools console.
///
/// When `testCode` is supplied, the worker runs the user code first, captures
/// its `module.exports` into a `userModule`, then injects a tiny Jest-like
/// harness (`test`, `expect`, `require('./user')`) and runs the test file.

const TIMEOUT_MS = 5000;

export async function runJavaScript(code: string, testCode?: string): Promise<RunResult> {
  return runInWorker(code, testCode);
}

export async function runTypeScript(code: string, testCode?: string): Promise<RunResult> {
  return runInWorker(stripTypeAnnotations(code), testCode ? stripTypeAnnotations(testCode) : undefined);
}

function runInWorker(code: string, testCode: string | undefined): Promise<RunResult> {
  const workerSource = `
    self.onmessage = async (e) => {
      const logs = [];
      const tests = [];
      const makeLogger = (level) => (...args) => {
        logs.push({ level, text: args.map(formatArg).join(' ') });
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

      // CommonJS shim — captures the user's exports so the test file can
      // \`require('./user')\` below.
      const userModule = { exports: {} };
      const userExports = userModule.exports;

      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const start = performanceNow();

      try {
        const userFn = new AsyncFunction('module', 'exports', 'console', e.data.code);
        await userFn(userModule, userExports, self.console);
      } catch (err) {
        self.postMessage({
          logs,
          error: formatError(err),
          durationMs: performanceNow() - start,
        });
        return;
      }

      // ---- Test phase (optional) ----
      if (e.data.testCode) {
        const testHarness = makeTestHarness(tests, userModule);
        try {
          const testFn = new AsyncFunction(
            'test', 'it', 'describe', 'expect', 'require', 'console',
            e.data.testCode
          );
          await testFn(
            testHarness.test,
            testHarness.test,       // alias 'it' → 'test'
            testHarness.describe,
            testHarness.expect,
            testHarness.require,
            self.console
          );
        } catch (err) {
          // A thrown error in the test file itself (not a failing assertion)
          self.postMessage({
            logs,
            tests,
            error: 'test file error: ' + formatError(err),
            durationMs: performanceNow() - start,
          });
          return;
        }
      }

      self.postMessage({ logs, tests, durationMs: performanceNow() - start });

      // ---- Helpers defined inside the worker source ----
      function performanceNow() {
        return (typeof performance !== 'undefined' ? performance.now() : Date.now());
      }

      function formatError(err) {
        return (err && (err.stack || err.message)) || String(err);
      }

      function makeTestHarness(results, userModule) {
        const expect = (actual) => ({
          toBe(expected) {
            if (actual !== expected) throw new Error('expected ' + fmt(expected) + ', got ' + fmt(actual));
          },
          toEqual(expected) {
            if (JSON.stringify(actual) !== JSON.stringify(expected))
              throw new Error('expected ' + fmt(expected) + ', got ' + fmt(actual));
          },
          toBeTruthy() {
            if (!actual) throw new Error('expected truthy, got ' + fmt(actual));
          },
          toBeFalsy() {
            if (actual) throw new Error('expected falsy, got ' + fmt(actual));
          },
          toBeGreaterThan(n) {
            if (!(actual > n)) throw new Error('expected > ' + n + ', got ' + fmt(actual));
          },
          toBeLessThan(n) {
            if (!(actual < n)) throw new Error('expected < ' + n + ', got ' + fmt(actual));
          },
          toContain(item) {
            if (!actual || !actual.includes || !actual.includes(item))
              throw new Error('expected ' + fmt(actual) + ' to contain ' + fmt(item));
          },
          toBeCloseTo(expected, digits = 2) {
            const diff = Math.abs(actual - expected);
            const tol = Math.pow(10, -digits) / 2;
            if (diff > tol) throw new Error('expected ~' + expected + ', got ' + fmt(actual));
          },
          toBeNull() {
            if (actual !== null) throw new Error('expected null, got ' + fmt(actual));
          },
          toBeUndefined() {
            if (actual !== undefined) throw new Error('expected undefined, got ' + fmt(actual));
          },
          toThrow() {
            let threw = false;
            try { typeof actual === 'function' && actual(); }
            catch (_) { threw = true; }
            if (!threw) throw new Error('expected function to throw');
          },
        });

        const test = async (name, fn) => {
          try {
            await fn();
            results.push({ name, passed: true });
          } catch (err) {
            results.push({ name, passed: false, error: (err && err.message) || String(err) });
          }
        };

        const describe = async (_name, fn) => { await fn(); };

        const require = (path) => {
          if (path === './user' || path === '../user' || path === 'user')
            return userModule.exports;
          throw new Error("require() only supports './user' in tests (got " + fmt(path) + ')');
        };

        function fmt(v) {
          if (typeof v === 'string') return JSON.stringify(v);
          if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
          return String(v);
        }

        return { test, describe, expect, require };
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
        tests: [] as TestResult[],
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

    worker.postMessage({ code, testCode });
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
