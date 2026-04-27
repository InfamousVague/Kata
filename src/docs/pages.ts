import type { DocsSection } from "./types";

/// All documentation pages. Adding a page = appending an entry; adding a
/// section = appending a section. Authored in Bun-style: heavy on code,
/// light on hand-waving. Every code block reflects the actual codebase as
/// of authoring — when something changes, update the doc page next to the
/// code change, not in a separate sweep.

const welcome = `Fishbones is an offline-first **interactive coding course platform** that runs as a desktop app. The shell is **Tauri 2** (Rust backend + a system webview), the frontend is **React + TypeScript**, and the entire learning surface — courses, lessons, code execution, AI chat — happens locally on your machine.

The app's three goals, in priority order:

1. **Run real code, instantly.** Every supported language has an in-browser sandbox or a native toolchain probe. No "click here to start a hosted REPL" — the editor runs your code.
2. **Stay offline.** Once a course is downloaded, every lesson, hint, solution, and test runs without a network round-trip. The AI assistant defaults to **local Ollama**; the cloud path (Anthropic) is opt-in.
3. **Bring your own content.** Courses ship as portable \`.fishbones\` archives. You can import PDFs, scrape docs sites, generate challenge packs, or hand-author markdown — all from inside the app.

## What's in the box

\`\`\`
┌──────────────────────────────────────────────────────────────────┐
│  Tauri shell (window, menus, FS, command channel)                │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  React frontend                                          │    │
│  │  ┌────────────────────────────────────────────────────┐  │    │
│  │  │  Sidebar  │  Main pane  │  Workbench (Monaco)     │  │    │
│  │  │  Library  │  Lesson     │  Editor + Run + Tests   │  │    │
│  │  │  Docs     │  Quiz       │  Floating phone preview │  │    │
│  │  │  Profile  │  Playground │  AI chat panel          │  │    │
│  │  └────────────────────────────────────────────────────┘  │    │
│  │  src/runtimes/  — in-browser sandboxes (web/react/svelte) │    │
│  │  src/ingest/    — LLM-driven course generation pipeline   │    │
│  └──────────────────────────────────────────────────────────┘    │
│  src-tauri/  — Rust commands: courses, completions, AI proxy,    │
│                ingest harness, toolchain probes, file ops         │
└──────────────────────────────────────────────────────────────────┘
\`\`\`

## How to read these docs

The left sidebar groups pages into sections. Each page is self-contained — no required reading order — but the sections are roughly stacked by abstraction level: getting started → core concepts → subsystems → reference.

If you're new, start with **Architecture overview** then **The course format**. If you've used Fishbones before and want to understand a specific piece, skip straight to its page.

Code samples are real, not pseudocode. File paths are relative to the project root. When something is opinionated, the doc says *why*.
`;

const installing = `Fishbones runs on macOS, Linux, and Windows. The dev workflow is the standard Tauri loop.

## Prerequisites

- **Node 20+** (or Bun 1.1+)
- **Rust 1.78+** (with the default toolchain)
- **Platform-specific webview deps** — see [Tauri prerequisites](https://tauri.app/start/prerequisites/)

\`\`\`bash
# Clone
git clone <your-fork-url> Fishbones
cd Fishbones

# Install JS deps
bun install   # or: npm install
\`\`\`

## Running in dev mode

Two terminals during development — one for Vite, one for Tauri:

\`\`\`bash
# Terminal 1 — frontend hot-reload server
bun run dev

# Terminal 2 — Tauri shell (auto-attaches to the Vite server)
bun run tauri:dev
\`\`\`

Or one-shot via the combined script:

\`\`\`bash
bun run tauri:dev
\`\`\`

The Tauri shell injects a global \`window.__TAURI_INTERNALS__\` that lets the React side call Rust commands via \`invoke('cmd_name', args)\`. That's the only IPC surface — no REST, no WebSockets, no Electron-style \`ipcRenderer\` (Tauri's design is closer to a function call).

## Building a release

\`\`\`bash
bun run tauri:build
\`\`\`

Output lands in \`src-tauri/target/release/bundle/\` — a \`.dmg\` on macOS, an \`AppImage\`/\`.deb\` on Linux, an \`.msi\` on Windows. Each bundle includes the bundled \`.fishbones\` archives in \`Resources/resources/bundled-packs/\`, which seed into the user's courses directory on first launch (see [Bundled packs](docs:bundled-packs)).

> [!NOTE]
> The first build downloads the Rust dependency tree (~400 MB) and compiles the WebKit / WebView2 wrapper. Expect 5–10 min on a fast machine. Subsequent builds are incremental.

## Toolchains for native runtimes

Several courses (Rust, Go, Swift, Python, Java) need the corresponding toolchain installed locally. Fishbones probes for them on launch and shows a banner in the playground if missing:

\`\`\`bash
bun run setup:toolchains
\`\`\`

This runs \`scripts/setup-e2e-toolchains.sh\` — installs every native toolchain Fishbones can drive. It's idempotent; re-running it just confirms each tool is on PATH.

## Tests

\`\`\`bash
bun test                   # unit + component tests (Vitest)
bun run test:content        # validates every bundled-pack archive parses
bun run test:e2e           # Playwright end-to-end (drives the running shell)
\`\`\`

The e2e suite needs the toolchain setup script first.
`;

const firstCourse = `The Library is the entry point — it lists every course on disk, including the ones bundled with the app. On first launch, Fishbones extracts the bundled \`.fishbones\` archives into your data dir and Library opens with them already populated.

## Pick a course

Click any cover. The course's first lesson opens in the main pane and the sidebar tree expands to show every chapter and lesson.

The cover bar across the top of the sidebar is the **course carousel** — your recently-opened courses. Clicking one switches the sidebar tree to that course. The active course is the one whose tree is showing; the active *lesson* (highlighted) is whichever lesson the main pane is rendering.

## The three lesson kinds

Every lesson is one of three things:

1. **Reading** — a prose explanation rendered as styled markdown, with code blocks (Shiki-highlighted), callouts, and optional inline-sandbox playgrounds for live code experiments.
2. **Exercise** — a Monaco editor with starter code, a test suite, hints, and a reveal-solution affordance. Hitting **Run** executes the code in an in-browser sandbox (or via a Rust subprocess for native languages) and grades it against the tests.
3. **Quiz** — multiple-choice questions with explanations.

The fourth kind, **mixed**, is a reading lesson that has an exercise sub-section. Less common but useful when the prose and the practice are tightly coupled.

## The workbench

For exercise lessons, the right half of the screen is the **workbench** — Monaco + run controls + console output + (sometimes) a phone preview. The toolbar:

- **Hint** — surfaces the next hint. Hints are progressive — most lessons have 3, each more revealing than the last.
- **Reset** — restores the starter code (only enabled when you've changed it).
- **Solution** — reveals the reference answer.
- **Run** — executes your code against the test suite. Pass/fail lands in the output pane below.

When you pass, Fishbones marks the lesson complete and updates your XP / streak counters. The next lesson is one click away — or auto-advance via the bottom-right "Next" button.

## Settings to know about

\`Cmd+,\` (or **Settings** in the sidebar) opens the settings dialog. The few settings actually worth touching:

- **Theme** — light / dark / system (defaults to system)
- **AI assistant** — local (Ollama) or cloud (Anthropic) backend
- **Sign in** — enables cloud sync of progress and stats across machines
- **Clear courses / cache** — destructive but useful when something gets wedged

## Pop out

The workbench has a **pop-out** button (top-right of the editor pane). It opens the editor + console + phone preview as a separate Tauri window, leaving the lesson body taking the full main pane. Useful on multi-monitor setups: one screen for prose, the other for code.

The two windows stay synchronized — typing in either updates both — via Tauri events under the hood. See [Cross-window sync](docs:cross-window-sync).
`;

const archOverview = `Fishbones has four layers. Each one has a single responsibility and talks to the next via a narrow, typed surface.

\`\`\`
┌──────────────────────────────────────────────────────────────┐
│  Layer 4 — UI (React components)                              │
│             src/components/* + src/App.tsx                    │
│                          ▲                                    │
│                          │  hooks consume state               │
├──────────────────────────────────────────────────────────────┤
│  Layer 3 — State + Domain logic                               │
│             src/hooks/*  +  src/lib/*  +  src/data/*          │
│                          ▲                                    │
│                          │  invoke('cmd_name', args)           │
├──────────────────────────────────────────────────────────────┤
│  Layer 2 — Tauri command bridge                               │
│             src-tauri/src/*.rs                                 │
│             courses, completions, ai, ingest, files,           │
│             toolchain probe, llm proxy                          │
│                          ▲                                    │
│                          │  std::process / sqlite / fs         │
├──────────────────────────────────────────────────────────────┤
│  Layer 1 — Operating system                                   │
│             FS, network, subprocesses, GPU, audio              │
└──────────────────────────────────────────────────────────────┘
\`\`\`

## Layer 1 — OS

Tauri opens one or more webviews (\`WKWebView\` on macOS, \`WebKitGTK\` on Linux, \`WebView2\` on Windows) and exposes the OS to Rust. Everything below the webview is "normal" Rust — \`std::fs\`, \`reqwest\`, \`rusqlite\` (sqlite for completions/recents/stats), \`std::process::Command\` for spawning toolchains.

> [!NOTE]
> Tauri's WebView is **not** Chromium. WebKit and WebView2 have minor differences from Chrome (mostly around CSS / font rendering / experimental APIs). Fishbones tests on all three — the few divergences live in feature-detected branches, not browser-sniffing.

## Layer 2 — Tauri commands

Rust functions tagged \`#[tauri::command]\` are callable from the frontend via \`invoke('command_name', argsObject)\`. These are the only inputs the frontend can give to Rust — no shared memory, no foreign function calls. The full command surface lives in \`src-tauri/src/\`:

- \`courses.rs\` — read/write course archives, list installed courses, hydrate course bodies
- \`completions.rs\` — track lesson completions and timestamps in sqlite
- \`ai_chat.rs\` — proxy to local Ollama or Anthropic API; streams tokens back via Tauri events
- \`ingest.rs\` — orchestrates the LLM-driven course generation pipeline
- \`toolchain.rs\` — probes for installed compilers/runtimes (rustc, go, python3, etc.)
- \`stats.rs\` — XP, streak, daily aggregates
- \`fs_ops.rs\` — file picker, archive open/save, drag-drop

Each command takes typed arguments (Serde-deserialized from JSON) and returns either a typed value or an error. The error surfaces as a thrown \`Error\` on the JS side.

## Layer 3 — State + domain logic

Domain types live in \`src/data/types.ts\` — \`Course\`, \`Chapter\`, \`Lesson\` (a discriminated union over \`kind\`), \`WorkbenchFile\`, \`LanguageId\`, \`FileLanguage\`, etc. Both the Rust side and the TypeScript side serialize to the same JSON shape so a course written by Rust is readable by TS without a translation step.

Hooks in \`src/hooks/\` orchestrate state:

- \`useCourses\` — loads installed courses, exposes \`refresh()\` to re-scan
- \`useProgress\` — sqlite completion history, mark-complete mutations
- \`useRecentCourses\` — local-storage-backed "last opened at" timestamps
- \`useWorkbenchFiles\` / \`usePlaygroundFiles\` — multi-file editor state with debounced persistence
- \`useAiChat\` — chat history, streaming-message state, backend probe + setup flows
- \`useIngestRun\` — runs a course-generation pipeline, surfacing events to the UI
- \`useStreakAndXp\` / \`useToolchainStatus\` / \`useFishbonesCloud\` — supporting state

\`src/lib/\` contains pure utilities — file helpers, language metadata, Monaco wiring, cross-window message buses.

## Layer 4 — UI

The component tree is rooted at \`App.tsx\`. \`App\` owns the *outermost* state (which view is showing, which course is open, which lesson is selected, which dialogs are open) and feeds it down via props. There's no global store (no Redux, no Zustand) — the hooks colocate the state with the data, and components receive only what they need.

The main pane renders one of:

- **Library** — course catalog
- **Playground** — free-form editor sandbox
- **Profile** — XP / streak / progress dashboard
- **Docs** — these pages
- **Lesson view** — the actual learning surface (reading / exercise / quiz / mixed)
- **Empty state** — "pick a lesson"

The sidebar is global — present in every view. The top bar is global. Dialogs (settings, import, AI chat) are portaled overlays.

## How a learner action becomes a state change

Real example: clicking **Run** in an exercise lesson.

1. \`Workbench\` (component) → onClick handler in \`EditorPane\`
2. \`EditorPane\` calls \`onRun(files)\` — passed in by parent
3. Parent (App tree) calls \`runFiles(language, files, testCode)\` from \`src/runtimes/index.ts\`
4. \`runFiles\` dispatches to the right runtime — \`runWeb\`, \`runReact\`, \`runJavaScript\`, etc.
5. The runtime evaluates the code in an iframe / Web Worker / Rust subprocess
6. Returns a \`RunResult\` — logs, test results, error, durationMs
7. \`OutputPane\` renders the result. If passing, parent calls \`markComplete(courseId, lessonId)\`
8. \`markComplete\` invokes \`mark_completion\` Tauri command (writes to sqlite)
9. \`useProgress\` re-fetches completions; sidebar lights up the new green dot

The whole loop is plain function calls — no event bus, no observable. Easy to trace, easy to test.
`;

