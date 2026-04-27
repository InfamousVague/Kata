import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./FloatingPhone.css";

interface FloatingPhoneProps {
  /// What renders inside the phone (iframe, console, placeholder).
  children: ReactNode;
  /// Whether the modal is visible. Parent controls this — the modal
  /// itself only emits a close request via `onMinimise`.
  open: boolean;
  /// Called when the user clicks the minimise button.
  onMinimise: () => void;
  /// Optional close (×) — caller can hide it for "always-mount" surfaces
  /// where you only want the user to be able to minimise, not close.
  onClose?: () => void;
}

/// localStorage key holding the floating phone's `{x, y}` viewport
/// position. Top-left of the modal in CSS pixels. Persisted on
/// `mouseup` after a drag so the next page load drops the modal where
/// the user last left it.
const POSITION_STORAGE_KEY = "fishbones:floating-phone-pos";

/// Once the user lets go of the title bar within this many pixels of
/// a viewport edge, snap the modal flush to that edge so it docks
/// cleanly. Keeps the user from having to pixel-hunt for "perfectly
/// against the wall".
const SNAP_THRESHOLD_PX = 12;

/// Padding from a viewport edge for the default "first-load" position.
/// Picked to land the phone in the top-right of the workbench area
/// without eating the AI orb in the bottom-right.
const DEFAULT_EDGE_PADDING = 24;

/// Approximate width of the floating phone — used by the default
/// position calculation so we land flush near the top-right corner
/// without the modal hanging off the side of the screen on first
/// render. The phone itself caps at 380px (PhoneFrame.css), and our
/// title bar / wrapper add no horizontal padding, so 380 is correct.
const APPROX_PHONE_WIDTH = 380;

interface XY {
  x: number;
  y: number;
}

/// Read the persisted position out of localStorage. Returns `null`
/// when nothing's stored (or the value is malformed) so the caller
/// can fall back to the first-load default.
function readPersistedPos(): XY | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<XY>;
    if (
      parsed &&
      typeof parsed.x === "number" &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y)
    ) {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    /* ignore — malformed value falls back to default */
  }
  return null;
}

/// Default first-load position: pinned to the top-right of the
/// viewport with `DEFAULT_EDGE_PADDING` of breathing room. Falls back
/// to a sensible offset when `window` isn't available (SSR / test
/// envs).
function defaultPos(): XY {
  if (typeof window === "undefined") {
    return { x: 80, y: 80 };
  }
  return {
    x: Math.max(
      DEFAULT_EDGE_PADDING,
      window.innerWidth - APPROX_PHONE_WIDTH - DEFAULT_EDGE_PADDING,
    ),
    y: 80,
  };
}

/// Clamp a candidate position so the modal stays at least partly
/// on-screen. We allow a small slip past the right/bottom edges so the
/// drag feels natural, but never let the title bar leave the viewport
/// — losing the drag handle would strand the modal.
function clampPos(pos: XY, el: HTMLDivElement | null): XY {
  if (typeof window === "undefined") return pos;
  const w = el?.offsetWidth ?? APPROX_PHONE_WIDTH;
  // Always keep ~40px of the title bar visible so the user can grab it
  // back. Beyond that, let the modal hang off the edge — height isn't
  // checked because the body cap (max-height: 100vh - 32px) already
  // keeps the title bar inside the viewport vertically.
  const minX = -w + 80;
  const minY = 0;
  const maxX = window.innerWidth - 80;
  const maxY = window.innerHeight - 36;
  return {
    x: Math.max(minX, Math.min(maxX, pos.x)),
    y: Math.max(minY, Math.min(maxY, pos.y)),
  };
}

/// Snap to the nearest viewport edge if the user dropped within
/// `SNAP_THRESHOLD_PX`. Each axis snaps independently so a
/// top-left-ish drop snaps to BOTH edges, while an only-near-the-top
/// drop only snaps vertically.
function snapToEdges(pos: XY, el: HTMLDivElement | null): XY {
  if (typeof window === "undefined") return pos;
  const w = el?.offsetWidth ?? APPROX_PHONE_WIDTH;
  const h = el?.offsetHeight ?? 600;
  let { x, y } = pos;
  // Left edge.
  if (Math.abs(x) <= SNAP_THRESHOLD_PX) x = 0;
  // Right edge.
  const rightGap = window.innerWidth - (x + w);
  if (Math.abs(rightGap) <= SNAP_THRESHOLD_PX) x = window.innerWidth - w;
  // Top edge.
  if (Math.abs(y) <= SNAP_THRESHOLD_PX) y = 0;
  // Bottom edge.
  const bottomGap = window.innerHeight - (y + h);
  if (Math.abs(bottomGap) <= SNAP_THRESHOLD_PX) y = window.innerHeight - h;
  return { x, y };
}

