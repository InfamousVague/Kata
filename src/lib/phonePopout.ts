/// Phone-simulator popout window plumbing.
///
/// Replaces the in-app `<FloatingPhone>` modal for React Native (and
/// other phone-shaped) previews. Instead of rendering the simulator
/// chrome over the main editor, we open a SEPARATE OS window that
/// holds just the phone frame + the preview iframe. The user can
/// drag it to a second monitor, snap it next to the editor, or just
/// move it out of the way.
///
/// Shape mirrors `workbenchSync.ts` which already does this for the
/// editor pop-out — same single-bundle pattern (the popped window
/// re-loads the app at `?phone=1&scope=...` and `main.tsx` routes to
/// `PhonePopoutView`), same Tauri-WebviewWindow / window.open
/// fallback split, same `makeBus` cross-window comm primitive.
///
/// Cross-window state is one-way: the main window pushes
/// `PhonePreviewMsg` updates as the user runs code; the popout
/// listens and re-renders. Going the other way (popout → main) isn't
/// needed yet — closing the popout via the OS window-close button is
/// detected via the absence of further messages, not an explicit
/// "I'm gone" event.
import type { LogLine } from "../runtimes/types";

/// Discriminated union of every message type the main window can
/// push to a popped phone. `running` clears the iframe back to a
/// "running…" placeholder; `preview` swaps the iframe src to the new
/// URL; `console` shows logs+error when a run produced no preview;
/// `clear` resets to the initial empty state.
export type PhonePreviewMsg =
  | { type: "running" }
  | { type: "preview"; url: string }
  | { type: "console"; logs: LogLine[]; error?: string }
  | { type: "clear" };

export interface PhonePreviewBus {
  /// Subscribe to incoming messages. Returns an unlisten function.
  listen(fn: (msg: PhonePreviewMsg) => void): () => void;
  /// Push a message. Fire-and-forget — there's no guarantee a
  /// listener is alive on the other side.
  emit(msg: PhonePreviewMsg): void;
}

function isTauri(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__ !== "undefined";
}

/// Stable label for the popped phone window. `scope` is whatever
/// identity the caller wants — typically the lesson id (so each
/// lesson gets its own popout) or `playground:<lang>` (so playground
/// previews don't collide with lesson previews).
export function phonePopoutLabel(scope: string): string {
  return `phone-${scope.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/// Channel name used by the main↔popout bus. Same scope as the
/// popout window so a stale popout from a different lesson can't
/// pick up messages meant for the new one.
function channelName(scope: string): string {
  return `fishbones:phone-preview:${scope.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/// Build a bus keyed on `scope`. Picks the Tauri event system when
/// available so cross-WebviewWindow messaging works (BroadcastChannel
/// doesn't bridge separate webview processes). Falls back to
/// BroadcastChannel for plain `vite dev`.
export function makePhonePreviewBus(scope: string): PhonePreviewBus {
  const eventName = channelName(scope);

  if (isTauri()) {
    return {
      listen(fn) {
        let unlisten: (() => void) | null = null;
        let disposed = false;
        // Same swallowing pattern workbenchSync uses — `_unlisten` can
        // throw if the event plugin's listener registry has already
        // dropped the handler (HMR teardown, double-unmount, etc.).
        // Wrap with a `safeUn` that catches both sync throws and the
        // async rejection from the wrapper Promise.
        const safeUn = (un: () => void) => {
          try {
            const r = un() as unknown as Promise<void> | void;
            if (r && typeof (r as Promise<void>).catch === "function") {
              (r as Promise<void>).catch(() => {});
            }
          } catch {
            /* stale listener registry */
          }
        };
        import("@tauri-apps/api/event").then(({ listen }) => {
          if (disposed) return;
          listen<PhonePreviewMsg>(eventName, (ev) => fn(ev.payload))
            .then((un) => {
              if (disposed) safeUn(un);
              else unlisten = un;
            })
            .catch(() => {
              /* registration failed — listener never fires */
            });
        });
        return () => {
          disposed = true;
          if (unlisten) safeUn(unlisten);
        };
      },
      emit(msg) {
        import("@tauri-apps/api/event").then(({ emit }) => {
          emit(eventName, msg).catch(() => {
            /* the other side may not be listening yet — fine */
          });
        });
      },
    };
  }

  // Browser / vite-dev path: BroadcastChannel. Re-open per emit
  // rather than holding a long-lived instance so HMR teardown
  // doesn't leak channels.
  return {
    listen(fn) {
      const channel = new BroadcastChannel(eventName);
      channel.onmessage = (ev) => {
        if (!ev.data) return;
        fn(ev.data as PhonePreviewMsg);
      };
      return () => channel.close();
    },
    emit(msg) {
      const channel = new BroadcastChannel(eventName);
      channel.postMessage(msg);
      channel.close();
    },
  };
}

/// Open the phone simulator in its own OS window. Idempotent — a
/// second call with the same `scope` focuses the existing window
/// rather than spawning a duplicate.
///
/// `scope` keys both the window label AND the bus channel; pass the
/// same value to `makePhonePreviewBus` to talk to this window.
export async function openPhonePopout(
  scope: string,
  title: string,
): Promise<void> {
  const base = new URL(window.location.href);
  // Strip any `?popped=...` workbench params that might still be on
  // the URL — we want a clean phone view, not a workbench-in-phone-
  // window monstrosity.
  base.searchParams.delete("popped");
  base.searchParams.delete("course");
  base.searchParams.delete("lesson");
  base.searchParams.delete("files");
  base.searchParams.set("phone", "1");
  base.searchParams.set("scope", scope);
  const url = base.toString();
  const label = phonePopoutLabel(scope);

  if (isTauri()) {
    try {
      const { WebviewWindow } = await import(
        "@tauri-apps/api/webviewWindow"
      );
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) {
        await existing.setFocus();
        return;
      }
      // Sized to comfortably hold a 380×760 phone frame plus a small
      // title bar gutter from the OS. Resizable so the user can
      // shrink it onto a secondary monitor or stretch for long
      // scrollable previews.
      new WebviewWindow(label, {
        url,
        title: `Fishbones · ${title}`,
        width: 440,
        height: 860,
        minWidth: 320,
        minHeight: 560,
        resizable: true,
      });
      return;
    } catch (e) {
      console.warn(
        "[fishbones] Tauri WebviewWindow failed for phone popout, falling back to window.open:",
        e,
      );
    }
  }

  window.open(url, label, "width=440,height=860");
}

/// Close the popped phone window if one is open. Tauri path uses
/// `WebviewWindow.close()`; for browser fallback the window's own
/// `close()` works for same-origin children.
export async function closePhonePopout(scope: string): Promise<void> {
  const label = phonePopoutLabel(scope);
  if (isTauri()) {
    try {
      const { WebviewWindow } = await import(
        "@tauri-apps/api/webviewWindow"
      );
      const win = await WebviewWindow.getByLabel(label);
      if (win) await win.close();
      return;
    } catch (e) {
      console.warn(
        "[fishbones] Tauri close failed for phone popout:",
        e,
      );
    }
  }
  // Browser fallback — there's no reliable way to programmatically
  // close a window opened via window.open from a different page
  // navigation, so this is best-effort. The user can always close
  // the OS window manually.
}
