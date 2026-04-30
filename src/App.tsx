import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { onOpenUrl, getCurrent as getCurrentDeepLinks } from "@tauri-apps/plugin-deep-link";
import {
  Course,
  Lesson,
  filterCourseForDesktop,
  isCloze,
  isExerciseKind,
  isMicroPuzzle,
  isQuiz,
} from "./data/types";
import { makeBus, openPoppedWorkbench, closePoppedWorkbench } from "./lib/workbenchSync";
import { deriveSolutionFiles } from "./lib/workbenchFiles";
import { Icon } from "@base/primitives/icon";
import { libraryBig } from "@base/primitives/icon/icons/library-big";
import { panelLeftOpen } from "@base/primitives/icon/icons/panel-left-open";
import "@base/primitives/icon/icon.css";
import Sidebar from "./components/Sidebar/Sidebar";
import TopBar from "./components/TopBar/TopBar";
import LessonReader from "./components/Lesson/LessonReader";
import LessonNav from "./components/Lesson/LessonNav";
import EditorPane from "./components/Editor/EditorPane";
import OutputPane from "./components/Output/OutputPane";
import PhoneToggleButton from "./components/FloatingPhone/PhoneToggleButton";
import {
  openPhonePopout,
  closePhonePopout,
  makePhonePreviewBus,
} from "./lib/phonePopout";
import Workbench from "./components/Workbench/Workbench";
import MissingToolchainBanner from "./components/MissingToolchain/MissingToolchainBanner";
import { useToolchainStatus } from "./hooks/useToolchainStatus";
import ImportDialog from "./components/ImportDialog/ImportDialog";
import BulkImportDialog from "./components/ImportDialog/BulkImportDialog";
import DocsImportDialog from "./components/ImportDialog/DocsImportDialog";
import SettingsDialog from "./components/SettingsDialog/SettingsDialog";
import CourseLibrary from "./components/Library/CourseLibrary";
import ArchiveDropOverlay from "./components/Library/ArchiveDropOverlay";
import { useArchiveDrop } from "./hooks/useArchiveDrop";
import { DeferredMount, LoadingPane } from "./components/Shared/DeferredMount";
import FishbonesLoader from "./components/Shared/FishbonesLoader";
import DottedGradientBg from "./components/Shared/DottedGradientBg";
import ConfirmDialog from "./components/ConfirmDialog/ConfirmDialog";
import CourseSettingsModal from "./components/CourseSettings/CourseSettingsModal";
import FloatingIngestPanel from "./components/IngestPanel/FloatingIngestPanel";
import ProfileView from "./components/Profile/ProfileView";
import PlaygroundView from "./components/Playground/PlaygroundView";
import DocsView from "./components/Docs/DocsView";
import { FISHBONES_DOCS } from "./docs/pages";
import { isWeb, isMobile } from "./lib/platform";
import GeneratePackDialog from "./components/ChallengePack/GeneratePackDialog";
import { useIngestRun } from "./hooks/useIngestRun";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import QuizView from "./components/Quiz/QuizView";
// Cloze (fill-in-the-blank) lessons render the same on phone + desktop
// — a code block with inline tappable chips. Reusing MobileCloze
// here keeps the chip rendering, option-pick sheet, and validation
// flow in one place; only the parent layout differs by surface.
import MobileCloze from "./mobile/MobileCloze";
// Same story for micro-puzzles: stack of single-line drills with
// Shiki highlighting + inline chips. The component is surface-
// agnostic; we wrap it in the desktop column-layout chrome below.
import MobileMicroPuzzle from "./mobile/MobileMicroPuzzle";
import AiAssistant from "./components/AiAssistant/AiAssistant";
import MobileApp from "./mobile/MobileApp";
import { InstallBanner } from "./components/InstallBanner/InstallBanner";
import CommandPalette from "./components/CommandPalette/CommandPalette";
import { VerifyCourseOverlay, type VerifySessionView } from "./components/VerifyCourse";
import FixApplierDialog from "./components/FixApplier/FixApplierDialog";
import {
  verifyCourse,
  verifyAllCourses,
  collectVerifyTargets,
} from "./lib/verifyCourse";
import { syncBundledToInstalled } from "./lib/courseSync";
import {
  emitEvent as emitVerifierEvent,
  onCommand as onVerifierCommand,
} from "./lib/verifierBus";
import { runFiles, isPassing, type RunResult } from "./runtimes";
import { useProgress } from "./hooks/useProgress";
import { useFishbonesCloud } from "./hooks/useFishbonesCloud";
import FirstLaunchPrompt from "./components/SignInDialog/FirstLaunchPrompt";
import SignInDialog from "./components/SignInDialog/SignInDialog";
import { useCourses } from "./hooks/useCourses";
import { useRecentCourses } from "./hooks/useRecentCourses";
import { useStreakAndXp } from "./hooks/useStreakAndXp";
import { useWorkbenchFiles } from "./hooks/useWorkbenchFiles";
import "./App.css";

interface OpenCourse {
  courseId: string;
  lessonId: string;
}

/// Languages that need a local compiler / VM / assembler installed on
/// the host before lessons in them can run. Used by LessonView to
/// decide whether to proactively probe the toolchain + show an install
/// banner. Everything else (JavaScript / TypeScript / Python / Web /
/// Three.js / React Native) runs fully in-browser OR hits an online
/// sandbox (Rust / Go / Swift) so the local machine doesn't need a
/// toolchain. Matches the set of languages `nativeRunners.ts` routes
/// to Tauri `run_*` commands.
const NATIVE_TOOLCHAIN_LANGUAGES = new Set<string>([
  "c",
  "cpp",
  "java",
  "kotlin",
  "csharp",
  "assembly",
]);