/// Wraps `<PhoneFrame>` (rendered as `children`) in a draggable,
/// minimisable container so the phone simulator floats above the
/// editor like a debug panel. Drag handle is the title-bar strip
/// only — clicks elsewhere (including the iframe inside the phone)
/// keep their normal behaviour. Position + minimise state persist in
/// localStorage so the modal sticks across reloads.
export default function FloatingPhone({
  children,
  open,
  onMinimise,
  onClose,
}: FloatingPhoneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<XY>(() => readPersistedPos() ?? defaultPos());
  const [dragging, setDragging] = useState(false);

  // Drag offset — vector from the title bar's pointer-down spot to the
  // modal's top-left corner. Captured on mousedown and added back on
  // every move so the cursor stays "stuck" to the same grip point
  // throughout the drag.
  const dragOffsetRef = useRef<XY>({ x: 0, y: 0 });
  // Latest position during a drag — kept in a ref so the mouseup
  // handler can read the final coordinates without needing to be
  // re-bound on every state update.
  const latestPosRef = useRef<XY>(pos);
  useEffect(() => {
    latestPosRef.current = pos;
  }, [pos]);

  // Re-clamp on viewport resize so a previously off-screen modal
  // (saved from a wider monitor, then opened on a laptop screen)
  // floats back into view instead of sitting permanently invisible.
  useEffect(() => {
    function onResize() {
      setPos((p) => clampPos(p, containerRef.current));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const handleTitleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only start a drag when the mousedown originated on the title
      // bar itself — not on the minimise / close buttons (which have
      // their own handlers) and not on anything inside the phone.
      // Without this guard, clicks on the minimise button also start
      // a drag, then onClick never fires because mouseup landed
      // outside the button after the cursor moved.
      if (e.target !== e.currentTarget) return;
      // Left-click only — middle/right click shouldn't start a drag.
      if (e.button !== 0) return;
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      dragOffsetRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      setDragging(true);

      function onMove(ev: MouseEvent) {
        const next = clampPos(
          {
            x: ev.clientX - dragOffsetRef.current.x,
            y: ev.clientY - dragOffsetRef.current.y,
          },
          containerRef.current,
        );
        setPos(next);
      }
      function onUp() {
        // Snap the final landing position to a nearby edge if the user
        // dropped within `SNAP_THRESHOLD_PX`. We compute against the
        // latest pos (read via the ref so it's current) instead of
        // closing over `pos` from when the drag started.
        const snapped = snapToEdges(latestPosRef.current, containerRef.current);
        setPos(snapped);
        latestPosRef.current = snapped;
        if (typeof localStorage !== "undefined") {
          try {
            localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(snapped));
          } catch {
            /* quota / disabled — non-fatal */
          }
        }
        setDragging(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [],
  );

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      className={`fishbones-floating-phone ${
        dragging ? "fishbones-floating-phone--dragging" : ""
      }`}
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
      role="dialog"
      aria-label="Phone simulator"
    >
      <div
        className="fishbones-floating-phone-titlebar"
        onMouseDown={handleTitleMouseDown}
      >
        <span className="fishbones-floating-phone-title">Phone</span>
        <div className="fishbones-floating-phone-actions">
          <button
            type="button"
            className="fishbones-floating-phone-btn"
            onClick={onMinimise}
            aria-label="Minimise phone simulator"
            title="Minimise"
          >
            {/* Plain text glyphs so we don't pull a new icon dep — the
                spec explicitly asks for a — and × character. */}
            —
          </button>
          {onClose && (
            <button
              type="button"
              className="fishbones-floating-phone-btn"
              onClick={onClose}
              aria-label="Close phone simulator"
              title="Close"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="fishbones-floating-phone-body">{children}</div>
    </div>
  );
}