const tauriBackend = `The Rust side is small and stratified. It exposes ~30 commands across 8 modules. Each module is a thin wrapper over a system resource — sqlite, the filesystem, an HTTP client, a child process.

## Module map

\`\`\`
src-tauri/src/
├── main.rs                     # the tauri::Builder + command registry
├── courses.rs                  # course archives: open, save, list, seed
├── completions.rs              # sqlite-backed completion tracking
├── ai_chat.rs                  # ollama / anthropic proxy + streaming
├── ingest.rs                   # LLM-driven course generation pipeline
├── toolchain.rs                # probe rustc / go / python3 / etc.
├── stats.rs                    # XP, streak, daily aggregates
├── fs_ops.rs                   # native file picker, drag-drop, archive read
└── settings.rs                 # ~/.config/fishbones/settings.json
\`\`\`

## How a command is exposed

\`\`\`rust
// src-tauri/src/completions.rs

#[tauri::command]
pub async fn list_completions(app: tauri::AppHandle) -> Result<Vec<Completion>, String> {
    let conn = open_db(&app).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT course_id, lesson_id, completed_at FROM completions ORDER BY completed_at DESC")
        .map_err(|e| e.to_string())?;
    // ...
    Ok(rows)
}
\`\`\`

Then registered in \`main.rs\`:

\`\`\`rust
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            completions::list_completions,
            completions::mark_completion,
            // ... ~30 more
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
\`\`\`

The frontend calls it via:

\`\`\`ts
import { invoke } from "@tauri-apps/api/core";

const completions = await invoke<Completion[]>("list_completions");
\`\`\`

> [!TIP]
> Type the return value at the call site (\`invoke<Completion[]>\`). Tauri doesn't auto-generate TypeScript types from Rust — type drift is a real risk. \`src/data/types.ts\` is the single source of truth; both sides deserialize against it.

## SQLite is the persistence layer

Completions, recents, stats, daily aggregates — all sqlite. The DB lives at \`<app-data>/fishbones.sqlite\`. The schema is created idempotently at startup (no separate migration step yet — the schema is small enough that \`CREATE TABLE IF NOT EXISTS\` suffices).

\`\`\`sql
-- completions: one row per (course, lesson) the user has finished
CREATE TABLE IF NOT EXISTS completions (
    course_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    PRIMARY KEY (course_id, lesson_id)
);

-- daily_xp: aggregated XP per UTC day
CREATE TABLE IF NOT EXISTS daily_xp (
    day TEXT PRIMARY KEY,
    xp INTEGER NOT NULL DEFAULT 0
);
\`\`\`

The Rust crate is \`rusqlite\` with the \`bundled\` feature so we ship our own libsqlite3 — no host-OS sqlite version drift.

## Course storage on disk

Courses live as **directories**, not bundles, on disk. The bundle is just the wire format:

\`\`\`
<app-data>/courses/
├── javascript-crash-course/
│   ├── course.json
│   └── cover.png         (optional)
├── bun-complete/
│   └── course.json
└── seeded-packs.json     (marker — see Bundled packs)
\`\`\`

\`course.json\` is the canonical course shape (\`Course\` from \`data/types.ts\`). Importing a \`.fishbones\` archive unzips it into a directory; exporting zips the directory back.

## The AI proxy

\`ai_chat.rs\` knows two backends:

- **Ollama** — local; talks HTTP to \`http://127.0.0.1:11434\` (default)
- **Anthropic** — cloud; talks HTTP to \`https://api.anthropic.com\` with the user's API key

The frontend never sees raw HTTP — it calls \`ai_chat_send\` with a message + context, and Rust streams completion tokens back via \`tauri::Window::emit\` events. The streaming is a Tauri event channel, not a return value, so the UI can render tokens as they arrive.

\`\`\`rust
// Pseudocode of the streaming pattern
#[tauri::command]
pub async fn ai_chat_send(window: Window, msg: String) -> Result<(), String> {
    let mut stream = backend.stream(msg).await?;
    while let Some(token) = stream.next().await {
        window.emit("ai-chat-token", token?)?;
    }
    window.emit("ai-chat-done", ())?;
    Ok(())
}
\`\`\`

On the JS side, \`useAiChat\` listens for those events and appends to the active message buffer.

## The toolchain probe

\`toolchain.rs\` runs \`<tool> --version\` for each language Fishbones can drive natively (Rust, Go, Swift, Python, Java, etc.). The result is cached for 5 minutes so we don't pay the spawn cost on every component re-render.

\`\`\`rust
#[tauri::command]
pub async fn probe_language_toolchain(language: String) -> Result<ToolchainStatus, String> {
    // ... spawns the binary's --version, parses, returns ToolchainStatus
}
\`\`\`

The frontend calls this from \`useToolchainStatus\` and renders a banner if the tool is missing — with a one-click "install" button on supported platforms (rustup-init, brew, etc.).
`;

const reactFrontend = `The frontend is a single-page React app, built with Vite, served from \`/\` by the Tauri shell. There's no routing library — the app uses a \`view\` state machine in \`App.tsx\`.

## Entry point

\`\`\`tsx
// src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
\`\`\`

\`App.tsx\` is the one file with global state — every other component is a leaf or near-leaf with prop-driven rendering.

## State machine: which view is showing

\`\`\`tsx
const [view, setView] = useState<
  "courses" | "profile" | "playground" | "library" | "docs"
>("courses");
\`\`\`

The render tree picks the main-pane component:

\`\`\`tsx
{view === "profile"    ? <ProfileView />
: view === "playground" ? <PlaygroundView />
: view === "docs"       ? <DocsView />
: view === "library"    ? <CourseLibrary />
: courses.length === 0  ? <WelcomePrompt />
: openTabs.length === 0 ? <CourseLibrary inline />
: activeLesson          ? <LessonView />
                        : <EmptyPickALesson />}
\`\`\`

The \`view\` is set by sidebar nav clicks. Selecting a lesson resets \`view\` to \`"courses"\` so the lesson view actually shows up — otherwise clicking a sidebar lesson while on Settings would do nothing visible.

## The component tree

\`\`\`
<App>
  <TopBar/>                         — global; streak chip, profile menu, sign-in
  <main>
    <Sidebar/>                      — global; course tree, primary nav, carousel
    <main-pane>                     — the view-switched area above
      <LessonView>                  — when a lesson is open
        <LessonReader/>             — markdown body w/ enrichment + popovers
        <Workbench>                 — exercise lessons only
          <EditorPane/>             — Monaco + tabs + run button
          <OutputPane/>             — console + test results
          <FloatingPhone/>          — RN / Svelte mobile preview
        </Workbench>
        <QuizView/>                 — quiz lessons
      </LessonView>
    </main-pane>
  </main>
  <Dialogs/>                        — settings, import, AI chat (portaled)
  <CommandPalette/>                 — Cmd+K
  <AiAssistant/>                    — floating chat button + panel
</App>
\`\`\`

## Component conventions

- **One component per directory.** Each component lives in \`src/components/<Name>/<Name>.tsx\` with a sibling \`<Name>.css\`.
- **Props are typed inline** — no separate \`<Name>.types.ts\`.
- **CSS class names use the \`fishbones__\` BEM-style prefix** to avoid collision with library-provided classes (the icon library, for instance).
- **No global stores.** State lives in hooks; data flows down as props, callbacks flow up.

## Hooks colocate state with data

Every meaningful piece of state has a hook in \`src/hooks/\`. Hooks own:

- The data structure
- The persistence layer (sqlite via Tauri, localStorage, or in-memory)
- The mutators
- Any debouncing / cancellation / re-fetch logic

\`useCourses()\` is the canonical example:

\`\`\`ts
export function useCourses() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const list = await invoke<Course[]>("list_courses");
    setCourses(list);
    setLoaded(true);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { courses, loaded, refresh };
}
\`\`\`

A consumer doesn't know whether the data came from sqlite, localStorage, or a fetch — they just call the hook.

## Theme

Three themes — \`light\`, \`dark\`, \`system\` (which follows OS-level preference). Each writes a \`data-theme\` attribute on the document root which CSS variables key off:

\`\`\`css
[data-theme="dark"] {
  --color-bg-primary: #0b0b10;
  --color-text-primary: #f5f5f7;
  /* ... */
}

[data-theme="light"] {
  --color-bg-primary: #ffffff;
  --color-text-primary: #15151c;
  /* ... */
}
\`\`\`

Components reference the variables, not the hex values. Adding a new theme is editing one CSS file (\`src/theme/themes.css\`). Monaco's editor theme is regenerated to match — see [Theme system](docs:theme).
`;

