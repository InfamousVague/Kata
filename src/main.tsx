import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PoppedWorkbench from "./components/Workbench/PoppedWorkbench";
import PhonePopoutView from "./components/PhonePopout/PhonePopoutView";
import { applyTheme, loadTheme } from "./theme/themes";
import "./theme/themes.css";
import "./App.css";

// Apply the user's chosen theme (or system preference for the first-run
// default) before React mounts so we don't flash the wrong palette.
applyTheme(loadTheme());

// Three render modes out of a single bundle:
// - default: full App (sidebar + reader + workbench)
// - ?popped=1&course=…&lesson=…: standalone workbench only. Used by
//   the pop-out window opened via window.open from the main window,
//   so learners can drag the editor + console onto a second monitor.
// - ?phone=1&scope=…: standalone phone simulator. Replaces the in-app
//   FloatingPhone modal — RN previews now open in a separate OS
//   window and the main editor pushes new preview URLs over a bus.
const params = new URLSearchParams(window.location.search);
const isPopped = params.get("popped") === "1";
const isPhone = params.get("phone") === "1";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isPhone ? <PhonePopoutView /> : isPopped ? <PoppedWorkbench /> : <App />}
  </React.StrictMode>,
);

// Hand off from the inline index.html preloader to React's in-app
// bootloader. `is-booted` fades the preloader out via the CSS rule in
// index.html; App's `.fishbones__bootloader` overlay (driven by
// `coursesLoaded`) takes over until the course list resolves. We try
// `requestAnimationFrame` first so the swap lands after React's first
// paint, but fall back to a plain microtask — rAF is throttled to zero
// in hidden tabs (preview server, background windows) and we don't want
// the preloader stranded in that case.
function handoffFromPreloader() {
  document.body.classList.add("is-booted");
}
requestAnimationFrame(handoffFromPreloader);
// Defensive fallback in case rAF is throttled (hidden tab) — microtask
// + setTimeout cover both "tab visible but RAF paused" and "React still
// parsing" windows. classList.add is idempotent.
queueMicrotask(handoffFromPreloader);
setTimeout(handoffFromPreloader, 0);
