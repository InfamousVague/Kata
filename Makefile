# Fishbones — Build, Sign, Notarize, Install
# Usage:
#   make              — full pipeline: build → sign → notarize → install
#   make build        — tauri release build
#   make sign         — post-build signing only (no rebuild)
#   make notarize     — notarize + staple the DMG
#   make install      — install notarized app to /Applications
#   make release      — bump patch, commit, tag, push (no build)
#   make local-release — bump + build + sign + notarize + upload DMG
#   make dev          — run in dev mode
#   make clean        — remove build artifacts

SHELL := /bin/bash
ROOT  := $(shell pwd)
TAURI := $(ROOT)/src-tauri

# Load credentials from .env.apple (gitignored)
-include $(ROOT)/.env.apple

export APPLE_SIGNING_IDENTITY

IDENTITY      := $(APPLE_SIGNING_IDENTITY)
APPLE_ID      ?= InfamousVagueRat@gmail.com
TEAM_ID       := $(APPLE_TEAM_ID)
TEAM_ID       ?= F6ZAL7ANAD
VERSION       := $(shell grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
ARCH          := $(shell uname -m)
ifeq ($(ARCH),arm64)
  ARCH_TAG := aarch64
else ifeq ($(ARCH),x86_64)
  ARCH_TAG := x64
else
  ARCH_TAG := $(ARCH)
endif
APP_BUNDLE    := $(TAURI)/target/release/bundle/macos/Fishbones.app
DMG           := $(TAURI)/target/release/bundle/dmg/Fishbones_$(VERSION)_$(ARCH_TAG).dmg
INSTALL_PATH  := /Applications/Fishbones.app

.PHONY: all build sign notarize staple install dev release local-release clean help \
        run run-split run-phone run-watch pick-phone pick-watch run-clean

# --- iOS / watchOS run config ---------------------------------------------
WATCH_ROOT      := /Users/matt/Development/Apps/FishbonesWatch
DEVICE_CACHE    := $(ROOT)/.fishbones-devices.cache
PHONE_BUNDLE_ID := com.mattssoftware.kata
WATCH_BUNDLE_ID := com.mattssoftware.fishbones.watchkitapp
# CocoaPods needs UTF-8 locale or it bails on unicode in podspecs.
TAURI_ENV       := LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

## Default: full pipeline
all: build sign notarize install
	@echo ""
	@echo "✓ Done — Fishbones.app installed and notarized"

## Build Tauri release
build:
	@echo "=== Building Tauri release ==="
	cd $(ROOT) && npm run tauri build -- --bundles app,dmg

## Post-build: sign everything with hardened runtime + rebuild DMG
sign:
	@echo "=== Signing ==="
	cd $(TAURI) && bash scripts/post-build.sh

## Notarize the DMG with Apple
notarize:
	@echo "=== Notarizing ==="
	@if [ -z "$(APPLE_PASSWORD)" ]; then \
		echo "ERROR: APPLE_PASSWORD not set. Check .env.apple"; exit 1; \
	fi
	xcrun notarytool submit "$(DMG)" \
		--apple-id "$(APPLE_ID)" \
		--team-id "$(TEAM_ID)" \
		--password "$(APPLE_PASSWORD)" \
		--wait
	@echo "=== Stapling ==="
	xcrun stapler staple "$(DMG)"

## Staple notarization ticket to DMG (standalone)
staple:
	@echo "=== Stapling ==="
	xcrun stapler staple "$(DMG)"

## Install notarized app from DMG to /Applications
install: staple
	@echo "=== Installing ==="
	hdiutil attach "$(DMG)" -quiet -nobrowse -mountpoint /tmp/fishbones-dmg
	rm -rf "$(INSTALL_PATH)"
	ditto /tmp/fishbones-dmg/Fishbones.app "$(INSTALL_PATH)"
	hdiutil detach /tmp/fishbones-dmg -quiet
	@echo "Installed: $(INSTALL_PATH)"
	@spctl --assess --type execute --verbose "$(INSTALL_PATH)" 2>&1

## Dev mode
dev:
	cd $(ROOT) && npm run tauri dev

## Bump version, commit, tag, push (no build)
BUMP ?= patch

release:
	@CURRENT=$(VERSION); \
	IFS='.' read -r MAJOR MINOR PATCH <<< "$$CURRENT"; \
	if [ "$(BUMP)" = "major" ]; then \
		MAJOR=$$((MAJOR + 1)); MINOR=0; PATCH=0; \
	elif [ "$(BUMP)" = "minor" ]; then \
		MINOR=$$((MINOR + 1)); PATCH=0; \
	else \
		PATCH=$$((PATCH + 1)); \
	fi; \
	NEW="$$MAJOR.$$MINOR.$$PATCH"; \
	echo "=== Bumping $$CURRENT → $$NEW ==="; \
	sed -i '' "s/\"version\": \"$$CURRENT\"/\"version\": \"$$NEW\"/" src-tauri/tauri.conf.json; \
	sed -i '' "s/^version = \"$$CURRENT\"/version = \"$$NEW\"/" src-tauri/Cargo.toml; \
	git add src-tauri/tauri.conf.json src-tauri/Cargo.toml; \
	git commit -m "Fishbones v$$NEW"; \
	git tag -a "v$$NEW" -m "Fishbones v$$NEW"; \
	git push origin HEAD; \
	git push origin "v$$NEW"; \
	echo ""; \
	echo "✓ v$$NEW tagged and pushed"

## Local release: build + sign + notarize + upload current version to GitHub
## (Use `make release` first if you want to bump the version.) Skips the
## /Applications install step — release publishing shouldn't require
## the user be willing to replace their local copy.
local-release: build sign notarize
	@DMG_CURRENT="$(TAURI)/target/release/bundle/dmg/Fishbones_$(VERSION)_$(ARCH_TAG).dmg"; \
	if [ ! -f "$$DMG_CURRENT" ]; then \
		echo "ERROR: DMG not found at $$DMG_CURRENT"; exit 1; \
	fi; \
	if git rev-parse "v$(VERSION)" >/dev/null 2>&1; then \
		echo "Tag v$(VERSION) already exists — skipping tag creation"; \
	else \
		git tag -a "v$(VERSION)" -m "Fishbones v$(VERSION)"; \
		git push origin "v$(VERSION)"; \
	fi; \
	gh release view "v$(VERSION)" >/dev/null 2>&1 && { \
		echo "Release v$(VERSION) exists — uploading DMG as asset"; \
		gh release upload "v$(VERSION)" "$$DMG_CURRENT" --clobber; \
	} || { \
		gh release create "v$(VERSION)" \
			"$$DMG_CURRENT" \
			--title "Fishbones v$(VERSION)" \
			--notes "Signed and notarized macOS release." \
			--latest; \
	}; \
	echo ""; \
	echo "✓ v$(VERSION) released and uploaded"

## Remove build artifacts
clean:
	rm -rf $(TAURI)/target/release/bundle
	@echo "Cleaned"

# --- iOS phone + watch device runner ---------------------------------------
# `make run`         — pick iPhone + Watch, build/install/launch both
# `make run-phone`   — phone only
# `make run-watch`   — watch only
# `make pick-phone`  / `make pick-watch` — refresh selection without building
# `make run-clean`   — drop the cached selection
#
# Picks are cached in .fishbones-devices.cache (gitignored). The first run on
# a fresh checkout always prompts; subsequent runs prompt "Use last? (Y/n)".

pick-phone:
	@bash $(ROOT)/scripts/pick-device.sh phone --reuse

pick-watch:
	@bash $(ROOT)/scripts/pick-device.sh watch --reuse

run-clean:
	@rm -f $(DEVICE_CACHE) && echo "Cleared $(DEVICE_CACHE)"

# When `make run` invokes us via sub-make, it already picked both devices —
# avoid prompting "Use last?" again. The standalone case has FB_SKIP_PICK
# unset, so the picker still runs.
run-phone: $(if $(FB_SKIP_PICK),,pick-phone)
	@set -eu; \
	. $(DEVICE_CACHE); \
	echo ""; \
	echo "=== Phone: $$IPHONE_NAME ($$IPHONE_KIND/$$IPHONE_UDID) ==="; \
	if [ "$$IPHONE_KIND" = "sim" ]; then \
		echo "--- tauri ios build (sim) ---"; \
		cd $(ROOT) && $(TAURI_ENV) tauri ios build --target aarch64-sim --debug; \
		APP="$(TAURI)/gen/apple/build/arm64-sim/Fishbones.app"; \
		echo "--- boot + install + launch ---"; \
		xcrun simctl boot "$$IPHONE_UDID" 2>/dev/null || true; \
		open -a Simulator; \
		xcrun simctl install "$$IPHONE_UDID" "$$APP"; \
		xcrun simctl launch "$$IPHONE_UDID" $(PHONE_BUNDLE_ID); \
	else \
		echo "--- tauri ios build (device) ---"; \
		cd $(ROOT) && $(TAURI_ENV) tauri ios build --target aarch64 --debug; \
		APP=""; \
		for cand in \
			"$(TAURI)/gen/apple/build/arm64/Fishbones.app" \
			"$(TAURI)/gen/apple/build/fishbones_iOS.xcarchive/Products/Applications/Fishbones.app"; do \
			if [ -d "$$cand" ]; then APP="$$cand"; echo "Found .app: $$cand"; break; fi; \
		done; \
		if [ -z "$$APP" ]; then \
			IPA="$(TAURI)/gen/apple/build/arm64/Fishbones.ipa"; \
			if [ -f "$$IPA" ]; then \
				echo "--- no .app found; extracting from $$IPA ---"; \
				EXTRACT_DIR="$(TAURI)/gen/apple/build/arm64/_ipa-extract"; \
				rm -rf "$$EXTRACT_DIR"; mkdir -p "$$EXTRACT_DIR"; \
				unzip -q -o "$$IPA" -d "$$EXTRACT_DIR"; \
				APP=$$(ls -d "$$EXTRACT_DIR"/Payload/*.app 2>/dev/null | head -1); \
				[ -d "$$APP" ] && echo "Extracted .app: $$APP"; \
			fi; \
		fi; \
		if [ -z "$$APP" ] || [ ! -d "$$APP" ]; then \
			echo "ERROR: no Fishbones.app or .ipa produced under $(TAURI)/gen/apple/build/."; \
			echo "Build likely failed — scroll up for tauri/xcodebuild errors,"; \
			echo "or try 'tauri ios dev --target $$IPHONE_UDID' for a guided run."; \
			exit 1; \
		fi; \
		echo "--- devicectl install + launch ---"; \
		xcrun devicectl device install app --device "$$IPHONE_UDID" "$$APP"; \
		xcrun devicectl device process launch --device "$$IPHONE_UDID" --terminate-existing $(PHONE_BUNDLE_ID); \
	fi; \
	echo "✓ Phone launched."

run-watch: $(if $(FB_SKIP_PICK),,pick-watch)
	@set -eu; \
	. $(DEVICE_CACHE); \
	echo ""; \
	echo "=== Watch: $$WATCH_NAME ($$WATCH_KIND/$$WATCH_UDID) ==="; \
	cd $(WATCH_ROOT); \
	if [ "$$WATCH_KIND" = "sim" ]; then \
		echo "--- xcodebuild (watchOS sim) ---"; \
		xcodebuild -project FishbonesWatch.xcodeproj -scheme FishbonesWatch \
			-destination "platform=watchOS Simulator,id=$$WATCH_UDID" \
			-configuration Debug -derivedDataPath build/DerivedData \
			build CODE_SIGNING_ALLOWED=NO | tail -40; \
		APP="$(WATCH_ROOT)/build/DerivedData/Build/Products/Debug-watchsimulator/FishbonesWatch.app"; \
		echo "--- boot + install + launch ---"; \
		xcrun simctl boot "$$WATCH_UDID" 2>/dev/null || true; \
		open -a Simulator; \
		xcrun simctl install "$$WATCH_UDID" "$$APP"; \
		xcrun simctl launch "$$WATCH_UDID" $(WATCH_BUNDLE_ID); \
	else \
		echo "--- xcodebuild (watchOS device, signed) ---"; \
		xcodebuild -project FishbonesWatch.xcodeproj -scheme FishbonesWatch \
			-destination "platform=watchOS,id=$$WATCH_UDID" \
			-configuration Debug -derivedDataPath build/DerivedData \
			build | tail -40; \
		APP="$(WATCH_ROOT)/build/DerivedData/Build/Products/Debug-watchos/FishbonesWatch.app"; \
		if [ ! -d "$$APP" ]; then \
			echo "ERROR: $$APP not found. Check signing settings (DEVELOPMENT_TEAM=F6ZAL7ANAD)."; \
			exit 1; \
		fi; \
		echo "--- devicectl install + launch ---"; \
		xcrun devicectl device install app --device "$$WATCH_UDID" "$$APP"; \
		xcrun devicectl device process launch --device "$$WATCH_UDID" --terminate-existing $(WATCH_BUNDLE_ID); \
	fi; \
	echo "✓ Watch launched."

# `run` chains both pickers up-front (so all prompts happen before any build),
# then delegates to the per-target recipes with FB_SKIP_PICK=1 so they don't
# re-prompt for the same selection.
run:
	@bash $(ROOT)/scripts/pick-device.sh phone --reuse
	@bash $(ROOT)/scripts/pick-device.sh watch --reuse
	@$(MAKE) --no-print-directory FB_SKIP_PICK=1 run-phone
	@$(MAKE) --no-print-directory FB_SKIP_PICK=1 run-watch

# `run-split` picks both devices in this window, then spawns each build into
# its own Terminal/iTerm window so phone + watch logs stream side-by-side.
# Set FB_TERM=iterm or FB_TERM=terminal to override auto-detection.
run-split:
	@bash $(ROOT)/scripts/pick-device.sh phone --reuse
	@bash $(ROOT)/scripts/pick-device.sh watch --reuse
	@bash $(ROOT)/scripts/run-split.sh

help:
	@echo "Build / release targets:"
	@echo "  make              — full pipeline: build → sign → notarize → install"
	@echo "  make build        — Tauri release build"
	@echo "  make sign         — post-build signing (no rebuild)"
	@echo "  make notarize     — notarize + staple DMG"
	@echo "  make install      — install to /Applications"
	@echo "  make release      — bump patch ($(VERSION) → next), tag, push (no build)"
	@echo "  make local-release — full local build + sign + notarize + upload to GitHub"
	@echo ""
	@echo "iOS / watchOS run targets (interactive device picker):"
	@echo "  make run          — pick + run phone AND watch (sequential, this window)"
	@echo "  make run-split    — pick + run phone AND watch in two new terminal windows"
	@echo "  make run-phone    — pick + run phone only"
	@echo "  make run-watch    — pick + run watch only"
	@echo "  make pick-phone   — refresh phone selection only"
	@echo "  make pick-watch   — refresh watch selection only"
	@echo "  make run-clean    — drop the cached device selection"
