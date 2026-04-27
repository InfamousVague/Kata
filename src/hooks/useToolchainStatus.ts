import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isWeb } from "../lib/platform";

/// Everything the `MissingToolchainBanner` needs to render the install
/// affordance. Mirrors `toolchain::InstallHint` in the Rust side.
export interface InstallHint {
  manager: string;
  command: string;
  requires_password: boolean;
  description: string;
  /// Optional title override. When set, the banner reads this instead
  /// of `{Language} isn't installed` — used for the Kotlin partial-
  /// install case where kotlinc is present but the JDK is missing, so
  /// "Kotlin isn't installed" would mislead the learner.
  title?: string;
  /// Optional primary-button label override. Defaults to `Install
  /// {Language}` when absent.
  button_label?: string;
}

export interface ToolchainStatus {
  language: string;
  installed: boolean;
  version: string | null;
  install_hint: InstallHint | null;
}

/// Queries the Rust `probe_language_toolchain` command for the given
/// language. `cacheBust` is an opaque number — bumping it forces a
/// re-probe (useful after an install finishes). Returns `null` until
/// the first probe resolves.
///
/// Callers can pass an empty / falsy `language` to disable the probe
/// entirely — handy in OutputPane, which only knows the language when
/// the most recent run actually came back with a missing-toolchain
/// flag. With the guard we skip the IPC on every successful run
/// instead of invoking the backend with `language: ""`.
///
/// Errors (e.g. unknown language) surface as `null` status + logged
/// warning — the banner simply doesn't appear in that case, which is
/// the right fallback for languages that don't need a local toolchain.
export function useToolchainStatus(language: string, cacheBust: number = 0) {
  const [status, setStatus] = useState<ToolchainStatus | null>(null);
  const [loading, setLoading] = useState(!!language);

  useEffect(() => {
    if (!language) {
      setStatus(null);
      setLoading(false);
      return;
    }
    if (isWeb) {
      // Web build: there's no local toolchain to probe (the gate in
      // runtimes/index.ts already short-circuits desktop-only langs
      // to a `desktopOnly` RunResult). Set null so the
      // MissingToolchainBanner's `installed: !!status` check stays
      // false and it doesn't render at all.
      setStatus(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    invoke<ToolchainStatus>("probe_language_toolchain", { language })
      .then((s) => {
        if (!cancelled) {
          setStatus(s);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn("[fishbones] probe_language_toolchain failed:", e);
          setStatus(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [language, cacheBust]);

  return { status, loading };
}