const courseFormat = `A course is a folder. The wire format is a zip archive with the \`.fishbones\` extension wrapping that folder. The folder contents:

\`\`\`
<course-id>/
├── course.json     # required — the canonical course data
└── cover.png       # optional — used by the Library + Sidebar carousel
\`\`\`

## course.json

This is a JSON serialization of the \`Course\` interface from \`src/data/types.ts\`:

\`\`\`ts
interface Course {
  id: string;
  title: string;
  description?: string;
  author?: string;
  language: LanguageId;
  chapters: Chapter[];
  packType?: "course" | "challenges";
  source?: "pdf" | "docs";
  coverFetchedAt?: number;
}

interface Chapter {
  id: string;
  title: string;
  lessons: Lesson[];
}

type Lesson = ReadingLesson | ExerciseLesson | QuizLesson | MixedLesson;
\`\`\`

A real course.json (truncated):

\`\`\`json
{
  "id": "bun-complete",
  "title": "Bun: The Complete Runtime",
  "description": "A deep, end-to-end tour of Bun...",
  "author": "Fishbones",
  "language": "bun",
  "chapters": [
    {
      "id": "why-bun",
      "title": "Why Bun",
      "lessons": [
        {
          "id": "r1",
          "kind": "reading",
          "title": "What Bun actually is",
          "body": "Bun is **four tools shipped as one binary**:..."
        },
        {
          "id": "q1",
          "kind": "quiz",
          "title": "Pick the right tool",
          "questions": [{
            "prompt": "...",
            "choices": ["..."],
            "correctIndex": 1,
            "explanation": "..."
          }]
        }
      ]
    }
  ]
}
\`\`\`

## Lesson kinds

### reading

Plain markdown body. Renders through the same pipeline LessonReader uses.

\`\`\`json
{
  "id": "r1",
  "kind": "reading",
  "title": "...",
  "body": "Markdown content..."
}
\`\`\`

The body supports:

- All CommonMark + GFM features (tables, fenced code, ordered/unordered lists)
- **GitHub-style callouts**: \`> [!NOTE]\`, \`> [!TIP]\`, \`> [!WARNING]\`, \`> [!EXAMPLE]\`
- **Inline-sandbox playgrounds**: code fences with the word \`playground\` in the info string become embedded mini-editors
- **Symbol popovers + glossary** (when \`enrichment\` is present — see below)

### exercise

Includes starter code, tests, hints, and a reference solution.

\`\`\`json
{
  "id": "e1",
  "kind": "exercise",
  "title": "...",
  "body": "Markdown describing the task",
  "language": "javascript",
  "topic": "javascript",
  "starter": "function add(a, b) { /* TODO */ }\\nmodule.exports = { add };",
  "solution": "function add(a, b) { return a + b; }\\nmodule.exports = { add };",
  "tests": "test('adds', () => expect(add(1,2)).toBe(3));",
  "hints": ["Look at the function signature.", "Use +", "Return the value"]
}
\`\`\`

For multi-file exercises, use \`files\` and \`solutionFiles\` arrays of \`WorkbenchFile\` objects instead of \`starter\` / \`solution\` strings.

\`tests\` is a string of test code in the format the lesson's runtime expects:
- JS / TS / Bun → Jest-compatible \`test()\` / \`expect()\` calls
- Python → \`assert\`-based tests via the in-browser Python sandbox
- Native (Rust / Go / Swift) → tests evaluated by spawning the toolchain

### quiz

\`\`\`json
{
  "id": "q1",
  "kind": "quiz",
  "title": "...",
  "questions": [
    {
      "prompt": "...",
      "choices": ["A", "B", "C", "D"],
      "correctIndex": 1,
      "explanation": "Why B is right"
    }
  ]
}
\`\`\`

Multiple questions per quiz are allowed. The lesson is marked complete when every question has a correct answer.

### mixed

A reading lesson that contains an exercise sub-section. Same fields as \`exercise\` but the prose body is the dominant content.

## Bundle format (.fishbones zip)

Just a standard ZIP. The python builder script is the simplest way to produce one:

\`\`\`python
import json, zipfile

course = { ... }   # build the dict matching the Course interface

with zipfile.ZipFile("my-course.fishbones", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("course.json", json.dumps(course, indent=2))
    # optional: z.write("cover.png", arcname="cover.png")
\`\`\`

The Tauri side handles import: drag a \`.fishbones\` onto the Library, or use **Settings → Import**. \`courses.rs::import_archive\` unzips into \`<app-data>/courses/<course.id>/\`.

## Bundled vs imported

Bundled packs ship inside the app binary at \`src-tauri/resources/bundled-packs/\`. On first launch, the seeder copies them into the user's courses directory — see [Bundled packs](docs:bundled-packs). The user can delete a bundled course; Fishbones tracks the deletion so it doesn't re-seed.

## Enrichment (optional)

A course can carry a per-lesson \`enrichment\` object that powers the in-prose popover system:

\`\`\`json
{
  "kind": "reading",
  "body": "Use \`server.upgrade(req)\` to ...",
  "enrichment": {
    "symbols": [
      { "pattern": "server.upgrade",
        "title": "server.upgrade(req, options?)",
        "summary": "Upgrade an HTTP request to a WebSocket connection." }
    ],
    "glossary": [
      { "term": "WebSocket",
        "definition": "Bidirectional message protocol over TCP." }
    ]
  }
}
\`\`\`

LessonReader scans the rendered HTML, finds first occurrences of each pattern / term, and wraps them in popover triggers. Hovering pops a small card with the summary; clicking pins it open.
`;

const runtimeLayer = `Code execution is the heart of Fishbones. Every lesson with code runs *somewhere* — in an iframe, a Web Worker, a child process, or a hosted compiler proxy. The runtime layer is the dispatcher.

## The dispatch contract

\`src/runtimes/index.ts\` exports two entry points:

\`\`\`ts
// Single-source dispatch — used by lessons whose runnable code is one string
export async function runCode(
  language: LanguageId,
  code: string,
  testCode?: string,
): Promise<RunResult>;

// Multi-file dispatch — used by the workbench
export async function runFiles(
  language: LanguageId,
  files: WorkbenchFile[],
  testCode?: string,
  assets?: WorkbenchAsset[],
): Promise<RunResult>;
\`\`\`

\`runFiles\` picks the right per-language runtime, handing it the file array verbatim. \`runCode\` is the older single-string flavor — for native languages, it's still the path used.

## RunResult — the universal return shape

\`\`\`ts
export interface RunResult {
  logs: LogLine[];                 // console.log / println / printf output
  testResults?: TestResult[];      // when testCode is provided
  error?: string;                  // top-level runtime error
  durationMs: number;
  artifact?: ArtifactPayload;      // optional iframe URL for visual lessons
}

export interface TestResult {
  name: string;
  passed: boolean;
  message?: string;
}

export function isPassing(r: RunResult): boolean {
  // No tests + no error = "ran cleanly"; tests = "all green"
}
\`\`\`

Every runtime — whether it's an iframe, a worker, or a Rust proxy — returns this shape. The output pane and grading logic only know about \`RunResult\`.

## In-browser sandboxes

The browser-only languages (anything that can be evaluated client-side without a toolchain on disk):

| Language | Runtime file | How it runs |
|---|---|---|
| \`javascript\` | \`runtimes/javascript.ts\` | Web Worker with eval'd source |
| \`typescript\` | \`runtimes/javascript.ts\` (typescript path) | Babel-transpile then JS worker |
| \`python\` | \`runtimes/python.ts\` | Pyodide (CPython compiled to WASM) |
| \`web\` / \`threejs\` | \`runtimes/web.ts\` | iframe with concatenated HTML/CSS/JS |
| \`react\` | \`runtimes/react.ts\` | iframe with React + Babel + the user's JSX |
| \`reactnative\` | \`runtimes/reactnative.ts\` | iframe with react-native-web + AppRegistry |
| \`svelte\` | \`runtimes/svelte.ts\` | iframe with the official Svelte 5 compiler ESM bundle |
| \`solid\` | routed → \`runReact\` | JSX evaluator covers Solid syntax |
| \`htmx\` / \`astro\` | routed → \`runWeb\` | Plain HTML serving |
| \`bun\` | routed → \`runJavaScript\` | JS sandbox handles syntax-level Bun lessons |
| \`tauri\` | routed → \`runRust\` | Rust toolchain proxy |

## Native runtimes

Anything requiring a real compiler runs out of process. \`runtimes/nativeRunners.ts\` and the per-language files (\`rust.ts\`, \`go.ts\`, \`swift.ts\`) wrap a single Tauri command:

\`\`\`ts
// src/runtimes/rust.ts
export async function runRust(code: string, testCode?: string): Promise<RunResult> {
  const out = await invoke<NativeRunResult>("run_native_code", {
    language: "rust",
    code,
    testCode,
  });
  return adaptToRunResult(out);
}
\`\`\`

\`run_native_code\` on the Rust side:

1. Writes the user's code to a tempdir
2. Spawns the toolchain (\`rustc\`, \`go run\`, etc.)
3. Captures stdout / stderr / exit code
4. Optionally compiles + runs the test harness against the user's module
5. Returns the result

Native runtimes need the toolchain installed locally. The toolchain probe (see [Tauri backend](docs:tauri-backend)) tells the UI when to show a "missing toolchain" banner.

## The web runtime, in detail

\`runtimes/web.ts\` builds an iframe that runs the user's HTML/CSS/JS. It also injects a console shim so logs flow back to the parent page:

\`\`\`ts
// Console patching template (lives at the top of the iframe)
const CONSOLE_SHIM = \`<script>
  ['log', 'warn', 'error', 'info', 'debug'].forEach((level) => {
    const orig = console[level];
    console[level] = (...args) => {
      window.parent.postMessage({
        __fishbones: true, kind: 'console', level, args
      }, '*');
      orig.apply(console, args);
    };
  });
  window.addEventListener('error', (e) => {
    window.parent.postMessage({ __fishbones: true, kind: 'error', message: e.message }, '*');
  });
</script>\`;
\`\`\`

The parent page listens on \`message\`, filters \`__fishbones === true\`, and pushes log lines into the \`RunResult\`.

For lessons with tests, the runtime also injects a tiny \`window.test()\` / \`window.expect()\` harness that runs the test code AFTER the user's code, capturing pass/fail.

## The React Native runtime

\`runtimes/reactnative.ts\` is the most involved. It builds an iframe with:

- \`react-native-web\` (RN components rendered as web components)
- A boot stage tracker (so we can show "Compiling...", "Mounting...", "Crashed" in the floating phone)
- Babel-in-browser to transpile JSX
- An AppRegistry shim that picks up the user's \`App\` export and mounts it
- An error overlay that paints over the phone screen if any phase throws
- Theme tokens read from the parent page's CSS variables (so the phone preview matches your theme)

The output appears inside the **floating phone** — see [Floating phone](docs:floating-phone).

## The Svelte 5 runtime

\`runtimes/svelte.ts\` compiles \`.svelte\` source in the browser:

1. Imports the Svelte 5 compiler from esm.sh
2. Calls \`compile(source, { generate: 'client' })\` — produces a JS module
3. Rewrites bare-spec imports (\`from "svelte"\`) to fully-qualified esm.sh URLs
4. Wraps the resulting JS in a Blob URL and dynamic-imports it
5. Mounts via \`mount(Component, { target })\` from the Svelte 5 runtime

All in the browser. No server-side build step. The same approach scales to SvelteKit (the \`runSvelteKit\` variant adds page-loader stubs).

## Adding a new language

The boilerplate to add a new language:

1. Add the id to \`LanguageId\` in \`src/data/types.ts\`
2. Add metadata (label, color, icon) to \`src/lib/languages.tsx\` \`LANGUAGE_META\`
3. Add a default file (filename + Monaco language) to \`LANG_DEFAULTS\` in \`src/lib/workbenchFiles.ts\`
4. Add a playground starter template to \`src/runtimes/playgroundTemplates.ts\`
5. **If it's a new runtime**, add a file under \`src/runtimes/\` exporting \`runX(...)\`. Wire into the dispatcher in \`runtimes/index.ts\`. **If it's a syntactic variant of an existing runtime** (like \`solid\` → \`react\`), just add a route in \`runFiles\` and skip building the runtime.
6. Switch cases — Sidebar.tsx, BookCover.tsx, PlaygroundView.tsx, etc. each have switches over \`LanguageId\` that need a new case.
`;

