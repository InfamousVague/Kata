//! Shell-out runners for languages that need a real toolchain.
//!
//! The in-browser runtimes (JavaScript, TypeScript, Python) cover most
//! of the course surface, but a serious code-learning app needs C,
//! Java, Kotlin, etc. too. Those languages don't run in a webview so
//! each command here writes the user's source to a temp file, invokes
//! the system toolchain, and hands stdout/stderr back to the frontend
//! as a `SubprocessResult`.
//!
//! Design notes:
//!   - `launch_error` (vs exiting with a non-zero status) signals that
//!     the toolchain couldn't start at all — typically "not on PATH".
//!     The frontend uses this to show a one-click install hint
//!     instead of a wall of stderr.
//!   - We keep compile+run as two stages where it matters (C / C++ /
//!     Java / Assembly) so a compile failure reads clearly in stderr
//!     instead of manifesting as "Java said nothing and exited 1".
//!   - Temp files live in `std::env::temp_dir()` under a
//!     `fishbones-<lang>-run.<ext>` prefix. Each run overwrites, which
//!     is fine because we don't parallelise runs per language.
//!
//! Nothing here knows about lessons or courses — these are thin wrappers
//! around system binaries. The TS runtime dispatcher (`src/runtimes`)
//! is what selects which command to call.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::Instant;

use crate::SubprocessResult;

// ---- Shared helpers --------------------------------------------------

/// Write `code` to a temp file named `fishbones-<prefix>-run.<ext>` and
/// hand back the path. Returns a `SubprocessResult::launch_error` on
/// IO failure so the caller can early-return without duplicating the
/// error-shape assembly.
fn write_temp(prefix: &str, ext: &str, code: &str) -> Result<PathBuf, SubprocessResult> {
    let path = std::env::temp_dir().join(format!("fishbones-{prefix}-run.{ext}"));
    match std::fs::File::create(&path).and_then(|mut f| f.write_all(code.as_bytes())) {
        Ok(()) => Ok(path),
        Err(e) => Err(SubprocessResult {
            stdout: String::new(),
            stderr: String::new(),
            success: false,
            duration_ms: 0,
            launch_error: Some(format!("failed to write temp source: {e}")),
        }),
    }
}

/// Build a `SubprocessResult` from a completed `std::process::Output`.
/// Factored out so the run functions stay readable.
fn from_output(output: Output, start: Instant) -> SubprocessResult {
    SubprocessResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        success: output.status.success(),
        duration_ms: start.elapsed().as_millis() as u64,
        launch_error: None,
    }
}

/// Produce the "toolchain not installed" error with a one-liner install
/// hint tailored to macOS (the primary dev target). Linux users still
/// see the install hint; it just won't match their package manager.
fn launch_failure(toolchain: &str, hint: &str, err: std::io::Error, start: Instant) -> SubprocessResult {
    let msg = if err.kind() == std::io::ErrorKind::NotFound {
        format!("{toolchain} not found on PATH — {hint}")
    } else {
        format!("failed to launch {toolchain}: {err}")
    };
    SubprocessResult {
        stdout: String::new(),
        stderr: String::new(),
        success: false,
        duration_ms: start.elapsed().as_millis() as u64,
        launch_error: Some(msg),
    }
}

/// Chain a compile step + run step into one result. The compile step
/// dominates user-visible latency for most of these languages, so we
/// keep its stderr in the final result (otherwise a syntax error looks
/// like "the program printed nothing"). If compilation fails, we skip
/// the run step entirely.
///
/// Both the compile and run phase are also fed through
/// `maybe_stub_launch_failure`: on macOS, `/usr/bin/java`, `/usr/bin/javac`,
/// and `kotlinc` are shipped as stubs that print a "please install"
/// message and exit non-zero when no JDK is present. From Rust's
/// perspective the subprocess DID launch successfully, so the plain
/// `ErrorKind::NotFound` branch doesn't fire — we have to pattern-match
/// the stderr ourselves to upgrade it into a `launch_error`, which is
/// what the frontend keys off to surface the install-toolchain banner.
fn compile_then_run(
    compile: Command,
    run_cmd: Command,
    toolchain: &str,
    install_hint: &str,
    start: Instant,
) -> SubprocessResult {
    let mut compile = compile;
    let mut run_cmd = run_cmd;

    let compile_out = match compile.output() {
        Ok(o) => o,
        Err(e) => return launch_failure(toolchain, install_hint, e, start),
    };
    if !compile_out.status.success() {
        let stderr = String::from_utf8_lossy(&compile_out.stderr).into_owned();
        if let Some(stub) = maybe_stub_launch_failure(toolchain, install_hint, &stderr, start) {
            return stub;
        }
        return SubprocessResult {
            stdout: String::from_utf8_lossy(&compile_out.stdout).into_owned(),
            stderr,
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: None,
        };
    }
    match run_cmd.output() {
        Ok(out) => {
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
                if let Some(stub) = maybe_stub_launch_failure(toolchain, install_hint, &stderr, start) {
                    return stub;
                }
            }
            from_output(out, start)
        }
        Err(e) => launch_failure(toolchain, install_hint, e, start),
    }
}

