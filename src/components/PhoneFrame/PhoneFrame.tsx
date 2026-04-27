import type { ReactNode } from "react";
import "./PhoneFrame.css";

interface PhoneFrameProps {
  /// Content rendered inside the phone "screen". Sits above the
  /// status bar / below the home indicator. The component handles
  /// scrolling internally so a tall preview stays inside the frame.
  children: ReactNode;
  /// Optional fake status-bar carrier label. Defaults to "Fishbones".
  carrier?: string;
}

/// Pure-CSS iPhone 14-Pro-shaped chrome that wraps arbitrary content
/// in a device-shaped frame. Used by the Playground "Phone simulator"
/// view to make React Native / Swift output feel like it's running on
/// a real device, even though the inside is just an iframe (RN) or a
/// terminal-style log dump (Swift).
///
/// Visual layout (top → bottom):
///   - dark bezel gradient (1a1a1c → 2a2a2c) with rounded corners
///   - status bar row with carrier label + signal/wifi/battery glyphs
///   - dynamic island pill, centred near the top
///   - content area (children render here, scrolls if too tall)
///   - home indicator bar near the bottom
///
/// All proportions key off `aspect-ratio: 9 / 19.5` so the frame
/// scales smoothly inside any container without going off-shape.
export default function PhoneFrame({
  children,
  carrier = "FISH",
}: PhoneFrameProps) {
  return (
    <div className="fishbones-phone-frame-outer">
      <div className="fishbones-phone-frame">
        {/* Side-button silhouettes — non-functional, just visual cues. */}
        <span
          className="fishbones-phone-frame-side-btn fishbones-phone-frame-side-btn--mute"
          aria-hidden
        />
        <span
          className="fishbones-phone-frame-side-btn fishbones-phone-frame-side-btn--volup"
          aria-hidden
        />
        <span
          className="fishbones-phone-frame-side-btn fishbones-phone-frame-side-btn--voldown"
          aria-hidden
        />
        <span
          className="fishbones-phone-frame-side-btn fishbones-phone-frame-side-btn--sleep"
          aria-hidden
        />

        <div className="fishbones-phone-frame-screen">
          {/* Dynamic island — black pill near the top of the screen. */}
          <div className="fishbones-phone-frame-island" aria-hidden />

          {/* Status bar: carrier on the left, signal/wifi/battery on
              the right. The time sits below the island in iPhone 14 Pro
              chrome — we put it on the left for a stable read. */}
          <div className="fishbones-phone-frame-status">
            <div className="fishbones-phone-frame-status-left">
              <span className="fishbones-phone-frame-status-carrier">
                {carrier}
              </span>
            </div>
            <div className="fishbones-phone-frame-status-right" aria-hidden>
              {/* Signal — three rising bars. */}
              <svg
                className="fishbones-phone-frame-glyph"
                viewBox="0 0 18 12"
                width="18"
                height="12"
              >
                <rect x="1" y="8" width="2" height="3" rx="0.5" />
                <rect x="6" y="5" width="2" height="6" rx="0.5" />
                <rect x="11" y="2" width="2" height="9" rx="0.5" />
              </svg>
              {/* Wifi — three concentric arcs + a dot. */}
              <svg
                className="fishbones-phone-frame-glyph"
                viewBox="0 0 18 14"
                width="18"
                height="12"
              >
                <path
                  d="M1 5 a11 11 0 0 1 16 0"
                  fill="none"
                  strokeWidth="1.5"
                  stroke="currentColor"
                  strokeLinecap="round"
                />
                <path
                  d="M4 8 a7 7 0 0 1 10 0"
                  fill="none"
                  strokeWidth="1.5"
                  stroke="currentColor"
                  strokeLinecap="round"
                />
                <circle cx="9" cy="11" r="1.2" fill="currentColor" />
              </svg>
              {/* Battery — outline rectangle with fill bar. */}
              <svg
                className="fishbones-phone-frame-glyph"
                viewBox="0 0 26 12"
                width="26"
                height="12"
              >
                <rect
                  x="0.75"
                  y="0.75"
                  width="22"
                  height="10.5"
                  rx="2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                  opacity="0.6"
                />
                <rect
                  x="23.5"
                  y="3.5"
                  width="1.6"
                  height="5"
                  rx="0.7"
                  fill="currentColor"
                  opacity="0.6"
                />
                <rect
                  x="2"
                  y="2"
                  width="18"
                  height="8"
                  rx="1.5"
                  fill="currentColor"
                />
              </svg>
            </div>
          </div>

          {/* The actual content slot. `overflow: auto` lets the inner
              UI scroll inside the screen rather than blowing past the
              frame's bottom edge. */}
          <div className="fishbones-phone-frame-content">{children}</div>

          {/* Home indicator — flat capsule near the bottom of the screen. */}
          <div className="fishbones-phone-frame-home" aria-hidden />
        </div>
      </div>
    </div>
  );
}