const workbench = `The workbench is the right half of an exercise lesson. It owns the code, the tests, and the run loop.

\`\`\`
┌──────────────────────────────────────────────────────────────┐
│  EditorPane                                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  user.js  test.js  helpers.js                        │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                                                      │   │
│  │   Monaco editor                                      │   │
│  │                                                      │   │
│  │                                                      │   │
│  └──────────────────────────────────────────────────────┘   │
│  [Hint] [Reset] [Reveal solution]               [Run ▶]     │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│  OutputPane                                                  │
│  > log "hello"                                                │
│  ✓ test 1 passed                                              │
│  ✗ test 2 failed: expected 5, got 4                           │
└──────────────────────────────────────────────────────────────┘
\`\`\`

## Multi-file by default

Internally every workbench is a list of \`WorkbenchFile\`:

\`\`\`ts
interface WorkbenchFile {
  name: string;             // tab label; also the filename at runtime
  language: FileLanguage;   // Monaco mode for this file
  content: string;
  readOnly?: boolean;       // greyed-out tab; can't be edited
}
\`\`\`

Single-string lessons (the legacy \`starter\` field on \`ExerciseLesson\`) are converted to a one-element file array on the way in:

\`\`\`ts
// src/lib/workbenchFiles.ts
export function deriveStarterFiles(lesson: ExerciseLesson): WorkbenchFile[] {
  if (lesson.files && lesson.files.length > 0) {
    return lesson.files.map(f => ({ ...f }));
  }
  // Fallback: synthesize a single file from \`lesson.starter\`
  const def = LANG_DEFAULTS[lesson.language] ?? { name: "user.txt", language: "plaintext" };
  return [{
    name: def.name,
    language: def.language,
    content: lesson.starter ?? "",
  }];
}
\`\`\`

\`LANG_DEFAULTS\` maps each \`LanguageId\` to a default filename + Monaco language. This is also what fixed the syntax-highlighting bug for the Bun course — see the [DRY findings](docs:dry-findings) page.

## State + persistence

\`useWorkbenchFiles(lesson)\` is the hook that owns the editor state for a lesson.

\`\`\`ts
const { files, setFiles, reset, isPristine } = useWorkbenchFiles(lesson);
\`\`\`

It:

1. Hydrates from \`localStorage\` keyed on \`workbench:files:<courseId>:<lessonId>\` if present, otherwise from \`deriveStarterFiles(lesson)\`.
2. Debounces persistence — saves to localStorage 400 ms after the last edit, plus a final save on unmount.
3. Exposes \`reset()\` — restores starter, clears localStorage entry.

The pattern is duplicated in \`usePlaygroundFiles\` (which keys by \`playground:files:<language>\` instead of by lesson). Both should compose around a single \`useLocalStorage\` + \`useDebouncedCallback\` — see [DRY findings](docs:dry-findings) item 1 + 2.

## Monaco wiring

Monaco is loaded via \`@monaco-editor/react\`. Bun-specific (and other custom) language wiring happens once at app boot:

\`\`\`ts
// src/lib/monaco-setup.ts
import * as monaco from "monaco-editor";
import svelteGrammar from "./monaco-svelte";

export function setupMonaco() {
  monaco.languages.register({ id: "svelte" });
  monaco.languages.setMonarchTokensProvider("svelte", svelteGrammar);

  // Theme regeneration based on the active app theme
  monaco.editor.defineTheme("fishbones-dark", FISHBONES_DARK_THEME);
  monaco.editor.defineTheme("fishbones-light", FISHBONES_LIGHT_THEME);
}
\`\`\`

The themes are generated from the same color tokens the rest of the app uses — see [Theme system](docs:theme).

## Run flow

\`\`\`
[Run] click
  ↓
EditorPane.onRun(files)
  ↓
parent: runFiles(language, files, testCode, assets)
  ↓
runtimes/index.ts dispatches to per-language runtime
  ↓
RunResult (logs + testResults + error)
  ↓
OutputPane renders
  ↓
if isPassing(result):
  markComplete(courseId, lessonId)   →  invoke('mark_completion')
  awardXp(...)
  bumpStreak(...)
\`\`\`

## Reveal solution

The **Solution** button calls \`deriveSolutionFiles(lesson)\` (analogous to \`deriveStarterFiles\`) and \`setFiles(solutionFiles)\`. The lesson is NOT auto-marked complete on reveal — the learner still has to run the code (which then passes trivially) to get credit. This is intentional: it makes "I revealed the solution" visible in the completion timestamp pattern (you can see when you'd looked something up vs. solved it cold).

## Pop-out

The header has a "pop out" button. Clicking it opens a dedicated Tauri window containing only the workbench. The two windows stay in sync via a \`makeBus\` helper in \`src/lib/workbenchSync.ts\` that picks the right channel:

- **In Tauri** — \`@tauri-apps/api/event\` (window-to-window events)
- **In a browser dev environment** — \`BroadcastChannel\` (no Tauri available)

\`\`\`ts
// Message shape
type WorkbenchMsg =
  | { kind: 'files'; files: WorkbenchFile[] }
  | { kind: 'run-result'; result: RunResult };
\`\`\`

Each window emits on its bus when files change; the other window listens and replaces its state. The same pattern (a separate bus, same shape) powers the floating phone pop-out — \`src/lib/phonePopout.ts\` is essentially a parallel implementation that should consolidate. See [DRY findings](docs:dry-findings).
`;

const ingestPipeline = `Ingest is how courses are *generated*, not just imported. Three pipelines exist:

1. **PDF ingest** — point at a textbook PDF, get a course
2. **Docs site ingest** — point at a docs URL (like https://bun.com/docs), get a course
3. **Challenge pack** — generate kata-style problem sets per language + difficulty

All three share infrastructure: an LLM proxy, an event-emitting orchestrator, and stats tracking.

## Pipeline shape

Each pipeline is an async function taking a \`config\` and an \`onEvent\` callback:

\`\`\`ts
export async function runIngestPipeline(
  config: IngestConfig,
  onEvent: (e: IngestEvent) => void,
  signal: AbortSignal,
): Promise<Course>;
\`\`\`

\`IngestEvent\` has a structured shape so the UI can render a live progress feed:

\`\`\`ts
type IngestEvent =
  | { kind: 'phase';   label: string }
  | { kind: 'log';     message: string }
  | { kind: 'lesson';  title: string; lessonKind: 'reading' | 'exercise' | 'quiz' }
  | { kind: 'stats';   stats: PipelineStats }
  | { kind: 'error';   message: string };
\`\`\`

The frontend hook (\`useIngestRun\`) accumulates events into a 500-line ring buffer and renders them in \`FloatingIngestPanel\`.

## PDF ingest

\`src/ingest/pipeline.ts\` (1142 lines — the largest single file in the codebase). The phases:

\`\`\`
1. Parse the PDF                  pdfParser.ts → text + page boundaries
2. Detect chapter structure       LLM call: chapters.json
3. For each chapter:
   3a. Extract section text
   3b. Generate lessons (LLM)     lessons.json per chapter
4. Cover image extraction         pdfParser.ts → first decent image
5. Optional enrichment            enrichCourse.ts → glossary + symbols
6. Write course.json + cover.png  invoke('save_course')
\`\`\`

LLM calls go through a single Tauri command: \`invoke('llm_generate', { prompt, model, jsonSchema })\`. The Rust side dispatches to the configured backend (Ollama or Anthropic) and returns the raw text.

> [!NOTE]
> Cost tracking is a per-pipeline \`PipelineStats\` object. Token counts come back from the LLM call; the cost is computed via the model's input/output rates. The pricing table is currently duplicated in 5 ingest files — a high-priority DRY fix (see [DRY findings](docs:dry-findings)).

## Docs site ingest

\`src/ingest/ingestDocsSite.ts\`. The phases:

\`\`\`
1. Fetch the index page              invoke('crawl_docs_site') → page tree
2. Cluster pages into chapters       LLM call: chapter assignments
3. For each chapter:
   3a. Fetch each page's HTML
   3b. Extract main content (HTMLRewriter on Rust side)
   3c. Generate lessons (LLM)
4. Cover image                       crawl head OG image
5. Enrichment + write
\`\`\`

The crawl is breadth-first up to a configurable depth; pages outside the docs subdomain are dropped. The result is the same \`Course\` shape regardless of source.

## Challenge pack generation

\`src/ingest/generateChallengePack.ts\`. Different shape — instead of mining content from a source, this generates fresh kata problems:

\`\`\`
1. For each (language, difficulty) pair:
   1a. Prompt the LLM for N exercise specs
   1b. For each spec: generate starter, solution, tests, hints
2. Validate every exercise actually runs
3. Write course.json with packType: 'challenges'
\`\`\`

Validation runs each generated exercise through the same \`runFiles\` dispatcher used in the live app — passing tests is the gate. Failed exercises get one retry, then a "regen" pass via \`regenExercises.ts\`.

## Enrichment

\`src/ingest/enrichCourse.ts\` is a *post-generation* pass. It walks every reading lesson, identifies meaningful symbols and glossary candidates, and writes them back as the lesson's \`enrichment\` field.

Why a separate pass? It's expensive (one LLM call per lesson) and optional. A course is fully usable without enrichment — the popovers just don't appear.

## Stats and cost

Every pipeline emits \`stats\` events as it goes. The shape:

\`\`\`ts
interface PipelineStats {
  startedAt: number;
  elapsedMs: number;
  apiCalls: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  model: string;
  lessonsByKind: Record<LessonKind, number>;
}
\`\`\`

The estimated cost is approximate — Anthropic's actual billing rounds and bills in cents. Within ~5% over a full run.

## Aborting

Every ingest function takes an \`AbortSignal\`. The \`Aborted\` exceptions are typed (\`IngestAborted\`, \`DocsIngestAborted\`, etc.) so callers can distinguish "user cancelled" from "LLM returned garbage" — the former is silent, the latter shows an error.

The exception classes are duplicated across 6 files; consolidating to a single \`createAbortError()\` factory would drop ~30 lines. See [DRY findings](docs:dry-findings) item 8.

## The \`useIngestRun\` hook

The frontend orchestrator lives in \`src/hooks/useIngestRun.ts\` (705 lines). It exposes:

\`\`\`ts
const {
  status,           // 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  events,           // last 500 events for the live feed
  stats,            // current PipelineStats snapshot
  course,           // the in-flight course object
  startPdf,         // start a PDF ingest
  startDocs,        // start a docs-site ingest
  startChallengePack,
  cancel,           // abort the current run
} = useIngestRun();
\`\`\`

Internally it threads the \`AbortSignal\` from a stable \`AbortController\` and accumulates events through a series of state updaters that all share the same 500-event-cap pattern (also DRY-able).
`;

