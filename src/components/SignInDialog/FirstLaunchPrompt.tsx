import { useEffect, useState } from "react";
import type { UseFishbonesCloud } from "../../hooks/useFishbonesCloud";
import SignInDialog from "./SignInDialog";

/// First-launch sign-in nudge.
///
/// Wakes up once on the very first session (no token, no "skip"
/// pref recorded), opens the SignInDialog with a softer headline,
/// and surfaces a "Don't show this again" checkbox the user can
/// flip to suppress future prompts. After they sign in, skip, or
/// close the modal, the decision sticks in localStorage:
///
///   - sign in       → token gets written, user is logged in,
///                     prompt never reappears
///   - skip + tick   → fishbones:cloud:dismissed-v1 = "permanent"
///   - skip          → "session" (we re-prompt next launch)
///   - close (×)     → "session" (treated like skip — same intent)
///
/// All gating happens here, so the only thing the parent has to do
/// is render `<FirstLaunchPrompt cloud={cloud} />` near the top of
/// the tree. The component renders nothing until it decides to show.

const DISMISS_KEY = "fishbones:cloud:dismissed-v1";

function readDismissed(): "permanent" | "session" | null {
  try {
    const v = localStorage.getItem(DISMISS_KEY);
    return v === "permanent" || v === "session" ? v : null;
  } catch {
    return null;
  }
}
function writeDismissed(v: "permanent" | "session"): void {
  try {
    localStorage.setItem(DISMISS_KEY, v);
  } catch {
    /* ignore */
  }
}

interface Props {
  cloud: UseFishbonesCloud;
}

export default function FirstLaunchPrompt({ cloud }: Props) {
  const [open, setOpen] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  // Decide whether to open. We wait until the cloud hook has
  // resolved its boot state — `cloud.user === null` means "we have a
  // stored token and are still checking it"; we don't want to flash
  // the prompt over an already-signed-in user just because the `me`
  // request hasn't returned yet.
  useEffect(() => {
    if (cloud.user !== false) return; // null = booting, object = signed in
    const dismissed = readDismissed();
    if (dismissed === "permanent") return;
    // Slight delay so the prompt arrives after the bootloader fades
    // and the lesson view has had a paint. Feels less ambush-y.
    const id = window.setTimeout(() => setOpen(true), 800);
    return () => window.clearTimeout(id);
  }, [cloud.user]);

  if (!open) return null;

  const handleSkip = () => {
    writeDismissed(dontShowAgain ? "permanent" : "session");
  };

  const handleClose = () => {
    // If they got here without signing in, treat the close as a skip.
    if (!cloud.signedIn) {
      writeDismissed(dontShowAgain ? "permanent" : "session");
    }
    setOpen(false);
  };

  return (
    <>
      <SignInDialog
        cloud={cloud}
        onClose={handleClose}
        showSkipButton
        onSkip={handleSkip}
        headline="Save your progress with a Fishbones account"
        blurb="Optional. Sign in to sync streaks and lesson progress between devices, upload your imported books, and share courses with friends. Skip to keep using Fishbones entirely on this machine — everything still runs locally."
      />
      {/* "Don't show again" sits inside the modal flow rather than
          as a separate widget so the user sees it before deciding to
          dismiss. Absolute-positioned over the backdrop layer. */}
      <div className="fishbones-firstlaunch-dontshow">
        <label>
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          <span>Don't show this again</span>
        </label>
      </div>
    </>
  );
}