/// Detect the macOS "please install" stub messages that `java`, `javac`,
/// and `kotlinc` emit when invoked without a JDK installed. These stubs
/// live at `/usr/bin/java` etc. and are happy to launch — they just
/// print a helpful-for-Finder-but-useless-to-us message and exit 1.
/// Without this upgrade the frontend would render the macOS stub text
/// as a plain red "error" block and the learner would have no path to
/// fixing it; with this, we convert the failure into a `launch_error`
/// so the existing missing-toolchain banner + install button path picks
/// it up. Returns `Some(SubprocessResult)` if the stderr matches one of
/// the known stubs, `None` otherwise.
fn maybe_stub_launch_failure(
    toolchain: &str,
    install_hint: &str,
    stderr: &str,
    start: Instant,
) -> Option<SubprocessResult> {
    // macOS Java stub. Both `java` and `javac` go through
    // /usr/libexec/java_home, which emits this exact string. Kotlin's
    // `kotlinc` shells out to the JDK and surfaces the same message.
    const JAVA_STUB_MARKERS: &[&str] = &[
        "Unable to locate a Java Runtime",
        "No Java runtime present",
        "to locate a Java Runtime",
    ];
    if JAVA_STUB_MARKERS.iter().any(|m| stderr.contains(m)) {
        return Some(SubprocessResult {
            stdout: String::new(),
            stderr: String::new(),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: Some(format!(
                "{toolchain} is installed as a macOS stub but no JDK is present — {install_hint}"
            )),
        });
    }
    None
}

// ---- C --------------------------------------------------------------

/// Compile + run C via the system `cc` (usually clang on macOS, gcc on
/// Linux). `-O0` keeps compile times snappy for small lesson snippets;
/// optimisation doesn't help a "hello world" kata.
#[tauri::command]
pub async fn run_c(code: String) -> SubprocessResult {
    let start = Instant::now();
    let source = match write_temp("c", "c", &code) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let binary = source.with_extension("out");
    let mut compile = Command::new("cc");
    compile
        .arg("-O0")
        .arg("-o")
        .arg(&binary)
        .arg(&source);
    let run_cmd = Command::new(&binary);
    compile_then_run(
        compile,
        run_cmd,
        "cc",
        "install Xcode Command Line Tools (`xcode-select --install`) or a system C compiler.",
        start,
    )
}

// ---- C++ ------------------------------------------------------------

/// C++ via `c++` (symlinked to clang++ on macOS, g++ on most Linux).
/// Same latency trade-off as C — single source, minimal flags.
#[tauri::command]
pub async fn run_cpp(code: String) -> SubprocessResult {
    let start = Instant::now();
    let source = match write_temp("cpp", "cpp", &code) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let binary = source.with_extension("out");
    let mut compile = Command::new("c++");
    compile
        .arg("-O0")
        .arg("-std=c++17")
        .arg("-o")
        .arg(&binary)
        .arg(&source);
    let run_cmd = Command::new(&binary);
    compile_then_run(
        compile,
        run_cmd,
        "c++",
        "install Xcode Command Line Tools (`xcode-select --install`) or a system C++ compiler.",
        start,
    )
}

// ---- Java -----------------------------------------------------------

/// Java requires `public class Foo` to live in `Foo.java`. We parse the
/// class name out of the source so the user can write whichever name
/// they want — we then rename the temp file to match. If no public
/// class is declared we fall back to `App` (and write `App.java`) which
/// covers `class App` + static-main snippets.
#[tauri::command]
pub async fn run_java(code: String) -> SubprocessResult {
    let start = Instant::now();
    let class_name = extract_java_class_name(&code).unwrap_or_else(|| "App".to_string());

    // Java is picky about filename-vs-classname, so we write under a
    // per-run temp directory to keep the flat `/tmp` namespace clean.
    let dir = std::env::temp_dir().join("fishbones-java-run");
    let _ = std::fs::remove_dir_all(&dir); // best-effort: drop the previous build
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return SubprocessResult {
            stdout: String::new(),
            stderr: String::new(),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: Some(format!("failed to create temp dir: {e}")),
        };
    }
    let source = dir.join(format!("{class_name}.java"));
    if let Err(e) = std::fs::File::create(&source).and_then(|mut f| f.write_all(code.as_bytes())) {
        return SubprocessResult {
            stdout: String::new(),
            stderr: String::new(),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: Some(format!("failed to write temp source: {e}")),
        };
    }

    let mut compile = Command::new("javac");
    compile.arg(&source);
    let mut run_cmd = Command::new("java");
    run_cmd.arg("-cp").arg(&dir).arg(&class_name);
    compile_then_run(
        compile,
        run_cmd,
        "javac",
        "install a JDK (`brew install openjdk` on macOS) and make sure `javac` + `java` are on PATH.",
        start,
    )
}