const aiAssistant = `Fishbones has a chat panel — clickable from the floating fish icon, the command palette, or the lesson reader's "Ask Fishbones" badge on a code block. The panel is a normal LLM chat, but with two interesting properties:

1. **Local-first.** The default backend is Ollama running on \`127.0.0.1:11434\`. No data leaves your machine.
2. **Lesson-aware.** When you open the panel from inside a lesson, the conversation is seeded with the lesson title + body + the snippet you clicked.

## Two backends

\`\`\`
┌───────────────────────────────────────┐
│  AI Settings (UI)                     │
│  Backend: ◉ Ollama (local)            │
│            ○ Anthropic (cloud)         │
│  Model:   [llama3.2:3b      ▼]        │
└───────────────────────────────────────┘
              │
              ▼
┌───────────────────────────────────────┐
│  Rust: ai_chat.rs                     │
│   ├── OllamaBackend                   │
│   │     POST /api/chat                │
│   │     stream NDJSON tokens           │
│   └── AnthropicBackend                │
│         POST /v1/messages             │
│         stream SSE tokens              │
└───────────────────────────────────────┘
              │
              ▼
       Tauri events → React UI
\`\`\`

## Local: Ollama

[Ollama](https://ollama.ai) is a single-binary local LLM runner. Fishbones doesn't bundle Ollama — it expects you to install it (one click on the Settings dialog will run \`brew install ollama\` on macOS, similar on Linux).

The backend probe (\`useAiChat::refreshProbe\`) checks:

1. Is Ollama installed? (\`which ollama\` on POSIX, Get-Command on Windows)
2. Is the daemon running? (HTTP HEAD on \`127.0.0.1:11434\`)
3. Are any models available? (\`GET /api/tags\`)
4. Is the configured model among them?

If any of these fail, the AI panel shows a setup banner with the appropriate one-click action: "Install Ollama" → "Start Ollama" → "Pull <model>". \`useAiChat::runSetup\` wraps each action with a re-probe so the UI updates as conditions change.

## Cloud: Anthropic

The cloud backend talks directly to Anthropic's API from Rust. The user supplies an API key in Settings (stored in \`~/.config/fishbones/settings.json\`). Models supported: \`claude-sonnet-4.5\`, \`claude-opus-4.5\`, \`claude-haiku-4.5\` (the pricing table is in \`src/ingest/pricing.ts\` — though as noted in [DRY findings](docs:dry-findings) it's duplicated across 5 ingest files).

> [!WARNING]
> The Anthropic backend uses the API key directly — no OAuth, no proxy. Treat your settings file as a secret. Don't sync it to a public dotfiles repo.

## Streaming

Both backends stream. The pattern:

\`\`\`rust
// Rust side
let mut stream = backend.stream_chat(messages).await?;
while let Some(token) = stream.next().await {
    let token = token?;
    window.emit("ai-chat-token", &token)?;
}
window.emit("ai-chat-done", ())?;
\`\`\`

\`\`\`ts
// JS side
useEffect(() => {
  const unlisten = await listen<string>("ai-chat-token", (e) => {
    setActiveMessage(prev => prev + e.payload);
  });
  return () => unlisten();
}, []);
\`\`\`

The active message is rendered with a blinking caret while streaming. When the \`ai-chat-done\` event lands, the active message is committed to history and the caret disappears.

## Lesson-context seeding

When the panel is opened *from* a lesson, it's pre-seeded with a system message containing:

- The lesson's title and body
- The full course title (so the LLM has framing)
- If launched from a code-block "Ask Fishbones" badge: the specific snippet the user clicked

The seed format:

\`\`\`
[Course: Bun Complete — Lesson: WebSocket compression — perMessageDeflate]

The user is reading this lesson:

> WebSocket frames are uncompressed by default — every byte you ws.send goes
> on the wire as-is. For chatty apps with text payloads...

User question follows.
\`\`\`

This dramatically improves answer quality compared to a blank chat — the LLM has the same context the user does.

## The chat hook

\`useAiChat\` is the most stateful hook in the codebase. It manages:

- Chat history (in memory, not persisted across launches)
- The active streaming message
- Backend probe state (installed / running / model present)
- Setup actions (install, start, pull-model) with re-probe coordination
- Token cap (truncate history if it would push the prompt past the model's window)

The streaming state machine is the trickiest part — see \`src/hooks/useAiChat.ts\` for the implementation.
`;

const phoneFloating = `Some lessons render to a phone-shaped frame instead of an inline iframe — specifically, React Native and Svelte mobile lessons. Why? Because:

- React Native components (\`<View>\`, \`<Text>\`, \`<ScrollView>\`) are designed for a phone-sized viewport. Showing them at desktop width looks wrong.
- The mental model "this code becomes a mobile app" is only meaningful when the preview *looks like a phone*.
- Touch interactions (long-press, swipe) make more sense in a portrait frame.

## What it looks like

A floating, draggable, resizable phone-shaped pane that sits on top of the workbench. The phone has a status bar, a notch, a home bar — visual cues that this is a mobile preview, not just a small browser.

## How it's wired

\`\`\`
┌──────────────────────────────────────────────────────────────┐
│  src/runtimes/reactnative.ts                                 │
│   - Builds the iframe HTML                                   │
│   - Includes react-native-web + Babel + AppRegistry shim     │
│   - Reads CSS theme tokens from the parent's :root            │
│                       │                                      │
│                       ▼                                      │
│  PreviewKind: 'reactnative' on the RunResult                 │
│                       │                                      │
│                       ▼                                      │
│  src/components/FloatingPhone/FloatingPhone.tsx              │
│   - Renders the iframe inside a phone bezel                  │
│   - Owns position + size (draggable + resizable)             │
│   - Persists position in localStorage                        │
│                                                              │
│  src/components/PhoneFrame/PhoneFrame.tsx                    │
│   - The bezel SVG + status bar + home bar                    │
└──────────────────────────────────────────────────────────────┘
\`\`\`

## Boot stages

The React Native runtime tracks compile/mount stages so the user sees what's happening:

\`\`\`ts
type BootStage =
  | 'loading-runtime'   // Babel + react-native-web bundle download
  | 'compiling'         // user JSX → JS
  | 'mounting'          // AppRegistry.runApplication
  | 'running'           // success — iframe shows the app
  | 'crashed';          // any phase threw
\`\`\`

Each stage transitions paint a different overlay:

- \`loading-runtime\` — full-phone shimmer with "Setting up React Native..."
- \`compiling\` — same shimmer, "Compiling your code..."
- \`crashed\` — red overlay with the error + stack

When \`running\`, the user's app is visible and the overlay is gone.

## Dev tools panel

\`src/components/Output/ReactNativeDevTools.tsx\` adds a small drawer to the floating phone:

- Toggle dark mode (writes a different theme token set into the iframe)
- Resize buttons for common phone sizes (iPhone 14, Pixel 7, iPhone SE)
- Reload (re-runs the user's code without re-fetching the runtime bundle)
- Console — the iframe's console output mirrored into the panel

## Pop out

Just like the workbench, the floating phone has a pop-out button. \`src/lib/phonePopout.ts\` opens a dedicated Tauri window containing only the phone. The two stay in sync via a Tauri-event bus (or BroadcastChannel in dev).

The phonePopout and workbenchSync helpers are nearly identical — both wrap "is this Tauri or a browser?" + a message bus. Consolidating them into one \`makePopoutBus\` helper is a moderate-payoff refactor. See [DRY findings](docs:dry-findings) item 9.

## Theme integration

The preview iframe reads the parent page's CSS variables on boot and copies them into its own \`:root\`:

\`\`\`ts
function currentThemeColors(): ReactNativePreviewTheme {
  if (typeof document === "undefined") return undefined;
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string) => cs.getPropertyValue(name).trim();
  return {
    bgPrimary:   get("--color-bg-primary"),
    bgSecondary: get("--color-bg-secondary"),
    textPrimary: get("--color-text-primary"),
    // ...
  };
}
\`\`\`

When the user switches the app theme, the next \`runFiles\` call picks up the new palette. The phone preview matches without a manual refresh.
`;

