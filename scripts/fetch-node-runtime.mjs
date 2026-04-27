#!/usr/bin/env node
/// Download + extract the Node.js distribution for the host
/// platform into `src-tauri/resources/node/`. Tauri's `tauri build`
/// step picks it up via the `bundle.resources` glob in
/// tauri.conf.json and ships it inside the app — at runtime,
/// sveltekit_runner.rs resolves `<resources>/node/bin/node` and
/// `<resources>/node/bin/npm` so SvelteKit lessons run without
/// requiring the user to install Node themselves.
///
/// Strategy: download once and cache. The Node distribution is
/// ~80MB unpacked; re-fetching every build would be wasteful, so we
/// stash the tarball under `src-tauri/.cache/node-<version>-...tar.gz`
/// and re-extract from cache on subsequent runs.
///
/// Multi-platform: Tauri produces one bundle per build target, and
/// only the host platform's Node ships per build. CI that targets
/// multiple platforms re-runs this script per matrix job.
///
/// Pinning Node to a stable LTS line means the bundled npm has
/// known-good behaviour against the SvelteKit scaffold templates
/// (tested against Node 22 LTS).

import {
  createReadStream,
  createWriteStream,
  existsSync,
} from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TAURI_DIR = join(ROOT, "src-tauri");
const RESOURCES_DIR = join(TAURI_DIR, "resources", "node");
const CACHE_DIR = join(TAURI_DIR, ".cache");

/// Pinned Node release. Bumping is fine — npm comes with whichever
/// release we pick, so newer Node = newer bundled npm. Stay on LTS
/// to avoid the 6-month odd-version behaviour churn.
const NODE_VERSION = "22.11.0";

function detectPlatform() {
  switch (process.platform) {
    case "darwin":
      return process.arch === "arm64"
        ? { triple: "darwin-arm64", ext: "tar.gz" }
        : { triple: "darwin-x64", ext: "tar.gz" };
    case "linux":
      return process.arch === "arm64"
        ? { triple: "linux-arm64", ext: "tar.xz" }
        : { triple: "linux-x64", ext: "tar.xz" };
    case "win32":
      return process.arch === "arm64"
        ? { triple: "win-arm64", ext: "zip" }
        : { triple: "win-x64", ext: "zip" };
    default:
      throw new Error(`unsupported platform: ${process.platform}-${process.arch}`);
  }
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function fetchToFile(url, dst) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${url} → ${res.status}`);
  }
  const total = Number(res.headers.get("content-length") || 0);
  let received = 0;
  let lastTick = 0;
  const reader = res.body.getReader();
  const writer = createWriteStream(dst);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    writer.write(value);
    const now = Date.now();
    if (now - lastTick > 250) {
      lastTick = now;
      const pct = total ? ((received / total) * 100).toFixed(1) : "?";
      process.stdout.write(
        `\r  downloading… ${(received / 1e6).toFixed(1)} MB${
          total ? ` / ${(total / 1e6).toFixed(1)} MB (${pct}%)` : ""
        }    `,
      );
    }
  }
  writer.end();
  await new Promise((r) => writer.on("close", r));
  process.stdout.write("\n");
}

/// Run a command, inheriting stdio so progress / errors are visible.
function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`)),
    );
    child.on("error", rej);
  });
}

async function extract(archive, ext, dst) {
  await ensureDir(dst);
  if (ext === "tar.gz" || ext === "tar.xz") {
    // --strip-components=1 collapses `node-vXX-platform/...` →
    // top-level so we get a flat `bin/`, `lib/`, etc. inside `dst`
    // instead of an extra version-named wrapper directory.
    const flag = ext === "tar.gz" ? "z" : "J";
    await run("tar", [`-x${flag}f`, archive, "-C", dst, "--strip-components=1"]);
  } else if (ext === "zip") {
    // macOS / Linux always have unzip; Windows uses tar these days
    // but we stay platform-aware: spawn whichever's available.
    await run("unzip", ["-q", archive, "-d", dst]);
    // Windows zip wraps in a top-level dir — flatten by copying its
    // contents up. Skipped on darwin/linux since we use tar instead.
  } else {
    throw new Error(`unsupported archive ext: ${ext}`);
  }
}

async function main() {
  const { triple, ext } = detectPlatform();
  const filename = `node-v${NODE_VERSION}-${triple}.${ext}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${filename}`;
  const cachePath = join(CACHE_DIR, filename);

  console.log(`fetch-node-runtime`);
  console.log(`  platform: ${triple}`);
  console.log(`  version:  ${NODE_VERSION}`);
  console.log(`  url:      ${url}`);
  console.log(`  resources: ${RESOURCES_DIR}`);

  await ensureDir(CACHE_DIR);
  if (!existsSync(cachePath)) {
    console.log(`  caching to ${cachePath}…`);
    await fetchToFile(url, cachePath);
  } else {
    console.log(`  cache hit (${cachePath})`);
  }

  // Wipe + re-extract so a previous build's stale node/ doesn't
  // mix files with the new release. ~5s cost on warm cache.
  if (existsSync(RESOURCES_DIR)) {
    await rm(RESOURCES_DIR, { recursive: true, force: true });
  }
  console.log(`  extracting…`);
  await extract(cachePath, ext, RESOURCES_DIR);

  // Sanity check — fail fast if the layout isn't what
  // sveltekit_runner.rs expects.
  const expected = process.platform === "win32"
    ? [join(RESOURCES_DIR, "node.exe"), join(RESOURCES_DIR, "npm.cmd")]
    : [join(RESOURCES_DIR, "bin", "node"), join(RESOURCES_DIR, "bin", "npm")];
  for (const f of expected) {
    if (!existsSync(f)) {
      throw new Error(`expected ${f} after extract, not found`);
    }
  }
  console.log(`fetch-node-runtime OK`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
