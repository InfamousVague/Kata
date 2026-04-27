import type { RunResult, LogLine, TestResult } from "./types";

/// Python via Pyodide (CPython compiled to WASM).
///
/// Pyodide is large (~12MB) and ships fully vendored under
/// `public/pyodide/` — Vite serves it same-origin, the Tauri bundle
/// ships it as part of the dist, and the worker `importScripts` it
/// from a relative path. No CDN traffic. First run takes ~3–5s while
/// the worker spins up + Pyodide initializes; subsequent runs are
/// instant because the same worker stays warm.
///
/// Test harness mirrors the JS one: user code is exec'd first into a
/// module-like namespace; if test code is present, a tiny Python harness
/// (`test(name, fn)` + `expect(x)` with `.to_be`, `.to_equal`, ...) gets
/// injected and runs the test file in a namespace that can `from user import X`.

const TIMEOUT_MS = 15000; // Pyodide cold start can be slow

let workerPromise: Promise<Worker> | null = null;

/** Module-level cached Pyodide worker. The same worker stays warm across runs. */
function getWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise;

  // Resolve `/pyodide/pyodide.js` against the page origin so the
  // worker's importScripts (which has its own origin) targets the
  // SAME absolute URL the main thread would have used. Without this
  // an importScripts('/pyodide/pyodide.js') from a Blob-URL worker
  // would resolve relative to the blob: scheme and 404 instantly.
  const pyodideUrl = new URL(
    "/pyodide/pyodide.js",
    window.location.origin,
  ).toString();
  const pyodideRoot = new URL(
    "/pyodide/",
    window.location.origin,
  ).toString();

  const workerSource = `
    importScripts(${JSON.stringify(pyodideUrl)});
    let pyodideReady = (async () => {
      // indexURL tells Pyodide where to fetch its packages, lock file,
      // and side files. Pin to the same vendored root we loaded
      // pyodide.js from so the wasm + lock all come from /pyodide/.
      self.pyodide = await self.loadPyodide({ indexURL: ${JSON.stringify(pyodideRoot)} });
    })();

    self.onmessage = async (e) => {
      await pyodideReady;
      const { id, code, testCode } = e.data;
      const logs = [];
      const tests = [];

      self.pyodide.setStdout({ batched: (s) => logs.push({ level: 'log',   text: s }) });
      self.pyodide.setStderr({ batched: (s) => logs.push({ level: 'error', text: s }) });

      const start = performance.now();

      // Expose a tiny test harness as a Python module-like object. user.py
      // is the user's module; tests can 'from user import foo'.
      const userNs = self.pyodide.toPy({});
      const testsArr = self.pyodide.toPy(tests);

      // Register 'user' and 'kata_test' as importable modules so test code
      // can \`from user import add\` and \`from kata_test import test, expect\`.
      //
      // The worker is cached (module-level \`workerPromise\`), so we get
      // RE-INVOKED across runs. Pyodide's \`registerJsModule\` doesn't
      // cleanly overwrite a module that's already been imported — the
      // previously-imported \`_katahost\` reference stays in
      // \`sys.modules\` and in any closures that captured it. Without the
      // unregister + sys.modules purge below, \`_katahost.pushTest\` on
      // the second run still points at the first run's \`tests\` array,
      // and the caller sees tests=0. Unregister and nuke the cache so
      // the fresh registration wins.
      try { self.pyodide.unregisterJsModule('_katahost'); } catch {}
      self.pyodide.runPython("import sys\\nsys.modules.pop('_katahost', None)\\nsys.modules.pop('kata_test', None)");
      self.pyodide.registerJsModule('_katahost', {
        pushTest: (t) => {
          const plain = t.toJs ? t.toJs({ dict_converter: Object.fromEntries }) : t;
          tests.push(plain);
          if (t.destroy) t.destroy();
        },
      });

      try {
        // ---- User code ----
        // Run user code in its own namespace so we can re-import symbols
        // from it in the test file.
        const setupUser = \`
import sys, types
_user_mod = types.ModuleType('user')
exec(compile(_USER_CODE, 'user.py', 'exec'), _user_mod.__dict__)
sys.modules['user'] = _user_mod
\`;
        self.pyodide.globals.set('_USER_CODE', code);
        self.pyodide.runPython(setupUser);
      } catch (err) {
        self.postMessage({
          id,
          result: {
            logs,
            error: String(err && err.message ? err.message : err),
            durationMs: performance.now() - start,
            testsExpected: !!testCode,
          }
        });
        return;
      }

      if (testCode) {
        try {
          // ---- Test harness + test code ----
          const harnessPy = \`
import types, sys, _katahost

class _Expectation:
    def __init__(self, actual):
        self.actual = actual
    def to_be(self, expected):
        if self.actual != expected:
            raise AssertionError(f"expected {expected!r}, got {self.actual!r}")
    def to_equal(self, expected):
        if self.actual != expected:
            raise AssertionError(f"expected {expected!r}, got {self.actual!r}")
    def to_be_truthy(self):
        if not self.actual:
            raise AssertionError(f"expected truthy, got {self.actual!r}")
    def to_be_falsy(self):
        if self.actual:
            raise AssertionError(f"expected falsy, got {self.actual!r}")
    def to_be_greater_than(self, n):
        if not (self.actual > n):
            raise AssertionError(f"expected > {n}, got {self.actual!r}")
    def to_be_less_than(self, n):
        if not (self.actual < n):
            raise AssertionError(f"expected < {n}, got {self.actual!r}")
    def to_contain(self, item):
        if item not in self.actual:
            raise AssertionError(f"expected {self.actual!r} to contain {item!r}")
    def to_be_none(self):
        if self.actual is not None:
            raise AssertionError(f"expected None, got {self.actual!r}")
    def to_be_close_to(self, expected, digits=2):
        tol = 10 ** (-digits) / 2
        if abs(self.actual - expected) > tol:
            raise AssertionError(f"expected ~{expected}, got {self.actual!r}")

def expect(actual):
    return _Expectation(actual)

def test(name, fn=None):
    def run(inner_fn):
        try:
            inner_fn()
            _katahost.pushTest({"name": name, "passed": True})
        except AssertionError as e:
            _katahost.pushTest({"name": name, "passed": False, "error": str(e)})
        except Exception as e:
            _katahost.pushTest({"name": name, "passed": False, "error": f"{type(e).__name__}: {e}"})
    if fn is not None:
        run(fn)
        return
    # decorator form: @test("name")
    return run

kata_test = types.ModuleType('kata_test')
kata_test.test = test
kata_test.expect = expect
sys.modules['kata_test'] = kata_test
\`;
          self.pyodide.runPython(harnessPy);

          // Make \`test\` and \`expect\` directly importable and also available
          // as globals in the test file namespace for pytest-adjacent ergonomics.
          self.pyodide.globals.set('_TEST_CODE', testCode);
          self.pyodide.runPython(
            "from kata_test import test, expect\\nexec(compile(_TEST_CODE, 'tests.py', 'exec'), {'test': test, 'expect': expect, '__name__': '__tests__'})"
          );
        } catch (err) {
          self.postMessage({
            id,
            result: {
              logs,
              tests,
              error: 'test file error: ' + String(err && err.message ? err.message : err),
              durationMs: performance.now() - start,
              testsExpected: !!testCode,
            }
          });
          return;
        }
      }

      self.postMessage({
        id,
        result: { logs, tests, durationMs: performance.now() - start, testsExpected: !!testCode },
      });
    };
  `;

  const blob = new Blob([workerSource], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  workerPromise = Promise.resolve(worker);
  return workerPromise;
}

let nextId = 0;

export async function runPython(code: string, testCode?: string): Promise<RunResult> {
  const worker = await getWorker();
  const id = ++nextId;

  return new Promise<RunResult>((resolve) => {
    const timeout = setTimeout(() => {
      // Reset the worker — a stuck Python can't be killed cleanly without
      // terminating the whole worker, which would force a cold reload.
      worker.terminate();
      workerPromise = null;
      resolve({
        logs: [] as LogLine[],
        tests: [] as TestResult[],
        error: `execution timed out after ${TIMEOUT_MS}ms (Pyodide cold start can take several seconds on first run)`,
        durationMs: TIMEOUT_MS,
        testsExpected: testCode !== undefined,
      });
    }, TIMEOUT_MS);

    const handler = (e: MessageEvent<{ id: number; result: RunResult }>) => {
      if (e.data.id !== id) return;
      clearTimeout(timeout);
      worker.removeEventListener("message", handler);
      resolve(e.data.result);
    };
    worker.addEventListener("message", handler);
    worker.postMessage({ id, code, testCode });
  });
}