const themeSystem = `Three themes — \`light\`, \`dark\`, \`system\`. Picking \`system\` follows the OS-level preference via \`prefers-color-scheme\`. The default is system.

## CSS variable architecture

Themes are CSS-only. \`src/theme/themes.css\` defines a \`[data-theme="dark"]\` rule and a \`[data-theme="light"]\` rule, each setting a complete palette of \`--color-*\` variables:

\`\`\`css
/* src/theme/themes.css */

:root {
  /* Spacing, type, radii — theme-independent */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --radius-sm: 4px;
  --radius-md: 8px;
}

[data-theme="dark"] {
  --color-bg-primary: #0b0b10;
  --color-bg-secondary: #15151c;
  --color-bg-tertiary: #1f1f28;
  --color-text-primary: #f5f5f7;
  --color-text-secondary: #a4a4ad;
  --color-text-tertiary: #71717a;
  --color-border-default: rgba(255, 255, 255, 0.08);
  --color-accent: #ffb86c;
  /* ... ~40 more tokens */
}

[data-theme="light"] {
  --color-bg-primary: #ffffff;
  --color-text-primary: #15151c;
  /* ... */
}
\`\`\`

Components consume the variables, never the hex values:

\`\`\`css
.fishbones__lesson-reader {
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border-default);
}
\`\`\`

## Setting the active theme

\`useActiveTheme()\` is the hook:

\`\`\`ts
const { theme, setTheme } = useActiveTheme();
\`\`\`

Internally:

1. \`theme\` is the user's *preference* — \`'light' | 'dark' | 'system'\`. Persisted in localStorage.
2. The hook resolves \`'system'\` to \`'light'\` or \`'dark'\` based on \`window.matchMedia('(prefers-color-scheme: dark)')\`.
3. Sets \`document.documentElement.dataset.theme = 'dark' | 'light'\` so the CSS rules apply.
4. Listens for system preference changes and re-applies when on \`'system'\`.

## Monaco theme regeneration

Monaco doesn't know about CSS variables. Its theme is a plain JS object with hardcoded colors. Fishbones generates one Monaco theme per app theme, deriving the colors from the same palette:

\`\`\`ts
// src/theme/monaco-themes.ts (excerpt)

export const FISHBONES_DARK_THEME: monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment',   foreground: 'a4a4ad', fontStyle: 'italic' },
    { token: 'keyword',   foreground: 'ffb86c' },
    { token: 'string',    foreground: '8be9fd' },
    { token: 'number',    foreground: 'bd93f9' },
    { token: 'type',      foreground: '50fa7b' },
    // ... ~80 token rules
  ],
  colors: {
    'editor.background':  '#15151c',
    'editor.foreground':  '#f5f5f7',
    // ... ~30 chrome colors
  },
};
\`\`\`

The Monaco theme switches whenever the app theme switches:

\`\`\`ts
// src/lib/monaco-setup.ts
useEffect(() => {
  monaco.editor.setTheme(activeTheme === 'dark' ? 'fishbones-dark' : 'fishbones-light');
}, [activeTheme]);
\`\`\`

## Adding a new theme

1. Append a \`[data-theme="solarized"]\` rule to \`themes.css\` with the full \`--color-*\` set.
2. Add a Monaco theme to \`monaco-themes.ts\`.
3. Append \`'solarized'\` to the \`ThemeName\` union in \`src/theme/themes.ts\`.
4. Add a chip to the Settings dialog's theme picker.

That's it. No component changes — every component already reads from variables.

## Color palette philosophy

Fishbones uses a small, restrained palette per theme — about 8 background tones, 5 text tones, 4 accent colors. Code highlighting (Shiki + Monaco) gets a wider palette. The CSS variables enforce the "small palette" — components can't reach for an arbitrary hex.

The reference palette is documented at the top of \`themes.css\` for designers tweaking colors:

\`\`\`css
/*
 * DARK THEME PALETTE
 *
 * Backgrounds (low contrast → high contrast)
 *   --color-bg-primary    #0b0b10  the chrome
 *   --color-bg-secondary  #15151c  panels, cards
 *   --color-bg-tertiary   #1f1f28  elevated surfaces
 *
 * Text (high readability → low)
 *   --color-text-primary   #f5f5f7  body
 *   --color-text-secondary #a4a4ad  secondary
 *   --color-text-tertiary  #71717a  hints, captions
 *
 * Accents
 *   --color-accent         #ffb86c  primary CTA
 *   --color-success        #50fa7b  passing tests, complete dots
 *   --color-warning        #f1fa8c  warnings
 *   --color-error          #ff5555  failing tests, errors
 */
\`\`\`
`;

const bundledPacks = `Fishbones ships with ~30 courses pre-bundled into the binary. They appear in the Library on first launch with no install step.

## Where they live

In source: \`src-tauri/resources/bundled-packs/\`:

\`\`\`
src-tauri/resources/bundled-packs/
├── javascript-crash-course.fishbones
├── python-crash-course.fishbones
├── learning-go.fishbones
├── the-rust-programming-language.fishbones
├── learning-react-native.fishbones
├── fluent-react.fishbones
├── interactive-web-development-with-three-js-and-a-frame.fishbones
├── introduction-to-computer-organization-arm.fishbones
├── javascript-the-definitive-guide.fishbones
├── react-native.fishbones
├── svelte-5-complete.fishbones
├── bun-complete.fishbones
├── htmx-fundamentals.fishbones
├── solidjs-fundamentals.fishbones
├── astro-fundamentals.fishbones
├── bun-fundamentals.fishbones
├── tauri-2-fundamentals.fishbones
├── challenges-rust-handwritten.fishbones
├── challenges-go-handwritten.fishbones
├── challenges-c-handwritten.fishbones
├── challenges-cpp-handwritten.fishbones
├── challenges-java-handwritten.fishbones
├── challenges-kotlin-handwritten.fishbones
├── challenges-csharp-handwritten.fishbones
├── challenges-swift-handwritten.fishbones
├── challenges-javascript-handwritten.fishbones
├── challenges-python-handwritten.fishbones
├── challenges-reactnative-handwritten.fishbones
├── challenges-typescript-mo9c9k2o.fishbones
├── challenges-rust-mo9bapm1.fishbones
├── challenges-go-mo9kijkd.fishbones
└── challenges-assembly-handwritten.fishbones
\`\`\`

Tauri's resource bundling copies that whole directory into the platform-specific bundle:

\`\`\`toml
# src-tauri/tauri.conf.json (snippet)
{
  "bundle": {
    "resources": ["resources/bundled-packs/**/*"]
  }
}
\`\`\`

After build, on macOS, they live at:

\`\`\`
Fishbones.app/Contents/Resources/resources/bundled-packs/
\`\`\`

## First-launch seeding

\`src-tauri/src/courses.rs::ensure_seed\` runs on every app launch. It:

1. Lists every \`.fishbones\` (or legacy \`.kata\`) file in the resource dir
2. For each, peeks at \`course.json::id\` without unzipping the whole thing
3. **If the user already has a course directory at \`<app-data>/courses/<id>/\`** — skip (don't overwrite user edits / progress)
4. **If the id is in \`seeded-packs.json\`** — skip (the user has explicitly deleted this pack at some point — respect that)
5. **Otherwise** — unzip into \`<app-data>/courses/\` and add the id to \`seeded-packs.json\`

The marker file \`seeded-packs.json\` is the user's "pin" — once a course id has been seeded once, it's recorded forever. Deleting the course removes the directory but keeps the id in the marker, so next launch we know not to resurrect it.

\`\`\`json
// <app-data>/seeded-packs.json
{
  "seedIds": [
    "javascript-crash-course",
    "bun-complete",
    "svelte-5-complete",
    ...
  ]
}
\`\`\`

> [!TIP]
> If you're testing the seeder, delete \`seeded-packs.json\` (not the courses dir) to force a re-seed on next launch. Or call the Rust command \`reset_seeded_packs_marker\` if you've added that path.

## Authoring a bundled pack

Two-step workflow:

1. **Author** — write a Python builder script that produces a \`.fishbones\` archive. The archive is just a zip of one \`course.json\` (and optionally \`cover.png\`).
2. **Drop** — copy the archive into \`src-tauri/resources/bundled-packs/\`. The next \`tauri:build\` includes it; the next \`tauri:dev\` launch picks it up via the seeder.

Example builder:

\`\`\`python
#!/usr/bin/env python3
import json, zipfile

course = {
    "id": "my-course",
    "title": "My course",
    "description": "...",
    "language": "javascript",
    "chapters": [
        {
            "id": "intro",
            "title": "Intro",
            "lessons": [
                {
                    "id": "r1",
                    "kind": "reading",
                    "title": "Hello",
                    "body": "# Hello\\nWelcome!"
                }
            ]
        }
    ],
}

OUT = "/Users/.../Fishbones/src-tauri/resources/bundled-packs/my-course.fishbones"

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("course.json", json.dumps(course, indent=2))
\`\`\`

Run \`python3 build-my-course.py\`, then \`bun run tauri:dev\`. Your course appears in the Library.

## .fishbones vs .kata

Older versions used \`.kata\` as the extension. The seeder reads both:

\`\`\`rust
match path.extension().and_then(|s| s.to_str()) {
    Some("fishbones") | Some("kata") => { /* import */ }
    _ => continue,
}
\`\`\`

Going forward, all new packs use \`.fishbones\`. Existing \`.kata\` files keep working — no migration needed.
`;

const playgroundDoc = `The playground is a free-form code editor — no lesson, no tests, just a Monaco pane that runs whatever you type.

## What you can do

- Pick a language from a dropdown
- Get a starter template loaded
- Edit, run, see output
- Switch languages — your last buffer per language is remembered

It's "open the editor, hack on something" — useful for noodling on syntax, testing a snippet from Stack Overflow, or sketching out something before turning it into a lesson.

## The state model

\`usePlaygroundFiles(language)\` is the equivalent of \`useWorkbenchFiles\` but keyed by *language* instead of by lesson. Each language has its own buffer:

\`\`\`ts
// localStorage key
\`playground:files:javascript\`
\`playground:files:rust\`
\`playground:files:python\`
\`\`\`

Switching languages swaps the visible buffer but keeps the others on disk. You can be mid-experiment in five languages simultaneously.

## Templates

\`src/runtimes/playgroundTemplates.ts\` is the registry of starter content per language. Each entry is either a single file or a multi-file array:

\`\`\`ts
// Single-file
javascript: {
  filename: "user.js",
  fileLanguage: "javascript",
  content: \`console.log("Hello, world!");\\n\`,
},

// Multi-file
web: {
  filename: "index.html",
  fileLanguage: "html",
  content: WEB_TEMPLATE_FILES[0].content,
  files: WEB_TEMPLATE_FILES,
},
\`\`\`

When you switch to a language for the first time (no localStorage entry yet), the template is loaded. After that, your edits persist.

## Run loop

Same as the workbench — \`runFiles(language, files)\` from \`src/runtimes/index.ts\`. The playground doesn't pass a \`testCode\`, so the result has logs / errors but no test rows.

## Cmd+Enter

Cmd+Enter (Ctrl+Enter on Linux/Windows) is the run shortcut — registered as a Monaco keybinding. The same shortcut works in workbench exercises.

## Why it's a separate view

You could imagine the playground being a *special lesson*. It's not, because:

- It has no lesson body
- It has no completion semantics
- The state lives by language, not by lesson id
- The dropdown is a UI affordance, not a lesson field

Keeping it separate also makes the dispatcher cleaner — the lesson view doesn't have a "no lesson" branch.
`;

