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

.PHONY: all build sign notarize staple install dev release local-release clean help

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
	git commit -S -m "Fishbones v$$NEW"; \
	git tag -a "v$$NEW" -m "Fishbones v$$NEW"; \
	git push origin HEAD; \
	git push origin "v$$NEW"; \
	echo ""; \
	echo "✓ v$$NEW tagged and pushed"

## Local release: build + sign + notarize + upload current version to GitHub
## (Use `make release` first if you want to bump the version.)
local-release: all
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

help:
	@echo "Targets: all build sign notarize staple install dev release local-release clean"
	@echo ""
	@echo "  make              — full pipeline: build → sign → notarize → install"
	@echo "  make build        — Tauri release build"
	@echo "  make sign         — post-build signing (no rebuild)"
	@echo "  make notarize     — notarize + staple DMG"
	@echo "  make install      — install to /Applications"
	@echo "  make release      — bump patch ($(VERSION) → next), tag, push (no build)"
	@echo "  make local-release — full local build + sign + notarize + upload to GitHub"