export default function App() {
  // Mobile short-circuit. Renders a totally separate component tree
  // (no TopBar, no Sidebar, no editor) when running on a phone-sized
  // device. We bail before instantiating the desktop hooks tree so we
  // don't pay for any of the chrome the mobile UI doesn't use.
  if (isMobile) {
    return <MobileApp />;
  }

  const {
    courses: coursesAll,
    loaded: coursesLoaded,
    refresh: refreshCourses,
    hydrateCourse,
    hydrating,
  } = useCourses();

  // Desktop hides drill-style lesson kinds (puzzle / cloze / micropuzzle)
  // from every navigation surface — they're mobile/watch-first formats
  // designed for big tap targets, and on desktop the underlying
  // `ExerciseLesson` they auto-derive from is the better presentation.
  // Stats and completion records still credit drill completions; we keep
  // `coursesAll` around for `useStreakAndXp` so XP / streak stay correct
  // across devices. Every other downstream consumer (Sidebar, Library,
  // CommandPalette, ProfileView, tab tracker, lesson lookup) gets the
  // filtered list — see `filterCourseForDesktop` in data/types.ts for
  // the rule.
  const courses = useMemo(
    () => coursesAll.map(filterCourseForDesktop),
    [coursesAll],
  );

  const [openTabs, setOpenTabs] = useState<OpenCourse[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(0);

  /// `cmd+K → "Verify this course"` session state. Null when no
  /// verification is in flight or visible. The overlay component
  /// renders this snapshot; mutation happens through `setVerifySession`
  /// + `verifyControllerRef` in the handlers below. We separate the
  /// AbortController from the snapshot so re-renders don't churn the
  /// controller identity.
  const [verifySession, setVerifySession] = useState<VerifySessionView | null>(
    null,
  );
  const verifyControllerRef = useRef<AbortController | null>(null);

  /// `cmd+K → "Apply fixes from prompt"` dialog open state. Null when
  /// closed; otherwise the id of the course to pre-select in the
  /// dropdown. App.tsx owns it so the dialog survives re-renders of
  /// any inner view.
  const [fixApplierForCourseId, setFixApplierForCourseId] = useState<
    string | null
  >(null);

  /// Pre-picked PDF/EPUB path that the unified Add Course flow
  /// passes into ImportDialog so the user doesn't have to re-pick
  /// a file they just selected from the smart picker. Cleared on
  /// dialog dismiss.
  const [preselectedImportPath, setPreselectedImportPath] = useState<
    string | null
  >(null);
  const [importOpen, setImportOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [docsImportOpen, setDocsImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Sign-in modal state, opened by the "Sign in" button in the TopBar
  // stats dropdown. Kept separate from `FirstLaunchPrompt` (which has
  // its own one-time-show gate) so signed-out users can re-open it
  // from the dropdown whenever they want.
  const [signInOpen, setSignInOpen] = useState(false);
  // Pending delete request queued by the library / sidebar context menu.
  // Kept in state rather than firing window.confirm() directly so we can
  // render an app-styled modal with Escape + backdrop-click dismissal.
  const [pendingDelete, setPendingDelete] = useState<{
    courseId: string;
    courseTitle: string;
  } | null>(null);

  /// Completion state lives in SQLite; the hook loads on mount and writes
  /// through on markCompleted. Keys are `${courseId}:${lessonId}`.
  const {
    completed,
    history,
    markCompleted,
    clearLessonCompletion,
    clearChapterCompletions,
    clearCourseCompletions,
  } = useProgress();

  /// Optional Fishbones cloud account — bound at the app level so the
  /// first-launch prompt, the Settings → Account section, and the
  /// markCompleted-side-effect sync all share the same hook instance.
  const cloud = useFishbonesCloud();

  /// Listen for the browser-OAuth callback. The relay redirects to
  /// `fishbones://oauth/done?session=...&status=ok&token=fb_...` (or
  /// `status=error&error=...&message=...`); the deep-link plugin
  /// surfaces those URLs to us as a stream of strings. We parse the
  /// query params, hand the token to the cloud hook, and let it run
  /// the existing /me-on-mount fetch to materialise the user.
  ///
  /// `getCurrent` covers the cold-start case where the app was
  /// launched by the OS in response to the deep-link itself (the
  /// browser will have just dispatched it, the app boots, and the
  /// URL is waiting for us). `onOpenUrl` handles the warm case:
  /// the app was already running and the OS forwarded the URL.
  ///
  /// We pin the latest `cloud` instance into a ref so the listener
  /// closure can call the up-to-date `applyOAuthToken` without
  /// becoming a render-dep. If we listed `[cloud]` (or even
  /// `[cloud.applyOAuthToken]`) here, the effect would re-run every
  /// time the cloud state changed — re-subscribing the listener AND
  /// re-calling `getCurrentDeepLinks()`. On macOS the latter
  /// sometimes re-delivers the OAuth URL each call, which fires
  /// applyOAuthToken repeatedly — `user` flips to null between each
  /// `/me` resolve, causing the visible auth-state flashing the
  /// learner sees in the TopBar / Settings.
  const cloudRef = useRef(cloud);
  cloudRef.current = cloud;
  useEffect(() => {
    let cancelled = false;
    const handleUrls = (urls: string[]) => {
      for (const raw of urls) {
        try {
          const url = new URL(raw);
          // Defensive guard — the listener fires for any registered
          // scheme, and we only know how to handle our own.
          //
          // `fishbones-dev:` is the dev-build twin: macOS Launch
          // Services routes a custom scheme to whichever `.app` bundle
          // last registered it, and the installed prod app re-claims
          // `fishbones://` on every launch. The dev binary uses the
          // `-dev` variant so its OAuth callbacks don't get hijacked
          // by the prod install. start_oauth (src-tauri/src/lib.rs)
          // picks the matching `return_to` based on
          // `cfg!(debug_assertions)`.
          if (url.protocol !== "fishbones:" && url.protocol !== "fishbones-dev:") continue;

          // Route on the URL host (the segment after `fishbones://`):
          //   fishbones://oauth/done?status=ok&token=…   → cloud sign-in
          //   fishbones://open?courseId=…&lessonId=…     → land on lesson
          //
          // Unknown hosts are logged + ignored so a future scheme
          // addition doesn't crash older clients that haven't been
          // updated.
          const host = url.host || url.pathname.replace(/^\/+/, "").split("/")[0];

          if (host === "oauth") {
            const status = url.searchParams.get("status");
            const token = url.searchParams.get("token");
            if (status === "ok" && token) {
              console.log("[fishbones] oauth callback: success");
              void cloudRef.current.applyOAuthToken(token);
            } else if (status === "error") {
              console.error(
                `[fishbones] oauth callback: error ${url.searchParams.get("error")} — ${url.searchParams.get("message")}`,
              );
            } else {
              console.warn(
                `[fishbones] oauth callback: unrecognised payload ${raw}`,
              );
            }
          } else if (host === "open") {
            // "Open in Fishbones" handoff from fishbones.academy. The
            // courseId is required; lessonId is optional (we fall
            // through to the course's first lesson if it's missing or
            // doesn't match anything in the course). We only stash a
            // pendingOpen request — the auto-open + warm-path effects
            // below pick it up and route accordingly.
            const courseId = url.searchParams.get("courseId");
            if (courseId) {
              const lessonId = url.searchParams.get("lessonId") ?? undefined;
              setPendingOpen({ courseId, lessonId });
            } else {
              console.warn(
                `[fishbones] open deep-link missing courseId: ${raw}`,
              );
            }
          } else {
            console.warn(`[fishbones] unrecognised deep link host=${host}: ${raw}`);
          }
        } catch (e) {
          console.error("[fishbones] deep-link: parse failed", e);
        }
      }
    };
    // Cold-start: the app may have been launched by clicking the
    // callback URL in the browser. Drain whatever URL fired the boot.
    void getCurrentDeepLinks()
      .then((urls) => {
        if (!cancelled && urls && urls.length > 0) handleUrls(urls);
      })
      .catch((e) => {
        // getCurrent returns a rejection on web preview / unsupported
        // hosts. Not fatal; the warm-path listener still works in
        // the desktop bundle.
        console.debug("[fishbones] deep-link getCurrent unavailable:", e);
      });
    // Warm-path listener. Returns an unlisten fn we call on unmount.
    const unlistenPromise = onOpenUrl(handleUrls).catch((e) => {
      console.debug("[fishbones] deep-link onOpenUrl unavailable:", e);
      return undefined;
    });
    return () => {
      cancelled = true;
      void unlistenPromise.then((fn) => {
        if (typeof fn === "function") fn();
      });
    };
    // Empty deps — run once on mount, unsubscribe on unmount. The
    // closure sees the latest cloud instance via cloudRef.current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /// One-time pull on first sign-in: when a freshly signed-in account
  /// has progress on the relay, merge it into local SQLite so the
  /// learner doesn't lose their existing streak. Tracked via
  /// localStorage so we don't re-pull on every app launch.
  useEffect(() => {
    // `cloud.user` is the discriminated union: `null` (booting),
    // `false` (definitely-not-signed-in), or the user object. Narrow
    // to the object case before reading `.id`.
    if (!cloud.signedIn || cloud.user === null || cloud.user === false) return;
    const pulledKey = `fishbones:cloud:pulled-${cloud.user.id}`;
    if (localStorage.getItem(pulledKey)) return;
    let cancelled = false;
    void cloud.pullProgress().then((rows) => {
      if (cancelled) return;
      for (const r of rows) {
        // Re-apply each row through the local hook so SQLite + the
        // in-memory `completed` Set both stay in sync.
        markCompleted(r.course_id, r.lesson_id);
      }
      try {
        localStorage.setItem(pulledKey, new Date().toISOString());
      } catch {
        /* private mode */
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `cloud` itself is a memoised reference now (see useFishbonesCloud),
    // so listing it here is fine — but we explicitly call out the
    // narrowed slices we read, so refactors that change the hook
    // shape don't accidentally drop a dep.
  }, [cloud, markCompleted]);

  /// Best-effort push of the local history every 30s while signed
  /// in. We use the existing `history` array (already in memory) so
  /// the relay catches up even if the user finished lessons offline
  /// and came back online later. Failures are swallowed — sync is
  /// optional and shouldn't pop user-visible errors during normal use.
  useEffect(() => {
    if (!cloud.signedIn) return;
    let cancelled = false;
    const flush = () => {
      if (cancelled || history.length === 0) return;
      void cloud.pushProgress(
        history.map((h) => ({
          course_id: h.course_id,
          lesson_id: h.lesson_id,
          // history uses unix-epoch seconds; relay stores ISO 8601
          // strings so the server-side merge can rely on lexicographic
          // ordering working correctly for "newer wins".
          completed_at: new Date(h.completed_at * 1000).toISOString(),
        })),
      ).catch(() => undefined);
    };
    flush();
    const id = window.setInterval(flush, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [cloud.signedIn, cloud, history]);

  /// Timestamp of the last fresh completion (transition from incomplete →
  /// complete). Drives the AI tutor's happy-celebration loop. Plain
  /// markCompleted is idempotent — re-passing a lesson the user has
  /// already finished doesn't re-fire it — so we filter on the
  /// `completed` set up here. The AiAssistant resets to idle on its
  /// own a few seconds later.
  const [celebrateAt, setCelebrateAt] = useState(0);
  function markCompletedAndCelebrate(courseId: string, lessonId: string) {
    const key = `${courseId}:${lessonId}`;
    if (!completed.has(key)) setCelebrateAt(Date.now());
    markCompleted(courseId, lessonId);
    // Tell the watch-mode verifier (cmd+K → Verify course) that this
    // lesson is now done. Fires for ALL completion paths — exercise
    // pass, reading + Next, quiz all-correct — so the verifier loop
    // can advance without caring which kind it just finished.
    emitVerifierEvent({ type: "lessonComplete", courseId, lessonId });
  }
  // Stats use the UNFILTERED list so XP / streak / longest-streak stay
  // correct even when the learner racked up completions via drill kinds
  // we hide from the desktop nav. See `filterCourseForDesktop` doc in
  // data/types.ts.
  const stats = useStreakAndXp(history, coursesAll);

  /// Per-course "last opened" timestamps for the sidebar carousel. Stored
  /// in localStorage so recent-first ordering survives an app restart.
  /// Updated inside selectLesson so any path that navigates to a course
  /// (tab click, sidebar lesson click, carousel click, library open) feeds
  /// the signal uniformly.
  const { recents: recentCourses, touch: touchRecentCourse } = useRecentCourses();

  /// Ingest run lifted to app level so it survives ImportDialog dismissal.
  /// Every per-lesson save triggers onCourseSaved, which re-fetches the
  /// courses list — the sidebar fills in with new lessons as the pipeline
  /// generates them. Debounced via useCourses' own internal handling.
  const {
    run: ingest,
    start: startIngest,
    startBulk: startBulkIngest,
    startRegenExercises,
    startGenerateChallengePack,
    startDocsIngest,
    startEnrichCourse,
    startRetryLesson,
    cancel: cancelIngest,
    dismiss: dismissIngest,
  } = useIngestRun({ onCourseSaved: () => { refreshCourses(); } });

  /// Course-id of the course whose settings modal is open. `null` when
  /// no settings modal is showing. Opened from the sidebar's right-click
  /// "Course settings…" action.
  const [courseSettingsId, setCourseSettingsId] = useState<string | null>(null);

  /// Which main-pane route is showing. "courses" is the default (welcome /
  /// inline library / lesson view depending on tab state). "profile" and
  /// "playground" are dedicated destinations triggered from the sidebar
  /// iconbar. Selecting a lesson anywhere forces back to "courses" so the
  /// learner isn't stuck on a side view after clicking a sidebar item.
  const [view, setView] = useState<
    "courses" | "profile" | "playground" | "library" | "docs"
  >(
    "courses",
  );

  /// Active docs page id. Lifted to App-level so the main Sidebar can
  /// render the docs section/page nav AND DocsView can render the
  /// matching body — both as controlled views over a single source of
  /// truth. Without this lift we'd be back to two sidebars trying to
  /// stay in sync. Default to the first page of the first section so
  /// opening the docs route doesn't drop us on a blank pane.
  const [docsActiveId, setDocsActiveId] = useState<string>(
    () => FISHBONES_DOCS[0]?.pages[0]?.id ?? "welcome",
  );

  /// Challenge-pack generation dialog visibility. Opened from the Profile
  /// page's "Generate challenge pack" CTA; runs through useIngestRun when
  /// submitted and closes itself.
  const [genPackOpen, setGenPackOpen] = useState(false);

  /// Sidebar collapsed state. Persisted so a learner who prefers the
  /// full-width pane (e.g. writing a long exercise) doesn't have to
  /// re-hide the sidebar every launch. Toggled by the top-bar button or
  /// Cmd+\\ (matches VS Code's muscle memory).
  ///
  /// Storage key migrated from `kata:sidebarCollapsed` to
  /// `fishbones:sidebarCollapsed` in v0.1.4. Read prefers the new key
  /// and falls back to the legacy one so existing installs keep their
  /// preference; the next write lands under the new key.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      const v =
        localStorage.getItem("fishbones:sidebarCollapsed") ??
        localStorage.getItem("kata:sidebarCollapsed");
      return v === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "fishbones:sidebarCollapsed",
        sidebarCollapsed ? "1" : "0",
      );
      // Clear the legacy key once we've persisted to the new one so
      // the migration is a one-shot and `localStorage.length` doesn't
      // accumulate dead entries forever.
      localStorage.removeItem("kata:sidebarCollapsed");
    } catch {
      /* private mode — fine to drop */
    }
  }, [sidebarCollapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd+\ on macOS, Ctrl+\ elsewhere — matches VS Code.
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setSidebarCollapsed((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Hand off from index.html's inline preloader to our React loader.
  // Runs in a layout-effect (post-DOM-mutate, pre-paint) so the inline
  // preloader fades exactly when `.fishbones__bootloader` is on screen
  // — no black gap on cold-start. Safe to run once; the safety
  // timeout in main.tsx is a no-op if we got here first.
  useLayoutEffect(() => {
    document.body.classList.add("is-booted");
  }, []);

  /// Cmd+K (Ctrl+K) — global command palette toggle. Lives at the
  /// app root so it works from every route + every focus state.
  /// Browsers default Cmd+K to "address bar focus" inside <input>;
  /// preventDefault flips that for our keystroke specifically. The
  /// palette's own Esc / repeated Cmd+K handlers manage close.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Pending-open: a request to land on a specific course+lesson at boot,
  // sourced from either:
  //   - the web build's URL params (`?courseId=…&lessonId=…`) — set when
  //     fishbones.academy hands the learner over via "Start in browser"
  //     or "Open in Fishbones".
  //   - a desktop `fishbones://open?courseId=…&lessonId=…` deep link,
  //     handled by the listener above (which calls setPendingOpen).
  //
  // The state survives the initial render so the auto-open effect below
  // can pick the right course as soon as `coursesLoaded` flips true. On
  // a successful match we clear pendingOpen so a later URL-bar manual
  // edit (or a stale ?courseId in browser history) doesn't yank the
  // learner away from a tab they actively opened.
  const [pendingOpen, setPendingOpen] = useState<{
    courseId: string;
    lessonId?: string;
  } | null>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const courseId = params.get("courseId");
      if (!courseId) return null;
      const lessonId = params.get("lessonId") ?? undefined;
      return { courseId, lessonId };
    } catch {
      return null;
    }
  });

  // On fresh launch (courses loaded, no tabs yet), open a starting lesson
  // as a convenience. Picks the pendingOpen target when one's set + the
  // course exists; otherwise falls back to courses[0]. Skipped on re-mount
  // once the learner has actively opened/closed tabs — closing the last
  // tab should NOT auto-re-open it, the learner wanted the library view.
  // The ref is flipped after the first auto-open OR after any manual
  // selectLesson call so repeated close-all cycles don't keep re-opening.
  const didAutoOpen = useRef(false);
  useEffect(() => {
    if (didAutoOpen.current) return;
    if (!coursesLoaded || courses.length === 0 || openTabs.length !== 0) return;

    let target = pendingOpen
      ? courses.find((c) => c.id === pendingOpen.courseId)
      : undefined;
    if (!target) target = courses[0];

    // Resolve the lesson id: prefer the pendingOpen lessonId if it
    // actually exists in the resolved course, otherwise fall through
    // to the course's first lesson. Guards against stale links to
    // lessons that were renamed or removed.
    const lessonExists =
      pendingOpen?.lessonId &&
      target.id === pendingOpen.courseId &&
      target.chapters.some((ch) =>
        ch.lessons.some((l) => l.id === pendingOpen.lessonId),
      );
    const lessonId = lessonExists
      ? pendingOpen!.lessonId!
      : target.chapters[0]?.lessons[0]?.id;
    if (!lessonId) return;

    didAutoOpen.current = true;
    setOpenTabs([{ courseId: target.id, lessonId }]);
    setPendingOpen(null);

    // Strip ?courseId=… off the URL so a refresh doesn't re-yank
    // them back to this course after they've moved on. Only does the
    // strip when we matched something — leaves a pendingOpen that
    // failed to resolve in the URL so a power user can see what was
    // requested.
    if (pendingOpen) {
      try {
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.hash,
        );
      } catch {
        /* history.replaceState isn't available — fine, no-op */
      }
    }
  }, [coursesLoaded, courses, openTabs.length, pendingOpen]);

  // Warm-path: if a deep link arrives after the app's already booted
  // and the learner has tabs open, honour it via selectLesson rather
  // than appending it to the auto-open queue.
  useEffect(() => {
    if (!pendingOpen) return;
    if (!didAutoOpen.current) return; // cold-start path handles it
    if (!coursesLoaded || courses.length === 0) return;
    const course = courses.find((c) => c.id === pendingOpen.courseId);
    if (!course) {
      setPendingOpen(null);
      return;
    }
    const exists =
      pendingOpen.lessonId &&
      course.chapters.some((ch) =>
        ch.lessons.some((l) => l.id === pendingOpen.lessonId),
      );
    const lessonId = exists
      ? pendingOpen.lessonId!
      : course.chapters[0]?.lessons[0]?.id;
    if (!lessonId) return;
    selectLesson(course.id, lessonId);
    setPendingOpen(null);
    // selectLesson is stable enough that listing it as a dep would
    // cause the effect to run on every keystroke (it's recreated each
    // render). pendingOpen + coursesLoaded are the actual triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpen, coursesLoaded, courses]);

  const activeTab = openTabs[activeTabIndex];
  const activeCourse = courses.find((c) => c.id === activeTab?.courseId) ?? null;
  const activeLesson = findLesson(activeCourse, activeTab?.lessonId);

  function selectLesson(courseId: string, lessonId: string) {
    // Once the learner has explicitly opened something, the auto-open-
    // first-lesson effect stands down — they're driving.
    didAutoOpen.current = true;
    // Mark this course as "just opened" — the sidebar carousel sorts
    // by these timestamps to keep the most-active course leftmost.
    touchRecentCourse(courseId);
    // Pull in the full course body (starter / solution / tests) if we
    // only have the summary from the initial fast load. No-op if it's
    // already hydrated, so this is safe to fire on every selection.
    // Not awaited — the tab opens immediately and the LessonView
    // re-renders when the full body arrives. This makes "slow click"
    // feel instant while still ensuring the body is available by the
    // time the learner clicks Run.
    void hydrateCourse(courseId);
    // Selecting a lesson always routes back to courses view — otherwise
    // we'd switch the sidebar's active tab silently while the main pane
    // still shows Profile / Playground. That's disorienting.
    setView("courses");
    const existing = openTabs.findIndex((t) => t.courseId === courseId);
    if (existing >= 0) {
      const updated = [...openTabs];
      updated[existing] = { courseId, lessonId };
      setOpenTabs(updated);
      setActiveTabIndex(existing);
    } else {
      setOpenTabs([...openTabs, { courseId, lessonId }]);
      setActiveTabIndex(openTabs.length);
    }
  }

  /// Ask for a destination then shell out to the Rust `export_course` command,
  /// which zips the course folder (course.json + any sibling assets) into a
  /// `.fishbones` archive. We derive a default filename from the course title
  /// so the save sheet starts on a useful name.
  async function exportCourse(courseId: string, courseTitle: string) {
    try {
      const defaultName = slugify(courseTitle) + ".fishbones";
      const destination = await save({
        defaultPath: defaultName,
        filters: [{ name: "Fishbones course", extensions: ["fishbones", "kata"] }],
        title: `Export "${courseTitle}"`,
      });
      if (!destination) return; // user cancelled
      await invoke("export_course", { courseId, destination });
    } catch (e) {
      // Keep this simple — surface via alert for now. A toast would be nicer
      // but there's no toast system yet; the happy path just succeeds silently.
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Export failed: ${msg}`);
    }
  }

  /// Export every course in the library into a single directory as
  /// `.fishbones` archives. One prompt, no per-course save sheets.
  /// Failures don't halt the batch — they're collected and surfaced at
  /// the end so a flaky file doesn't strand the rest.
  async function bulkExportLibrary() {
    try {
      if (courses.length === 0) {
        alert("Library is empty — nothing to export.");
        return;
      }
      const destDir = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose destination folder for library export",
      });
      if (typeof destDir !== "string") return;
      const failures: Array<{ title: string; error: string }> = [];
      for (const c of courses) {
        const filename = slugify(c.title) + ".fishbones";
        const destination = `${destDir}/${filename}`;
        try {
          await invoke("export_course", { courseId: c.id, destination });
        } catch (e) {
          failures.push({
            title: c.title,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      const exported = courses.length - failures.length;
      if (failures.length === 0) {
        alert(`Exported ${exported} course${exported === 1 ? "" : "s"} to ${destDir}`);
      } else {
        const msg = failures.map((f) => `• ${f.title}: ${f.error}`).join("\n");
        alert(
          `Exported ${exported} of ${courses.length}. ${failures.length} failed:\n\n${msg}`,
        );
      }
    } catch (e) {
      alert(
        `Bulk export failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /// Open a course from the Library view. Reuses the `selectLesson` path
  /// (which upserts an open tab) and targets the first lesson if the
  /// course isn't already open.
  function openCourseFromLibrary(courseId: string) {
    const c = courses.find((x) => x.id === courseId);
    if (!c) return;
    const existing = openTabs.find((t) => t.courseId === courseId);
    const lessonId = existing?.lessonId ?? c.chapters[0]?.lessons[0]?.id;
    if (!lessonId) return;
    selectLesson(courseId, lessonId);
  }

  /// Queue a delete for confirmation. The actual deletion runs in
  /// `performDelete` once the user clicks Delete in the ConfirmDialog.
  function deleteCourseFromLibrary(courseId: string, courseTitle: string) {
    setPendingDelete({ courseId, courseTitle });
  }

  /// Actually wipe the course: remove the course dir, drop open tabs, clear
  /// the book's ingest cache so a re-import starts fresh. Errors on cache
  /// clear are swallowed because cache may already be gone; the course
  /// delete is the important part.
  async function performDelete(courseId: string) {
    try {
      await invoke("delete_course", { courseId });
      await invoke("cache_clear", { bookId: courseId }).catch((e) => {
        console.warn("[fishbones] cache_clear after delete failed:", e);
      });
      setOpenTabs((prev) => prev.filter((t) => t.courseId !== courseId));
      await refreshCourses();
    } catch (e) {
      console.error("[fishbones] delete_course failed:", e);
    } finally {
      setPendingDelete(null);
    }
  }

  /// Import a previously-exported `.fishbones` (or legacy `.kata`) archive.
  /// Shared importer used by BOTH the file-picker path and the
  /// drag-drop path. Hands `archivePath` (an absolute fs path on
  /// disk) to the Rust `import_course` command which unzips into
  /// the courses dir, then refreshes the sidebar and opens the
  /// first lesson if `andOpen` is true.
  ///
  /// `andOpen` defaults to true. Drag-drop sets it to true only on
  /// the LAST item of a batch — earlier items just import quietly
  /// so the user doesn't see tabs flap open and closed during a
  /// multi-drop.
  async function importArchiveAtPath(
    archivePath: string,
    andOpen: boolean = true,
  ): Promise<string | null> {
    const courseId = await invoke<string>("import_course", { archivePath });
    const fresh = await refreshCourses();
    if (!andOpen) return courseId;
    const imported = fresh.find((c) => c.id === courseId);
    if (!imported || imported.chapters.length === 0) return courseId;
    const firstLessonId = imported.chapters[0].lessons[0]?.id;
    if (!firstLessonId) return courseId;
    setOpenTabs((prev) => {
      const without = prev.filter((t) => t.courseId !== courseId);
      const next = [...without, { courseId, lessonId: firstLessonId }];
      setActiveTabIndex(next.length - 1);
      return next;
    });
    setView("courses");
    return courseId;
  }

  /// Opens the native file picker filtered to both extensions, then
  /// imports the chosen path. Wraps `importArchiveAtPath` with the
  /// picker + error reporting.
  async function importCourseArchive() {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "Fishbones course", extensions: ["fishbones", "kata"] }],
      });
      if (typeof picked !== "string") return; // user cancelled
      await importArchiveAtPath(picked);
    } catch (e) {
      console.error("[fishbones] import_course failed:", e);
      alert(
        `Couldn't import course archive: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Track in-flight drag-drop batch so we only "open" the LAST
  // imported course (avoids tab thrash when 5+ files are dropped).
  // Captured by ref because the hook's onImport callback is stable
  // over the component lifetime — we don't want to re-subscribe the
  // Tauri listener every time these change.
  const dropBatchRef = useRef<{ remaining: number }>({ remaining: 0 });
  const archiveDrop = useArchiveDrop({
    onImport: async (archivePath: string) => {
      const remaining = dropBatchRef.current.remaining;
      const isLastInBatch = remaining <= 1;
      try {
        await importArchiveAtPath(archivePath, isLastInBatch);
      } catch (e) {
        console.error("[fishbones] dropped import failed:", e);
        // Don't alert mid-batch — too noisy if a user dropped 10
        // files and 2 had bad zips. The console error is enough; the
        // overlay already conveys progress.
      } finally {
        dropBatchRef.current.remaining = Math.max(0, remaining - 1);
      }
    },
  });
  // Keep `dropBatchRef.remaining` synced to the progress total. The
  // hook bumps `progress.total` once per batch (single setState at
  // queue start), so this effect runs once per batch + once on
  // teardown — cheap.
  useEffect(() => {
    if (archiveDrop.progress) {
      dropBatchRef.current.remaining =
        archiveDrop.progress.total - archiveDrop.progress.current + 1;
    } else {
      dropBatchRef.current.remaining = 0;
    }
  }, [archiveDrop.progress]);

  function closeTab(index: number) {
    const next = openTabs.filter((_, i) => i !== index);
    setOpenTabs(next);
    if (activeTabIndex >= next.length) {
      setActiveTabIndex(Math.max(0, next.length - 1));
    } else if (activeTabIndex > index) {
      setActiveTabIndex(activeTabIndex - 1);
    }
  }

  const tabs = openTabs.map((t) => {
    const c = courses.find((x) => x.id === t.courseId);
    return {
      id: t.courseId,
      label: c?.title ?? t.courseId,
      language: c?.language ?? "javascript",
    };
  });

  return (
    <div
      className={`fishbones ${
        sidebarCollapsed ? "fishbones--sidebar-collapsed" : ""
      }`}
    >
      {/* Always-on top-left corner bloom — the same animated dotted
          gradient used by the bootloader, but anchored top-left of the
          viewport via `variant="corner"` and pointer-events disabled.
          Fixed-position so it stays put across view changes. Lives
          above the root .fishbones bg but below the topbar / sidebar /
          panels (z-index 0); chrome with solid backgrounds covers it
          where they overlap, but it peeks through any transparent
          surface (e.g. the bootloader during fade-out, an empty
          welcome view). */}
      <DottedGradientBg variant="corner" />

      {/* First-load overlay. Shown until `useCourses` resolves its
          initial list so the learner sees a branded loader instead of
          an empty sidebar + blank welcome flash. Same fish-bone spinner
          the OutputPane uses — keeps the loading vocabulary consistent
          across the app. Fades itself out via CSS once coursesLoaded
          flips true. */}
      <div
        className={`fishbones__bootloader ${
          coursesLoaded ? "fishbones__bootloader--hidden" : ""
        }`}
        aria-hidden={coursesLoaded}
      >
        {/* Ambient halftone-dot gradient sits behind the spinner so
            the cold-start screen doesn't read as a flat black rectangle.
            Drifts on a 22s loop; honors prefers-reduced-motion. */}
        <DottedGradientBg />
        <FishbonesLoader label="loading Fishbones…" />
      </div>

      {/* Drag-and-drop import overlay. Listens at the app level via
          `useArchiveDrop` so .fishbones / .kata files can be dropped
          anywhere on the window — the OS-level Tauri webview drop
          handler fires regardless of where in the React tree the
          cursor is. The overlay is purely visual feedback. */}
      <ArchiveDropOverlay
        isDragging={archiveDrop.isDragging}
        isImporting={archiveDrop.isImporting}
        progress={archiveDrop.progress}
      />

      <TopBar
        tabs={tabs}
        activeIndex={activeTabIndex}
        onActivate={(i) => {
          // Tabs live in the top bar across every route, so clicking one
          // should always land on the course view — otherwise the learner
          // sees the tab highlight change while still looking at Profile
          // or Playground, which feels broken.
          setView("courses");
          setActiveTabIndex(i);
        }}
        onClose={closeTab}
        stats={stats}
        history={history}
        onOpenProfile={() => setView("profile")}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        // Cloud-sync account row in the stats dropdown. The chip stays
        // hidden while the cloud hook is still booting (`user === null`,
        // briefly during the `me` refetch); once it lands we pass a
        // concrete `signedIn` boolean so the row picks the right shape.
        //
        // Both desktop and web ship the auth chip now. The web variant
        // routes OAuth through a popup window that postMessages the
        // token back via /oauth/done (see SignInDialog `startOAuth`)
        // instead of the desktop's `fishbones://` deep-link callback.
        // While `cloud.user === null` (booting) we still render
        // `undefined` so the TopBar stays in its skeleton state and
        // doesn't flash a "Sign in" CTA before we know the persisted
        // token's actual status.
        signedIn={cloud.user === null ? undefined : cloud.signedIn}
        userDisplayName={
          cloud.signedIn && typeof cloud.user === "object" && cloud.user
            ? cloud.user.display_name
            : null
        }
        userEmail={
          cloud.signedIn && typeof cloud.user === "object" && cloud.user
            ? cloud.user.email
            : null
        }
        onSignIn={() => setSignInOpen(true)}
        onSignOut={() => {
          void cloud.signOut();
        }}
        // Search trigger sits left of the stats chip; clicking it pops
        // the same CommandPalette that Cmd/Ctrl+K already binds.
        onOpenSearch={() => setPaletteOpen(true)}
        // Feed the inline search input's pool. The TopBarSearch widget
        // filters across all courses + their lessons; clicking a row
        // routes through the same selectLesson path the sidebar uses.
        courses={courses}
        onOpenLesson={selectLesson}
      />

      <div className="fishbones__body">
        <Sidebar
          courses={courses}
          activeCourseId={view === "courses" ? activeCourse?.id : undefined}
          activeLessonId={view === "courses" ? activeLesson?.id : undefined}
          completed={completed}
          recents={recentCourses}
          onSelectLesson={selectLesson}
          onSelectCourse={openCourseFromLibrary}
          onLibrary={() => setView("library")}
          onSettings={() => setSettingsOpen(true)}
          onPlayground={() => setView("playground")}
          onDocs={() => setView("docs")}
          // Docs nav is rendered IN this Sidebar (replaces the
          // course tree) when view === "docs", so we pass the same
          // active-id state DocsView reads. Outside docs view we
          // pass undefined so the sidebar reverts to course mode.
          docsActiveId={view === "docs" ? docsActiveId : undefined}
          onDocsSelect={setDocsActiveId}
          activeView={view}
          onExportCourse={exportCourse}
          onDeleteCourse={deleteCourseFromLibrary}
          onCourseSettings={(id) => setCourseSettingsId(id)}
          onResetLesson={clearLessonCompletion}
          onResetChapter={clearChapterCompletions}
          onResetCourse={clearCourseCompletions}
        />

        <main className="fishbones__main">
          {view === "profile" ? (
            <ProfileView
              courses={courses}
              completed={completed}
              history={history}
              stats={stats}
              onOpenLesson={selectLesson}
            />
          ) : view === "playground" ? (
            <PlaygroundView />
          ) : view === "docs" ? (
            <DocsView
              activeId={docsActiveId}
              onActiveIdChange={setDocsActiveId}
            />
          ) : view === "library" ? (
            // Library view — renders the inline CourseLibrary as the main
            // pane content (not as a modal overlay). DeferredMount paints
            // a "Loading library…" card for one animation frame so the
            // sidebar click feels instant even when the cover-loading
            // IPCs stack up under StrictMode's dev-mode double-render.
            <DeferredMount
              phase="library"
              fallback={<LoadingPane label="Loading library…" />}
            >
              <CourseLibrary
                mode="inline"
                courses={courses}
                completed={completed}
                hydrating={hydrating}
                onDismiss={() => setView("courses")}
                onOpen={(id) => openCourseFromLibrary(id)}
                // Import / bulk-import / docs-crawl / archive-import
                // all live behind Tauri commands (PDF parsing, file
                // dialog, crawler, etc.). On the web build we pass
                // `undefined` so CourseLibrary's optional-prop checks
                // hide the corresponding buttons rather than calling
                // an Anthropic-backed pipeline that can't run here.
                onImport={isWeb ? undefined : () => setImportOpen(true)}
                onBulkImport={isWeb ? undefined : () => setBulkImportOpen(true)}
                onDocsImport={isWeb ? undefined : () => setDocsImportOpen(true)}
                onImportArchive={isWeb ? undefined : importCourseArchive}
                onExport={isWeb ? undefined : exportCourse}
                onDelete={deleteCourseFromLibrary}
                onSettings={(id) => setCourseSettingsId(id)}
                onBulkExport={isWeb ? undefined : bulkExportLibrary}
                onUpdateCourse={handleReapplyBundledStarter}
                onAddCourse={isWeb ? undefined : handleAddCourse}
              />
            </DeferredMount>
          ) : courses.length === 0 && coursesLoaded ? (
            <div className="fishbones__welcome">
              <div className="fishbones__welcome-inner">
                <div className="fishbones__welcome-glyph" aria-hidden>
                  <Icon icon={libraryBig} size="2xl" color="currentColor" weight="light" />
                </div>
                <h1 className="fishbones__welcome-title">Welcome to Fishbones</h1>
                <p className="fishbones__welcome-blurb">
                  {isWeb
                    ? "A browser-native preview. Try the bundled lessons in JavaScript, Python, or Svelte — your progress saves locally and syncs to the cloud once you sign in."
                    : "Turn any technical book into an interactive course. Pick a PDF to import, and Fishbones will split it into lessons, generate exercises, and let you code along chapter by chapter."}
                </p>
                <div className="fishbones__welcome-actions">
                  {isWeb ? (
                    <a
                      className="fishbones__welcome-primary"
                      href="https://github.com/InfamousVague/Kata/releases/latest"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Get the desktop app
                    </a>
                  ) : (
                    <button
                      className="fishbones__welcome-primary"
                      onClick={() => setImportOpen(true)}
                    >
                      Import a PDF
                    </button>
                  )}
                  <button
                    className="fishbones__welcome-secondary"
                    onClick={() => setSettingsOpen(true)}
                  >
                    Open Settings
                  </button>
                </div>
                <p className="fishbones__welcome-hint">
                  {isWeb
                    ? "Want to import your own PDFs, run C / C++ / Java / Swift, or use the offline AI? Grab the desktop app — it ships every runtime."
                    : "You'll need an Anthropic API key in Settings for the AI-assisted structuring pipeline. Without one, imports fall back to simple section splits."}
                </p>
              </div>
            </div>
          ) : openTabs.length === 0 ? (
            // No tabs open (all closed, or freshly launched before first
            // tab was created) — render the library inline so the learner
            // has a launching pad instead of a blank pane.
            <DeferredMount
              phase="library-empty"
              fallback={<LoadingPane label="Loading library…" />}
            >
              <CourseLibrary
                mode="inline"
                courses={courses}
                completed={completed}
                hydrating={hydrating}
                onDismiss={() => { /* inline mode has no dismiss affordance */ }}
                onOpen={(id) => openCourseFromLibrary(id)}
                onImport={isWeb ? undefined : () => setImportOpen(true)}
                onBulkImport={isWeb ? undefined : () => setBulkImportOpen(true)}
                onDocsImport={isWeb ? undefined : () => setDocsImportOpen(true)}
                onImportArchive={isWeb ? undefined : importCourseArchive}
                onExport={isWeb ? undefined : exportCourse}
                onDelete={deleteCourseFromLibrary}
                onSettings={(id) => setCourseSettingsId(id)}
                onBulkExport={isWeb ? undefined : bulkExportLibrary}
                onUpdateCourse={handleReapplyBundledStarter}
                onAddCourse={isWeb ? undefined : handleAddCourse}
              />
            </DeferredMount>
          ) : activeLesson && activeCourse ? (
            <LessonView
              // Key on course+lesson so the editor/code state and quiz answers
              // fully reset when navigating via Prev/Next — otherwise React
              // would reuse stale component state across lessons.
              key={`${activeCourse.id}:${activeLesson.id}`}
              courseId={activeCourse.id}
              courseLanguage={activeCourse.language}
              lesson={activeLesson}
              neighbors={findNeighbors(activeCourse, activeLesson.id)}
              isCompleted={completed.has(`${activeCourse.id}:${activeLesson.id}`)}
              onComplete={() => markCompletedAndCelebrate(activeCourse.id, activeLesson.id)}
              onNavigate={(lessonId) => selectLesson(activeCourse.id, lessonId)}
              onRetryLesson={(lessonId) =>
                startRetryLesson(
                  activeCourse.id,
                  lessonId,
                  activeLesson.title.replace(/\s*\(demoted\)\s*$/i, "").trim(),
                )
              }
            />
          ) : (
            <div className="fishbones__empty">
              <p>Pick a lesson from the sidebar to get started.</p>
            </div>
          )}
        </main>
      </div>

      {settingsOpen && (
        <SettingsDialog
          cloud={cloud}
          onDismiss={() => setSettingsOpen(false)}
          onRequestSignIn={() => setSignInOpen(true)}
        />
      )}


      {genPackOpen && (
        <GeneratePackDialog
          onDismiss={() => setGenPackOpen(false)}
          onStart={(opts) => {
            startGenerateChallengePack(opts);
            setGenPackOpen(false);
          }}
        />
      )}

      {docsImportOpen && (
        <DocsImportDialog
          onDismiss={() => setDocsImportOpen(false)}
          onStart={(opts) => {
            startDocsIngest(opts);
            setDocsImportOpen(false);
          }}
        />
      )}

      {courseSettingsId && (() => {
        const course = courses.find((c) => c.id === courseSettingsId);
        if (!course) return null;
        return (
          <CourseSettingsModal
            course={course}
            onDismiss={() => setCourseSettingsId(null)}
            onExport={() => exportCourse(course.id, course.title)}
            onDelete={() => deleteCourseFromLibrary(course.id, course.title)}
            onRegenerateExercises={() => startRegenExercises(course.id, course.title)}
            onEnrichLessons={() => startEnrichCourse(course.id, course.title)}
            onCoverRefreshed={async (fetchedAt) => {
              // Load the course JSON, bump coverFetchedAt, save it back.
              // Avoids the "stale blob URL" problem the first time a
              // cover is fetched for an existing course — useCourseCover
              // reruns whenever this value changes.
              try {
                const current = await invoke<Course>("load_course", {
                  courseId: course.id,
                });
                current.coverFetchedAt = fetchedAt;
                await invoke("save_course", {
                  courseId: course.id,
                  body: current,
                });
                await refreshCourses();
              } catch (e) {
                console.error("[fishbones] cover save failed:", e);
              }
            }}
            onChangeLanguage={async (language) => {
              // Load → mutate → save → refresh. Same pattern as the
              // cover-refresh handler above. Only the top-level
              // `language` changes; lesson-level `language` fields are
              // left alone because they're valid in their own right
              // (e.g. a Python course with a quiz lesson whose language
              // is "plaintext" is fine — the quiz doesn't run code).
              const current = await invoke<Course>("load_course", {
                courseId: course.id,
              });
              current.language = language;
              await invoke("save_course", {
                courseId: course.id,
                body: current,
              });
              await refreshCourses();
            }}
            onChangeMetadata={async (patch) => {
              // Title / author / release-status edit. Same load →
              // mutate → save → refresh as the language handler. The
              // patch carries only the keys the user actually changed
              // (modal computes the diff before calling). null on
              // author or releaseStatus clears the field, so the
              // course can fall back to "no byline" / "Unreviewed".
              const current = await invoke<Course>("load_course", {
                courseId: course.id,
              });
              if (typeof patch.title === "string") {
                current.title = patch.title;
              }
              if (patch.author === null) {
                delete (current as { author?: string }).author;
              } else if (typeof patch.author === "string") {
                current.author = patch.author;
              }
              if (patch.releaseStatus === null) {
                delete (current as { releaseStatus?: string }).releaseStatus;
              } else if (patch.releaseStatus !== undefined) {
                current.releaseStatus = patch.releaseStatus;
              }
              await invoke("save_course", {
                courseId: course.id,
                body: current,
              });
              await refreshCourses();
            }}
          />
        );
      })()}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${pendingDelete.courseTitle}"?`}
          message={
            `This removes the course, all lesson progress, and the ingest cache from disk. ` +
            `Re-importing the same PDF later will run the full AI pipeline from scratch.\n\n` +
            `This can't be undone.`
          }
          confirmLabel="Delete course"
          cancelLabel="Keep"
          danger
          onConfirm={() => performDelete(pendingDelete.courseId)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {bulkImportOpen && (
        <BulkImportDialog
          onDismiss={() => setBulkImportOpen(false)}
          onStartQueue={(items) => {
            // Hands off to the queue runner. FloatingIngestPanel shows
            // progress across the batch. Dialog dismisses itself.
            startBulkIngest(items);
          }}
        />
      )}

      {importOpen && (
        <ImportDialog
          onDismiss={() => {
            setImportOpen(false);
            setPreselectedImportPath(null);
          }}
          preselectedPath={preselectedImportPath ?? undefined}
          onStartAiIngest={(opts) => {
            // Fire-and-forget — the pipeline runs detached and the floating
            // panel (below) shows progress. Dialog already closes itself.
            startIngest(opts);
          }}
          onSavedCourse={async (courseId) => {
            // Non-AI path: the deterministic splitter already saved the
            // course. Refresh the sidebar + jump to the first lesson.
            const fresh = await refreshCourses();
            const imported = fresh.find((c) => c.id === courseId);
            if (!imported || imported.chapters.length === 0) return;
            const firstLessonId = imported.chapters[0].lessons[0]?.id;
            if (!firstLessonId) return;
            setOpenTabs((prev) => {
              const without = prev.filter((t) => t.courseId !== courseId);
              const next = [...without, { courseId, lessonId: firstLessonId }];
              setActiveTabIndex(next.length - 1);
              return next;
            });
          }}
        />
      )}

      {ingest.status !== "idle" && (
        <FloatingIngestPanel
          run={ingest}
          onCancel={cancelIngest}
          onDismiss={dismissIngest}
          onOpen={(bookId) => {
            const c = courses.find((x) => x.id === bookId);
            if (!c || c.chapters.length === 0) return;
            const firstLessonId = c.chapters[0].lessons[0]?.id;
            if (!firstLessonId) return;
            setOpenTabs((prev) => {
              const without = prev.filter((t) => t.courseId !== bookId);
              const next = [...without, { courseId: bookId, lessonId: firstLessonId }];
              setActiveTabIndex(next.length - 1);
              return next;
            });
            dismissIngest();
          }}
        />
      )}

      {/* Floating local-LLM tutor. Lives at the root so it persists
          across library / lesson / playground / profile routes —
          same character, same conversation state. System prompt is
          rebuilt from the active lesson on each send(). */}
      {/* AI assistant is desktop-only for now — the streaming runs
          via Tauri events from a local Ollama / Anthropic-via-Rust
          path that doesn't have a web equivalent yet. Phase 4 will
          re-enable this on web by streaming directly from
          api.mattssoftware.com once the relay endpoints land. */}
      {!isWeb && (
        <AiAssistant
          lesson={activeLesson}
          course={activeCourse}
          celebrateAt={celebrateAt}
        />
      )}

      {/* Floating "get the desktop app" upsell — web-only. The
          component self-gates on `isWeb` and a 30-day localStorage
          dismissal, so on desktop this is a no-op render. */}
      <InstallBanner />

      {/* First-launch sign-in nudge. Self-gates on
          `cloud.user === false` (= no token, not signed in) and on
          a localStorage "permanent dismiss" flag, so this stays
          quiet on every subsequent launch unless the user clicks
          "Skip" without ticking the checkbox.

          Web build: enabled. SignInDialog branches on `isWeb` to
          route OAuth through a popup window that postMessages the
          minted token back to the parent (instead of the desktop's
          `fishbones://` deep-link callback). Email + password worked
          unchanged on web all along — the dialog just wasn't being
          rendered. */}
      <FirstLaunchPrompt cloud={cloud} />

      {/* Re-openable sign-in modal. Driven by the "Sign in" button in
          the TopBar stats dropdown — separate from the first-launch
          prompt above (which has a one-time-show gate of its own).
          The dialog auto-closes on a successful OAuth round-trip
          (deep-link on desktop, postMessage on web) via its internal
          `awaitingOAuth` watcher. */}
      {signInOpen && (
        <SignInDialog
          cloud={cloud}
          onClose={() => setSignInOpen(false)}
        />
      )}

      {/* Cmd+K command palette. Searches across actions + every
          loaded course / lesson. Opening a lesson reuses the same
          selectLesson path the sidebar uses, so tab + recents
          state stay coherent. */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        courses={courses}
        actions={{
          openLibrary: () => setView("library"),
          openPlayground: () => setView("playground"),
          openProfile: () => setView("profile"),
          openDocs: () => setView("docs"),
          openSettings: () => setSettingsOpen(true),
          importBook: () => setImportOpen(true),
          // Triggering "ask AI" from the palette dispatches the same
          // event the lesson reader's `?` badges fire. Empty detail
          // leaves the panel open without a pre-canned prompt so the
          // learner can type their own question.
          askAi: () => {
            window.dispatchEvent(
              new CustomEvent("fishbones:ask-ai", {
                detail: { kind: "open" },
              }),
            );
          },
          // "Verify" actions only surface when there's something to
          // verify — an active course (single mode) or any loaded
          // courses at all (multi mode). The palette itself is
          // unaware of these conditions; we just gate the action by
          // making it undefined when not applicable.
          verifyCourse: activeCourse
            ? () => startVerifySingleCourse(activeCourse)
            : undefined,
          verifyAllCourses:
            courses.length > 0
              ? () => startVerifyAllCourses(courses)
              : undefined,
          // Course-mutation actions: only surface when an active
          // course is open so they have a clear target.
          reapplyBundledStarter: activeCourse
            ? () => void handleReapplyBundledStarter(activeCourse.id)
            : undefined,
          applyFixesFromPrompt: activeCourse
            ? () => setFixApplierForCourseId(activeCourse.id)
            : courses.length > 0
              ? () => setFixApplierForCourseId(courses[0].id)
              : undefined,
        }}
        onOpenLesson={(courseId, lessonId) => selectLesson(courseId, lessonId)}
      />

      <VerifyCourseOverlay
        session={verifySession}
        onCancel={cancelVerification}
        onClose={() => {
          // If a run is still in flight when the user clicks ✕, treat
          // it as cancel-and-close so we don't keep producing results
          // into a stale, unrendered session object.
          if (verifyControllerRef.current) cancelVerification();
          setVerifySession(null);
        }}
      />

      {fixApplierForCourseId && (
        <FixApplierDialog
          courses={courses}
          initialCourseId={fixApplierForCourseId}
          onClose={() => setFixApplierForCourseId(null)}
          onApplied={async () => {
            // Re-hydrate so the workbench picks up the patched
            // solution / tests on next Run. We don't auto-close —
            // the user might want to download the updated JSON to
            // promote into the bundled starter.
            if (fixApplierForCourseId) {
              await hydrateCourse(fixApplierForCourseId);
            }
          }}
        />
      )}
    </div>
  );

  /// Kick off `verifyCourse` for one course in WATCH mode — the
  /// editor visibly flips to solution code, the run button visibly
  /// fires, the next button visibly advances, quizzes auto-answer
  /// with green-chip animation. By the end the course shows 100%
  /// completion.
  async function startVerifySingleCourse(course: Course) {
    if (verifyControllerRef.current) return; // ignore re-entry
    const controller = new AbortController();
    verifyControllerRef.current = controller;
    const total = collectVerifyTargets(course).length;
    setVerifySession({
      label: course.title,
      index: 0,
      total,
      current: null,
      results: [],
      done: total === 0,
    });
    // Move to the first lesson immediately so the user sees the
    // course open even before the loop's first iteration kicks in
    // (the loop's own `selectLesson` is idempotent).
    const first = course.chapters[0]?.lessons[0];
    if (first) selectLesson(course.id, first.id);
    try {
      await verifyCourse(course, {
        signal: controller.signal,
        selectLesson,
        markComplete: markCompletedAndCelebrate,
        onProgress: (p) =>
          setVerifySession((s) =>
            s ? { ...s, index: p.index, total: p.total, current: p.current } : null,
          ),
        onResult: (r) =>
          setVerifySession((s) =>
            s ? { ...s, results: [...s.results, r] } : null,
          ),
      });
    } finally {
      verifyControllerRef.current = null;
      setVerifySession((s) => (s ? { ...s, done: true, current: null } : null));
    }
  }

  /// Same shape as the single-course path but loops every loaded
  /// course. The label updates per course so the overlay header
  /// reads "Mastering Ethereum (3 / 8)" while running.
  async function startVerifyAllCourses(allCourses: Course[]) {
    if (verifyControllerRef.current) return;
    const controller = new AbortController();
    verifyControllerRef.current = controller;
    const grandTotal = allCourses.reduce(
      (n, c) => n + collectVerifyTargets(c).length,
      0,
    );
    let runningCount = 0;
    setVerifySession({
      label: `All courses (${allCourses.length})`,
      index: 0,
      total: grandTotal,
      current: null,
      results: [],
      done: grandTotal === 0,
    });
    try {
      await verifyAllCourses(allCourses, {
        signal: controller.signal,
        selectLesson,
        markComplete: markCompletedAndCelebrate,
        onProgress: (mp) => {
          setVerifySession((s) =>
            s
              ? {
                  ...s,
                  label: mp.currentCourse
                    ? `${mp.currentCourse.title} (${mp.courseIndex + 1} / ${mp.totalCourses})`
                    : `All courses (${mp.totalCourses})`,
                  index: runningCount + mp.perCourse.index,
                  current: mp.perCourse.current,
                }
              : null,
          );
        },
        onResult: (r) =>
          setVerifySession((s) =>
            s ? { ...s, results: [...s.results, r] } : null,
          ),
        onCourseComplete: (_course, results) => {
          runningCount += results.length;
        },
      });
    } finally {
      verifyControllerRef.current = null;
      setVerifySession((s) =>
        s ? { ...s, done: true, current: null, index: s.total } : null,
      );
    }
  }

  function cancelVerification() {
    verifyControllerRef.current?.abort();
    verifyControllerRef.current = null;
    setVerifySession((s) => (s ? { ...s, done: true, current: null } : null));
  }

  /// Unified "Add course" handler — replaces the four separate
  /// import buttons (Book / Bulk books / Docs site / Archive) with
  /// a single OS file picker that sniffs each chosen file and
  /// dispatches to the right pipeline:
  ///   * `.fishbones` / `.kata` / `.zip` → `importArchiveAtPath`
  ///   * `.pdf` / `.epub` (single)       → ImportDialog with
  ///                                       `preselectedPath`
  ///   * `.pdf` / `.epub` (multi)        → BulkImportDialog (no
  ///                                       pre-fill in v1; user
  ///                                       re-picks inside)
  /// Docs URLs are URL-only so they stay as a separate dropdown
  /// item on AddCourseButton.
  async function handleAddCourse() {
    try {
      const picked = await openDialog({
        multiple: true,
        filters: [
          {
            name: "Course files",
            extensions: ["pdf", "epub", "fishbones", "kata", "zip"],
          },
        ],
      });
      if (!picked) return;
      const paths: string[] = Array.isArray(picked) ? picked : [picked];
      const pdfs: string[] = [];
      const archives: string[] = [];
      for (const p of paths) {
        const ext = p.toLowerCase().split(".").pop() ?? "";
        if (ext === "pdf" || ext === "epub") pdfs.push(p);
        else if (ext === "fishbones" || ext === "kata" || ext === "zip")
          archives.push(p);
      }

      // Archives import directly via the existing Tauri command —
      // no dialog hop needed. Fire each in sequence; alert ONLY at
      // the end so a user dropping 5 archives doesn't get 5 popups
      // mid-batch.
      const archiveErrors: string[] = [];
      for (const archive of archives) {
        try {
          await importArchiveAtPath(archive);
        } catch (e) {
          archiveErrors.push(
            `${archive}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (archiveErrors.length > 0) {
        alert(
          `Some archives failed to import:\n\n${archiveErrors.join("\n")}`,
        );
      }

      if (pdfs.length === 1) {
        // Single PDF/EPUB → open the existing import wizard with
        // the path pre-filled so the user lands on the metadata
        // step immediately instead of re-picking.
        setPreselectedImportPath(pdfs[0]);
        setImportOpen(true);
      } else if (pdfs.length > 1) {
        // Multi PDF/EPUB → bulk import wizard. v1 doesn't pre-fill
        // the queue; user re-selects inside. Acceptable trade-off
        // because bulk runs are rarer than single imports.
        setBulkImportOpen(true);
      }
    } catch (e) {
      console.error("[fishbones] add course failed:", e);
      alert(
        `Couldn't open the file picker: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /// "Reapply bundled starter" — overwrite the installed copy of a
  /// course with the bundled `public/starter-courses/<id>.json`,
  /// then refresh the in-memory course list so the active tab
  /// picks up the new content. Used from cmd+K AND from the
  /// Library cover badge.
  async function handleReapplyBundledStarter(courseId: string) {
    try {
      await syncBundledToInstalled(courseId);
      // Re-pull the summary list + re-hydrate this course's body
      // so the running app reflects the new content without a
      // page reload.
      await refreshCourses();
      await hydrateCourse(courseId);
    } catch (e) {
      console.error("[fishbones] reapply bundled starter failed:", e);
    }
  }
}

interface Neighbors {
  prev: { id: string; title: string } | null;
  next: { id: string; title: string } | null;
}

function LessonView({
  courseId,
  courseLanguage,
  lesson,
  neighbors,
  isCompleted,
  onComplete,
  onNavigate,
  onRetryLesson,
}: {
  courseId: string;
  /// Primary language of the PARENT course. Used as an override signal
  /// for `runFiles` — when the course is "reactnative", lessons always
  /// run through the RN runtime regardless of how the individual
  /// lesson's `language` field ended up tagged. LLM-generated lessons
  /// sometimes default to "javascript" for JSX code, which otherwise
  /// sends RN source to the JavaScript worker and fails with an
  /// opaque `AsyncFunction@[native code]` blob-URL error.
  courseLanguage: Course["language"];
  lesson: Lesson;
  neighbors: Neighbors;
  isCompleted: boolean;
  onComplete: () => void;
  onNavigate: (lessonId: string) => void;
  /// Fires when the "Retry this exercise" inline button is clicked on
  /// a demoted lesson. App wires this to `startRetryLesson`.
  onRetryLesson?: (lessonId: string) => void;
}) {
  const hasExercise = isExerciseKind(lesson);
  // Multi-file workbench state. We always deal in arrays here — legacy
  // single-file lessons get synthesized into a one-element array by
  // `deriveStarterFiles`. Storing an array even for the single-file case
  // keeps the EditorPane contract uniform.
  // `useWorkbenchFiles` reads from localStorage synchronously on first
  // render so reopening a lesson restores the learner's in-progress code
  // instead of snapping back to the starter. Reset clears the save and
  // returns to starter in one step.
  const { files, setFiles, resetToStarter } = useWorkbenchFiles(
    courseId,
    lesson,
    hasExercise,
  );
  const [activeFileIdx, setActiveFileIdx] = useState(0);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  // When true, the workbench has been popped out into a separate window and
  // the main-window editor gets hidden in favor of a "currently popped out"
  // placeholder. Reset on lesson change via the parent's keyed remount.
  const [popped, setPopped] = useState(false);

  // React Native courses route their preview through a SEPARATE OS
  // window (the popped phone simulator) instead of a fixed bottom-
  // pane OutputPane. When this is true, the lesson workbench renders
  // the EditorPane full-width and the phone view lives in its own
  // popout. We track an "open" boolean to remember whether the user
  // last asked the popout to be on or off — the next Run auto-opens
  // it, and the toggle button reopens it after dismissal.
  const useFloatingPhone = courseLanguage === "reactnative";
  // Scope keyed on lesson so two RN lessons in different tabs each
  // get their own popout window + bus channel.
  const phoneScope = `lesson:${courseId}:${lesson.id}`;
  const [floatingPhoneOpen, setFloatingPhoneOpen] = useState<boolean>(() => {
    if (typeof localStorage === "undefined") return true;
    const v = localStorage.getItem("fishbones:floating-phone-open");
    if (v === null) return true;
    return v === "true";
  });
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      "fishbones:floating-phone-open",
      floatingPhoneOpen ? "true" : "false",
    );
  }, [floatingPhoneOpen]);
  // Bus the LessonView pushes preview URLs through. Memoised
  // implicitly because makePhonePreviewBus is cheap; the popout
  // listens with the matching scope.
  const phoneBus = useFloatingPhone ? makePhonePreviewBus(phoneScope) : null;
  // When the user closes the lesson tab or pops the workbench out,
  // close the popout too — leaving an orphaned phone window for a
  // lesson the user has stopped looking at is just confusing.
  useEffect(() => {
    if (!useFloatingPhone) return;
    return () => {
      void closePhonePopout(phoneScope);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useFloatingPhone, phoneScope]);

  // SvelteKit lessons keep a long-lived `vite dev` process under
  // <app-data>/sveltekit-runs/<id>/. Stop it on lesson tab close
  // so we don't leak Node processes across sessions. Idempotent —
  // backend no-ops when nothing's running.
  useEffect(() => {
    const id = `${courseId}:${lesson.id}`;
    return () => {
      // Lazy-import to avoid loading the runtime module before
      // it's needed (the SvelteKit runtime pulls in extra Tauri
      // event-listener glue).
      void import("./runtimes/sveltekit").then((m) =>
        m.stopSvelteKit(id),
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, lesson.id]);

  // Proactive toolchain probe. When the lesson's language is one that
  // needs a local compiler (C / C++ / Java / Kotlin / C# / Assembly),
  // hit `probe_language_toolchain` on mount — matches the pattern
  // PlaygroundView uses. If the probe says "not installed" (or
  // installed-but-broken, e.g. the macOS `java` stub without a real
  // JDK), we render the install banner above the workbench so the
  // learner sees it BEFORE clicking Run instead of after a failed
  // compile. Browser-hosted languages (JS/TS/Python/etc.) short-
  // circuit inside `probe_language_toolchain` to installed=true, so
  // the banner never appears for them.
  const [tcRefresh, setTcRefresh] = useState(0);
  // Reading-only lessons don't have a `language` field — only exercise
  // and mixed-content lessons do. Skip the probe entirely for readers.
  const lessonLanguage = hasExercise ? lesson.language : undefined;
  const needsLocalToolchain =
    !!lessonLanguage && NATIVE_TOOLCHAIN_LANGUAGES.has(lessonLanguage);
  const { status: lessonToolchainStatus } = useToolchainStatus(
    needsLocalToolchain ? lessonLanguage! : "",
    tcRefresh,
  );
  const showLessonToolchainBanner =
    needsLocalToolchain &&
    !!lessonToolchainStatus &&
    !lessonToolchainStatus.installed &&
    !!lessonToolchainStatus.install_hint;


  async function handleRun() {
    if (!hasExercise) return;
    setRunning(true);
    setResult(null);
    // Auto-pop the phone simulator open on every Run so a closed
    // popout surfaces itself when the user actually has output to
    // see. We open the OS window AND set the local "open" state so
    // the toggle button hides and we remember the preference. The
    // popout is idempotent — re-opening when already open just
    // focuses the existing window.
    if (useFloatingPhone) {
      setFloatingPhoneOpen(true);
      void openPhonePopout(phoneScope, lesson.title);
      // Tell the popout we're working on a new run so it can swap
      // to the "running…" placeholder instead of showing a stale
      // preview iframe through the compile.
      phoneBus?.emit({ type: "running" });
    }
    try {
      const tests = "tests" in lesson ? lesson.tests : undefined;
      // Prefer the course's language when it's a whole-app runtime
      // (react native, web, threejs) — those are meta-languages where
      // the RUN behaviour is owned by the course, not the individual
      // lesson. The fix for docs-generated RN courses: the LLM
      // sometimes stamps `lesson.language: "javascript"` for JSX code
      // even though we told it the course is "reactnative". Without
      // this override we'd dispatch to the JS worker and blow up with
      // an AsyncFunction blob error.
      const effectiveLanguage =
        courseLanguage === "reactnative" ||
        courseLanguage === "web" ||
        courseLanguage === "threejs"
          ? courseLanguage
          : lesson.language;
      const harness =
        "harness" in lesson
          ? (lesson as { harness?: "evm" | "solana" }).harness
          : undefined;
      const r = await runFiles(
        effectiveLanguage,
        files,
        tests,
        undefined,
        // Identity passed through to the SvelteKit runner so the
        // long-lived `vite dev` process gets keyed per lesson —
        // re-runs hot-reload the same server instead of spinning
        // up a fresh project dir each time.
        `${courseId}:${lesson.id}`,
        harness,
      );
      // Defensive guard: a runtime can theoretically resolve to
      // undefined (unknown language id slipping past the LanguageId
      // switch, an untyped IPC failure). Surface a friendly error
      // rather than crashing the handler with `r.error` on undefined.
      if (!r) {
        const errResult: RunResult = {
          logs: [],
          error: `No runtime for language "${effectiveLanguage}".`,
          durationMs: 0,
        };
        setResult(errResult);
        emitVerifierEvent({
          type: "runResult",
          lessonId: lesson.id,
          passed: false,
          result: errResult,
        });
        if (useFloatingPhone) {
          phoneBus?.emit({
            type: "console",
            logs: [],
            error: `No runtime for language "${effectiveLanguage}".`,
          });
        }
        return;
      }
      setResult(r);
      const passed = isPassing(r);
      if (passed) onComplete();
      // Watch-mode verifier: announce the run finished + whether it
      // passed so the verify-course coroutine can advance to the
      // next lesson without polling React state.
      emitVerifierEvent({
        type: "runResult",
        lessonId: lesson.id,
        passed,
        result: r,
      });
      // Push the run outcome to the popped phone simulator. Preview
      // URL when present (RN runtime hands one back from the local
      // Tauri preview server); otherwise the captured logs + error
      // so a failed run is at least readable inside the popout.
      if (useFloatingPhone) {
        if (r.previewUrl) {
          phoneBus?.emit({ type: "preview", url: r.previewUrl });
        } else {
          phoneBus?.emit({
            type: "console",
            logs: r.logs ?? [],
            error: r.error,
          });
        }
      }
    } catch (e) {
      // Tauri IPC failures (missing command, serialization errors),
      // worker init failures — any thrown error from the runtime chain
      // lands here. Render it in the OutputPane so the user sees what
      // went wrong instead of a silent failed run.
      const errMsg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      const errResult: RunResult = {
        logs: [],
        error: errMsg,
        durationMs: 0,
      };
      setResult(errResult);
      emitVerifierEvent({
        type: "runResult",
        lessonId: lesson.id,
        passed: false,
        result: errResult,
      });
      if (useFloatingPhone) {
        phoneBus?.emit({ type: "console", logs: [], error: errMsg });
      }
    } finally {
      setRunning(false);
    }
  }

  /// Reset reverts every file to its starter content AND wipes the saved
  /// copy in localStorage so the next lesson-open also starts fresh. Safe
  /// to call always — the hook no-ops when the lesson isn't an exercise.
  function handleReset() {
    resetToStarter();
    setActiveFileIdx(0);
  }

  /// Reveal solution swaps the entire file set to the reference solution.
  /// Clears the run result so the learner sees a fresh state to run against;
  /// gated by EditorPane's confirmation dialog so it can't fire by accident.
  function handleRevealSolution() {
    if (hasExercise) {
      setFiles(deriveSolutionFiles(lesson));
      setActiveFileIdx(0);
      setResult(null);
    }
  }

  /// Per-file edit handler. Immutably replaces the content of files[index].
  /// React re-renders EditorPane with the new array; Monaco picks up the
  /// new value for the active file.
  function handleFileChange(index: number, next: string) {
    setFiles((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const copy = prev.slice();
      copy[index] = { ...copy[index], content: next };
      return copy;
    });
  }

  const hints =
    hasExercise && "hints" in lesson && lesson.hints ? lesson.hints : undefined;

  // Keep the main window and the popped-out window in sync. The bus chooses
  // Tauri events (for native multi-window) or BroadcastChannel (for vite
  // dev) under the hood — we only see a clean listen/emit API here.
  useEffect(() => {
    if (!hasExercise) return;
    const bus = makeBus(courseId, lesson.id);
    const unlisten = bus.listen((msg, from) => {
      if (from !== "popped") return;
      if (msg.type === "files") setFiles(msg.files);
      if (msg.type === "running") setRunning(true);
      if (msg.type === "result") {
        setResult(msg.result);
        setRunning(false);
      }
      if (msg.type === "complete") onComplete();
      // The popped window fires `hello` once it mounts so we can push it
      // our current files (otherwise it'd load with starter text even if
      // the user had edited here).
      if (msg.type === "hello") {
        bus.emit({ type: "files", files }, "main");
      }
      // Popped window is going away — flip the inline workbench back on
      // so the learner doesn't stare at a "popped out" placeholder over
      // an empty detached window.
      if (msg.type === "closed") {
        setPopped(false);
      }
    });
    return unlisten;
    // `files` intentionally omitted — we re-broadcast via the effect
    // below. Including it here would re-register the listener on every
    // keystroke and drop pending messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, lesson.id, hasExercise, onComplete]);

  useEffect(() => {
    if (!hasExercise) return;
    const bus = makeBus(courseId, lesson.id);
    bus.emit({ type: "files", files }, "main");
  }, [files, courseId, lesson.id, hasExercise]);

  /// Open the workbench in a detached window. Uses Tauri's WebviewWindow
  /// when available so the popped window lives inside the app; falls back
  /// to window.open for vite dev or if the capability is missing. We pass
  /// the current code through the URL so the popped window paints with
  /// the learner's in-progress code on first render — localStorage isn't
  /// reliably shared across Tauri webview windows.
  async function handlePopOut() {
    if (!hasExercise) return;
    try {
      await openPoppedWorkbench(courseId, lesson.id, lesson.title, files);
      setPopped(true);
    } catch (e) {
      console.error("[fishbones] pop-out failed:", e);
    }
  }

  /// Bring the workbench back into the main window. Closes the popped
  /// window too so we don't leave a zombie detached view. The popped
  /// window's `beforeunload` also emits `closed` which flips our state,
  /// but setting it here too makes the main-window transition instant
  /// instead of waiting for the round-trip.
  async function handleReopenInline() {
    setPopped(false);
    await closePoppedWorkbench(courseId, lesson.id);
  }

  // Reading-only lessons have no run/quiz gate — the Next button stands in
  // as the "I read this" affordance. Exercise/quiz lessons get marked complete
  // when the user actually solves them, so Next there is just navigation.
  const isReadingOnly = !hasExercise && !isQuiz(lesson);

  function handleNext() {
    if (!neighbors.next) return;
    if (isReadingOnly && !isCompleted) {
      onComplete();
    }
    onNavigate(neighbors.next.id);
  }
  function handlePrev() {
    if (neighbors.prev) onNavigate(neighbors.prev.id);
  }

  /// Watch-mode verifier wiring. The verifier coroutine (cmd+K →
  /// Verify course) emits commands targeting a specific lesson id;
  /// this LessonView listens and dispatches them to the same
  /// handlers the buttons use, so the editor visibly flips to
  /// solution code, the run button visibly fires, etc.
  ///
  /// We capture the latest handlers via a ref so the listener stays
  /// registered across re-renders without re-binding the window
  /// event each time the closure changes.
  const verifierHandlersRef = useRef({
    handleRevealSolution,
    handleRun,
    handleNext,
  });
  useEffect(() => {
    verifierHandlersRef.current = {
      handleRevealSolution,
      handleRun,
      handleNext,
    };
  });
  useEffect(() => {
    const off = onVerifierCommand((cmd) => {
      if (cmd.lessonId !== lesson.id) return;
      if (cmd.type === "revealSolution")
        verifierHandlersRef.current.handleRevealSolution();
      else if (cmd.type === "run")
        void verifierHandlersRef.current.handleRun();
      else if (cmd.type === "next")
        verifierHandlersRef.current.handleNext();
    });
    return off;
  }, [lesson.id]);

  /// Announce the lesson view is mounted + ready to receive
  /// commands. Fires once per lesson change. The verifier coroutine
  /// awaits this event before dispatching any per-lesson commands so
  /// it doesn't race the previous LessonView's unmount.
  useEffect(() => {
    emitVerifierEvent({
      type: "lessonReady",
      courseId,
      lessonId: lesson.id,
      kind: lesson.kind,
    });
  }, [courseId, lesson.id, lesson.kind]);

  const nextLabel =
    isReadingOnly && !isCompleted && neighbors.next ? "mark read & next" : "next";

  const nav = (
    <LessonNav
      prev={neighbors.prev}
      next={neighbors.next}
      onPrev={handlePrev}
      onNext={handleNext}
      nextLabel={nextLabel}
    />
  );

  // Quiz lessons are rendered inline under the lesson prose with no editor /
  // output pane — the quiz widget handles its own answer flow. Column layout
  // so reader and quiz stack vertically inside a single scroll container.
  if (isQuiz(lesson)) {
    return (
      <div className="fishbones__lesson fishbones__lesson--column">
        <div className="fishbones__lesson-scroll">
          <LessonReader lesson={lesson} />
          <QuizView lesson={lesson} onComplete={onComplete} />
          <div className="fishbones__lesson-nav-wrap">{nav}</div>
        </div>
      </div>
    );
  }

  // Cloze lessons share the column layout with quizzes — prose on top,
  // interactive code-with-chips below. We reuse MobileCloze for the
  // chip rendering since the UX is fundamentally the same on phone and
  // desktop (a code block with inline tappable slots); the only
  // surface-specific decision is the option-picker presentation, which
  // stays as a bottom sheet on both since it's compact and doesn't
  // need the screen real estate a popover would.
  if (isCloze(lesson)) {
    return (
      <div className="fishbones__lesson fishbones__lesson--column">
        <div className="fishbones__lesson-scroll">
          <LessonReader lesson={lesson} />
          <MobileCloze
            // Remount on lesson change so picks / fired-flag don't
            // leak the previous lesson's "correct" state — same fix
            // as the mobile MobileLesson dispatch.
            key={lesson.id}
            template={lesson.template}
            slots={lesson.slots}
            prompt={lesson.prompt}
            onComplete={onComplete}
            isCompleted={isCompleted}
          />
          <div className="fishbones__lesson-nav-wrap">{nav}</div>
        </div>
      </div>
    );
  }

  if (isMicroPuzzle(lesson)) {
    return (
      <div className="fishbones__lesson fishbones__lesson--column">
        <div className="fishbones__lesson-scroll">
          <LessonReader lesson={lesson} />
          <MobileMicroPuzzle
            key={lesson.id}
            challenges={lesson.challenges}
            language={lesson.language}
            prompt={lesson.prompt}
            isCompleted={isCompleted}
          />
          <div className="fishbones__lesson-nav-wrap">{nav}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="fishbones__lesson">
      <LessonReader
        lesson={lesson}
        footer={nav}
        onRetryLesson={onRetryLesson}
      />
      {hasExercise && !popped && (
        <div className="fishbones__lesson-workbench-wrap">
          {showLessonToolchainBanner && lessonToolchainStatus && (
            // Proactive missing-toolchain nudge. Sits above the
            // workbench so the learner doesn't click Run, wait for
            // compile, and THEN discover their JDK is missing — they
            // see "Java isn't installed" with a one-click Install
            // button the moment the lesson opens. `tcRefresh` re-runs
            // the probe after a successful install so this clears
            // itself once the toolchain lands on PATH.
            <MissingToolchainBanner
              status={lessonToolchainStatus}
              onInstalled={() => setTcRefresh((n) => n + 1)}
            />
          )}
          {useFloatingPhone ? (
            // RN-course path — editor takes the full workbench width
            // and the FloatingPhone modal carries the preview. We
            // render the EditorPane inside a `solo` wrapper that
            // matches the Workbench's card chrome so the visual
            // weight stays consistent with the JS / Python lesson
            // surfaces.
            <div className="fishbones__lesson-workbench-solo">
              <EditorPane
                language={lesson.language}
                files={files}
                activeIndex={activeFileIdx}
                onActiveIndexChange={setActiveFileIdx}
                onChange={handleFileChange}
                onRun={handleRun}
                hints={hints}
                onReset={handleReset}
                onRevealSolution={handleRevealSolution}
                onPopOut={handlePopOut}
              />
            </div>
          ) : (
            <Workbench
              widthControlsParent
              editor={
                <EditorPane
                  language={lesson.language}
                  files={files}
                  activeIndex={activeFileIdx}
                  onActiveIndexChange={setActiveFileIdx}
                  onChange={handleFileChange}
                  onRun={handleRun}
                  hints={hints}
                  onReset={handleReset}
                  onRevealSolution={handleRevealSolution}
                  onPopOut={handlePopOut}
                />
              }
              output={
                <OutputPane
                  result={result}
                  running={running}
                  suppressToolchainBanner={showLessonToolchainBanner}
                  language={lesson.language}
                  testsExpected={"tests" in lesson && !!lesson.tests?.trim()}
                />
              }
            />
          )}
        </div>
      )}
      {hasExercise && popped && (
        <button
          className="fishbones__workbench-popped-pill"
          onClick={handleReopenInline}
          title="Close the popped window and dock the workbench back into this pane"
        >
          <span className="fishbones__workbench-popped-pill-icon" aria-hidden>
            <Icon icon={panelLeftOpen} size="xs" color="currentColor" />
          </span>
          <span>pop back in</span>
        </button>
      )}

      {/* Phone simulator for RN courses now lives in its own OS
          window — opened lazily on first Run, or via this toggle
          button at any time. The popout listens on
          `makePhonePreviewBus(phoneScope)` for new preview URLs we
          push from `handleRun`. The button sits permanently in the
          corner because we can't reliably detect whether the user
          closed the OS window (Tauri webview close events bubble
          inconsistently across platforms), so the cheapest correct
          UX is "always offer to re-open / focus". `openPhonePopout`
          is idempotent — re-opening an already-open popout just
          focuses it. */}
      {useFloatingPhone && hasExercise && !popped && (
        <PhoneToggleButton
          onShow={() => {
            setFloatingPhoneOpen(true);
            void openPhonePopout(phoneScope, lesson.title);
            // If we already have a result for this lesson, replay
            // it into the popout so the freshly-opened window isn't
            // empty until the next Run.
            if (result?.previewUrl) {
              phoneBus?.emit({ type: "preview", url: result.previewUrl });
            } else if (result) {
              phoneBus?.emit({
                type: "console",
                logs: result.logs ?? [],
                error: result.error,
              });
            }
          }}
        />
      )}
    </div>
  );
}

/// Flatten all chapters into a linear lesson list and return the siblings of
/// the given lessonId. Returning null at the ends lets the nav disable the
/// Prev/Next buttons without additional branching in the view.
function findNeighbors(course: Course, lessonId: string): Neighbors {
  const flat: Array<{ id: string; title: string }> = [];
  for (const ch of course.chapters) {
    for (const l of ch.lessons) flat.push({ id: l.id, title: l.title });
  }
  const idx = flat.findIndex((x) => x.id === lessonId);
  if (idx < 0) return { prev: null, next: null };
  return {
    prev: idx > 0 ? flat[idx - 1] : null,
    next: idx < flat.length - 1 ? flat[idx + 1] : null,
  };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "course";
}

function findLesson(course: Course | null, lessonId: string | undefined): Lesson | null {
  if (!course || !lessonId) return null;
  for (const ch of course.chapters) {
    const found = ch.lessons.find((l) => l.id === lessonId);
    if (found) return found;
  }
  return null;
}