const progressXp = `Fishbones tracks progress with three structures, each with a different lifecycle:

| Structure | Lives in | Lifecycle |
|---|---|---|
| **Completions** | sqlite (\`completions\`) | Permanent — one row per (course, lesson) finished |
| **Daily XP** | sqlite (\`daily_xp\`) | Permanent — aggregated per UTC day |
| **Streak** | derived | Computed at read time from \`daily_xp\` |

## Completions

When you pass a lesson, \`mark_completion\` writes a row:

\`\`\`sql
INSERT OR REPLACE INTO completions (course_id, lesson_id, completed_at)
VALUES (?, ?, strftime('%s', 'now'));
\`\`\`

The frontend re-reads completions whenever the sidebar / library renders — \`useProgress::list_completions\`. The result populates the green dots on lesson rows and the chapter \`x / y\` counters.

## XP

Each lesson awards XP on completion:

| Lesson kind | XP |
|---|---|
| Reading | 5 |
| Quiz | 10 |
| Exercise | 20 |
| Mixed | 25 |

XP is added to the **current UTC day's row** in \`daily_xp\`:

\`\`\`sql
INSERT INTO daily_xp (day, xp)
VALUES (strftime('%Y-%m-%d', 'now'), ?)
ON CONFLICT(day) DO UPDATE SET xp = xp + excluded.xp;
\`\`\`

Lifetime XP = sum of all daily rows. Today's XP = the today row.

> [!NOTE]
> XP is **not** awarded for re-completing a lesson you'd already finished. The completion row is a primary key — re-completion is a no-op on the completions table. The XP grant logic checks "was this completion new?" and skips the daily_xp bump if not.

## Streak

The streak is computed, not stored:

\`\`\`ts
function streakLength(dailyXpRows: { day: string; xp: number }[]): number {
  // Walk backward from today; count consecutive days with xp > 0.
  // The streak breaks the moment we hit a day with no XP.
}
\`\`\`

The result is shown as the flame emoji + count in the top-right corner of the app:

\`\`\`
🔥 12      ← 12-day streak
\`\`\`

Click it for a calendar view in the **Profile** page — each day cell colored by XP earned.

## Why UTC, not local?

Streak math doesn't work cleanly with timezone shifts. UTC means the day boundary is fixed everywhere; "complete a lesson before midnight" is well-defined globally. The downside: in some timezones (e.g. Pacific) the rollover happens at 4 PM local, which can feel weird. We accept the trade-off — most users in any one location adapt quickly.

## The Profile page

\`src/components/Profile/ProfileView.tsx\` aggregates everything:

- Total XP (lifetime)
- Today's XP
- Streak (current + longest)
- Calendar heatmap of the past year
- Per-language progress bars (% of available lessons completed)
- "Generate challenge pack" CTA — opens the challenge-pack ingest dialog

It's a read-mostly view — it triggers a fresh \`list_completions\` and \`list_daily_xp\` on mount and renders.
`;

const cloudSync = `Fishbones is **offline-first** but offers optional cloud sync via a paired backend (\`fishbones-api\`). Sign-in is a one-time setup; once paired, completions and stats sync across machines.

## What syncs

- Completions (\`completions\` table)
- Daily XP rows (\`daily_xp\` table)
- Recent-courses timestamps

What does **not** sync:

- Course archives themselves (those live on disk; you import them per machine)
- Workbench drafts (your in-progress code; lives only in localStorage)
- AI chat history (in-memory only)
- Settings (per-machine)

The rationale: course archives can be huge (hundreds of MB if a course has video), and they're already portable via the bundle format. Sync is for *progress*, not *content*.

## Backend

The \`fishbones-api\` repo (sibling to \`kata\`) is a lightweight Bun.serve API. Endpoints:

\`\`\`
POST /auth/sign-in       { email, password }    → { token, user }
POST /auth/sign-out      Bearer token            → 204
GET  /sync/state         Bearer token            → { completions, dailyXp, recents }
POST /sync/upsert        Bearer token + body     → 204
\`\`\`

The schema is a thin mirror of the local sqlite tables, plus a \`user_id\` foreign key.

## The sync flow

\`useFishbonesCloud\` runs a sync pass every ~60 seconds while signed in (and on Tauri window-focus events):

1. \`GET /sync/state\` — fetch the server's view
2. \`local_completions\` ⊆ \`server_completions\` ? upsert anything we have that server doesn't
3. \`server_completions\` ⊆ \`local_completions\` ? insert anything server has that we don't
4. Same for \`daily_xp\` and recents

Conflicts (same row, different completed_at): server timestamp wins. The server gets the *first* completion timestamp; if you finish a lesson on machine A then re-complete on machine B, machine B's timestamp is dropped on the next sync.

## Sign-in UI

\`\`\`
Settings → Sign in
   ┌─────────────────────────┐
   │  Email     [          ] │
   │  Password  [          ] │
   │            [ Sign in  ] │
   │  ─────── or ────────    │
   │  [ Sign up ]            │
   └─────────────────────────┘
\`\`\`

\`SignInDialog\` calls the backend, stores the token + user in localStorage, and triggers a first sync. Subsequent launches read the token and proceed.

> [!WARNING]
> The token is stored in localStorage in plaintext. This is acceptable for a desktop app where the local user is implicitly trusted (the OS account boundary is the security model). It would NOT be acceptable for a browser app.

## First-launch prompt

If the user hasn't signed in (or out), the app shows a **FirstLaunchPrompt** modal once: "Sign in to sync progress, or skip." Either choice persists — there's no nag.

## Hooks

\`useFishbonesCloud\` exposes:

\`\`\`ts
const {
  user,                  // current user or null
  signedIn,              // boolean
  loading,
  error,
  signIn,                // (email, password) => Promise<void>
  signUp,
  signOut,
  syncNow,               // force an immediate sync
  lastSyncedAt,
} = useFishbonesCloud();
\`\`\`

It's the most network-aware hook in the app. The implementation handles offline gracefully — if the server is unreachable, syncs are queued and retry on the next interval. Local writes never block on network.

## Privacy

Everything that syncs is **progress metadata** — lesson ids, course ids, timestamps, XP amounts. No code snippets, no chat history, no file content. The backend never sees what you wrote in an exercise.
`;