/// Pull the first `public class <Name>` (or bare `class <Name>`) from
/// a Java source string. Ignores anything inside `//` or `/* */`
/// comments — minimal parse, but enough to survive template headers.
fn extract_java_class_name(code: &str) -> Option<String> {
    // Strip line + block comments first. Simple regex-free approach:
    // find `public class <Name>` / `class <Name>` anywhere. This is
    // good enough for snippets; a full parser would be overkill.
    for token in ["public class ", "public final class ", "class "] {
        if let Some(idx) = code.find(token) {
            let rest = &code[idx + token.len()..];
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
                .collect();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

// ---- Kotlin ---------------------------------------------------------

/// Kotlin via `kotlinc -include-runtime` + `java -jar`. App mode, not
/// script mode: the challenge packs (and the `generate_challenge`
/// prompt) produce code that uses `fun main()` as the entry point —
/// and in .kts script mode main() is treated as just another function
/// that never gets called, so stdout stays empty and the test
/// harness's KATA_TEST lines never fire. Compiling to a self-contained
/// jar + `java -jar` honours the main() entry.
///
/// Two-stage slow: `kotlinc` cold-starts a JVM (~3s) to compile, then
/// `java -jar` boots a second JVM (~0.5s) to run. Total 3-5s per run
/// is the cost of actually respecting the language's entry-point
/// contract.
#[tauri::command]
pub async fn run_kotlin(code: String) -> SubprocessResult {
    let start = Instant::now();
    // Dedicated dir so the jar + source don't clutter /tmp. Best-effort
    // cleanup of the previous run — same pattern as `run_java`.
    let dir = std::env::temp_dir().join("fishbones-kotlin-run");
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return SubprocessResult {
            stdout: String::new(),
            stderr: String::new(),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: Some(format!("failed to create temp dir: {e}")),
        };
    }
    let source = dir.join("Main.kt");
    if let Err(e) = std::fs::File::create(&source).and_then(|mut f| f.write_all(code.as_bytes())) {
        return SubprocessResult {
            stdout: String::new(),
            stderr: String::new(),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: Some(format!("failed to write temp source: {e}")),
        };
    }
    let jar = dir.join("main.jar");

    // Pick absolute paths for kotlinc + java that survived a version
    // probe — `find_binary_all(...).next()` would blindly return the
    // first candidate (often `/usr/bin/java`, the macOS stub), and
    // spawning that either errors noisily or hangs the app while macOS
    // pops its "install a JDK" Software Update modal. `find_working_
    // binary` runs `-version` against each candidate and returns only
    // one that actually launched. Fall back to the bare name if
    // nothing worked — `Command::new` will then fail fast with
    // ErrorKind::NotFound and the stub-detection path surfaces the
    // install banner.
    let kotlinc_path = crate::toolchain::find_working_binary("kotlinc", &["-version"])
        .unwrap_or_else(|| "kotlinc".to_string());
    let java_path = crate::toolchain::find_working_binary("java", &["-version"])
        .unwrap_or_else(|| "java".to_string());
    let broadened = crate::toolchain::broadened_path();
    let java_home = java_home_for(&java_path);

    let mut compile = Command::new(&kotlinc_path);
    compile
        .env("PATH", &broadened)
        .arg("-include-runtime")
        .arg("-d")
        .arg(&jar)
        .arg(&source);
    if let Some(ref home) = java_home {
        compile.env("JAVA_HOME", home);
    }
    let mut run_cmd = Command::new(&java_path);
    run_cmd.env("PATH", &broadened).arg("-jar").arg(&jar);
    if let Some(ref home) = java_home {
        run_cmd.env("JAVA_HOME", home);
    }
    compile_then_run(
        compile,
        run_cmd,
        "kotlinc",
        "install Kotlin (`brew install kotlin` on macOS) and a JDK (`brew install openjdk`). Both `kotlinc` and `java` must be on PATH.",
        start,
    )
}

/// Given a working `java` binary path, walk up to its JDK root so we
/// can set `JAVA_HOME`. A Homebrew openjdk install lives at
/// `/opt/homebrew/opt/openjdk/bin/java` with the JDK home at
/// `/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home`, but
/// we conservatively walk `bin/..` first which works for most
/// distributions (Linux `/usr/lib/jvm/*/bin/java` too). Returns None
/// when we can't derive a plausible home — caller falls back to not
/// setting JAVA_HOME rather than pointing it at the wrong thing.
fn java_home_for(java_path: &str) -> Option<String> {
    let p = std::path::Path::new(java_path);
    // Resolve symlinks so `/opt/homebrew/opt/openjdk/bin/java` lands on
    // the real Cellar entry. If canonicalize fails (permission, broken
    // link), fall back to the original path.
    let real = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    // Typical layout: <JAVA_HOME>/bin/java. Two `parent()` hops up.
    let home = real.parent()?.parent()?;
    if home.join("bin").join("java").exists() {
        return Some(home.to_string_lossy().into_owned());
    }
    None
}

// ---- C# -------------------------------------------------------------

/// C# via `dotnet script` (the community `dotnet-script` global tool,
/// installed with `dotnet tool install -g dotnet-script`). That tool
/// is the only low-friction way to run a single `.csx` file without
/// scaffolding a project. If it's missing we surface an install hint
/// pointing at the `dotnet tool install` command.
#[tauri::command]
pub async fn run_csharp(code: String) -> SubprocessResult {
    let start = Instant::now();
    let source = match write_temp("csharp", "csx", &code) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let output = match Command::new("dotnet").arg("script").arg(&source).output() {
        Ok(o) => o,
        Err(e) => {
            return launch_failure(
                "dotnet",
                "install the .NET SDK (`brew install --cask dotnet-sdk` on macOS), then `dotnet tool install -g dotnet-script`.",
                e,
                start,
            );
        }
    };
    // `dotnet script` itself prints an error message if the
    // `dotnet-script` subcommand isn't installed — pass that through
    // verbatim so the user sees exactly what dotnet said to do.
    from_output(output, start)
}

// ---- Assembly -------------------------------------------------------

/// Assembly: assemble with `as`, link with `ld`, run the executable.
/// We target the host architecture with whatever syscall ABI the user
/// wrote — this isn't an emulator, just a thin shell over the native
/// tools. Keeps lessons honest (users see real-world linker errors)
/// at the cost of a learning curve for absolute beginners.
///
/// Linker flags differ between macOS (needs `-lSystem` + SDK path) and
/// Linux (nothing extra). We detect at runtime via `cfg!(target_os)`
/// so a single binary works on either host without the user having to
/// pick a variant.
#[tauri::command]
pub async fn run_asm(code: String) -> SubprocessResult {
    let start = Instant::now();
    let source = match write_temp("asm", "s", &code) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let obj_path = source.with_extension("o");
    let bin_path = source.with_extension("out");

    // Assemble.
    let mut assemble = Command::new("as");
    assemble.arg("-o").arg(&obj_path).arg(&source);
    let assemble_out = match assemble.output() {
        Ok(o) => o,
        Err(e) => {
            return launch_failure(
                "as",
                "install a system assembler (Xcode Command Line Tools on macOS, `binutils` on Linux).",
                e,
                start,
            );
        }
    };
    if !assemble_out.status.success() {
        // Prefix stderr with a stage marker so the output pane makes
        // it obvious WHICH step failed. Falls back to a hint when the
        // toolchain exits non-zero with no error text — common on
        // Intel Macs where the default arm64 template won't assemble.
        let raw = String::from_utf8_lossy(&assemble_out.stderr).into_owned();
        let body = if raw.trim().is_empty() {
            "assembler produced no output. If you're on an Intel Mac, the default template uses arm64 syscalls — rewrite it for x86_64 or switch hosts.".to_string()
        } else {
            raw
        };
        return SubprocessResult {
            stdout: String::from_utf8_lossy(&assemble_out.stdout).into_owned(),
            stderr: format!("as (assemble) failed: {}\n{}", assemble_out.status, body),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: None,
        };
    }

    // Link. macOS wants `-lSystem` + the SDK path; Linux just needs
    // the object file. We keep the entry symbol as the default (`_main`
    // on macOS, `_start` on Linux) so users write the ABI they expect.
    let mut link = Command::new("ld");
    link.arg("-o").arg(&bin_path).arg(&obj_path);
    if cfg!(target_os = "macos") {
        link.arg("-lSystem");
        // `xcrun --show-sdk-path` points at the active SDK's Frameworks
        // directory, which `ld` needs as `-syslibroot` on modern Xcode.
        if let Ok(out) = Command::new("xcrun")
            .args(["-sdk", "macosx", "--show-sdk-path"])
            .output()
        {
            if out.status.success() {
                let sdk = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !sdk.is_empty() {
                    link.arg("-syslibroot").arg(sdk);
                }
            }
        }
    }

    let link_out = match link.output() {
        Ok(o) => o,
        Err(e) => {
            return launch_failure(
                "ld",
                "install the linker (Xcode Command Line Tools on macOS, `binutils` on Linux).",
                e,
                start,
            );
        }
    };
    if !link_out.status.success() {
        let raw = String::from_utf8_lossy(&link_out.stderr).into_owned();
        let body = if raw.trim().is_empty() {
            "linker produced no output. Check that your entry symbol matches the platform (`_main` on macOS, `_start` on Linux).".to_string()
        } else {
            raw
        };
        return SubprocessResult {
            stdout: String::from_utf8_lossy(&link_out.stdout).into_owned(),
            stderr: format!("ld (link) failed: {}\n{}", link_out.status, body),
            success: false,
            duration_ms: start.elapsed().as_millis() as u64,
            launch_error: None,
        };
    }

    // Run.
    let run_out = match Command::new(&bin_path).output() {
        Ok(o) => o,
        Err(e) => {
            return launch_failure(
                bin_path.to_string_lossy().as_ref(),
                "built but couldn't execute — check the binary's permissions.",
                e,
                start,
            );
        }
    };
    // A successful assemble+link run is a success even if the user's program
    // exits non-zero — exit codes are meaningful output for low-level code
    // (the default template deliberately returns 42 to demonstrate the exit
    // syscall). Surface the exit code in stdout so it renders as program
    // output instead of a generic "no output captured" error.
    let stdout = String::from_utf8_lossy(&run_out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&run_out.stderr).into_owned();
    let code_note = match run_out.status.code() {
        Some(c) if c != 0 => format!(
            "{}program exited with code {c}\n",
            if stdout.is_empty() { "" } else { "\n" },
        ),
        _ => String::new(),
    };
    SubprocessResult {
        stdout: format!("{stdout}{code_note}"),
        stderr,
        success: true,
        duration_ms: start.elapsed().as_millis() as u64,
        launch_error: None,
    }
}

// ── 2026 expansion: simple-CLI runners ─────────────────────────────
//
// Five languages whose toolchain is "one binary takes a source file
// and runs it" — Ruby (`ruby`), Elixir (`elixir`), Haskell
// (`runghc` from GHC), Scala (`scala-cli`), and Dart (`dart`). No
// compile step, no per-language temp directory, no class-name
// parsing. Each just shells out via `simple_run_one_file` below.
//
// Languages that need a project structure (Move, Cairo, Sway —
// each looks for a manifest file at the working dir) are NOT here;
// they remain as "coming soon" stubs in the JS layer until we wire
// per-Run scaffolding (write a Cargo.toml-equivalent + invoke the
// project-aware CLI).

/// Generic single-file CLI runner: write `code` to a temp file with
/// the given extension, then exec `binary <args> <temp>` — capture
/// stdout/stderr, surface launch failures with a friendly install
/// hint. Used by every simple-CLI-shaped language below.
fn simple_run_one_file(
    binary: &str,
    extra_args: &[&str],
    prefix: &str,
    extension: &str,
    install_hint: &str,
    code: String,
) -> SubprocessResult {
    let start = Instant::now();
    let source = match write_temp(prefix, extension, &code) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let mut cmd = Command::new(binary);
    for a in extra_args {
        cmd.arg(a);
    }
    cmd.arg(&source);
    match cmd.output() {
        Ok(o) => from_output(o, start),
        Err(e) => launch_failure(binary, install_hint, e, start),
    }
}

// ---- Ruby -----------------------------------------------------------

/// `ruby <file>`. macOS ships a system Ruby (Apple's bundled MRI)
/// that's installed by default; on Linux it's a one-liner via the
/// distro package manager.
#[tauri::command]
pub async fn run_ruby(code: String) -> SubprocessResult {
    simple_run_one_file(
        "ruby",
        &[],
        "ruby",
        "rb",
        "install Ruby (`brew install ruby` / `apt install ruby`).",
        code,
    )
}

// ---- Elixir ---------------------------------------------------------

/// `elixir <file>`. Lessons use `.exs` (Elixir script) so we don't
/// require a Mix project. Pure module-level expressions work fine
/// at this size.
#[tauri::command]
pub async fn run_elixir(code: String) -> SubprocessResult {
    simple_run_one_file(
        "elixir",
        &[],
        "elixir",
        "exs",
        "install Elixir (`brew install elixir` on macOS, `asdf install elixir` for cross-platform).",
        code,
    )
}

// ---- Haskell --------------------------------------------------------

/// `runghc <file>`. `runghc` is bundled with every GHC install and
/// runs Haskell as a script (compile+run in one shot, throws away
/// the binary). For lesson-sized snippets that's the right choice
/// — `ghc` would leave .hi / .o droppings beside the temp source.
#[tauri::command]
pub async fn run_haskell(code: String) -> SubprocessResult {
    simple_run_one_file(
        "runghc",
        &[],
        "haskell",
        "hs",
        "install GHC via GHCup (`curl --proto '=https' --tlsv1.2 -sSf https://get-ghcup.haskell.org | sh`).",
        code,
    )
}

// ---- Scala ----------------------------------------------------------

/// `scala-cli run <file>`. scala-cli is the modern recommended way
/// to run Scala scripts — it handles dependency resolution + JVM
/// boot automatically. The classic `scala` REPL would also work
/// but scala-cli is the path Scala 3 docs steer learners toward.
#[tauri::command]
pub async fn run_scala(code: String) -> SubprocessResult {
    simple_run_one_file(
        "scala-cli",
        &["run"],
        "scala",
        "scala",
        "install scala-cli (`brew install Virtuslab/scala-cli/scala-cli` or see https://scala-cli.virtuslab.org/install).",
        code,
    )
}

// ---- Dart -----------------------------------------------------------

/// `dart run <file>`. The `dart` command resolves to the Dart SDK
/// binary; `run <file>` executes a single .dart entrypoint without
/// requiring a `pubspec.yaml`. Most lesson-sized programs work.
#[tauri::command]
pub async fn run_dart(code: String) -> SubprocessResult {
    simple_run_one_file(
        "dart",
        &["run"],
        "dart",
        "dart",
        "install the Dart SDK (`brew install dart-sdk` or see https://dart.dev/get-dart).",
        code,
    )
}

// ---- Zig ------------------------------------------------------------

/// `zig run <file>`. Compiles + executes the user's program in one
/// shot. Zig's compiler is a single binary distributed via tarball;
/// the install hint points to the official downloads page since
/// platform package managers don't always ship the latest. Output
/// from `std.debug.print` lands on stderr — both stdout and stderr
/// are captured by `from_output` and the JS-side parser scans both
/// streams for `KATA_TEST::` lines.
///
/// Source pre-processing: lessons author plain function definitions
/// + a `// CASES: [["name","fnName"], ...]` comment (or just rely on
/// `fn test*()` auto-detection). `preprocess_zig_source` strips any
/// pre-existing `pub fn main` / `fn runTest` blocks, then appends a
/// generated harness that uses `std.debug.print` (works in every
/// recent Zig version, unlike `std.io.getStdOut()` which Zig 0.16
/// removed). One source-of-truth for the I/O shape means we don't
/// have to rewrite 120 lessons every time the Zig stdlib reshuffles.
#[tauri::command]
pub async fn run_zig(code: String) -> SubprocessResult {
    let prepared = preprocess_zig_source(&code);
    simple_run_one_file(
        "zig",
        &["run"],
        "zig",
        "zig",
        "install Zig (`brew install zig` on macOS, or grab a tarball from https://ziglang.org/download/).",
        prepared,
    )
}

/// Transform a Zig lesson's source into something runnable on the
/// `zig run` happy path. Returns the original verbatim when the
/// source already has a `pub fn main` AND no `fn test*` — i.e. a
/// pure playground run with no tests. Otherwise strips any
/// pre-existing main / runTest helpers and appends a freshly
/// generated harness.
fn preprocess_zig_source(code: &str) -> String {
    // Find every `fn test...(` declaration so we know what tests
    // exist regardless of whether the lesson author shipped a CASES
    // comment.
    let auto_test_fns: Vec<String> = scan_test_fn_names(code);
    let cases_from_comment = parse_cases_comment(code);
    let cases_from_runtest = parse_runtest_calls(code);

    // Pick the case list with priority:
    //   1. explicit CASES comment (LLM-emitted lessons)
    //   2. existing runTest(...) calls inside the user's main
    //      (the original 5 hand-authored lessons)
    //   3. auto-detected test fn names
    // If we have NO test fns at all, return the source unchanged —
    // it's a playground / smoke run with the user's own main.
    let cases: Vec<(String, String)> = if !cases_from_comment.is_empty() {
        cases_from_comment
    } else if !cases_from_runtest.is_empty() {
        cases_from_runtest
    } else if !auto_test_fns.is_empty() {
        auto_test_fns
            .iter()
            .map(|fn_name| {
                let display = fn_name.strip_prefix("test").unwrap_or(fn_name);
                let snake = pascal_to_snake(display);
                let snake = if snake.is_empty() { fn_name.clone() } else { snake };
                (snake, fn_name.clone())
            })
            .collect()
    } else {
        return code.to_string();
    };

    // Strip any user-supplied main / runTest blocks so we don't get
    // duplicate-definition errors when we append our own.
    let stripped = strip_top_level_block(code, "pub fn main");
    let stripped = strip_top_level_block(&stripped, "fn runTest");

    // Generate the harness. We use a name-mangled `_kata_std` import
    // so we can't collide with the user's own `const std =
    // @import("std");`.
    let mut harness = String::from(
        "\n\n// ── Kata harness (auto-generated) ──\n\
         const _kata_std_ = @import(\"std\");\n\n\
         pub fn main() void {\n",
    );
    for (name, fn_name) in &cases {
        let safe_name = name.replace('"', "\\\"");
        harness.push_str(&format!(
            "    _kataRunTest_(\"{safe_name}\", &{fn_name});\n"
        ));
    }
    harness.push_str(
        "}\n\n\
         fn _kataRunTest_(name: []const u8, body_fn: *const fn () anyerror!void) void {\n\
        \x20   if (body_fn()) |_| {\n\
        \x20       _kata_std_.debug.print(\"KATA_TEST::{s}::PASS\\n\", .{name});\n\
        \x20   } else |err| {\n\
        \x20       _kata_std_.debug.print(\"KATA_TEST::{s}::FAIL::{s}\\n\", .{ name, @errorName(err) });\n\
        \x20   }\n\
         }\n",
    );

    format!("{stripped}{harness}")
}

/// Scan for `fn test\w+\(\) !void` declarations. Returns the function
/// names in source order. Matches both `fn testFoo()` and
/// `pub fn testFoo()` since occasional lessons emit either.
fn scan_test_fn_names(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut search_from = 0usize;
    let bytes = code.as_bytes();
    loop {
        let Some(idx) = code[search_from..].find("fn test") else {
            break;
        };
        let abs = search_from + idx;
        // Ensure `fn` is a real keyword — preceded by whitespace,
        // newline, or `pub `.
        let prev_ok = abs == 0
            || matches!(
                bytes[abs - 1],
                b' ' | b'\t' | b'\n' | b'\r' | b';' | b'}'
            );
        if !prev_ok {
            search_from = abs + 2;
            continue;
        }
        // Walk past `fn ` to the function name.
        let after_fn = abs + 3;
        let name_start = after_fn;
        let mut name_end = name_start;
        while name_end < bytes.len() && is_zig_ident_byte(bytes[name_end]) {
            name_end += 1;
        }
        if name_end > name_start {
            let name = &code[name_start..name_end];
            // Only record the ones that actually start with "test"
            // (case-sensitive, matches Zig convention).
            if name.starts_with("test") {
                out.push(name.to_string());
            }
        }
        search_from = name_end;
    }
    // Dedupe in case a name appears more than once (defensive).
    out.dedup();
    out
}

fn is_zig_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Parse a `// CASES: [["name","fnName"], ...]` comment if present.
/// Returns an empty vec when not found OR when the JS-array shape is
/// malformed — silent fallback so a botched comment doesn't kill the
/// whole run; auto-detected names take over.
fn parse_cases_comment(code: &str) -> Vec<(String, String)> {
    let Some(start) = code.find("// CASES:") else {
        return Vec::new();
    };
    // Find the line ending so we don't accidentally span beyond.
    let line_end = code[start..]
        .find('\n')
        .map(|n| start + n)
        .unwrap_or(code.len());
    let line = &code[start..line_end];
    let Some(open) = line.find('[') else {
        return Vec::new();
    };
    let Some(close) = line.rfind(']') else {
        return Vec::new();
    };
    if close <= open {
        return Vec::new();
    }
    let body = &line[open..=close];
    parse_pair_list(body)
}

/// Parse `[["a","fa"], ["b","fb"]]` into a list of (a, fa) pairs.
/// Walks byte-by-byte: find `[`, skip whitespace, expect a quoted
/// string (the case label), then a comma + another quoted string
/// (the test fn name), then `]`. Skips any prefix `[` that doesn't
/// open a valid pair (so the outer `[` of `[["a","b"]]` is harmlessly
/// consumed before we land on the inner one).
fn parse_pair_list(s: &str) -> Vec<(String, String)> {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    'outer: while i < bytes.len() {
        // Find next `[`.
        while i < bytes.len() && bytes[i] != b'[' {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        i += 1; // consume `[`
        // Skip whitespace.
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        // Need `"` — the start of the case label. If not, it's the
        // outer wrapper bracket; loop back to find the inner one.
        if i >= bytes.len() || bytes[i] != b'"' {
            continue 'outer;
        }
        i += 1;
        let s1_start = i;
        while i < bytes.len() && bytes[i] != b'"' {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let s1 = std::str::from_utf8(&bytes[s1_start..i])
            .unwrap_or("")
            .to_string();
        i += 1; // closing `"`
        // Skip past comma + whitespace, expect another `"`.
        while i < bytes.len() && bytes[i] != b'"' && bytes[i] != b']' {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] == b']' {
            continue 'outer;
        }
        i += 1;
        let s2_start = i;
        while i < bytes.len() && bytes[i] != b'"' {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let s2 = std::str::from_utf8(&bytes[s2_start..i])
            .unwrap_or("")
            .to_string();
        i += 1;
        if !s1.is_empty() && !s2.is_empty() {
            out.push((s1, s2));
        }
    }
    out
}

/// Parse `runTest(out, "name", &fnName) catch {};` style calls inside
/// the user's main(). Returns (name, fn) pairs in source order.
fn parse_runtest_calls(code: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut search_from = 0usize;
    while let Some(idx) = code[search_from..].find("runTest(") {
        let start = search_from + idx + "runTest(".len();
        let line_end = code[start..]
            .find('\n')
            .map(|n| start + n)
            .unwrap_or(code.len());
        let segment = &code[start..line_end];
        // Pull the first quoted string and the next `&IDENT` token.
        let Some(q1) = segment.find('"') else {
            search_from = start;
            continue;
        };
        let Some(q2) = segment[q1 + 1..].find('"') else {
            search_from = start;
            continue;
        };
        let name = &segment[q1 + 1..q1 + 1 + q2];
        let Some(amp) = segment[q1 + 1 + q2..].find('&') else {
            search_from = start;
            continue;
        };
        let amp_abs = q1 + 1 + q2 + amp + 1;
        let bytes = segment.as_bytes();
        let mut end = amp_abs;
        while end < bytes.len() && is_zig_ident_byte(bytes[end]) {
            end += 1;
        }
        if end > amp_abs {
            let fn_name = &segment[amp_abs..end];
            out.push((name.to_string(), fn_name.to_string()));
        }
        search_from = start + segment.len();
    }
    out
}

/// Strip the first top-level block whose opening line starts with
/// `prefix` (e.g. `pub fn main`, `fn runTest`). Walks balanced
/// `{` / `}` to find the matching closer, ignoring braces that
/// appear inside `// ...` line comments and string literals (but
/// not block comments — Zig lessons rarely nest those, and missing
/// the edge case just means we leave a few extra lines in the
/// stripped output, which is harmless because the harness names are
/// mangled).
fn strip_top_level_block(code: &str, prefix: &str) -> String {
    let Some(start) = code.find(prefix) else {
        return code.to_string();
    };
    let bytes = code.as_bytes();
    // Find the opening `{` on or after `start`.
    let mut i = start + prefix.len();
    while i < bytes.len() && bytes[i] != b'{' {
        i += 1;
    }
    if i >= bytes.len() {
        return code.to_string();
    }
    // Walk balanced braces.
    let mut depth = 0i32;
    let mut in_string = false;
    let mut in_line_comment = false;
    let body_start = i;
    while i < bytes.len() {
        let b = bytes[i];
        if in_line_comment {
            if b == b'\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }
        if in_string {
            if b == b'\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if b == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            in_line_comment = true;
            i += 2;
            continue;
        }
        if b == b'"' {
            in_string = true;
            i += 1;
            continue;
        }
        if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            depth -= 1;
            if depth == 0 {
                let block_end = i + 1;
                // Strip from `start` to block_end (inclusive).
                let mut out = String::with_capacity(code.len());
                out.push_str(&code[..start]);
                // Trim trailing whitespace before the strip target so
                // we don't leave a hole of blank lines.
                while out.ends_with('\n') || out.ends_with(' ') {
                    out.pop();
                }
                out.push('\n');
                out.push_str(&code[block_end..]);
                return out;
            }
        }
        i += 1;
    }
    // Unbalanced braces — leave the source alone.
    let _ = body_start;
    code.to_string()
}

/// "FooBar" → "foo_bar". Used to derive a kata test name when only
/// the fn identifier is available (no CASES comment, no existing
/// runTest call). Pure ASCII, matches the kata id grammar `[\w-]+`.
fn pascal_to_snake(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for (i, c) in s.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

// ---- Silence unused-import in builds where none of the commands are
// actually wired yet. Harmless in production.
#[allow(dead_code)]
fn _silence_unused_path_import(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preprocess_lesson_with_existing_main() {
        let src = r#"
pub fn greeting() []const u8 { return "Hello, world!"; }

const std_kata = @import("std");

fn testGreets() !void {
    if (greeting().len == 0) return error.WrongAnswer;
}

fn runTest(out: anytype, name: []const u8, body_fn: *const fn () anyerror!void) !void {
    _ = out; _ = name; _ = body_fn;
}

pub fn main() !void {
    const out = std_kata.io.getStdOut().writer();
    runTest(out, "greets", &testGreets) catch {};
}
"#;
        let out = preprocess_zig_source(src);
        // The user's main and runTest should be gone.
        assert!(
            !out.contains("std_kata.io.getStdOut"),
            "stale main not stripped:\n{out}"
        );
        assert!(
            !out.contains("fn runTest("),
            "stale runTest not stripped:\n{out}"
        );
        // The harness should run testGreets.
        assert!(out.contains("&testGreets"), "harness call missing:\n{out}");
        assert!(out.contains("\"greets\""), "case name lost:\n{out}");
        assert!(
            out.contains("_kata_std_.debug.print"),
            "harness print missing:\n{out}"
        );
    }

    #[test]
    fn preprocess_lesson_with_cases_comment() {
        let src = r#"
const std = @import("std");

pub fn doubleIt(x: i32) i32 { return x * 2; }

fn testDoublesPositive() !void {
    if (doubleIt(5) != 10) return error.WrongAnswer;
}

fn testDoublesNegative() !void {
    if (doubleIt(-3) != -6) return error.WrongAnswer;
}

// CASES: [["positive", "testDoublesPositive"], ["negative", "testDoublesNegative"]]
"#;
        let out = preprocess_zig_source(src);
        assert!(out.contains("&testDoublesPositive"));
        assert!(out.contains("&testDoublesNegative"));
        assert!(out.contains("\"positive\""));
        assert!(out.contains("\"negative\""));
    }

    #[test]
    fn preprocess_lesson_with_no_cases_no_main_autodetects() {
        let src = r#"
pub fn squareIt(x: i32) i32 { return x * x; }

fn testBasic() !void {
    if (squareIt(3) != 9) return error.WrongAnswer;
}
fn testZero() !void {
    if (squareIt(0) != 0) return error.WrongAnswer;
}
"#;
        let out = preprocess_zig_source(src);
        assert!(out.contains("&testBasic"));
        assert!(out.contains("&testZero"));
        // PascalCase → snake_case via the auto-naming path.
        assert!(out.contains("\"basic\""));
        assert!(out.contains("\"zero\""));
    }

    #[test]
    fn preprocess_playground_run_left_alone() {
        // No test functions and no CASES → playground run, leave it.
        let src = r#"
const std = @import("std");
pub fn main() !void {
    std.debug.print("hello\n", .{});
}
"#;
        let out = preprocess_zig_source(src);
        // The user's own main must survive untouched.
        assert!(out.contains("pub fn main()"));
        assert!(!out.contains("_kataRunTest_"));
    }

    #[test]
    fn pascal_to_snake_basic() {
        assert_eq!(pascal_to_snake("FooBar"), "foo_bar");
        assert_eq!(pascal_to_snake("ABC"), "a_b_c");
        assert_eq!(pascal_to_snake("a"), "a");
        assert_eq!(pascal_to_snake(""), "");
    }

    /// End-to-end: take a lesson's merged source, run it through the
    /// preprocessor, write to a temp file, and exec `zig run`. Skips
    /// (no-op pass) when zig isn't on PATH so CI without zig still
    /// passes — local dev runs the actual compile.
    #[test]
    fn preprocess_lesson_runs_under_zig() {
        let zig_available = std::process::Command::new("zig")
            .arg("version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !zig_available {
            return;
        }

        let cases = [
            (
                "existing-main",
                // Mirrors the original 5 hand-authored Easy lessons.
                r#"pub fn greeting() []const u8 { return "Hello, world!"; }
const std_kata = @import("std");
fn testGreets() !void {
    if (!std_kata.mem.eql(u8, greeting(), "Hello, world!")) return error.WrongAnswer;
}
fn runTest(out: anytype, name: []const u8, body_fn: *const fn () anyerror!void) !void {
    if (body_fn()) |_| {
        try out.print("KATA_TEST::{s}::PASS\n", .{name});
    } else |err| {
        try out.print("KATA_TEST::{s}::FAIL::{s}\n", .{ name, @errorName(err) });
    }
}
pub fn main() !void {
    const out = std_kata.io.getStdOut().writer();
    runTest(out, "greets", &testGreets) catch {};
}
"#,
                vec!["KATA_TEST::greets::PASS"],
            ),
            (
                "cases-comment",
                // Mirrors LLM-emitted lessons with `// CASES: [...]`.
                r#"const std = @import("std");
pub fn sumSlice(numbers: []const i32) i32 {
    var total: i32 = 0;
    for (numbers) |num| total += num;
    return total;
}
fn testNormalCase() !void {
    if (sumSlice(&[_]i32{1,2,3}) != 6) return error.WrongAnswer;
}
fn testEmptySlice() !void {
    if (sumSlice(&[_]i32{}) != 0) return error.WrongAnswer;
}
// CASES: [["normal", "testNormalCase"], ["empty", "testEmptySlice"]]
"#,
                vec!["KATA_TEST::normal::PASS", "KATA_TEST::empty::PASS"],
            ),
            (
                "auto-detect",
                // Lesson with no main, no CASES — derives names from
                // PascalCase fn identifiers.
                r#"pub fn doubleIt(x: i32) i32 { return x * 2; }
fn testBasic() !void {
    if (doubleIt(3) != 6) return error.WrongAnswer;
}
fn testZero() !void {
    if (doubleIt(0) != 0) return error.WrongAnswer;
}
"#,
                vec!["KATA_TEST::basic::PASS", "KATA_TEST::zero::PASS"],
            ),
        ];

        for (label, src, want_lines) in cases {
            let out = preprocess_zig_source(src);
            let tmp = std::env::temp_dir().join(format!("fb-prep-{label}.zig"));
            std::fs::write(&tmp, &out).unwrap();
            let result = std::process::Command::new("zig")
                .arg("run")
                .arg(&tmp)
                .output()
                .expect("zig run failed to spawn");
            let stdout = String::from_utf8_lossy(&result.stdout);
            let stderr = String::from_utf8_lossy(&result.stderr);
            let combined = format!("{stdout}\n{stderr}");
            for want in &want_lines {
                assert!(
                    combined.contains(want),
                    "{label}: missing `{want}` in output:\nSOURCE:\n{out}\n---OUTPUT---\n{combined}"
                );
            }
            let _ = std::fs::remove_file(&tmp);
        }
    }
}
