/// Web-build stub for `@tauri-apps/plugin-dialog`.
///
/// The native dialogs (`open` / `save`) don't have a clean web
/// equivalent: file selection on web is `<input type="file">` and
/// downloads happen via blob URLs + `<a download>`. Both flows need
/// component-level work, not a transparent shim.
///
/// So these stubs always return `null` — caller code that does
/// `if (path === null) return;` short-circuits cleanly. Phase 3 ports
/// the actual UI (Library import buttons, course-export save, course-
/// settings asset uploads) to the browser-native equivalents.

export interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  multiple?: boolean;
  filters?: DialogFilter[];
  directory?: boolean;
  defaultPath?: string;
  title?: string;
  recursive?: boolean;
}

export interface SaveDialogOptions {
  filters?: DialogFilter[];
  defaultPath?: string;
  title?: string;
}

export async function open(
  _options?: OpenDialogOptions,
): Promise<string | string[] | null> {
  return null;
}

export async function save(
  _options?: SaveDialogOptions,
): Promise<string | null> {
  return null;
}

export async function confirm(
  message: string,
  _options?: { title?: string; kind?: "info" | "warning" | "error" },
): Promise<boolean> {
  // Browser-native confirm is the obvious fallback.
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    return window.confirm(message);
  }
  return false;
}

export async function message(
  msg: string,
  _options?: { title?: string; kind?: "info" | "warning" | "error" },
): Promise<void> {
  if (typeof window !== "undefined" && typeof window.alert === "function") {
    window.alert(msg);
  }
}

export async function ask(
  message: string,
  _options?: { title?: string; kind?: "info" | "warning" | "error" },
): Promise<boolean> {
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    return window.confirm(message);
  }
  return false;
}