const dryFindings = `This page captures the codebase audit performed during the docs-system buildout. Each finding is a concrete refactor opportunity. They're ordered roughly by **payoff per hour of effort**.

## Top 10 refactors, ranked

### 1. \`MODEL_PRICING\` + \`costFor()\` duplicated 5×

The Anthropic / Ollama pricing table is hardcoded in:

- \`src/ingest/pipeline.ts\` lines 88–92
- \`src/ingest/ingestDocsSite.ts\` lines 632–636
- \`src/ingest/generateChallengePack.ts\` lines 146–150
- \`src/ingest/enrichCourse.ts\` lines 56–60
- \`src/ingest/retryLesson.ts\` lines 114–118

\`\`\`ts
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-opus-4-5":   { input: 15, output: 75 },
  "claude-haiku-4-5":  { input: 1, output: 5 },
};
\`\`\`

Same content in every file. When Anthropic updates rates, you fix it in 5 places — and forget one.

**Fix:** Extract to \`src/ingest/pricing.ts\`:

\`\`\`ts
export const MODEL_PRICING = { /* ... */ };

export function costFor(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const m = MODEL_PRICING[model];
  if (!m) return 0;
  return (inputTokens * m.input + outputTokens * m.output) / 1_000_000;
}
\`\`\`

**Effort:** 15 minutes. **Payoff:** 20 lines deleted, single point of change.

### 2. \`LlmResponseTS\` interface duplicated 6×

Same shape in 6 ingest files:

\`\`\`ts
interface LlmResponseTS {
  text: string;
  input_tokens: number;
  output_tokens: number;
  elapsed_ms: number;
}
\`\`\`

**Fix:** One export from \`src/ingest/types.ts\`. **Effort:** 5 minutes. **Payoff:** 30 lines, type drift impossible.

### 3. \`useLocalStorage<T>\` hook missing

Pattern repeated in:

- \`src/hooks/usePlaygroundFiles.ts\` — \`readStored\` + \`writeStored\`
- \`src/hooks/useWorkbenchFiles.ts\` — same
- \`src/hooks/useRecentCourses.ts\` — manual \`loadInitial\`
- \`src/hooks/useFishbonesCloud.ts\` — \`readToken\` / \`writeToken\` / \`readUser\` / \`writeUser\`

Every one of these is a small variation on:

\`\`\`ts
function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; }
  catch { return fallback; }
}
function write<T>(key: string, value: T): void {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* quota / private mode */ }
}
\`\`\`

**Fix:** Single hook in \`src/hooks/useLocalStorage.ts\`:

\`\`\`ts
export function useLocalStorage<T>(
  key: string,
  initial: T,
  validate?: (v: unknown) => v is T,
): [T, (v: T) => void] { /* ... */ }
\`\`\`

Then retrofit the 4 hooks. **Effort:** 1 hour. **Payoff:** ~120 lines deleted, one place to fix quota / sandboxed-iframe / private-mode quirks.

### 4. \`useDebouncedCallback<T>\` hook missing

Two hooks (\`usePlaygroundFiles\`, \`useWorkbenchFiles\`) reimplement debounced-save with a 400 ms timer + ref tracking + unmount flush:

\`\`\`ts
const latestRef = useRef(value);
latestRef.current = value;

useEffect(() => {
  const handle = setTimeout(() => fn(latestRef.current), delayMs);
  return () => clearTimeout(handle);
}, [value]);

useEffect(() => {
  return () => fn(latestRef.current);   // unmount flush
}, []);
\`\`\`

**Fix:** \`src/hooks/useDebouncedCallback.ts\`. **Effort:** 30 minutes. **Payoff:** 40 lines, prevents unmount-ordering bugs.

### 5. \`useAsync<T>\` hook missing

Pattern in \`useProgress\`, \`useToolchainStatus\`, parts of \`useAiChat\` and \`useCourses\`:

\`\`\`ts
useEffect(() => {
  let cancelled = false;
  setLoading(true);
  invoke<T>("cmd", args)
    .then(data => { if (!cancelled) { setData(data); setLoading(false); } })
    .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
  return () => { cancelled = true; };
}, [deps]);
\`\`\`

**Fix:** \`useAsync(asyncFn, deps)\` returning \`{ data, loading, error }\`. **Effort:** 30 minutes. **Payoff:** 60 lines, fewer cancellation-flag bugs.

### 6. \`CONSOLE_SHIM\` duplicated across 4 runtimes

The "patch console → postMessage to parent" template appears in:

- \`runtimes/web.ts\` lines 23–61
- \`runtimes/react.ts\` lines 213–245
- \`runtimes/reactnative.ts\` lines ~150–190 (embedded)
- (omitted from \`runtimes/svelte.ts\` — relies on parent injection)

**Fix:** Extract to \`src/runtimes/templates/consoleShim.ts\` and import. **Effort:** 30 minutes. **Payoff:** 70 lines, one place to fix console-capture edge cases (e.g. \`console.table\`, structured logs).

### 7. Modal-dialog wrapper component missing

Same JSX skeleton in:

- \`SettingsDialog.tsx\` lines 175–181
- \`CourseSettingsModal.tsx\` lines 230–250
- \`BulkImportDialog.tsx\` lines 230–250
- \`ImportDialog.tsx\`

\`\`\`tsx
<div className="*-backdrop" onClick={onDismiss}>
  <div className="*-panel" onClick={(e) => e.stopPropagation()}>
    <div className="*-header">
      <div className="*-title">{title}</div>
      <button className="*-close" onClick={onDismiss}>×</button>
    </div>
    <div className="*-body">{children}</div>
  </div>
</div>
\`\`\`

**Fix:** \`<ModalDialog title={} onDismiss={}>{children}</ModalDialog>\` in \`src/components/Shared/\`. **Effort:** 1 hour. **Payoff:** Consistent dismiss behavior, accessibility easier to audit (focus trap goes in one place).

### 8. \`languageLabel()\` switch duplicated

\`src/components/Sidebar/Sidebar.tsx\` lines 26–73 has a 50-line switch over \`LanguageId\` returning the display name. The same data is already in \`src/lib/languages.tsx::LANGUAGE_META\`:

\`\`\`ts
LANGUAGE_META.javascript.label;   // "JavaScript"
LANGUAGE_META.rust.label;         // "Rust"
\`\`\`

The Sidebar switch is dead duplication.

**Fix:** Replace with \`languageMeta(lang).label\`. Same fix on \`BookCover.tsx::langGlyph\` (lines 155–202) — the carousel glyph map is also duplicated. **Effort:** 30 minutes. **Payoff:** 100+ lines deleted; one place to add a new language label.

### 9. \`runFiles\` dispatcher → router registry

\`runtimes/index.ts\` lines 119–185 has 67 lines of \`if language === X\` branches mixed with heuristics (\`isWebLesson\`, \`looksLikeReactNative\`, \`looksLikeSvelteKit\`).

**Fix:** Convert to a route table:

\`\`\`ts
interface Route {
  match: (lang: LanguageId, files: WorkbenchFile[]) => boolean;
  run: (language: LanguageId, files: WorkbenchFile[], testCode?: string, assets?: WorkbenchAsset[]) => Promise<RunResult>;
}

const ROUTES: Route[] = [
  { match: l => l === "reactnative", run: (_, f) => runReactNative(f, currentThemeColors()) },
  { match: l => l === "react",       run: (_, f) => runReact(f) },
  { match: l => l === "svelte" && looksLikeSvelteKit(/* ... */), run: ... },
  /* ... */
];

export async function runFiles(language, files, testCode, assets) {
  const route = ROUTES.find(r => r.match(language, files));
  return route ? route.run(language, files, testCode, assets) : runFallback();
}
\`\`\`

**Effort:** 1 hour. **Payoff:** Adding a new runtime is a table-edit, not a branch insert.

### 10. \`pushEvent()\` helper for the 500-event ring buffer

\`useIngestRun.ts\` has the same 5-line pattern at lines 135–139, 233–239, 297–303, 379–385, 556–565, 659–665:

\`\`\`ts
const next = r.events.length >= 500 ? r.events.slice(-499) : r.events.slice();
next.push(ev);
return { ...r, events: next };
\`\`\`

**Fix:** One helper. **Effort:** 5 minutes. **Payoff:** Tune the cap in one place; unify the pattern.

## Smaller wins (each <30 min)

| Pattern | Files | LOC saved |
|---|---|---|
| Base64 encoding utility | 3 runtimes | 9 |
| Abort exception factory | 6 ingest files | 30 |
| Settings row component | 4 dialogs | 30 |
| Confirmation-action component | 2 dialogs | 40 |
| Empty-state component | 3 places | small |
| \`pushSidebarMenu\` hook | Sidebar | 100 |
| Filter pill component | CourseLibrary | 30 |

## Larger refactors (longer-term)

### \`buildPreviewHtml\` factory

The 3 web-iframe runtimes (\`react.ts\`, \`reactnative.ts\`, \`svelte.ts\`) each have a \`buildPreviewHtml\` that's 60–80% structural overlap (HTML skeleton, error overlay, console shim, base64-encoded source) and 20–40% language-specific (Babel vs Svelte compiler vs nothing).

A \`PreviewBuilder\` factory accepting per-runtime "phases" would consolidate ~250 lines while keeping the runtime-specific bits clear.

**Effort:** half a day. **Payoff:** Adding a new framework runtime becomes plug-and-play.

### Course-store coalescence

\`useCourses\`, \`useProgress\`, \`useRecentCourses\` each independently fetch from sqlite/localStorage on mount. A unified \`useCourseLibrary()\` could coalesce the three into one IPC round-trip on launch (currently 3+).

**Effort:** half a day. **Payoff:** Faster cold start, single refresh point.

### Ingest \`pipelineUtils\`

Every ingest file redefines \`emit\`, \`checkAbort\`, \`timedInvoke\`, \`callLlm\` with ~80 lines of overlap. A \`createPipelineHelpers(onEvent, signal, stats)\` factory that returns all four would clean up the 5 ingest pipelines.

**Effort:** 1–2 days (good abstraction needed). **Payoff:** ~150 lines deleted; new pipelines are 30% smaller.

## Already clean

These look refactor-able but actually aren't:

- \`languages.tsx\` itself — already data-driven via \`LANGUAGE_META\`. No switch/case to consolidate.
- \`workbenchFiles.ts\` vs \`workbenchSync.ts\` — clean separation (data vs IPC). No overlap.
- \`Sidebar.tsx\` sub-components (\`SidebarNavItem\`, \`CourseGroup\`, \`ChapterBlock\`, \`LessonRow\`) — already extracted properly.
- \`AiChatPanel.tsx\` — internal sub-components already split.

## How to use this list

Each finding is **independent** — you can tackle them in any order. The top 10 are highest payoff per hour; the rest are polish. None of them require architectural changes — they're all "extract this thing that's already a pattern" rather than "rethink this part of the app."

When picking up one, check the actual line numbers (this doc may drift) and re-read the surrounding code before editing — the cited locations may have moved.
`;

const keyboard = `Fishbones registers a small set of global keyboard shortcuts. Most are scoped to the workbench when an exercise is active.

## Global

| Shortcut | Action |
|---|---|
| \`Cmd+K\` / \`Ctrl+K\` | Open command palette |
| \`Cmd+,\` / \`Ctrl+,\` | Open settings |
| \`Cmd+\\\\\` / \`Ctrl+\\\\\` | Toggle sidebar |
| \`Cmd+Shift+P\` | Open command palette (alt) |
| \`Esc\` | Dismiss the topmost modal / popover |

## Lesson navigation

| Shortcut | Action |
|---|---|
| \`Cmd+ArrowRight\` | Next lesson |
| \`Cmd+ArrowLeft\` | Previous lesson |
| \`Cmd+M\` | Mark current reading lesson complete |

## Workbench (when editor is focused)

| Shortcut | Action |
|---|---|
| \`Cmd+Enter\` | Run code |
| \`Cmd+Shift+H\` | Show next hint |
| \`Cmd+Shift+R\` | Reset to starter |
| \`Cmd+Shift+S\` | Reveal solution |
| \`Cmd+/\` | Toggle line comment |
| \`Cmd+B\` | Pop out workbench window |

## Phone preview

| Shortcut | Action |
|---|---|
| \`Cmd+Shift+P\` (when phone focused) | Pop out phone window |
| \`Cmd+Shift+R\` | Reload preview without re-fetching runtime |

## Why so few?

Fishbones is mouse-first by design — clicking lessons, selecting courses, dragging the phone — these don't have keyboard equivalents because they don't need them.

The exceptions are the actions you do *frequently inside the editor*: run, hint, reset. Those have keys because hand-to-mouse round-trips while typing are a tax.

## Customization

Shortcuts aren't user-customizable yet. The bindings live in:

- \`src/components/CommandPalette/CommandPalette.tsx\` — \`Cmd+K\`
- \`src/components/Editor/EditorPane.tsx\` — Monaco command bindings
- \`src/App.tsx\` — global bindings

If you fork the app, search for those keybinding registrations and edit in place. A user-configurable shortcut UI is a candidate for a future settings panel.
`;

const sections: DocsSection[] = [
  {
    id: "getting-started",
    title: "Getting started",
    pages: [
      { id: "welcome", title: "Welcome to Fishbones", tagline: "What this app is and what to expect", body: welcome },
      { id: "installing", title: "Installing", tagline: "Dev setup, building a release", body: installing },
      { id: "first-course", title: "Your first course", tagline: "The 5-minute tour", body: firstCourse },
    ],
  },
  {
    id: "architecture",
    title: "Architecture",
    pages: [
      { id: "overview", title: "Overview", tagline: "The four layers", body: archOverview },
      { id: "tauri-backend", title: "The Tauri backend", tagline: "Rust commands, sqlite, and the AI proxy", body: tauriBackend },
      { id: "react-frontend", title: "The React frontend", tagline: "View state, components, hooks", body: reactFrontend },
    ],
  },
  {
    id: "courses",
    title: "Course system",
    pages: [
      { id: "course-format", title: "The course format", tagline: ".fishbones, course.json, lesson kinds", body: courseFormat },
      { id: "bundled-packs", title: "Bundled packs", tagline: "First-launch seeding + the marker file", body: bundledPacks },
    ],
  },
  {
    id: "runtimes",
    title: "Runtime layer",
    pages: [
      { id: "runtime-layer", title: "How code runs", tagline: "Dispatcher, sandboxes, native runtimes", body: runtimeLayer },
      { id: "workbench", title: "The workbench", tagline: "Multi-file editor, run loop, pop-out", body: workbench },
      { id: "playground", title: "The playground", tagline: "Free-form editor sandbox", body: playgroundDoc },
      { id: "floating-phone", title: "The floating phone", tagline: "React Native + Svelte mobile preview", body: phoneFloating },
    ],
  },
  {
    id: "subsystems",
    title: "Subsystems",
    pages: [
      { id: "ingest", title: "The ingest pipeline", tagline: "PDF, docs site, challenge pack generation", body: ingestPipeline },
      { id: "ai-assistant", title: "The AI assistant", tagline: "Ollama and Anthropic backends", body: aiAssistant },
      { id: "progress", title: "Progress, XP, streaks", tagline: "Completion tracking and the daily counter", body: progressXp },
      { id: "cloud-sync", title: "Cloud sync (optional)", tagline: "Cross-machine progress sync", body: cloudSync },
      { id: "theme", title: "The theme system", tagline: "CSS variables, Monaco regeneration", body: themeSystem },
    ],
  },
  {
    id: "reference",
    title: "Reference",
    pages: [
      { id: "keybindings", title: "Keyboard shortcuts", tagline: "Every binding in the app", body: keyboard },
      { id: "dry-findings", title: "Refactor opportunities", tagline: "Audit notes — DRY violations and componentization wins", body: dryFindings },
    ],
  },
];

export const FISHBONES_DOCS: DocsSection[] = sections;

/// Flat list of all pages for quick lookups by id.
export const FISHBONES_DOCS_INDEX: ReadonlyMap<string, { section: DocsSection; pageIndex: number }> =
  (() => {
    const m = new Map<string, { section: DocsSection; pageIndex: number }>();
    for (const section of sections) {
      section.pages.forEach((p, i) => m.set(p.id, { section, pageIndex: i }));
    }
    return m;
  })();
