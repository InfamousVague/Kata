/// Mobile settings — minimal. The desktop SettingsDialog has four
/// rails (AI & API, Theme, Data, Account). On mobile we drop AI & API
/// (no API-key entry workflow on phones, the hidden-tests pipeline
/// is a desktop affordance) and tighten the rest into one stack.
///
/// Sections:
///   - Account     — sign-in CTA when signed out, profile + sign-out when signed in
///   - About       — version, link to fishbones.academy
///   - Reset       — wipe local progress (with click-to-confirm)
///
/// Triggered from the bottom-tab bar's "Settings" button.

import { useState } from "react";
import type { UseFishbonesCloud } from "../hooks/useFishbonesCloud";
import "./MobileSettings.css";

interface Props {
  cloud: UseFishbonesCloud;
  onRequestSignIn: () => void;
  onResetProgress: () => Promise<void> | void;
  appVersion?: string;
}

export default function MobileSettings({
  cloud,
  onRequestSignIn,
  onResetProgress,
  appVersion = "0.1.4",
}: Props) {
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const signedIn = cloud.signedIn === true;
  const user =
    typeof cloud.user === "object" && cloud.user ? cloud.user : null;

  const onReset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResetting(true);
    try {
      await onResetProgress();
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  };

  return (
    <div className="m-set">
      <header className="m-set__head">
        <h1 className="m-set__title">Settings</h1>
      </header>

      <section className="m-set__section">
        <h3 className="m-set__section-title">Account</h3>
        {signedIn && user ? (
          <>
            <div className="m-set__row m-set__row--passive">
              <div className="m-set__row-text">
                <span className="m-set__row-title">{user.display_name}</span>
                <span className="m-set__row-meta">{user.email}</span>
              </div>
            </div>
            <button
              type="button"
              className="m-set__row m-set__row--button m-set__row--danger"
              onClick={async () => {
                setSigningOut(true);
                try {
                  await cloud.signOut();
                } finally {
                  setSigningOut(false);
                }
              }}
              disabled={signingOut}
            >
              <span className="m-set__row-title">
                {signingOut ? "Signing out…" : "Sign out"}
              </span>
            </button>
          </>
        ) : (
          <>
            <p className="m-set__blurb">
              Sign in to sync progress, streaks, and lesson history between
              devices. Fishbones runs entirely offline without an account —
              signing in is purely additive.
            </p>
            <button
              type="button"
              className="m-set__row m-set__row--button m-set__row--primary"
              onClick={onRequestSignIn}
            >
              <span className="m-set__row-title">Sign in</span>
            </button>
          </>
        )}
      </section>

      <section className="m-set__section">
        <h3 className="m-set__section-title">About</h3>
        <div className="m-set__row m-set__row--passive">
          <div className="m-set__row-text">
            <span className="m-set__row-title">Fishbones</span>
            <span className="m-set__row-meta">v{appVersion}</span>
          </div>
        </div>
        <a
          className="m-set__row m-set__row--link"
          href="https://fishbones.academy"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="m-set__row-title">fishbones.academy</span>
          <span className="m-set__row-chevron" aria-hidden>
            ↗
          </span>
        </a>
      </section>

      <section className="m-set__section">
        <h3 className="m-set__section-title">Data</h3>
        <p className="m-set__blurb">
          Wipes every "lesson complete" flag on this device. Cloud-synced
          progress on other devices isn't touched.
        </p>
        <button
          type="button"
          className={`m-set__row m-set__row--button${confirmReset ? " m-set__row--danger" : ""}`}
          onClick={onReset}
          disabled={resetting}
        >
          <span className="m-set__row-title">
            {resetting
              ? "Resetting…"
              : confirmReset
                ? "Tap again to confirm"
                : "Reset local progress"}
          </span>
        </button>
      </section>
    </div>
  );
}
