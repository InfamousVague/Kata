#!/bin/bash
# Post-build: Sign the Fishbones .app bundle with hardened runtime + secure
# timestamp, then rebuild the DMG with an Applications symlink for
# drag-to-install. Run after `cargo tauri build`.
#
# Reads APPLE_SIGNING_IDENTITY from ../.env.apple (the repo root). When
# no identity is set we exit cleanly so local dev builds (which don't
# need signing) keep working.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$(dirname "$SCRIPT_DIR")"

# Find the built .app bundle
APP_BUNDLE=$(find "$TAURI_DIR/target/release/bundle/macos" -name "*.app" -maxdepth 1 2>/dev/null | head -1)

if [ -z "$APP_BUNDLE" ]; then
    echo "No .app bundle found in target/release/bundle/macos — skipping post-build"
    exit 0
fi

# Load signing identity from .env.apple (repo root).
ENV_FILE="$TAURI_DIR/../.env.apple"
if [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE"
fi

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"

if [ -z "$IDENTITY" ]; then
    echo "WARNING: No APPLE_SIGNING_IDENTITY in .env.apple — skipping code signing"
    exit 0
fi

echo "=== Signing with: $IDENTITY ==="

# Sign the main binary with hardened runtime + entitlements. The binary
# name matches the `[package] name` in Cargo.toml — `fishbones`.
codesign --force --options runtime --timestamp \
    --sign "$IDENTITY" \
    --entitlements "$TAURI_DIR/Entitlements.plist" \
    "$APP_BUNDLE/Contents/MacOS/fishbones"
echo "Signed: main binary"

# Sign the entire .app bundle (outermost, must be last)
codesign --force --options runtime --timestamp \
    --sign "$IDENTITY" \
    --entitlements "$TAURI_DIR/Entitlements.plist" \
    "$APP_BUNDLE"
echo "Signed: $APP_BUNDLE"

# Verify
echo ""
echo "=== Verification ==="
codesign --verify --deep --strict "$APP_BUNDLE" && echo "Signature valid" || echo "WARNING: Signature verification failed"
spctl --assess --type execute --verbose "$APP_BUNDLE" 2>&1 || true

# Rebuild DMG with properly signed app + Applications symlink for
# drag-to-install. Arch tag matches the host we built on.
DMG_DIR="$TAURI_DIR/target/release/bundle/dmg"
VERSION=$(node -e "console.log(require('$TAURI_DIR/tauri.conf.json').version)" 2>/dev/null || echo "0.0.0")
ARCH=$(uname -m)
case "$ARCH" in
    arm64) ARCH_TAG="aarch64" ;;
    x86_64) ARCH_TAG="x64" ;;
    *) ARCH_TAG="$ARCH" ;;
esac
DMG_PATH="$DMG_DIR/Fishbones_${VERSION}_${ARCH_TAG}.dmg"
if [ -d "$DMG_DIR" ]; then
    echo ""
    echo "=== Rebuilding DMG with signed app ==="
    rm -f "$DMG_PATH"
    # Create staging folder with app + Applications symlink for drag-to-install
    DMG_STAGE=$(mktemp -d)
    cp -R "$APP_BUNDLE" "$DMG_STAGE/"
    ln -s /Applications "$DMG_STAGE/Applications"
    hdiutil create -volname "Fishbones" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG_PATH"
    rm -rf "$DMG_STAGE"
    # Sign the DMG
    codesign --force --sign "$IDENTITY" "$DMG_PATH"
    echo "DMG rebuilt and signed: $DMG_PATH"
fi

echo ""
echo "=== Post-build complete ==="
echo ""
echo "To notarize:"
echo "  make notarize"
